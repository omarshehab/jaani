/**
 * adBlockEngine.js — ad / tracker / annoyance handling for the Live Page reader.
 *
 * One Ghostery engine per process, built from the prebuilt "full" lists (EasyList, EasyPrivacy,
 * uBlock filters and the annoyance + cookie-notice lists), cached on disk.
 *
 *   stripNetworkRequests(page, { isAllowedUrl })  one route handler: SSRF check, then ad/tracker match
 *   injectCosmeticFilters(page, url)               element-hiding CSS from the lists, into the live page
 *   getAdSelectors()                               hand-written selectors for what the lists miss
 *   replaceAdSlots(page) / removeAnnoyances(page)  sized "ব্লক করা হয়েছে" placeholders / overlay removal
 *   detectPaywall(page, requestLog)                Piano/Tinypass & JSON-LD signals — detection only,
 *                                                  paywall gates are never removed or bypassed
 *   cosmeticStyleFor(...)                          same CSS, for the served (jsdom) document
 */
const fs = require('fs');
const path = require('path');

let adblocker = null;
try {
  adblocker = require('@ghostery/adblocker');
} catch {
  adblocker = null;
}

const ENGINE_CACHE_PATH = path.join(__dirname, '..', 'data', 'adblock', 'ghostery-engine-full.bin');

let enginePromise = null;
function getEngine() {
  if (!adblocker) return Promise.resolve(null);
  if (!enginePromise) {
    fs.mkdirSync(path.dirname(ENGINE_CACHE_PATH), { recursive: true });
    const startedAt = Date.now();
    enginePromise = adblocker.FiltersEngine.fromPrebuiltFull(fetch, {
      path: ENGINE_CACHE_PATH,
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    }).then((engine) => {
      try {
        const { networkFilters, cosmeticFilters } = engine.getFilters();
        console.log(`🛡️ [adblock] Engine ready in ${Date.now() - startedAt}ms — ${networkFilters.length} network + ${cosmeticFilters.length} cosmetic rules (ads, tracking, annoyances, cookie notices)`);
      } catch {
        console.log(`🛡️ [adblock] Engine ready in ${Date.now() - startedAt}ms`);
      }
      return engine;
    }).catch((err) => {
      console.warn(`⚠️ [adblock] Engine unavailable: ${err.message}`);
      enginePromise = null;
      return null;
    });
  }
  return enginePromise;
}

const stripWww = (host = '') => String(host || '').toLowerCase().replace(/^www\./, '');
const registrableDomain = (hostname = '') => {
  const parts = stripWww(hostname).split('.');
  const twoPart = parts.length > 2 && parts[parts.length - 2].length <= 3; // .com.bd, .co.uk
  return parts.slice(twoPart ? -3 : -2).join('.');
};

const TRACKER_HOST_RE = /doubleclick|googlesyndication|googleadservices|adservice|googletagservices|googletagmanager|google-analytics|taboola|outbrain|facebook\.net|scorecardresearch|chartbeat|criteo|adnxs|amazon-adsystem|tinypass|piano\.io|cxense/i;
const PAYWALL_HOST_RE = /tinypass\.com|piano\.io|cxense\.com|zephr|poool\.fr/i;

/**
 * Install the single request handler for a page (call before navigation). Every request is
 * first checked by `isAllowedUrl` (the reader's SSRF guard) and then matched against the
 * ad/tracker lists. Returns a live log: { blocked: {host: n}, allowedTrackers: {host: n},
 * ssrf, blockedPaywallHosts: Set }.
 */
