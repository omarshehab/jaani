/**
 * Local index of Bangladeshi fact-checks, built by polling the fact-checkers' own public RSS feeds
 * on a schedule (never per user request, never a search query sent to their servers).
 *
 * Only what the feeds publish is stored (title, excerpt, link, date, categories). Nothing here is
 * generated: an LLM elsewhere may only choose among items retrieved from this index.
 *
 * robots.txt is checked before every poll and Crawl-delay is honoured (FactWatch asks for 60 s).
 * AFP Fact Check has no usable Bangla feed and is not covered.
 */

const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const robotsParser = require('robots-parser');
const { normalizeText } = require('./rtiGazetteer');

const UA = 'JAANI/1.0 (civic-tech; bangladesh)';
const INDEX_PATH = path.join(__dirname, '..', 'data', 'factcheck_index', 'index.json');
const MAX_ITEMS = 6000;

const SOURCES = [
  { id: 'rumorscanner-bn', name: 'Rumor Scanner', origin: 'https://rumorscanner.com', feed: 'https://rumorscanner.com/feed', paginate: true },
  { id: 'rumorscanner-en', name: 'Rumor Scanner', origin: 'https://rumorscanner.com', feed: 'https://rumorscanner.com/en/feed', paginate: true },
  { id: 'factwatch', name: 'FactWatch', origin: 'https://www.fact-watch.org', feed: 'https://www.fact-watch.org/feed/', paginate: true },
  { id: 'dismislab', name: 'Dismislab', origin: 'https://dismislab.com', feed: 'https://dismislab.com/feed/', paginate: true },
  { id: 'boombd', name: 'BOOM Bangladesh', origin: 'https://boombd.com', feed: 'https://boombd.com/feed', paginate: false },
];

let state = null;
let loadedMtime = 0;
let polling = null;

async function load() {
  // Re-read when the file changed (another instance may have polled); never mid-poll.
  let mtime = 0;
  try { mtime = (await fs.stat(INDEX_PATH)).mtimeMs; } catch { mtime = 0; }
  if (state && (polling || mtime === loadedMtime)) return state;
  try {
    state = JSON.parse(await fs.readFile(INDEX_PATH, 'utf8'));
  } catch {
    state = state || { items: {}, sources: {} };
  }
  loadedMtime = mtime;
  state.items = state.items || {};
  state.sources = state.sources || {};
  return state;
}

