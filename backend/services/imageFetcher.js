/**
 * Image Fetcher Service — Live Officer Image Fetching (Upgrade 2 → v3)
 * 
 * Scrapes officer profile images from Bangladesh government portal pages.
 * Features:
 *   - **Three-tier extraction**: Playwright (SPA/JS) → Cheerio (fast) → Wayback Machine (archive)
 *   - In-memory + disk cache for instant repeat loads
 *   - Handles .gov.bd TLS certificate issues
 *   - Concurrent request limiting to avoid overwhelming gov servers
 *
 * Used by:
 *   - VerificationGrid.js (officer cards — fetches on mount for main card display)
 *   - GET /api/extract-image endpoint
 *   - POST /api/extract-images (batch) endpoint
 *   - POST /api/verify-contact (enrichment pass)
 */

const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Playwright — lazy-loaded because not every call needs a browser
let chromiumMod = null;
/**
 * Chromium for officer photos, launched through the same egress guard proxy as the Section 1 reader, so every
 * connection (redirect hops and sub-resources included) is checked for private/reserved addresses (brief 15.9).
 * ALLOW_PRIVATE_NETWORK_URLS=true (tests with a local mock portal only) launches without the proxy.
 */
async function launchGuardedBrowser(chromium) {
  const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-http2'];
  if (String(process.env.ALLOW_PRIVATE_NETWORK_URLS || '').toLowerCase() === 'true') {
    return chromium.launch({ headless: true, args });
  }
  const { startEgressGuardProxy } = require('../utils/egressGuardProxy');
  const proxy = await startEgressGuardProxy({
    onBlock: (entry) => console.warn(`🛡️ [ImageFetcher] egress guard blocked ${entry}`),
  });
  try {
    const browser = await chromium.launch({ headless: true, args, proxy: { server: proxy.server, bypass: '<-loopback>' } });
    browser.egressGuard = proxy;
    return browser;
  } catch (err) {
    await proxy.close();
    throw err;
  }
}

// Connect-time address check for plain HTTP fetches (redirect hops included): private/reserved answers are refused.
const { createOfficerUrlGuard } = require('../utils/officerUrlGuard');
const officerLookup = createOfficerUrlGuard({
  allowPrivateNetwork: String(process.env.ALLOW_PRIVATE_NETWORK_URLS || '').toLowerCase() === 'true',
}).lookup;

function getChromium() {
  if (!chromiumMod) {
    try { chromiumMod = require('playwright').chromium; } catch {
      try { chromiumMod = require('playwright-core').chromium; } catch {
        console.warn('⚠️ [ImageFetcher] Playwright not available — Cheerio-only mode');
        chromiumMod = false;
      }
    }
  }
  return chromiumMod || null;
}

// ── TLS fallback for Bangladesh government sites ─────────────────────
const INSECURE_TLS_AGENT = new https.Agent({ rejectUnauthorized: false });

// ── In-memory image URL cache (avoids repeated HTTP calls) ──────────
const imageCache = new Map();
const IMAGE_CACHE_TTL = 20 * 30 * 60 * 1000; // 20x = 10 hours (was 30 minutes)

// ── Disk cache directory ─────────────────────────────────────────────
const DISK_CACHE_DIR = path.join(__dirname, '..', 'data', 'image_cache');
try {
  if (!fs.existsSync(DISK_CACHE_DIR)) {
    fs.mkdirSync(DISK_CACHE_DIR, { recursive: true });
  }
} catch (e) {
  console.warn('⚠️ Could not create image cache directory:', e.message);
}

// ── Concurrency limiter (max 10 simultaneous gov.bd requests) ────────
let activeRequests = 0;
const MAX_CONCURRENT = 10;
const requestQueue = [];

function runWithLimit(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeRequests++;
      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          activeRequests--;
          if (requestQueue.length > 0) {
            const next = requestQueue.shift();
            next();
          }
        });
    };

    if (activeRequests < MAX_CONCURRENT) {
      run();
    } else {
      requestQueue.push(run);
    }
  });
}

// ── Cache helpers ────────────────────────────────────────────────────

function getCacheKey(url) {
  return crypto.createHash('md5').update(url).digest('hex');
}

function getFromMemoryCache(url) {
  const entry = imageCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > IMAGE_CACHE_TTL) {
    imageCache.delete(url);
    return null;
  }
  return entry.imageUrl;
}

function setMemoryCache(url, imageUrl) {
  imageCache.set(url, { imageUrl, timestamp: Date.now() });
}

function getFromDiskCache(url) {
  try {
    const key = getCacheKey(url);
    const cachePath = path.join(DISK_CACHE_DIR, `${key}.json`);
    if (!fs.existsSync(cachePath)) return null;

    const stat = fs.statSync(cachePath);
    const ageMs = Date.now() - stat.mtimeMs;
    // Disk cache: 20x = 20 days (was 24 hours)
    if (ageMs > 20 * 24 * 60 * 60 * 1000) {
      try { fs.unlinkSync(cachePath); } catch {}
      return null;
    }

    const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    return data.imageUrl || null;
  } catch {
    return null;
  }
}

function setDiskCache(url, imageUrl) {
  try {
    const key = getCacheKey(url);
    const cachePath = path.join(DISK_CACHE_DIR, `${key}.json`);
    fs.writeFileSync(cachePath, JSON.stringify({ url, imageUrl, cachedAt: new Date().toISOString() }));
  } catch {
    // Silently fail — disk cache is optional
  }
}

