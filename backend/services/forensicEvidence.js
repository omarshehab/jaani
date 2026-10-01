/**
 * Forensic evidence capture for news articles.
 *
 * Preserves what a court or opposing party would ask for if the publisher later deletes or edits the
 * article: the raw HTTP response bytes, rendered DOM, full-page screenshot, TLS certificate, DNS data,
 * redirect chain, Internet Archive snapshot, and an RFC 3161 trusted timestamp over a manifest that
 * hashes every file. Everything is written to data/evidence_vault/<capture_id>/.
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const https = require('https');
const tls = require('tls');
const dns = require('dns').promises;
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { VAULT_DIR } = require('./evidenceVault');
// SSRF guard: Section 1's classifier (liveProxyReader) — the same rules, not a copy.
const { assertFetchableUrl, isPrivateOrReservedIp, isLocalHostname, isPublicHost } = require('./liveProxyReader');
const { startEgressGuardProxy } = require('../utils/egressGuardProxy');

// DNS lookup for Node sockets (raw HTTP hops, TLS): refuses a host if ANY resolved address is
// private/reserved, at connect time — so a DNS change between a check and the connect can't slip by.
function guardedLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'function' ? {} : (options || {});
  if (isLocalHostname(hostname)) return cb(Object.assign(new Error(`blocked local host ${hostname}`), { code: 'EBLOCKED' }));
  return require('dns').lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isPrivateOrReservedIp(a.address))) {
      return cb(Object.assign(new Error(`blocked private/reserved address for ${hostname}`), { code: 'EBLOCKED' }));
    }
    if (opts.all) return cb(null, addrs);
    return cb(null, addrs[0].address, addrs[0].family);
  });
}

async function assertPublicUrl(url) {
  const parsed = assertFetchableUrl(url); // protocol, credentials, ports 80/443, local names, IP literals
  if (!(await isPublicHost(parsed.hostname))) {
    throw Object.assign(new Error(`blocked: ${parsed.hostname} resolves to a private or reserved address`), { status: 400 });
  }
  return parsed;
}

const TOOL = 'JAANI forensic capture v1.0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const URL_INDEX_PATH = path.join(VAULT_DIR, 'url_index.json');
const inFlight = new Map();

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest('hex');
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
const toBuf = (v) => (Buffer.isBuffer(v) ? v : Buffer.from(String(v ?? ''), 'utf8'));

function agentFor(url) {
  let insecure = false;
  try {
    const host = new URL(url).hostname;
    insecure = host.endsWith('.gov.bd') && String(process.env.ALLOW_INSECURE_GOV_TLS).toLowerCase() === 'true';
  } catch { /* fall through */ }
  return new https.Agent({ rejectUnauthorized: !insecure, lookup: guardedLookup });
}
const guardedHttpAgent = new (require('http').Agent)({ lookup: guardedLookup });

// ── 1. Raw HTTP capture with redirect chain ─────────────────────────────────────────────────────

async function captureRawHttp(url) {
  const chain = [];
  let current = url;
  const startedAt = new Date();
  for (let hop = 0; hop < 8; hop += 1) {
    await assertPublicUrl(current); // every hop, including redirect targets
    const t0 = Date.now();
    const res = await axios.get(current, {
      responseType: 'arraybuffer',
      maxRedirects: 0,
      timeout: 30000,
      validateStatus: () => true,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'bn-BD,bn;q=0.9,en;q=0.7' },
      httpsAgent: agentFor(current),
      httpAgent: guardedHttpAgent,
      proxy: false,
    });
    const sock = res.request?.socket;
    chain.push({
      url: current,
      status: res.status,
      statusText: res.statusText || '',
      elapsedMs: Date.now() - t0,
      location: res.headers.location || null,
      serverDate: res.headers.date || null,
      remoteAddress: sock?.remoteAddress || null,
      remotePort: sock?.remotePort || null,
    });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      current = new URL(res.headers.location, current).href;
      continue;
    }
    return {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      finalUrl: current,
      status: res.status,
      headers: res.headers,
      body: Buffer.from(res.data),
      chain,
    };
  }
  throw new Error('Too many redirects');
}

// ── 2. TLS certificate + DNS ────────────────────────────────────────────────────────────────────

