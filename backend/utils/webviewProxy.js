/**
 * Webview Proxy Utility — Multi-Fallback System
 *
 * Strategy:
 *   0. Disk cache (instant return if recently fetched)
 *   1. Direct fetch (accept ALL status codes, retry up to 2×)
 *   2. Wayback Machine (archive.org cached snapshot)
 *   3. Google Cache (webcache.googleusercontent.com)
 *   4. Playwright headless browser (for JS-rendered pages)
 *   5. Graceful error page with "Open in New Tab" button
 *
 * Bypasses X-Frame-Options/CSP by:
 *   – Fetching HTML server-side
 *   – Stripping security headers & frame-busting scripts
 *   – Injecting <base href> for correct asset loading
 *   – Returning sanitized HTML safe for iframe embedding
 */

const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALLOW_INSECURE_WEBVIEW_TLS = String(process.env.ALLOW_INSECURE_WEBVIEW_TLS || '').toLowerCase() === 'true';

// ─── Disk Cache ───────────────────────────────────────────────────
const CACHE_DIR = path.join(__dirname, '..', '.webview-cache');
const CACHE_TTL = 20 * 24 * 60 * 60 * 1000; // 20x = 20 days (was 24 hours)

// Ensure cache directory exists
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

function cacheKey(url) {
  return crypto.createHash('md5').update(url).digest('hex');
}

function readCache(url) {
  try {
    const filePath = path.join(CACHE_DIR, cacheKey(url) + '.html');
    const stat = fs.statSync(filePath);
    if (Date.now() - stat.mtimeMs < CACHE_TTL) {
      const html = fs.readFileSync(filePath, 'utf8');
      if (html.length > 500) {
        console.log(`💾 [CACHE HIT] ${url} (${html.length} bytes, age: ${Math.round((Date.now() - stat.mtimeMs) / 60000)}m)`);
        return html;
      }
    } else {
      fs.unlinkSync(filePath); // Expired
    }
  } catch {}
  return null;
}

function writeCache(url, html) {
  try {
    const filePath = path.join(CACHE_DIR, cacheKey(url) + '.html');
    fs.writeFileSync(filePath, html, 'utf8');
    console.log(`💾 [CACHE WRITE] ${url} (${html.length} bytes)`);
  } catch (e) {
    console.warn(`⚠️ [CACHE] Write failed: ${e.message}`);
  }
}

// ─── Constants ────────────────────────────────────────────────────
const httpsAgent = new https.Agent({ rejectUnauthorized: !ALLOW_INSECURE_WEBVIEW_TLS, keepAlive: true });

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
];

const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// Minimum usable HTML length (below this is likely an error page)
const MIN_HTML_LENGTH = 200;

