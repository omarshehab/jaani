/**
 * liveProxyReader.js — "Live Page (Highlighted)" view for Read The News.
 * ─────────────────────────────────────────────────────────────────────────
 * Serves an annotated copy of the real news page from a SEPARATE origin (its own
 * port / domain — never the app's origin). The response carries a CSP `sandbox`
 * (no scripts) so the document has an opaque origin even when opened directly.
 *
 * Why a rendered snapshot and not the raw HTML (Stage 1 finding): Prothom Alo's server
 * HTML contains no article <img> tags at all — its hero and body images are built by the
 * page's own JavaScript. So the reader loads the page in a real (headless) browser, lets
 * the page's scripts run, and captures the post-JS DOM. Scripts are stripped only AFTER
 * that, so the images they injected stay in the snapshot.
 *
 * Pipeline per URL:
 *   snapshot (Playwright, cached 10 min):
 *     fresh incognito context on one long-lived browser → every request SSRF-checked and
 *     matched against the Ghostery ad/tracker lists (blocked ones aborted) → load → settle
 *     (networkidle or 5s) → bounded scroll for lazy images → ad slots measured and replaced
 *     with same-size "ব্লক করা হয়েছে" placeholders → page.content() → context closed
 *   serve (jsdom, per request):
 *     strip <script>/<noscript>/on* handlers/javascript: URLs → data-src/srcset rewrite →
 *     embed iframes turned into links → links open in a new tab → highlights injected with
 *     the SAME matcher the frontend uses (frontend/src/utils/highlightHTMLEntities.js) →
 *     Ghostery cosmetic hiding styles → <base href> + referrer meta
 *
 * Highlights: /api/analyze-text stores {entities, keywords} here keyed by
 * sha256(normalized URL) and returns that token; the frontend passes it as &token=.
 * No token / expired payload → the page is served without highlights (never blocks).
 *
 * Only hostnames in READER_ALLOWLIST are served; anything else gets 400 "Not in allowlist"
 * and the frontend stays on the Extracted Text view.
 */
const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const path = require('path');
const express = require('express');
const { JSDOM } = require('jsdom');

let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch {
  chromium = null;
}

const adBlockEngine = require('./adBlockEngine');

const READER_PORT = parseInt(process.env.READER_PORT || '5002', 10);
const READER_PUBLIC_ORIGIN = (process.env.READER_PUBLIC_ORIGIN || `http://localhost:${READER_PORT}`).replace(/\/+$/, '');
const NAV_TIMEOUT_MS = parseInt(process.env.READER_NAV_TIMEOUT_MS || '20000', 10);
// Upper bound only -- Promise.race with waitForLoadState('networkidle') already returns as soon
// as the network actually settles, so most pages never wait the full amount. Lowered from 5000ms
// since in practice a news article's network goes idle well under 2.5s and the old value only
// ever padded out slow/never-idle pages (ad trackers that keep polling) to their worst case.
const SETTLE_MS = parseInt(process.env.READER_SETTLE_MS || '2500', 10);
const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const SNAPSHOT_MAX_ENTRIES = 20;
const PAYLOAD_TTL_MS = 10 * 60 * 1000;
const PAYLOAD_MAX_ENTRIES = 50;
const HIGHLIGHTER_PATH = path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'highlightHTMLEntities.js');

// Frontend origins allowed to call /prepare (CORS JSON).
const APP_ORIGINS = Array.from(new Set([
  ...(process.env.READER_APP_ORIGINS || 'http://localhost:3000 http://127.0.0.1:3000 http://localhost:5005').split(/\s+/),
  process.env.FRONTEND_URL || '',
].map((v) => v.trim().replace(/\/+$/, '')).filter(Boolean)));