async function save() {
  await fs.mkdir(path.dirname(INDEX_PATH), { recursive: true });
  const tmp = `${INDEX_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state));
  await fs.rename(tmp, INDEX_PATH); // atomic replace
  try { loadedMtime = (await fs.stat(INDEX_PATH)).mtimeMs; } catch { /* ignore */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function robotsFor(origin) {
  try {
    const url = `${origin}/robots.txt`;
    const r = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 15000, validateStatus: () => true, responseType: 'text' });
    return robotsParser(url, r.status === 200 ? String(r.data) : '');
  } catch {
    return robotsParser(`${origin}/robots.txt`, '');
  }
}

function stripHtml(html) {
  return cheerio.load(`<x>${html || ''}</x>`)('x').text().replace(/\s+/g, ' ').trim();
}

function parseFeed(xml, source) {
  const $ = cheerio.load(String(xml || ''), { xmlMode: true });
  const out = [];
  $('item').each((_, el) => {
    const $el = $(el);
    const url = ($el.find('link').first().text() || '').trim();
    const title = stripHtml($el.find('title').first().text());
    if (!url || !title) return;
    out.push({
      url,
      title,
      description: stripHtml($el.find('description').first().text()).slice(0, 700),
      published: new Date($el.find('pubDate').first().text() || Date.now()).toISOString(),
      categories: $el.find('category').map((i, c) => $(c).text().trim()).get().slice(0, 8),
      source: source.name,
      sourceId: source.id,
    });
  });
  return out;
}

async function pollSource(source, { pages = 1 } = {}) {
  const robots = await robotsFor(source.origin);
  const delayMs = Math.max(3000, (Number(robots.getCrawlDelay(UA)) || 0) * 1000 + 1000);
  let added = 0;
  const lastPage = source.paginate ? pages : 1;
  for (let page = 1; page <= lastPage; page += 1) {
    const url = page === 1 ? source.feed : `${source.feed}${source.feed.includes('?') ? '&' : '?'}paged=${page}`;
    if (robots.isAllowed(url, UA) === false) {
      console.warn(`[factcheck] robots.txt disallows ${url} — skipped`);
      break;
    }
    let items = [];
    try {
      const r = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 20000, responseType: 'text', validateStatus: (s) => s < 500 });
      if (r.status !== 200) break;
      items = parseFeed(r.data, source);
    } catch (e) {
      console.warn(`[factcheck] ${source.id} page ${page} failed: ${e.message}`);
      break;
    }
    if (!items.length) break;
    let newOnPage = 0;
    items.forEach((it) => {
      if (!state.items[it.url]) { newOnPage += 1; added += 1; }
      state.items[it.url] = { ...(state.items[it.url] || {}), ...it, indexedAt: state.items[it.url]?.indexedAt || new Date().toISOString() };
    });
    if (page > 1 && newOnPage === 0) break; // reached already-indexed history
    if (page < lastPage) await sleep(delayMs);
  }
  state.sources[source.id] = { lastPolled: new Date().toISOString(), delayMs, count: Object.values(state.items).filter((i) => i.sourceId === source.id).length };
  return added;
}

function trimIndex() {
  const all = Object.values(state.items);
  if (all.length <= MAX_ITEMS) return;
  all.sort((a, b) => String(b.published).localeCompare(String(a.published)));
  state.items = Object.fromEntries(all.slice(0, MAX_ITEMS).map((i) => [i.url, i]));
}

/**
 * Poll every source. `pages` > 1 backfills history on the first run. Sources are polled one after
 * another so no site sees more than one request at a time from JAANI.
 */
async function pollAll({ pages = 1 } = {}) {
  if (polling) return polling;
  polling = (async () => {
    await load();
    let added = 0;
    for (const source of SOURCES) {
      try { added += await pollSource(source, { pages }); } catch (e) { console.warn(`[factcheck] ${source.id}: ${e.message}`); }
    }
    trimIndex();
    state.updatedAt = new Date().toISOString();
    await save();
    console.log(`[factcheck] index updated: +${added} items, ${Object.keys(state.items).length} total`);
    return added;
  })().finally(() => { polling = null; });
  return polling;
}

// ── Retrieval (deterministic, BM25-style) ───────────────────────────────────────────────────────
const STOPWORDS = new Set(['এবং', 'ও', 'এ', 'এই', 'সে', 'যে', 'না', 'করে', 'হয়', 'হয়েছে', 'থেকে', 'জন্য', 'সঙ্গে', 'বলে',
  'দাবি', 'দাবিতে', 'ভিডিও', 'ছবি', 'করা', 'নিয়ে', 'একটি', 'তার', 'তিনি', 'এক', 'কি', 'কী', 'নয়', 'ভুয়া', 'গুজব', 'প্রচার',
  'হচ্ছে', 'হলো', 'হল', 'আর', 'বা', 'কোনো', 'সব', 'এর', 'তা', 'যা', 'the', 'a', 'an', 'of', 'in', 'on', 'to', 'and', 'is', 'was',
  'for', 'with', 'false', 'claim', 'video', 'photo', 'fake', 'news'].map(normalizeText));
// Normalized the same way as the text (NFC decomposes য়/ড়, so raw literals would never match).
const SUFFIXES = ['দের', 'গুলো', 'গুলি', 'টির', 'টা', 'টি', 'এর', 'ের', 'কে', 'তে', 'রা', 'র', 'য়', 'ে'].map(normalizeText);

function stem(token) {
  if (token.length <= 3) return token;
  for (const suf of SUFFIXES) {
    if (token.endsWith(suf) && token.length - suf.length >= 2) return token.slice(0, -suf.length);
  }
  return token;
}

function tokenize(text) {
  return normalizeText(text).split(' ').map(stem).filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/**
 * @param {string[]} queries  short phrases describing the article's subject/claims
 * @returns {Promise<Array<{item: object, score: number}>>}
 */
async function search(queries = [], { limit = 6, minScore = 4 } = {}) {
  await load();
  const items = Object.values(state.items);
  if (!items.length) return [];
  const qTokens = Array.from(new Set(queries.flatMap(tokenize)));
  if (!qTokens.length) return [];

  const docs = items.map((item) => {
    const tokens = [...tokenize(item.title), ...tokenize(item.title), ...tokenize(item.description)]; // title weighted ×2
    const tf = new Map();
    tokens.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    return { item, tf, len: tokens.length };
  });
  const avgLen = docs.reduce((a, d) => a + d.len, 0) / docs.length || 1;
  const df = new Map();
  qTokens.forEach((t) => df.set(t, docs.filter((d) => d.tf.has(t)).length));
  const k1 = 1.4;
  const b = 0.75;
  const N = docs.length;

  return docs.map((d) => {
    let score = 0;
    let matched = 0;
    qTokens.forEach((t) => {
      const f = d.tf.get(t);
      if (!f) return;
      matched += 1;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgLen)));
    });
    return { item: d.item, score: matched >= 2 ? score : 0, matched };
  })
    .filter((r) => r.score >= minScore)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, limit);
}

async function stats() {
  await load();
  return {
    total: Object.keys(state.items).length,
    updatedAt: state.updatedAt || null,
    sources: state.sources,
  };
}

module.exports = { pollAll, search, stats, tokenize, SOURCES, _internal: { parseFeed } };
