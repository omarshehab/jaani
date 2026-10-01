/**
 * Cross-Source Intelligence Service
 * Discovers similar news coverage from Google News RSS and major BD outlet RSS feeds.
 * All I/O has timeouts and individual failures are isolated.
 */

'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');

const UA = 'JAANI/1.0 (civic-tech; rtirequest.org)';
const FEED_TIMEOUT_MS = 6000;

// ── BD outlet RSS registry ─────────────────────────────────────────────────────
const BD_FEEDS = [
  { name: 'প্রথম আলো',      url: 'https://www.prothomalo.com/feed',                               lang: 'bn' },
  { name: 'The Daily Star', url: 'https://www.thedailystar.net/frontpage/rss.xml',               lang: 'en' },
  { name: 'bdnews24',       url: 'https://bdnews24.com/?widgetName=rssfeed&widgetId=1',           lang: 'bn' },
  { name: 'Dhaka Tribune',  url: 'https://www.dhakatribune.com/feed',                            lang: 'en' },
  { name: 'সমকাল',          url: 'https://samakal.com/feed',                                     lang: 'bn' },
  { name: 'কালের কণ্ঠ',     url: 'https://www.kalerkantho.com/rss.xml',                          lang: 'bn' },
  { name: 'মানবজমিন',       url: 'https://mzamin.com/feed',                                      lang: 'bn' },
  { name: 'ইত্তেফাক',       url: 'https://www.ittefaq.com.bd/feed',                              lang: 'bn' },
  { name: 'যুগান্তর',       url: 'https://jugantor.com/rss-feed',                                lang: 'bn' },
  { name: 'TBS News',       url: 'https://www.tbsnews.net/feed',                                 lang: 'en' },
];

// ── Category labels (EN → BN) ──────────────────────────────────────────────────
const CATEGORY_BN = {
  corroborating: 'সমর্থক',
  complementary: 'পরিপূরক',
  contradicting:  'বিরোধী',
  background:    'পটভূমি',
  follow_up:     'পরবর্তী',
  divergent:     'বিচ্ছিন্ন',
};

// ── Word-level Jaccard similarity ─────────────────────────────────────────────

function wordSet(text) {
  return new Set(
    (text || '').toLowerCase()
      .replace(/[^\w\u0980-\u09FF\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2)
  );
}

function wordJaccard(t1, t2) {
  const s1 = wordSet(t1);
  const s2 = wordSet(t2);
  const inter = [...s1].filter(w => s2.has(w)).length;
  const union = new Set([...s1, ...s2]).size;
  return union === 0 ? 0 : inter / union;
}

// ── RSS fetch & parse (RSS 2.0 + Atom) ────────────────────────────────────────

async function fetchRss(url, timeout = FEED_TIMEOUT_MS) {
  const resp = await axios.get(url, {
    timeout,
    headers: { 'User-Agent': UA, Accept: 'application/xml,text/xml,*/*' },
    validateStatus: s => s < 400,
  });

  const $ = cheerio.load(resp.data, { xmlMode: true });
  const items = [];

  // RSS 2.0
  $('item').each((_, el) => {
    const $el = $(el);
    items.push({
      title:   $el.find('title').first().text().trim(),
      link:    ($el.find('link').first().text().trim() || $el.find('link').first().attr('href') || ''),
      snippet: $el.find('description').first().text().replace(/<[^>]+>/g, '').trim().slice(0, 250),
      pubDate: $el.find('pubDate').first().text().trim() || $el.find('dc\\:date').first().text().trim(),
    });
  });

  // Atom
  $('entry').each((_, el) => {
    const $el = $(el);
    items.push({
      title:   $el.find('title').first().text().trim(),
      link:    ($el.find('link[rel="alternate"]').attr('href') || $el.find('link').first().attr('href') || $el.find('link').first().text().trim()),
      snippet: $el.find('summary').first().text().replace(/<[^>]+>/g, '').trim().slice(0, 250),
      pubDate: $el.find('updated').first().text().trim() || $el.find('published').first().text().trim(),
    });
  });

  return items.filter(i => i.title && i.link);
}

// ── Google News RSS ────────────────────────────────────────────────────────────

async function fetchGoogleNews(query, lang = 'bn', timeout = 8000) {
  const q    = encodeURIComponent(query);
  const hl   = lang === 'bn' ? 'bn' : 'en';
  const ceid = lang === 'bn' ? 'BD:bn' : 'BD:en';
  const url  = `https://news.google.com/rss/search?q=${q}&hl=${hl}&gl=BD&ceid=${ceid}`;
  try {
    return await fetchRss(url, timeout);
  } catch (e) {
    console.warn(`[crossSource] Google News RSS failed: ${e.message}`);
    return [];
  }
}

// ── Build search queries from analysis context ─────────────────────────────────

function buildQueries(keywords = [], entities = [], summary = '') {
  const queries = [];

  const orgNames = entities
    .filter(e => /^(ORG|ORGANIZATION|MINISTRY)$/i.test(e.label || e.type || ''))
    .slice(0, 2)
    .map(e => e.text || e.name || '')
    .filter(Boolean);

  if (orgNames.length > 0 || keywords.length > 0) {
    queries.push([...orgNames, ...keywords.slice(0, 3)].join(' '));
  }

  if (keywords.length > 0) queries.push(keywords.slice(0, 4).join(' '));

  const firstSentence = (summary || '').split(/[।.]/)[0]?.trim();
  if (firstSentence && firstSentence.length > 20) queries.push(firstSentence.slice(0, 100));

  return [...new Set(queries.filter(Boolean))].slice(0, 3);
}

// ── Classify a similar article relative to the source article ─────────────────

function classifyRelationship(foundPubDate, analyzedPubDate, similarity) {
  const a = new Date(analyzedPubDate || Date.now());
  const f = new Date(foundPubDate     || Date.now());
  const daysDiff = (f - a) / 86_400_000;

  if (similarity > 0.6)  return 'corroborating';
  if (daysDiff < -14)    return 'background';
  if (daysDiff > 3)      return 'follow_up';
  if (similarity > 0.35) return 'complementary';
  return 'divergent';
}

function sourceNameFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'Unknown'; }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Main discovery function
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {Object} opts
 * @param {string}   opts.articleUrl
 * @param {string}   opts.articleTitle
 * @param {string}   opts.articleText
 * @param {string}   [opts.articlePubDate]
 * @param {string[]} [opts.keywords]
 * @param {Object[]} [opts.entities]
 * @param {string}   [opts.summary]
 * @returns {Promise<Object>}
 */