// ── Profile selectors for BD government portal pages ─────────────────

const GOV_PROFILE_SELECTORS = [
  // ══ HIGHEST PRIORITY: National Portal V2 (*.portal.gov.bd / *.gov.bd) ══
  // The Bangladesh National Portal V2 uses info-officer-view-widget with
  // list-card-image class. These are the MOST reliable selectors for gov.bd.
  '.info-officer-view-widget img.list-card-image',
  '.info-officer-view img.list-card-image',
  '.list-card-body img.list-card-image',
  '.image-section img.list-card-image',
  'img.list-card-image',
  '.info-officer-view-widget .image-section img',
  '.info-officer-view .image-section img',
  '.list-card-body .image-section img',

  // ── Specific selectors for older/custom gov.bd portals ──
  '.officer-info img',
  '.officer-details img',
  '.কর্মকর্তা img',
  '[class*="officer"] img:not([alt*="banner"]):not([alt*="logo"])',
  '[class*="কর্মকর্তা"] img',
  '.duty-officer img',
  '.rti-officer img',
  '.designated-officer img',

  // National Portal / LGD style
  '.profile-image img',
  '.officer-photo img',
  '.photo img',
  '.card-img img',
  '.member-photo img',
  '.personnel-photo img',
  '.official-image img',

  // Common class patterns
  'img.profile',
  'img.photo',
  'img.officer-img',
  'img[alt*="photo"]',
  'img[alt*="ছবি"]',
  'img[alt*="Photo"]',
  'img[alt*="Officer"]',
  'img[alt*="কর্মকর্তা"]',

  // Table-based layouts (common in BD gov sites)
  'table img[src*="photo"]',
  'table img[src*="image"]',
  'table img[src*="pic"]',
  'table img[src*="upload"]',

  // ID card style sections
  '.id-card img',
  '.card-box img',
  '.info-card img',

  // Generic content area first image
  '.content-area img:first-of-type',
  'article img:first-of-type',
  '.main-content img:first-of-type',
];

// ── Patterns to EXCLUDE from profile images ──────────────────────────
const EXCLUDE_PATTERNS = [
  'logo', 'icon', 'banner', 'flag', 'seal', 'emblem',
  'header', 'footer', 'background', 'sprite',
  'advert', 'advertisement', 'social', 'facebook', 'twitter',
  'whatsapp', 'share', 'arrow', 'button', 'loading',
  'placeholder', 'default', 'no-image', 'noimage',
  // ── UPGRADED: Add landscape/scenery patterns ──
  'landscape', 'scenery', 'building', 'architecture',
  'slider', 'slide', 'gallery', 'carousel',
  'cover', 'hero', 'intro', 'welcome',
];

// ── CSS class patterns to EXCLUDE (checked separately from src/alt) ──
const EXCLUDE_CLASS_PATTERNS = [
  'slider-image', 'office-logo', 'technical-support',
  'carousel', 'banner', 'hero', 'logo', 'icon',
  'footer', 'header', 'nav-', 'navbar',
];

function isLikelyProfileImage(src, alt = '', width = 0, height = 0, cssClass = '') {
  if (!src) return false;
  const srcLower = src.toLowerCase();
  const altLower = (alt || '').toLowerCase();
  const clsLower = (cssClass || '').toLowerCase();

  // ── Check class-based exclusions first ──
  if (clsLower && EXCLUDE_CLASS_PATTERNS.some(p => clsLower.includes(p))) return false;

  // Exclude known non-profile patterns
  if (EXCLUDE_PATTERNS.some(p => srcLower.includes(p) || altLower.includes(p))) return false;

  // ── Known positive class: list-card-image (National Portal V2 officer photos) ──
  if (clsLower.includes('list-card-image')) return true;

  // If dimensions available, check aspect ratio (portrait or square preferred)
  if (width > 0 && height > 0) {
    const ratio = width / height;
    // ── UPGRADED: Stricter aspect ratio check ──
    // Profile photos are typically portrait (0.65-1.0) or square (0.9-1.1)
    // REJECT wide landscape photos (ratio > 1.3)
    if (ratio > 1.3 || ratio < 0.5) return false;
    // Skip very tiny images (likely icons)
    if (width < 60 || height < 80) return false;
    // ── UPGRADED: More restrictive max dimensions ──
    // Profile photos are rarely larger than 600x800
    if (width > 600 || height > 800) return false;
  }

  return true;
}

function isHttpUrl(value = '') {
  return /^https?:\/\//i.test(String(value || ''));
}

function collectIframeUrlsFromHtml(html, baseUrl) {
  try {
    const $ = cheerio.load(html || '');
    const urls = [];
    $('iframe[src], frame[src]').each((_, el) => {
      const raw = ($(el).attr('src') || '').trim();
      if (!raw || raw.startsWith('javascript:') || raw.startsWith('data:')) return;
      try {
        const resolved = new URL(raw, baseUrl).href;
        if (isHttpUrl(resolved)) urls.push(resolved);
      } catch {}
    });
    return Array.from(new Set(urls)).slice(0, 8);
  } catch {
    return [];
  }
}