async function stripNetworkRequests(page, { isAllowedUrl, mainUrl } = {}) {
  const engine = await getEngine();
  const log = { blocked: {}, allowedTrackers: {}, ssrf: 0, blockedCount: 0, paywallHosts: new Set() };
  await page.route('**/*', async (route) => {
    const request = route.request();
    const reqUrl = request.url();
    if (/^(data|blob|about):/i.test(reqUrl)) return route.continue();
    let host = '';
    try {
      host = new URL(reqUrl).hostname;
    } catch {
      return route.abort('blockedbyclient');
    }
    if (isAllowedUrl && !(await isAllowedUrl(reqUrl))) {
      log.ssrf += 1;
      return route.abort('blockedbyclient');
    }
    const type = request.resourceType();
    if (type === 'font' || type === 'media') return route.abort('blockedbyclient');
    if (PAYWALL_HOST_RE.test(host)) log.paywallHosts.add(host);
    if (engine && reqUrl !== mainUrl) {
      const verdict = engine.match(adblocker.Request.fromRawDetails({
        url: reqUrl,
        sourceUrl: (request.frame() && request.frame().url()) || mainUrl || reqUrl,
        type,
      }));
      if (verdict.match) {
        log.blocked[host] = (log.blocked[host] || 0) + 1;
        log.blockedCount += 1;
        return route.abort('blockedbyclient');
      }
    }
    // Known ad/tracker hosts the lists let through (e.g. the Facebook SDK): the snapshot never
    // needs them, and the served page runs no scripts.
    if (TRACKER_HOST_RE.test(host) && !PAYWALL_HOST_RE.test(host)) {
      log.blocked[host] = (log.blocked[host] || 0) + 1;
      log.blockedCount += 1;
      return route.abort('blockedbyclient');
    }
    if (TRACKER_HOST_RE.test(host)) log.allowedTrackers[host] = (log.allowedTrackers[host] || 0) + 1;
    return route.continue();
  });
  return log;
}

/** Element-hiding CSS for a page, from its hostname and the classes/ids present in its DOM. */
async function cosmeticStyleFor({ url, classes = [], ids = [], hrefs = [] }) {
  const engine = await getEngine();
  if (!engine) return '';
  try {
    const { hostname } = new URL(url);
    const cosmetics = engine.getCosmeticsFilters({
      url,
      hostname,
      domain: registrableDomain(hostname),
      classes,
      ids,
      hrefs,
      getBaseRules: true,
      getInjectionRules: false,
      getExtendedRules: false,
      getRulesFromHostname: true,
      getRulesFromDOM: true,
    });
    return cosmetics.styles || '';
  } catch (err) {
    console.warn(`⚠️ [adblock] Cosmetic filters failed: ${err.message}`);
    return '';
  }
}

/** Inject the lists' element-hiding CSS into the live page (after load). Returns CSS length. */
async function injectCosmeticFilters(page, url) {
  const dom = await page.evaluate(() => {
    const classes = new Set();
    const ids = new Set();
    document.querySelectorAll('[class]').forEach((el) => {
      if (el.classList) el.classList.forEach((c) => classes.add(c));
    });
    document.querySelectorAll('[id]').forEach((el) => ids.add(el.id));
    return { classes: Array.from(classes), ids: Array.from(ids) };
  });
  const css = await cosmeticStyleFor({ url, ...dom });
  if (css) await page.addStyleTag({ content: css });
  return css.length;
}

// Hand-written selectors for what the lists miss. Whole-token / prefix matches only — a plain
// substring like [class*="ad-"] also hits "lead-", "head-", "read-", "download-".
// Found by inspecting the live pages (2026-09-27): once Ghostery blocks Google's ad script, the
// outlets' own reserved ad containers stay behind as empty grey boxes.
const AD_SELECTORS = [
  // Generic / Google Publisher Tag
  'ins.adsbygoogle', '[id^="div-gpt-ad"]', '[id^="google_ads_iframe"]', '[data-ad-slot]', '[data-ad-unit]',
  '[data-ad]', '[data-advertisement]', '[data-google-query-id]',
  '[class~="ad"]', '[class~="ads"]', '[class^="ad-"]', '[class*=" ad-"]', '[id^="ad-"]', '[id$="-ad"]',
  '[class*="advertisement"]', '[class*="Advertisement"]', '[class*="sponsored-"]', '[class*="ads-container"]',
  '.ad-slot', '.ad-unit', '.ad-container', '.ad-wrapper', '.ad-box', '[id*="taboola"]', '[id*="outbrain"]',
  'iframe[src*="doubleclick"]', 'iframe[src*="googlesyndication"]', 'iframe[src*="adservice"]',
  // Prothom Alo
  '.adsBox', '.print-adslot', '.dfp-ad-unit', '.adunitContainer', '.story-ad-block', '[id*="adSlot"]',
  '[id^="top-ad"]', '[id^="interstitial-ad"]', '[id^="special_ads_for_story"]',
  // Dhaka Post
  '.top-advertisement', '.dhaka-post-ad', '.common-header-ad', '.details-end-ad', '.footer-ad',
  '[id^="ad-inner-"]', '[id*="-right-ad-"]', '[id*="parallax-ad"]', '[id*="header-ad"]', '[id*="footer-ad"]',
];