// ═══════════════════════════════════════════════════════════════════
// STRATEGY 1: Direct Fetch (with retries)
// ═══════════════════════════════════════════════════════════════════
async function fetchDirect(targetUrl, retries = 2) {
  const baseOrigin = new URL(targetUrl).origin;
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`🌐 [DIRECT] Attempt ${attempt}/${retries}: ${targetUrl}`);
      const response = await axios.get(targetUrl, {
        headers: {
          'User-Agent': randomUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'bn-BD,bn;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
        },
        timeout: 25000,
        maxRedirects: 10,
        responseType: 'text',
        validateStatus: () => true, // Accept ALL status codes
        decompress: true,
        httpsAgent,
      });

      const html = response.data;
      const status = response.status;
      console.log(`📡 [DIRECT] Status: ${status} | Length: ${html?.length || 0}`);

      // Check if the response is usable (200 OK + enough HTML content)
      if (status >= 200 && status < 400 && html && html.length > MIN_HTML_LENGTH) {
        return { html, origin: baseOrigin, source: 'direct' };
      }

      // Server-error or tiny error body — retry or fall through
      console.warn(`⚠️ [DIRECT] Unusable response (status ${status}, ${html?.length || 0} bytes)`);
      lastError = new Error(`Server returned ${status}: ${(html || '').substring(0, 100)}`);
    } catch (err) {
      console.warn(`⚠️ [DIRECT] Attempt ${attempt} failed: ${err.message}`);
      lastError = err;
    }

    if (attempt < retries) {
      const delay = 1500 * attempt;
      console.log(`⏳ [DIRECT] Waiting ${delay}ms before retry...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError || new Error('Direct fetch failed');
}

// ═══════════════════════════════════════════════════════════════════
// STRATEGY 2: Wayback Machine (archive.org)
// ═══════════════════════════════════════════════════════════════════
async function fetchWayback(targetUrl) {
  console.log(`📚 [WAYBACK] Looking up archived version of: ${targetUrl}`);

  const parsedUrl = new URL(targetUrl);
  const baseOrigin = parsedUrl.origin;

  // Build a list of URLs to try, from most specific to domain root
  const urlsToTry = [targetUrl];
  // Try without the Bangla slug (just UUID path)
  const pathParts = parsedUrl.pathname.split('/');
  if (pathParts.length > 3) {
    // Try progressively shorter paths
    for (let i = pathParts.length - 1; i >= 2; i--) {
      const shortPath = pathParts.slice(0, i).join('/');
      if (shortPath && shortPath !== parsedUrl.pathname) {
        urlsToTry.push(`${baseOrigin}${shortPath}`);
      }
    }
  }
  // Always try domain root as last resort
  urlsToTry.push(baseOrigin + '/');

  // De-duplicate
  const uniqueUrls = [...new Set(urlsToTry)];

  for (const candidateUrl of uniqueUrls) {
    // Step 1: Ask the Wayback availability API for the best snapshot
    let snapshotUrl = null;
    try {
      const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(candidateUrl)}`;
      const apiResp = await axios.get(apiUrl, { timeout: 10000, httpsAgent, validateStatus: () => true });
      const snap = apiResp.data?.archived_snapshots?.closest;
      if (snap && snap.available && snap.url) {
        snapshotUrl = snap.url.replace(/^http:/, 'https:');
        console.log(`📚 [WAYBACK] Found snapshot for ${candidateUrl}: ${snapshotUrl} (${snap.timestamp})`);
      }
    } catch (e) {
      console.warn(`⚠️ [WAYBACK] API lookup failed for ${candidateUrl}: ${e.message}`);
    }

    // Step 2: If no API match, try generic latest-year URL
    if (!snapshotUrl) {
      const year = new Date().getFullYear();
      snapshotUrl = `https://web.archive.org/web/${year}/${candidateUrl}`;
    }

    // Step 3: Fetch the snapshot
    try {
      const response = await axios.get(snapshotUrl, {
        headers: {
          'User-Agent': randomUA(),
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        },
        timeout: 30000,
        maxRedirects: 10,
        responseType: 'text',
        validateStatus: () => true,
        decompress: true,
        httpsAgent,
      });

      if (response.status >= 200 && response.status < 400 && response.data?.length > MIN_HTML_LENGTH) {
        console.log(`✅ [WAYBACK] Got ${response.data.length} bytes from: ${candidateUrl}`);
        const html = cleanWaybackHtml(response.data, targetUrl);
        return { html, origin: baseOrigin, source: 'wayback' };
      }

      console.log(`⚠️ [WAYBACK] Status ${response.status} for ${candidateUrl}, trying next...`);
    } catch (err) {
      console.warn(`⚠️ [WAYBACK] Fetch failed for ${candidateUrl}: ${err.message}`);
    }
  }

  throw new Error('No Wayback snapshots found for any URL variant');
}

/**
 * Remove Wayback Machine's injected toolbar, banner and rewriting scripts
 * while keeping the original page content intact.
 */
function cleanWaybackHtml(html, originalUrl) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const baseOrigin = new URL(originalUrl).origin;

  // Remove Wayback toolbar / banner
  $('#wm-ipp-base').remove();
  $('#wm-ipp').remove();
  $('#wm-ipp-print').remove();
  $('#donato').remove();
  $('#__wb_log').remove();

  // Remove Wayback injected scripts
  $('script').each((_, el) => {
    const src = $(el).attr('src') || '';
    const content = $(el).html() || '';
    if (
      src.includes('archive.org') ||
      src.includes('web.archive.org') ||
      content.includes('__wm.init') ||
      content.includes('wombat') ||
      content.includes('archive_analytics')
    ) {
      $(el).remove();
    }
  });

  // Remove Wayback inserted links/styles
  $('link').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('archive.org') || href.includes('web.archive.org')) {
      $(el).remove();
    }
  });

  // Rewrite Wayback-modified URLs back to original domain
  // Wayback rewrites URLs like: /web/20250528084325/https://domain.com/path → https://domain.com/path
  const waybackPattern = /https?:\/\/web\.archive\.org\/web\/\d+\//gi;

  $('a[href], link[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) $(el).attr('href', href.replace(waybackPattern, ''));
  });
  $('img[src], script[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) $(el).attr('src', src.replace(waybackPattern, ''));
  });

  // Fix inline styles with wayback URLs
  $('[style]').each((_, el) => {
    let style = $(el).attr('style');
    if (style && style.includes('web.archive.org')) {
      $(el).attr('style', style.replace(waybackPattern, ''));
    }
  });

  // Remove the toolbar height CSS variable
  $('html').css('--wm-toolbar-height', '');

  return $.html();
}