async function fetchIframeOfficerImages(iframeUrls = [], maxCount = 5) {
  const found = [];
  if (!Array.isArray(iframeUrls) || iframeUrls.length === 0) return found;

  for (const iframeUrl of iframeUrls) {
    if (found.length >= maxCount) break;
    try {
      let hostname = '';
      try { hostname = new URL(iframeUrl).hostname.toLowerCase(); } catch {}
      const isGovBd = hostname.endsWith('.gov.bd') || hostname.endsWith('.portal.gov.bd');
      const httpsAgent = isGovBd ? INSECURE_TLS_AGENT : undefined;

      const response = await axios.get(iframeUrl, {
          lookup: officerLookup,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'bn-BD,bn;q=0.9,en-US;q=0.8,en;q=0.7',
        },
        timeout: 12000,
        maxRedirects: 5,
        responseType: 'text',
        ...(httpsAgent ? { httpsAgent } : {}),
        validateStatus: () => true,
      });

      const html = response?.data;
      if (!html || typeof html !== 'string' || html.length < 300) continue;

      const iframeCandidates = extractAllImagesFromHtml(html, iframeUrl, maxCount);
      for (const imageUrl of iframeCandidates) {
        if (!found.includes(imageUrl)) {
          found.push(imageUrl);
          if (found.length >= maxCount) break;
        }
      }
    } catch {
      // skip this iframe source
    }
  }

  return found;
}

// ── Main extraction function ─────────────────────────────────────────

/**
 * Fetch officer profile image from a government website URL
 * THREE-TIER STRATEGY:
 *   1. Playwright (handles JS-rendered gov.bd SPAs)
 *   2. Cheerio/Axios (fast, works for static sites)
 *   3. Wayback Machine (archive fallback when live site fails)
 * 
 * @param {string} targetUrl - Government website URL
 * @param {Object} options - { forceRefresh?: boolean }
 * @returns {Promise<string|null>} - Image URL or null
 */