// Overlays and notices: always removed (a placeholder for a cookie bar makes no sense).
const ANNOYANCE_SELECTORS = [
  '.cookie-notice', '.cookie-banner', '.cookie-consent', '.CookieConsent', '[class*="cookie-bar"]',
  '[class*="cookie-consent"]', '[id*="cookie-consent"]', '[id*="cookiebanner"]', '[class*="gdpr"]', '[id*="gdpr"]',
  '[class*="newsletter-popup"]', '.modal-overlay',
];

// Detected only — never removed (no paywall bypass).
const PAYWALL_SELECTORS = [
  '.tp-modal', '.tp-backdrop', '[id*="piano-"]', '[class*="paywall"]', '[class*="subscribe-wall"]', '#piano-inline', '[class*="zephr"]',
];

function getAdSelectors() {
  return { ads: AD_SELECTORS.slice(), annoyances: ANNOYANCE_SELECTORS.slice(), paywall: PAYWALL_SELECTORS.slice() };
}

/**
 * Replace ad slots with same-size placeholders while real layout is available (run BEFORE the
 * cosmetic CSS, which would collapse them to 0×0). Never touches anything that looks like
 * article content (contains a headline, an <article>, or more than 300 characters of text).
 * Ads inside fixed/sticky bars (anchor ads, interstitials) are removed with their empty bar.
 */
async function replaceAdSlots(page) {
  return page.evaluate(({ adSelectors, paywallSelectors }) => {
    const all = Array.from(document.querySelectorAll(adSelectors.join(',')));
    const paywall = paywallSelectors.join(',');
    const isContent = (el) => el.querySelector('h1, article, [itemprop="articleBody"]')
      || (el.innerText || '').trim().length > 300
      || el.matches(paywall) || el.querySelector(paywall);
    const candidates = all.filter((el) => el.isConnected && !isContent(el));
    const outermost = candidates.filter((el) => !candidates.some((o) => o !== el && o.contains(el)));
    const fixedAncestor = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const pos = getComputedStyle(n).position;
        if (pos === 'fixed' || pos === 'sticky') return n;
      }
      return null;
    };
    const replaced = [];
    let removed = 0;
    outermost.forEach((el) => {
      const anchor = fixedAncestor(el);
      if (anchor) {
        el.remove();
        if (anchor.isConnected && !(anchor.innerText || '').trim() && !anchor.querySelector('img, a[href]')) anchor.remove();
        removed += 1;
        return;
      }
      const rect = el.getBoundingClientRect();
      let w = Math.round(rect.width);
      let h = Math.round(rect.height);
      // Out-of-page slots (interstitials, 1x1 pixels, parallax/anchor units) take no space in the
      // article when unfilled — remove them rather than inventing a box from their size name.
      const slotNames = `${el.id} ${el.className} ${Array.from(el.querySelectorAll('[id]')).map((c) => c.id).join(' ')}`;
      if (h === 0 && /interstitial|_Int_|\b1x1\b|_1x1|parallax|anchor|out-?of-?page/i.test(slotNames)) {
        el.remove();
        removed += 1;
        return;
      }
      if (h < 50) {
        // Collapsed because the ad script was blocked: fall back to a size hint in the markup
        // ("News_728x90", data-ad-size, min-h-[250px]).
        const text = `${el.id} ${el.className} ${el.getAttribute('data-ad-size') || ''} ${Array.from(el.querySelectorAll('[id],[class]')).map((c) => `${c.id} ${c.className}`).join(' ')}`;
        const wh = text.match(/(\d{2,4})x(\d{2,4})/);
        const minH = text.match(/min-h-\[(\d{2,4})px\]/);
        if (wh) { w = Math.min(parseInt(wh[1], 10), w || parseInt(wh[1], 10)); h = parseInt(wh[2], 10); }
        else if (minH) h = parseInt(minH[1], 10);
      }
      if (w > 0 && h > 20) {
        const ph = document.createElement('div');
        ph.className = 'jaani-ad-block';
        ph.setAttribute('data-jaani-blocked', 'true');
        ph.setAttribute('data-ad-size', `${w}x${h}`);
        ph.setAttribute('style', `width:${w}px;max-width:100%;height:${h}px;box-sizing:border-box;margin:8px auto;background:#f5f5f5;border:1px dashed #bbb;display:flex;align-items:center;justify-content:center;font-family:sans-serif;font-size:13px;color:#888`);
        ph.textContent = 'ব্লক করা হয়েছে';
        el.replaceWith(ph);
        replaced.push(`${w}x${h}`);
      } else {
        el.remove();
        removed += 1;
      }
    });
    return { replaced, removed };
  }, { adSelectors: AD_SELECTORS, paywallSelectors: PAYWALL_SELECTORS });
}