function certSummary(c) {
  if (!c || !Object.keys(c).length) return null;
  return {
    subject: c.subject, issuer: c.issuer, validFrom: c.valid_from, validTo: c.valid_to,
    serialNumber: c.serialNumber, fingerprint256: c.fingerprint256, subjectAltName: c.subjectaltname || null,
  };
}

function captureTls(hostname, port = 443) {
  return new Promise((resolve) => {
    const done = (v) => resolve(v);
    const timer = setTimeout(() => done({ error: 'tls timeout' }), 12000);
    try {
      const sock = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false, lookup: guardedLookup }, () => {
        clearTimeout(timer);
        const chain = [];
        let c = sock.getPeerCertificate(true);
        for (let i = 0; c && Object.keys(c).length && i < 5; i += 1) {
          chain.push(certSummary(c));
          if (!c.issuerCertificate || c.issuerCertificate === c) break;
          c = c.issuerCertificate;
        }
        const out = {
          protocol: sock.getProtocol(), cipher: sock.getCipher(),
          trustedByNode: sock.authorized, authorizationError: sock.authorizationError || null, certificateChain: chain,
        };
        sock.end();
        done(out);
      });
      sock.on('error', (e) => { clearTimeout(timer); done({ error: e.message }); });
    } catch (e) { clearTimeout(timer); done({ error: e.message }); }
  });
}

async function captureDns(hostname) {
  const [a, aaaa, cname, ns, mx] = await Promise.allSettled([
    dns.resolve4(hostname), dns.resolve6(hostname), dns.resolveCname(hostname), dns.resolveNs(hostname), dns.resolveMx(hostname),
  ]);
  const val = (r) => (r.status === 'fulfilled' ? r.value : []);
  return { hostname, A: val(a), AAAA: val(aaaa), CNAME: val(cname), NS: val(ns), MX: val(mx), resolvedAt: new Date().toISOString() };
}

// ── 3. Browser render: screenshot + rendered DOM ────────────────────────────────────────────────

// Full-page PNG of any height as ONE image. Chromium's software renderer corrupts/tiles single
// screenshots past ~16,384 px, so tall pages are captured in segments and stitched with sharp.
const SINGLE_SHOT_MAX_PX = 15500;
const SEGMENT_PX = 8000;
const STITCH_MAX_PX = 60000;

async function fullPageShot(page, width = 1280) {
  const pageHeightPx = await page.evaluate(() => Math.max(
    document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0,
  )).catch(() => 900);
  const total = Math.max(1, Math.min(pageHeightPx, STITCH_MAX_PX));
  if (total <= SINGLE_SHOT_MAX_PX) {
    const png = await page.screenshot({ fullPage: true, type: 'png' });
    return { png, pageHeightPx, capturedHeightPx: pageHeightPx, segments: 1, truncated: false };
  }
  const sharp = require('sharp');
  const parts = [];
  for (let y = 0; y < total; y += SEGMENT_PX) {
    const h = Math.min(SEGMENT_PX, total - y);
    parts.push({ input: await page.screenshot({ fullPage: true, clip: { x: 0, y, width, height: h }, type: 'png' }), top: y, left: 0 });
  }
  const png = await sharp({ create: { width, height: total, channels: 4, background: '#ffffff' } })
    .composite(parts).png().toBuffer();
  return { png, pageHeightPx, capturedHeightPx: total, segments: parts.length, truncated: pageHeightPx > STITCH_MAX_PX };
}