async function fetchOfficerImage(targetUrl, options = {}) {
  if (!targetUrl) return null;

  // Check memory cache first
  if (!options.forceRefresh) {
    const memCached = getFromMemoryCache(targetUrl);
    if (memCached !== null) {
      console.log(`⚡ [ImageFetcher] Memory cache hit for ${targetUrl}`);
      return memCached || null;
    }

    // Check disk cache
    const diskCached = getFromDiskCache(targetUrl);
    if (diskCached !== null) {
      console.log(`💾 [ImageFetcher] Disk cache hit for ${targetUrl}`);
      setMemoryCache(targetUrl, diskCached);
      return diskCached || null;
    }
  }

  console.log(`🔍 [ImageFetcher] Fetching profile image from: ${targetUrl}`);

  return runWithLimit(async () => {
    let imageUrl = null;

    // ──────────────────────────────────────────────
    // STRATEGY 1: Playwright (best for JS-rendered gov.bd portals)
    // ──────────────────────────────────────────────
    const chromium = getChromium();
    if (chromium && !imageUrl) {
      let browser;
      try {
        console.log(`🎭 [ImageFetcher] Strategy 1: Playwright for ${targetUrl}`);
        browser = await launchGuardedBrowser(chromium);
        const context = await browser.newContext({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          ignoreHTTPSErrors: true,
          locale: 'bn-BD,bn;q=0.9',
        });
        const page = await context.newPage();
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000); // wait for JS renders

        // Try to find officer images inside browser context
        imageUrl = await page.evaluate((args) => {
          const { selectors, excludePatterns, excludeClassPatterns } = args;
          const isExcluded = (src, alt, cls) => {
            const combined = ((src || '') + ' ' + (alt || '')).toLowerCase();
            if (excludePatterns.some(p => combined.includes(p))) return true;
            // Also check CSS class for exclusion
            const clsLower = (cls || '').toLowerCase();
            if (clsLower && excludeClassPatterns.some(p => clsLower.includes(p))) return true;
            return false;
          };

          const isPortrait = (img) => {
            const w = img.naturalWidth || img.width || parseInt(img.getAttribute('width') || '0');
            const h = img.naturalHeight || img.height || parseInt(img.getAttribute('height') || '0');
            if (w > 0 && h > 0) {
              const ratio = w / h;
              if (ratio > 1.4 || ratio < 0.4) return false; // landscape or too narrow
              if (w < 40 || h < 50) return false; // too small (icon)
            }
            return true;
          };

          // Priority 1: Targeted selectors (includes National Portal V2 selectors)
          for (const sel of selectors) {
            try {
              const img = document.querySelector(sel);
              if (!img) continue;
              const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
              if (!src || src.startsWith('data:')) continue;
              if (isExcluded(src, img.getAttribute('alt'), img.getAttribute('class'))) continue;
              if (!isPortrait(img)) continue;
              return src.startsWith('http') ? src : new URL(src, window.location.origin).href;
            } catch {}
          }

          // Priority 2: Score all images
          const candidates = [];
          document.querySelectorAll('img').forEach((img) => {
            const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
            if (!src || src.startsWith('data:')) return;
            const imgClass = img.getAttribute('class') || '';
            if (isExcluded(src, img.getAttribute('alt'), imgClass)) return;
            if (!isPortrait(img)) return;

            const w = img.naturalWidth || img.width || parseInt(img.getAttribute('width') || '0');
            const h = img.naturalHeight || img.height || parseInt(img.getAttribute('height') || '0');
            let score = 0;
            const combined = (src + ' ' + (img.getAttribute('alt') || '')).toLowerCase();
            if (/photo|profile|officer|portrait|pic|ছবি|কর্মকর্তা|upload/i.test(combined)) score += 8;
            if (w > 60 && w < 500 && h > 80 && h < 600) score += 5;
            if (w > 0 && h > 0 && h >= w) score += 4; // portrait
            if (/thumb|small|tiny|mini/i.test(combined)) score -= 3;

            // ── National Portal V2: boost list-card-image class ──
            if (imgClass.includes('list-card-image')) score += 12;
            // Check parent/ancestor for officer-related containers
            const parent = img.closest('[class*="officer"], [class*="কর্মকর্তা"], .profile-image, .photo, .card, .info-officer-view-widget, .info-officer-view, .list-card-body');
            if (parent) score += 6;

            const resolved = src.startsWith('http') ? src : (() => {
              try { return new URL(src, window.location.origin).href; } catch { return ''; }
            })();
            if (resolved) candidates.push({ url: resolved, score });
          });

          candidates.sort((a, b) => b.score - a.score);
          return candidates.length > 0 && candidates[0].score >= 4 ? candidates[0].url : null;
        }, { selectors: GOV_PROFILE_SELECTORS, excludePatterns: EXCLUDE_PATTERNS, excludeClassPatterns: EXCLUDE_CLASS_PATTERNS });

        if (imageUrl) {
          console.log(`✅ [ImageFetcher] Playwright found: ${imageUrl.substring(0, 100)}`);
        }

        if (!imageUrl) {
          try {
            const iframeUrls = await page.evaluate(() => {
              const urls = [];
              document.querySelectorAll('iframe[src], frame[src]').forEach((el) => {
                const raw = (el.getAttribute('src') || '').trim();
                if (!raw || raw.startsWith('javascript:') || raw.startsWith('data:')) return;
                try {
                  urls.push(new URL(raw, window.location.href).href);
                } catch {}
              });
              return Array.from(new Set(urls)).slice(0, 8);
            });

            const iframeImages = await fetchIframeOfficerImages(iframeUrls, 3);
            if (iframeImages.length > 0) {
              imageUrl = iframeImages[0];
              console.log(`✅ [ImageFetcher] Playwright iframe found: ${imageUrl.substring(0, 100)}`);
            }
          } catch (iframeErr) {
            console.warn(`⚠️ [ImageFetcher] Playwright iframe extraction failed: ${iframeErr.message}`);
          }
        }
      } catch (err) {
        console.warn(`⚠️ [ImageFetcher] Playwright failed: ${err.message}`);
      } finally {
        try { if (browser) await browser.close(); } catch {}
        try { if (browser && browser.egressGuard) await browser.egressGuard.close(); } catch {}
      }
    }

    // ──────────────────────────────────────────────
    // STRATEGY 2: Cheerio / Axios (fast, static HTML)
    // ──────────────────────────────────────────────
    if (!imageUrl) {
      try {
        console.log(`⚡ [ImageFetcher] Strategy 2: Cheerio for ${targetUrl}`);
        let hostname = '';
        try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch {}
        const isGovBd = hostname.endsWith('.gov.bd') || hostname.endsWith('.portal.gov.bd');
        const httpsAgent = isGovBd ? INSECURE_TLS_AGENT : undefined;

        const response = await axios.get(targetUrl, {
          lookup: officerLookup,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'bn-BD,bn;q=0.9,en-US;q=0.8,en;q=0.7',
          },
          timeout: 12000,
          maxRedirects: 5,
          responseType: 'text',
          ...(httpsAgent ? { httpsAgent } : {}),
          validateStatus: () => true,
        });

        if (response.data && typeof response.data === 'string' && response.data.length >= 500) {
          imageUrl = extractImageFromHtml(response.data, targetUrl);
          if (!imageUrl) {
            const iframeUrls = collectIframeUrlsFromHtml(response.data, targetUrl);
            const iframeImages = await fetchIframeOfficerImages(iframeUrls, 2);
            if (iframeImages.length > 0) imageUrl = iframeImages[0];
          }
          if (imageUrl) {
            console.log(`✅ [ImageFetcher] Cheerio found: ${imageUrl.substring(0, 100)}`);
          }
        }
      } catch (err) {
        console.warn(`⚠️ [ImageFetcher] Cheerio failed: ${err.message}`);
      }
    }

    // ──────────────────────────────────────────────
    // STRATEGY 3: Wayback Machine (archive.org) fallback
    // ──────────────────────────────────────────────
    if (!imageUrl) {
      try {
        console.log(`🏛️ [ImageFetcher] Strategy 3: Wayback Machine for ${targetUrl}`);
        const waybackUrl = await getWaybackUrl(targetUrl);
        if (waybackUrl) {
          const wbResponse = await axios.get(waybackUrl, {
          lookup: officerLookup,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'text/html',
            },
            timeout: 15000,
            maxRedirects: 5,
            responseType: 'text',
            validateStatus: () => true,
          });

          if (wbResponse.data && typeof wbResponse.data === 'string' && wbResponse.data.length >= 500) {
            imageUrl = extractImageFromHtml(wbResponse.data, waybackUrl);
            if (imageUrl) {
              // Wayback URLs embed original URLs; try to extract the original image URL
              const originalImage = extractOriginalUrlFromWayback(imageUrl);
              imageUrl = originalImage || imageUrl;
              console.log(`✅ [ImageFetcher] Wayback found: ${imageUrl.substring(0, 100)}`);
            }
          }
        }
      } catch (err) {
        console.warn(`⚠️ [ImageFetcher] Wayback failed: ${err.message}`);
      }
    }

    // Cache the result (or cache negative result)
    const result = imageUrl || '';
    setMemoryCache(targetUrl, result);
    setDiskCache(targetUrl, result);

    if (imageUrl) {
      console.log(`✅ [ImageFetcher] Final image: ${imageUrl.substring(0, 100)}`);
    } else {
      console.log(`⚠️ [ImageFetcher] No profile image found for ${targetUrl}`);
    }

    return imageUrl || null;
  });
}