/** Remove cookie bars, newsletter popups and overlays (run after cosmetic CSS). */
async function removeAnnoyances(page) {
  return page.evaluate(({ selectors, paywallSelectors }) => {
    const paywall = paywallSelectors.join(',');
    let removed = 0;
    const found = [];
    document.querySelectorAll(selectors.join(',')).forEach((el) => {
      if (!el.isConnected || el.matches(paywall) || el.querySelector('h1, article, [itemprop="articleBody"]')) return;
      found.push((typeof el.className === 'string' && el.className.split(' ')[0]) || el.id || el.tagName);
      el.remove();
      removed += 1;
    });
    // Unlock scrolling that overlays commonly freeze.
    [document.documentElement, document.body].forEach((n) => { if (n) n.style.overflow = ''; });
    return { removed, found: found.slice(0, 10) };
  }, { selectors: ANNOYANCE_SELECTORS, paywallSelectors: PAYWALL_SELECTORS });
}

/** Paywall signals: Piano/Tinypass DOM + globals + resource hosts, JSON-LD isAccessibleForFree. */
async function detectPaywall(page, requestLog = null) {
  const signals = await page.evaluate((paywallSelectors) => {
    const out = [];
    if (document.querySelector('.tp-modal') || document.body.classList.contains('tp-modal-open')) out.push('piano:tp-modal');
    if (typeof window.tp !== 'undefined' && window.tp) out.push('piano:window.tp');
    if (document.documentElement.dataset.paywall) out.push(`data-paywall=${document.documentElement.dataset.paywall}`);
    if (document.querySelector(paywallSelectors.join(','))) out.push('paywall-selector');
    try {
      performance.getEntriesByType('resource').forEach((e) => {
        if (/tinypass\.com|piano\.io/i.test(e.name)) out.push('piano:resource');
      });
    } catch { /* ignore */ }
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        const txt = s.textContent || '';
        if (/"isAccessibleForFree"\s*:\s*("false"|false)/i.test(txt)) out.push('jsonld:isAccessibleForFree=false');
      } catch { /* ignore */ }
    });
    return Array.from(new Set(out));
  }, PAYWALL_SELECTORS);
  if (requestLog && requestLog.paywallHosts && requestLog.paywallHosts.size) {
    signals.push(`requests:${Array.from(requestLog.paywallHosts).join('|')}`);
  }
  const detected = signals.some((s) => s.startsWith('piano:') || s.startsWith('jsonld:') || s.startsWith('data-paywall') || s === 'paywall-selector');
  const vendor = signals.some((s) => s.includes('piano') || s.includes('tinypass')) ? 'piano'
    : signals.some((s) => s.startsWith('jsonld:')) ? 'json-ld' : detected ? 'unknown' : '';
  return { detected, vendor, signals };
}

/** Stylesheets from ad/tracker CDNs (inert without scripts, but they cost lookups and layout). */
function isAdStylesheetUrl(href = '') {
  return /doubleclick|googlesyndication|taboola|outbrain|adservice|amazon-adsystem|criteo/i.test(String(href));
}

module.exports = {
  getEngine,
  stripNetworkRequests,
  injectCosmeticFilters,
  cosmeticStyleFor,
  getAdSelectors,
  replaceAdSlots,
  removeAnnoyances,
  detectPaywall,
  isAdStylesheetUrl,
};