// CSP frame-ancestors is OFF unless READER_FRAME_ANCESTORS is set. frame-ancestors is checked
// against EVERY ancestor, so when the app itself is embedded — VS Code's built-in browser shows
// localhost:3000 inside a vscode-webview frame — an origin list blanks the Live Page. `*` would
// not help either (it never matches vscode-webview:/vscode-file:). The reader serves pages with
// no scripts and no working forms, so there is nothing for a framing site to click-jack.
const FRAME_ANCESTORS = String(process.env.READER_FRAME_ANCESTORS || '')
  .split(/\s+/).map((v) => v.trim().replace(/\/+$/, '')).filter(Boolean);

const stripWww = (host = '') => String(host || '').toLowerCase().replace(/^www\./, '');
const READER_ALLOWLIST = new Set(
  String(process.env.READER_ALLOWLIST || '')
    .split(',')
    .map((h) => stripWww(h.trim()))
    .filter(Boolean)
);

// ─── SSRF guard ─────────────────────────────────────────────────────────────

function ipv4IsPrivateOrReserved(ip) {
  const [a, b] = ip.split('.').map((n) => parseInt(n, 10));
  return (
    a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127) // CGNAT
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || ip.startsWith('192.0.0.') || ip.startsWith('192.0.2.')
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
    || ip.startsWith('198.51.100.') || ip.startsWith('203.0.113.')
  );
}

function isPrivateOrReservedIp(value = '') {
  const ip = String(value || '').trim().toLowerCase();
  const type = net.isIP(ip);
  if (!type) return true;
  if (type === 4) return ipv4IsPrivateOrReserved(ip);

  // IPv4-mapped / translated IPv6 (::ffff:10.0.0.1) — judge the embedded IPv4.
  const mapped = ip.match(/^(?:::ffff:(?:0:)?|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4IsPrivateOrReserved(mapped[1]);

  return (
    ip === '::' || ip === '::1'
    || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb') // link-local
    || ip.startsWith('fc') || ip.startsWith('fd') // unique local
    || ip.startsWith('ff') // multicast
    || ip.startsWith('2001:db8:')
    || ip.startsWith('::ffff:')
  );
}

function isLocalHostname(hostname = '') {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home') || host.endsWith('.lan')) return true;
  return !host.includes('.') && !net.isIP(host);
}

/** Static checks on a top-level URL (protocol, credentials, default ports, local names, IP literals). */
function assertFetchableUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw Object.assign(new Error('Invalid URL'), { status: 400 });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw Object.assign(new Error('Only http and https URLs can be opened'), { status: 400 });
  }
  if (parsed.username || parsed.password) {
    throw Object.assign(new Error('URLs with credentials are not allowed'), { status: 400 });
  }
  if (parsed.port && !['80', '443'].includes(parsed.port)) {
    throw Object.assign(new Error('Only default ports (80/443) are allowed'), { status: 400 });
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isLocalHostname(hostname)) {
    throw Object.assign(new Error('Local hostnames are not allowed'), { status: 400 });
  }
  if (net.isIP(hostname) && isPrivateOrReservedIp(hostname)) {
    throw Object.assign(new Error('Private or reserved addresses are not allowed'), { status: 400 });
  }
  return parsed;
}

// Two SSRF layers protect the reader's browser:
//  1. page.route() (adBlockEngine.stripNetworkRequests with isAllowedUrl = isPublicHost below):
//     checks the FIRST request of every navigation, sub-resource and fetch/XHR, and does the
//     ad/tracker filtering. It does NOT see redirect hops — Playwright only routes the first URL of
//     a redirect chain (verified 2026-09-28: a public redirect to 127.0.0.1 was loaded and served).
//  2. utils/egressGuardProxy (browser launched with it, see getBrowser): sees EVERY connection —
//     redirect hops, sub-resources, WebSockets — resolves the host, refuses private/reserved
//     addresses with the same isLocalHostname/isPrivateOrReservedIp as here, and connects to the
//     exact address it checked, so DNS re-binding between check and connect is also closed.
// The allowlist (only known outlets are loaded top-level) remains a third, outer limit.
const hostVerdictCache = new Map(); // hostname -> { ok, ts }
const HOST_VERDICT_TTL_MS = 60 * 1000;