// ── Cheerio-based image extraction (shared between Strategy 2 and Wayback) ──

function extractImageFromHtml(html, baseUrl) {
  const results = extractAllImagesFromHtml(html, baseUrl, 1);
  return results.length > 0 ? results[0] : null;
}

/**
 * Extract MULTIPLE candidate profile images from HTML (for multi-officer pages).
 * Returns an array of up to `maxCount` unique image URLs, sorted by relevance score.
 * @param {string} html
 * @param {string} baseUrl
 * @param {number} maxCount - Maximum number of images to return (default 5)
 * @returns {string[]}
 */
function extractAllImagesFromHtml(html, baseUrl, maxCount = 5) {
  const $ = cheerio.load(html);
  let baseOrigin = '';
  try { baseOrigin = new URL(baseUrl).origin; } catch {}

  const HIGH_CONFIDENCE_SELECTORS = [
    // ══ National Portal V2 (highest confidence) ══
    '.info-officer-view-widget img.list-card-image',
    '.info-officer-view img.list-card-image',
    '.list-card-body img.list-card-image',
    '.image-section img.list-card-image',
    'img.list-card-image',
    '.info-officer-view-widget .image-section img',
    '.info-officer-view .image-section img',
    '.list-card-body .image-section img',
    // ── Older gov.bd portals ──
    '.officer-info img', '.officer-details img', '.duty-officer img',
    '.rti-officer img', '.designated-officer img', '.officer-photo img',
    '[class*="officer"] img:not([alt*="banner"]):not([alt*="logo"])',
    '[class*="কর্মকর্তা"] img', '.কর্মকর্তা img',
    '.profile-image img', '.personnel-photo img', '.official-image img',
  ];

  const resolvedSet = new Set();
  const allCandidates = [];

  const resolveUrl = (src) => {
    if (!src || src.startsWith('data:')) return '';
    try {
      return src.startsWith('http') ? src : new URL(src, baseOrigin || baseUrl).href;
    } catch { return ''; }
  };

  const addCandidate = (url, score) => {
    if (!url || resolvedSet.has(url)) return;
    resolvedSet.add(url);
    allCandidates.push({ url, score });
  };

  // Pass 1: Targeted CSS selectors (high-confidence)
  for (const selector of GOV_PROFILE_SELECTORS) {
    // Use .each() to find ALL matching images, not just first
    $(selector).each((_, el) => {
      const img = $(el);
      const src = img.attr('src') || img.attr('data-src') || img.attr('data-lazy-src') || '';
      const alt = img.attr('alt') || '';
      const cssClass = img.attr('class') || '';
      if (!src || src.startsWith('data:')) return;

      const clsLower = cssClass.toLowerCase();
      // Check class-based exclusions (e.g. slider-image)
      if (EXCLUDE_CLASS_PATTERNS.some(p => clsLower.includes(p))) return;

      const isHighConf = HIGH_CONFIDENCE_SELECTORS.includes(selector);
      const width = parseInt(img.attr('width') || '0', 10);
      const height = parseInt(img.attr('height') || '0', 10);

      // For HIGH CONFIDENCE selectors, trust the selector and skip generic URL-based exclusion
      // (oraclecloud hash URLs can accidentally match patterns like 'ad', 'bg', etc.)
      if (isHighConf) {
        const resolved = resolveUrl(src);
        if (resolved) {
          addCandidate(resolved, 20);
        }
      } else {
        const srcLower = src.toLowerCase();
        if (EXCLUDE_PATTERNS.some(p => srcLower.includes(p))) return;
        if (isLikelyProfileImage(src, alt, width, height, cssClass)) {
          const resolved = resolveUrl(src);
          if (resolved) {
            addCandidate(resolved, 15);
          }
        }
      }
    });
  }

  // Pass 2: OG / Twitter meta (single image, lower priority for multi)
  const ogImage = $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('meta[property="og:image:secure_url"]').attr('content') || '';
  if (ogImage && isLikelyProfileImage(ogImage)) {
    const resolved = resolveUrl(ogImage);
    if (resolved) addCandidate(resolved, 10);
  }

  // Pass 3: Score ALL images on the page
  $('img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || '';
    const alt = $(el).attr('alt') || '';
    const cssClass = $(el).attr('class') || '';
    const width = parseInt($(el).attr('width') || '0', 10);
    const height = parseInt($(el).attr('height') || '0', 10);
    if (!src || src.startsWith('data:')) return;
    if (!isLikelyProfileImage(src, alt, width, height, cssClass)) return;

    const resolved = resolveUrl(src);
    if (!resolved) return;

    let score = 0;
    const combined = (src + ' ' + alt).toLowerCase();
    if (/photo|profile|officer|portrait|pic|ছবি|কর্মকর্তা|upload/i.test(combined)) score += 8;
    if (/upload|images\/officer|images\/photo/i.test(src.toLowerCase())) score += 3;
    if (width > 0 && height > 0) {
      const ratio = width / height;
      if (ratio >= 0.65 && ratio < 1.0) score += 6;  // portrait
      else if (ratio >= 0.9 && ratio <= 1.1) score += 4; // square
      else if (ratio > 1.3) score -= 10; // landscape
    }
    if (width >= 60 && width <= 400 && height >= 80 && height <= 500) score += 4;
    if (/thumb|small|tiny|mini/i.test(combined)) score -= 2;
    if (/landscape|scenery|building|slider|carousel|cover|hero|banner/i.test(combined)) score -= 8;

    // ── National Portal V2: boost list-card-image class ──
    const clsLower = cssClass.toLowerCase();
    if (clsLower.includes('list-card-image')) score += 12;
    // Check parent containers for officer context
    const parentCls = ($(el).parent().attr('class') || '').toLowerCase();
    const gpCls = ($(el).parent().parent().attr('class') || '').toLowerCase();
    if (parentCls.includes('image-section') || gpCls.includes('list-card-body')) score += 8;
    if (parentCls.includes('officer') || gpCls.includes('officer') ||
        $(el).closest('.info-officer-view-widget, .info-officer-view').length > 0) score += 6;

    addCandidate(resolved, score);
  });

  // Sort by score descending, filter minimum threshold
  allCandidates.sort((a, b) => b.score - a.score);
  const qualified = allCandidates.filter(c => c.score >= 4).slice(0, maxCount);

  if (qualified.length > 0) {
    console.log(`  ↳ [Cheerio] Found ${qualified.length} candidate images (scores: ${qualified.map(c => c.score).join(', ')})`);
  }

  return qualified.map(c => c.url);
}