async function settleAndScroll(page) {
  await Promise.race([page.waitForLoadState('networkidle').catch(() => {}), page.waitForTimeout(5000)]);
  // Bounded scroll so lazy images load (infinite-scroll pages can't hang it).
  await page.evaluate(async () => {
    for (let i = 0; i < 40; i += 1) {
      window.scrollBy(0, 900);
      await new Promise((r) => setTimeout(r, 120));
      if (window.scrollY + window.innerHeight >= document.body.scrollHeight - 5) break;
    }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForTimeout(1500);
}

// Two renders of the same URL: (1) exactly as the publisher served it, (2) through the same
// ad/tracker/overlay filtering as Section 1's reader (adBlockEngine). Each is its own evidence file.
async function captureRender(url) {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch { return { error: 'playwright not installed' }; }
  let browser;
  let egress;
  const contextOptions = { userAgent: UA, viewport: { width: 1280, height: 900 }, locale: 'bn-BD', ignoreHTTPSErrors: true };
  try {
    // Every connection (page, sub-resources, redirect hops, WebSockets) goes through the egress
    // guard proxy; "<-loopback>" stops Chromium from bypassing the proxy for localhost.
    egress = await startEgressGuardProxy();
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-http2'],
      proxy: { server: egress.server, bypass: '<-loopback>' },
    });

    const rawPass = (async () => {
      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await settleAndScroll(page);
      const shot = await fullPageShot(page);
      const out = { ...shot, dom: await page.content(), title: await page.title(), finalUrl: page.url() };
      await context.close();
      return out;
    })();

    const adblockPass = (async () => {
      const adBlockEngine = require('./adBlockEngine');
      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();
      const requestLog = await adBlockEngine.stripNetworkRequests(page, {
        mainUrl: url,
        isAllowedUrl: async (reqUrl) => {
          try {
            const parsed = new URL(reqUrl);
            return ['http:', 'https:'].includes(parsed.protocol) && isPublicHost(parsed.hostname);
          } catch {
            return false;
          }
        },
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await settleAndScroll(page);
      const adSlots = await adBlockEngine.replaceAdSlots(page);
      const cosmeticCssChars = await adBlockEngine.injectCosmeticFilters(page, page.url());
      await page.waitForTimeout(500);
      const annoyances = await adBlockEngine.removeAnnoyances(page);
      const shot = await fullPageShot(page);
      await context.close();
      return {
        ...shot,
        filtering: {
          engine: 'Ghostery adblocker (EasyList, EasyPrivacy, uBlock annoyance/cookie lists) via JAANI adBlockEngine',
          blockedRequests: Array.isArray(requestLog?.blocked) ? requestLog.blocked.length : (requestLog?.blockedCount ?? null),
          adSlots,
          cosmeticCssChars,
          annoyances,
        },
      };
    })();

    const [raw, adblock] = await Promise.allSettled([rawPass, adblockPass]);
    await browser.close();
    await egress.close();
    const blockedRequests = egress.blocked.slice(0, 50);
    if (raw.status !== 'fulfilled') {
      return { error: raw.reason?.message || 'render failed', adblock: adblock.status === 'fulfilled' ? adblock.value : { error: adblock.reason?.message } };
    }
    return {
      ...raw.value,
      egressBlocked: blockedRequests,
      capturedAt: new Date().toISOString(),
      adblock: adblock.status === 'fulfilled' ? adblock.value : { error: adblock.reason?.message },
    };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    if (egress) await egress.close().catch(() => {});
    return { error: e.message };
  }
}

// ── 4. Internet Archive ─────────────────────────────────────────────────────────────────────────

async function captureWayback(url) {
  const out = { requestedAt: new Date().toISOString(), saveRequest: null, snapshots: [] };
  // Save request: up to 3 attempts with exponential backoff (2 s, 4 s) before recording a failure.
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const resp = await axios.get(`https://web.archive.org/save/${url}`, {
        timeout: 45000, maxRedirects: 5, validateStatus: () => true, headers: { 'User-Agent': UA },
      });
      const loc = resp.headers?.['content-location'] || resp.headers?.location || resp.request?.res?.responseUrl || '';
      const m = String(loc).match(/\/web\/(\d{14})\//);
      out.saveRequest = {
        httpStatus: resp.status,
        snapshotUrl: m ? (String(loc).startsWith('http') ? loc : `https://web.archive.org${loc}`) : null,
        snapshotTimestamp: m ? m[1] : null,
        attempt,
      };
      attempts.push({ attempt, httpStatus: resp.status, snapshot: Boolean(m) });
      if (m) break;
    } catch (e) {
      attempts.push({ attempt, error: e.message });
      out.saveRequest = { error: e.message, attempt };
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * (2 ** (attempt - 1))));
  }
  out.saveAttempts = attempts;
  try {
    const cdx = await axios.get('https://web.archive.org/cdx/search/cdx', {
      params: { url, output: 'json', limit: -5, fl: 'timestamp,statuscode,digest,original,length' }, timeout: 40000, headers: { 'User-Agent': UA },
    });
    const rows = Array.isArray(cdx.data) ? cdx.data.slice(1) : [];
    out.snapshots = rows.map(([timestamp, statuscode, digest, original, length]) => ({
      timestamp, statuscode, digest, original, length, url: `https://web.archive.org/web/${timestamp}/${original}`,
    }));
  } catch (e) { out.cdxError = e.message; }
  return out;
}