async function isPublicHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || isLocalHostname(host)) return false;
  if (net.isIP(host)) return !isPrivateOrReservedIp(host);
  const cached = hostVerdictCache.get(host);
  if (cached && Date.now() - cached.ts < HOST_VERDICT_TTL_MS) return cached.ok;
  let ok = false;
  try {
    const addresses = await dns.lookup(host, { all: true, verbatim: true });
    ok = addresses.length > 0 && !addresses.some((a) => isPrivateOrReservedIp(a.address));
  } catch {
    ok = false;
  }
  if (hostVerdictCache.size > 2000) hostVerdictCache.clear();
  hostVerdictCache.set(host, { ok, ts: Date.now() });
  return ok;
}

// ─── Allowlist, tokens, analysis payloads ───────────────────────────────────

function isAllowlisted(rawUrl) {
  try {
    return READER_ALLOWLIST.has(stripWww(new URL(String(rawUrl)).hostname));
  } catch {
    return false;
  }
}

function normalizeArticleUrl(rawUrl) {
  const u = new URL(String(rawUrl || '').trim());
  u.hash = '';
  return u.href;
}

function tokenForUrl(rawUrl) {
  try {
    return crypto.createHash('sha256').update(normalizeArticleUrl(rawUrl)).digest('hex');
  } catch {
    return '';
  }
}

const payloadStore = new Map(); // token -> { entities, keywords, sentenceHighlights, ts }

function setReaderPayload(rawUrl, { entities = [], keywords = [], sentenceHighlights = [] } = {}) {
  const token = tokenForUrl(rawUrl);
  if (!token) return '';
  payloadStore.delete(token);
  payloadStore.set(token, {
    entities: (entities || []).map((e) => ({ text: e?.text || e?.name || '', label: e?.label || e?.type || '' }))
      .filter((e) => e.text),
    keywords: (keywords || []).filter((k) => typeof k === 'string'),
    sentenceHighlights: (sentenceHighlights || []).filter((s) => typeof s === 'string'),
    ts: Date.now(),
  });
  while (payloadStore.size > PAYLOAD_MAX_ENTRIES) payloadStore.delete(payloadStore.keys().next().value);
  return token;
}

function getReaderPayload(token) {
  const entry = payloadStore.get(token);
  if (!entry) return null;
  if (Date.now() - entry.ts > PAYLOAD_TTL_MS) {
    payloadStore.delete(token);
    return null;
  }
  return entry;
}

// ─── Shared highlighter (same file the frontend imports) ────────────────────

let highlighterModule = null;
function getHighlighter() {
  if (highlighterModule) return highlighterModule;
  const source = fs.readFileSync(HIGHLIGHTER_PATH, 'utf8')
    .replace(/^export\s+(function|const|let)\s/gm, '$1 ');
  // eslint-disable-next-line no-new-func
  highlighterModule = new Function(`${source}\nreturn { highlightDomTree };`)();
  return highlighterModule;
}

// ─── Browser + snapshot ─────────────────────────────────────────────────────