// ── Wayback Machine helpers ──────────────────────────────────────────

/**
 * Query Wayback Machine availability API for the closest snapshot
 */
async function getWaybackUrl(originalUrl) {
  try {
    const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(originalUrl)}`;
    const resp = await axios.get(apiUrl, {
          lookup: officerLookup, timeout: 8000 });
    const snapshot = resp.data?.archived_snapshots?.closest;
    if (snapshot && snapshot.available && snapshot.url) {
      console.log(`🏛️ [Wayback] Found snapshot: ${snapshot.url.substring(0, 80)}`);
      return snapshot.url;
    }
  } catch (err) {
    console.warn(`⚠️ [Wayback] API error: ${err.message}`);
  }
  return null;
}

/**
 * Extract the original image URL from a Wayback-rewritten URL
 * e.g. https://web.archive.org/web/20230101/https://example.com/photo.jpg → https://example.com/photo.jpg
 */
function extractOriginalUrlFromWayback(waybackImageUrl) {
  if (!waybackImageUrl) return null;
  const match = waybackImageUrl.match(/\/web\/\d+[a-z]*\/(https?:\/\/.+)/i);
  if (match && match[1]) return match[1];
  return null;
}

/**
 * Fetch MULTIPLE officer profile images from a single government website URL.
 * Returns an array of up to `maxCount` distinct image URLs (best first).
 * Uses separate cache key so it doesn't conflict with single-image cache.
 *
 * @param {string} targetUrl - Government website URL
 * @param {Object} options - { forceRefresh?: boolean, maxCount?: number }
 * @returns {Promise<string[]>} - Array of image URLs (may be empty)
 */
async function fetchAllOfficerImages(targetUrl, options = {}) {
  if (!targetUrl) return [];

  const maxCount = options.maxCount || 5;
  const multiCacheKey = `multi:${targetUrl}`;

  // Check memory cache first
  if (!options.forceRefresh) {
    const memCached = getFromMemoryCache(multiCacheKey);
    if (memCached !== null) {
      try {
        const arr = JSON.parse(memCached);
        if (Array.isArray(arr)) {
          console.log(`⚡ [ImageFetcher] Multi-image memory cache hit for ${targetUrl} (${arr.length} images)`);
          return arr;
        }
      } catch {}
    }

    const diskCached = getFromDiskCache(multiCacheKey);
    if (diskCached !== null) {
      try {
        const arr = JSON.parse(diskCached);
        if (Array.isArray(arr)) {
          console.log(`💾 [ImageFetcher] Multi-image disk cache hit for ${targetUrl} (${arr.length} images)`);
          setMemoryCache(multiCacheKey, diskCached);
          return arr;
        }
      } catch {}
    }
  }

  console.log(`🔍 [ImageFetcher] Fetching ALL profile images (up to ${maxCount}) from: ${targetUrl}`);

  return runWithLimit(async () => {
    let images = [];

    // ── STRATEGY 1: Playwright (best for JS-rendered pages) ──
    const chromium = getChromium();
    if (chromium) {
      let browser;
      try {
        console.log(`🎭 [ImageFetcher] Multi-image Strategy 1: Playwright for ${targetUrl}`);
        browser = await launchGuardedBrowser(chromium);
        const context = await browser.newContext({
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          ignoreHTTPSErrors: true,
          locale: 'bn-BD,bn;q=0.9',
        });
        const page = await context.newPage();
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);

        images = await page.evaluate((args) => {
          const { excludePatterns, excludeClassPatterns, limit } = args;
          const isExcluded = (src, alt, cls) => {
            const combined = ((src || '') + ' ' + (alt || '')).toLowerCase();
            if (excludePatterns.some(p => combined.includes(p))) return true;
            const clsLower = (cls || '').toLowerCase();
            if (clsLower && excludeClassPatterns.some(p => clsLower.includes(p))) return true;
            return false;
          };

          const isPortrait = (img) => {
            const w = img.naturalWidth || img.width || parseInt(img.getAttribute('width') || '0');
            const h = img.naturalHeight || img.height || parseInt(img.getAttribute('height') || '0');
            if (w > 0 && h > 0) {
              const ratio = w / h;
              if (ratio > 1.4 || ratio < 0.4) return false;
              if (w < 40 || h < 50) return false;
            }
            return true;
          };

          const seen = new Set();
          const candidates = [];

          // ── FAST PATH: National Portal V2 — list-card-image in info-officer widgets ──
          // These are in order: first = primary officer, second = alternate, third = appellate
          const npV2Images = document.querySelectorAll('.info-officer-view-widget img.list-card-image, .info-officer-view img.list-card-image, img.list-card-image');
          npV2Images.forEach((img) => {
            const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
            if (!src || src.startsWith('data:')) return;
            const resolved = src.startsWith('http') ? src : (() => {
              try { return new URL(src, window.location.origin).href; } catch { return ''; }
            })();
            if (!resolved || seen.has(resolved)) return;
            seen.add(resolved);
            candidates.push({ url: resolved, score: 25 }); // very high confidence
          });

          // If we already found enough via National Portal V2, return early
          if (candidates.length >= limit) {
            candidates.sort((a, b) => b.score - a.score);
            return candidates.slice(0, limit).map(c => c.url);
          }

          // Score all remaining images
          document.querySelectorAll('img').forEach((img) => {
            const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
            if (!src || src.startsWith('data:')) return;
            const imgClass = img.getAttribute('class') || '';
            if (isExcluded(src, img.getAttribute('alt'), imgClass)) return;
            if (!isPortrait(img)) return;

            const resolved = src.startsWith('http') ? src : (() => {
              try { return new URL(src, window.location.origin).href; } catch { return ''; }
            })();
            if (!resolved || seen.has(resolved)) return;
            seen.add(resolved);

            const w = img.naturalWidth || img.width || parseInt(img.getAttribute('width') || '0');
            const h = img.naturalHeight || img.height || parseInt(img.getAttribute('height') || '0');
            let score = 0;
            const combined = (src + ' ' + (img.getAttribute('alt') || '')).toLowerCase();
            if (/photo|profile|officer|portrait|pic|ছবি|কর্মকর্তা|upload/i.test(combined)) score += 8;
            if (w > 60 && w < 500 && h > 80 && h < 600) score += 5;
            if (w > 0 && h > 0 && h >= w) score += 4;
            if (/thumb|small|tiny|mini/i.test(combined)) score -= 3;

            // National Portal V2 class boost
            if (imgClass.includes('list-card-image')) score += 12;
            // Check if image is near "officer" styled containers
            const parent = img.closest('[class*="officer"], [class*="কর্মকর্তা"], .profile-image, .photo, .card, .info-officer-view-widget, .info-officer-view, .list-card-body');
            if (parent) score += 6;

            if (score >= 4) candidates.push({ url: resolved, score });
          });

          candidates.sort((a, b) => b.score - a.score);
          return candidates.slice(0, limit).map(c => c.url);
        }, { excludePatterns: EXCLUDE_PATTERNS, excludeClassPatterns: EXCLUDE_CLASS_PATTERNS, limit: maxCount });

        if (images.length > 0) {
          console.log(`✅ [ImageFetcher] Playwright found ${images.length} images`);
        }

        if (images.length < maxCount) {
          try {
            const iframeUrls = await page.evaluate(() => {
              const urls = [];
              document.querySelectorAll('iframe[src], frame[src]').forEach((el) => {
                const raw = (el.getAttribute('src') || '').trim();
                if (!raw || raw.startsWith('javascript:') || raw.startsWith('data:')) return;
                try {
                  urls.push(new URL(raw, window.location.href).href);
                } catch {}
              });
              return Array.from(new Set(urls)).slice(0, 8);
            });

            const iframeImages = await fetchIframeOfficerImages(iframeUrls, maxCount);
            for (const imageUrl of iframeImages) {
              if (!images.includes(imageUrl) && images.length < maxCount) {
                images.push(imageUrl);
              }
            }
            if (iframeImages.length > 0) {
              console.log(`✅ [ImageFetcher] Playwright iframe found ${iframeImages.length} additional images`);
            }
          } catch (iframeErr) {
            console.warn(`⚠️ [ImageFetcher] Playwright iframe multi-image extraction failed: ${iframeErr.message}`);
          }
        }
      } catch (err) {
        console.warn(`⚠️ [ImageFetcher] Playwright multi-image failed: ${err.message}`);
      } finally {
        try { if (browser) await browser.close(); } catch {}
        try { if (browser && browser.egressGuard) await browser.egressGuard.close(); } catch {}
      }
    }

    // ── STRATEGY 2: Cheerio (fast, for static pages) ──
    if (images.length < maxCount) {
      try {
        console.log(`⚡ [ImageFetcher] Multi-image Strategy 2: Cheerio for ${targetUrl}`);
        let hostname = '';
        try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch {}
        const isGovBd = hostname.endsWith('.gov.bd') || hostname.endsWith('.portal.gov.bd');
        const httpsAgent = isGovBd ? INSECURE_TLS_AGENT : undefined;

        const response = await axios.get(targetUrl, {
          lookup: officerLookup,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'bn-BD,bn;q=0.9,en-US;q=0.8,en;q=0.7',
          },
          timeout: 12000,
          maxRedirects: 5,
          responseType: 'text',
          ...(httpsAgent ? { httpsAgent } : {}),
          validateStatus: () => true,
        });

        if (response.data && typeof response.data === 'string' && response.data.length >= 500) {
          const cheerioImages = extractAllImagesFromHtml(response.data, targetUrl, maxCount);
          // Merge with Playwright results, avoiding duplicates
          for (const img of cheerioImages) {
            if (!images.includes(img) && images.length < maxCount) {
              images.push(img);
            }
          }

          if (images.length < maxCount) {
            const iframeUrls = collectIframeUrlsFromHtml(response.data, targetUrl);
            const iframeImages = await fetchIframeOfficerImages(iframeUrls, maxCount);
            for (const img of iframeImages) {
              if (!images.includes(img) && images.length < maxCount) {
                images.push(img);
              }
            }
          }

          if (cheerioImages.length > 0) {
            console.log(`✅ [ImageFetcher] Cheerio found ${cheerioImages.length} images (total now: ${images.length})`);
          }
        }
      } catch (err) {
        console.warn(`⚠️ [ImageFetcher] Cheerio multi-image failed: ${err.message}`);
      }
    }

    // ── STRATEGY 3: Wayback Machine (archive fallback) ──
    if (images.length === 0) {
      try {
        console.log(`🏛️ [ImageFetcher] Multi-image Strategy 3: Wayback for ${targetUrl}`);
        const waybackUrl = await getWaybackUrl(targetUrl);
        if (waybackUrl) {
          const wbResponse = await axios.get(waybackUrl, {
          lookup: officerLookup,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'text/html',
            },
            timeout: 15000,
            maxRedirects: 5,
            responseType: 'text',
            validateStatus: () => true,
          });

          if (wbResponse.data && typeof wbResponse.data === 'string' && wbResponse.data.length >= 500) {
            const wbImages = extractAllImagesFromHtml(wbResponse.data, waybackUrl, maxCount);
            for (const img of wbImages) {
              const originalImage = extractOriginalUrlFromWayback(img) || img;
              if (!images.includes(originalImage) && images.length < maxCount) {
                images.push(originalImage);
              }
            }
          }
        }
      } catch (err) {
        console.warn(`⚠️ [ImageFetcher] Wayback multi-image failed: ${err.message}`);
      }
    }

    // Cache the results
    const serialized = JSON.stringify(images);
    setMemoryCache(multiCacheKey, serialized);
    setDiskCache(multiCacheKey, serialized);

    // Also set single-image cache from best result if not already set
    if (images.length > 0 && !getFromMemoryCache(targetUrl)) {
      setMemoryCache(targetUrl, images[0]);
      setDiskCache(targetUrl, images[0]);
    }

    console.log(`✅ [ImageFetcher] Multi-image final: ${images.length} images for ${targetUrl}`);
    return images;
  });
}

/**
 * Batch fetch images for multiple URLs (used when loading multiple officer cards)
 * @param {string[]} urls - Array of gov website URLs
 * @returns {Promise<Map<string, string>>} - Map of url → imageUrl
 */
async function fetchOfficerImagesBatch(urls = []) {
  const results = new Map();
  const uniqueUrls = [...new Set(urls.filter(Boolean))];

  if (uniqueUrls.length === 0) return results;

  console.log(`🔍 [ImageFetcher] Batch fetching ${uniqueUrls.length} images...`);

  const promises = uniqueUrls.map(async (url) => {
    const imageUrl = await fetchOfficerImage(url);
    if (imageUrl) results.set(url, imageUrl);
  });

  await Promise.allSettled(promises);
  console.log(`✅ [ImageFetcher] Batch complete: ${results.size}/${uniqueUrls.length} images found`);

  return results;
}

/**
 * Clear image cache (useful for testing or manual refresh)
 */
function clearImageCache() {
  imageCache.clear();
  try {
    const files = fs.readdirSync(DISK_CACHE_DIR);
    for (const file of files) {
      try { fs.unlinkSync(path.join(DISK_CACHE_DIR, file)); } catch {}
    }
  } catch {}
  console.log('🧹 [ImageFetcher] Cache cleared');
}

module.exports = {
  fetchOfficerImage,
  fetchAllOfficerImages,
  fetchOfficerImagesBatch,
  clearImageCache,
};