// ═══════════════════════════════════════════════════════════════════
// STRATEGY 3: Google Cache
// ═══════════════════════════════════════════════════════════════════
async function fetchGoogleCache(targetUrl) {
  console.log(`🔍 [GOOGLE CACHE] Looking up cached version of: ${targetUrl}`);

  const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(targetUrl)}&hl=en&gl=bd`;

  try {
    const response = await axios.get(cacheUrl, {
      headers: {
        'User-Agent': randomUA(),
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'bn-BD,bn;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      timeout: 15000,
      maxRedirects: 5,
      responseType: 'text',
      validateStatus: () => true,
      decompress: true,
      httpsAgent,
    });

    if (response.status >= 200 && response.status < 400 && response.data?.length > MIN_HTML_LENGTH) {
      console.log(`✅ [GOOGLE CACHE] Got ${response.data.length} bytes`);
      // Strip Google Cache banner
      const $ = cheerio.load(response.data, { decodeEntities: false });
      $('div[style*="ARCHIVE"]').remove();
      $('div').filter((_, el) => ($(el).text() || '').includes("Google's cache")).remove();
      const baseOrigin = new URL(targetUrl).origin;
      return { html: $.html(), origin: baseOrigin, source: 'google-cache' };
    }

    throw new Error(`Google Cache returned status ${response.status}`);
  } catch (err) {
    console.warn(`❌ [GOOGLE CACHE] Failed: ${err.message}`);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════
// STRATEGY 4: Playwright Headless Browser
// ═══════════════════════════════════════════════════════════════════
async function fetchPlaywright(targetUrl) {
  console.log(`🎭 [PLAYWRIGHT] Launching headless browser for: ${targetUrl}`);

  let browser = null;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: randomUA(),
    });
    const page = await ctx.newPage();

    const resp = await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
    const status = resp?.status() || 0;
    const html = await page.content();

    console.log(`🎭 [PLAYWRIGHT] Status: ${status} | Length: ${html.length}`);

    await browser.close();
    browser = null;

    if (html.length > MIN_HTML_LENGTH && status >= 200 && status < 400) {
      return { html, origin: new URL(targetUrl).origin, source: 'playwright' };
    }

    throw new Error(`Playwright got status ${status} with ${html.length} bytes`);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.warn(`❌ [PLAYWRIGHT] Failed: ${err.message}`);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN: fetchAndProxyWebpage — cascading fallback
// ═══════════════════════════════════════════════════════════════════
async function fetchAndProxyWebpage(targetUrl) {
  if (!targetUrl || typeof targetUrl !== 'string') {
    throw new Error('Invalid URL provided');
  }

  // Validate URL
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    throw new Error(`Invalid URL format: ${targetUrl}`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🌐 [WEBVIEW PROXY] Proxying: ${targetUrl}`);
  console.log(`${'═'.repeat(60)}`);

  let result = null;
  const errors = [];

  // ── Strategy 0: Disk cache (instant) ──────────────────────────
  const cachedHtml = readCache(targetUrl);
  if (cachedHtml) {
    return {
      html: cachedHtml,
      contentType: 'text/html; charset=utf-8',
    };
  }

  // ── Strategy 1: Direct fetch ─────────────────────────────────
  try {
    result = await fetchDirect(targetUrl, 2);
  } catch (err) {
    errors.push(`Direct: ${err.message}`);
    console.log(`⚠️ Direct fetch failed, trying Wayback Machine...`);
  }

  // ── Strategy 2: Wayback Machine ──────────────────────────────
  if (!result) {
    try {
      result = await fetchWayback(targetUrl);
    } catch (err) {
      errors.push(`Wayback: ${err.message}`);
      console.log(`⚠️ Wayback failed, trying Google Cache...`);
    }
  }

  // ── Strategy 3: Google Cache ──────────────────────────────────
  if (!result) {
    try {
      result = await fetchGoogleCache(targetUrl);
    } catch (err) {
      errors.push(`Google Cache: ${err.message}`);
      console.log(`⚠️ Google Cache failed, trying Playwright...`);
    }
  }

  // ── Strategy 4: Playwright ────────────────────────────────────
  if (!result) {
    try {
      result = await fetchPlaywright(targetUrl);
    } catch (err) {
      errors.push(`Playwright: ${err.message}`);
      console.log(`❌ All strategies failed.`);
    }
  }

  // ── All failed → build error page ─────────────────────────────
  if (!result) {
    console.error(`❌ [WEBVIEW PROXY] All strategies failed for ${targetUrl}`);
    errors.forEach((e) => console.error(`   - ${e}`));
    return {
      html: buildErrorPage(targetUrl, errors),
      contentType: 'text/html; charset=utf-8',
    };
  }

  // ── Process & sanitize the HTML ────────────────────────────────
  const baseOrigin = result.origin;
  const html = result.html;
  const source = result.source;

  console.log(`✅ [WEBVIEW PROXY] Using source: ${source} (${html.length} bytes)`);

  const $ = cheerio.load(html, { decodeEntities: false, xmlMode: false });

  // 1. Inject <base href>
  $('base').remove();
  $('meta[http-equiv="Content-Security-Policy"]').remove();
  $('meta[http-equiv="X-Frame-Options"]').remove();
  $('head').prepend(`<base href="${baseOrigin}/" target="_blank">`);

  // 2. Fix relative URLs
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !href.startsWith('http') && !href.startsWith('//') && !href.startsWith('data:')) {
      try { $(el).attr('href', new URL(href, baseOrigin).href); } catch {}
    }
  });

  $('script[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src && !src.startsWith('http') && !src.startsWith('//') && !src.startsWith('data:')) {
      try { $(el).attr('src', new URL(src, baseOrigin).href); } catch {}
    }
  });

  $('img[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src && !src.startsWith('http') && !src.startsWith('//') && !src.startsWith('data:')) {
      try { $(el).attr('src', new URL(src, baseOrigin).href); } catch {}
    }
  });

  $('[style*="background"]').each((_, el) => {
    let style = $(el).attr('style');
    if (style) {
      style = style.replace(/url\(['"]?(?!http|data:)([^'")]+)['"]?\)/gi, (match, path) => {
        try { return `url('${new URL(path, baseOrigin).href}')`; } catch { return match; }
      });
      $(el).attr('style', style);
    }
  });

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      $(el).attr('target', '_blank');
      $(el).attr('rel', 'noopener noreferrer');
      if (!href.startsWith('http') && !href.startsWith('//')) {
        try { $(el).attr('href', new URL(href, baseOrigin).href); } catch {}
      }
    }
  });

  // 3. CSS fixes for iframe display
  const sourceLabel = source === 'wayback' ? 'আর্কাইভ সংস্করণ (Wayback Machine)' : (source === 'playwright' ? 'ব্রাউজার রেন্ডার' : 'সরাসরি');
  $('head').append(`
    <style id="jaani-proxy-fixes">
      html, body { overflow: auto !important; height: auto !important; min-height: 100vh; }
      .fixed-top, .sticky-top { position: relative !important; }
      img { max-width: 100%; height: auto; }
    </style>
  `);

  // 4. Source indicator banner (so user knows if this is a cached version)
  if (source !== 'direct') {
    $('body').prepend(`
      <div id="jaani-source-banner" style="
        background: linear-gradient(135deg, #006a4e, #004d38);
        color: #fff;
        text-align: center;
        padding: 6px 16px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 12px;
        position: sticky;
        top: 0;
        z-index: 99999;
        border-bottom: 2px solid #c5a55a;
      ">
        📚 ${sourceLabel} — মূল সাইটটি বর্তমানে অনুপলব্ধ তাই ক্যাশে সংস্করণ দেখানো হচ্ছে
        <button onclick="this.parentElement.remove()" style="
          background: none; border: 1px solid rgba(255,255,255,0.4); color: #fff;
          border-radius: 3px; padding: 2px 8px; margin-left: 12px; cursor: pointer; font-size: 11px;
        ">✕ বন্ধ করুন</button>
      </div>
    `);
  }

  // 5. Remove frame-busting scripts
  $('script').each((_, el) => {
    const content = $(el).html() || '';
    if (
      content.includes('top.location') ||
      content.includes('parent.location') ||
      content.includes('frameElement') ||
      content.includes('top !== self')
    ) {
      $(el).remove();
    }
  });

  // 6. Inject proxy script
  $('body').append(`
    <script id="jaani-proxy-script">
      document.querySelectorAll('form').forEach(function(f){f.setAttribute('target','_blank')});
      console.log('[JAANI Proxy] Page loaded via ${source}');
    </script>
  `);

  const modifiedHtml = $.html();
  console.log(`✅ [WEBVIEW PROXY] Final HTML: ${modifiedHtml.length} bytes (source: ${source})`);

  // ── Cache to disk for instant future loads ─────────────────────
  writeCache(targetUrl, modifiedHtml);

  return {
    html: modifiedHtml,
    contentType: 'text/html; charset=utf-8',
  };
}