// One long-lived browser, always paired with its own egress-guard proxy: they start together, and
// when the browser disconnects (crash, close) the proxy is closed and both are recreated on the
// next request. "<-loopback>" stops Chromium from bypassing the proxy for localhost.
let browserPromise = null;
function getBrowser() {
  if (!chromium) return Promise.reject(new Error('Playwright is not installed'));
  if (!browserPromise) {
    // Required here (not at the top) because egressGuardProxy imports this module's IP rules.
    const { startEgressGuardProxy } = require('../utils/egressGuardProxy');
    let egress = null;
    browserPromise = startEgressGuardProxy({
      onBlock: (entry) => console.warn(`🛡️ [READER] egress guard blocked ${entry}`),
    }).then((proxy) => {
      egress = proxy;
      return chromium.launch({
        headless: true,
        args: ['--disable-gpu', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
        proxy: { server: proxy.server, bypass: '<-loopback>' },
      });
    }).then((browser) => {
      browser.egressGuard = egress;
      browser.on('disconnected', () => {
        browserPromise = null;
        if (egress) egress.close().catch(() => {});
      });
      return browser;
    }).catch((err) => {
      browserPromise = null;
      if (egress) egress.close().catch(() => {});
      throw err;
    });
  }
  return browserPromise;
}

const snapshotCache = new Map(); // normalized url -> { snapshot, ts }
const snapshotInFlight = new Map(); // normalized url -> Promise

async function captureSnapshot(targetUrl) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'bn-BD',
    viewport: { width: 1280, height: 2000 },
    serviceWorkers: 'block',
    acceptDownloads: false,
    bypassCSP: true,
  });
  const startedAt = Date.now();
  try {
    // No WebSockets at all — they bypass request routing.
    if (typeof context.routeWebSocket === 'function') {
      await context.routeWebSocket(/.*/, (ws) => ws.close());
    }
    const page = await context.newPage();
    // One request handler: SSRF guard first, then the ad/tracker lists (installed before navigation).
    const requestLog = await adBlockEngine.stripNetworkRequests(page, {
      mainUrl: targetUrl,
      isAllowedUrl: async (reqUrl) => {
        try {
          const parsed = new URL(reqUrl);
          return ['http:', 'https:'].includes(parsed.protocol) && isPublicHost(parsed.hostname);
        } catch {
          return false;
        }
      },
    });

    const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    const status = response ? response.status() : 0;
    if (status >= 400) {
      throw Object.assign(new Error(`The news site answered with HTTP ${status}`), { status: 502, upstreamStatus: status });
    }

    await Promise.race([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.waitForTimeout(SETTLE_MS),
    ]);

    // Bounded scroll so lazy images load (max 30 steps — infinite-scroll pages can't hang it).
    await page.evaluate(async () => {
      for (let i = 0; i < 30; i += 1) {
        window.scrollBy(0, 900);
        await new Promise((r) => setTimeout(r, 120));
        if (window.scrollY + window.innerHeight >= document.body.scrollHeight - 5) break;
      }
      window.scrollTo(0, 0);
    });
    // Lets scroll-triggered lazy images finish requesting; 1200ms was a flat tax paid by every
    // page load whether or not it had any lazy images. 600ms is enough headroom for a request to
    // fire and start streaming -- images.length is measured after this point regardless of
    // whether the bytes have fully arrived, so the extra 600ms bought no additional accuracy.
    await page.waitForTimeout(600);

    // Ad slots → same-size placeholders, measured BEFORE the cosmetic CSS (which would collapse
    // them to 0×0 and leave nothing to measure). Then the lists' hiding CSS, then overlays out.
    const adSlots = await adBlockEngine.replaceAdSlots(page);
    const cosmeticCssChars = await adBlockEngine.injectCosmeticFilters(page, page.url());
    await page.waitForTimeout(250);
    const annoyances = await adBlockEngine.removeAnnoyances(page);
    const paywall = await adBlockEngine.detectPaywall(page, requestLog);
    if (paywall.detected) console.log(`🔒 [READER] Paywall detected on ${targetUrl} (${paywall.vendor}: ${paywall.signals.join(', ')}) — shown with a notice, not bypassed`);

    const stats = await page.evaluate(() => ({
      images: Array.from(document.images).filter((img) => img.naturalWidth >= 150).length,
      textChars: (document.querySelector('article, main, [itemprop="articleBody"]') || document.body).innerText.length,
      title: document.title,
    }));

    const html = await page.content();
    return {
      html,
      finalUrl: page.url(),
      status,
      capturedAt: Date.now(),
      paywall,
      stats: {
        ...stats,
        placeholders: adSlots.replaced.length,
        placeholderSizes: adSlots.replaced,
        removed: adSlots.removed,
        annoyancesRemoved: annoyances.removed,
        annoyancesFound: annoyances.found,
        cosmeticCssChars,
        blockedAds: requestLog.blockedCount,
        blockedByHost: requestLog.blocked,
        trackersAllowed: requestLog.allowedTrackers,
        blockedSsrf: requestLog.ssrf,
        paywall: paywall.detected ? paywall.vendor : '',
        ms: Date.now() - startedAt,
      },
    };
  } finally {
    await context.close().catch(() => {});
  }
}