async function discoverSimilarArticles({
  articleUrl    = '',
  articleTitle  = '',
  articleText   = '',
  articlePubDate = '',
  keywords      = [],
  entities      = [],
  summary       = '',
} = {}) {
  const queries = buildQueries(keywords, entities, summary);
  let articleDomain = '';
  try { articleDomain = new URL(articleUrl).hostname; } catch {}

  const allItems = [];
  const channelsOk = [];

  // ── A: Google News (Bengali) ──
  for (const q of queries.slice(0, 2)) {
    try {
      const items = await fetchGoogleNews(q, 'bn');
      if (items.length) channelsOk.push('google_news_bn');
      items.forEach(i => allItems.push({ ...i, channel: 'google_news' }));
      await new Promise(r => setTimeout(r, 800)); // polite delay
    } catch {}
  }

  // ── B: BD outlet RSS feeds (parallel, isolated) ──
  const feedResults = await Promise.allSettled(
    BD_FEEDS.map(async feed => {
      let feedDomain = '';
      try { feedDomain = new URL(feed.url).hostname; } catch {}
      if (feedDomain === articleDomain) return [];
      const items = await fetchRss(feed.url, FEED_TIMEOUT_MS);
      return items.map(i => ({ ...i, source_name: feed.name, channel: 'outlet_rss' }));
    })
  );

  for (const r of feedResults) {
    if (r.status === 'fulfilled' && r.value.length) {
      channelsOk.push('outlet_rss');
      r.value.forEach(i => allItems.push(i));
    }
  }

  // ── Score & deduplicate ──
  const refText = [articleTitle, ...keywords.slice(0, 5), (summary || '').slice(0, 200)].join(' ');
  const seen    = new Set([articleUrl.toLowerCase()]);

  const scored = allItems
    .filter(i => i.title && i.link)
    .map(i => ({
      ...i,
      similarity_score: Math.round(wordJaccard(refText, `${i.title} ${i.snippet || ''}`) * 100) / 100,
    }))
    .filter(i => {
      const k = i.link.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return i.similarity_score > 0.08;
    })
    .sort((a, b) => b.similarity_score - a.similarity_score)
    .slice(0, 25);

  const sameSource  = scored.filter(i => { try { return new URL(i.link).hostname === articleDomain; } catch { return false; } });
  const otherSource = scored.filter(i => { try { return new URL(i.link).hostname !== articleDomain; } catch { return true; } });

  const similarArticles = otherSource.slice(0, 12).map(i => {
    const category = classifyRelationship(i.pubDate, articlePubDate, i.similarity_score);
    return {
      title:              i.title,
      url:                i.link,
      source_name:        i.source_name || sourceNameFromUrl(i.link),
      published_at:       i.pubDate || null,
      snippet:            i.snippet || '',
      category,
      category_label_bn:  CATEGORY_BN[category] || category,
      similarity_score:   i.similarity_score,
      is_same_source:     false,
    };
  });

  const moreFromSource = sameSource.slice(0, 5).map(i => ({
    title:            i.title,
    url:              i.link,
    published_at:     i.pubDate || null,
    similarity_score: i.similarity_score,
    is_same_source:   true,
  }));

  const highCount = similarArticles.filter(a => a.similarity_score > 0.45).length;
  const coverage_consensus = highCount >= 3 ? 'high' : highCount >= 2 ? 'medium' : 'low';

  const cross_source_summary = similarArticles.length > 0
    ? `${similarArticles.length}টি অন্য সংবাদমাধ্যমে সংশ্লিষ্ট প্রতিবেদন পাওয়া গেছে।`
    : 'অন্য সংবাদমাধ্যমে কোনো সংশ্লিষ্ট প্রতিবেদন পাওয়া যায়নি।';

  return {
    similar_articles:    similarArticles,
    more_from_source:    moreFromSource,
    cross_source_summary,
    coverage_consensus,
    unique_to_source:    [],
    search_queries_used: queries,
    channels_successful: [...new Set(channelsOk)],
  };
}

module.exports = {
  discoverSimilarArticles,
  fetchGoogleNews,
  buildQueries,
  wordJaccard,
};
