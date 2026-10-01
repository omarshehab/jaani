// jaaniDB.js — all client-side persistence for the article cache and view history.
// The RTI officer CSV and the forensic evidence vault stay server-side.
import Dexie from 'dexie';
import LZString from 'lz-string';

export const db = new Dexie('jaani_v3');
db.version(1).stores({
  articles: '&urlHash, url, fetchedAt', // &urlHash = primary key
  history: '++id, urlHash, viewedAt',
  providerCache: '&provider',
});

// Handy for checks from the browser console in development (e.g. expiring a cached row).
if (process.env.NODE_ENV === 'development' && typeof window !== 'undefined') {
  window.jaaniDB = db;
}

// Call once at app startup. Logs whether the browser granted persistent storage.
export async function initDB() {
  try {
    if (navigator.storage?.persist) {
      const granted = await navigator.storage.persist();
      console.log(`[jaaniDB] storage.persist granted: ${granted}`);
    }
  } catch (e) {
    console.warn('[jaaniDB] storage.persist failed:', e?.message || e);
  }
}

/**
 * Cache key for an article: SHA-256 of the URL normalized the same way the backend does it
 * (services/liveProxyReader.js tokenForUrl: parsed URL with the #fragment dropped), so the key
 * equals the reader token / salience urlHash. Returns '' when Web Crypto is unavailable
 * (non-secure origins such as http://<LAN-IP>) — the cache is then simply skipped.
 */
export async function computeUrlHash(rawUrl) {
  try {
    if (!window.crypto?.subtle) return '';
    const u = new URL(String(rawUrl || '').trim());
    u.hash = '';
    const bytes = new TextEncoder().encode(u.href);
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

// articleHtml is often 50–200 KB raw; stored compressed.
export const compressHtml = (html) => LZString.compressToUTF16(html || '');
export const decompressHtml = (lz) => LZString.decompressFromUTF16(lz || '') || '';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Fields rebuilt per request, never persisted.
const TRANSIENT_FIELDS = ['requestId', 'articleHtml', 'sentenceHighlights', 'ai_status', 'fromCache'];

export async function getCachedArticle(urlHash) {
  if (!urlHash) return null;
  const row = await db.articles.get(urlHash);
  if (!row) return null;
  if (Date.now() - row.fetchedAt > CACHE_TTL_MS) return null; // stale
  return { ...row, articleHtml: decompressHtml(row.articleHtmlLz) };
}

/**
 * Store a finished analysis (after the Phase 2 merge). The full analysis payload is kept so a
 * cache hit can restore every section, not just the article body.
 */
export async function cacheArticle(urlHash, url, payload = {}) {
  if (!urlHash) return;
  const raw = payload.articleHtml || '';
  const articleHtmlLz = compressHtml(raw);
  const analysis = { ...payload };
  TRANSIENT_FIELDS.forEach((k) => { delete analysis[k]; });
  await db.articles.put({
    urlHash,
    url,
    articleHtmlLz,
    proxyModeAvailable: Boolean(payload.proxyModeAvailable),
    meta: payload.meta_data || {},
    entities: payload.entities || [],
    keywords: payload.keywords || [],
    sentenceHighlights: Array.isArray(payload.sentenceHighlights) ? payload.sentenceHighlights : [],
    analysis,
    fetchedAt: Date.now(),
  });
  await db.history.put({ urlHash, title: payload.meta_data?.title || url, viewedAt: Date.now() });
  console.log(`[jaaniDB] cached ${url} — articleHtml ${raw.length} chars → ${articleHtmlLz.length} UTF-16 chars compressed`);
}

export async function recordView(urlHash, title) {
  if (!urlHash) return;
  await db.history.put({ urlHash, title, viewedAt: Date.now() });
}

export async function updateSentenceHighlights(urlHash, sentenceHighlights) {
  if (!urlHash) return;
  await db.articles.update(urlHash, { sentenceHighlights });
}