async function getSnapshot(targetUrl) {
  const key = normalizeArticleUrl(targetUrl);
  const cached = snapshotCache.get(key);
  if (cached && Date.now() - cached.ts < SNAPSHOT_TTL_MS) return cached.snapshot;
  if (snapshotInFlight.has(key)) return snapshotInFlight.get(key);

  const job = captureSnapshot(key)
    .then((snapshot) => {
      snapshotCache.delete(key);
      snapshotCache.set(key, { snapshot, ts: Date.now() });
      while (snapshotCache.size > SNAPSHOT_MAX_ENTRIES) snapshotCache.delete(snapshotCache.keys().next().value);
      console.log(`📰 [READER] Snapshot ${key} — ${snapshot.stats.images} images, ${snapshot.stats.textChars} chars, ${snapshot.stats.placeholders} ad placeholders ${JSON.stringify(snapshot.stats.placeholderSizes)}, ${snapshot.stats.removed} ad nodes + ${snapshot.stats.annoyancesRemoved} overlays removed, ${snapshot.stats.blockedAds} requests blocked, trackers let through: ${JSON.stringify(snapshot.stats.trackersAllowed)}, ${snapshot.stats.ms}ms`);
      return snapshot;
    })
    .finally(() => snapshotInFlight.delete(key));
  snapshotInFlight.set(key, job);
  return job;
}

// ─── Serve: sanitize + highlight ────────────────────────────────────────────

const escapeHtml = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const ARTICLE_ROOT_SELECTORS = 'article, [itemprop="articleBody"], main, [role="main"]';
const READER_STYLE = `
.jaani-ad-block{background:#f0f0f0;border:1px dashed #bbb;color:#888}
.important-sentence-highlight{background-color:#fff176;color:#212121;border-radius:2px;padding:0 1px}
.keyword-highlight{background-color:#bbdefb;color:#0d47a1;border-radius:2px;padding:0 2px}
.gov-org-highlight{background-color:#e3f2fd;color:#1565c0;font-weight:600;border-radius:3px;padding:0 2px}
.officer-highlight{text-decoration-line:underline;text-decoration-color:#1565c0;text-decoration-thickness:3px;text-underline-offset:4px;font-weight:600}`;