// ── 5. RFC 3161 trusted timestamp (over the manifest hash) ───────────────────────────────────────

function buildTimestampQuery(hashHex) {
  const hash = Buffer.from(hashHex, 'hex');
  const prefix = Buffer.from('3039020101' + '3031300d060960864801650304020105000420', 'hex');
  return Buffer.concat([prefix, hash, Buffer.from('0101ff', 'hex')]);
}

function parseTimestampResponse(buf) {
  try {
    let i = 1;
    i += buf[i] & 0x80 ? 1 + (buf[i] & 0x7f) : 1; // outer SEQUENCE length
    if (buf[i] !== 0x30) return { granted: false };
    i += 1;
    i += buf[i] & 0x80 ? 1 + (buf[i] & 0x7f) : 1; // PKIStatusInfo length
    const status = buf[i] === 0x02 ? buf[i + 2] : -1;
    const text = buf.toString('latin1');
    const gen = text.match(/\x18\x0f(\d{14}Z)/);
    let genTime = null;
    if (gen) {
      const g = gen[1];
      genTime = `${g.slice(0, 4)}-${g.slice(4, 6)}-${g.slice(6, 8)}T${g.slice(8, 10)}:${g.slice(10, 12)}:${g.slice(12, 14)}Z`;
    }
    return { granted: status === 0 || status === 1, status, genTime };
  } catch { return { granted: false }; }
}

const TSA_SERVERS = [
  { name: 'FreeTSA.org', url: 'https://freetsa.org/tsr', verifyHint: 'CA: https://freetsa.org/files/cacert.pem  TSA cert: https://freetsa.org/files/tsa.crt' },
  { name: 'DigiCert', url: 'http://timestamp.digicert.com', verifyHint: 'Chain: https://www.digicert.com/kb/digicert-root-certificates.htm' },
];

async function requestTimestamp(hashHex) {
  const tsq = buildTimestampQuery(hashHex);
  const attempts = [];
  for (const tsa of TSA_SERVERS) {
    try {
      const r = await axios.post(tsa.url, tsq, {
        headers: { 'Content-Type': 'application/timestamp-query', 'User-Agent': UA },
        responseType: 'arraybuffer', timeout: 25000, validateStatus: () => true,
      });
      const tsr = Buffer.from(r.data);
      const parsed = parseTimestampResponse(tsr);
      attempts.push({ tsa: tsa.name, httpStatus: r.status, granted: parsed.granted });
      if (r.status === 200 && parsed.granted) {
        return { ok: true, tsa: tsa.name, tsaUrl: tsa.url, verifyHint: tsa.verifyHint, tsq, tsr, genTime: parsed.genTime, digestAlgorithm: 'SHA-256', messageImprint: hashHex, attempts };
      }
    } catch (e) { attempts.push({ tsa: tsa.name, error: e.message }); }
  }
  return { ok: false, attempts };
}

// ── URL index (reuse the capture made at analysis time when the PDF is requested later) ─────────

async function readIndex() {
  try { return JSON.parse(await fs.readFile(URL_INDEX_PATH, 'utf8')); } catch { return {}; }
}

