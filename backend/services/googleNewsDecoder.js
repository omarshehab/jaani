/**
 * Resolve Google News RSS links (news.google.com/rss/articles/<id>) to the publisher's own URL.
 *
 * Google no longer exposes the target in the link or via a plain redirect. The current (2026)
 * mechanism, reproduced here without a headless browser:
 *   1. GET the article page and read its data-n-a-sg (signature) and data-n-a-ts (timestamp);
 *   2. POST every id's (id, ts, sig) to news.google.com's batchexecute RPC ("Fbv4je") in ONE
 *      request; each answer ("garturlres") carries the publisher URL.
 * A consent cookie is sent so EU-style consent walls don't replace the page.
 *
 * Google changes this without notice, so failure is expected, not exceptional: unresolved ids map
 * to null and callers keep the Google link, labelled as such. Resolved URLs never change, so they
 * are cached by id for the life of the process.
 */

const axios = require('axios');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Cookie: 'CONSENT=YES+cb', 'Accept-Language': 'bn,en;q=0.8' };
const BATCH_URL = 'https://news.google.com/_/DotsSplashUi/data/batchexecute';
const CACHE_MAX = 5000;
const cache = new Map(); // id → publisher URL (only successes are cached)

function articleIdFromUrl(url = '') {
  const m = String(url).match(/news\.google\.com\/(?:rss\/)?articles\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

function remember(id, url) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(id, url);
}

async function fetchSignature(id, timeoutMs) {
  const r = await axios.get(`https://news.google.com/rss/articles/${id}`, {
    headers: HEADERS, timeout: timeoutMs, maxRedirects: 3, responseType: 'text', maxContentLength: 4 * 1024 * 1024,
  });
  const html = String(r.data || '');
  const sg = (html.match(/data-n-a-sg="([^"]+)"/) || [])[1];
  const ts = (html.match(/data-n-a-ts="([^"]+)"/) || [])[1];
  if (!sg || !ts) throw new Error('signature not found (page layout changed or consent wall)');
  return { id, sg, ts };
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      try { out[i] = await fn(items[i]); } catch (e) { out[i] = { error: e.message }; }
    }
  });
  await Promise.all(workers);
  return out;
}

function parseBatchResponse(text) {
  const byTag = new Map();
  const body = String(text || '').replace(/^\)\]\}'\s*/, '');
  let rows;
  try { rows = JSON.parse(body.split('\n').find((line) => line.trim().startsWith('[[')) || '[]'); } catch { return byTag; }
  (rows || []).forEach((row) => {
    if (!Array.isArray(row) || row[0] !== 'wrb.fr' || row[1] !== 'Fbv4je') return;
    try {
      const inner = JSON.parse(row[2]);
      if (inner && inner[0] === 'garturlres' && typeof inner[1] === 'string') byTag.set(String(row[row.length - 1]), inner[1]);
    } catch { /* malformed row */ }
  });
  return byTag;
}

/**
 * @param {string[]} articleIds
 * @param {{ budgetMs?: number }} options  overall time budget; whatever is unresolved by then → null
 * @returns {Promise<Map<string, string|null>>}
 */
async function resolvePublisherUrls(articleIds = [], { budgetMs = 12000 } = {}) {
  const ids = Array.from(new Set((articleIds || []).filter(Boolean)));
  const result = new Map(ids.map((id) => [id, cache.get(id) || null]));
  const pending = ids.filter((id) => !cache.has(id));
  if (!pending.length) return result;

  const deadline = Date.now() + budgetMs;
  const work = (async () => {
    const sigs = (await mapWithConcurrency(pending, 4, (id) => fetchSignature(id, Math.max(2000, deadline - Date.now() - 2500))))
      .filter((s) => s && s.sg);
    if (!sigs.length) return;
    // One batchexecute call for every id; the trailing tag (index) maps answers back to ids.
    const reqs = sigs.map((s, i) => ['Fbv4je',
      `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${s.id}",${Number(s.ts)},"${s.sg.replace(/"/g, '')}"]`,
      null, String(i)]);
    const r = await axios.post(BATCH_URL, `f.req=${encodeURIComponent(JSON.stringify([reqs]))}`, {
      headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      timeout: Math.max(2000, deadline - Date.now()), responseType: 'text',
    });
    const byTag = parseBatchResponse(r.data);
    sigs.forEach((s, i) => {
      const url = byTag.get(String(i));
      if (url && /^https?:\/\//i.test(url) && !/news\.google\.com/.test(url)) {
        remember(s.id, url);
        result.set(s.id, url);
      }
    });
  })().catch((e) => console.warn('[googleNewsDecoder] batch failed:', e.message));

  await Promise.race([work, new Promise((resolve) => setTimeout(resolve, budgetMs))]);
  return result;
}

module.exports = { resolvePublisherUrls, articleIdFromUrl };