async function buildServedDocument(snapshot, payload) {
  const dom = new JSDOM(snapshot.html, { url: snapshot.finalUrl });
  const { window } = dom;
  const doc = window.document;

  doc.querySelectorAll('script, noscript, template, base, link[rel="preload"][as="script"], link[rel="modulepreload"], link[rel="manifest"], meta[http-equiv]')
    .forEach((el) => el.remove());
  doc.querySelectorAll('link[rel~="stylesheet"][href], link[rel="preload"][href]').forEach((el) => {
    if (adBlockEngine.isAdStylesheetUrl(el.getAttribute('href'))) el.remove();
  });

  let highlightCount = 0;
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = String(attr.value || '').trim().toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      else if (['href', 'src', 'action', 'formaction', 'xlink:href'].includes(name) && value.startsWith('javascript:')) el.removeAttribute(attr.name);
    }
  });

  // Lazy-load attributes → real attributes (for outlets that ship lazy <img> tags).
  doc.querySelectorAll('img').forEach((img) => {
    const current = img.getAttribute('src') || '';
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
    if (lazy && (!current || current.startsWith('data:') || /placeholder|blank|spacer|lazy/i.test(current))) {
      img.setAttribute('src', lazy);
    }
    const lazySet = img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
    if (lazySet && !img.getAttribute('srcset')) img.setAttribute('srcset', lazySet);
  });
  doc.querySelectorAll('source[data-srcset]').forEach((source) => {
    if (!source.getAttribute('srcset')) source.setAttribute('srcset', source.getAttribute('data-srcset'));
  });

  // Embedded players need scripts, which the reader never runs — link out instead (link-only video).
  doc.querySelectorAll('iframe, object, embed').forEach((el) => {
    const src = el.getAttribute('src') || el.getAttribute('data') || '';
    if (/youtube\.com|youtu\.be|vimeo\.com|facebook\.com\/plugins\/video|dailymotion\.com/i.test(src)) {
      const link = doc.createElement('a');
      link.setAttribute('href', src.startsWith('//') ? `https:${src}` : src);
      link.textContent = '▶ ভিডিও দেখুন (নতুন ট্যাবে)';
      link.setAttribute('style', 'display:block;padding:14px;margin:10px 0;background:#111;color:#fff;border-radius:6px;text-align:center;font-weight:600;text-decoration:none;');
      el.replaceWith(link);
    } else {
      el.remove();
    }
  });

  doc.querySelectorAll('a[href]').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });

  if (payload && (payload.entities.length || payload.keywords.length || payload.sentenceHighlights.length)) {
    const { highlightDomTree } = getHighlighter();
    const candidates = Array.from(doc.querySelectorAll(ARTICLE_ROOT_SELECTORS));
    const roots = candidates.filter((el) => !candidates.some((other) => other !== el && other.contains(el)));
    (roots.length ? roots : [doc.body]).forEach((root) => {
      highlightCount += highlightDomTree(root, payload.entities, payload.keywords, window, payload.sentenceHighlights);
    });
  }

  const classes = new Set();
  const ids = new Set();
  doc.querySelectorAll('[class]').forEach((el) => el.classList.forEach((c) => classes.add(c)));
  doc.querySelectorAll('[id]').forEach((el) => ids.add(el.id));
  const cosmeticCss = await adBlockEngine.cosmeticStyleFor({ url: snapshot.finalUrl, classes: Array.from(classes), ids: Array.from(ids) });

  // Paywalled page: say so and link out. The gate itself is never removed or worked around.
  if (snapshot.paywall && snapshot.paywall.detected && doc.body) {
    doc.body.insertAdjacentHTML('afterbegin',
      `<div class="jaani-paywall-notice" style="position:relative;z-index:2147483647;margin:0;padding:12px 16px;background:#fff8e1;border-bottom:2px solid #f9a825;font:600 15px sans-serif;color:#5d4037;text-align:center">সাবস্ক্রাইবার কনটেন্ট — <a href="${escapeHtml(snapshot.finalUrl)}" target="_blank" rel="noopener noreferrer" style="color:#1565c0">মূল সাইটে পড়ুন ↗</a></div>`);
  }

  const head = doc.head || doc.documentElement.insertBefore(doc.createElement('head'), doc.body);
  head.insertAdjacentHTML('afterbegin',
    `<base href="${escapeHtml(snapshot.finalUrl)}"><meta name="referrer" content="no-referrer">`);
  const style = doc.createElement('style');
  style.textContent = `${cosmeticCss}\n${READER_STYLE}`;
  head.appendChild(style);

  const html = dom.serialize();
  window.close();
  return { html, highlightCount };
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

function errorPage(message, targetUrl = '') {
  const link = targetUrl
    ? `<p><a href="${escapeHtml(targetUrl)}" target="_blank" rel="noopener noreferrer">Open the original page in a new tab</a></p>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;padding:24px;color:#b71c1c">
<h3>⚠️ Could not load the live page</h3><p>${escapeHtml(message)}</p>${link}</body></html>`;
}