// ═══════════════════════════════════════════════════════════════════
// Error page builder
// ═══════════════════════════════════════════════════════════════════
function buildErrorPage(targetUrl, errors) {
  const errorList = errors.map((e) => `<li>${e}</li>`).join('\n');
  return `<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>সংযোগ সমস্যা</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; background: #f7faf5; color: #1b2e1b; padding: 24px;
    }
    .card {
      background: #fff; border-radius: 8px; padding: 32px 28px;
      max-width: 480px; width: 100%; text-align: center;
      border: 1px solid #b9d3b0; box-shadow: 0 2px 12px rgba(0,106,78,.08);
    }
    .icon { font-size: 48px; margin-bottom: 12px; }
    h1 { font-size: 1.15rem; color: #6a1b25; margin-bottom: 6px; }
    p { font-size: 0.85rem; color: #4b6043; margin: 4px 0; line-height: 1.5; }
    .url {
      font-family: monospace; font-size: 0.72rem; background: #e8f5e9;
      padding: 10px; border-radius: 4px; word-break: break-all;
      max-width: 100%; margin: 14px 0; border: 1px solid #b9d3b0;
      text-align: left;
    }
    .errors { text-align: left; font-size: 0.72rem; color: #888; margin: 12px 0; }
    .errors li { margin: 2px 0; }
    .btn {
      display: inline-block; margin-top: 16px; padding: 10px 20px;
      background: #006a4e; color: #fff; border: none; border-radius: 4px;
      cursor: pointer; font-size: 0.85rem; font-weight: 600;
      text-decoration: none;
    }
    .btn:hover { background: #004d38; }
    .note { font-size: 0.72rem; color: #999; margin-top: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔗</div>
    <h1>সংযোগ করা যাচ্ছে না</h1>
    <p>সরকারি ওয়েবসাইটটি বর্তমানে অনুপলব্ধ। সার্ভারটি রক্ষণাবেক্ষণ বা সাময়িক সমস্যায় থাকতে পারে।</p>
    <div class="url">${targetUrl}</div>
    <ul class="errors">${errorList}</ul>
    <a class="btn" href="${targetUrl}" target="_blank" rel="noopener">নতুন ট্যাবে খুলুন ↗</a>
    <p class="note">সরাসরি সংযোগ, আর্কাইভ ও ব্রাউজার রেন্ডার — তিনটি পদ্ধতিই চেষ্টা করা হয়েছে।</p>
  </div>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════
// Extract Profile Image (unchanged)
// ═══════════════════════════════════════════════════════════════════
async function extractProfileImage(targetUrl) {
  if (!targetUrl) return null;

  try {
    const userAgent = randomUA();

    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 10000,
      responseType: 'text',
      httpsAgent,
      validateStatus: () => true,
    });

    if (!response.data || response.data.length < MIN_HTML_LENGTH) return null;

    const $ = cheerio.load(response.data);
    const baseOrigin = new URL(targetUrl).origin;

    const profileSelectors = [
      '.profile-image img',
      '.officer-photo img',
      '.photo img',
      '.card-img img',
      '.member-photo img',
      'img.profile',
      'img.photo',
      'img[alt*="photo"]',
      'img[alt*="ছবি"]',
      '.content-area img:first',
      'article img:first',
      '.main-content img:first',
    ];

    let imageUrl = null;
    let maxArea = 0;

    for (const selector of profileSelectors) {
      const img = $(selector).first();
      if (img.length) {
        const src = img.attr('src');
        if (src && !src.includes('logo') && !src.includes('icon') && !src.includes('banner')) {
          imageUrl = src.startsWith('http') ? src : new URL(src, baseOrigin).href;
          break;
        }
      }
    }

    if (!imageUrl) {
      $('img').each((_, el) => {
        const src = $(el).attr('src');
        const width = parseInt($(el).attr('width') || '0', 10);
        const height = parseInt($(el).attr('height') || '0', 10);
        const area = width * height;

        if (src && area > maxArea && area > 5000 && area < 500000) {
          if (!src.includes('logo') && !src.includes('icon') && !src.includes('banner') && !src.includes('flag')) {
            maxArea = area;
            imageUrl = src.startsWith('http') ? src : new URL(src, baseOrigin).href;
          }
        }
      });
    }

    return imageUrl || null;
  } catch (error) {
    console.error(`❌ [IMAGE EXTRACTOR] Error: ${error.message}`);
    return null;
  }
}

module.exports = {
  fetchAndProxyWebpage,
  extractProfileImage,
};