async function writeIndex(idx) {
  await fs.mkdir(VAULT_DIR, { recursive: true });
  const tmp = `${URL_INDEX_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(idx, null, 2));
  await fs.rename(tmp, URL_INDEX_PATH); // atomic replace
}

async function loadForensic(captureId) {
  try { return JSON.parse(await fs.readFile(path.join(VAULT_DIR, captureId, 'forensic.json'), 'utf8')); } catch { return null; }
}

// A capture is complete when it holds both the publisher's raw response and the original-page
// screenshot. One made while the network or the browser was down has neither and must not stand in
// for the article's evidence forever.
function isCompleteCapture(rec) {
  const names = new Set((rec?.files || []).map((f) => f.name));
  return names.has('raw_http_response_body.html') && names.has('screenshot_fullpage.png');
}

async function getForensicEvidenceForUrl(url) {
  const key = String(url || '').trim();
  if (inFlight.has(key)) return inFlight.get(key);
  const ids = [].concat((await readIndex())[key] || []);
  if (!ids.length) return null;
  const all = (await Promise.all(ids.map(loadForensic))).filter(Boolean);
  if (!all.length) return null;
  // The earliest COMPLETE capture is the strongest proof of publication; the others (including
  // incomplete attempts) are listed alongside it. With no complete capture, the earliest is
  // returned flagged `incomplete` so the caller can try again.
  const chosen = all.find(isCompleteCapture) || all[0];
  const others = all.filter((r) => r !== chosen)
    .map((r) => ({ capture_id: r.capture_id, captured_at_utc: r.captured_at_utc, http_status: r.http?.status, complete: isCompleteCapture(r) }));
  const newest = all[all.length - 1];
  return {
    ...chosen,
    incomplete: !isCompleteCapture(chosen),
    newest_capture_at_utc: newest.captured_at_utc,
    other_captures: others,
  };
}

async function hasRecentCapture(url, maxAgeMs) {
  const ids = [].concat((await readIndex())[String(url || '').trim()] || []);
  if (!ids.length) return false;
  const last = await loadForensic(ids[ids.length - 1]);
  // An incomplete capture does not count: the next analysis should try again.
  return Boolean(last && isCompleteCapture(last) && Date.now() - new Date(last.captured_at_utc).getTime() < maxAgeMs);
}

// ── Article text / metadata derived from THIS capture's own fetch ──────────────────────────────
// Everything preserved as "the article" (text, title, date, author) is read out of the HTML this
// module fetched itself — never from a caller, and never from the client's browser.
function deriveArticleFromCapture(html, baseUrl) {
  if (!html) return null;
  try {
    const dom = new JSDOM(html, { url: baseUrl, virtualConsole: new VirtualConsole() }); // scripts never run
    const doc = dom.window.document;
    const meta = (...sels) => {
      for (const sel of sels) {
        const v = doc.querySelector(sel)?.getAttribute('content');
        if (v && v.trim()) return v.trim();
      }
      return '';
    };
    const metadata = {
      title: meta('meta[property="og:title"]', 'meta[name="twitter:title"]') || (doc.title || '').trim(),
      published_date: meta('meta[property="article:published_time"]', 'meta[name="pubdate"]', 'meta[name="publication_date"]')
        || (doc.querySelector('time[datetime]')?.getAttribute('datetime') || '').trim(),
      modified_date: meta('meta[property="article:modified_time"]', 'meta[property="og:updated_time"]'),
      author: meta('meta[name="author"]', 'meta[property="article:author"]'),
      site_name: meta('meta[property="og:site_name"]'),
    };
    const article = new Readability(doc).parse();
    // One line per block element, so paragraphs don't run together (Readability's textContent
    // drops block boundaries).
    let lines = [];
    if (article?.content) {
      const body = new JSDOM(`<body>${article.content}</body>`, { virtualConsole: new VirtualConsole() }).window.document.body;
      lines = Array.from(body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,pre,td'))
        .filter((el) => !el.querySelector('p,li,blockquote,h1,h2,h3,h4,h5,h6'))
        .map((el) => el.textContent);
    }
    if (!lines.length) lines = (article?.textContent || '').split(/\n+/);
    const text = lines
      .map((line) => String(line).normalize('NFC').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
    return { text, html: article?.content || '', metadata: { ...metadata, author: metadata.author || (article?.byline || '').trim() } };
  } catch (e) {
    return { text: '', html: '', metadata: {}, error: e.message };
  }
}

// Staging folders left by a crash were never renamed into place, so they are not evidence.
async function removeStalePartials(maxAgeMs = 60 * 60 * 1000) {
  try {
    const entries = await fs.readdir(VAULT_DIR);
    await Promise.all(entries.filter((e) => e.startsWith('.partial-')).map(async (e) => {
      const p = path.join(VAULT_DIR, e);
      const st = await fs.stat(p);
      if (Date.now() - st.mtimeMs > maxAgeMs) await fs.rm(p, { recursive: true, force: true });
    }));
  } catch { /* vault may not exist yet */ }
}

// ── Main pipeline ───────────────────────────────────────────────────────────────────────────────

/**
 * Capture court-oriented evidence for a URL. Only the URL is accepted: the preserved article text,
 * title, dates and author are derived from this capture's own browser render (or raw HTTP body if the
 * render failed), so nothing a caller or client sends can end up hashed and timestamped as evidence.
 */
async function captureForensicEvidence({ articleUrl } = {}) {
  const url = String(articleUrl || '').trim();
  if (!url) throw new Error('articleUrl required');
  if (inFlight.has(url)) return inFlight.get(url);

  const job = (async () => {
    await removeStalePartials();
    await assertPublicUrl(url); // refuse private/reserved targets before any fetch or disk write
    const captureId = uuidv4();
    // Everything is written into a hidden staging folder and renamed into place only after the
    // manifest, timestamp and summary exist, so a crash mid-capture can never leave a half-written
    // entry that looks like evidence (rename within one filesystem is atomic).
    const finalDir = path.join(VAULT_DIR, captureId);
    const dir = path.join(VAULT_DIR, `.partial-${captureId}`);
    await fs.mkdir(dir, { recursive: true });
    const custody = [];
    const log = (event, detail = '') => custody.push({ at: new Date().toISOString(), event, detail });
    const host = new URL(url).hostname;

    log('capture_started', `${TOOL}; target ${url}`);

    const [rawR, tlsR, dnsR, renderR, waybackR] = await Promise.allSettled([
      captureRawHttp(url), captureTls(host), captureDns(host), captureRender(url), captureWayback(url),
    ]);
    const raw = rawR.status === 'fulfilled' ? rawR.value : null;
    const render = renderR.status === 'fulfilled' ? renderR.value : { error: renderR.reason?.message };
    log('raw_http_capture', raw ? `HTTP ${raw.status}, ${raw.body.length} bytes` : `failed: ${rawR.reason?.message}`);
    log('tls_dns_capture', 'TLS certificate chain and DNS records recorded');
    if (render.egressBlocked && render.egressBlocked.length) {
      log('egress_guard', `blocked ${render.egressBlocked.length} browser connection(s) to private/reserved addresses: ${render.egressBlocked.slice(0, 5).join('; ')}`);
    }
    log('browser_render', render.png
      ? `original page screenshot ${render.png.length} bytes, ${render.capturedHeightPx}px tall${render.segments > 1 ? ` (${render.segments} segments stitched)` : ''}${render.truncated ? `, truncated from ${render.pageHeightPx}px` : ''}`
      : `failed: ${render.error}`);
    log('browser_render_filtered', render.adblock && render.adblock.png
      ? `reading-view screenshot (ads/trackers/overlays removed by automated filter) ${render.adblock.png.length} bytes, ${render.adblock.capturedHeightPx}px tall`
      : `failed: ${render.adblock?.error || 'not captured'}`);
    log('internet_archive', waybackR.status === 'fulfilled' ? JSON.stringify(waybackR.value.saveRequest) : `failed: ${waybackR.reason?.message}`);

    const files = [];
    const put = async (name, data) => {
      const buf = toBuf(data);
      await fs.writeFile(path.join(dir, name), buf);
      files.push({ name, bytes: buf.length, sha256: sha256(buf), sha512: sha512(buf), md5: md5(buf) });
    };
    if (raw) {
      await put('raw_http_response_body.html', raw.body);
      await put('http_response_headers.json', JSON.stringify({ finalUrl: raw.finalUrl, status: raw.status, headers: raw.headers }, null, 2));
      await put('redirect_chain.json', JSON.stringify(raw.chain, null, 2));
    }
    if (render.png) await put('screenshot_fullpage.png', render.png);
    if (render.adblock && render.adblock.png) await put('screenshot_adblocked.png', render.adblock.png);
    if (render.dom) await put('rendered_dom.html', render.dom);

    // Preserved article text: from the rendered DOM (what the screenshot shows), else the raw body.
    const fromRender = deriveArticleFromCapture(render.dom, render.finalUrl || url);
    const fromRaw = (!fromRender || !fromRender.text) ? deriveArticleFromCapture(raw?.body?.toString('utf8'), raw?.finalUrl || url) : null;
    const derived = (fromRender && fromRender.text) ? fromRender : (fromRaw && fromRaw.text ? fromRaw : null);
    const textSource = derived === fromRender && derived ? 'rendered_dom.html'
      : (derived ? 'raw_http_response_body.html' : 'none');
    const articleMeta = (fromRender && fromRender.metadata) || (fromRaw && fromRaw.metadata) || {};
    const title = articleMeta.title || render.title || '';
    const publishedDate = articleMeta.published_date || '';
    await put('extracted_article_text.txt', derived ? derived.text : '');
    if (derived && derived.html) await put('extracted_article.html', derived.html);
    log('article_text_derived', derived
      ? `from ${textSource} of this capture (Readability), ${derived.text.length} chars`
      : 'no article text could be derived from this capture');
    await put('tls_certificate.json', JSON.stringify(tlsR.status === 'fulfilled' ? tlsR.value : { error: tlsR.reason?.message }, null, 2));
    await put('dns_records.json', JSON.stringify(dnsR.status === 'fulfilled' ? dnsR.value : { error: dnsR.reason?.message }, null, 2));
    await put('internet_archive.json', JSON.stringify(waybackR.status === 'fulfilled' ? waybackR.value : { error: waybackR.reason?.message }, null, 2));
    await put('extracted_metadata.json', JSON.stringify({ ...articleMeta, derived_from: textSource }, null, 2));

    const manifest = {
      capture_id: captureId, tool: TOOL, article_url: url, title, published_date: publishedDate, text_source: textSource,
      captured_at_utc: new Date().toISOString(), server_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      files, custody_log: custody,
    };
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    await fs.writeFile(path.join(dir, 'manifest.json'), manifestBuf);
    const manifestSha256 = sha256(manifestBuf);

    const ts = await requestTimestamp(manifestSha256);
    if (ts.ok) {
      await fs.writeFile(path.join(dir, 'manifest.tsq'), ts.tsq);
      await fs.writeFile(path.join(dir, 'manifest.tsr'), ts.tsr);
      custody.push({ at: new Date().toISOString(), event: 'rfc3161_timestamp', detail: `${ts.tsa} attested ${ts.genTime}` });
    } else {
      custody.push({ at: new Date().toISOString(), event: 'rfc3161_timestamp_failed', detail: JSON.stringify(ts.attempts) });
    }

    const summaryRecord = {
      capture_id: captureId,
      article_url: url,
      final_url: raw?.finalUrl || url,
      title,
      published_date: publishedDate,
      // Which captured file the preserved article text was derived from (never client-supplied).
      text_source: textSource,
      captured_at_utc: manifest.captured_at_utc,
      captured_at_bst: new Date(manifest.captured_at_utc).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour12: false }) + ' (UTC+6, Asia/Dhaka)',
      http: raw ? { status: raw.status, headers: raw.headers, chain: raw.chain, startedAt: raw.startedAt, finishedAt: raw.finishedAt } : null,
      server_ip: raw?.chain?.[raw.chain.length - 1]?.remoteAddress || null,
      tls: tlsR.status === 'fulfilled' ? tlsR.value : null,
      dns: dnsR.status === 'fulfilled' ? dnsR.value : null,
      render: render.png ? {
        title: render.title, finalUrl: render.finalUrl, pageHeightPx: render.pageHeightPx, capturedHeightPx: render.capturedHeightPx,
        segments: render.segments, truncated: render.truncated,
        filtered: render.adblock && render.adblock.png
          ? { pageHeightPx: render.adblock.pageHeightPx, capturedHeightPx: render.adblock.capturedHeightPx, segments: render.adblock.segments, filtering: render.adblock.filtering }
          : { error: render.adblock?.error || 'not captured' },
      } : { error: render.error },
      wayback: waybackR.status === 'fulfilled' ? waybackR.value : null,
      files,
      manifest_sha256: manifestSha256,
      timestamp: ts.ok
        ? { tsa: ts.tsa, tsa_url: ts.tsaUrl, gen_time: ts.genTime, algorithm: ts.digestAlgorithm, message_imprint: ts.messageImprint, verify_hint: ts.verifyHint, tsr_file: 'manifest.tsr', tsq_file: 'manifest.tsq' }
        : { error: 'No trusted timestamp obtained', attempts: ts.attempts },
      custody_log: custody,
      screenshot_data_uri: render.png && render.png.length < 6_000_000 ? `data:image/png;base64,${render.png.toString('base64')}` : null,
      tool: TOOL,
    };
    const { screenshot_data_uri: _omit, ...persisted } = summaryRecord;
    await fs.writeFile(path.join(dir, 'forensic.json'), JSON.stringify(persisted, null, 2));
    await fs.rename(dir, finalDir);

    const idx = await readIndex();
    idx[url] = [].concat(idx[url] || [], captureId);
    await writeIndex(idx);
    return summaryRecord;
  })();

  inFlight.set(url, job);
  try { return await job; } finally { inFlight.delete(url); }
}

// ── Retention ──────────────────────────────────────────────────────────────────────────────────
// Captures older than `maxAgeDays` are removed with their vault folders; each deletion is logged.
// Covers forensic captures (forensic.json captured_at_utc), the older evidenceVault format
// (metadata.json captured_at) and empty folders (folder time). Staging folders are left to
// removeStalePartials. The URL index is rewritten once, atomically, after the sweep.
async function sweepExpiredCaptures({ maxAgeDays = 90, dryRun = false, log = console.log } = {}) {
  const days = Number(maxAgeDays);
  if (!Number.isFinite(days) || days <= 0) return { skipped: true, reason: 'retention disabled' };
  const cutoff = Date.now() - days * 86400 * 1000;
  let entries = [];
  try { entries = await fs.readdir(VAULT_DIR, { withFileTypes: true }); } catch { return { removed: [], kept: 0 }; }
  const removed = [];
  let kept = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !/^[0-9a-f-]{36}$/i.test(e.name)) continue;
    const dir = path.join(VAULT_DIR, e.name);
    let capturedAt = null;
    let kind = 'empty';
    try {
      capturedAt = JSON.parse(await fs.readFile(path.join(dir, 'forensic.json'), 'utf8')).captured_at_utc;
      kind = 'forensic';
    } catch {
      try {
        capturedAt = JSON.parse(await fs.readFile(path.join(dir, 'metadata.json'), 'utf8')).captured_at;
        kind = 'legacy';
      } catch { /* empty or unreadable folder: fall back to folder time */ }
    }
    const t = capturedAt ? new Date(capturedAt).getTime() : (await fs.stat(dir)).mtimeMs;
    if (!Number.isFinite(t) || t >= cutoff) { kept += 1; continue; }
    removed.push({ id: e.name, kind, capturedAt: capturedAt || new Date(t).toISOString() });
    log(`[evidence-retention] ${dryRun ? 'would delete' : 'deleting'} ${kind} capture ${e.name} (captured ${capturedAt || 'unknown'}, older than ${days} days)`);
    if (!dryRun) await fs.rm(dir, { recursive: true, force: true });
  }
  if (!dryRun && removed.length) {
    const gone = new Set(removed.map((r) => r.id));
    const idx = await readIndex();
    Object.keys(idx).forEach((url) => {
      idx[url] = [].concat(idx[url] || []).filter((id) => !gone.has(id));
      if (!idx[url].length) delete idx[url];
    });
    await writeIndex(idx);
  }
  return { removed, kept, dryRun, maxAgeDays: days };
}

// Re-hash every stored file and confirm the manifest still matches its timestamp imprint.
async function verifyForensicBundle(captureId) {
  const dir = path.join(VAULT_DIR, captureId);
  const rec = await loadForensic(captureId);
  if (!rec) return { verified: false, error: 'not_found' };
  const results = [];
  for (const f of rec.files) {
    try {
      const buf = await fs.readFile(path.join(dir, f.name));
      results.push({ name: f.name, ok: sha256(buf) === f.sha256 });
    } catch { results.push({ name: f.name, ok: false }); }
  }
  let manifestOk = false;
  try { manifestOk = sha256(await fs.readFile(path.join(dir, 'manifest.json'))) === rec.manifest_sha256; } catch { /* missing */ }
  let imprintOk = null;
  try {
    const tsq = await fs.readFile(path.join(dir, 'manifest.tsq'));
    imprintOk = tsq.subarray(tsq.length - 3 - 32, tsq.length - 3).toString('hex') === rec.manifest_sha256;
  } catch { imprintOk = null; }
  return {
    verified: results.every((r) => r.ok) && manifestOk && imprintOk !== false,
    capture_id: captureId, files: results, manifest_matches: manifestOk, timestamp_imprint_matches: imprintOk, checked_at: new Date().toISOString(),
  };
}

module.exports = {
  captureForensicEvidence, getForensicEvidenceForUrl, hasRecentCapture, verifyForensicBundle, loadForensic,
  sweepExpiredCaptures,
  _internal: { fullPageShot, deriveArticleFromCapture }, // for tests
};