function setReaderHeaders(res) {
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    // No scripts at all: the snapshot's scripts are stripped, and this forbids any that slip through.
    'Content-Security-Policy': [
      'sandbox allow-popups allow-popups-to-escape-sandbox',
      "script-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
      ...(FRAME_ANCESTORS.length ? [`frame-ancestors ${FRAME_ANCESTORS.join(' ')}`] : []),
    ].join('; '),
  });
}

function checkTarget(rawUrl) {
  const parsed = assertFetchableUrl(rawUrl);
  if (!isAllowlisted(parsed.href)) {
    throw Object.assign(new Error('Not in allowlist'), { status: 400, notAllowlisted: true });
  }
  return normalizeArticleUrl(parsed.href);
}

async function handleRead(req, res) {
  setReaderHeaders(res);
  const target = typeof req.query.url === 'string' ? req.query.url : '';
  if (!target) return res.status(400).send(errorPage('Missing url parameter'));
  try {
    const url = checkTarget(target);
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const payload = token && token === tokenForUrl(url) ? getReaderPayload(token) : null;
    const snapshot = await getSnapshot(url);
    const { html, highlightCount } = await buildServedDocument(snapshot, payload);
    res.set('X-Jaani-Highlights', String(highlightCount));
    return res.status(200).send(html);
  } catch (err) {
    if (err.notAllowlisted) return res.status(400).type('text/plain').send('Not in allowlist');
    console.warn(`⚠️ [READER] /read failed for ${target}: ${err.message}`);
    return res.status(err.status || 502).send(errorPage(err.message || 'Unknown error', target));
  }
}

// Warms the snapshot and tells the frontend (via CORS JSON) whether the live view will work,
// so it can fall back to Extracted Text silently instead of showing a broken iframe.
async function handlePrepare(req, res) {
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  if (origin && APP_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Cache-Control', 'no-store');
  const target = typeof req.query.url === 'string' ? req.query.url : '';
  try {
    const url = checkTarget(target);
    const snapshot = await getSnapshot(url);
    return res.json({ ok: true, stats: snapshot.stats });
  } catch (err) {
    if (err.notAllowlisted) return res.status(400).json({ ok: false, reason: 'Not in allowlist' });
    return res.status(err.status || 502).json({ ok: false, reason: err.message || 'Snapshot failed' });
  }
}

function buildReaderUrl(targetUrl = '', token = '') {
  const tokenPart = token ? `&token=${encodeURIComponent(token)}` : '';
  return `${READER_PUBLIC_ORIGIN}/read?url=${encodeURIComponent(String(targetUrl || ''))}${tokenPart}`;
}

function createReaderApp() {
  const app = express();
  app.disable('x-powered-by');
  app.get('/read', handleRead);
  app.get('/prepare', handlePrepare);
  app.get('/health', (_req, res) => res.json({ success: true, service: 'jaani-reader', allowlist: Array.from(READER_ALLOWLIST) }));
  app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));
  return app;
}

function startReaderServer() {
  const app = createReaderApp();
  adBlockEngine.getEngine(); // warm the filter lists in the background
  return app.listen(READER_PORT, '0.0.0.0', () => {
    console.log(`📰 Reader on ${READER_PUBLIC_ORIGIN} — allowlist: ${Array.from(READER_ALLOWLIST).join(', ') || '(empty)'} — framable by: ${FRAME_ANCESTORS.length ? FRAME_ANCESTORS.join(' ') : 'any (frame-ancestors off)'} — /prepare CORS: ${APP_ORIGINS.join(' ')}`);
  });
}

module.exports = {
  READER_PORT,
  READER_PUBLIC_ORIGIN,
  buildReaderUrl,
  createReaderApp,
  startReaderServer,
  isAllowlisted,
  tokenForUrl,
  setReaderPayload,
  getReaderPayload,
  getSnapshot,
  buildServedDocument,
  isPrivateOrReservedIp,
  isLocalHostname,
  isPublicHost,
  assertFetchableUrl,
  _internal: { getBrowser }, // for tests
};
