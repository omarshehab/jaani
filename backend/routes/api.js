/**
 * ? JAANI API Routes - The Core Logic Engine
 * 
 * 3 Main Endpoints:
 * 1. POST /analyze            - Analyzes news URLs and returns metadata with images
 * 2. POST /verify-contact     - Compares Database vs Live scraped contact info
 * 3. POST /send-mail          - Queues email for sending (with multipart/form-data support)
 */

const express = require('express');
const axios = require('axios');
const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
let JSDOM = null;
let Readability = null;
try {
  ({ JSDOM } = require('jsdom'));
  ({ Readability } = require('@mozilla/readability'));
} catch (e) {
  console.warn('?? Readability parser not available - using heuristic extraction only');
}
let chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  console.warn('?? Playwright not available - PDF generation and JS-heavy page extraction will be disabled');
  chromium = null;
}
const { body, validationResult } = require('express-validator');
let postmark = null;
try {
  postmark = require('postmark');
} catch (e) {
  console.warn('⚠️ postmark package not available - /send-mail-postmark will be disabled');
}
const contactLoader = require('../data/contactLoader');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs'); // Synchronous fs for existsSync
const crypto = require('crypto');
const historyManager = require('../../shared/historyManager');
const sanitizeHtml = require('sanitize-html');
const activityTracker = require('../../shared/activityTracker');
const { extractWithPlaywright } = require('./playwrightExtractor');
const { extractWithAxiosOnly, extractMediaFromHtml, truncateToWords, normalizeWhitespace } = require('./axiosFastExtractor');
// detectPriorityOffice removed — Section 3 now uses officeResolution.js
const { fetchAndProxyWebpage } = require('../utils/webviewProxy');
const mammoth = require('mammoth');
const rtfToHtml = require('@iarna/rtf-to-html');
const rtiLookup = require('../services/rtiDatabaseLookup');
const rtiActGuidance = require('../services/rtiActGuidance');
const { buildFormKaDraft } = require('../services/rtiApplicationDraft');
const googleNewsDecoder = require('../services/googleNewsDecoder');
const factCheckLookup = require('../services/factCheckLookup');

// -- Gemini AI Analysis (replaces local ML service) --
const geminiAnalysis = require('../services/geminiAnalysis');

// -- NEW: Analytics, Evidence Vault, Cross-Source Intelligence --
const analyticsEngine       = require('../services/analyticsEngine');
const evidenceVault         = require('../services/evidenceVault');
const forensicEvidence     = require('../services/forensicEvidence');
const crossSourceIntelligence = require('../services/crossSourceIntelligence');
const liveProxyReader = require('../services/liveProxyReader');
const salienceEnsemble = require('../services/salienceEnsemble');
const salienceStore = require('../services/salienceStore');

const gmailRoutes = require('./gmail');

const router = express.Router();

/*
// Redis cache stub (future use)
// const { createClient } = require('redis');
// const redisClient = createClient({ url: process.env.REDIS_URL });
// redisClient.on('error', (err) => console.warn('Redis error:', err.message));
// const buildDailyCacheKey = (targetUrl) => {
//   const day = new Date().toISOString().slice(0, 10);
//   return `news:${day}:${targetUrl}`;
// };
*/

/*
// RSS Feed Aggregation stub (future use)
// Parses XML feeds from Prothom Alo / Daily Star Bangla / Jugantor
// const { parseStringPromise } = require('xml2js');
// const RSS_FEEDS = [
//   { name: 'prothomalo',  url: 'https://www.prothomalo.com/feed' },
//   { name: 'dailystar',   url: 'https://www.thedailystar.net/rss.xml' },
//   { name: 'jugantor',    url: 'https://www.jugantor.com/rss.xml' },
// ];
// async function aggregateRssFeeds() {
//   const allItems = [];
//   for (const feed of RSS_FEEDS) {
//     try {
//       const res = await axios.get(feed.url, { httpsAgent: INSECURE_TLS_AGENT, timeout: 15000 });
//       const parsed = await parseStringPromise(res.data);
//       const items = (parsed?.rss?.channel?.[0]?.item || []).slice(0, 20);
//       items.forEach(item => {
//         allItems.push({
//           source: feed.name,
//           title: item.title?.[0] || '',
//           link:  item.link?.[0] || '',
//           pubDate: item.pubDate?.[0] || '',
//         });
//       });
//     } catch (err) { console.warn(`RSS fetch failed for ${feed.name}:`, err.message); }
//   }
//   return allItems;
// }
*/

const ROUTE_HTTP_AGENT = new http.Agent({
  keepAlive: true,
  maxSockets: 128,
  maxFreeSockets: 32,
  timeout: 30000,
});

const ROUTE_HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  maxSockets: 128,
  maxFreeSockets: 32,
  timeout: 30000,
});

const URL_SAFETY_CACHE_TTL_MS = parseInt(process.env.URL_SAFETY_CACHE_TTL_MS || '600000', 10);
const urlSafetyCache = new Map();
const ALLOW_PRIVATE_NETWORK_URLS = String(process.env.ALLOW_PRIVATE_NETWORK_URLS || '').toLowerCase() === 'true';
const textIntegrity = require('../utils/textIntegrity');
const { findRoleHeadingElement } = require('../utils/roleHeadings');
const { buildLiveScrapedRecord, computeOfficerDiscrepancies } = require('../utils/officerDiff');
const { createOfficerUrlGuard } = require('../utils/officerUrlGuard');
const officerUrlGuard = createOfficerUrlGuard({ allowPrivateNetwork: ALLOW_PRIVATE_NETWORK_URLS });
const ALLOW_INSECURE_GOV_TLS = String(process.env.ALLOW_INSECURE_GOV_TLS || '').toLowerCase() === 'true';
const MAX_PROXY_IMAGE_BYTES = parseInt(process.env.MAX_PROXY_IMAGE_BYTES || String(5 * 1024 * 1024), 10);
const MAX_EXTERNAL_URL_LENGTH = parseInt(process.env.MAX_EXTERNAL_URL_LENGTH || '4096', 10);

function isPrivateOrReservedIp(ip = '') {
  const value = (ip || '').toString().trim();
  if (!value) return true;

  const ipType = net.isIP(value);
  if (!ipType) return true;

  if (ipType === 4) {
    return (
      /^0\./.test(value)
      || /^10\./.test(value)
      || /^127\./.test(value)
      || /^169\.254\./.test(value)
      || /^172\.(1[6-9]|2\d|3[0-1])\./.test(value)
      || /^192\.168\./.test(value)
      || /^192\.0\.0\./.test(value)
      || /^192\.0\.2\./.test(value)
      || /^198\.(1[8-9])\./.test(value)
      || /^198\.51\.100\./.test(value)
      || /^203\.0\.113\./.test(value)
      || /^22[4-9]\./.test(value)
      || /^23\d\./.test(value)
      || /^24\d\./.test(value)
      || /^25[0-5]\./.test(value)
    );
  }

  const lower = value.toLowerCase();
  return (
    lower === '::1'
    || lower === '::'
    || lower.startsWith('fe80:')
    || lower.startsWith('fc')
    || lower.startsWith('fd')
    || lower.startsWith('::ffff:127.')
    || lower.startsWith('2001:db8:')
  );
}

function isLocalOrInvalidHostname(hostname = '') {
  const host = (hostname || '').toString().trim().toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host === '0.0.0.0') return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home')) return true;

  // Single-label hostnames can resolve internally in enterprise networks.
  if (!host.includes('.')) return true;

  return false;
}

function getAxiosAgentConfigForUrl(targetUrl = '', options = {}) {
  const allowInsecureGovTls = Boolean(options.allowInsecureGovTls);
  const isGovSite = isGovBdHostFromUrl(targetUrl);
  const useInsecureTls = allowInsecureGovTls && isGovSite;

  return {
    httpAgent: ROUTE_HTTP_AGENT,
    httpsAgent: useInsecureTls ? INSECURE_TLS_AGENT : ROUTE_HTTPS_AGENT,
  };
}

async function validateExternalHttpUrl(rawUrl, options = {}) {
  const allowPrivateNetwork = Boolean(options.allowPrivateNetwork);
  const label = options.label || 'url';

  if (typeof rawUrl !== 'string') {
    return { ok: false, status: 400, reason: `${label} must be a string` };
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, status: 400, reason: `${label} is required` };
  }

  if (trimmed.length > MAX_EXTERNAL_URL_LENGTH) {
    return { ok: false, status: 400, reason: `${label} is too long` };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, status: 400, reason: `${label} has invalid format` };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, status: 400, reason: `${label} must use http or https` };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, status: 400, reason: `${label} cannot include credentials` };
  }

  const hostname = (parsed.hostname || '').toLowerCase();
  if (!hostname) {
    return { ok: false, status: 400, reason: `${label} is missing hostname` };
  }

  if (!allowPrivateNetwork && isLocalOrInvalidHostname(hostname)) {
    return { ok: false, status: 400, reason: `${label} targets a local or invalid hostname` };
  }

  if (net.isIP(hostname)) {
    if (!allowPrivateNetwork && isPrivateOrReservedIp(hostname)) {
      return { ok: false, status: 400, reason: `${label} targets a private/reserved IP` };
    }

    return {
      ok: true,
      normalizedUrl: parsed.toString(),
      hostname,
      addresses: [hostname],
      isGovSite: isGovBdHostFromUrl(parsed.toString()),
    };
  }

  const cacheKey = `${hostname}::${allowPrivateNetwork ? '1' : '0'}`;
  const cached = urlSafetyCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < URL_SAFETY_CACHE_TTL_MS) {
    if (cached.ok) {
      return {
        ok: true,
        normalizedUrl: parsed.toString(),
        hostname,
        addresses: cached.addresses || [],
        isGovSite: isGovBdHostFromUrl(parsed.toString()),
      };
    }
    return { ok: false, status: 400, reason: cached.reason || `${label} host is not allowed` };
  }

  let addresses = [];
  try {
    const lookedUp = await dns.lookup(hostname, { all: true, verbatim: true });
    addresses = (lookedUp || []).map((entry) => entry?.address).filter(Boolean);
  } catch {
    addresses = [];
  }

  if (!allowPrivateNetwork && addresses.some((ip) => isPrivateOrReservedIp(ip))) {
    urlSafetyCache.set(cacheKey, {
      ok: false,
      reason: `${label} resolves to private/reserved network`,
      addresses,
      ts: Date.now(),
    });
    return { ok: false, status: 400, reason: `${label} resolves to private/reserved network` };
  }

  urlSafetyCache.set(cacheKey, { ok: true, addresses, ts: Date.now() });

  return {
    ok: true,
    normalizedUrl: parsed.toString(),
    hostname,
    addresses,
    isGovSite: isGovBdHostFromUrl(parsed.toString()),
  };
}

// Gmail OAuth + Draft/Send API (Google API)
router.use('/gmail', gmailRoutes);

function looksBlockedOrInterstitial(text, title = '') {
  const sample = `${title || ''}\n${(text || '').slice(0, 2000)}`.toLowerCase();
  const signals = [
    'just a moment', 'checking your browser', 'attention required',
    'cloudflare', 'access denied', 'you have been blocked',
    'enable javascript', 'please enable javascript', 'verify you are human',
    'are you a robot', 'captcha', 'recaptcha', 'hcaptcha',
    'automated queries', 'unusual traffic', 'bot detection',
    'browser verification', 'ray id', 'cf-browser-verification',
    'please wait while we verify', 'ddos protection',
    'security check', 'one more step', 'please complete the security check',
    'incapsula', 'sucuri', 'imperva', 'akamai ghost',
    'sorry, you have been blocked',
  ];
  return signals.some(s => sample.includes(s));
}

function normalizeExtractionText(text = '') {
  return String(text || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function countTokenOccurrences(haystack = '', token = '') {
  if (!haystack || !token) return 0;
  let count = 0;
  let idx = haystack.indexOf(token);
  while (idx !== -1) {
    count += 1;
    if (count > 300) break;
    idx = haystack.indexOf(token, idx + token.length);
  }
  return count;
}

function looksLikelyBoilerplateText(text = '') {
  const normalized = normalizeExtractionText(text);
  if (!normalized) return false;

  const sample = normalized.slice(0, 20000).toLowerCase();

  // Script payload signatures that leak into extraction when parsing fails.
  if (
    sample.includes('self.__next_f.push')
    || sample.includes('window.__initial_state__')
    || sample.includes('webpackchunk')
    || sample.includes('window.__nuxt__')
  ) {
    return true;
  }

  const words = sample.split(/\s+/).filter(Boolean);
  if (words.length < 80) return false;

  const sentenceCount = (sample.match(/[.!?।]/g) || []).length;
  const linkLikeCount = (sample.match(/https?:\/\/|www\.|\/category\/|\/tag\/| login | signup | sign in | privacy | cookie | terms | newsletter | subscribe /gi) || []).length;

  const boilerplateTokens = [
    'home',
    'menu',
    'latest',
    'breaking',
    'contact',
    'about',
    'privacy policy',
    'terms',
    'cookie',
    'advertisement',
    'subscribe',
    'newsletter',
    'facebook',
    'twitter',
    'instagram',
    'youtube',
    'linkedin',
    'all rights reserved',
  ];

  let navHits = 0;
  for (const token of boilerplateTokens) {
    navHits += countTokenOccurrences(sample, token);
  }

  const uniqueWords = new Set(words.slice(0, 1600));
  const uniqueRatio = uniqueWords.size / Math.max(words.length, 1);

  if (sentenceCount <= 6 && navHits >= 12) return true;
  if (sentenceCount <= 6 && linkLikeCount >= 20) return true;
  if (words.length > 450 && uniqueRatio < 0.28 && navHits >= 10) return true;

  return false;
}

function shouldEscalateExtraction(text = '', title = '') {
  return looksBlockedOrInterstitial(text, title) || looksLikelyBoilerplateText(text);
}

function parseArticleWithReadability(html = '', pageUrl = '') {
  if (!JSDOM || !Readability || !html) return null;
  try {
    const dom = new JSDOM(html, {
      url: pageUrl || 'https://example.com/',
      contentType: 'text/html',
    });

    const reader = new Readability(dom.window.document, {
      keepClasses: true,
      charThreshold: 120,
      nbTopCandidates: 8,
    });

    const parsed = reader.parse();
    if (!parsed) return null;

    // Readability's textContent glues block elements together with no separator
    // ("…৪৭৪বিশেষ প্রতিবেদক", "…হয়েছে।অযাচিত"), which merges headline/byline/paragraphs into one
    // run-on "sentence". Rebuild the text from the article HTML with a newline per block.
    let blockText = '';
    try {
      const blockHtml = String(parsed.content || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li|blockquote|figcaption|figure|tr|section|article|header|pre|ul|ol|table)>/gi, '</$1>\n');
      const blockDom = new JSDOM(`<body>${blockHtml}</body>`);
      blockText = blockDom.window.document.body.textContent || '';
      blockDom.window.close();
    } catch {
      blockText = '';
    }
    const textContent = normalizeExtractionText(blockText || parsed.textContent || '');
    if (!textContent || textContent.length < 180) return null;

    return {
      title: (parsed.title || '').trim(),
      byline: (parsed.byline || '').trim(),
      siteName: (parsed.siteName || '').trim(),
      excerpt: (parsed.excerpt || '').trim(),
      textContent,
      contentHtml: parsed.content || '',
    };
  } catch (error) {
    return null;
  }
}

// Configure multer for file uploads
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fsSync.existsSync(uploadsDir)) {
  fsSync.mkdirSync(uploadsDir, { recursive: true });
}
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif|webp|bmp|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|rtf|json|zip|rar|7z/;
    const allowedMime = /image\/|pdf|msword|officedocument|excel|spreadsheet|powerpoint|text|csv|rtf|json|zip|rar|7z/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedMime.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only images, PDFs, and documents allowed'));
    }
  }
});

/**
 * Helper function to capture legal proof data (checksum, headers, raw response)
 * This is used for court evidence to prove the existence of news content
 */
function normalizeIpAddressForGeo(ipValue = '') {
  const raw = (ipValue || '').toString().trim();
  if (!raw) return '';
  if (raw.startsWith('::ffff:')) return raw.replace('::ffff:', '');
  return raw;
}

function isPrivateOrLocalIp(ipValue = '') {
  const ip = normalizeIpAddressForGeo(ipValue).toLowerCase();
  if (!ip) return true;

  if (ip === 'localhost' || ip === '::1' || ip === '0.0.0.0' || ip === 'unknown') return true;
  if (/^10\./.test(ip)) return true;
  if (/^127\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;

  // IPv6 local/private ranges
  if (/^(fc|fd)/.test(ip)) return true;
  if (/^fe80:/.test(ip)) return true;

  return false;
}

function createHttpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function isBlockedHostname(hostname = '') {
  const host = (hostname || '').toString().trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  if (host === '0.0.0.0') return true;

  const ipType = net.isIP(host);
  if (ipType) {
    return isPrivateOrLocalIp(host);
  }

  return false;
}

async function resolvesToPrivateOrLocalIp(hostname = '') {
  const host = (hostname || '').toString().trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;

  const cacheKey = `host:${host}`;
  const now = Date.now();
  const cached = urlSafetyCache.get(cacheKey);
  if (cached && (now - cached.ts) < URL_SAFETY_CACHE_TTL_MS) {
    return Boolean(cached.privateOrLocal);
  }

  let privateOrLocal = false;
  try {
    const records = await dns.lookup(host, { all: true, verbatim: false });
    if (Array.isArray(records) && records.length > 0) {
      privateOrLocal = records.some((record) => isPrivateOrLocalIp(record?.address || ''));
    }
  } catch {
    privateOrLocal = false;
  }

  urlSafetyCache.set(cacheKey, { privateOrLocal, ts: now });
  if (urlSafetyCache.size > 4000) {
    const oldestKey = urlSafetyCache.keys().next().value;
    if (oldestKey) urlSafetyCache.delete(oldestKey);
  }

  return privateOrLocal;
}

async function assertSafeExternalUrl(rawUrl, options = {}) {
  const allowPrivateNetwork = options.allowPrivateNetwork === true;
  const allowHttp = options.allowHttp !== false;

  const raw = (rawUrl || '').toString().trim();
  if (!raw) throw createHttpError('URL is required');
  if (raw.length > MAX_EXTERNAL_URL_LENGTH) throw createHttpError('URL is too long');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw createHttpError('Invalid URL format');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw createHttpError('Only http/https URLs are allowed');
  }

  if (!allowHttp && parsed.protocol !== 'https:') {
    throw createHttpError('Only HTTPS URLs are allowed');
  }

  if (parsed.username || parsed.password) {
    throw createHttpError('URL credentials are not allowed');
  }

  const hostname = (parsed.hostname || '').toLowerCase().replace(/\.$/, '');
  if (!hostname) {
    throw createHttpError('Invalid URL hostname');
  }

  if (!allowPrivateNetwork && isBlockedHostname(hostname)) {
    throw createHttpError('Private/local network URLs are blocked');
  }

  if (!allowPrivateNetwork) {
    const privateOrLocal = await resolvesToPrivateOrLocalIp(hostname);
    if (privateOrLocal) {
      throw createHttpError('Resolved URL points to a private/local address');
    }
  }

  return {
    normalizedUrl: parsed.toString(),
    hostname,
    protocol: parsed.protocol,
  };
}

async function resolveServerIpLocation(ipValue = '') {
  const ip = normalizeIpAddressForGeo(ipValue);
  if (!ip) {
    return {
      status: 'unknown',
      reason: 'ip_missing',
      source: 'none',
    };
  }

  if (isPrivateOrLocalIp(ip)) {
    return {
      status: 'private',
      ip,
      reason: 'private_or_local_ip',
      source: 'local-check',
    };
  }

  try {
    const primary = await axios.get(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,regionName,city,lat,lon,isp,org,as,timezone,query`, {
      timeout: 4500,
    });

    if (primary?.data?.status === 'success') {
      return {
        status: 'ok',
        ip: primary.data.query || ip,
        country: primary.data.country || '',
        countryCode: primary.data.countryCode || '',
        region: primary.data.regionName || '',
        city: primary.data.city || '',
        latitude: primary.data.lat ?? null,
        longitude: primary.data.lon ?? null,
        isp: primary.data.isp || '',
        organization: primary.data.org || '',
        asn: primary.data.as || '',
        timezone: primary.data.timezone || '',
        source: 'ip-api.com',
      };
    }
  } catch {
    // fallback below
  }

  try {
    const fallback = await axios.get(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      timeout: 4500,
    });

    if (fallback?.data?.success) {
      return {
        status: 'ok',
        ip: fallback.data.ip || ip,
        country: fallback.data.country || '',
        countryCode: fallback.data.country_code || '',
        region: fallback.data.region || '',
        city: fallback.data.city || '',
        latitude: fallback.data.latitude ?? null,
        longitude: fallback.data.longitude ?? null,
        isp: fallback.data.connection?.isp || '',
        organization: fallback.data.connection?.org || '',
        asn: fallback.data.connection?.asn || '',
        timezone: fallback.data.timezone?.id || '',
        source: 'ipwho.is',
      };
    }
  } catch {
    // ignore
  }

  return {
    status: 'unknown',
    ip,
    reason: 'geo_lookup_failed',
    source: 'none',
  };
}

async function captureLegalProofData(url) {
  try {
    const validated = await validateExternalHttpUrl(url, {
      allowPrivateNetwork: ALLOW_PRIVATE_NETWORK_URLS,
      label: 'url',
    });
    if (!validated.ok) {
      throw new Error(validated.reason || 'Unsafe URL for legal-proof capture');
    }

    const safeUrl = validated.normalizedUrl;
    const agentConfig = getAxiosAgentConfigForUrl(safeUrl, {
      allowInsecureGovTls: ALLOW_INSECURE_GOV_TLS,
    });

    const startTime = Date.now();
    const response = await axios.get(safeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5,bn-BD;q=0.3',
      },
      timeout: 15000,
      validateStatus: () => true, // Accept all status codes
      ...agentConfig,
    });
    
    const responseTime = Date.now() - startTime;
    const rawHtml = response.data;
    
    // Generate SHA-256 checksum of the raw HTML content
    const contentChecksum = crypto.createHash('sha256').update(rawHtml).digest('hex');
    
    // Generate MD5 checksum (alternative)
    const contentMd5 = crypto.createHash('md5').update(rawHtml).digest('hex');
    
    // Capture important HTTP headers for legal proof
    const proofHeaders = {
      server: response.headers['server'] || 'Unknown',
      date: response.headers['date'] || new Date().toUTCString(),
      lastModified: response.headers['last-modified'] || null,
      etag: response.headers['etag'] || null,
      contentType: response.headers['content-type'] || 'text/html',
      contentLength: response.headers['content-length'] || rawHtml.length,
      cacheControl: response.headers['cache-control'] || null,
      xPoweredBy: response.headers['x-powered-by'] || null,
      cfRay: response.headers['cf-ray'] || null, // Cloudflare ray ID
      xRequestId: response.headers['x-request-id'] || null,
    };
    
    // Store first 5000 characters of raw HTML as evidence
    const rawHtmlSnippet = rawHtml.substring(0, 5000);
    
    // Generate unique proof ID
    const proofId = crypto.randomBytes(16).toString('hex');
    
    // ENHANCED LEGAL PROOF - Maximum authenticity data to prevent denial
    const urlObject = new URL(safeUrl);
    const domain = urlObject.hostname;
    const rawServerIp = response.request?.socket?.remoteAddress || 'Unknown';
    const normalizedServerIp = normalizeIpAddressForGeo(rawServerIp) || rawServerIp;
    const serverLocation = await resolveServerIpLocation(normalizedServerIp);
    const validityScore = Math.max(0, Math.min(100,
      (response.status >= 200 && response.status < 500 ? 25 : 0)
      + (contentChecksum ? 20 : 0)
      + (contentMd5 ? 10 : 0)
      + (proofHeaders.etag ? 8 : 0)
      + (proofHeaders.lastModified ? 8 : 0)
      + (normalizedServerIp && normalizedServerIp !== 'Unknown' ? 12 : 0)
      + (serverLocation?.status === 'ok' ? 17 : 8)
    ));
    
    const legalProof = {
      proofId: proofId,
      timestamp: new Date().toISOString(),
      captureTimeUtc: new Date().toUTCString(),
      captureTimeLocal: new Date().toLocaleString('en-BD', { timeZone: 'Asia/Dhaka' }),
      captureDate: new Date().toLocaleDateString('en-GB'),
      captureTime: new Date().toLocaleTimeString('en-GB', { hour12: false }),
      unixTimestamp: Math.floor(Date.now() / 1000),
      url: safeUrl,
      domain: domain,
      urlHash: crypto.createHash('sha256').update(safeUrl).digest('hex'),
      responseStatus: response.status,
      responseStatusText: response.statusText || 'OK',
      responseTime: `${responseTime}ms`,
      checksums: {
        sha256: contentChecksum,
        md5: contentMd5,
        sha512: crypto.createHash('sha512').update(rawHtml).digest('hex'),
      },
      httpHeaders: proofHeaders,
      allResponseHeaders: response.headers,
      requestHeaders: response.config?.headers || {},
      contentSize: rawHtml.length,
      contentSizeKb: (rawHtml.length / 1024).toFixed(2) + ' KB',
      contentSizeMb: (rawHtml.length / 1024 / 1024).toFixed(2) + ' MB',
      rawHtmlSnippet: rawHtmlSnippet,
      rawHtmlBase64: Buffer.from(rawHtml.substring(0, 10000)).toString('base64'),
      fullHtmlHash: crypto.createHash('sha256').update(rawHtml).digest('hex'),
      serverIp: normalizedServerIp || 'Unknown',
      serverIpRaw: rawServerIp,
      serverPort: response.request?.socket?.remotePort || 443,
      serverLocation,
      protocol: url.startsWith('https') ? 'HTTPS/TLS' : 'HTTP',
      tlsVersion: response.request?.socket?.getProtocol?.() || 'TLS 1.2/1.3',
      extractionMethod: 'direct_http_capture',
      verificationScore: validityScore,
      newsValidity: {
        denialResistance: validityScore >= 80 ? 'high' : (validityScore >= 60 ? 'medium' : 'low'),
        sourceReachable: response.status >= 200 && response.status < 500,
        cryptographicIntegrity: Boolean(contentChecksum && contentMd5),
        timestampedCapture: true,
        serverFingerprintAvailable: Boolean(normalizedServerIp && normalizedServerIp !== 'Unknown'),
        score: validityScore,
      },
      waybackMachineUrl: `https://web.archive.org/web/${new Date().toISOString().split('T')[0].replace(/-/g, '')}/${safeUrl}`,
      internetArchiveNote: 'This URL can be verified on Internet Archive Wayback Machine',
      verificationNote: 'This data serves as cryptographic proof of content existence at the time of capture. The SHA-256 checksum can be used to verify content integrity. Even if the original article is deleted, this proof demonstrates it existed.',
      legalNote: 'This capture includes multiple hash checksums (SHA-256, MD5, SHA-512), full HTTP headers, server response data, and timestamp information that can be used as legal evidence.',
      howToVerify: [
        '1. Compare SHA-256 hash with original content',
        '2. Check Wayback Machine for historical snapshots',
        '3. Verify HTTP headers and server response',
        '4. Cross-reference timestamp with other sources',
        '5. Use base64 content for partial verification'
      ],
    };
    
    console.log(`? Legal proof captured - SHA256: ${contentChecksum.substring(0, 16)}...`);
    return legalProof;
    
  } catch (error) {
    console.error('? Failed to capture legal proof:', error.message);
    return {
      proofId: crypto.randomBytes(16).toString('hex'),
      timestamp: new Date().toISOString(),
      url: (url || '').toString(),
      error: error.message,
      checksums: { sha256: null, md5: null },
      verificationNote: 'Proof capture failed - content may still be valid',
    };
  }
}

function normalizeGovInfoOfficerUrl(inputUrl) {
  if (!inputUrl || typeof inputUrl !== 'string') return '';
  const raw = inputUrl.trim();
  if (!/^https?:\/\//i.test(raw)) return '';

  try {
    const parsed = new URL(raw);
    const host = (parsed.hostname || '').toLowerCase();
    const pathName = parsed.pathname || '/';
    const hasOnlyRootPath = pathName === '/' || pathName === '';
    const hasNoQueryOrHash = !parsed.search && !parsed.hash;

    // If it's a bare *.gov.bd root URL, auto-target the common officer endpoint.
    if (host.endsWith('.gov.bd') && hasOnlyRootPath && hasNoQueryOrHash) {
      parsed.pathname = '/views/info-officers';
    }

    return parsed.toString();
  } catch {
    return raw;
  }
}

function getWebsiteLinkFromRecord(record) {

  if (!record || typeof record !== 'object') return '';
  const directKeys = [
    'website',
    'website_link',
    'websiteLink',
    'Website_Link',
    'Website Link',
    'source_url',
    'verifyUrl',
    'gov_url',
    'govSite',
    'url',
  ];
  for (const key of directKeys) {
    const value = record[key];
    if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) {
      return normalizeGovInfoOfficerUrl(value);
    }
  }

  // Fallback: scan for any URL-like field
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) {
      return normalizeGovInfoOfficerUrl(value);
    }
  }
  return '';
}

function toNormalizedOfficerRecord(record, photoUrl = '') {
  const ministry = record.ministry || record.Ministry || '';
  const department = record.department || record.Department || '';
  // Canonical Primary_*/Alternate_* fields are what the live scrape/enrichment pipeline
  // actually writes to. The lowercase duty_officer* fields are a one-time snapshot taken
  // when the record was first loaded from CSV (see contactLoader.js) and are never updated
  // afterward — checking them first would silently discard any fresher scraped data.
  const primaryOfficer = record.Primary_Officer || record.duty_officer || record['Duty Officer'] || record.name || '';
  // record.email / record.phone are OFFICE-level conveniences: contactLoader fills them with the primary's value
  // "|| the alternate's". Using them as a Primary_* fallback therefore re-attributes the ALTERNATE's e-mail and
  // mobile to the primary role on any office that publishes no primary officer (lawjusticediv.gov.bd). A role's
  // contact details may only come from that role's own fields.
  const primaryMobile = record.Primary_Mobile || record.duty_officer_mobile || record.Mobile || '';
  const primaryEmail = record.Primary_Email || record.duty_officer_email || record['E-mail'] || '';
  const alternateOfficer = record.Alternate_Officer || record.alternate_duty_officer || record['Alternate Duty Officer'] || '';
  const alternateDesignation = record.Alternate_Designation || record.alternate_designation || record.Designation || '';
  const alternateMobile = record.Alternate_Mobile || record.alternate_mobile || record['Alternate Mobile'] || '';
  const alternateEmail = record.Alternate_Email || record.alternate_email || record['Alternate E-mail'] || '';
  const appellateOfficer = record.Appellate_Officer || record.Appellate_Name || '';
  const websiteLink = getWebsiteLinkFromRecord(record);

  const normalizeEmail = (v) => (v || '').toString().replace(/\s+/g, '').trim();
  const normalizePhone = (v) => (v || '').toString().replace(/\s+/g, ' ').trim();

  return {
    ...record,
    Ministry: ministry,
    Department: department,
    Primary_Officer: primaryOfficer,
    Primary_Designation: record.Primary_Designation || record.designation || record.Designation || '',
    Primary_Phone: record.Primary_Phone || '',
    Primary_Address: record.Primary_Address || '',
    Primary_Mobile: normalizePhone(primaryMobile),
    Primary_Email: normalizeEmail(primaryEmail),
    Alternate_Officer: alternateOfficer,
    Alternate_Designation: alternateDesignation,
    Alternate_Phone: record.Alternate_Phone || '',
    Alternate_Address: record.Alternate_Address || '',
    Alternate_Mobile: normalizePhone(alternateMobile),
    Alternate_Email: normalizeEmail(alternateEmail),
    Primary_Photo: record.Primary_Photo || record.Primary_Image_URL || photoUrl || '',
    Alternate_Photo: record.Alternate_Photo || record.Alternate_Image_URL || '',
    Appellate_Officer: appellateOfficer,
    Appellate_Name: appellateOfficer,
    Appellate_Designation: record.Appellate_Designation || '',
    Appellate_Phone: record.Appellate_Phone || '',
    Appellate_Mobile: record.Appellate_Mobile || '',
    Appellate_Email: record.Appellate_Email || '',
    Appellate_Address: record.Appellate_Address || '',
    Appellate_Photo: record.Appellate_Photo || record.Appellate_Image_URL || '',
    Discovered_Office_Links: record.Discovered_Office_Links || [],
    Website_Link: record.Website_Link || record.website_link || record['Website Link'] || websiteLink,
    website_link: record.website_link || record['Website Link'] || record.Website_Link || websiteLink,
    office_name: record.office_name || [ministry, department].filter(Boolean).join(' - ') || ministry || department,
    photo: record.photo || record.image || record.image_url || photoUrl,
  };
}

function hasMissingOfficerRoleInfo(record = {}) {
  if (!record || typeof record !== 'object') return true;

  const hasValue = (...keys) => keys.some((k) => ((record[k] || '').toString().trim().length > 0));

  const primaryMissing = !(
    hasValue('Primary_Officer', 'duty_officer', 'name', 'Duty Officer') &&
    hasValue('Primary_Email', 'duty_officer_email', 'E-mail', 'email')
  );
  const alternateMissing = !(
    hasValue('Alternate_Officer', 'alternate_duty_officer', 'Alternate Duty Officer') &&
    hasValue('Alternate_Email', 'alternate_email', 'Alternate E-mail')
  );
  const appellateMissing = !(
    hasValue('Appellate_Officer', 'Appellate_Name') &&
    hasValue('Appellate_Email')
  );

  return primaryMissing || alternateMissing || appellateMissing;
}

function getOfficerRoleFoundStatus(record = {}) {
  if (!record || typeof record !== 'object') {
    return {
      primary_found: false,
      alternate_found: false,
      appellate_found: false,
    };
  }

  const hasValue = (...keys) => keys.some((k) => ((record[k] || '').toString().trim().length > 0));

  return {
    primary_found: hasValue('Primary_Officer', 'duty_officer', 'name', 'Duty Officer'),
    alternate_found: hasValue('Alternate_Officer', 'alternate_duty_officer', 'Alternate Duty Officer'),
    appellate_found: hasValue('Appellate_Officer', 'Appellate_Name'),
  };
}

async function enrichMissingOfficerPhotos(record = {}, websiteLink = '', discoveredLinks = []) {
  if (!record || typeof record !== 'object') return record;

  const next = { ...record };
  const roleOfficerKeys = {
    Primary_Photo: ['Primary_Officer', 'Primary_Officer_Name'],
    Alternate_Photo: ['Alternate_Officer', 'Alternate_Officer_Name'],
    Appellate_Photo: ['Appellate_Officer', 'Appellate_Name', 'Appellate_Officer_Name'],
  };
  const roleHasOfficer = (photoKey) => roleOfficerKeys[photoKey]
    .some((nameKey) => (next[nameKey] || '').toString().trim().length > 0);

  // Only ever assign a photo to a role that actually has a named officer —
  // an empty Appellate slot must stay blank, never inherit another role's face.
  const roleKeys = ['Primary_Photo', 'Alternate_Photo', 'Appellate_Photo'].filter(roleHasOfficer);

  // Clear photos on roles with no officer so a stale/duplicated photo never lingers.
  // Also clear the raw *_Image_URL twin — toNormalizedOfficerRecord falls back to it,
  // so leaving it set would let an orphan photo resurface after this function runs.
  const photoToImageUrlKey = {
    Primary_Photo: 'Primary_Image_URL',
    Alternate_Photo: 'Alternate_Image_URL',
    Appellate_Photo: 'Appellate_Image_URL',
  };
  for (const photoKey of Object.keys(roleOfficerKeys)) {
    if (!roleHasOfficer(photoKey)) {
      next[photoKey] = '';
      next[photoToImageUrlKey[photoKey]] = '';
    }
  }

  if (roleKeys.length === 0) return next;

  // Rule R3: a missing role photo stays missing. Images are never taken from the page by position or "next unused
  // image" to fill a role; the same photo on two roles is removed from both (it cannot belong to two people).
  const seen = {};
  for (const k of roleKeys) {
    const v = (next[k] || '').toString().trim();
    if (v) seen[v] = (seen[v] || 0) + 1;
  }
  for (const k of roleKeys) {
    const v = (next[k] || '').toString().trim();
    if (v && seen[v] > 1) {
      next[k] = '';
      next[photoToImageUrlKey[k]] = '';
    }
  }
  return next;
}

/**
 * searchWebForOffice � Web search fallback when org is not in local database.
 * Searches Google for the office name + RTI keywords to find .gov.bd pages,
 * then constructs an initial record from the discovered website.
 */
async function searchWebForOffice(officeName) {
  if (!officeName || typeof officeName !== 'string') return null;
  try {
    // User-requested query style: "{ORG} RTI Information officers Bangladesh".
    // Use DuckDuckGo HTML (more scrape-friendly than Google).
    const queries = [
      `${officeName} RTI Information officers Bangladesh`,
      `${officeName} RTI officer Bangladesh site:gov.bd`,
    ];

    let foundUrl = null;
    let foundTitle = '';

    for (const q of queries) {
      if (foundUrl) break;
      try {
        const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
        const resp = await axiosGetWith5xxRetry(searchUrl, {
          timeout: 14000,
          headers: getStealthHeaders({
            'Accept-Language': 'bn,en;q=0.9',
          }, searchUrl),
        });

        const $ = cheerio.load(resp.data || '');
        const results = [];
        $('.result__a, a.result__a').each((_, a) => {
          const href = $(a).attr('href');
          const title = ($(a).text() || '').trim();
          if (href && /^https?:\/\//i.test(href)) results.push({ href, title });
        });

        const preferred =
          results.find(r => /\.gov\.bd\b/i.test(r.href))
          || results.find(r => /rti|information|officer/i.test(`${r.title} ${r.href}`))
          || results[0];

        if (preferred?.href) {
          foundUrl = preferred.href;
          foundTitle = preferred.title || '';
        }
      } catch (_) { /* try next query */ }
    }

    if (!foundUrl) return null;
    foundUrl = normalizeGovInfoOfficerUrl(foundUrl) || foundUrl;

    // Construct a basic record from the web discovery
    return {
      office_name: foundTitle || officeName,
      Ministry: '',
      Department: '',
      Primary_Officer: '',
      Primary_Designation: '',
      Primary_Phone: '',
      Primary_Mobile: '',
      Primary_Email: '',
      Primary_Address: '',
      Alternate_Officer: '',
      Alternate_Designation: '',
      Alternate_Mobile: '',
      Alternate_Email: '',
      Website_Link: foundUrl,
      website_link: foundUrl,
    };
  } catch (err) {
    console.warn('?? searchWebForOffice error:', err.message);
    return null;
  }
}

function normalizeForMatch(value) {
  return (value || '')
    .toString()
    .normalize('NFC')
    .toLowerCase()
    .replace(/\u09af\u09bc/g, '\u09df')
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\-]+/g, ' - ')
    .replace(/[\u200b\u200c\u200d]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function extractProfileImageFromWebsite(url) {
  if (!url) return '';
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8'
      },
      timeout: 10000,
      maxRedirects: 3,
    });

    const $ = cheerio.load(response.data);

    const ogImage = $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('meta[property="og:image:secure_url"]').attr('content') || '';

    if (ogImage) {
      return ogImage.startsWith('http') ? ogImage : new URL(ogImage, url).href;
    }

    // Try to find a reasonable profile/ID image
    const imgCandidates = [];
    $('img').each((_, img) => {
      const src = $(img).attr('src') || $(img).attr('data-src') || '';
      const alt = ($(img).attr('alt') || '').toLowerCase();
      if (!src) return;
      const normalizedSrc = src.startsWith('http') ? src : new URL(src, url).href;
      const isLikelyProfile = /(photo|profile|officer|card|id|portrait)/i.test(normalizedSrc) ||
        /(photo|profile|officer|card|id|portrait)/i.test(alt);
      if (isLikelyProfile) imgCandidates.push(normalizedSrc);
    });

    if (imgCandidates.length > 0) return imgCandidates[0];

    // Final fallback: first non-logo image
    const firstImage = $('img').map((_, img) => $(img).attr('src') || $(img).attr('data-src') || '').get()
      .find(src => src && !/logo|icon/i.test(src));
    if (firstImage) {
      return firstImage.startsWith('http') ? firstImage : new URL(firstImage, url).href;
    }
  } catch (error) {
    console.warn('?? Failed to extract profile image:', error.message);
  }
  return '';
}

/**
 * Helper function to download image and save to shared folder
 */
async function downloadImage(imageUrl, originalUrl) {
  try {
    let hostname = '';
    try { hostname = new URL(imageUrl).hostname.toLowerCase(); } catch {}
    const isGovBd = hostname.endsWith('.gov.bd') || hostname.endsWith('.portal.gov.bd');

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': originalUrl || undefined,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
      ...(isGovBd ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) } : {}),
    });
    
    // Generate unique filename
    const hash = crypto.createHash('md5').update(imageUrl).digest('hex');
    const extFromUrl = path.extname(imageUrl).split('?')[0];
    const contentType = (response.headers?.['content-type'] || '').toLowerCase();
    const ext = extFromUrl || (contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : contentType.includes('gif') ? '.gif' : '.jpg');
    const filename = `${hash}${ext}`;
    
    // Save to shared/image data from link folder
    const savePath = path.join(__dirname, '../../shared/image data from link', filename);
    await fs.mkdir(path.dirname(savePath), { recursive: true });
    await fs.writeFile(savePath, response.data);
    
    console.log(`? Downloaded image: ${filename}`);
    return {
      originalUrl: imageUrl,
      savedPath: `/shared/image data from link/${filename}`,
      filename: filename
    };
  } catch (error) {
    console.error(`? Failed to download image ${imageUrl}:`, error.message);
    return null;
  }
}

/**
 * Persist primary/alternate/appellate photos locally in shared folder.
 * Returns same record with updated *_Photo fields pointing to local saved paths when available.
 */
async function persistOfficerPhotosLocally(record = {}) {
  if (!record || typeof record !== 'object') return record;

  const next = { ...record };
  const rolePhotoKeys = ['Primary_Photo', 'Alternate_Photo', 'Appellate_Photo'];

  const imageUrlKey = { Primary_Photo: 'Primary_Image_URL', Alternate_Photo: 'Alternate_Image_URL', Appellate_Photo: 'Appellate_Image_URL' };
  const seenLocal = new Set();

  for (const key of rolePhotoKeys) {
    // The role-specific *_Image_URL is canonical; a mismatched local *_Photo (e.g. another role's) must not win.
    const roleUrl = (next[imageUrlKey[key]] || '').toString().trim();
    let src = (next[key] || '').toString().trim();
    if (/^https?:\/\//i.test(roleUrl) && (!src || src.startsWith('/shared/'))) src = roleUrl;
    if (!src) continue;
    // Already a local shared path.
    if (src.startsWith('/shared/')) {
      if (seenLocal.has(src)) next[key] = '';
      else seenLocal.add(src);
      continue;
    }
    // Only persist valid remote URLs.
    if (!/^https?:\/\//i.test(src)) continue;

    try {
      const verdict = await officerUrlGuard.check(src, { kind: 'image' });
      if (!verdict.ok) { next[key] = ''; continue; }
      const saved = await downloadImage(src, next.Website_Link || next.website_link || '');
      if (saved?.savedPath) {
        next[key] = saved.savedPath;
        seenLocal.add(saved.savedPath);
      }
    } catch (_) {
      // Keep remote URL on failure.
    }
  }

  await syncOfficerPhotoFolder(next);

  // Keep legacy top-level photo aligned with primary photo.
  if (next.Primary_Photo) {
    next.photo = next.Primary_Photo;
  }

  return next;
}

const OFFICER_PHOTO_DIR = path.join(__dirname, '..', '..', 'shared', 'officer_photos');
const officerPhotoSlug = (s) => (s || '').toString().replace(/[\\/:*?"<>|,\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);

// shared/officer_photos/<office>/<role>.<ext> is the source of truth: use it when present,
// otherwise store the role's extracted photo there so the next lookup finds it.
async function syncOfficerPhotoFolder(record) {
  const office = record.Office || record.office_name || record.Ministry || '';
  const slug = officerPhotoSlug(office);
  if (!slug) return record;
  const dir = path.join(OFFICER_PHOTO_DIR, slug);
  let existing = [];
  try { existing = await fs.readdir(dir); } catch { existing = []; }

  const roles = [
    ['primary', 'Primary_Photo', ['Primary_Officer', 'Primary_Officer_Name']],
    ['alternate', 'Alternate_Photo', ['Alternate_Officer', 'Alternate_Officer_Name']],
    ['appellate', 'Appellate_Photo', ['Appellate_Officer', 'Appellate_Name', 'Appellate_Officer_Name']],
  ];
  const imageUrlKey = { primary: 'Primary_Image_URL', alternate: 'Alternate_Image_URL', appellate: 'Appellate_Image_URL' };
  for (const [role, key, nameKeys] of roles) {
    if (!nameKeys.some((k) => (record[k] || '').toString().trim())) continue;
    // The local copy is only valid for the image it was copied from: <role>.source.txt records that URL, so a changed
    // CSV Image_URL is never shadowed by a stale file, and a role with no Image_URL shows no cached photo (brief 15.8).
    const sourceUrl = (record[imageUrlKey[role]] || '').toString().trim();
    const file = existing.find((f) => f.startsWith(`${role}.`) && !f.endsWith('.source.txt'));
    let recordedSource = '';
    try { recordedSource = (await fs.readFile(path.join(dir, `${role}.source.txt`), 'utf8')).trim(); } catch { recordedSource = ''; }
    const current = (record[key] || '').toString();
    if (current.startsWith('/shared/image data from link/') && sourceUrl) {
      try {
        const src = path.join(__dirname, '..', '..', current.replace(/^\//, ''));
        await fs.mkdir(dir, { recursive: true });
        for (const old of existing.filter((f) => f.startsWith(`${role}.`) && !f.endsWith('.source.txt'))) {
          await fs.unlink(path.join(dir, old)).catch(() => {});
        }
        const fname = `${role}${path.extname(src) || '.jpg'}`;
        await fs.copyFile(src, path.join(dir, fname));
        await fs.writeFile(path.join(dir, `${role}.source.txt`), `${sourceUrl}\n`, 'utf8');
        record[key] = `/shared/officer_photos/${encodeURIComponent(slug)}/${fname}`;
      } catch (_) { /* keep original path */ }
      continue;
    }
    if (file && sourceUrl && recordedSource === sourceUrl) {
      record[key] = `/shared/officer_photos/${encodeURIComponent(slug)}/${encodeURIComponent(file)}`;
      continue;
    }
    if (!sourceUrl && current.startsWith('/shared/officer_photos/')) record[key] = '';
  }
  return record;
}

function normalizeBanglaLabel(label = '') {
  return (label || '')
    .toString()
    .replace(/\s+/g, ' ')
    .replace(/[::]+/g, ':')
    .trim()
    .replace(/\s*:\s*$/g, '');
}

function normalizeBanglaValue(value = '') {
  return (value || '')
    .toString()
    .replace(/[\u200b\u200c\u200d]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactEmailValue(email = '') {
  return (email || '')
    .toString()
    .replace(/\s+/g, '')
    .replace(/,+$/g, '')
    .trim();
}

// Resilient lookup for officer-table rows scraped from .gov.bd "info-officers" pages.
// Matches by label *meaning* (substring against known Bengali labels) rather than an
// exact key string, since different portal templates phrase the same field slightly
// differently (e.g. ইমেইল vs ই-মেইল vs ইমেইল ঠিকানা).
const OFFICER_TABLE_FIELD_PATTERNS = {
  name: /নাম/,
  designation: /পদবি|পদ(?!বি)/,
  phone: /(?<!মো)ফোন|টেলিফোন/,
  mobile: /মোবাইল/,
  email: /ই[- ]?মেইল/,
  address: /ঠিকানা/,
};

function pickOfficerTableField(tableObj, fieldName) {
  if (!tableObj || typeof tableObj !== 'object') return '';
  const pattern = OFFICER_TABLE_FIELD_PATTERNS[fieldName];
  if (!pattern) return '';
  for (const [key, value] of Object.entries(tableObj)) {
    if (pattern.test(key)) return (value || '').toString().trim();
  }
  return '';
}

const OFFICER_IMAGE_EXCLUDE_PATTERNS = [
  'logo', 'icon', 'banner', 'sprite', 'emblem', 'placeholder', 'default', 'no-image', 'noimage',
  'slider', 'carousel', 'cover', 'hero', 'advert', 'ads', 'header', 'footer',
  'facebook', 'twitter', 'youtube', 'share', 'thumb', 'tiny', 'small',
];

const OFFICER_IMAGE_INCLUDE_HINTS = [
  'officer', 'profile', 'photo', 'pic', 'portrait', 'upload', 'staff',
  'কর্মকর্তা', 'ছবি', 'list-card-image', 'duty',
];

function isLikelyOfficerPhotoCandidate(src = '', altOrTitle = '', cssClass = '') {
  const srcNorm = normalizeForMatch(src);
  const textNorm = normalizeForMatch(altOrTitle);
  const classNorm = normalizeForMatch(cssClass);
  if (!srcNorm) return false;

  if (OFFICER_IMAGE_EXCLUDE_PATTERNS.some((p) => srcNorm.includes(p) || textNorm.includes(p) || classNorm.includes(p))) {
    return false;
  }

  const hasStrongHint = OFFICER_IMAGE_INCLUDE_HINTS.some((p) => srcNorm.includes(p) || textNorm.includes(p) || classNorm.includes(p));
  const likelyImagePath = /\.(jpg|jpeg|png|webp|gif|bmp)(\?|$)/i.test(srcNorm) || /\/image|\/photo|\/upload/i.test(srcNorm);

  return hasStrongHint || likelyImagePath;
}

function hasSuspiciousOfficerPhotoSet(photoUrls = []) {
  const urls = (Array.isArray(photoUrls) ? photoUrls : [])
    .map((u) => (u || '').toString().trim())
    .filter(Boolean);

  if (urls.length === 0) return false;

  const unique = new Set(urls);
  if (unique.size < urls.length) return true;

  return urls.some((u) => !isLikelyOfficerPhotoCandidate(u));
}

function extractKeyValueTable($, tableEl) {
  const out = {};
  const $table = $(tableEl);
  $table.find('tr').each((_, tr) => {
    const tds = $(tr).find('td,th');
    if (tds.length < 2) return;
    const key = normalizeBanglaLabel($(tds[0]).text());
    const rawVal = normalizeBanglaValue($(tds[1]).text());
    if (!key) return;
    out[key] = rawVal;
  });
  return out;
}

function resolveImageUrl(baseUrl, src) {
  if (!src) return '';
  const s = src.toString().trim();
  if (!s) return '';
  try {
    return s.startsWith('http') ? s : new URL(s, baseUrl).href;
  } catch {
    return '';
  }
}

function extractRolePhotosFromPortalWidgets($, baseUrl) {
  const rolePhotos = {
    primaryPhoto: '',
    alternatePhoto: '',
    appellatePhoto: '',
  };

  // Only leaf widgets: the outer wrapper contains all three roles and would mislabel the first image.
  const widgets = $('.info-officer-view-widget, .info-officer-view').toArray()
    .filter((el) => $(el).find('.info-officer-view-widget, .list-card-body').length <= (($(el).is('.list-card-body') || $(el).children('.list-card-body').length) ? 1 : 0));
  const orderedImages = [];

  const pickWidgetImage = (widgetEl) => {
    const $widget = $(widgetEl);
    const candidates = $widget.find('img.list-card-image, .image-section img, img').toArray();
    for (const img of candidates) {
      const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-original') || '';
      const altTitle = `${$(img).attr('alt') || ''} ${$(img).attr('title') || ''}`;
      const cssClass = $(img).attr('class') || '';
      if (!isLikelyOfficerPhotoCandidate(src, altTitle, cssClass)) continue;
      const resolved = resolveImageUrl(baseUrl, src);
      if (resolved) return resolved;
    }
    return '';
  };

  for (const widget of widgets) {
    const widgetText = normalizeForMatch($(widget).find('h1,h2,h3,h4,h5,h6,.info-officer-view-widget-heading').first().text() || $(widget).text());
    const img = pickWidgetImage(widget);
    if (!img) continue;

    if (!orderedImages.includes(img)) orderedImages.push(img);

    // Alternate/appellate headings both contain the primary "দায়িত্বপ্রাপ্ত কর্মকর্তা" phrase
    // as a substring, so the more specific checks must run first.
    if (widgetText.includes(normalizeForMatch('বিকল্প'))) {
      if (!rolePhotos.alternatePhoto) rolePhotos.alternatePhoto = img;
      continue;
    }
    if (widgetText.includes(normalizeForMatch('আপীল'))) {
      if (!rolePhotos.appellatePhoto) rolePhotos.appellatePhoto = img;
      continue;
    }
    if (widgetText.includes(normalizeForMatch('দায়িত্বপ্রাপ্ত'))) {
      if (!rolePhotos.primaryPhoto) rolePhotos.primaryPhoto = img;
      continue;
    }
  }

  // No positional fallback (rule R3): a widget whose heading names no role gives its image to no role.

  return rolePhotos;
}

// Caption text with a space between sibling nodes so "<figcaption>A<span>B</span></figcaption>" reads "A B".
function spacedText($node) {
  if (!$node || !$node.length) return '';
  const parts = [];
  $node.contents().each((_, n) => {
    const t = (n.type === 'text' ? n.data : (n.children ? require('cheerio').load('<x></x>', null, false)('x').append(n).text() : '')) || '';
    const c = t.replace(/\s+/g, ' ').trim();
    if (c) parts.push(c);
  });
  return parts.join(' ').trim();
}

// Finds each role's photo by walking up from the role label (or officer name) to the
// smallest ancestor holding an officer-like <img> without also containing another role's label.
function extractRolePhotosByLabel($, baseUrl, names = {}) {
  const ROLE_DEFS = [
    { key: 'alternatePhoto', re: /বিকল্প\s*দায়িত্বপ্রাপ্ত/, name: names.alternate },
    { key: 'appellatePhoto', re: /আপীল|আপিল/, name: names.appellate },
    { key: 'primaryPhoto', re: /দায়িত্বপ্রাপ্ত\s*কর্মকর্তা/, name: names.primary },
  ];
  const roleOf = (text) => {
    for (const d of ROLE_DEFS) if (d.re.test(text)) return d.key;
    return '';
  };
  const out = { primaryPhoto: '', alternatePhoto: '', appellatePhoto: '' };

  const imgIn = ($scope) => {
    for (const img of $scope.find('img').toArray()) {
      const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-original') || '';
      const altTitle = `${$(img).attr('alt') || ''} ${$(img).attr('title') || ''}`;
      if (!isLikelyOfficerPhotoCandidate(src, altTitle, $(img).attr('class') || '')) continue;
      const resolved = resolveImageUrl(baseUrl, src);
      if (resolved) return resolved;
    }
    return '';
  };

  const anchors = [];
  $('h1,h2,h3,h4,h5,h6,strong,b,label,th,td,dt,p,span,div,li').each((_, el) => {
    if ($(el).children().length > 3) return;
    const t = normalizeForMatch($(el).text());
    if (!t || t.length > 80) return;
    const key = roleOf(t);
    if (key) anchors.push({ el, key });
  });

  for (const { el, key } of anchors) {
    if (out[key]) continue;
    let $cur = $(el);
    for (let depth = 0; depth < 6 && $cur.length; depth += 1) {
      const scopeText = normalizeForMatch($cur.text());
      const roles = new Set(ROLE_DEFS.filter((d) => d.re.test(scopeText)).map((d) => d.key));
      // Primary label is a substring of the alternate one, so tolerate that overlap.
      const foreign = [...roles].filter((k) => k !== key && !(key === 'primaryPhoto' && k === 'alternatePhoto'));
      if (foreign.length > 0) break;
      const found = imgIn($cur);
      if (found) { out[key] = found; break; }
      $cur = $cur.parent();
    }
  }

  for (const d of ROLE_DEFS) {
    if (out[d.key] || !d.name) continue;
    const needle = normalizeForMatch(d.name);
    $('img').each((_, img) => {
      if (out[d.key]) return;
      const scopeText = normalizeForMatch($(img).closest('div,li,tr,td,section,article').text());
      if (scopeText.includes(needle) && scopeText.length < 800) {
        const src = $(img).attr('src') || $(img).attr('data-src') || '';
        if (isLikelyOfficerPhotoCandidate(src, `${$(img).attr('alt') || ''}`, $(img).attr('class') || '')) {
          out[d.key] = resolveImageUrl(baseUrl, src);
        }
      }
    });
  }
  return out;
}

function findNearestImage($, headingEl, baseUrl) {
  if (!headingEl) return '';

  // Try within the same parent section
  const $h = $(headingEl);
  const parent = $h.parent();
  const candidates = parent.find('img');
  for (const img of candidates.toArray()) {
    const src = $(img).attr('src') || $(img).attr('data-src') || '';
    const altTitle = `${$(img).attr('alt') || ''} ${$(img).attr('title') || ''}`;
    const cssClass = $(img).attr('class') || '';
    if (!isLikelyOfficerPhotoCandidate(src, altTitle, cssClass)) continue;
    const resolved = resolveImageUrl(baseUrl, src);
    if (resolved) return resolved;
  }

  // Try previous siblings
  let prev = $h.prev();
  for (let i = 0; i < 8 && prev && prev.length; i += 1) {
    const imgs = prev.find('img');
    for (const img of imgs.toArray()) {
      const src = $(img).attr('src') || $(img).attr('data-src') || '';
      const altTitle = `${$(img).attr('alt') || ''} ${$(img).attr('title') || ''}`;
      const cssClass = $(img).attr('class') || '';
      if (!isLikelyOfficerPhotoCandidate(src, altTitle, cssClass)) continue;
      const resolved = resolveImageUrl(baseUrl, src);
      if (resolved) return resolved;
    }
    prev = prev.prev();
  }

  return '';
}

function cleanOfficerName(name = '') {
  return (name || '')
    .toString()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[?-?0-9]+/g, ' ')
    .replace(/[,:;|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectImageCandidates($, baseUrl) {
  const seen = new Set();
  const out = [];
  $('img').each((_, img) => {
    if (out.length >= 30) return;
    const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-original') || '';
    const altTitle = `${$(img).attr('alt') || ''} ${$(img).attr('title') || ''}`;
    const cssClass = $(img).attr('class') || '';
    if (!isLikelyOfficerPhotoCandidate(src, altTitle, cssClass)) return;
    const resolved = resolveImageUrl(baseUrl, src);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);

    const alt = normalizeBanglaValue($(img).attr('alt') || '');
    const title = normalizeBanglaValue($(img).attr('title') || '');
    const parentText = normalizeBanglaValue($(img).closest('tr,td,div,figure,section,article').first().text()).slice(0, 220);
    const context = [alt, title, parentText].filter(Boolean).join(' | ').slice(0, 260);

    out.push({ url: resolved, context });
  });
  return out;
}

function findOfficerImageByName($, baseUrl, officerName, headingEl = null) {
  const cleaned = cleanOfficerName(officerName);
  if (!cleaned) return '';

  const normalizedName = normalizeForMatch(cleaned);
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => normalizeForMatch(t))
    .filter((t) => t && t.length >= 3);

  const pickImageFromScope = ($scope) => {
    if (!$scope || !$scope.length) return '';
    const imgs = $scope.find('img').toArray();
    for (const img of imgs) {
      const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-original') || '';
      const altTitle = `${$(img).attr('alt') || ''} ${$(img).attr('title') || ''}`;
      const cssClass = $(img).attr('class') || '';
      if (!isLikelyOfficerPhotoCandidate(src, altTitle, cssClass)) continue;
      const resolved = resolveImageUrl(baseUrl, src);
      if (resolved) return resolved;
    }
    return '';
  };

  if (headingEl) {
    const byHeading = findNearestImage($, headingEl, baseUrl);
    if (byHeading) return byHeading;
  }

  const textNodes = $('td,th,div,span,p,strong,h4,h5,li').toArray();
  for (const el of textNodes) {
    const text = normalizeForMatch($(el).text());
    if (!text) continue;

    const tokenHits = tokens.reduce((acc, t) => (text.includes(t) ? acc + 1 : acc), 0);
    const strongMatch = text.includes(normalizedName) || tokenHits >= Math.min(2, tokens.length || 0);
    if (!strongMatch) continue;

    const scopes = [
      $(el),
      $(el).closest('tr'),
      $(el).closest('td'),
      $(el).parent(),
      $(el).closest('table'),
      $(el).closest('div'),
      $(el).prev(),
      $(el).next(),
    ];

    for (const scope of scopes) {
      const picked = pickImageFromScope(scope);
      if (picked) return picked;
    }
  }

  // Last pass: match by image alt/title mentioning officer name tokens
  for (const img of $('img').toArray()) {
    const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-original') || '';
    const altTitleRaw = `${$(img).attr('alt') || ''} ${$(img).attr('title') || ''}`;
    const cssClass = $(img).attr('class') || '';
    if (!isLikelyOfficerPhotoCandidate(src, altTitleRaw, cssClass)) continue;
    const resolved = resolveImageUrl(baseUrl, src);
    if (!resolved) continue;
    const altTitle = normalizeForMatch(altTitleRaw);
    if (!altTitle) continue;
    const tokenHits = tokens.reduce((acc, t) => (altTitle.includes(t) ? acc + 1 : acc), 0);
    if (tokenHits >= Math.min(2, tokens.length || 0) || altTitle.includes(normalizedName)) return resolved;
  }

  return '';
}

const INSECURE_TLS_AGENT = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

const SCRAPER_MAX_5XX_RETRIES = parseInt(process.env.SCRAPER_MAX_5XX_RETRIES || '5', 10);
const SCRAPER_RETRY_BASE_DELAY_MS = parseInt(process.env.SCRAPER_RETRY_BASE_DELAY_MS || '2000', 10);
const SCRAPER_RETRY_FACTOR = 2;
const GOV_SCRAPE_TIMEOUT_MS = parseInt(process.env.GOV_SCRAPE_TIMEOUT_MS || '45000', 10);
const DEFAULT_SCRAPE_TIMEOUT_MS = parseInt(process.env.DEFAULT_SCRAPE_TIMEOUT_MS || '15000', 10);

const STEALTH_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isGovBdHostFromUrl(inputUrl = '') {
  try {
    const host = new URL(inputUrl).hostname.toLowerCase();
    return host.endsWith('.gov.bd') || host.endsWith('.portal.gov.bd') || host === 'bangladesh.gov.bd';
  } catch {
    return false;
  }
}

function pickStealthUserAgent() {
  if (!Array.isArray(STEALTH_USER_AGENTS) || STEALTH_USER_AGENTS.length === 0) {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  }
  const idx = Math.floor(Math.random() * STEALTH_USER_AGENTS.length);
  return STEALTH_USER_AGENTS[idx];
}

function getStealthHeaders(extraHeaders = {}, targetUrl = '') {
  let host = '';
  try { host = new URL(targetUrl).hostname; } catch { host = ''; }

  return {
    'User-Agent': pickStealthUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'bn-BD,bn;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    ...(host ? { Referer: `https://${host}/` } : {}),
    ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {}),
  };
}

function buildOfficerSlots(record = {}) {
  const hasValue = (...keys) => keys.some((k) => ((record?.[k] || '').toString().trim().length > 0));
  return {
    primary: {
      found: hasValue('Primary_Officer', 'duty_officer', 'name', 'Duty Officer'),
    },
    alternate: {
      found: hasValue('Alternate_Officer', 'alternate_duty_officer', 'Alternate Duty Officer'),
    },
    appellate: {
      found: hasValue('Appellate_Officer', 'Appellate_Name'),
    },
  };
}

function isRetryable5xxError(err) {
  const status = Number(err?.response?.status || 0);
  const code = (err?.code || err?.cause?.code || '').toString().toUpperCase();
  const retryableCodes = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNABORTED',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ECONNREFUSED',
  ]);
  return (status >= 500 && status <= 599) || retryableCodes.has(code);
}

function isRetryableNetworkError(err) {
  if (isRetryable5xxError(err)) {
    return true;
  }

  const message = (err?.message || '').toString();
  return /(timeout|ssl|tls|cert|socket|network|econn|enotfound|getaddrinfo|handshake)/i.test(message);
}

async function fetchWithRetry(executor, options = {}) {
  const maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : SCRAPER_MAX_5XX_RETRIES;
  const baseDelayMs = Number.isFinite(options.baseDelayMs) ? options.baseDelayMs : SCRAPER_RETRY_BASE_DELAY_MS;
  const factor = Number.isFinite(options.factor) ? options.factor : SCRAPER_RETRY_FACTOR;
  const maxDelayMs = Number.isFinite(options.maxDelayMs) ? options.maxDelayMs : 8000;
  const label = options.label || 'request';

  let retryCount = 0;
  while (true) {
    try {
      return await executor();
    } catch (err) {
      if (!isRetryable5xxError(err) || retryCount >= maxRetries) {
        throw err;
      }

      const status = err?.response?.status;
      const waitMs = Math.min(maxDelayMs, Math.max(0, baseDelayMs * Math.pow(factor, retryCount)));
      retryCount += 1;
      console.warn(`?? HTTP ${status} for ${label} � retry ${retryCount}/${maxRetries} in ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }
}

async function axiosGetWith5xxRetry(url, config = {}, options = {}) {
  return fetchWithRetry(() => axios.get(url, config), {
    ...options,
    label: options.label || url,
  });
}

async function axiosGetWithGovTlsFallback(url, config) {
  const isGovSite = isGovBdHostFromUrl(url);
  const { httpAgent, httpsAgent } = getAxiosAgentConfigForUrl(url, {
    allowInsecureGovTls: ALLOW_INSECURE_GOV_TLS,
  });

  const hardenedConfig = {
    ...(config || {}),
    headers: getStealthHeaders(config?.headers || {}, url),
    timeout: Number.isFinite(config?.timeout)
      ? config.timeout
      : (isGovSite ? GOV_SCRAPE_TIMEOUT_MS : DEFAULT_SCRAPE_TIMEOUT_MS),
    httpAgent,
    httpsAgent,
  };

  try {
    return await axiosGetWith5xxRetry(url, hardenedConfig);
  } catch (err) {
    const code = err?.code || err?.cause?.code;
    const shouldRetry = (
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      code === 'UNABLE_TO_VERIFY_FIRST_CERTIFICATE' ||
      code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      code === 'SELF_SIGNED_CERT_IN_CHAIN'
    );
    let host = '';
    try { host = new URL(url).hostname; } catch { host = ''; }
    const isGov = (host || '').toLowerCase().endsWith('.gov.bd') || (host || '').toLowerCase().endsWith('.portal.gov.bd') || (host || '').toLowerCase() === 'bangladesh.gov.bd';
    if (!shouldRetry || !isGov || !ALLOW_INSECURE_GOV_TLS) throw err;

    console.warn(`?? TLS chain issue for ${host}; retrying with insecure agent`);
    return await axiosGetWith5xxRetry(url, {
      ...hardenedConfig,
      httpAgent,
      httpsAgent: INSECURE_TLS_AGENT,
    });
  }
}

async function scrapeInfoOfficersPage(url, options = {}) {
  if (!url) return null;
  url = normalizeGovInfoOfficerUrl(url) || url;
  const llmProvider = geminiAnalysis.normalizeLlmProvider(options?.llmProvider || 'auto');
  const requestTimeout = isGovBdHostFromUrl(url) ? GOV_SCRAPE_TIMEOUT_MS : 15000;

  const findWideOfficerLink = async (targetUrl) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return '';
    }

    const rootUrl = `${parsed.protocol}//${parsed.host}/`;
    try {
      const resp = await officerUrlGuard.getWithRedirects(rootUrl, axiosGetWithGovTlsFallback, {
        headers: getStealthHeaders({}, rootUrl),
        timeout: requestTimeout,
      });

      const $home = cheerio.load(resp.data || '');
      const candidates = [];
      $home('a[href]').each((_, a) => {
        const href = ($home(a).attr('href') || '').trim();
        const label = normalizeForMatch($home(a).text() || '');
        if (!href) return;

        const resolved = resolveImageUrl(rootUrl, href);
        if (!resolved) return;

        const hay = `${normalizeForMatch(resolved)} ${label}`;
        if (!/(info[-_\s]?officers|information_officers|rti)/i.test(hay)) return;
        candidates.push(resolved);
      });

      const preferred =
        candidates.find((u) => /\/views\/info-officers/i.test(u))
        || candidates.find((u) => /information_officers/i.test(u))
        || candidates[0]
        || '';

      return normalizeGovInfoOfficerUrl(preferred) || preferred;
    } catch {
      return '';
    }
  };

  let response;
  try {
    response = await officerUrlGuard.getWithRedirects(url, axiosGetWithGovTlsFallback, {
      headers: getStealthHeaders({}, url),
      timeout: requestTimeout,
    });
  } catch (primaryErr) {
    if (primaryErr?.code === 'EOFFICERGUARD') throw primaryErr;
    const discovered = await findWideOfficerLink(url);
    if (!discovered || discovered === url) {
      throw primaryErr;
    }
    console.warn(`?? [Scraper] Primary info-officers URL failed; retrying with discovered link: ${discovered}`);
    url = discovered;
    response = await officerUrlGuard.getWithRedirects(url, axiosGetWithGovTlsFallback, {
      headers: getStealthHeaders({}, url),
      timeout: requestTimeout,
    });
  }

  const html = response.data;
  const $ = cheerio.load(html);
  // Legacy-font (Bijoy/SutonnyMJ) text is not readable data; the page is reported, never parsed into values (R11).
  const legacyFontPage = $('font[face], [style*="font-family"]').toArray().some((el) => {
    const face = $(el).attr('face') || ((($(el).attr('style') || '').match(/font-family\s*:\s*([^;]+)/i) || [])[1]) || '';
    return textIntegrity.isLegacyFont(face) && $(el).text().trim().length > 0;
  });

  const title = normalizeBanglaValue($('h1').first().text()) || normalizeBanglaValue($('title').text());

  // Headings in LGD/National Portal style pages. See utils/roleHeadings.js (findRoleHeadingElement) for why a
  // plain substring search cannot be trusted alone -- it is still the search used here, just validated against
  // spec 6.2's role classification before a match is accepted.
  const primaryHeading = findRoleHeadingElement($, 'দায়িত্বপ্রাপ্ত কর্মকর্তা', 'primary');
  const alternateHeading = findRoleHeadingElement($, 'বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা', 'alternate');
  const appellateHeading = findRoleHeadingElement($, 'আপীল কর্তৃপক্ষ', 'appellate');

  const findNextTable = (headingEl) => {
    if (!headingEl) return null;
    const $h = $(headingEl);
    const tbl = $h.nextAll('table').first();
    if (tbl && tbl.length) return tbl.get(0);
    // Some portal pages wrap tables inside divs after the heading.
    const nested = $h.nextAll().find('table').first();
    if (nested && nested.length) return nested.get(0);
    return null;
  };

  const primaryTable = findNextTable(primaryHeading);
  const alternateTable = findNextTable(alternateHeading);
  const appellateTable = findNextTable(appellateHeading);

  let primary = primaryTable ? extractKeyValueTable($, primaryTable) : {};
  let alternate = alternateTable ? extractKeyValueTable($, alternateTable) : {};
  let appellate = appellateTable ? extractKeyValueTable($, appellateTable) : {};
  let llmProviderUsed = '';
  let llmReasoningDetails = null;

  // If manual table extraction fails, fallback to Gemini to extract all 3 officers from raw text
  if (!pickOfficerTableField(primary, 'name') && !pickOfficerTableField(alternate, 'name') && !pickOfficerTableField(appellate, 'name')) {
    try {
      console.log(`?? [Scraper] Structural table parse failed for ${url}. Falling back to Gemini extraction...`);
      $('style, script, nav, footer, aside, meta, link, noscript').remove();
      const rawText = $('body').text().replace(/\s+/g, ' ').trim();
      const geminiData = await geminiAnalysis.extractContactFromText(rawText, { llmProvider });
      if (geminiData) {
        llmProviderUsed = geminiData?._llm?.provider_used || llmProviderUsed;
        llmReasoningDetails = geminiData?._llm?.reasoning_details || llmReasoningDetails;
        // The model is a parser, never a source (rules R1/R2): a role is kept only if the page itself names that role,
        // and only values that appear verbatim in the page text survive. A "focal point" is not a designated officer.
        const pageText = normalizeForMatch(rawText);
        // Which roles the page claims. This stays a page-wide text test on purpose: on the national-portal widget
        // template (Template A) the officer cards carry no textual role heading at all, and this flag is the only
        // thing that lets a genuine primary officer through. It is deliberately permissive; the binding guarantee
        // that a role's values are really that role's comes from the structural pass (findRoleHeadingElement) and from
        // the name-gating in applyScrapedOfficers, not from here.
        const roleOnPage = {
          primary: /দায়িত্বপ্রাপ্ত\s*কর্মকর্তা|তথ্য\s*প্রদানকারী\s*কর্মকর্তা/.test(rawText),
          alternate: /বিকল্প/.test(rawText),
          appellate: /আপ[ীি]ল\s*কর্তৃপক্ষ/.test(rawText),
        };
        const grounded = (obj) => {
          const out = {};
          for (const [k, v] of Object.entries(obj || {})) {
            const val = (v == null ? '' : String(v)).trim();
            if (val && pageText.includes(normalizeForMatch(val))) out[k] = val;
          }
          return out;
        };
        for (const role of ['primary', 'alternate', 'appellate']) {
          const kept = roleOnPage[role] ? grounded(geminiData[role]) : {};
          if (!pickOfficerTableField(kept, 'name')) continue;
          if (role === 'primary') primary = kept;
          if (role === 'alternate') alternate = kept;
          if (role === 'appellate') appellate = kept;
        }
      }
    } catch(e) {
      console.warn('?? Gemini fallback text extraction failed:', e.message);
    }
  }

  // Attempt to resolve emails that are shown with spaces like "director1 @lgd.gov.bd"
  for (const obj of [primary, alternate, appellate]) {
    for (const k of Object.keys(obj)) {
      if (OFFICER_TABLE_FIELD_PATTERNS.email.test(k)) {
        obj[k] = compactEmailValue(obj[k]);
      }
    }
  }

  const primaryName = normalizeBanglaValue(pickOfficerTableField(primary, 'name'));
  const alternateName = normalizeBanglaValue(pickOfficerTableField(alternate, 'name'));
  const appellateName = normalizeBanglaValue(pickOfficerTableField(appellate, 'name'));

  const rolePhotosFromWidgets = extractRolePhotosFromPortalWidgets($, url);

  const rolePhotosByLabel = extractRolePhotosByLabel($, url, { primary: primaryName, alternate: alternateName, appellate: appellateName });

  // The page's own role blocks decide first; a label/name fallback may never take a photo that another role's block
  // already holds, and two roles never share one photo (rule R3).
  const usedPhotos = new Set([rolePhotosFromWidgets.primaryPhoto, rolePhotosFromWidgets.alternatePhoto,
    rolePhotosFromWidgets.appellatePhoto].filter(Boolean));
  const pickRolePhoto = (widgetPhoto, ...fallbacks) => {
    if (widgetPhoto) return widgetPhoto;
    const found = fallbacks.find((u) => u && !usedPhotos.has(u)) || '';
    if (found) usedPhotos.add(found);
    return found;
  };
  let primaryPhoto = pickRolePhoto(rolePhotosFromWidgets.primaryPhoto, rolePhotosByLabel.primaryPhoto, findOfficerImageByName($, url, primaryName, primaryHeading));
  let alternatePhoto = pickRolePhoto(rolePhotosFromWidgets.alternatePhoto, rolePhotosByLabel.alternatePhoto, findOfficerImageByName($, url, alternateName, alternateHeading));
  let appellatePhoto = pickRolePhoto(rolePhotosFromWidgets.appellatePhoto, rolePhotosByLabel.appellatePhoto, findOfficerImageByName($, url, appellateName, appellateHeading));

  const shouldRunSemanticImageMapping = Boolean(primaryName || alternateName || appellateName)
    && (!primaryPhoto || !alternatePhoto || !appellatePhoto || hasSuspiciousOfficerPhotoSet([primaryPhoto, alternatePhoto, appellatePhoto]));

  // Optional semantic fallback if one or more images are unresolved or clearly suspicious (duplicate/icon-like).
  if (shouldRunSemanticImageMapping) {
    try {
      const candidates = collectImageCandidates($, url);
      if (candidates.length > 0) {
        const mapped = await geminiAnalysis.mapOfficerImagesFromCandidates({
          pageUrl: url,
          primaryName,
          alternateName,
          appellateName,
          candidates,
        }, {
          llmProvider,
        });
        llmProviderUsed = mapped?._llm_provider_used || llmProviderUsed;
        llmReasoningDetails = mapped?.reasoning_details || llmReasoningDetails;
        // Rule R3: a model's suggestion is not structural evidence, so it is logged and never assigned.
        if (mapped && (mapped.primaryPhoto || mapped.alternatePhoto || mapped.appellatePhoto)) {
          console.log(`ℹ️ [Scraper] model photo suggestions ignored for ${url} (roles are assigned only from the page's own blocks)`);
        }
      }
    } catch (e) {
      console.warn('?? Gemini image mapping skipped:', e.message);
    }
  }

  // Discover other info-officers links on same site (lightweight)
  const discoveredLinks = new Set();
  $('a[href]').each((_, a) => {
    const href = ($(a).attr('href') || '').trim();
    if (!href) return;
    if (/\/views\/info-officers\//i.test(href) || /\/site\/view\/information_officers\//i.test(href)) {
      const resolved = resolveImageUrl(url, href);
      if (resolved) discoveredLinks.add(resolved);
    }
  });

  return {
    title,
    primary,
    alternate,
    appellate,
    primaryPhoto,
    alternatePhoto,
    appellatePhoto,
    llmProviderUsed,
    llmReasoningDetails,
    discoveredLinks: Array.from(discoveredLinks).slice(0, 30),
    legacyFontPage,
  };
}

function officerNamesLikelySame(a = '', b = '') {
  const left = normalizeForMatch(cleanOfficerName(a));
  const right = normalizeForMatch(cleanOfficerName(b));
  if (!left || !right) return true;
  if (left === right) return true;

  const leftTokens = left.split(/\s+/).filter((t) => t.length >= 2);
  const rightTokens = right.split(/\s+/).filter((t) => t.length >= 2);
  if (leftTokens.length === 0 || rightTokens.length === 0) return true;

  const common = leftTokens.filter((t) => rightTokens.includes(t)).length;
  return common >= Math.min(2, Math.min(leftTokens.length, rightTokens.length));
}

async function enrichFromDiscoveredInfoOfficerLinks(enriched = {}, scraped = null, websiteLink = '', options = {}) {
  if (!enriched || typeof enriched !== 'object' || !scraped) return enriched;

  const links = Array.isArray(scraped.discoveredLinks)
    ? scraped.discoveredLinks.filter((u) => /^https?:\/\//i.test(u) && u !== websiteLink).slice(0, 5)
    : [];

  if (links.length === 0) return enriched;

  const next = { ...enriched };
  const currentPrimaryName = next.Primary_Officer || '';

  for (const discoveredUrl of links) {
    const needsMore = !next.Alternate_Photo || !next.Appellate_Photo || !next.Appellate_Officer || !next.Appellate_Email;
    if (!needsMore) break;

    let candidate = null;
    try {
      candidate = await Promise.race([
        scrapeInfoOfficersPage(discoveredUrl, options),
        new Promise((_, reject) => setTimeout(() => reject(new Error('discover-timeout')), WEBSITE_LINK_MAX_WAIT_MS)),
      ]).catch(() => null);
    } catch {
      candidate = null;
    }

    if (!candidate) continue;

    const candidatePrimaryName = pickOfficerTableField(candidate?.primary, 'name');
    if (!officerNamesLikelySame(currentPrimaryName, candidatePrimaryName)) {
      continue;
    }

    if (!next.Primary_Photo && candidate.primaryPhoto) next.Primary_Photo = candidate.primaryPhoto;
    if (!next.Alternate_Photo && candidate.alternatePhoto) next.Alternate_Photo = candidate.alternatePhoto;
    if (!next.Appellate_Photo && candidate.appellatePhoto) next.Appellate_Photo = candidate.appellatePhoto;

    const cap = candidate.appellate || {};
    const capName = pickOfficerTableField(cap, 'name');
    const capDesignation = pickOfficerTableField(cap, 'designation');
    const capPhone = pickOfficerTableField(cap, 'phone');
    const capMobile = pickOfficerTableField(cap, 'mobile');
    const capEmail = pickOfficerTableField(cap, 'email');
    const capAddress = pickOfficerTableField(cap, 'address');
    if (!next.Appellate_Officer && capName) next.Appellate_Officer = capName;
    if (!next.Appellate_Name && capName) next.Appellate_Name = capName;
    if (!next.Appellate_Designation && capDesignation) next.Appellate_Designation = capDesignation;
    if (!next.Appellate_Phone && capPhone) next.Appellate_Phone = capPhone;
    if (!next.Appellate_Mobile && capMobile) next.Appellate_Mobile = capMobile;
    if (!next.Appellate_Email && capEmail) next.Appellate_Email = capEmail;
    if (!next.Appellate_Address && capAddress) {
      next.Appellate_Address = capAddress;
    }
  }

  return next;
}


function sanitizeArticleHtml(rawHtml, baseUrl = '') {
  if (!rawHtml) return '';

  const $ = cheerio.load(rawHtml, { decodeEntities: false });

  // Attribute escaping helper
  const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Resolve relative URL to absolute
  const toAbs = (v) => {
    const s = (v || '').toString().trim();
    if (!s || s.startsWith('data:') || s.startsWith('#')) return '';
    try { return s.startsWith('http') ? s : new URL(s, baseUrl).href; } catch { return ''; }
  };

  // Get best src from an img element (handles lazy-load attrs and srcset)
  const getBestSrc = ($img) => {
    let src = $img.attr('src') || $img.attr('data-src') || $img.attr('data-lazy-src')
      || $img.attr('data-original') || $img.attr('data-lazy') || '';
    if (!src || src.startsWith('data:')) {
      const srcset = $img.attr('srcset') || $img.attr('data-srcset') || '';
      if (srcset) {
        const parts = srcset.split(',').map(p => p.trim().split(/\s+/)[0]).filter(Boolean);
        src = parts[parts.length - 1] || ''; // largest
      }
    }
    if (!src || src.startsWith('data:')) {
      const $src = $img.closest('picture').find('source').first();
      const ss = $src.attr('srcset') || $src.attr('data-srcset') || '';
      if (ss) src = ss.split(',').map(p => p.trim().split(/\s+/)[0]).filter(Boolean).pop() || '';
    }
    return toAbs(src);
  };

  const isTiny = ($img) => {
    const w = parseInt($img.attr('width') || '0', 10);
    const h = parseInt($img.attr('height') || '0', 10);
    return (w > 0 && w < 60) || (h > 0 && h < 60);
  };

  // Build a <figure> block from any element containing an img
  const makeFigure = ($el) => {
    const $img = $el.is('img') ? $el : $el.find('img').first();
    if (!$img.length || isTiny($img)) return '';
    const src = getBestSrc($img);
    if (!src) return '';
    const alt = esc(($img.attr('alt') || $img.attr('title') || '').trim());
    const srcset = (() => {
      const ss = $img.attr('srcset') || $img.attr('data-srcset') || '';
      if (!ss) return '';
      const resolved = ss.split(',').map(p => {
        const [u, ...r] = p.trim().split(/\s+/);
        const abs = toAbs(u);
        return abs ? [abs, ...r].join(' ') : '';
      }).filter(Boolean).join(', ');
      return resolved ? ` srcset="${esc(resolved)}"` : '';
    })();
    const caption = esc(
      spacedText($el.find('figcaption').first())
      || spacedText($el.find('[class*="caption"]').not('figcaption').first())
      || ''
    );
    return `<figure><img src="${esc(src)}"${srcset} alt="${alt}" loading="lazy" referrerpolicy="no-referrer">${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;
  };

  // Find article container
  const containerSelectors = [
    '.story-content', '[data-testid="story-body"]', '[data-testid="story"]',
    '.details-content', '.news-details', 'article[role="article"]',
    '[itemprop="articleBody"]', 'article.article', 'article.post',
    '.article-content', '.article-body', '.story-body', '.post-content',
    '.entry-content', '#article-body', '#article-content',
    'main article', 'article', 'main', '[role="main"]',
    '#main-content', '#content',
  ];
  let $container = $('body');
  for (const sel of containerSelectors) {
    const c = $(sel).first();
    if (c.length && (c.text() || '').replace(/\s+/g, ' ').trim().length > 200) {
      $container = c; break;
    }
  }

  // Pre-clean: remove scripts, styles, noscripts, and known heavy-ad elements
  $container.find('script, style, noscript, template').remove();
  // Explicit tag / class / attribute ad selectors (Google Ads, Taboola, Teads, GPT, etc.)
  $container.find([
    'ins',
    '.adsbygoogle',
    '.advertisement',
    '.teads',
    '[id^="div-gpt-ad"]',
    '[class*="ad-slot"]',
    '[class*="ad-unit"]',
    '[class*="ad-container"]',
    '[class*="ad-wrapper"]',
    '[class*="ad-box"]',
    '[class*="advert"]',
    '[id*="taboola"]',
    '[id*="outbrain"]',
    '[data-ad-unit]',
    '[data-ad-slot]',
  ].join(', ')).remove();

  // Ad / noise pattern
  const AD_PAT = /\b(ad|ads|advert|advertisement|ad[-_]?(box|container|slot|unit|wrap|banner)|adsense|dfp|gpt[-_]?ad|taboola|outbrain|sponsored|social[-_]?share|share[-_]?button|follow[-_]?us|related[-_]?(article|post|news|storie)|more[-_]?storie|newsletter|subscri(be|ption)|cookie[-_]?notice|popup|modal|overlay)\b/i;

  const isAdEl = ($el) => {
    const str = ($el.attr('class') || '') + ' ' + ($el.attr('id') || '');
    return AD_PAT.test(str);
  };

  // TEXT_TAGS: elements we output directly as text HTML (after cleaning attrs)
  const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol']);

  const output = [];
  let lastWasAd = false;

  const emit = (html) => { if (html) { output.push(html); lastWasAd = false; } };
  const emitAd = () => {
    if (!lastWasAd) {
      output.push('<div class="jaani-ad-block" style="background:#f0f0f0;border:1px dashed #ccc;padding:20px;text-align:center;margin:20px 0;color:#999;font-weight:bold;">📢 এই ব্লকগুলো বিজ্ঞাপন — these blocks are ads</div>');
      lastWasAd = true;
    }
  };

  function walk(el) {
    const $el = $(el);
    const tag = (el.tagName || '').toLowerCase();
    if (!tag || ['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'base'].includes(tag)) return;

    // Ad / noise
    if (isAdEl($el)) { emitAd(); return; }

    // ── Text leaf elements ──────────────────────────────────────────────────
    if (TEXT_TAGS.has(tag)) {
      const text = ($el.text() || '').trim();
      if (!text || text.length < 3) return;
      // Inline images inside p/blockquote → resolve src and add referrerpolicy
      $el.find('img').each((_, i) => { const s = getBestSrc($(i)); if (s) { $(i).attr('src', s); $(i).attr('referrerpolicy', 'no-referrer'); } });
      // Strip class/id/style so our newspaper CSS applies cleanly
      $el.removeAttr('class').removeAttr('id').removeAttr('style');
      // Strip nested elements' classes too (span, em, strong, a)
      $el.find('span, em, strong').each((_, i) => $(i).removeAttr('class').removeAttr('id').removeAttr('style'));
      emit($.html($el));
      return;
    }

    // ── Image containers ────────────────────────────────────────────────────
    if (tag === 'figure' || tag === 'picture') {
      emit(makeFigure($el));
      return;
    }
    if (tag === 'img') {
      if (!isTiny($el)) emit(makeFigure($el));
      return;
    }

    // ── Video / embed ───────────────────────────────────────────────────────
    if (tag === 'iframe') {
      const src = ($el.attr('src') || '').toLowerCase();
      if (src.includes('youtube.com') || src.includes('youtu.be') || src.includes('vimeo.com')) {
        $el.attr('src', toAbs($el.attr('src') || '') || $el.attr('src') || '');
        $el.removeAttr('class').removeAttr('id').removeAttr('style').removeAttr('frameborder').removeAttr('scrolling');
        $el.attr('style', 'width:100%;aspect-ratio:16/9;border:0;display:block;margin:12px 0;');
        emit($.html($el));
      } else { emitAd(); }
      return;
    }
    if (tag === 'video') {
      const src = $el.attr('src') || $el.find('source').first().attr('src') || '';
      if (src) {
        $el.attr('src', toAbs(src) || src);
        $el.removeAttr('class').removeAttr('id').removeAttr('style');
        $el.attr('style', 'width:100%;display:block;margin:12px 0;');
        $el.attr('controls', '');
        emit($.html($el));
      }
      return;
    }

    // ── Wrapper elements (div, section, article, aside, li, span, a…) ──────
    // Decide how to handle based on content type
    const $children = $el.children();
    if ($children.length === 0) {
      // Leaf wrapper with direct text
      const text = ($el.text() || '').trim();
      if (text.length > 50) emit(`<p>${esc(text)}</p>`);
      return;
    }

    // Does this block contain ONLY image-related elements (no text paragraphs)?
    const hasTextChildren = $el.find('p, h1, h2, h3, h4, h5, h6').length > 0;
    const hasImgChildren = $el.find('img').length > 0;
    const hasDirectFig = $el.children('figure, picture').length > 0;

    if (!hasTextChildren && hasImgChildren) {
      // Pure image block → extract as single figure
      if (hasDirectFig) {
        // Handle each figure child separately (multiple images)
        $el.children('figure, picture').each((_, fig) => emit(makeFigure($(fig))));
      } else {
        emit(makeFigure($el));
      }
      return;
    }

    // Mixed or text-only → recurse into children in DOM order
    $children.each((_, child) => walk(child));
  }

  $container.children().each((_, el) => walk(el));

  // ── Prepend article title h1 if it was not captured inside the container ──
  // Many sites place the headline in a separate .article-title / header element
  // outside the body container we selected above.
  const hasH1InOutput = output.some(h => /^<h1[\s>]/i.test(h.trimStart()));
  if (!hasH1InOutput) {
    // Try common headline selectors outside $container
    const titleSelectors = [
      'h1.article-title', 'h1.story-title', 'h1.entry-title', 'h1.post-title',
      'h1.headline', 'h1.news-title', '[itemprop="headline"]', '.article-header h1',
      '.story-header h1', 'header h1', 'h1',
    ];
    for (const sel of titleSelectors) {
      const $h1 = $(sel).not($container.find('*')).first();
      if ($h1.length) {
        const titleText = ($h1.text() || '').trim();
        if (titleText.length > 4) {
          output.unshift(`<h1>${esc(titleText)}</h1>`);
        }
        break;
      }
    }
  }

  // Ensure all img tags have referrerpolicy="no-referrer" to prevent hotlink blocking
  const joined = output.join('\n').trim();
  return joined.replace(/<img(?![^>]*referrerpolicy)(\s)/gi, '<img referrerpolicy="no-referrer"$1');
}

/**
 * Some news sites (e.g. dhakapost.com) block direct scraping outright (403 /
 * bot-detection) regardless of extractor used. The Wayback Machine keeps its
 * own cached copy of most published articles and serves it over plain HTTP
 * with no bot-blocking, so when direct access fails this fetches the closest
 * archived snapshot and lets the normal extractor parse that instead — the
 * site's block is effectively bypassed rather than surfaced as a dead end.
 */
/**
 * Newest HTTP-200 Wayback snapshot for a URL, via the CDX index.
 * CDX returns rows oldest-first, so `limit=-1` (last row only) is what gives the newest
 * capture — the earlier `limit=5` + "take the last row" returned the 5th-OLDEST capture
 * on any URL with more than 5 snapshots (e.g. a 2017 copy of prothomalo.com/bangladesh).
 * (`fastLatest=true` was measured slower here — 8–40s vs 2–3s — so it is not used.)
 * Returns { timestamp, original } or null when the index has no snapshot / is unreachable.
 */
async function findLatestWaybackSnapshot(targetUrl, { timeoutMs = 40000 } = {}) {
  try {
    const resp = await axios.get('https://web.archive.org/cdx/search/cdx', {
      params: {
        url: targetUrl,
        output: 'json',
        limit: -1,
        fl: 'timestamp,original',
        filter: 'statuscode:200',
      },
      timeout: timeoutMs,
    });
    const rows = Array.isArray(resp?.data) ? resp.data : [];
    // First row is the header (["timestamp","original"]).
    const latest = rows.length > 1 ? rows[1] : null;
    if (!latest?.[0]) return null;
    return { timestamp: String(latest[0]), original: latest[1] || targetUrl };
  } catch (err) {
    console.warn(`⚠️ [Wayback] CDX lookup failed for ${targetUrl}: ${err.message}`);
    return null;
  }
}

async function resolveWaybackSnapshotUrl(targetUrl) {
  // Archive.org round trips from this network have measured 2–18s, so extraction keeps a
  // generous single-attempt timeout (a slow path stays slow on retry).
  const snapshot = await findLatestWaybackSnapshot(targetUrl, { timeoutMs: 40000 });
  if (!snapshot) return null;
  console.log(`🗄️ [Wayback] Newest snapshot for ${targetUrl}: ${snapshot.timestamp}`);
  // "id_" mode returns the raw archived HTML with no Wayback toolbar/banner injected.
  return `https://web.archive.org/web/${snapshot.timestamp}id_/${snapshot.original}`;
}

/**
 * Helper function to extract content with Cheerio (fallback method)
 */
async function extractWithCheerio(url) {
  try {
    const parsedUrl = new URL(url);
    const response = await axiosGetWithGovTlsFallback(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': `${parsedUrl.protocol}//${parsedUrl.hostname}/`,
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
      },
      // Node's http client has measured noticeably slower connect times to some
      // hosts (e.g. archive.org) than a plain curl from the same machine — 20s
      // was cutting it close on a slow day, so this has real margin now.
      timeout: 35000,
      maxRedirects: 5,
      decompress: true,
      responseType: 'arraybuffer',
    }, {
      label: `extractWithCheerio:${parsedUrl.hostname}`,
    });
    const rawBody = Buffer.isBuffer(response?.data)
      ? response.data
      : Buffer.from(response?.data || '');
    const headerCharsetMatch = String(response?.headers?.['content-type'] || '').match(/charset=([^;\s]+)/i);
    const sniffSample = rawBody.toString('ascii', 0, Math.min(rawBody.length, 4096));
    const metaCharsetMatch = sniffSample.match(/<meta[^>]+charset=["']?([^\s"'>/]+)/i)
      || sniffSample.match(/<meta[^>]+content=["'][^"']*charset=([^\s"';>]+)/i);
    const declaredCharset = ((headerCharsetMatch && headerCharsetMatch[1]) || (metaCharsetMatch && metaCharsetMatch[1]) || 'utf-8')
      .trim()
      .replace(/^utf8$/i, 'utf-8');
    const rawHtml = iconv.encodingExists(declaredCharset)
      ? iconv.decode(rawBody, declaredCharset)
      : rawBody.toString('utf8');

    if (!rawHtml || rawHtml.length < 40) {
      return {
        title: '',
        subtitle: '',
        text: '',
        html: '',
        rawHtml: rawHtml || '',
        images: [],
        videos: [],
        stylesheets: [],
        inlineCss: '',
        replicaMeta: { htmlAttrs: {}, bodyAttrs: {} },
        author: '',
        publicationDate: '',
        source: parsedUrl.hostname,
      };
    }

    const $page = cheerio.load(rawHtml, { decodeEntities: false });

    const pickMetaContent = (...selectors) => {
      for (const selector of selectors) {
        const value = ($page(selector).attr('content') || '').toString().trim();
        if (value) return value;
      }
      return '';
    };

    const metaTitle = pickMetaContent('meta[property="og:title"]', 'meta[name="twitter:title"]', 'meta[name="title"]')
      || ($page('h1').first().text() || '').trim()
      || ($page('title').first().text() || '').split('|')[0].split(' - ')[0].trim();
    const metaSubtitle = pickMetaContent('meta[property="og:description"]', 'meta[name="description"]', 'meta[name="twitter:description"]')
      || ($page('h2').first().text() || '').trim();
    const metaAuthor = pickMetaContent('meta[name="author"]', 'meta[property="article:author"]', 'meta[name="parsely-author"]');
    const metaPublicationDate = pickMetaContent('meta[property="article:published_time"]', 'meta[name="pubdate"]', 'meta[name="publication_date"]', 'meta[property="og:updated_time"]')
      || ($page('time').first().attr('datetime') || '').trim();
    const metaSource = pickMetaContent('meta[property="og:site_name"]') || parsedUrl.hostname;
    const metaSiteName = pickMetaContent('meta[property="og:site_name"]', 'meta[name="application-name"]');
    const metaModifiedDate = pickMetaContent('meta[property="article:modified_time"]', 'meta[property="og:updated_time"]', 'meta[name="last-modified"]');
    const canonicalHref = ($page('link[rel="canonical"]').attr('href') || pickMetaContent('meta[property="og:url"]') || '').trim();
    let metaCanonicalUrl = '';
    try { metaCanonicalUrl = canonicalHref ? new URL(canonicalHref, url).href : ''; } catch { metaCanonicalUrl = ''; }
    const metaOgImage = pickMetaContent('meta[property="og:image"]', 'meta[property="og:image:url"]', 'meta[name="twitter:image"]', 'meta[name="twitter:image:src"]');

    // Capture stylesheets + inline CSS for replica rendering (Cheerio path).
    const stylesheets = [];
    $page('link[rel="stylesheet"][href]').each((_, el) => {
      if (stylesheets.length >= 12) return false;
      const href = ($page(el).attr('href') || '').trim();
      if (!href) return;
      try {
        const resolved = href.startsWith('http') ? href : new URL(href, url).href;
        if (!stylesheets.includes(resolved)) stylesheets.push(resolved);
      } catch {
        // Ignore malformed stylesheet URL.
      }
    });
    const inlineCssParts = [];
    $page('style').each((_, el) => {
      const css = ($page(el).html() || '').trim();
      if (css) inlineCssParts.push(css);
    });
    const inlineCss = inlineCssParts.join('\n\n').slice(0, 120000);

    // Capture html/body attrs for replica fidelity.
    const replicaMeta = {
      htmlAttrs: {},
      bodyAttrs: {},
    };
    const htmlEl = $page('html').first();
    if (htmlEl.attr('lang')) replicaMeta.htmlAttrs.lang = htmlEl.attr('lang');
    if (htmlEl.attr('dir')) replicaMeta.htmlAttrs.dir = htmlEl.attr('dir');
    if (htmlEl.attr('class')) replicaMeta.htmlAttrs.class = htmlEl.attr('class');
    const bodyEl = $page('body').first();
    if (bodyEl.attr('class')) replicaMeta.bodyAttrs.class = bodyEl.attr('class');

    const toAbsoluteUrl = (value = '') => {
      const candidate = (value || '').toString().trim();
      if (!candidate || candidate.startsWith('data:')) return '';
      try {
        return candidate.startsWith('http') ? candidate : new URL(candidate, url).href;
      } catch {
        return '';
      }
    };

    const collectImagesFromScope = ($ctx, $scope, limit = 15) => {
      const images = [];
      const seen = new Set();

      $scope.find('img').each((_, elem) => {
        if (images.length >= limit) return false;

        const $img = $ctx(elem);
        let src = ($img.attr('src') || $img.attr('data-src') || $img.attr('data-lazy-src') || $img.attr('data-original') || '').trim();

        if (!src || src.startsWith('data:')) {
          const srcset = ($img.attr('srcset') || $img.attr('data-srcset') || '').trim();
          if (srcset) {
            const parts = srcset.split(',').map((entry) => entry.trim().split(' ')[0]).filter(Boolean);
            src = parts[parts.length - 1] || '';
          }
        }

        if (!src || src.startsWith('data:')) {
          const $source = $img.closest('picture').find('source').first();
          const srcset = ($source.attr('srcset') || $source.attr('data-srcset') || '').trim();
          if (srcset) {
            src = srcset.split(',')[0].trim().split(' ')[0] || '';
          }
        }

        const resolvedSrc = toAbsoluteUrl(src);
        if (!resolvedSrc) return;

        const alt = ($img.attr('alt') || $img.attr('title') || '').trim();
        const skipPattern = /logo|icon|avatar|social|share|pixel|track|banner|sprite|emoji/i;
        if (skipPattern.test(`${resolvedSrc} ${alt}`)) return;
        if (seen.has(resolvedSrc)) return;

        seen.add(resolvedSrc);
        const $figure = $img.closest('figure');
        const caption = spacedText($figure.find('figcaption').first())
          || $img.closest('[class*="caption"]').text().trim()
          || '';
        images.push({
          src: resolvedSrc,
          alt: alt || 'Article image',
          caption,
        });
      });

      return images;
    };

    const collectVideosFromScope = ($ctx, $scope, limit = 5) => {
      const videos = [];
      const seen = new Set();

      $scope.find('iframe[src], video, video source').each((_, elem) => {
        if (videos.length >= limit) return false;

        const $el = $ctx(elem);
        const src = toAbsoluteUrl($el.attr('src') || $el.closest('video').attr('src') || '');
        if (!src || seen.has(src)) return;

        seen.add(src);
        videos.push(src);
      });

      return videos;
    };

    const extractParagraphsFromScope = ($ctx, $scope) => {
      const paragraphs = [];
      const seen = new Set();

      const pushParagraph = (value) => {
        const normalized = normalizeExtractionText(value);
        if (!normalized || normalized.length < 35 || normalized.length > 2500) return;

        const lower = normalized.toLowerCase();
        if (/^(advertisement|sponsored|share this|follow us|read more|related|comments?)$/.test(lower)) return;

        const key = lower.slice(0, 220);
        if (seen.has(key)) return;
        seen.add(key);
        paragraphs.push(normalized);
      };

      $scope.find('p').each((_, elem) => {
        const $el = $ctx(elem);
        const className = `${$el.attr('class') || ''} ${$el.attr('id') || ''}`.toLowerCase();
        if (/(related|recommend|comment|share|footer|header|breadcrumb|pagination|newsletter|advert|promo|most-read|trending)/.test(className)) return;

        const text = $el.text();
        const linkTextLength = normalizeExtractionText($el.find('a').text()).length;
        const plainLength = normalizeExtractionText(text).length;
        if (plainLength > 0 && linkTextLength / plainLength > 0.55) return;

        pushParagraph(text);
      });

      if (paragraphs.length < 3) {
        $scope.find('li, div').each((_, elem) => {
          const $el = $ctx(elem);
          if ($el.find('p').length > 0) return;
          if ($el.children('div').length > 0) return;

          const className = `${$el.attr('class') || ''} ${$el.attr('id') || ''}`.toLowerCase();
          if (/(related|recommend|comment|share|footer|header|breadcrumb|pagination|newsletter|advert|promo|most-read|trending|menu|nav)/.test(className)) return;

          const text = normalizeExtractionText($el.text());
          if (text.length < 90) return;

          const linkTextLength = normalizeExtractionText($el.find('a').text()).length;
          if (linkTextLength > 0 && linkTextLength / text.length > 0.45) return;

          pushParagraph(text);
        });
      }

      return paragraphs;
    };

    const readabilityResult = parseArticleWithReadability(rawHtml, url);

    let extractedText = '';
    let extractedHtml = '';
    let extractedImages = [];
    let extractedVideos = [];

    if (readabilityResult && !shouldEscalateExtraction(readabilityResult.textContent, readabilityResult.title || metaTitle)) {
      const $readable = cheerio.load(readabilityResult.contentHtml || '<article></article>', { decodeEntities: false });
      extractedText = normalizeExtractionText(readabilityResult.textContent || '');
      extractedHtml = ($readable('body').html() || $readable.root().html() || readabilityResult.contentHtml || '').trim();
      extractedImages = collectImagesFromScope($readable, $readable.root(), 15);
      extractedVideos = collectVideosFromScope($readable, $readable.root(), 5);
    }

    const $work = cheerio.load(rawHtml, { decodeEntities: false });
    $work('script, noscript, nav, footer, aside, header, .ad, .advertisement, .social-share, .related-articles, .comments, .newsletter, .sidebar, .cookie-consent, [role="banner"], [role="navigation"], [role="complementary"], .share-buttons, .breadcrumb, .pagination').remove();

    const containerSelectors = [
      '.story-content',
      '.story-element',
      '[data-testid="story-body"]',
      '.details-content',
      '.news-details',
      'article[role="article"]',
      '[itemprop="articleBody"]',
      'article.article',
      'article.post',
      '.article-content',
      '.article-body',
      '.story-body',
      '.post-content',
      '.entry-content',
      '#article-body',
      '#article-content',
      'main article',
      'article',
      '.content-area',
      'main',
      '[role="main"]',
      '#main-content',
      '#content',
      '.single-post',
    ];

    let $container = $work('body').first();
    for (const selector of containerSelectors) {
      let candidate = $work(selector).first();
      if (!candidate.length) continue;

      let candidateText = normalizeExtractionText(candidate.text());
      if (candidateText.length < 200) {
        // Some CMSes (kalerkantho.com among them) wrap EACH PARAGRAPH of the article body in
        // its own same-tag element instead of one shared container, so .first() only ever
        // gets the opening paragraph. Sibling elements of the same tag under the exact same
        // parent are this article's own remaining paragraphs -- a different "other articles"
        // block further down the page lives under a different parent node even when
        // CSS-module class names happen to collide -- so merge them and re-check.
        const tag = candidate.get(0)?.tagName;
        const sameTagSiblings = tag ? candidate.parent().children(tag) : $work();
        if (sameTagSiblings.length > 1) {
          const $merged = $work('<div></div>');
          sameTagSiblings.each((_, el) => $merged.append($work(el).clone()));
          const mergedText = normalizeExtractionText($merged.text());
          if (mergedText.length > candidateText.length) {
            candidate = $merged;
            candidateText = mergedText;
          }
        }
      }
      if (candidateText.length < 200) continue;
      if (looksLikelyBoilerplateText(candidateText)) continue;

      $container = candidate;
      break;
    }

    const heuristicParagraphs = extractParagraphsFromScope($work, $container);
    let heuristicText = normalizeExtractionText(heuristicParagraphs.join('\n\n'));

    if (!heuristicText) {
      const lines = ($container.text() || '')
        .split(/\n+/)
        .map((line) => normalizeExtractionText(line))
        .filter((line) => line.length >= 50 && line.length <= 500)
        .filter((line) => !/^(home|menu|login|privacy|terms|cookie|newsletter|subscribe)$/i.test(line))
        .slice(0, 200);
      heuristicText = normalizeExtractionText(lines.join('\n\n'));
    }

    if (!extractedText || extractedText.length < 200 || shouldEscalateExtraction(extractedText, metaTitle)) {
      if (heuristicText && !shouldEscalateExtraction(heuristicText, metaTitle)) {
        extractedText = heuristicText;
        extractedHtml = ($container.html() || '').trim();
        extractedImages = collectImagesFromScope($work, $container, 15);
        extractedVideos = collectVideosFromScope($work, $container, 5);
      }
    }

    if (!extractedText && heuristicText) extractedText = heuristicText;
    if (!extractedHtml) extractedHtml = ($container.html() || '').trim();
    if (!extractedImages.length) extractedImages = collectImagesFromScope($work, $container, 15);
    if (!extractedVideos.length) extractedVideos = collectVideosFromScope($work, $container, 5);

    // Prepend og:image as the main article image (always available even for JS-rendered sites)
    if (metaOgImage) {
      const toAbs = (v) => { try { return v.startsWith('http') ? v : new URL(v, url).href; } catch { return ''; } };
      const ogAbs = toAbs(metaOgImage);
      if (ogAbs) {
        const existingIdx = extractedImages.findIndex((img) => img.src === ogAbs);
        if (existingIdx > 0) {
          // Move to front, preserving its caption
          extractedImages.unshift(extractedImages.splice(existingIdx, 1)[0]);
        } else if (existingIdx === -1) {
          // The og:image is the hero image, but on some sites (e.g. Prothom Alo) the
          // hero figure lives outside whatever container we picked for body text,
          // so it never got a caption via the normal image-collection pass. The page's
          // first non-boilerplate figcaption is, in practice, almost always this
          // hero image's own caption — search the whole page (not just the container)
          // for it rather than leaving the caption permanently blank.
          let heroCaption = '';
          try {
            const $cap = $work('figcaption, [class*="caption"]').filter((_, el) => {
              const $el = $work(el);
              if ($el.closest('.related, .recommended, .comments, nav, footer, header, [class*="related"], [class*="recommend"]').length) return false;
              return normalizeExtractionText($el.text()).length > 0;
            }).first();
            // Captions are often built from a label + a nested description span with
            // no text-node separator between them (e.g. "গ্রেপ্তার" + <span>"প্রতীকী ছবি"</span>),
            // which reads as a visual "label | description" but concatenates to nothing
            // readable via a flat .text() call — join each direct piece with " | " instead.
            const capParts = [];
            $cap.contents().each((_, node) => {
              const piece = node.type === 'text'
                ? normalizeExtractionText($work(node).text() || '')
                : normalizeExtractionText($work(node).text() || '');
              if (piece) capParts.push(piece);
            });
            heroCaption = (capParts.length > 0 ? capParts.join(' | ') : normalizeExtractionText($cap.text() || '')).slice(0, 200);
          } catch { heroCaption = ''; }
          extractedImages.unshift({ src: ogAbs, alt: metaTitle || 'Main article image', caption: heroCaption });
        }
        // existingIdx === 0 means it's already at front — no action needed
      }
    }

    const resolvedTitle = (readabilityResult?.title || metaTitle || '').trim();
    const resolvedSubtitle = (readabilityResult?.excerpt || metaSubtitle || '').trim();
    const resolvedAuthor = (metaAuthor || readabilityResult?.byline || '').trim();
    const resolvedSource = (metaSource || readabilityResult?.siteName || parsedUrl.hostname || '').trim();
    const resolvedPublicationDate = (metaPublicationDate || '').trim();

    const cappedText = extractedText.length > 180000 ? extractedText.slice(0, 180000) : extractedText;

    return {
      title: resolvedTitle,
      subtitle: resolvedSubtitle,
      text: cappedText,
      html: extractedHtml,
      rawHtml,
      images: extractedImages,
      videos: extractedVideos,
      stylesheets,
      inlineCss,
      replicaMeta,
      author: resolvedAuthor,
      publicationDate: resolvedPublicationDate,
      source: resolvedSource,
      siteName: (metaSiteName || readabilityResult?.siteName || '').trim(),
      modifiedDate: (metaModifiedDate || '').trim(),
      canonicalUrl: metaCanonicalUrl,
    };
  } catch (error) {
    console.error('? Cheerio extraction failed:', error.message);
    return {
      title: '',
      subtitle: '',
      text: '',
      html: '',
      rawHtml: '',
      images: [],
      videos: [],
      stylesheets: [],
      inlineCss: '',
      replicaMeta: { htmlAttrs: {}, bodyAttrs: {} },
      author: '',
      publicationDate: '',
      source: '',
    };
  }
}


function sanitizeFilename(input, fallback = 'document') {
  const safe = (input || '').toString().trim().replace(/[\\/:*?"<>|]+/g, '_');
  return safe.length ? safe.slice(0, 120) : fallback;
}

// Evidence screenshots for the PDF: each on its own custom-height page (A4 width, 595 pt), scaled
// down proportionally when taller than Chromium's 14,400 pt (200 in) PDF page limit.
const PDF_PAGE_WIDTH_PT = 595;
const PDF_PAGE_MAX_PT = 14400;
const SCREENSHOT_LABELS = {
  'screenshot_fullpage.png': 'Original page as served by the publisher (unmodified)',
  'screenshot_adblocked.png': 'JAANI reading view (ads, trackers and overlays removed by an automated filter)',
};

async function loadEvidenceScreenshots(forensic) {
  const sharp = require('sharp');
  const out = [];
  for (const file of Object.keys(SCREENSHOT_LABELS)) {
    const entry = (forensic.files || []).find((f) => f.name === file);
    if (!entry) continue;
    try {
      const png = await fs.readFile(path.join(evidenceVault.VAULT_DIR, forensic.capture_id, file));
      const meta = await sharp(png, { limitInputPixels: false }).metadata();
      let widthPt = PDF_PAGE_WIDTH_PT;
      let heightPt = (meta.height / meta.width) * PDF_PAGE_WIDTH_PT;
      let scale = 1;
      if (heightPt > PDF_PAGE_MAX_PT) {
        scale = PDF_PAGE_MAX_PT / heightPt;
        heightPt = PDF_PAGE_MAX_PT;
        widthPt = PDF_PAGE_WIDTH_PT * scale;
      }
      const jpeg = await sharp(png, { limitInputPixels: false }).flatten({ background: '#ffffff' }).jpeg({ quality: 78 }).toBuffer();
      const isFiltered = file === 'screenshot_adblocked.png';
      const info = isFiltered ? (forensic.render?.filtered || {}) : (forensic.render || {});
      out.push({
        file,
        label: SCREENSHOT_LABELS[file],
        sha256: entry.sha256,
        dataUri: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
        pageWidthPt: PDF_PAGE_WIDTH_PT,
        widthPt: Number(widthPt.toFixed(2)),
        heightPt: Number(Math.ceil(heightPt)),
        scaled: scale < 1,
        scalePct: Math.round(scale * 100),
        capturedHeightPx: info.capturedHeightPx || meta.height,
        pageHeightPx: info.pageHeightPx || meta.height,
        segments: info.segments || 1,
        truncated: Boolean(info.truncated),
      });
    } catch (e) {
      console.warn(`[PDF] screenshot ${file} unavailable: ${e.message}`);
    }
  }
  return out;
}

// ZIP: evidence.pdf + every file of the capture folder (vault names = the names manifest.json
// hashes) + README_VERIFY.txt. The PDF is generated at download time, so it is not covered by the
// timestamped manifest; its own SHA-256 is recorded in the README.
async function buildEvidenceZip(forensic, pdfBuffer, pdfSha256) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  const dir = path.join(evidenceVault.VAULT_DIR, forensic.capture_id);
  zip.file('evidence.pdf', pdfBuffer);
  const names = (await fs.readdir(dir)).sort();
  for (const name of names) zip.file(name, await fs.readFile(path.join(dir, name)));
  const has = (n) => names.includes(n);
  const readme = [
    'JAANI evidence bundle',
    `Capture ID:        ${forensic.capture_id}`,
    `Article URL:       ${forensic.article_url}`,
    `Captured (UTC):    ${forensic.captured_at_utc}`,
    `Manifest SHA-256:  ${forensic.manifest_sha256 || ''}`,
    `evidence.pdf SHA-256: ${pdfSha256}  (generated at download time; NOT covered by the timestamped manifest)`,
    '',
    'Files',
    '  evidence.pdf                  readable certificate (summary, chain of custody, verification steps)',
    has('screenshot_fullpage.png') ? '  screenshot_fullpage.png       original page exactly as served (unmodified)' : '',
    has('screenshot_adblocked.png') ? '  screenshot_adblocked.png      reading view (ads/trackers/overlays removed by an automated filter)' : '',
    '  manifest.json                 SHA-256 / SHA-512 / MD5 of every captured file, plus the custody log',
    has('manifest.tsr') ? '  manifest.tsr / manifest.tsq   RFC 3161 timestamp token from FreeTSA / the request it answers' : '',
    '  raw_http_response_body.html, rendered_dom.html, redirect_chain.json, http_response_headers.json,',
    '  tls_certificate.json, dns_records.json, internet_archive.json, extracted_article_text.txt, ... : captured data',
    '',
    'Verify',
    '  1. File integrity:   shasum -a 256 <file>   and compare with manifest.json "files"',
    '  2. Manifest:         shasum -a 256 manifest.json   must equal the Manifest SHA-256 above',
    has('manifest.tsr') ? '  3. Trusted time:     openssl ts -verify -in manifest.tsr -queryfile manifest.tsq -CAfile cacert.pem -untrusted tsa.crt' : '',
    has('manifest.tsr') ? '                       (cacert.pem and tsa.crt from https://freetsa.org/files/)' : '',
    '  4. Third party:      open the Internet Archive snapshot listed in internet_archive.json',
    '',
    'This bundle proves that this content was served at the attested time. It does not prove authorship.',
    'Admissibility is for a court to decide.',
  ].filter((line) => line !== '').join('\n');
  zip.file('README_VERIFY.txt', `${readme}\n`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// Compare the client's article text with an evidence capture's preserved text (normalized), for
// logging only. Returns null when either side is missing.
function compareEvidenceText(clientText, captureText) {
  const norm = (t) => String(t || '').normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  const a = norm(clientText);
  const b = norm(captureText);
  if (!a || !b) return null;
  const hash = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
  const tokens = (t) => new Set(t.toLowerCase().split(' ').filter((w) => w.length > 1));
  const ta = tokens(a);
  const tb = tokens(b);
  let inter = 0;
  ta.forEach((w) => { if (tb.has(w)) inter += 1; });
  return {
    match: a === b,
    clientSha256: hash(a),
    captureSha256: hash(b),
    tokenOverlap: Number((inter / Math.max(1, Math.min(ta.size, tb.size))).toFixed(2)),
  };
}

// Strict allowlist for article HTML rendered into a PDF by the server-side browser:
// text/structure/images only — no scripts, handlers, frames, objects, links or meta tags.
function sanitizePdfArticleHtml(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'div', 'span', 'section', 'article',
      'figure', 'figcaption', 'img', 'ul', 'ol', 'li', 'blockquote', 'strong', 'b', 'em', 'i', 'u', 'small',
      'sub', 'sup', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption', 'a'],
    allowedAttributes: { img: ['src', 'alt', 'width', 'height'], a: ['href'], '*': ['class'] },
    allowedSchemes: ['http', 'https', 'data'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'], a: ['http', 'https'] },
    disallowedTagsMode: 'discard',
  });
}

function buildPdfHtml({
  type,
  title,
  sourceUrl,
  meta,
  articleHtml,
  summary,
  legalProof,
  enrichedData,
  forensicHtml = '',
}) {
  // Everything interpolated below is escaped with safeText, and article HTML goes through a
  // strict allowlist: the PDF is rendered in a server-side browser, so no client-supplied
  // markup may carry scripts, handlers, frames or remote-loading elements.
  const safeText = (value) => (value == null ? '' : String(value))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const cleanArticleHtml = sanitizePdfArticleHtml(articleHtml);
  const safeTitle = (title || 'News').toString();
  const safeSourceUrl = (sourceUrl || '').toString();
  const safeSummary = (summary || '').toString();
  const headers = legalProof?.httpHeaders || {};
  const checksums = legalProof?.checksums || {};

  // Enriched data from frontend or cached analysis
  const ed = enrichedData || {};
  const persons = Array.isArray(ed.persons) ? ed.persons.filter(Boolean) : [];
  const organizations = Array.isArray(ed.organizations) ? ed.organizations.filter(Boolean) : [];
  const locations = Array.isArray(ed.locations) ? ed.locations.filter(Boolean) : [];
  const keywords = Array.isArray(ed.keywords) ? ed.keywords.filter(Boolean) : [];
  const highlights = Array.isArray(ed.highlights) ? ed.highlights.filter(Boolean) : [];
  const relatedGovOrgs = Array.isArray(ed.relatedGovOrgs) ? ed.relatedGovOrgs.filter(Boolean) : [];
  const mentionedGovOrgs = Array.isArray(ed.mentionedGovOrgs) ? ed.mentionedGovOrgs.filter(Boolean) : [];
  const rtiTargetOffice = (ed.rtiTargetOffice || '').toString();
  const ministryReasoning = (ed.ministryReasoning || '').toString();
  const category = (ed.category || '').toString();
  const categoryConfidence = ed.categoryConfidence || 0;
  const relatedSources = Array.isArray(ed.relatedSources) ? ed.relatedSources : [];
  const edLanguage = (ed.language || '').toString();
  const analysisSource = (ed.analysisSource || '').toString();
  const entityStats = ed.entityStats && typeof ed.entityStats === 'object' ? ed.entityStats : {};
  const edMeta = ed.metadata && typeof ed.metadata === 'object' ? ed.metadata : {};


  const personRows = persons
    .map((item) => {
      if (item && typeof item === 'object') {
        const name = (item.name || item.text || '').toString().trim();
        const rank = (item.rank || item.designation || item.title || '').toString().trim();
        return { name, rank, text: name || (item.text || '').toString().trim() };
      }
      const text = (item || '').toString().trim();
      return { name: text, rank: '', text };
    })
    .filter((row) => row.text);

  const orgRows = organizations
    .map((item) => {
      if (item && typeof item === 'object') {
        return (item.name || item.text || '').toString().trim();
      }
      return (item || '').toString().trim();
    })
    .filter(Boolean);

  const extractionMethod = legalProof?.extractionMethod || 'Unknown';
  const verificationScore = legalProof?.verificationScore || 'N/A';
  const contentIntegrity = checksums.sha256 ? 'Verified (SHA-256 checksum available)' : 'Unverified';
  
  const proofHtml = legalProof ? `
    <div class="proof">
      <h3>Authenticity & Legal Proof (Detailed Evidence)</h3>
      
      <div class="authenticity-summary">
        <p><strong>This document contains cryptographic evidence of the news article's authenticity at the time of capture.</strong></p>
        <p>The following metadata, checksums, and server information can be used as legal proof of the article's original content and publication.</p>
      </div>
      
      <h4>Verification Summary</h4>
      <div class="grid">
        <div><strong>Proof ID</strong><div class="mono">${safeText(legalProof.proofId || 'N/A')}</div></div>
        <div><strong>Captured (UTC)</strong><div>${safeText(legalProof.captureTimeUtc || legalProof.timestamp || 'N/A')}</div></div>
        <div><strong>Domain</strong><div>${safeText(meta?.domain || '')}</div></div>
        <div><strong>HTTP Status</strong><div>${safeText(legalProof.responseStatus ?? 'N/A')}</div></div>
        <div><strong>Extraction Method</strong><div>${safeText(extractionMethod)}</div></div>
        <div><strong>Content Integrity</strong><div>${safeText(contentIntegrity)}</div></div>
      </div>
      
      <h4>Network & Server Information</h4>
      <div class="grid">
        <div><strong>Protocol</strong><div>${safeText(legalProof.protocol || 'N/A')}</div></div>
        <div><strong>Response Time</strong><div>${safeText(legalProof.responseTime || 'N/A')}</div></div>
        <div><strong>Server IP Address</strong><div class="mono">${safeText(legalProof.serverIp || 'N/A')}</div></div>
        <div><strong>Server Port</strong><div class="mono">${safeText(legalProof.serverPort || 'N/A')}</div></div>
        <div><strong>TLS/SSL Version</strong><div>${safeText(legalProof.tlsVersion || 'N/A')}</div></div>
        <div><strong>Content Size</strong><div class="mono">${safeText(legalProof.contentSize ?? 'N/A')} bytes</div></div>
      </div>
      
      <h4>Cryptographic Checksums (Tamper Detection)</h4>
      <div class="grid">
        <div><strong>SHA-256 Hash</strong><div class="mono small-text">${safeText(checksums.sha256 || 'Not available')}</div></div>
        <div><strong>MD5 Hash</strong><div class="mono small-text">${safeText(checksums.md5 || 'Not available')}</div></div>
      </div>
      <p class="small">These checksums uniquely identify the content and can detect any modifications.</p>
      
      <h4>HTTP Headers (Server Response)</h4>
      <div class="grid">
        <div><strong>Server Software</strong><div>${safeText(headers.server || 'Not disclosed')}</div></div>
        <div><strong>ETag</strong><div class="mono small-text">${safeText(headers.etag || 'N/A')}</div></div>
        <div><strong>Last Modified</strong><div>${safeText(headers.lastModified || 'N/A')}</div></div>
        <div><strong>Content-Type</strong><div>${safeText(headers.contentType || 'N/A')}</div></div>
        <div><strong>Cache-Control</strong><div>${safeText(headers.cacheControl || 'N/A')}</div></div>
        <div><strong>Content-Encoding</strong><div>${safeText(headers.contentEncoding || 'N/A')}</div></div>
      </div>
      
      ${legalProof.rawHtmlSnippet ? `
        <h4>Raw HTML Evidence</h4>
        <div class="small"><strong>First 500 bytes of original HTML:</strong>
          <div class="mono pre code-block">${safeText(legalProof.rawHtmlSnippet.replace(/</g, '&lt;').replace(/>/g, '&gt;'))}</div>
        </div>
      ` : ''}
      
      ${legalProof.rawHtmlBase64 ? `
        <div class="small"><strong>Base64 Encoded (for verification):</strong>
          <div class="mono pre code-block">${safeText(legalProof.rawHtmlBase64.substring(0, 200))}...</div>
        </div>
      ` : ''}
      
      <div class="verification-note">
        <h4>Verification Instructions</h4>
        <p><strong>Legal Use:</strong> This document can be used as evidence in legal proceedings. The checksums and metadata provide cryptographic proof of authenticity.</p>
        <p><strong>Verification:</strong> To verify content integrity, recalculate the SHA-256 hash of the original HTML and compare with the hash above.</p>
        <p><strong>Timestamp:</strong> The capture time (UTC) establishes when this content was accessed and preserved.</p>
        ${legalProof.verificationNote ? `<p><strong>Note:</strong> ${safeText(legalProof.verificationNote)}</p>` : ''}
      </div>
    </div>
  ` : '';

  const sameStory = Array.isArray(ed.sameStory) ? ed.sameStory : relatedSources;
  const relatedNews = Array.isArray(ed.relatedNews) ? ed.relatedNews : [];
  const factChecks = Array.isArray(ed.factChecks) ? ed.factChecks : [];
  const newsListHtml = (heading, list) => (list.length > 0 ? `
        <div class="sources-section">
          <h3>${safeText(heading)}</h3>
          <ul>${list.slice(0, 10).map((s) => `<li>${s.source ? `<strong>${safeText(s.source)}:</strong> ` : ''}${safeText(s.title || 'Source')}${s.publishedAt ? ` (${safeText(s.publishedAt)})` : ''}${s.url ? ` — <span class="mono small-text">${safeText(s.url)}</span>` : ''}</li>`).join('')}</ul>
        </div>` : '');

  const summaryHtml = type === 'summary' ? `
    <div class="section">
      <h2>News Summary</h2>
      <p class="small"><em>This page reproduces the AI analysis as it was shown in the user's browser. It is not evidence;
      the evidence is the Digital Evidence Certificate below, built only from JAANI's own capture of the page.</em></p>
      ${(category || analysisSource || edLanguage) ? `<div class="badge-row">
        ${analysisSource ? `<span class="badge badge-green">${safeText(analysisSource)}</span>` : ''}
        ${edLanguage ? `<span class="badge badge-purple">${safeText(edLanguage)}</span>` : ''}
        ${category ? `<span class="badge badge-blue">${safeText(category)}${categoryConfidence > 0 ? ` (${Math.round(Number(categoryConfidence) * 100)}%)` : ''}</span>` : ''}
      </div>` : ''}
      <div class="content pre">${safeText(safeSummary)}</div>

      ${(edMeta?.title || edMeta?.siteName || edMeta?.author || edMeta?.publishedDate || edMeta?.domain || entityStats?.totalEntities) ? `
        <div class="analysis-meta-box">
          <h3>Analysis Snapshot</h3>
          <div class="grid">
            ${edMeta?.title ? `<div><strong>Title</strong><div>${safeText(edMeta.title)}</div></div>` : ''}
            ${edMeta?.siteName ? `<div><strong>Site</strong><div>${safeText(edMeta.siteName)}</div></div>` : ''}
            ${edMeta?.domain ? `<div><strong>Domain</strong><div>${safeText(edMeta.domain)}</div></div>` : ''}
            ${edMeta?.author ? `<div><strong>Author</strong><div>${safeText(edMeta.author)}</div></div>` : ''}
            ${edMeta?.publishedDate ? `<div><strong>Published</strong><div>${safeText(edMeta.publishedDate)}</div></div>` : ''}
            ${entityStats?.totalEntities ? `<div><strong>Detected Entities</strong><div>${safeText(entityStats.totalEntities)}</div></div>` : ''}
          </div>
        </div>
      ` : ''}

      ${highlights.length > 0 ? `
        <div class="highlight-box">
          <h3>Key Highlights</h3>
          <ul>${highlights.map((h) => `<li>${safeText(h)}</li>`).join('')}</ul>
        </div>
      ` : ''}

      ${rtiTargetOffice || relatedGovOrgs.length > 0 || mentionedGovOrgs.length > 0 ? `
        <div class="gov-box">
          <h3>Government Context</h3>
          ${rtiTargetOffice ? `<div class="rti-target"><strong>RTI আবেদনের জন্য প্রস্তাবিত অফিস:</strong> ${safeText(rtiTargetOffice)}</div>` : ''}
          ${relatedGovOrgs.length > 0 ? `<ul>${relatedGovOrgs.map((o) => `<li>${safeText(o)}</li>`).join('')}</ul>` : ''}
          ${mentionedGovOrgs.length > 0 && mentionedGovOrgs.join('|') !== relatedGovOrgs.join('|') ? `<p class="small"><strong>Mentioned in article:</strong> ${mentionedGovOrgs.map((o) => safeText(o)).join(', ')}</p>` : ''}
          ${ministryReasoning ? `<p class="reasoning">${safeText(ministryReasoning)}</p>` : ''}
        </div>
      ` : ''}

      ${personRows.length > 0 || orgRows.length > 0 || locations.length > 0 ? `
        <div class="entities-section">
          ${personRows.length > 0 ? `
            <div class="entity-group">
              <h3>Detected Persons (${personRows.length})</h3>
              <div class="chip-wrap">${personRows.map((p) => `<span class="chip chip-person">${safeText(p.name || p.text)}${p.rank ? ` — ${safeText(p.rank)}` : ''}</span>`).join('')}</div>
            </div>
          ` : ''}
          ${orgRows.length > 0 ? `
            <div class="entity-group">
              <h3>Detected Organizations (${orgRows.length})</h3>
              <div class="chip-wrap">${orgRows.map((o) => `<span class="chip chip-org">${safeText(o)}</span>`).join('')}</div>
            </div>
          ` : ''}
          ${locations.length > 0 ? `
            <div class="entity-group">
              <h3>Detected Locations (${locations.length})</h3>
              <div class="chip-wrap">${locations.map((l) => `<span class="chip chip-loc">${safeText(l)}</span>`).join('')}</div>
            </div>
          ` : ''}
        </div>
      ` : ''}

      ${keywords.length > 0 ? `
        <div class="keywords-section">
          <h3>AI Keywords</h3>
          <div class="chip-wrap">${keywords.map((k) => `<span class="chip chip-keyword">${safeText(k)}</span>`).join('')}</div>
        </div>
      ` : ''}

      ${newsListHtml('Same news in other newspapers', sameStory)}
      ${newsListHtml('Related news', relatedNews)}
      ${newsListHtml('Related fact-checks (independent fact-checkers; not a verdict on this article)', factChecks)}

      ${proofHtml}
    </div>
  ` : '';

  const articleSectionHtml = type === 'article' ? `
    <div class="section">
      <h2>Article</h2>
      <div class="content">${cleanArticleHtml}</div>
    </div>
  ` : '';

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      ${safeSourceUrl ? `<base href="${safeText(safeSourceUrl)}">` : ''}
      <title>${safeText(safeTitle)}</title>
      <style>
        * { box-sizing: border-box; }
        body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0; }
        .wrap { padding: 18mm 16mm; }
        .header { margin-bottom: 8mm; }
        .brand { font-weight: 700; font-size: 16px; }
        .meta { margin-top: 4px; font-size: 12px; color: #444; }
        .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; word-break: break-all; }
        .section { margin: 10mm 0; }
        h1 { font-size: 18px; margin: 0 0 2mm 0; }
        h2 { font-size: 14px; margin: 0 0 3mm 0; }
        h3 { font-size: 12.5px; margin: 0 0 3mm 0; }
        .content { font-size: 12px; line-height: 1.6; }
        .pre { white-space: pre-wrap; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; font-size: 12px; }
        .grid > div > div { margin-top: 2px; color: #333; }
        .small { margin-top: 6px; font-size: 11px; color: #555; }
        .proof { margin-top: 6mm; padding-top: 4mm; border-top: 1px solid #ddd; }
        img, video, iframe { max-width: 100%; height: auto; }
        mark, .highlight-yellow, .important-line-highlight { background: #fff59d; padding: 0 2px; }
        .gov-org-highlight { background-color: #dbeafe; color: #1e40af; font-weight: 600; padding: 1px 4px; border-radius: 3px; }
        .officer-highlight { text-decoration: underline; text-decoration-color: red; text-decoration-thickness: 2px; text-underline-offset: 2px; font-weight: 600; }
        .authenticity-summary { background: #f0f7ff; border-left: 4px solid #2196F3; padding: 8px 12px; margin: 6mm 0; font-size: 11px; }
        .verification-note { background: #fff9e6; border-left: 4px solid #ff9800; padding: 8px 12px; margin: 6mm 0; font-size: 11px; }
        h4 { font-size: 12px; margin: 4mm 0 2mm 0; color: #1976d2; border-bottom: 1px solid #e0e0e0; padding-bottom: 2mm; }
        .code-block { background: #f5f5f5; padding: 6px; border-radius: 3px; overflow-wrap: break-word; max-height: 150px; overflow-y: auto; }
        .small-text { font-size: 9px; }
        .badge-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 700; }
        .badge-green { background: #E8F5E9; color: #2E7D32; }
        .badge-purple { background: #F3E5F5; color: #7B1FA2; }
        .badge-blue { background: #1565C0; color: #fff; }
        .highlight-box { background: #FFF8E1; border-radius: 6px; padding: 8px 12px; margin: 6mm 0; }
        .highlight-box h3 { color: #F57F17; margin: 0 0 4px 0; font-size: 12px; }
        .highlight-box ul { margin: 0; padding-left: 16px; }
        .highlight-box li { font-size: 11px; line-height: 1.6; color: #333; margin-bottom: 2px; border-left: 3px solid #FFB300; padding-left: 6px; list-style: none; }
        .analysis-meta-box { margin: 5mm 0; background: #F5F5F5; border: 1px solid #E0E0E0; border-radius: 6px; padding: 8px 12px; }
        .analysis-meta-box h3 { margin: 0 0 5px 0; font-size: 12px; color: #424242; }
        .gov-box { background: #E8F5E9; border: 1px solid #A5D6A7; border-radius: 6px; padding: 8px 12px; margin: 6mm 0; }
        .gov-box h3 { color: #2E7D32; margin: 0 0 4px 0; font-size: 12px; }
        .gov-box ul { margin: 4px 0 0 0; padding-left: 16px; }
        .gov-box li { font-size: 11px; color: #1B5E20; }
        .gov-box li.primary { font-weight: 700; }
        .rti-target { background: #C8E6C9; border: 1px solid #81C784; border-radius: 4px; padding: 6px 10px; margin-bottom: 6px; font-size: 11px; color: #1B5E20; }
        .reasoning { font-size: 10px; color: #2E7D32; font-style: italic; margin-top: 4px; border-top: 1px solid #A5D6A7; padding-top: 4px; }
        .entities-section { margin: 6mm 0; }
        .entity-group { margin-bottom: 4mm; }
        .entity-group h3 { font-size: 12px; margin: 0 0 4px 0; }
        .chip-wrap { display: flex; flex-wrap: wrap; gap: 4px; }
        .chip { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; }
        .chip-person { background: #E8EAF6; color: #283593; }
        .chip-org { background: #E0F2F1; color: #004D40; }
        .chip-loc { background: #FFF3E0; color: #E65100; }
        .chip-keyword { background: #E0F2F1; color: #00695C; }
        .keywords-section { margin: 4mm 0; }
        .keywords-section h3 { font-size: 12px; margin: 0 0 4px 0; }
        .sources-section { margin: 4mm 0; }
        .sources-section h3 { font-size: 12px; margin: 0 0 4px 0; }
        .sources-section ul { margin: 0; padding-left: 16px; font-size: 11px; }
        .sources-section li { margin-bottom: 2px; }
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="header">
          <div class="brand">JAANI - News Export</div>
          <h1>${safeText(safeTitle)}</h1>
          <div class="meta">
            <div><strong>Source:</strong> <span class="mono">${safeText(safeSourceUrl)}</span></div>
            <div><strong>Date:</strong> ${safeText(meta?.date || meta?.publishedDate || edMeta?.publishedDate || '')}</div>
            <div><strong>Generated:</strong> ${new Date().toISOString()}</div>
          </div>
        </div>

        ${summaryHtml}
        ${type !== 'summary' ? proofHtml : ''}
        ${articleSectionHtml}
        ${forensicHtml}
      </div>
    </body>
  </html>`;
}


const escHtmlPdf = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function buildForensicHtml(ev, { screenshots = [], articleText = '', includeText = true } = {}) {
  if (!ev) return '';
  const e = escHtmlPdf;
  const files = Array.isArray(ev.files) ? ev.files : [];
  const hdr = ev.http?.headers || {};
  const pick = (k) => hdr[k] || hdr[k.toLowerCase()] || '';
  const chain = (ev.http?.chain || []).map((h) => `<tr><td>${e(h.url)}</td><td>${e(h.status)} ${e(h.statusText)}</td><td>${e(h.remoteAddress || '')}:${e(h.remotePort || '')}</td><td>${e(h.serverDate || '')}</td><td>${e(h.location || '')}</td></tr>`).join('');
  const certs = (ev.tls?.certificateChain || []).map((c, i) => `<tr><td>${i === 0 ? 'Server' : `CA ${i}`}</td><td>${e(c.subject?.CN || JSON.stringify(c.subject || {}))}</td><td>${e(c.issuer?.CN || '')} ${e(c.issuer?.O ? `(${c.issuer.O})` : '')}</td><td>${e(c.validFrom)} → ${e(c.validTo)}</td><td class="mono">${e(c.fingerprint256 || '')}</td></tr>`).join('');
  const fileRows = files.map((f) => `<tr><td>${e(f.name)}</td><td>${e(f.bytes)}</td><td class="mono">${e(f.sha256)}</td></tr>`).join('');
  const keyFiles = files.filter((f) => /raw_http_response_body|screenshot_fullpage|screenshot_adblocked|extracted_article_text|rendered_dom/.test(f.name));
  const strongRows = keyFiles.map((f) => `<tr><td>${e(f.name)}</td><td class="mono">${e(f.sha512)}</td><td class="mono">${e(f.md5)}</td></tr>`).join('');
  const snaps = (ev.wayback?.snapshots || []).map((s2) => `<li><span class="mono">${e(s2.url)}</span> (HTTP ${e(s2.statuscode)}, digest ${e(s2.digest)})</li>`).join('');
  const save = ev.wayback?.saveRequest || {};
  const ts = ev.timestamp || {};
  const custody = (ev.custody_log || []).map((c) => `<tr><td class="mono">${e(c.at)}</td><td>${e(c.event)}</td><td>${e(c.detail)}</td></tr>`).join('');
  const cid = e(ev.capture_id);
  const rawFile = files.find((f) => f.name === 'raw_http_response_body.html');
  const textFile = files.find((f) => f.name === 'extracted_article_text.txt');
  // Where the preserved text came from — always this capture's own fetch, never the client.
  const textProvenance = ev.text_source === 'none'
    ? 'No article text could be derived from this capture; the raw HTTP response and rendered page above are the preserved record.'
    : ev.text_source
      ? `Derived by JAANI from this capture's own <span class="mono">${e(ev.text_source)}</span> (article extraction with Mozilla Readability); file <span class="mono">extracted_article_text.txt</span>, SHA-256 <span class="mono">${e(textFile?.sha256 || '')}</span>. No text supplied by a user or browser is included.`
      : 'This capture was made before JAANI recorded where preserved text came from (before 2026-09-28); treat the text below as unverified and rely on <span class="mono">raw_http_response_body.html</span> and <span class="mono">rendered_dom.html</span>, which the server fetched itself.';

  return `
  <style>
    .fx h2 { font-size: 15px; margin: 6mm 0 2mm; color: #0d47a1; border-bottom: 2px solid #0d47a1; padding-bottom: 1mm; }
    .fx table { width: 100%; border-collapse: collapse; font-size: 9px; margin: 2mm 0 4mm; }
    .fx th, .fx td { border: 1px solid #bbb; padding: 3px 5px; vertical-align: top; text-align: left; word-break: break-all; }
    .fx th { background: #eceff1; }
    .fx .box { background: #fffde7; border: 1px solid #f9a825; border-left: 5px solid #f9a825; padding: 6px 10px; font-size: 10.5px; margin: 3mm 0; }
    .fx .ok { color: #1b5e20; font-weight: 700; }
    .fx .kv td:first-child { width: 28%; font-weight: 700; background: #fafafa; }
    .fx pre { white-space: pre-wrap; font-size: 9px; background: #f5f5f5; padding: 6px; border: 1px solid #ddd; }
    .fx .shot { width: 100%; border: 1px solid #999; }
    .fx-break { page-break-before: always; }
    ${screenshots.map((sh, i) => `@page shot${i} { size: ${sh.pageWidthPt}pt ${sh.heightPt}pt; margin: 0; } .shot-page-${i} { page: shot${i}; }`).join('\n    ')}
  </style>
  <div class="fx fx-break">
    <h1 style="font-size:18px;margin:0">Digital Evidence Certificate — Preservation of a Published News Article</h1>
    <div class="box">
      This certificate records that the web page below was requested from the publisher's server and preserved on
      <b>${e(ev.captured_at_utc)} (UTC)</b> / ${e(ev.captured_at_bst)}. The preserved files are cryptographically hashed, the hashes are covered by an
      independent RFC 3161 trusted timestamp${ts.gen_time ? ` issued by <b>${e(ts.tsa)}</b> at <b>${e(ts.gen_time)}</b>` : ' (<b>not obtained in this run</b>)'},
      and a copy was submitted to the Internet Archive. Capture ID: <span class="mono">${cid}</span>.
    </div>

    <h2>1. Identification of the publication</h2>
    <table class="kv">
      <tr><td>Article URL (as requested)</td><td class="mono">${e(ev.article_url)}</td></tr>
      <tr><td>Final URL after redirects</td><td class="mono">${e(ev.final_url)}</td></tr>
      <tr><td>Page title (rendered)</td><td>${e(ev.render?.title || ev.title)}</td></tr>
      <tr><td>Publication date shown by article</td><td>${e(ev.published_date || 'not extracted')}</td></tr>
      <tr><td>Publisher hostname</td><td>${e(ev.dns?.hostname || '')}</td></tr>
      <tr><td>Capture tool</td><td>${e(ev.tool)}</td></tr>
    </table>

    ${(ev.other_captures || []).length ? `<div style="font-size:9.5px"><b>Other captures of this URL on record:</b> ${(ev.other_captures || []).map((c) => `${e(c.capture_id)} (${e(c.captured_at_utc)}, HTTP ${e(c.http_status ?? 'n/a')}${c.complete === false ? ', incomplete: no raw response or screenshot' : ''})`).join('; ')}</div>` : ''}

    <h2>2. HTTP capture — what the publisher's server returned</h2>
    <table class="kv">
      <tr><td>Final HTTP status</td><td>${e(ev.http?.status)}</td></tr>
      <tr><td>Server-declared date (Date header)</td><td>${e(pick('date'))}</td></tr>
      <tr><td>Last-Modified</td><td>${e(pick('last-modified') || 'not sent')}</td></tr>
      <tr><td>ETag</td><td>${e(pick('etag') || 'not sent')}</td></tr>
      <tr><td>Server / CDN</td><td>${e(pick('server') || 'unknown')} ${pick('cf-ray') ? `(Cloudflare ray ${e(pick('cf-ray'))})` : ''}</td></tr>
      <tr><td>Content-Type / Cache-Control</td><td>${e(pick('content-type'))} / ${e(pick('cache-control'))}</td></tr>
      <tr><td>Server IP address</td><td>${e(ev.server_ip || '')}</td></tr>
      <tr><td>Request started / finished (UTC)</td><td>${e(ev.http?.startedAt)} / ${e(ev.http?.finishedAt)}</td></tr>
    </table>
    <table><tr><th>Request URL</th><th>Status</th><th>Server socket</th><th>Server Date</th><th>Redirect to</th></tr>${chain}</table>

    <h2>3. Server identity — DNS and TLS</h2>
    <table class="kv">
      <tr><td>DNS A records</td><td class="mono">${e((ev.dns?.A || []).join(', '))}</td></tr>
      <tr><td>DNS AAAA records</td><td class="mono">${e((ev.dns?.AAAA || []).join(', '))}</td></tr>
      <tr><td>Name servers</td><td class="mono">${e((ev.dns?.NS || []).join(', '))}</td></tr>
      <tr><td>TLS protocol / cipher</td><td>${e(ev.tls?.protocol || '')} / ${e(ev.tls?.cipher?.name || '')}</td></tr>
      <tr><td>Certificate trusted by capture host</td><td>${ev.tls?.trustedByNode ? '<span class="ok">Yes</span>' : `No (${e(ev.tls?.authorizationError || ev.tls?.error || 'unverified')})`}</td></tr>
    </table>
    <table><tr><th></th><th>Subject</th><th>Issuer</th><th>Validity</th><th>SHA-256 fingerprint</th></tr>${certs}</table>

    <h2>4. Independent third-party time attestations</h2>
    <table class="kv">
      <tr><td>RFC 3161 trusted timestamp</td><td>${ts.gen_time ? `<span class="ok">Granted</span> by ${e(ts.tsa)} (${e(ts.tsa_url)}) — attested time <b>${e(ts.gen_time)}</b>, algorithm ${e(ts.algorithm)}` : `Not obtained: ${e(JSON.stringify(ts.attempts || ''))}`}</td></tr>
      <tr><td>Timestamped hash (manifest SHA-256)</td><td class="mono">${e(ev.manifest_sha256)}</td></tr>
      <tr><td>Internet Archive save request</td><td>${save.snapshotUrl ? `<span class="ok">Snapshot created</span>: <span class="mono">${e(save.snapshotUrl)}</span>` : `HTTP ${e(save.httpStatus || '')} ${e(save.error || 'no snapshot URL returned')}`}</td></tr>
    </table>
    ${snaps ? `<div style="font-size:9.5px"><b>Archive snapshots on record for this URL (Wayback CDX index):</b><ul>${snaps}</ul></div>` : ''}

    <h2>5. Cryptographic fingerprints of every preserved file</h2>
    <table><tr><th>File</th><th>Bytes</th><th>SHA-256</th></tr>${fileRows}</table>
    <table><tr><th>File</th><th>SHA-512</th><th>MD5</th></tr>${strongRows}</table>
    <div class="box">The <b>manifest</b> lists every file above with its hash. Its SHA-256 (<span class="mono">${e(ev.manifest_sha256)}</span>) is what the trusted timestamp signs, so no file can be altered or added later without breaking the timestamp.
    ${rawFile ? `The unaltered server response body has SHA-256 <span class="mono">${e(rawFile.sha256)}</span>.` : ''}
    ${textFile ? ` The extracted article text has SHA-256 <span class="mono">${e(textFile.sha256)}</span>.` : ''}</div>

    <h2 class="fx-break">6. Full-page screenshots as rendered at capture</h2>
    ${screenshots.length ? `<p style="font-size:9.5px">Each screenshot is one image of the whole page (tall pages are captured in segments and joined into a single PNG before hashing) and is shown on its own page, scaled to fit, never cropped. The hashes refer to the PNG files in the evidence bundle; the images in this PDF are compressed copies for display.</p>
    <table><tr><th>Screenshot</th><th>File</th><th>Captured height</th><th>SHA-256 (PNG)</th></tr>
    ${screenshots.map((sh) => `<tr><td>${e(sh.label)}</td><td class="mono">${e(sh.file)}</td><td>${e(sh.capturedHeightPx)} px of ${e(sh.pageHeightPx)} px${sh.segments > 1 ? ` (${e(sh.segments)} segments)` : ''}${sh.truncated ? ' — truncated' : ''}${sh.scaled ? `; scaled to ${e(sh.scalePct)}% to fit the PDF page limit` : ''}</td><td class="mono">${e(sh.sha256)}</td></tr>`).join('')}
    </table>
    ${screenshots.some((sh) => sh.file === 'screenshot_adblocked.png') ? `<p style="font-size:9px">The reading view was produced by an automated filter (${e(ev.render?.filtered?.filtering?.engine || 'JAANI adBlockEngine')}): advertising slots are replaced by same-size grey placeholders and cookie bars/overlays are removed. Article content is not altered. The unmodified original is the first screenshot.</p>` : ''}`
    : '<p>A browser screenshot could not be produced in this run.</p>'}
    ${screenshots.map((sh, i) => `<div class="shot-page shot-page-${i}"><img src="${sh.dataUri}" alt="${e(sh.label)}" style="display:block;width:${sh.widthPt}pt;height:${sh.heightPt}pt" /></div>`).join('')}

    ${includeText ? `<h2 class="fx-break">7. Article text as preserved</h2>
    <p style="font-size:9.5px">${textProvenance}</p>
    ${articleText ? `<pre>${e(articleText)}</pre>` : ''}` : ''}

    <h2>8. Chain of custody (automated capture log)</h2>
    <table><tr><th>Time (UTC)</th><th>Event</th><th>Detail</th></tr>${custody}</table>

    <h2>9. How any party can verify this evidence independently</h2>
    <pre>1. Obtain the raw evidence files for capture ${cid} from the JAANI server that produced this
   document: GET /api/evidence/${cid}/bundle.zip  — it contains every file listed in section 5 plus
   manifest.json, manifest.tsq and manifest.tsr. (This PDF is the readable record; the raw files are what the hashes cover.)
2. File integrity:        shasum -a 256 raw_http_response_body.html screenshot_fullpage.png screenshot_adblocked.png manifest.json   (compare with section 5)
3. Timestamp integrity:   openssl ts -verify -in manifest.tsr -queryfile manifest.tsq -CAfile cacert.pem -untrusted tsa.crt
   ${e(ts.verify_hint || '')}
   Expected result: "Verification: OK", and "openssl ts -reply -in manifest.tsr -text" shows the attested time ${e(ts.gen_time || '')} and the manifest hash.
4. Third-party archive:   open the Internet Archive snapshot URL in section 4 and compare it with the screenshot and raw response.
5. Server identity:       compare the DNS/TLS data with an independent lookup (nslookup, openssl s_client -connect ${e(ev.dns?.hostname || 'host')}:443).</pre>

    <h2>10. Scope and limitations</h2>
    <div class="box" style="background:#f5f5f5;border-color:#9e9e9e">
      This certificate is produced by an automated process and states only what was observed and recorded at the times shown. The trusted timestamp proves that the
      preserved data existed no later than the attested time; it does not by itself prove who authored the article. The publisher's own server response (section 2),
      the third-party archive snapshot (section 4) and the screenshot (section 6) corroborate each other. Admissibility of electronic records is decided by the
      competent court under the applicable evidence law; parties may wish to accompany this document with a statement from the person who operated the capture
      and, where required, a notarised copy. This document is not legal advice.
    </div>
  </div>`;
}

async function renderPdfBufferFromHtml(html, { footerLabel = '' } = {}) {
  let browser;
  try {
    // Use Playwright instead of Puppeteer (already installed)
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    // No JavaScript in the PDF renderer: the HTML is built from client-supplied fields
    // (sanitized/escaped above); this is defense in depth, not a substitute for that.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      preferCSSPageSize: true, // screenshot pages declare their own @page size
      printBackground: true,
      margin: { top: '14mm', right: '12mm', bottom: '16mm', left: '12mm' },
      ...(footerLabel ? {
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: `<div style="width:100%;font-size:7px;color:#555;padding:0 12mm;display:flex;justify-content:space-between"><span>${footerLabel}</span><span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
      } : {}),
    });
    return Buffer.from(pdfBuffer);
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * ? Endpoint 1: POST /api/analyze
 * ? Compatibility alias: POST /api/fetch-and-analyze
 * Purpose: Extract news content (text + media only)
 * Input: { url?: string, text?: string }
 * Output: { text: string, media: { images: [], external_videos: [], self_hosted_videos: [] } }
 */
const analyzeValidators = [
  body('url').optional().isURL().withMessage('Invalid URL format'),
  body('text').optional().isString(),
  body().custom((_, { req }) => {
    const hasUrl = Boolean((req.body?.url || '').toString().trim());
    const hasText = Boolean((req.body?.text || '').toString().trim());
    if (!hasUrl && !hasText) {
      throw new Error('Either url or text is required');
    }
    return true;
  }),
];

const analyzeTextValidators = [
  body('text').isString().isLength({ min: 20 }).withMessage('Text is required for analysis'),
  body('llm_provider').optional().isString(),
  body('url').optional().isString(),
];

const EXTRACT_MAX_WORDS = parseInt(process.env.NEWS_EXTRACT_MAX_WORDS || '2500', 10);

function normalizeExtractedText(text) {
  const cleaned = normalizeExtractionText(text || '');
  const nfcText = cleaned.normalize('NFC');
  return truncateToWords(nfcText, EXTRACT_MAX_WORDS);
}

function toAbsoluteMediaUrl(value, baseUrl) {
  const candidate = (value || '').toString().trim();
  if (!candidate || candidate.startsWith('data:')) return '';
  try {
    return candidate.startsWith('http') ? candidate : new URL(candidate, baseUrl).href;
  } catch {
    return '';
  }
}

function splitVideoUrls(values = [], baseUrl) {
  const externalVideos = [];
  const selfHostedVideos = [];
  const seenExternal = new Set();
  const seenSelf = new Set();

  (Array.isArray(values) ? values : []).forEach((entry) => {
    const raw = typeof entry === 'string'
      ? entry
      : (entry?.src || entry?.url || entry?.href || '');
    const absolute = toAbsoluteMediaUrl(raw, baseUrl);
    if (!absolute) return;

    if (/(youtube\.com|youtu\.be|vimeo\.com|facebook\.com\/plugins\/video)/i.test(absolute)) {
      if (!seenExternal.has(absolute)) {
        seenExternal.add(absolute);
        externalVideos.push(absolute);
      }
      return;
    }

    if (/\.(mp4|webm|m3u8)(\?|#|$)/i.test(absolute)) {
      if (!seenSelf.has(absolute)) {
        seenSelf.add(absolute);
        selfHostedVideos.push(absolute);
      }
    }
  });

  return { externalVideos, selfHostedVideos };
}

function buildMediaPayload({ html = '', url = '', images = [], videos = [] } = {}) {
  const { media } = extractMediaFromHtml(html || '', url || '');

  const imageSet = new Set(media?.images || []);
  (Array.isArray(images) ? images : []).forEach((item) => {
    const raw = typeof item === 'string' ? item : item?.src || '';
    const absolute = toAbsoluteMediaUrl(raw, url);
    if (absolute) imageSet.add(absolute);
  });

  const { externalVideos, selfHostedVideos } = splitVideoUrls(videos, url);
  const externalMerged = new Set([...(media?.external_videos || []), ...externalVideos]);
  const selfHostedMerged = new Set([...(media?.self_hosted_videos || []), ...selfHostedVideos]);

  return {
    images: Array.from(imageSet),
    external_videos: Array.from(externalMerged),
    self_hosted_videos: Array.from(selfHostedMerged),
  };
}

async function extractNewsController(req, res) {
  let url = '';

  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Invalid extraction input',
        details: errors.array(),
      });
    }

    const requestBody = req.body || {};
    const rawText = normalizeWhitespace(requestBody.text || '');
    url = normalizeWhitespace(requestBody.url || '');

    if (rawText) {
      const cleanedText = normalizeExtractedText(rawText);
      return res.json({
        text: cleanedText,
        media: { images: [], external_videos: [], self_hosted_videos: [] },
      });
    }

    const validatedUrl = await validateExternalHttpUrl(url, {
      allowPrivateNetwork: ALLOW_PRIVATE_NETWORK_URLS,
      label: 'url',
    });

    if (!validatedUrl.ok) {
      return res.status(validatedUrl.status || 400).json({
        success: false,
        error: validatedUrl.reason || 'Invalid or unsafe URL',
      });
    }

    url = validatedUrl.normalizedUrl;

    // Redis cache stub (future use)
    // const cacheKey = buildDailyCacheKey(url);
    // const cached = await redisClient.get(cacheKey);
    // if (cached) return res.json(JSON.parse(cached));

    const siteTypeHint = (() => {
      try {
        const host = new URL(url).hostname.toLowerCase();
        if (host.includes('prothomalo') || host.includes('prothom-alo')) return 'prothomalo';
        if (host.includes('kalerkantho') || host.includes('kaler-kantho')) return 'kalerkantho';
        if (host.includes('bbc')) return 'bbc';
        if (host.includes('bdnews24')) return 'bdnews24';
        if (host.includes('dailystar')) return 'dailystar';
        return 'generic';
      } catch {
        return 'generic';
      }
    })();

    const isLowQualityExtraction = (data) => {
      if (!data?.text) return true;
      const candidateText = normalizeExtractionText(data.text);
      if (!candidateText || candidateText.length < 50) return true;
      return shouldEscalateExtraction(candidateText, data.title || data?.meta_data?.title || '');
    };
    const hasRenderableMedia = (html) => /<(figure|img|video|iframe)\b/i.test(html || '');
    const buildFallbackFigure = (image) => {
      const esc = (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      const src = typeof image === 'string' ? image : (image?.src || image?.image_url || '');
      if (!src) return '';
      const alt = esc(typeof image === 'string' ? '' : (image?.alt || image?.alt_text || extractedData?.title || ''));
      const caption = esc(typeof image === 'string' ? '' : (image?.caption || ''));
      return `<figure><img src="${esc(src)}" alt="${alt}" loading="lazy">${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;
    };

    const wantsRichMedia = siteTypeHint === 'prothomalo';

    let extractedData = await extractWithCheerio(url);
    if (isLowQualityExtraction(extractedData)) {
      extractedData = null;
    }

    const needsMediaUpgrade = wantsRichMedia
      && extractedData
      && Array.isArray(extractedData.images)
      && extractedData.images.length === 0;

    if (!extractedData || !extractedData.text || isLowQualityExtraction(extractedData) || needsMediaUpgrade) {
      const pwData = await extractWithPlaywright(url, { siteType: siteTypeHint });
      const pwHasImages = Array.isArray(pwData?.images) && pwData.images.length > 0;
      const canReplaceForMedia = needsMediaUpgrade && pwHasImages;
      if (pwData?.text && (canReplaceForMedia || !extractedData?.text || pwData.text.length >= (extractedData?.text?.length || 0))) {
        extractedData = pwData;
      }
    }

    if (!extractedData || !extractedData.text || isLowQualityExtraction(extractedData)) {
      extractedData = await extractWithAxiosOnly(url);
    }

    if (!extractedData || !extractedData.text || isLowQualityExtraction(extractedData)) {
      extractedData = await extractWithCheerio(url);
    }

    // Direct access still failing (likely bot-blocked, e.g. dhakapost.com returns a
    // flat 403) — try the Wayback Machine's cached copy before giving up entirely.
    if (!extractedData || !extractedData.text || isLowQualityExtraction(extractedData)) {
      const waybackUrl = await resolveWaybackSnapshotUrl(url);
      if (waybackUrl) {
        console.log(`🗄️ [Wayback] Direct access failed for ${url}; retrying via archived snapshot`);
        const waybackData = await extractWithCheerio(waybackUrl);
        if (waybackData?.text && !isLowQualityExtraction(waybackData)) {
          extractedData = { ...waybackData, source: 'wayback' };
        }
      }
    }

    if (!extractedData || !extractedData.text) {
      return res.status(400).json({
        success: false,
        error: 'Failed to extract news content. The site might be blocking bots or the content is too short.',
      });
    }

    let articleHtml = sanitizeArticleHtml(extractedData.html || extractedData.rawHtml || '', url);

    if (wantsRichMedia && !hasRenderableMedia(articleHtml)) {
      const pwData = await extractWithPlaywright(url, { siteType: siteTypeHint });
      const pwArticleHtml = sanitizeArticleHtml(pwData?.html || pwData?.rawHtml || '', url);
      if (pwData?.text && hasRenderableMedia(pwArticleHtml)) {
        extractedData = {
          ...extractedData,
          ...pwData,
          text: extractedData.text && extractedData.text.length >= (pwData.text || '').length
            ? extractedData.text
            : pwData.text,
        };
        articleHtml = pwArticleHtml;
      }
    }

    if (!hasRenderableMedia(articleHtml) && Array.isArray(extractedData.images) && extractedData.images.length > 0) {
      const fallbackFigure = buildFallbackFigure(extractedData.images[0]);
      if (fallbackFigure) {
        articleHtml = articleHtml.replace(/^(\s*<div class="jaani-ad-block">[\s\S]*?<\/div>\s*)+/, '');
        articleHtml = `${fallbackFigure}${articleHtml ? `\n${articleHtml}` : ''}`;
      }
    }

    const cleanedText = normalizeExtractedText(extractedData.text);
    const media = buildMediaPayload({
      html: extractedData.rawHtml || extractedData.html || '',
      url,
      images: extractedData.images || [],
      videos: extractedData.videos || [],
    });

    // Build sanitized interleaved article HTML for exact-order rendering.
    // Prefer the extracted article fragment when available, especially for JS-rendered media.
    articleHtml = articleHtml || sanitizeArticleHtml(extractedData.html || extractedData.rawHtml || '', url);

    const payload = {
      text: cleanedText,
      media,
      articleHtml,
      title: extractedData.title || '',
      subtitle: extractedData.subtitle || '',
      author: extractedData.author || '',
      publicationDate: extractedData.publicationDate || '',
      source: extractedData.source || '',
      siteName: extractedData.siteName || '',
      modifiedDate: extractedData.modifiedDate || '',
      canonicalUrl: extractedData.canonicalUrl || '',
      // True when the Live Page reader serves this outlet (READER_ALLOWLIST); the frontend
      // only offers the live view when this is set.
      proxyModeAvailable: liveProxyReader.isAllowlisted(url),
    };

    // Redis cache stub (future use)
    // await redisClient.setEx(cacheKey, 86400, JSON.stringify(payload));

    // Preserve court-grade evidence at the moment of analysis, in the background, so it exists even if the
    // publisher edits or deletes the article before a PDF is requested.
    if (url && /^https?:\/\//i.test(url)) {
      // Only the URL is handed over: the capture derives the preserved text from its own fetch.
      forensicEvidence.hasRecentCapture(url, 6 * 3600 * 1000)
        .then((recent) => recent || forensicEvidence.captureForensicEvidence({ articleUrl: url }))
        .catch((e) => console.warn('[forensic] background capture failed:', e.message));
    }

    return res.json(payload);
  } catch (error) {
    console.error('Error in /api/analyze:', error);
    return res.status(500).json({
      success: false,
      error: 'Extraction failed',
      message: error.message,
    });
  }
}

async function analyzeTextController(req, res) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Invalid analysis input',
        details: errors.array(),
      });
    }

    const requestBody = req.body || {};
    const cleanedText = normalizeExtractedText(requestBody.text || '');
    if (!cleanedText) {
      return res.status(400).json({
        success: false,
        error: 'Insufficient text content for analysis',
      });
    }

    const llmProvider = geminiAnalysis.normalizeLlmProvider(requestBody.llm_provider || requestBody.provider || 'auto');
    const sourceUrl = (requestBody.url || '').toString().trim();

    const analysis = await geminiAnalysis.analyzeQuick(cleanedText, sourceUrl, { llmProvider });

    // Hand the highlight inputs to the Live Page reader; the frontend passes the token back
    // in the reader iframe URL so the served page carries the same highlights.
    const hasSourceUrl = /^https?:\/\//i.test(sourceUrl);
    const highlightInputs = { entities: analysis.entities || [], keywords: analysis.keywords || [] };
    let readerToken = '';
    if (hasSourceUrl) {
      readerToken = liveProxyReader.setReaderPayload(sourceUrl, highlightInputs);
    }

    // Sentence salience runs AFTER the response (never delays the article or its highlights).
    // Sentences are split here so ranking and the character cap use the same boundaries.
    const urlHash = readerToken;
    const sentences = urlHash ? salienceEnsemble.splitBengaliSentences(cleanedText) : [];
    if (urlHash && sentences.length) {
      salienceStore.set(urlHash, { pending: true, startedAt: Date.now() });
    }

    res.json({
      success: true,
      data: {
        ...analysis,
        extractedText: cleanedText,
        reader_token: readerToken,
        url_hash: urlHash,
        salience_pending: Boolean(urlHash && sentences.length),
      },
    });

    if (urlHash && sentences.length) {
      setImmediate(async () => {
        try {
          const result = await salienceEnsemble.runSalience(cleanedText, sentences, highlightInputs);
          salienceStore.set(urlHash, {
            sentenceHighlights: result.sentences,
            ratio: result.ratio,
            providerCount: result.providerCount,
            providers: result.providers,
            perProvider: result.perProvider,
            mergedTop3: result.mergedTop3,
            readyAt: Date.now(),
          });
          if (result.sentences.length) {
            liveProxyReader.setReaderPayload(sourceUrl, { ...highlightInputs, sentenceHighlights: result.sentences });
          }
        } catch (e) {
          console.error('[salience] ensemble failed:', e.message);
          salienceStore.set(urlHash, { sentenceHighlights: [], ratio: 0, providerCount: 0, error: e.message, readyAt: Date.now() });
        }
      });
    }
    return undefined;
  } catch (error) {
    console.error('Error in /api/analyze-text:', error);
    return res.status(500).json({
      success: false,
      error: 'Analysis failed',
      message: error.message,
    });
  }
}

async function extractEntitiesController(req, res) {
  try {
    const text = (req.body?.text || '').toString();
    if (!text.trim()) {
      return res.status(400).json({
        success: false,
        error: "Missing or invalid 'text' field. Send JSON: {text: 'Bengali news'}",
        timestamp: new Date().toISOString(),
      });
    }

    const startedAt = Date.now();
    const extracted = await geminiAnalysis.extractBengaliGovernmentEntities(text, {
      llmProvider: geminiAnalysis.normalizeLlmProvider(req.body?.llm_provider || 'auto'),
    });
    const extractedWithTiming = {
      ...extracted,
      elapsed_ms: Date.now() - startedAt,
    };

    const enriched = await rtiLookup.enrichWithRTIDatabase(extractedWithTiming, { articleText: text });

    return res.json({
      success: extractedWithTiming.status === 'success',
      extracted: extractedWithTiming,
      enriched,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error in /api/extract-entities:', error);
    return res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * POST /api/rti-guidance { text, title?, llm_provider? }
 * RTI Act 2009 guidance for the RTI officer card: routing (s.10), deadlines (s.9), s.32 / s.7 flags,
 * fixed notes (s.6(3)(d), s.9(6)–(7), s.9(2)), suggested questions, money mentions.
 * Called after /api/analyze-text so its LLM calls never delay the article or the analysis.
 */
router.post('/rti-guidance', [
  body('text').isString().isLength({ min: 20 }),
  body('title').optional().isString(),
  body('llm_provider').optional().isString(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, error: 'text is required' });
  try {
    const guidance = await rtiActGuidance.buildRtiGuidance({
      text: normalizeExtractedText(req.body.text),
      title: String(req.body.title || '').slice(0, 500),
      llmProvider: geminiAnalysis.normalizeLlmProvider(req.body.llm_provider || 'auto'),
      run: geminiAnalysis.runPromptWithProvider,
    });
    return res.json({ success: true, guidance });
  } catch (error) {
    console.error('Error in /api/rti-guidance:', error.message);
    return res.status(500).json({ success: false, error: 'RTI guidance failed' });
  }
});

/**
 * POST /api/rti-application-draft
 * Composes a customized draft of the official RTI Form "ক" (RTI Rules 2009, rule 3) for Section
 * 4's compose body -- populated per-article, not a generic template. Item ২ ("কি ধরণের তথ্য") is
 * generated fresh by an LLM (rtiActGuidance.generateSuggestedQuestions) from the specific news
 * text every call; the officer/office fields come from the CSV row Section 3 already resolved
 * (never re-derived here); applicant fields come from the composer (never stored server-side).
 * Input: { text, office: {Office,Division,Ministry,Website_Link,Primary_Officer_Name,
 *          Primary_Designation,Primary_Email,Alternate_Officer_Name,Alternate_Designation,
 *          Alternate_Email}, applicant: {name,fatherName,motherName,address,email,phone,
 *          citizenship}, llm_provider? }
 * Output: { success, bodyText, bodyHtml, questions }
 */
router.post('/rti-application-draft', [
  body('text').isString().isLength({ min: 20 }),
  body('office').isObject(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, error: 'text and office are required' });
  }
  try {
    const office = req.body.office || {};
    const applicant = req.body.applicant || {};
    const authority = (office.Office || office.Division || office.Ministry || '').toString().trim();
    const text = normalizeExtractedText(req.body.text);
    const llmProvider = geminiAnalysis.normalizeLlmProvider(req.body.llm_provider || 'auto');

    // Both checks are independent LLM calls against the actual Act text (section 8(2)'s request
    // requirements for the questions themselves; section 7's exemption categories as a second,
    // independent pass over the SAME news) -- run in parallel, never block one on the other.
    const [{ questions }, section7] = await Promise.all([
      rtiActGuidance.generateSuggestedQuestions(geminiAnalysis.runPromptWithProvider, { text, authority, llmProvider }),
      rtiActGuidance.checkSection7Exemption(geminiAnalysis.runPromptWithProvider, { text, authority, llmProvider }),
    ]);

    const { bodyText, bodyHtml } = buildFormKaDraft({ office, applicant, questions });
    return res.json({
      success: true,
      bodyText,
      bodyHtml,
      questions,
      section7: section7?.flags?.length ? { flags: section7.flags } : null,
    });
  } catch (error) {
    console.error('Error in /api/rti-application-draft:', error.message);
    return res.status(500).json({ success: false, error: 'Draft generation failed' });
  }
});

/**
 * GET /api/salience-status?urlHash=<hash>
 * 200 {ready:true, sentenceHighlights, ratio, providerCount} · 202 {ready:false} while running · 404 unknown hash
 */
router.get('/salience-status', (req, res) => {
  const urlHash = typeof req.query.urlHash === 'string' ? req.query.urlHash : '';
  const entry = urlHash ? salienceStore.get(urlHash) : null;
  res.set('Cache-Control', 'no-store');
  if (!entry) return res.status(404).json({ ready: false });
  if (entry.pending) return res.status(202).json({ ready: false });
  return res.json({
    ready: true,
    sentenceHighlights: entry.sentenceHighlights || [],
    ratio: entry.ratio || 0,
    providerCount: entry.providerCount || 0,
    providers: entry.providers || [],
    perProvider: entry.perProvider || {},
    mergedTop3: entry.mergedTop3 || [],
  });
});

/**
 * POST /api/reader-payload  { url, entities, keywords, sentenceHighlights }
 * Browser-cache hit: the Live Page reader only keeps highlight inputs in memory for 10 minutes,
 * so the frontend hands back what it cached. Allowlisted outlets only, size-capped, and never
 * overwrites a payload the server still holds. Highlights only wrap text already on the page.
 */
router.post('/reader-payload', (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!url || !liveProxyReader.isAllowlisted(url)) return res.status(400).json({ success: false, error: 'url not on reader allowlist' });
  const token = liveProxyReader.tokenForUrl(url);
  if (liveProxyReader.getReaderPayload(token)) return res.json({ success: true, token, kept: 'server' });
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const entities = (Array.isArray(req.body.entities) ? req.body.entities : []).slice(0, 60)
    .map((e) => ({ text: str(e?.text || e?.name, 200), label: str(e?.label || e?.type, 20) }))
    .filter((e) => e.text);
  const keywords = (Array.isArray(req.body.keywords) ? req.body.keywords : []).slice(0, 40).map((k) => str(k, 100)).filter(Boolean);
  const sentenceHighlights = (Array.isArray(req.body.sentenceHighlights) ? req.body.sentenceHighlights : []).slice(0, 60).map((x) => str(x, 600)).filter(Boolean);
  liveProxyReader.setReaderPayload(url, { entities, keywords, sentenceHighlights });
  return res.json({ success: true, token, kept: 'client' });
});

router.get('/llm-status', async (_req, res) => {
  try {
    const report = await geminiAnalysis.getLiveProviderStatusReport();
    return res.json({ success: true, ...report });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve LLM status',
      message: error.message,
    });
  }
});


/*
*/

async function fetchRelatedSourcesGoogleNewsRss({ title, language = 'en', region = 'global', limit = 8, timeoutMs = 6000 }) {
  const cleanTitle = (title || '').toString().replace(/\s+/g, ' ').trim();
  if (cleanTitle.length < 8) return [];

  // Avoid fetching "related" links for placeholder / error titles.
  const titleLower = cleanTitle.toLowerCase();
  if (
    titleLower.includes('not found') ||
    titleLower.includes('404') ||
    titleLower.includes('untitled')
  ) {
    return [];
  }

  const shortTitle = cleanTitle.split(' ').slice(0, 14).join(' ');

  const isBangla = (language || '').toLowerCase().startsWith('bn') || /[\u0980-\u09FF]/.test(cleanTitle);
  const hl = isBangla ? 'bn' : 'en-US';
  const gl = isBangla ? 'BD' : 'US';
  const ceid = isBangla ? 'BD:bn' : 'US:en';

  const q = encodeURIComponent(`"${shortTitle}"`);
  const rssUrl = `https://news.google.com/rss/search?q=${q}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;

  const resp = await axios.get(rssUrl, {
    timeout: timeoutMs,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5',
    },
    responseType: 'text',
  });

  const $ = cheerio.load(resp.data, { xmlMode: true });
  const items = [];

  $('item').each((_, el) => {
    if (items.length >= limit) return;
    const $el = $(el);
    const itemTitle = ($el.find('title').first().text() || '').trim();
    const link = ($el.find('link').first().text() || '').trim();
    const source = ($el.find('source').first().text() || '').trim();
    if (!itemTitle || !link) return;

     // Filter out low-signal/non-news sources.
     const sourceLower = (source || '').toLowerCase();
     const linkLower = link.toLowerCase();
     if (sourceLower.includes('facebook') || linkLower.includes('facebook.com')) return;
     if (sourceLower.includes('youtube') || linkLower.includes('youtube.com')) return;
    items.push({ title: itemTitle, url: link, source: source || 'Google News' });
  });

  // De-dupe by url/title.
  const dedup = [];
  const seen = new Set();
  for (const it of items) {
    const key = `${(it.url || '').toLowerCase()}::${(it.title || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(it);
  }
  return dedup;
}



function withTimeout(promise, timeoutMs, fallback = null) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}


router.post('/analyze', analyzeValidators, extractNewsController);
router.post('/fetch-and-analyze', analyzeValidators, extractNewsController);
router.post('/analyze-text', analyzeTextValidators, analyzeTextController);
router.post('/extract-entities', extractEntitiesController);

// -------------------------------------------------------------------------------
// IMAGE PROXY - Bypass hotlink protection / CORS for news-site images
// -------------------------------------------------------------------------------
/**
 * ? Endpoint: GET /api/proxy-image
 * Purpose: Fetch images server-side with proper referer/headers so CDNs don't
 *          return 403.  The frontend `<img>` tags point here instead of to the
 *          original CDN URL.
 * Query:   url=<encoded_image_url>
 * Output:  Raw image bytes with correct Content-Type.
 */
const imageProxyCache = new Map(); // simple in-memory dedup (url ? {buf, ct, ts})
const IMAGE_PROXY_CACHE_TTL = 30 * 60 * 1000; // 30 min

router.get('/proxy-image', async (req, res) => {
  const { url: rawImgUrl } = req.query;
  if (!rawImgUrl) return res.status(400).send('Missing url parameter');

  try {
    const validated = await validateExternalHttpUrl(String(rawImgUrl), {
      allowPrivateNetwork: ALLOW_PRIVATE_NETWORK_URLS,
      label: 'url',
    });
    if (!validated.ok) {
      return res.status(validated.status || 400).send(validated.reason || 'Invalid image URL');
    }

    const imgUrl = validated.normalizedUrl;
    const parsed = new URL(imgUrl);

    // Check cache
    const cached = imageProxyCache.get(imgUrl);
    if (cached && Date.now() - cached.ts < IMAGE_PROXY_CACHE_TTL) {
      res.setHeader('Content-Type', cached.ct);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.send(cached.buf);
    }

    const agentConfig = getAxiosAgentConfigForUrl(imgUrl, {
      allowInsecureGovTls: ALLOW_INSECURE_GOV_TLS,
    });

    const resp = await axios.get(imgUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 5,
      maxContentLength: MAX_PROXY_IMAGE_BYTES,
      maxBodyLength: MAX_PROXY_IMAGE_BYTES,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8',
        'Referer': parsed.origin + '/',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'same-origin',
      },
      ...agentConfig,
    });

    const contentType = resp.headers['content-type'] || 'image/jpeg';
    if (!/^image\//i.test(contentType)) {
      return res.status(415).send('Remote URL did not return an image');
    }

    // Prevent SVG script injection through proxy payload.
    if (/image\/svg\+xml/i.test(contentType)) {
      return res.status(415).send('SVG images are not allowed');
    }

    const buf = Buffer.from(resp.data);
    if (buf.length > MAX_PROXY_IMAGE_BYTES) {
      return res.status(413).send('Image is too large');
    }

    // Cache (limit to 200 entries to avoid memory leak)
    if (imageProxyCache.size > 200) {
      const oldest = [...imageProxyCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) imageProxyCache.delete(oldest[0]);
    }
    imageProxyCache.set(imgUrl, { buf, ct: contentType, ts: Date.now() });

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(buf);
  } catch (err) {
    console.warn(`?? [PROXY-IMAGE] Failed for ${rawImgUrl}: ${err.message}`);
    // Return a transparent 1�1 pixel so the UI doesn't break
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(pixel);
  }
});

// -------------------------------------------------------------------------------
// IFRAME PROXY — Bypasses X-Frame-Options / CSP so news articles embed cleanly
// -------------------------------------------------------------------------------
/**
 * GET /api/wayback-url?url=<encoded_article_url>
 *
 * Queries the Wayback Machine Availability API to find the most recent archived
 * snapshot for the given URL.  Returns {available, wayback_url, timestamp} so
 * the frontend can offer a cached embed that bypasses all site-level X-Frame-Options.
 */
router.get('/wayback-url', async (req, res) => {
  const { url: rawUrl } = req.query;
  if (!rawUrl || typeof rawUrl !== 'string') {
    return res.status(400).json({ available: false, error: 'Missing url parameter' });
  }

  let pageUrl;
  try {
    // Express has already decoded the query string; decoding again would corrupt URLs containing %xx.
    const u = new URL(rawUrl);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Non-HTTP');
    pageUrl = u.href;
  } catch {
    return res.status(400).json({ available: false, error: 'Invalid URL' });
  }

  // Same CDX lookup as extraction (the "available" API was flaky and timed out in testing).
  const snapshot = await findLatestWaybackSnapshot(pageUrl, { timeoutMs: 10000 });
  if (snapshot) {
    console.log(`🗄️ [Wayback] viewer snapshot for ${pageUrl}: ${snapshot.timestamp}`);
    return res.json({
      available: true,
      wayback_url: `https://web.archive.org/web/${snapshot.timestamp}/${snapshot.original}`,
      timestamp: snapshot.timestamp,
    });
  }

  // No snapshot found (or CDX unreachable in 10s): best-effort URL — web.archive.org
  // redirects to the closest capture, or shows its calendar if there is none.
  return res.json({
    available: false,
    wayback_url: `https://web.archive.org/web/${pageUrl}`,
    timestamp: '',
  });
});

/**
 * GET /api/proxy-iframe?url=<encoded_page_url>
 * Kept for old links: redirects to the separate-origin reader (GET <reader>/read?url=...).
 */
// Untrusted third-party pages must never be served from this (the app's) origin.
// The reader runs on its own origin (services/liveProxyReader.js); this route only redirects there.
router.get('/proxy-iframe', (req, res) => {
  const { url: rawUrl } = req.query;
  if (!rawUrl || typeof rawUrl !== 'string') {
    return res.status(400).send('Missing url parameter');
  }
  return res.redirect(302, liveProxyReader.buildReaderUrl(rawUrl));
});

/**
 * ? Endpoint: POST /api/download-pdf
 * Purpose: Generate a PDF that reliably opens in browsers/viewers
 * Input: { url: string, type?: 'article'|'summary', language?: string, region?: string }
 */
router.post('/download-pdf', [
  body('url').isURL().withMessage('Invalid URL format'),
  body('type').optional().isIn(['article', 'summary']).withMessage('Invalid type')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors.array()
      });
    }

    let { url, type = 'article', language = 'en', region = 'global', enrichedData } = req.body;

    const validatedUrl = await validateExternalHttpUrl(String(url || ''), {
      allowPrivateNetwork: ALLOW_PRIVATE_NETWORK_URLS,
      label: 'url',
    });
    if (!validatedUrl.ok) {
      return res.status(validatedUrl.status || 400).json({
        success: false,
        error: validatedUrl.reason || 'Invalid or unsafe URL',
      });
    }
    url = validatedUrl.normalizedUrl;

    const options = { language, region };

    let cached = await historyManager.getCachedResult(url, options)
      || await historyManager.getLatestCachedResultByUrl(url);

    // Fall back to what the client already has on screen when nothing is cached server-side.
    const clientArticleHtml = typeof req.body.articleHtml === 'string' ? req.body.articleHtml : '';
    if (!cached && (clientArticleHtml || enrichedData?.summary)) {
      cached = {
        articleHtml: clientArticleHtml,
        title: String(req.body.title || enrichedData?.metadata?.title || ''),
        summary: enrichedData?.summary || '',
        meta_data: { ...(enrichedData?.metadata || {}), source: url },
      };
    }

    if (!cached) {
      return res.status(404).json({
        success: false,
        error: 'No cached analysis found for this URL. Analyze first, then download.'
      });
    }

    if (type === 'article' && !cached.articleHtml) {
      return res.status(409).json({
        success: false,
        error: 'Cached analysis does not contain article HTML. Please re-run Analyze, then download again.'
      });
    }

    // Build enriched data: prefer frontend-sent data, fall back to cached analysis
    const cachedEntities = cached.entities || [];
    const cachedPersons = cachedEntities.filter(e => {
      const t = (typeof e === 'string' ? '' : (e.label || e.type || '')).toUpperCase();
      return t === 'PERSON' || t === 'PER';
    }).map(e => typeof e === 'string' ? e : e.text);
    const cachedOrgs = cachedEntities.filter(e => {
      const t = (typeof e === 'string' ? '' : (e.label || e.type || '')).toUpperCase();
      return t === 'ORG' || t === 'ORGANIZATION';
    }).map(e => typeof e === 'string' ? e : e.text);
    const cachedLocations = cachedEntities.filter(e => {
      const t = (typeof e === 'string' ? '' : (e.label || e.type || '')).toUpperCase();
      return t === 'GPE' || t === 'LOC' || t === 'LOCATION';
    }).map(e => typeof e === 'string' ? e : e.text);

    const mergedEnrichedData = {
      summary: enrichedData?.summary || cached.summary || '',
      highlights: enrichedData?.highlights || cached.highlights || [],
      category: enrichedData?.category || cached.category || '',
      categoryConfidence: enrichedData?.categoryConfidence || cached.category_confidence || 0,
      persons: enrichedData?.persons || cachedPersons,
      organizations: enrichedData?.organizations || cachedOrgs,
      locations: enrichedData?.locations || cachedLocations,
      keywords: enrichedData?.keywords || cached.keywords || [],
      relatedGovOrgs: enrichedData?.relatedGovOrgs || cached.mentioned_gov_orgs || cached.related_offices || [],
      rtiTargetOffice: enrichedData?.rtiTargetOffice || cached.rti_target_office || '',
      ministryReasoning: enrichedData?.ministryReasoning || cached.ministry_reasoning || '',
      relatedSources: enrichedData?.relatedSources || (cached.related_sources || []).map(s => ({
        title: s?.title || 'Source', url: s?.url || s?.link || '', source: s?.source || '',
      })),
      sameStory: Array.isArray(enrichedData?.sameStory) ? enrichedData.sameStory.slice(0, 10) : undefined,
      relatedNews: Array.isArray(enrichedData?.relatedNews) ? enrichedData.relatedNews.slice(0, 10) : undefined,
      factChecks: Array.isArray(enrichedData?.factChecks) ? enrichedData.factChecks.slice(0, 6) : [],
      mentionedGovOrgs: enrichedData?.mentionedGovOrgs || cached.mentioned_gov_orgs || [],
      entityStats: enrichedData?.entityStats || {},
      metadata: enrichedData?.metadata || {},
      language: enrichedData?.language || cached.language || '',
      analysisSource: enrichedData?.analysisSource || cached.ml_source || '',
    };

    // Court-grade evidence: reuse the capture made when the article was first analysed (earliest proof of
    // publication); otherwise capture now, synchronously, from the server's own fetch. The client's
    // articleText/articleHtml are display material for the summary page only — they are NEVER the source
    // of evidence: a new capture receives only the URL, and the certificate's preserved text is read
    // from the vault. A capture that shows the page is gone (404/410) is evidence too.
    const clientText = typeof req.body.articleText === 'string' ? req.body.articleText : '';
    let forensic = null;
    try {
      forensic = await forensicEvidence.getForensicEvidenceForUrl(url);
      if (!forensic) {
        console.log(`[PDF] no evidence capture for ${url} yet — capturing now from the server's own fetch`);
        forensic = await forensicEvidence.captureForensicEvidence({ articleUrl: url });
      } else if (forensic.incomplete
        && Date.now() - new Date(forensic.newest_capture_at_utc || forensic.captured_at_utc).getTime() > 5 * 60 * 1000) {
        // Only incomplete captures exist (made while the network or the browser was down): try again,
        // at most once every 5 minutes, then use the earliest complete capture if there is one now.
        console.log(`[PDF] only incomplete evidence captures for ${url} — capturing again`);
        await forensicEvidence.captureForensicEvidence({ articleUrl: url }).catch((e) => console.warn('[PDF] re-capture failed:', e.message));
        forensic = await forensicEvidence.getForensicEvidenceForUrl(url);
      }
    } catch (forensicErr) {
      console.warn('[PDF] forensic evidence unavailable:', forensicErr.message);
    }

    const screenshots = forensic?.capture_id ? await loadEvidenceScreenshots(forensic) : [];
    // Preserved text comes only from the vault file of that capture (hashed in its manifest).
    let evidenceArticleText = '';
    if (forensic?.capture_id) {
      try { evidenceArticleText = await fs.readFile(path.join(evidenceVault.VAULT_DIR, forensic.capture_id, 'extracted_article_text.txt'), 'utf8'); } catch { evidenceArticleText = ''; }
    }
    // Divergence check: the client's copy vs. the capture's own text. Logged and reported in a header;
    // neither is silently preferred (the certificate always uses the capture's text).
    const textDivergence = compareEvidenceText(clientText, evidenceArticleText);
    if (textDivergence && !textDivergence.match) {
      console.warn(`[PDF] client article text diverges from evidence capture ${forensic?.capture_id}: `
        + `client sha256 ${textDivergence.clientSha256.slice(0, 16)}… vs capture ${textDivergence.captureSha256.slice(0, 16)}…, `
        + `token overlap ${textDivergence.tokenOverlap}`);
    }

    // Header title/date: from the evidence capture when there is one (the client's copy is display-only).
    const pdfHtml = buildPdfHtml({
      type,
      title: forensic?.title || cached.title || cached?.meta_data?.title || 'News',
      sourceUrl: cached?.meta_data?.source || url,
      meta: { ...(cached?.meta_data || {}), ...(forensic?.published_date ? { date: forensic.published_date } : {}) },
      articleHtml: cached.articleHtml,
      summary: cached.summary,
      legalProof: cached.legalProof,
      enrichedData: mergedEnrichedData,
      forensicHtml: buildForensicHtml(forensic, { screenshots, articleText: evidenceArticleText, includeText: type === 'summary' }),
    });

    const pdfBuffer = await renderPdfBufferFromHtml(pdfHtml, {
      footerLabel: forensic?.capture_id ? `JAANI evidence ${forensic.capture_id} - manifest SHA-256 ${forensic.manifest_sha256 || ''}`.slice(0, 190) : '',
    });
    res.setHeader('X-Evidence-Capture-Id', forensic?.capture_id || '');
    res.setHeader('X-Evidence-Text-Source', forensic?.text_source || (forensic ? 'unrecorded' : 'none'));
    if (textDivergence) {
      res.setHeader('X-Evidence-Client-Text-Match', textDivergence.match ? 'true' : `false; overlap=${textDivergence.tokenOverlap}`);
    }
    const pdfSha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    res.setHeader('X-PDF-SHA256', pdfSha256);

    // The default download is ONE combined PDF (summary + full evidence certificate + both
    // screenshots + preserved text + custody log + verification steps). The raw capture files are
    // only needed to re-verify hashes independently: format:'zip' returns them with the PDF, and
    // GET /api/evidence/<capture id>/bundle.zip returns them on their own.
    if (forensic?.capture_id && req.body.format === 'zip') {
      const zipBuffer = await buildEvidenceZip(forensic, pdfBuffer, pdfSha256);
      let domain = 'article';
      try { domain = new URL(forensic.article_url || url).hostname.replace(/^www\./, ''); } catch { /* keep default */ }
      const day = String(forensic.captured_at_utc || new Date().toISOString()).slice(0, 10).replace(/-/g, '');
      const zipName = `JAANI_evidence_${domain.replace(/[^a-z0-9.-]/gi, '_')}_${day}_${forensic.capture_id.slice(0, 8)}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
      res.setHeader('Content-Length', zipBuffer.length);
      return res.status(200).send(zipBuffer);
    }

    const filenameBase = sanitizeFilename((cached.title || cached?.meta_data?.domain || 'news') + '_' + type);
    const utf8Filename = `${filenameBase}.pdf`;
    const asciiFilename = utf8Filename
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'news.pdf';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(utf8Filename)}`
    );
    res.setHeader('Content-Length', pdfBuffer.length);
    return res.status(200).send(pdfBuffer);
  } catch (error) {
    console.error('? Error generating PDF:', error);
    return res.status(500).json({
      success: false,
      error: 'PDF generation failed',
      message: error.message
    });
  }
});

/**
 * ? Endpoint: POST /api/download-html
 * Purpose: Generate an HTML file with embedded CSS for offline viewing
 * Input: { url: string, type?: 'article'|'summary'|'live', language?: string, region?: string }
 */
router.post('/download-html', [
  body('url').isURL().withMessage('Invalid URL format'),
  body('type').optional().isIn(['article', 'summary', 'live']).withMessage('Invalid type')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors.array()
      });
    }

    let { url, type = 'live', language = 'en', region = 'global' } = req.body;

    const validatedUrl = await validateExternalHttpUrl(String(url || ''), {
      allowPrivateNetwork: ALLOW_PRIVATE_NETWORK_URLS,
      label: 'url',
    });
    if (!validatedUrl.ok) {
      return res.status(validatedUrl.status || 400).json({
        success: false,
        error: validatedUrl.reason || 'Invalid or unsafe URL',
      });
    }
    url = validatedUrl.normalizedUrl;
    
    // If requesting 'live' or 'article' with design, we fetch the full page with proxying
    // This ensures CSS/Images/Scripts (that are compatible) are 'imported' via absolute links
    if (type === 'live' || type === 'article') {
      try {
        const { html: fullHtml } = await fetchAndProxyWebpage(url);
        
        const filenameBase = sanitizeFilename(new URL(url).hostname);
        const utf8Filename = `${filenameBase}_full.html`;
        const asciiFilename = utf8Filename.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim() || 'page.html';

        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(utf8Filename)}`);
        return res.send(fullHtml);
        
      } catch (proxyError) {
        console.warn('?? Direct proxy fetch passed to download failed, falling back to cache:', proxyError.message);
        // Fallback to cache logic below
      }
    }

    // ... Fallback or 'summary' type logic using Cache ...
    const options = { language, region };
    const cached = await historyManager.getCachedResult(url, options)
      || await historyManager.getLatestCachedResultByUrl(url);

    if (!cached) {
      return res.status(404).json({
        success: false,
        error: 'No content found. Please Refresh/Analyze first.'
      });
    }

    const fullHtml = buildPdfHtml({
      type,
      title: cached.title || cached?.meta_data?.title || 'News',
      sourceUrl: cached?.meta_data?.source || url,
      meta: cached?.meta_data,
      articleHtml: cached.articleHtml || '<div>No content available</div>',
      summary: cached.summary,
      legalProof: cached.legalProof,
    });

    const filenameBase = sanitizeFilename((cached.title || cached?.meta_data?.domain || 'news') + '_' + type);
    const utf8Filename = `${filenameBase}.html`;
    const asciiFilename = utf8Filename
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'news.html';

    // Return HTML content
    res.setHeader('Content-Type', 'text/html');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(utf8Filename)}`
    );
    res.send(fullHtml);

  } catch (error) {
    console.error('? Error generating HTML:', error);
    return res.status(500).json({
      success: false,
      error: 'HTML generation failed',
      message: error.message
    });
  }
});

const WEBSITE_LINK_MAX_WAIT_MS = parseInt(process.env.WEBSITE_LINK_MAX_WAIT_MS || '7000', 10);

async function runWebsiteLinkTask(taskFn, fallbackValue, taskLabel = 'website_link_task') {
  const timeoutSentinel = { timedOut: true };
  try {
    const result = await withTimeout(
      Promise.resolve().then(taskFn),
      WEBSITE_LINK_MAX_WAIT_MS,
      timeoutSentinel,
    );

    if (result === timeoutSentinel) {
      console.warn(`?? [VERIFY] ${taskLabel} exceeded ${WEBSITE_LINK_MAX_WAIT_MS}ms; using existing data.`);
      return fallbackValue;
    }

    return result;
  } catch (err) {
    console.warn(`?? [VERIFY] ${taskLabel} failed (${err?.message || err}); using existing data.`);
    return fallbackValue;
  }
}

/**
 * Merge a structural scrape of the office's own RTI page into a record (Section 3, brief 15.2/15.3/R3):
 * canonical *_Officer_Name keys stay in step with the working keys, text that fails the integrity gate is dropped
 * and reported, and photos come only from the page's own per-role blocks, for roles that have a name.
 */
function applyScrapedOfficers(enriched, scraped, integrityWarnings = []) {
  const roles = [
    ['primary', 'Primary', 'Primary_Officer', 'Primary_Officer_Name'],
    ['alternate', 'Alternate', 'Alternate_Officer', 'Alternate_Officer_Name'],
    ['appellate', 'Appellate', 'Appellate_Officer', 'Appellate_Officer_Name'],
  ];
  for (const [role, prefix, workKey, csvKey] of roles) {
    const table = scraped[role] || {};
    const fields = {
      name: pickOfficerTableField(table, 'name'),
      Designation: pickOfficerTableField(table, 'designation'),
      Phone: pickOfficerTableField(table, 'phone'),
      Mobile: pickOfficerTableField(table, 'mobile'),
      Email: pickOfficerTableField(table, 'email'),
      Address: pickOfficerTableField(table, 'address'),
    };
    for (const [k, v] of Object.entries(fields)) {
      if (v && !textIntegrity.isStorable(v)) {
        integrityWarnings.push({ field: `${prefix}_${k === 'name' ? 'Officer_Name' : k}`, class: textIntegrity.classifyText(v), value: String(v).slice(0, 120) });
        fields[k] = '';
      }
    }
    if (fields.name) {
      enriched[workKey] = fields.name;
      enriched[csvKey] = fields.name;
      if (role === 'appellate') enriched.Appellate_Name = fields.name;
    }
    // A role with no officer name carries no contact details: writing them anyway is how another role's phone,
    // e-mail and address leak into an empty slot (lawjusticediv.gov.bd has no primary officer, but its alternate's
    // details were landing in Primary_*). Photos were already name-gated below; these fields must be too.
    const namedRole = Boolean(fields.name || enriched[workKey] || enriched[csvKey]
      || (role === 'appellate' && enriched.Appellate_Name));
    for (const k of ['Designation', 'Phone', 'Mobile', 'Email', 'Address']) {
      if (fields[k] && namedRole) enriched[`${prefix}_${k}`] = fields[k];
    }
    const hasName = Boolean(enriched[workKey] || enriched[csvKey] || (role === 'appellate' && enriched.Appellate_Name));
    const photo = hasName && fields.name ? (scraped[`${role}Photo`] || '') : '';
    // A scrape that found this role's officer decides the photo: the page's own photo, or none. The previous photo
    // may belong to a previous officer, so it is not kept when the page shows no photo for the named officer.
    if (fields.name) {
      enriched[`${prefix}_Photo`] = photo;
      enriched[`${prefix}_Image_URL`] = photo;
    }
  }
  enriched.Discovered_Office_Links = scraped.discoveredLinks || [];
  if (scraped.legacyFontPage) {
    integrityWarnings.push({ field: 'page', class: 'BIJOY_ANSI', value: 'legacy-font (Bijoy) text on the officer page' });
  }
  return enriched;
}

async function syncVerifiedRecordToCsv(record = {}, options = {}) {
  if (!record || typeof record !== 'object') return null;

  const normalized = toNormalizedOfficerRecord(
    record,
    record.Primary_Photo || record.photo || record.image || record.image_url || ''
  );

  const bestIdentifier = [
    normalized.Primary_Mobile,
    normalized.Primary_Email,
    normalized.Alternate_Mobile,
    normalized.Alternate_Email,
    normalized.Appellate_Mobile,
    normalized.Appellate_Email,
  ]
    .map((v) => (v || '').toString().trim())
    .find(Boolean) || '';

  try {
    const csvResult = contactLoader.upsertContactInCsv(normalized, {
      mode: 'auto-reconcile',
      allowInsert: true,
      originalIdentifier: options.originalIdentifier || bestIdentifier,
      requestedOffice: options.requestedOffice || normalized.office_name || '',
      minMatchScore: 130,
    });

    if (csvResult?.success && (csvResult.updated || csvResult.inserted)) {
      console.log(`? [VERIFY] CSV sync ${csvResult.inserted ? 'inserted' : 'updated'}: ${csvResult.path}`);
    }
    return csvResult;
  } catch (err) {
    console.warn(`?? [VERIFY] CSV sync failed: ${err?.message || err}`);
    return null;
  }
}

/**
 * GET /api/offices-list
 * Every distinct (Ministry, Division, Office) row in the CSV, for Section 3's browse/multi-select
 * dropdown -- lets a user pick an office directly instead of having to know its exact spelling to
 * type into the search bar. Same authoritative dataset the rest of Section 3 resolves against.
 */
router.get('/offices-list', (req, res) => {
  try {
    const contacts = contactLoader.contacts;
    const seen = new Set();
    const list = [];
    for (const c of contacts) {
      const ministry = (c.Ministry || '').toString().trim();
      const division = (c.Division || '').toString().trim();
      const office = (c.Office || '').toString().trim();
      if (!office) continue;
      const key = `${ministry}|${division}|${office}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ ministry, division, office });
    }
    list.sort((a, b) => a.ministry.localeCompare(b.ministry, 'bn') || a.office.localeCompare(b.office, 'bn'));
    res.json({ success: true, count: list.length, offices: list });
  } catch (error) {
    console.error('❌ Error in /offices-list:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch offices list' });
  }
});

/**
 * ? Endpoint 2: POST /api/verify-contact
 * Purpose: Find the RTI officer record(s) for an office, optionally live-scraping the
 * government website (enrich_web:true, or automatically when the stored row has gaps) and
 * writing any newly-confirmed data back to the CSV.
 * Input: { office_name: string, enrich_web?: boolean, llm_provider?: string, mlAnalysis?: object }
 * Output: { success, matches[], liveScrapedRecords[], discrepancies_by_match[], databaseRecord,
 *           liveScrapedRecord, discrepancies, ... } -- see buildLiveScrapedRecord/
 *           computeOfficerDiscrepancies above for how the live-vs-database diff is computed.
 * `discrepancies`/`discrepancies_by_match` entries are `null` (not a fabricated all-false object)
 * whenever no live scrape actually ran for that match, or nothing was comparable field-by-field.
 * VerificationGrid.js highlights any flagged field in red.
 */
router.post('/verify-contact', [
  body('office_name').notEmpty().withMessage('office_name is required'),
  body('llm_provider').optional().isString()
], async (req, res) => {
  const officeResolution = require('../utils/officeResolution');
  let rtiGazetteer;
  try { rtiGazetteer = require('../services/rtiGazetteer'); } catch { rtiGazetteer = null; }

  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const { office_name, enrich_web = false, llm_provider = 'auto', mlAnalysis = {} } = req.body;
    const llmProvider = geminiAnalysis.normalizeLlmProvider(llm_provider);
    const integrityWarnings = [];

    console.log(`\n🔍 [VERIFY] Searching for contact: ${office_name}`);
    console.log(`   Enrich from web: ${enrich_web}`);
    console.log(`   LLM provider: ${llmProvider}`);

    const emptyOfficerSlots = {
      primary_found: false,
      alternate_found: false,
      appellate_found: false,
    };

    const contacts = contactLoader.contacts;

    // ═══ NEW SECTION 3 LOGIC ═══
    // Collect detected organizations from Section 2's analysis + the requested office_name
    const detectedOrgs = [];
    // Add all government bodies detected by Section 2
    const govBodies = Array.isArray(mlAnalysis?.gov_body_matches)
      ? mlAnalysis.gov_body_matches
      : [];
    const mentionedOrgs = Array.isArray(mlAnalysis?.mentioned_gov_orgs)
      ? mlAnalysis.mentioned_gov_orgs
      : [];
    const enrichedEntities = Array.isArray(mlAnalysis?.enriched_entities)
      ? mlAnalysis.enriched_entities.map((e) => typeof e === 'string' ? e : (e?.databaseMatch?.office || e?.originalEntity || ''))
      : [];

    // Merge all detected orgs, preserving order, deduplicated
    const seen = new Set();
    for (const list of [govBodies, mentionedOrgs, enrichedEntities]) {
      for (const name of list) {
        const trimmed = (name || '').toString().trim();
        const key = officeResolution.normalizeText(trimmed);
        if (key && !seen.has(key)) {
          seen.add(key);
          detectedOrgs.push(trimmed);
        }
      }
    }

    // Also add the office_name segments (for manual / direct requests). The whole raw string is
    // tried FIRST, before splitting on comma/semicolon/pipe/newline: at least 5 of the CSV's 44
    // ministries have an official name that itself contains a comma (e.g. "পরিবেশ, বন ও জলবায়ু
    // পরিবর্তন মন্ত্রণালয়" -- Ministry of Environment, Forest and Climate Change), and splitting
    // first would fragment that single name into pieces that match nothing. A non-matching whole
    // string costs nothing (officeResolution silently skips anything not in the CSV, never pads).
    const requested = (office_name || '').toString().trim();
    if (requested) {
      const wholeKey = officeResolution.normalizeText(requested);
      if (wholeKey && !seen.has(wholeKey)) {
        seen.add(wholeKey);
        detectedOrgs.push(requested);
      }
    }
    for (const seg of requested.split(/[\n\r\t|,;]+/).map((s) => s.trim()).filter(Boolean)) {
      const key = officeResolution.normalizeText(seg);
      if (key && !seen.has(key)) {
        seen.add(key);
        detectedOrgs.push(seg);
      }
    }

    console.log(`📋 [VERIFY] Detected orgs to resolve: ${detectedOrgs.join(', ')}`);

    // Resolve: match against CSV, climb ladder, deduplicate
    // No cap: every detected organization that resolves to a CSV row gets its own card.
    // A relevance/confidence threshold or a fixed top-N cutoff would silently hide genuinely
    // mentioned offices (e.g. a 30%-confidence ministry is still a real mention) -- show all.
    const resolvedCards = officeResolution.resolveDetectedOrgs(
      detectedOrgs, contacts, rtiGazetteer, { maxCards: Infinity }
    );

    console.log(`✅ [VERIFY] Resolved to ${resolvedCards.length} unique card(s)`);

    // Last-resort AI fallback: any detected org that matched neither a CSV row nor a curated
    // gazetteer alias is not simply dropped -- it's classified against the CSV's own ministry
    // list by an LLM (never a name the AI invents) and resolved through the same ladder. Never
    // blocks the response: a classification failure or timeout just leaves that org unresolved,
    // exactly as it was before this fallback existed.
    const resolvedEntityNames = new Set();
    resolvedCards.forEach((card) => card.requestedEntities.forEach((e) => resolvedEntityNames.add(officeResolution.normalizeText(e))));
    const unresolvedOrgs = detectedOrgs.filter((org) => !resolvedEntityNames.has(officeResolution.normalizeText(org)));

    if (unresolvedOrgs.length > 0) {
      try {
        const aiOfficeFallback = require('../services/aiOfficeFallback');
        const aiCards = await aiOfficeFallback.resolveUnmatchedEntities(unresolvedOrgs, contacts, { llmProvider });
        const existingKeys = new Set(resolvedCards.map((c) => c.resolution.resolvedRowKey));
        for (const aiCard of aiCards) {
          if (existingKeys.has(aiCard.resolution.resolvedRowKey)) {
            const existing = resolvedCards.find((c) => c.resolution.resolvedRowKey === aiCard.resolution.resolvedRowKey);
            if (existing && !existing.requestedEntities.includes(aiCard.requestedEntities[0])) {
              existing.requestedEntities.push(aiCard.requestedEntities[0]);
            }
            continue;
          }
          existingKeys.add(aiCard.resolution.resolvedRowKey);
          resolvedCards.push(aiCard);
        }
        if (aiCards.length > 0) console.log(`🤖 [VERIFY] AI fallback resolved ${aiCards.length} additional card(s)`);
      } catch (err) {
        console.warn(`⚠️ [VERIFY] AI fallback step failed (non-fatal): ${err.message}`);
      }
    }

    if (resolvedCards.length === 0) {
      return res.json({
        success: true,
        partial_success: true,
        network_status: 'degraded',
        officer_slots: emptyOfficerSlots,
        matches: [],
        databaseRecord: null,
        liveScrapedRecord: null,
        error: `Contact not found for office: ${office_name}`,
        message: 'সংবাদে উল্লিখিত সরকারি সংস্থার RTI কর্মকর্তার তথ্য ডেটাসেটে পাওয়া যায়নি।',
        llm_provider_requested: llmProvider,
        llm_provider_used: 'none',
        llm_reasoning_details: null,
        discrepancies: null,
      });
    }

    // Build matches from resolved cards, optionally enriching via live website scraping
    const matches = [];
    const liveScrapedRecords = [];
    const matchDiscrepancies = [];

    for (const card of resolvedCards) {
      const contact = card.resolution.resolved;
      const noticeBn = officeResolution.buildNoticeBn(card.resolution);

      if (!contact) {
        // Rung "none": no resolved contact, show a placeholder card
        matches.push({
          office_name: card.requestedEntities[0] || requested,
          Ministry: card.matchedContact?.Ministry || '',
          Division: card.matchedContact?.Division || '',
          Office: card.matchedContact?.Office || '',
          Website_Link: card.matchedContact?.Website_Link || card.matchedContact?.website_link || '',
          Primary_Officer: '', Alternate_Officer: '', Appellate_Officer: '',
          resolution: {
            requestedEntities: card.requestedEntities,
            requestedRowKey: card.resolution.requestedRowKey,
            resolvedRowKey: null,
            rung: 'none',
            skipped: card.resolution.skipped,
            noticeBn,
          },
          officer_slots: emptyOfficerSlots,
          partial_success: true,
          network_status: 'ok',
        });
        liveScrapedRecords.push(null);
        matchDiscrepancies.push(null);
        continue;
      }

      const websiteLink = getWebsiteLinkFromRecord(contact);
      const databaseSnapshot = { ...contact };

      let scraped = null;
      const forceWebExtraction = hasMissingOfficerRoleInfo(contact);
      const shouldScrapeWebsite = Boolean(websiteLink) && (enrich_web || forceWebExtraction);

      if (shouldScrapeWebsite) {
        scraped = await runWebsiteLinkTask(
          () => scrapeInfoOfficersPage(websiteLink, { llmProvider }),
          null,
          `scrapeInfoOfficersPage:${websiteLink}`,
        );
      }

      const enriched = { ...contact };
      if (scraped) {
        applyScrapedOfficers(enriched, scraped, integrityWarnings);
      }

      if (shouldScrapeWebsite && scraped && websiteLink) {
        const discoveredEnriched = await runWebsiteLinkTask(
          () => enrichFromDiscoveredInfoOfficerLinks(enriched, scraped, websiteLink, { llmProvider }),
          enriched,
          `enrichFromDiscoveredInfoOfficerLinks:${websiteLink}`,
        );
        Object.assign(enriched, discoveredEnriched || {});
      }

      const profileImage = enriched.Primary_Photo || enriched.Primary_Image_URL || '';
      const rolePhotoBase = {
        ...enriched,
        photo: profileImage || enriched.Primary_Photo || '',
      };
      const rolePhotoEnriched = await runWebsiteLinkTask(
        () => enrichMissingOfficerPhotos(
          rolePhotoBase,
          websiteLink,
          enriched.Discovered_Office_Links || scraped?.discoveredLinks || []
        ),
        rolePhotoBase,
        `enrichMissingOfficerPhotos:${websiteLink}`,
      );

      const normalizedRecord = toNormalizedOfficerRecord(
        rolePhotoEnriched,
        rolePhotoEnriched.Primary_Photo || profileImage || enriched.Primary_Photo || ''
      );
      const localizedRecord = await persistOfficerPhotosLocally(normalizedRecord);

      // Attach per-card resolution metadata + per-card status
      const cardOfficerSlots = getOfficerRoleFoundStatus(localizedRecord);
      const cardHasGaps = hasMissingOfficerRoleInfo(localizedRecord);
      localizedRecord.resolution = {
        requestedEntities: card.requestedEntities,
        requestedRowKey: card.resolution.requestedRowKey,
        resolvedRowKey: card.resolution.resolvedRowKey,
        rung: card.resolution.rung,
        skipped: card.resolution.skipped,
        noticeBn,
      };
      localizedRecord.officer_slots = cardOfficerSlots;
      localizedRecord.partial_success = cardHasGaps;
      localizedRecord.network_status = shouldScrapeWebsite && !scraped ? 'partial' : 'ok';

      matches.push(localizedRecord);
      const liveScrapedRecord = scraped ? buildLiveScrapedRecord(scraped) : null;
      liveScrapedRecords.push(liveScrapedRecord);
      matchDiscrepancies.push(computeOfficerDiscrepancies(databaseSnapshot, liveScrapedRecord));
    }

    if (matches.length === 0) {
      return res.json({
        success: true,
        partial_success: true,
        network_status: 'degraded',
        officer_slots: emptyOfficerSlots,
        matches: [],
        databaseRecord: null,
        liveScrapedRecord: null,
        error: `Contact not found for office: ${office_name}`,
        message: 'No matching office record could be verified right now.',
        llm_provider_requested: llmProvider,
        llm_provider_used: 'none',
        llm_reasoning_details: null,
        discrepancies: null,
      });
    }

    console.log(`✅ Found ${matches.length} matching office(s)`);

    // CSV write-back: resolved row only, exact key, allowInsert: false
    for (const match of matches) {
      if (!match.resolution || match.resolution.rung === 'none') continue;
      try {
        const csvSync = contactLoader.upsertContactInCsv(
          toNormalizedOfficerRecord(match, match.Primary_Photo || ''),
          {
            mode: 'auto-reconcile',
            allowInsert: false,
            requestedOffice: match.office_name || '',
            minMatchScore: 130,
          }
        );
        if (csvSync?.integrity_warnings?.length) integrityWarnings.push(...csvSync.integrity_warnings);
      } catch (syncErr) {
        console.warn(`⚠️ [VERIFY] CSV sync failed: ${syncErr?.message || syncErr}`);
      }
    }

    res.json({
      success: true,
      matches,
      databaseRecord: matches[0],
      liveScrapedRecord: liveScrapedRecords[0] || null,
      liveScrapedRecords,
      discrepancies_by_match: matchDiscrepancies,
      partial_success: matches.some((m) => m.partial_success),
      network_status: matches.some((m) => m.network_status === 'partial') ? 'partial' : 'ok',
      officer_slots: matches[0]?.officer_slots || emptyOfficerSlots,
      llm_provider_requested: llmProvider,
      llm_provider_used: enrich_web ? 'mixed' : 'none',
      llm_reasoning_details: null,
      integrity_warnings: integrityWarnings,
      discrepancies: matchDiscrepancies[0] || null,
    });

  } catch (error) {
    console.error('❌ Error in /verify-contact:', error);
    const message = error?.message || 'Unknown verification error';
    const emptyOfficerSlots = {
      primary_found: false,
      alternate_found: false,
      appellate_found: false,
    };
    const maybeNetworkFailure =
      isRetryableNetworkError(error)
      || /(timeout|ssl|tls|cert|socket|network|econn|enotfound|getaddrinfo|handshake)/i.test(message);

    if (maybeNetworkFailure) {
      return res.json({
        success: true,
        partial_success: true,
        network_status: 'degraded',
        officer_slots: emptyOfficerSlots,
        matches: [],
        databaseRecord: null,
        liveScrapedRecord: null,
        error: 'Verification temporarily degraded due to network restrictions',
        message,
        llm_provider_requested: geminiAnalysis.normalizeLlmProvider(req.body?.llm_provider || req.body?.provider || 'auto'),
        llm_provider_used: 'none',
        llm_reasoning_details: null,
        discrepancies: null,
      });
    }

    res.status(500).json({
      success: false,
      partial_success: false,
      network_status: 'error',
      officer_slots: emptyOfficerSlots,
      error: 'Verification failed',
      message,
      llm_provider_requested: geminiAnalysis.normalizeLlmProvider(req.body?.llm_provider || req.body?.provider || 'auto'),
    });
  }
});

/**
 * ? Endpoint 3: POST /api/send-mail
 * Purpose: Queue email for sending via MailCard component with file attachments
 * Input: multipart/form-data { subject, body, recipient_email, office_name, files[] }
 * Output: { success, message }
 */
router.post('/send-mail', upload.array('files', 10), async (req, res) => {
  try {
    const { subject, body, recipient_email, office_name, cc, bcc, link_attachments } = req.body;
    const files = req.files || [];

    // Validation
    if (!subject || !body || !recipient_email) {
      return res.status(400).json({
        success: false,
        error: 'Subject, body, and recipient_email are required'
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient_email)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid recipient email format'
      });
    }

    console.log(`\n?? [EMAIL] Queuing email`);
    console.log(`   To: ${recipient_email}`);
    if (cc) console.log(`   Cc: ${cc}`);
    if (bcc) console.log(`   Bcc: ${bcc}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Body Length: ${body.length} characters`);
    console.log(`   Attachments: ${files.length} file(s)`);
    if (link_attachments) {
      const linkCount = Array.isArray(link_attachments) ? link_attachments.length : 1;
      console.log(`   Link Attachments: ${linkCount}`);
    }
    files.forEach((file, idx) => {
      console.log(`      ${idx + 1}. ${file.originalname} (${(file.size / 1024).toFixed(2)} KB)`);
    });
    console.log(`   Office: ${office_name || 'N/A'}`);
    console.log(`   Timestamp: ${new Date().toISOString()}`);

    // ?? MOCK EMAIL QUEUE
    // In production, this would:
    // 1. Store in database
    // 2. Upload attachments to S3
    // 3. Queue via Nodemailer/SendGrid/AWS SES
    // 4. Track delivery status

    const emailId = `email_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    console.log(`? Email queued with ID: ${emailId}`);

    res.json({
      success: true,
      message: 'Email queued successfully',
      email_id: emailId,
      recipient: recipient_email,
      cc: cc || null,
      bcc: bcc || null,
      link_attachments: link_attachments || [],
      attachments: files.map(f => ({
        filename: f.originalname,
        size: f.size,
        path: f.path
      })),
      status: 'queued',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('? Error in /send-mail:', error);
    res.status(500).json({
      success: false,
      error: 'Email sending failed',
      message: error.message
    });
  }
});

/**
 * POST /api/send-mail-postmark
 * Sends an RTI request email via the Postmark API. Deliberately kept entirely separate from
 * both /send-mail above (a still-unimplemented mock/queue stub) and the Gmail OAuth send/draft
 * path (createGmailDraft/sendViaGmail, defined elsewhere in this file) -- neither of those is
 * touched by this endpoint; Gmail stays available for later, Postmark is a new, independent
 * transport.
 *
 * The "From" address is NEVER fixed or read from an env var: the composer lets the user pick a
 * different sender every time, so every request must supply its own `from`, and it is passed
 * straight through to Postmark unchanged -- no server-side default/override.
 *
 * Input: multipart/form-data { from, to, subject, body_html?, body_text?, cc?, bcc?, files[] }
 * Output: { success, message_id, submitted_at, to } or a specific `sender_not_verified` error
 * when Postmark rejects the From address because it hasn't completed Sender Signature
 * verification (or isn't on a verified sending domain) -- surfaced clearly, never silently
 * swapped for a different sender.
 */
router.post('/send-mail-postmark', upload.array('files', 10), async (req, res) => {
  let uploadedFiles = [];
  try {
    if (!postmark) {
      return res.status(503).json({ success: false, error: 'Postmark integration is not installed on this server.' });
    }

    const { from, to, subject, body_html, body_text, cc, bcc } = req.body;
    uploadedFiles = req.files || [];

    const fromEmail = (from || '').toString().trim();
    const toEmail = (to || '').toString().trim();
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!fromEmail || !toEmail || !subject || !((body_html || '').trim() || (body_text || '').trim())) {
      return res.status(400).json({ success: false, error: 'from, to, subject, and a body are required' });
    }
    if (!emailRe.test(fromEmail)) {
      return res.status(400).json({ success: false, error: 'Invalid From email format' });
    }
    if (!emailRe.test(toEmail)) {
      return res.status(400).json({ success: false, error: 'Invalid To email format' });
    }

    const token = (process.env.POSTMARK_API_TOKEN || '').trim();
    if (!token) {
      return res.status(503).json({
        success: false,
        error: 'Postmark is not configured on this server (POSTMARK_API_TOKEN missing in backend/.env).',
      });
    }

    const attachments = await Promise.all(uploadedFiles.map(async (f) => ({
      Name: f.originalname,
      Content: (await fs.readFile(f.path)).toString('base64'),
      ContentType: f.mimetype || 'application/octet-stream',
    })));

    console.log(`\n📧 [POSTMARK] Sending — From: ${fromEmail} | To: ${toEmail} | Subject: ${subject} | Attachments: ${attachments.length}`);

    const client = new postmark.ServerClient(token);
    const result = await client.sendEmail({
      From: fromEmail,
      To: toEmail,
      ...(cc && cc.toString().trim() ? { Cc: cc.toString().trim() } : {}),
      ...(bcc && bcc.toString().trim() ? { Bcc: bcc.toString().trim() } : {}),
      Subject: subject,
      ...(body_html && body_html.trim() ? { HtmlBody: body_html } : {}),
      ...(body_text && body_text.trim() ? { TextBody: body_text } : {}),
      MessageStream: 'outbound',
      ...(attachments.length ? { Attachments: attachments } : {}),
    });

    console.log(`✅ [POSTMARK] Sent — MessageID: ${result.MessageID}`);

    res.json({
      success: true,
      message_id: result.MessageID,
      submitted_at: result.SubmittedAt,
      to: result.To,
    });
  } catch (error) {
    const message = error?.message || String(error);
    const looksLikeUnverifiedSender = /sender signature|not.*verified|invalid.*sender|signature.*not.*found/i.test(message);
    if (looksLikeUnverifiedSender) {
      console.warn(`⚠️ [POSTMARK] Sender not verified: ${req.body?.from || ''} — ${message}`);
      return res.status(422).json({
        success: false,
        error: 'sender_not_verified',
        message: `"${req.body?.from || ''}" ঠিকানাটি Postmark-এ এখনও যাচাই করা নেই। Postmark ড্যাশবোর্ডে গিয়ে এই ঠিকানাটি Sender Signature হিসেবে যাচাই করুন, অথবা আগে থেকে যাচাইকৃত অন্য কোনো ঠিকানা ব্যবহার করুন।`,
        postmark_message: message,
      });
    }
    console.error('❌ Error in /send-mail-postmark:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send email via Postmark',
      message,
    });
  } finally {
    await Promise.all(uploadedFiles.map((f) => fs.unlink(f.path).catch(() => {})));
  }
});

// NOTE: /api/webview endpoint is defined at the end of this file using webviewProxy utilities

/**
 * ? Helper Endpoint: GET /api/contacts
 * Purpose: List all available contacts (for testing/debugging)
 * Output: Array of all contacts in local store
 */
router.get('/contacts', (req, res) => {
  try {
    console.log(`\n?? [CONTACTS] Fetching all contacts`);
    
    console.log(`? Retrieved ${contactLoader.contacts.length} contacts`);

    res.json({
      success: true,
      count: contactLoader.contacts.length,
      data: contactLoader.contacts.map(c => ({
        office_name: c.office_name,
        name: c.name,
        designation: c.designation,
        email: c.email,
        phone: c.phone
      }))
    });

  } catch (error) {
    console.error('? Error in /contacts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch contacts'
    });
  }
});

/**
 * ? Endpoint: POST /api/contacts/update
 * Purpose: Update a contact record in JAANI_RTI_OFFICERS_COMPLETE.csv, the only
 * persisted contact store (see contactLoader.js) -- there is no database backing this route.
 * Body: { original_identifier?: string, updates: object }
 * Output: { success: boolean, data: normalizedUpdates }
 */
router.post('/contacts/update', [
  body('updates').isObject().withMessage('Updates must be an object'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { original_identifier, updates, match_hints = {} } = req.body;
    const normalizedUpdates = toNormalizedOfficerRecord(
      {
        ...(updates || {}),
        ...(match_hints || {}),
      },
      updates?.Primary_Photo || updates?.photo || ''
    );

    console.log(`\n?? [UPDATE CONTACT] Request received`);
    console.log(`?? [UPDATE CONTACT] Identifier: ${original_identifier || 'N/A'}`);
    console.log(`?? [UPDATE CONTACT] Updates:`, JSON.stringify(updates, null, 2).substring(0, 500));

    // -------------------------------------------------------------------
    // Update the authoritative CSV (JAANI_RTI_OFFICERS_COMPLETE.csv, via contactLoader)
    // -------------------------------------------------------------------
    const inferredIdentifier = (
      original_identifier
      || normalizedUpdates.Primary_Mobile
      || normalizedUpdates.Primary_Email
      || normalizedUpdates.Alternate_Mobile
      || normalizedUpdates.Alternate_Email
      || normalizedUpdates.Appellate_Mobile
      || normalizedUpdates.Appellate_Email
      || updates?.phone
      || updates?.email
      || updates?.Mobile
      || updates?.['E-mail']
      || ''
    ).toString().trim();

    const csvUpdateResult = contactLoader.upsertContactInCsv(normalizedUpdates, {
      mode: 'manual',
      allowInsert: true,
      originalIdentifier: inferredIdentifier,
      requestedOffice: normalizedUpdates.office_name || updates?.office_name || '',
      minMatchScore: 120,
    });

    if (!csvUpdateResult?.success) {
      console.warn(`?? CSV update skipped/failed: ${csvUpdateResult?.reason || 'unknown_reason'}`);
    } else if (csvUpdateResult.updated || csvUpdateResult.inserted) {
      console.log(`? CSV upsert complete (${csvUpdateResult.inserted ? 'inserted' : 'updated'}): ${csvUpdateResult.path}`);
    } else {
      console.log('?? CSV upsert found no field changes; authoritative file already up-to-date.');
    }

    // -------------------------------------------------------------------
    // Update in-memory cache
    // -------------------------------------------------------------------
    if (contactLoader.contacts) {
      const identifier = inferredIdentifier || original_identifier;
      const cacheIndex = contactLoader.contacts.findIndex(c =>
        c.phone === identifier ||
        c.Mobile === identifier ||
        c.Primary_Mobile === identifier ||
        c.Alternate_Mobile === identifier ||
        c.Appellate_Mobile === identifier ||
        c.email === identifier ||
        c['E-mail'] === identifier ||
        c.Primary_Email === identifier ||
        c.Alternate_Email === identifier ||
        c.Appellate_Email === identifier
      );
      
      if (cacheIndex !== -1) {
        contactLoader.contacts[cacheIndex] = { 
          ...contactLoader.contacts[cacheIndex],
          ...updates,
          ...normalizedUpdates,
        };
        console.log(`? In-memory cache updated at index ${cacheIndex}`);
      }
    }

    res.json({
      success: true,
      data: normalizedUpdates,
      csv_update: csvUpdateResult || null,
      integrity_warnings: csvUpdateResult?.integrity_warnings || [],
      message: 'Contact updated successfully',
    });

  } catch (error) {
    console.error('? Error updating contact:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update contact'
    });
  }
});

/**
 * ? Endpoint 5: GET /api/history
 * Purpose: Get search/analysis history
 * Query params: limit (default 50), offset (default 0)
 * Output: { success, total, items[], hasMore }
 */
router.get('/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const history = await historyManager.getHistory(limit, offset);

    res.json({
      success: true,
      ...history
    });
  } catch (error) {
    console.error('? Error in /history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch history'
    });
  }
});

/**
 * ? Endpoint 6: GET /api/history/search
 * Purpose: Search through history
 * Query params: q (search query), limit (default 20)
 * Output: { success, results[] }
 */
router.get('/history/search', async (req, res) => {
  try {
    const query = req.query.q || '';
    const limit = parseInt(req.query.limit) || 20;

    const results = await historyManager.searchHistory(query, limit);

    res.json({
      success: true,
      results: results
    });
  } catch (error) {
    console.error('? Error in /history/search:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search history'
    });
  }
});

/**
 * ? Endpoint 7: GET /api/history/stats
 * Purpose: Get history statistics
 * Output: { success, stats }
 */
router.get('/history/stats', async (req, res) => {
  try {
    const stats = await historyManager.getStats();

    res.json({
      success: true,
      stats: stats
    });
  } catch (error) {
    console.error('? Error in /history/stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get stats'
    });
  }
});

/**
 * ? Endpoint 8: DELETE /api/history
 * Purpose: Clear all history
 * Output: { success, message }
 */
router.delete('/history', async (req, res) => {
  try {
    const cleared = await historyManager.clearHistory();

    if (cleared) {
      res.json({
        success: true,
        message: 'History cleared successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to clear history'
      });
    }
  } catch (error) {
    console.error('? Error in DELETE /history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear history'
    });
  }
});

/**
 * ? Endpoint 9: DELETE /api/cache
 * Purpose: Clear all cached results
 * Output: { success, message }
 */
router.delete('/cache', async (req, res) => {
  try {
    const cleared = await historyManager.clearCache();

    if (cleared) {
      res.json({
        success: true,
        message: 'Cache cleared successfully'
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to clear cache'
      });
    }
  } catch (error) {
    console.error('? Error in DELETE /cache:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear cache'
    });
  }
});

/**
 * ? Endpoint 10: GET /api/history/export
 * Purpose: Export history data
 * Query params: format (json|csv, default json)
 * Output: Raw data for download
 */
router.get('/history/export', async (req, res) => {
  try {
    const format = req.query.format || 'json';
    const data = await historyManager.exportHistory(format);

    if (!data) {
      return res.status(500).json({
        success: false,
        error: 'Failed to export history'
      });
    }

    const filename = `jaani_history_${new Date().toISOString().split('T')[0]}.${format}`;
    const mimeType = format === 'csv' ? 'text/csv' : 'application/json';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(data);
  } catch (error) {
    console.error('? Error in /history/export:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to export history'
    });
  }
});

/**
 * ? Endpoint: GET /api/activity-stats
 * Purpose: Get comprehensive activity tracking statistics
 * Output: { success, statistics, todayActivities, recentSessions }
 */
router.get('/activity-stats', async (req, res) => {
  try {
    const activityTracker = require('../../shared/activityTracker');
    
    const [statistics, todayActivities, allSessions, allVisitors] = await Promise.all([
      activityTracker.getStatistics(),
      activityTracker.getTodayActivities(),
      activityTracker.getAllSessions(),
      activityTracker.getAllVisitors()
    ]);

    // Get recent sessions (last 10)
    const recentSessions = allSessions
      .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity))
      .slice(0, 10)
      .map(s => ({
        sessionId: s.sessionId,
        startTime: s.startTime,
        lastActivity: s.lastActivity,
        location: s.location,
        device: s.device,
        isNgrok: s.isNgrok,
        pageViews: s.pageViews?.length || 0,
        actions: s.actions?.length || 0
      }));

    res.json({
      success: true,
      statistics,
      todayActivities: todayActivities.length,
      recentSessions,
      topVisitors: allVisitors
        .sort((a, b) => b.totalVisits - a.totalVisits)
        .slice(0, 10)
        .map(v => ({
          location: v.location,
          totalVisits: v.totalVisits,
          firstVisit: v.firstVisit,
          lastVisit: v.lastVisit,
          accessMethod: v.accessMethod
        }))
    });
  } catch (error) {
    console.error('? Error in /activity-stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve activity statistics',
      message: error.message
    });
  }
});

/**
 * ? Endpoint: GET /api/activity-export
 * Purpose: Export all activity data as JSON
 * Output: Complete activity tracking data
 */
router.get('/activity-export', async (req, res) => {
  try {
    const activityTracker = require('../../shared/activityTracker');
    const dateFilter = req.query.date; // Optional YYYY-MM-DD filter
    
    const [activities, sessions, visitors, summary] = await Promise.all([
      activityTracker.getAllActivities(dateFilter),
      activityTracker.getAllSessions(),
      activityTracker.getAllVisitors(),
      activityTracker.getSummary()
    ]);

    const exportData = {
      exportDate: new Date().toISOString(),
      dateFilter: dateFilter || 'all',
      summary,
      activities,
      sessions,
      visitors
    };

    const filename = `jaani_activity_export_${dateFilter || 'all'}_${new Date().toISOString().split('T')[0]}.json`;
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(exportData);
  } catch (error) {
    console.error('? Error in /activity-export:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to export activity data',
      message: error.message
    });
  }
});

/**
 * ? Activity Tracking CSV Endpoints
 */

// GET /api/activity/generate-csv - Generate CSV report for a specific date
router.get('/activity/generate-csv', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const csvFile = await activityTracker.generateDailyCSVReport(date);
    
    if (!csvFile) {
      return res.status(404).json({
        success: false,
        error: `No activities found for ${date}`
      });
    }

    res.json({
      success: true,
      message: `CSV report generated for ${date}`,
      file: path.basename(csvFile),
      path: csvFile
    });
  } catch (error) {
    console.error('? Error generating CSV:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate CSV report'
    });
  }
});

// GET /api/activity/download-csv/:date - Download CSV report
router.get('/activity/download-csv/:date', async (req, res) => {
  try {
    const date = req.params.date;
    const csvDir = path.join(__dirname, '../../shared/activity_tracking/daily_logs_csv');
    const csvFile = path.join(csvDir, `${date}_detailed_report.csv`);
    
    // Check if file exists
    try {
      await fs.access(csvFile);
    } catch (err) {
      // Generate if doesn't exist
      await activityTracker.generateDailyCSVReport(date);
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${date}_activity_report.csv"`);
    
    const csvContent = await fs.readFile(csvFile, 'utf-8');
    res.send(csvContent);
  } catch (error) {
    console.error('? Error downloading CSV:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to download CSV report'
    });
  }
});

// POST /api/activity/update-viewport - Update session viewport and device info from client
router.post('/activity/update-viewport', async (req, res) => {
  try {
    const sessionId = req.sessionId || req.cookies?.sessionId || req.body.sessionId;
    
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'No session ID' });
    }

    // Extract comprehensive viewport data from client
    const viewportData = {
      width: req.body.viewportWidth || req.body.width,
      height: req.body.viewportHeight || req.body.height,
      screenResolution: req.body.screenResolution || 
                       `${req.body.screenWidth}x${req.body.screenHeight}`,
      colorDepth: req.body.colorDepth,
      devicePixelRatio: req.body.devicePixelRatio,
      touchSupport: req.body.touchSupport,
      orientation: req.body.orientation,
      timezone: req.body.timezone,
      language: req.body.language,
      platform: req.body.platform,
      online: req.body.online,
      connectionType: req.body.connectionType,
      maxScrollDepth: req.body.maxScrollDepth,
      gpuVendor: req.body.gpuVendor,
      gpuRenderer: req.body.gpuRenderer
    };

    // Update session with viewport data
    await activityTracker.updateViewport(sessionId, viewportData);
    
    // Handle v3.0 research-grade tracking data
    if (req.body.events && Array.isArray(req.body.events)) {
      // Process batched events from client
      for (const event of req.body.events) {
        await activityTracker.logActivity(sessionId, event.type, {
          ...event.data,
          eventId: event.id,
          eventTimestamp: event.timestamp
        });
      }
    }

    // Handle engagement metrics
    if (req.body.engagement) {
      await activityTracker.updateEngagement(sessionId, req.body.engagement);
    }

    // Handle GPS location from browser
    if (req.body.gps && req.body.gps.latitude) {
      await activityTracker.updateGPSLocation(sessionId, {
        latitude: req.body.gps.latitude,
        longitude: req.body.gps.longitude,
        accuracy: req.body.gps.accuracy,
        altitude: req.body.gps.altitude,
        speed: req.body.gps.speed,
        heading: req.body.gps.heading,
        source: req.body.gps.source || 'gps-browser'
      });
    }

    // Handle performance metrics
    if (req.body.performance) {
      await activityTracker.updatePerformance(sessionId, req.body.performance);
    }
    
    // Log the viewport update as an activity if it includes useful info
    if (req.body.eventType) {
      await activityTracker.logActivity(sessionId, req.body.eventType, {
        ...viewportData,
        engagement: req.body.engagement,
        timestamp: req.body.timestamp
      });
    }
    
    res.json({ 
      success: true,
      message: 'Viewport data updated'
    });
  } catch (error) {
    console.error('? Error updating viewport:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/activity/update-location - Update GPS location from browser
router.post('/activity/update-location', async (req, res) => {
  try {
    const sessionId = req.sessionId || req.cookies?.sessionId || req.body.sessionId;
    
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'No session ID' });
    }

    // Accept both legacy keys (gpsLatitude/gpsLongitude/...) and spec keys (latitude/longitude/...)
    const {
      latitude: latitudeIn,
      longitude: longitudeIn,
      accuracy: accuracyIn,
      altitude: altitudeIn,
      speed: speedIn,
      heading: headingIn,
      timestamp: timestampIn,
      source: sourceIn,
      gpsLatitude,
      gpsLongitude,
      gpsAccuracy,
      gpsAltitude,
      gpsSpeed,
      gpsHeading,
      gpsTimestamp,
      locationSource
    } = req.body;

    const latitude = Number(latitudeIn ?? gpsLatitude);
    const longitude = Number(longitudeIn ?? gpsLongitude);
    const accuracy = (accuracyIn ?? gpsAccuracy) == null ? null : Number(accuracyIn ?? gpsAccuracy);
    const altitude = (altitudeIn ?? gpsAltitude) == null ? null : Number(altitudeIn ?? gpsAltitude);
    const speed = (speedIn ?? gpsSpeed) == null ? null : Number(speedIn ?? gpsSpeed);
    const heading = (headingIn ?? gpsHeading) == null ? null : Number(headingIn ?? gpsHeading);
    const timestamp = Number(timestampIn ?? gpsTimestamp);
    const source = sourceIn || locationSource || 'browser';

    let result = null;
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      result = await activityTracker.updateGPSLocation(sessionId, {
        lat: latitude,
        lng: longitude,
        accuracy: Number.isFinite(accuracy) ? accuracy : null,
        altitude: Number.isFinite(altitude) ? altitude : null,
        speed: Number.isFinite(speed) ? speed : null,
        heading: Number.isFinite(heading) ? heading : null,
        source,
        timestamp: Number.isFinite(timestamp) ? timestamp : Date.now()
      });
      
      // Also log as activity
      await activityTracker.logActivity(sessionId, 'gps_update', {
        accepted: Boolean(result?.updated),
        reason: result?.reason || null,
        accuracy: Number.isFinite(accuracy) ? accuracy : null,
        source,
        lat: result?.updated ? latitude : null,
        lng: result?.updated ? longitude : null
      });

      if (result?.flagged) {
        return res.json({ success: true, accepted: false, flagged: true, reason: result.reason || 'rejected' });
      }
    }

    if (result?.updated) {
      return res.json({ success: true, accepted: true, message: 'Location updated' });
    }

    res.json({ success: true, accepted: false, message: 'Location not updated' });
  } catch (error) {
    console.error('? Error updating location:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/activity/current-location - Return the location currently saved for this session
router.get('/activity/current-location', async (req, res) => {
  try {
    const sessionId = req.sessionId || req.cookies?.sessionId;

    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'No session ID' });
    }

    const session = await activityTracker.getSessionById(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const location = session.location || null;
    const gpsLocation = session.gpsLocation || null;

    const isValidSafetyGPS = (rec) => {
      if (!rec) return false;
      const lat = Number(rec.lat);
      const lng = Number(rec.lng);
      const accuracy = rec.accuracy == null ? NaN : Number(rec.accuracy);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
      if (!Number.isFinite(accuracy)) return false;
      return accuracy <= 30;
    };

    // SAFETY: never fall back to IP coordinates as "GPS". Only return GPS if it's safety-grade (accuracy <= 30m)
    const rawLocationRecord = gpsLocation && Number.isFinite(Number(gpsLocation.lat)) && Number.isFinite(Number(gpsLocation.lng))
      ? {
          lat: Number(gpsLocation.lat),
          lng: Number(gpsLocation.lng),
          accuracy: gpsLocation.accuracy ?? null,
          confidence: gpsLocation.confidence || null,
          source: gpsLocation.source || 'browser',
          timestamp: gpsLocation.timestamp ?? null
        }
      : null;

    const gpsStatus = session.gpsStatus ?? (isValidSafetyGPS(rawLocationRecord) ? 'ok' : 'gps_required');
    const locationRecord = (gpsStatus === 'ok' && isValidSafetyGPS(rawLocationRecord)) ? rawLocationRecord : null;

    const canOpenGoogleMaps = Boolean(locationRecord);
    const googleMapsUrl = locationRecord
      ? `https://www.google.com/maps?q=${locationRecord.lat},${locationRecord.lng}`
      : null;

    // Region-only info (no coordinates) for display when GPS is approximate/unavailable
    const regionInfo = location ? {
      country: location.country || null,
      countryCode: location.countryCode || null,
      region: location.region || null,
      city: location.city || null,
      timezone: location.timezone || null,
      source: location.source || null,
      // INCLUDE IP-BASED COORDINATES (for display, not safety tracking)
      ipLatitude: location.latitude || null,
      ipLongitude: location.longitude || null,
      isIPBased: true
    } : null;

    res.json({
      success: true,
      sessionId,
      gpsStatus,
      locationRecord,  // GPS coordinates (safety-grade only, may be null)
      googleMapsUrl,
      canOpenGoogleMaps,
      regionInfo,  // IP-based location with coordinates (always available)
      message: locationRecord ? null : 'Precise location unavailable. GPS required.',
      lastActivity: session.lastActivity || null,
      startTime: session.startTime || null
    });
  } catch (error) {
    console.error('? Error getting current location:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/activity/track-events - Track batched client events
router.post('/activity/track-events', async (req, res) => {
  try {
    const sessionId = req.sessionId || req.cookies?.sessionId || req.body.sessionId;
    
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'No session ID' });
    }

    const { events } = req.body;
    
    if (events && Array.isArray(events)) {
      for (const event of events) {
        await activityTracker.logActivity(sessionId, event.type, {
          ...event.data,
          eventId: event.id,
          eventTimestamp: event.timestamp
        });
      }
    }
    
    res.json({ 
      success: true, 
      message: `Tracked ${events?.length || 0} events` 
    });
  } catch (error) {
    console.error('? Error tracking events:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/activity/summary - Get tracking summary statistics
router.get('/activity/summary', async (req, res) => {
  try {
    const stats = await activityTracker.getStatistics();
    const recentSessions = await activityTracker.getAllSessions();
    
    res.json({
      success: true,
      statistics: stats,
      recentSessions: recentSessions.slice(0, 20),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('? Error getting activity summary:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/activity/regenerate-csv - Regenerate all CSV reports
router.post('/activity/regenerate-csv', async (req, res) => {
  try {
    const count = await activityTracker.regenerateAllCSVReports();
    res.json({
      success: true,
      message: `Regenerated ${count} CSV reports`,
      count
    });
  } catch (error) {
    console.error('? Error regenerating CSV:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * ============================================================================
 * NEWS SUMMARY BOX ENDPOINTS (20 Features Integration)
 * ============================================================================
 */

/**
 * ? Endpoint: POST /api/news-summary
 * Purpose: Generate comprehensive news summary with all 20 features
 * Input: { url: string, text?: string }
 * Output: Complete data for NewsSummaryBox component
 */
router.post('/news-summary', [
  body('url').optional().isURL().withMessage('Invalid URL format'),
  body('text').optional().isString(),
  body('llm_provider').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors.array()
      });
    }

    let { url, text: providedText, llm_provider = 'auto' } = req.body;
    const llmProvider = geminiAnalysis.normalizeLlmProvider(llm_provider);
    let text = providedText || '';
    let title = '';
    let author = '';
    let authorBioUrl = '';
    let source = '';
    let sourceUrl = '';
    let publicationDate = '';
    let wordCount = 0;
    let legalProof = {};

    console.log(`\n?? [NEWS-SUMMARY] Processing request...`);
    console.log(`   LLM provider: ${llmProvider}`);

    if (url) {
      const validatedUrl = await validateExternalHttpUrl(url, {
        allowPrivateNetwork: ALLOW_PRIVATE_NETWORK_URLS,
        label: 'url',
      });
      if (!validatedUrl.ok) {
        return res.status(validatedUrl.status || 400).json({
          success: false,
          error: validatedUrl.reason || 'Invalid or unsafe URL',
        });
      }
      url = validatedUrl.normalizedUrl;
    }

    // If URL provided, fetch article content
    if (url && !text) {
      try {
        // Try cached result first
        const cached = await historyManager.getLatestCachedResultByUrl(url);
        if (cached) {
          console.log(`? Using cached data for URL: ${url}`);
          text = cached.extractedText || '';
          title = cached.title || cached.meta_data?.title || '';
          author = cached.meta_data?.author || '';
          source = cached.meta_data?.domain || '';
          sourceUrl = url;
          publicationDate = cached.meta_data?.date || '';
          wordCount = cached.meta_data?.wordCount || 0;
          legalProof = cached.legalProof || {};
        } else {
          // Fetch fresh content
          console.log(`?? Fetching fresh content from: ${url}`);
          const siteTypeHint = (() => {
            try {
              const host = new URL(url).hostname.toLowerCase();
              if (host.includes('prothomalo') || host.includes('prothom-alo')) return 'prothomalo';
              if (host.includes('kalerkantho') || host.includes('kaler-kantho')) return 'kalerkantho';
              if (host.includes('bbc')) return 'bbc';
              if (host.includes('bdnews24')) return 'bdnews24';
              if (host.includes('dailystar')) return 'dailystar';
              return 'generic';
            } catch {
              return 'generic';
            }
          })();

          const isLowQuality = (payload) => {
            const candidateText = normalizeExtractionText(payload?.text || '');
            if (!candidateText || candidateText.length < 120) return true;
            return shouldEscalateExtraction(candidateText, payload?.title || '');
          };

          let extracted = await extractWithCheerio(url);

          // If extractor output is noisy or too short, try Playwright for JS-heavy pages.
          if (isLowQuality(extracted)) {
            console.log('?? [NEWS-SUMMARY] Fast extraction insufficient; trying Playwright extraction...');
            const pw = await extractWithPlaywright(url, { siteType: siteTypeHint });
            if (pw?.text && (!extracted?.text || pw.text.length >= extracted.text.length || !isLowQuality(pw))) {
              extracted = {
                ...extracted,
                ...pw,
                author: extracted?.author || '',
                publicationDate: extracted?.publicationDate || '',
                source: extracted?.source || new URL(url).hostname,
              };
            }
          }

          // Emergency fallback
          if (!extracted?.text || extracted.text.length < 50 || isLowQuality(extracted)) {
            const axiosFallback = await extractWithAxiosOnly(url);
            if (axiosFallback?.text && axiosFallback.text.length > (extracted?.text?.length || 0)) {
              extracted = {
                ...extracted,
                ...axiosFallback,
                author: extracted?.author || '',
                publicationDate: extracted?.publicationDate || '',
                source: extracted?.source || new URL(url).hostname,
              };
            }
          }

          text = normalizeExtractionText(extracted?.text || '');
          title = (extracted?.title || '').trim();
          author = (extracted?.author || '').trim();
          source = (extracted?.source || new URL(url).hostname || '').trim();
          sourceUrl = url;
          publicationDate = (extracted?.publicationDate || '').trim();
          wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;

          // Capture legal proof
          legalProof = await captureLegalProofData(url);
        }
      } catch (fetchErr) {
        console.error('? Error fetching URL:', fetchErr.message);
        return res.status(400).json({
          success: false,
          error: 'Failed to fetch URL content',
          message: fetchErr.message
        });
      }
    }

    if (!text || text.length < 50) {
      return res.status(400).json({
        success: false,
        error: 'Insufficient text content for analysis'
      });
    }

    // Calculate word count if not set
    if (!wordCount) {
      wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
    }

    // Call Gemini AI for full summary (replaces local ML service)
    let mlSummary = null;
    try {
      mlSummary = await geminiAnalysis.generateFullSummary(text, url, title, { llmProvider });
      console.log(`? Gemini Full Summary generated (source: ${mlSummary.source})`);
    } catch (mlError) {
      console.warn('?? Gemini AI unavailable, using fallback:', mlError.message);
    }

    // Fallback summary generation (built into geminiAnalysis, but extra safety)
    if (!mlSummary) {
      const sentences = text.match(/[^.!??]+[.!??]+/g) || [];
      
      mlSummary = {
        tldr: sentences[0]?.trim() || text.substring(0, 150) + '...',
        keyTakeaways: sentences.slice(0, 5).map(s => s.trim()),
        fullSummary: sentences.slice(0, 3).join(' ').trim(),
        sentiment: { score: 50, label: 'Neutral', confidence: 0.5 },
        bias: { label: 'Center', confidence: 0.5 },
        entities: { people: [], organizations: [], locations: [] },
        keywords: [],
        legalImplications: []
      };
    }

    /* -- OLD LOCAL ML SERVICE (COMMENTED OUT) --
    try {
      const mlServiceUrl = process.env.ML_SERVICE_URL || 'http://localhost:8000';
      const mlResponse = await axios.post(`${mlServiceUrl}/generate-full-summary`, {
        text: text.substring(0, 10000), url, title
      }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });
      if (mlResponse.data) mlSummary = mlResponse.data;
    } catch (mlError) { console.warn('ML unavailable:', mlError.message); }
    -- END OLD ML SERVICE -- */

    // Search for related news (best-effort)
    let relatedNews = [];
    try {
      const enable = (process.env.ENABLE_RELATED_SOURCES || 'true').toString().toLowerCase() !== 'false';
      if (enable) {
        relatedNews = await fetchRelatedSourcesGoogleNewsRss({ title: title || mlSummary?.title || '', language: /[\u0980-\u09FF]/.test(text) ? 'bn' : 'en', region: 'global', limit: 8, timeoutMs: 6000 });
      }
    } catch (e) {
      relatedNews = [];
    }
    const opposingViewpoints = [];

    // Prepare response
    const response = {
      success: true,
      data: {
        // Overview Tab
        tldr: mlSummary.tldr || '',
        keyTakeaways: mlSummary.keyTakeaways || [],
        fullSummary: mlSummary.fullSummary || '',
        publicationDate: publicationDate ? new Date(publicationDate).toLocaleString('en-US', {
          month: 'short',
          day: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZoneName: 'short'
        }) : '',
        author: author || '',
        authorBioUrl: authorBioUrl || '',
        source: source || '',
        sourceUrl: sourceUrl || '',
        wordCount: wordCount,
        
        // Analytics Tab
        sentiment: mlSummary.sentiment || { score: 50, label: 'Neutral' },
        entities: mlSummary.entities || { people: [], organizations: [], locations: [] },
        keywords: mlSummary.keywords || [],
        bias: mlSummary.bias || { label: 'Center', confidence: 0.5 },
        factCheckLinks: [], // Placeholder - could integrate with fact-check APIs
        
        // Forensics Tab
        md5Hash: legalProof?.checksums?.md5 || '',
        sha256Hash: legalProof?.checksums?.sha256 || '',
        scrapeTimestamp: legalProof?.timestamp || new Date().toISOString(),
        archivalUrl: legalProof?.waybackMachineUrl || '',
        
        // Context Tab
        relatedNews: relatedNews,
        opposingViewpoints: opposingViewpoints,
        
        // Tools Tab
        legalImplications: mlSummary.legalImplications || [],
        
        // Raw data for export
        rawText: text,
        newsUrl: url || '',
        llm_provider_requested: llmProvider,
        llm_provider_used: mlSummary?.llm_provider_used || mlSummary?.source || 'fallback',
        llm_reasoning_details: mlSummary?.reasoning_details || null,
        metadata: {
          title,
          author,
          source,
          publicationDate,
          wordCount,
          ...legalProof
        }
      }
    };

    console.log(`? News summary generated - TL;DR: ${response.data.tldr?.substring(0, 50)}...`);
    
    res.json(response);

  } catch (error) {
    console.error('? Error in /news-summary:', error);
    res.status(500).json({
      success: false,
      error: 'News summary generation failed',
      message: error.message
    });
  }
});

async function searchGoogleNewsRss(query, { isBangla, limit = 8, timeoutMs = 9000 } = {}) {
  const hl = isBangla ? 'bn' : 'en-US';
  const gl = isBangla ? 'BD' : 'US';
  const ceid = isBangla ? 'BD:bn' : 'US:en';
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${hl}&gl=${gl}&ceid=${encodeURIComponent(ceid)}`;
  const resp = await axios.get(rssUrl, {
    timeout: timeoutMs,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.5' },
    responseType: 'text',
  });
  const $ = cheerio.load(resp.data, { xmlMode: true });
  const out = [];
  $('item').each((_, el) => {
    const $el = $(el);
    const source = ($el.find('source').first().text() || '').trim();
    let title = ($el.find('title').first().text() || '').trim();
    const link = ($el.find('link').first().text() || '').trim();
    if (!title || !link) return;
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    if (/facebook|youtube/i.test(`${source} ${link}`)) return;
    const snippet = cheerio.load(`<x>${$el.find('description').first().text() || ''}</x>`)('x').text().replace(/\s+/g, ' ').trim();
    out.push({ title, url: link, source: source || 'Google News', publishedAt: ($el.find('pubDate').first().text() || '').trim(), snippet });
  });
  return out.slice(0, limit * 2);
}

// Known Bangladeshi / regional fact-checkers and debunk-style headline patterns (fixed lists).
const FACT_CHECKER_NAMES = ['rumor scanner', 'রিউমর স্ক্যানার', 'factwatch', 'fact-watch', 'ফ্যাক্টওয়াচ', 'dismislab', 'ডিসমিসল্যাব',
  'afp fact check', 'এএফপি ফ্যাক্টচেক', 'boom bangladesh', 'boom bd', 'বুম বাংলাদেশ'];
const FACT_CHECKER_DOMAINS = ['rumorscanner.com', 'fact-watch.org', 'dismislab.com', 'factcheck.afp.com', 'boombd.com'];
const DEBUNK_TITLE_RE = /(কোনো মন্তব্য করেননি|দাবিটি সত্য নয়|ভুয়া|গুজব|মিথ্যা দাবি|বিভ্রান্তিকর|ফ্যাক্টচেক|ফ্যাক্ট চেক|fact[- ]?check|false claim|misleading)/i;

function isFactCheckItem(item = {}) {
  const source = String(item.source || '').toLowerCase();
  const url = String(item.url || '').toLowerCase();
  return FACT_CHECKER_NAMES.some((n) => source.includes(n))
    || FACT_CHECKER_DOMAINS.some((d) => url.includes(d))
    || DEBUNK_TITLE_RE.test(String(item.title || ''));
}

/**
 * Endpoint: GET /api/related-news
 * Query: title (article title), keywords (comma list), exclude (original article URL), language
 * Output: { success, sameStory[] (same news in other newspapers), related[] (topically related) }
 */
router.get('/related-news', async (req, res) => {
  try {
    const title = (req.query.title || req.query.q || '').toString().replace(/\s+/g, ' ').trim();
    const keywords = (req.query.keywords || '').toString().split(',').map((k) => k.trim()).filter(Boolean).slice(0, 4);
    const excludeUrl = (req.query.exclude || '').toString();
    if (title.length < 5 && keywords.length === 0) {
      return res.status(400).json({ success: false, error: 'title or keywords required' });
    }
    const isBangla = /[\u0980-\u09FF]/.test(title || keywords.join(' ')) || (req.query.language || '').toString().startsWith('bn');
    let ownHost = '';
    try { ownHost = new URL(excludeUrl).hostname.replace(/^www\./, '').toLowerCase(); } catch { /* no exclude */ }
    const hostKey = ownHost.split('.')[0];
    const OWN_NAME_ALIASES = { prothomalo: 'প্রথম আলো', dhakapost: 'ঢাকা পোস্ট', jugantor: 'যুগান্তর', kalerkantho: 'কালের কণ্ঠ', samakal: 'সমকাল', ittefaq: 'ইত্তেফাক', bdnews24: 'বিডিনিউজ২৪', banglatribune: 'বাংলা ট্রিবিউন', thedailystar: 'The Daily Star', dailystar: 'The Daily Star', tbsnews: 'The Business Standard', bd_pratidin: 'বাংলাদেশ প্রতিদিন', bd_protidin: 'বাংলাদেশ প্রতিদিন', jagonews24: 'জাগো নিউজ', risingbd: 'Rising BD', manabzamin: 'মানবজমিন', janakantha: 'জনকণ্ঠ' };
    const ownAlias = (OWN_NAME_ALIASES[hostKey] || '').toLowerCase();
    const isOwnSource = (item) => {
      const src = `${item.source}`.toLowerCase();
      if (ownAlias && src.includes(ownAlias)) return true;
      return Boolean(hostKey) && src.replace(/[^a-z0-9]/g, '').includes(hostKey.replace(/[^a-z0-9]/g, ''));
    };
    const tokens = (t) => new Set((t || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1));
    const titleTokens = tokens(title);
    const similarity = (t) => {
      const b = tokens(t);
      if (!titleTokens.size || !b.size) return 0;
      let inter = 0;
      b.forEach((w) => { if (titleTokens.has(w)) inter += 1; });
      return inter / Math.max(titleTokens.size, b.size);
    };

    const summary = (req.query.summary || '').toString().replace(/\s+/g, ' ').trim();
    const entityNames = (req.query.entities || '').toString().split(',').map((k) => k.trim()).filter(Boolean).slice(0, 4);
    const pubDate = req.query.date ? new Date(req.query.date.toString()) : null;
    const hasPubDate = pubDate && !Number.isNaN(pubDate.getTime());
    const bnDigits = (t) => (t || '').replace(/[\u09E6-\u09EF]/g, (d) => String(d.charCodeAt(0) - 0x09E6));
    const numbersIn = (t) => new Set((bnDigits(t).match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[,.]$/, '')).filter((n) => n.length >= 2));
    const articleNumbers = numbersIn(`${title} ${summary}`);
    const contextTokens = tokens(`${summary} ${keywords.join(' ')} ${entityNames.join(' ')}`);
    const contextSim = (text) => {
      const b = tokens(text);
      if (!contextTokens.size || !b.size) return 0;
      let inter = 0;
      b.forEach((w) => { if (contextTokens.has(w)) inter += 1; });
      return inter / Math.min(contextTokens.size, b.size);
    };
    const dateScore = (published) => {
      if (!hasPubDate || !published) return 0.5;
      const t = new Date(published).getTime();
      if (Number.isNaN(t)) return 0.5;
      const days = Math.abs(t - pubDate.getTime()) / 86400000;
      return days <= 1.5 ? 1 : Math.max(0, 1 - (days - 1.5) / 6);
    };
    const numberScore = (text) => {
      if (!articleNumbers.size) return 0;
      const found = numbersIn(text);
      let hit = 0;
      articleNumbers.forEach((n) => { if (found.has(n)) hit += 1; });
      return Math.min(1, hit / Math.min(articleNumbers.size, 3));
    };

    // Combined search: exact title, title + key facts, summary lead, and entity/keyword context.
    const firstSentence = summary.split(/[।.!?]/)[0].split(' ').slice(0, 14).join(' ');
    const queries = [
      title.length >= 8 ? `"${title.split(' ').slice(0, 10).join(' ')}"` : '',
      title.length >= 8 && entityNames.length ? `${title.split(' ').slice(0, 6).join(' ')} ${entityNames[0]}` : '',
      firstSentence.length >= 15 ? firstSentence : '',
      [...entityNames.slice(0, 2), ...keywords.slice(0, 2)].join(' '),
    ].filter((q, i, arr) => q && q.trim() && arr.indexOf(q) === i);
    // Related fact-checks from the local index — only once the AI summary/keywords exist (the
    // frontend's second call), so the fast title-only call spends no LLM tokens.
    const factCheckPromise = (summary || keywords.length)
      ? factCheckLookup.findRelatedFactChecks({
        title, summary, keywords, entities: entityNames,
        llmProvider: geminiAnalysis.normalizeLlmProvider(req.query.llm_provider || 'auto'),
        run: geminiAnalysis.runPromptWithProvider,
      }).catch((e) => ({ items: [], method: { error: e.message } }))
      : Promise.resolve({ items: [], method: { reason: 'waiting for analysis' } });
    const settled = await Promise.allSettled(queries.map((q) => searchGoogleNewsRss(q, { isBangla })));
    const pool = [];
    const seen = new Set();
    settled.forEach((r, qi) => {
      if (r.status !== 'fulfilled') return;
      r.value.forEach((it) => {
        if (isOwnSource(it)) return;
        const key = it.title.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        const titleSim = similarity(it.title);
        const ctx = contextSim(`${it.title} ${it.snippet || ''}`);
        const dateS = dateScore(it.publishedAt);
        const numS = numberScore(`${it.title} ${it.snippet || ''}`);
        const score = 0.4 * titleSim + 0.2 * ctx + 0.2 * dateS + 0.2 * numS;
        pool.push({ ...it, similarity: Number(score.toFixed(2)), signals: { title: Number(titleSim.toFixed(2)), context: Number(ctx.toFixed(2)), date: Number(dateS.toFixed(2)), numbers: Number(numS.toFixed(2)) }, query: qi });
      });
    });
    pool.sort((x, y) => y.similarity - x.similarity);
    // Items from fact-checkers, or with a debunk-style headline, are about a claim — never
    // corroborating coverage of the event — so they can never be "same news in other newspapers".
    pool.forEach((it) => { it.isFactCheck = isFactCheckItem(it); });
    const sameStory = pool.filter((it) => !it.isFactCheck && it.similarity >= 0.5 && (it.signals.title >= 0.35 || it.signals.numbers >= 0.6)).slice(0, 8);
    const sameKeys = new Set(sameStory.map((it) => it.url));
    const related = pool.filter((it) => !sameKeys.has(it.url)).slice(0, 8);

    // Replace Google News redirect links with the publishers' own URLs (one batched decode).
    const shown = [...sameStory, ...related];
    const ids = shown.map((it) => googleNewsDecoder.articleIdFromUrl(it.url)).filter(Boolean);
    const resolved = await googleNewsDecoder.resolvePublisherUrls(ids, { budgetMs: 12000 });
    shown.forEach((it) => {
      const id = googleNewsDecoder.articleIdFromUrl(it.url);
      const publisherUrl = id ? resolved.get(id) : null;
      it.googleNewsUrl = it.url;
      it.viaGoogleNews = !publisherUrl;
      if (publisherUrl) it.url = publisherUrl;
      // A fact-checker can also be recognised from the resolved domain.
      if (!it.isFactCheck && publisherUrl && FACT_CHECKER_DOMAINS.some((d) => publisherUrl.includes(d))) it.isFactCheck = true;
    });
    const finalSame = sameStory.filter((it) => !it.isFactCheck);
    const finalRelated = [...related, ...sameStory.filter((it) => it.isFactCheck)];
    const factChecks = await factCheckPromise;

    res.json({
      success: true,
      sameStory: finalSame,
      related: finalRelated,
      factChecks: factChecks.items,
      factCheckMethod: factChecks.method,
      resolvedCount: shown.filter((it) => !it.viaGoogleNews).length,
    });
  } catch (error) {
    console.error('Error in /related-news:', error.message);
    res.status(500).json({ success: false, error: 'Related news search failed' });
  }
});

// -------------------------------------------------------------------------------
// WEBVIEW PROXY - Bypass X-Frame-Options for iframe embedding
// -------------------------------------------------------------------------------

/**
 * ? Endpoint: GET /api/webview
 * Purpose: Proxy a webpage and strip security headers for iframe embedding
 * Query: url=<TARGET_URL>
 * Output: Modified HTML with <base href> injected
 */
router.get('/webview', async (req, res) => {
  let { url } = req.query;

  if (!url) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html><body style="font-family: sans-serif; padding: 20px; text-align: center;">
        <h3>?? Missing URL Parameter</h3>
        <p>Usage: /api/webview?url=https://example.gov.bd</p>
      </body></html>
    `);
  }

  const validatedUrl = await validateExternalHttpUrl(String(url), {
    allowPrivateNetwork: ALLOW_PRIVATE_NETWORK_URLS,
    label: 'url',
  });

  if (!validatedUrl.ok) {
    return res.status(validatedUrl.status || 400).send(`
      <!DOCTYPE html>
      <html><body style="font-family: sans-serif; padding: 20px; text-align: center;">
        <h3>?? Invalid URL</h3>
        <p>${validatedUrl.reason || 'URL is not allowed'}</p>
      </body></html>
    `);
  }

  url = validatedUrl.normalizedUrl;

  try {
    console.log(`\n?? [WEBVIEW] Proxying: ${url}`);
    
    const { html, contentType } = await fetchAndProxyWebpage(url);

    // --- Override ALL security headers that block iframe embedding ---
    res.setHeader('Content-Type', contentType);

    // Remove Helmet's cross-origin isolation headers (they block cross-port iframes)
    res.removeHeader('Cross-Origin-Embedder-Policy');
    res.removeHeader('Cross-Origin-Opener-Policy');
    res.removeHeader('Cross-Origin-Resource-Policy');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Content-Type-Options');
    res.removeHeader('Strict-Transport-Security');
    res.removeHeader('X-Download-Options');
    res.removeHeader('X-Permitted-Cross-Domain-Policies');
    res.removeHeader('X-XSS-Protection');
    res.removeHeader('Referrer-Policy');
    res.removeHeader('Origin-Agent-Cluster');
    res.removeHeader('X-DNS-Prefetch-Control');

    // Set permissive headers for iframe embedding
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=12000'); // 20x = ~200 minutes (was 10 minutes)

    res.send(html);

  } catch (error) {
    console.error('? [WEBVIEW] Proxy error:', error.message);
    // fetchAndProxyWebpage now never throws � it returns error HTML itself
    // This catch is a safety net

    // Remove all blocking headers
    res.removeHeader('Cross-Origin-Embedder-Policy');
    res.removeHeader('Cross-Origin-Opener-Policy');
    res.removeHeader('Cross-Origin-Resource-Policy');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Content-Type-Options');
    res.removeHeader('Strict-Transport-Security');
    res.removeHeader('Origin-Agent-Cluster');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    res.status(200).send(`
      <!DOCTYPE html>
      <html><body style="font-family: sans-serif; padding: 40px; text-align: center; background: #f7faf5;">
        <div style="font-size: 48px; margin-bottom: 16px;">??</div>
        <h3 style="color: #6a1b25;">????? ??????</h3>
        <p>${error.message}</p>
        <p style="font-size: 12px; color: #666;">URL: ${url}</p>
        <a href="${url}" target="_blank" rel="noopener"
           style="display:inline-block;margin-top:20px;padding:10px 20px;background:#006a4e;color:white;border:none;border-radius:4px;cursor:pointer;text-decoration:none;font-weight:600;">
          ???? ?????? ????? ?
        </a>
      </body></html>
    `);
  }
});

/**
 * ? Endpoint: GET /api/extract-image
 * Purpose: Extract profile image(s) from a government webpage
 * UPGRADED: Supports multi-image extraction for all officer roles
 * Query: url=<TARGET_URL>&refresh=true&count=3&persist=true
 * Output: { success: boolean, imageUrl: string | null, images?: string[] }
 */
router.get('/extract-image', async (req, res) => {
  const { refresh, persist, count } = req.query;
  let { url } = req.query;

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL parameter required' });
  }

  const validated = await validateExternalHttpUrl(String(url), {
    allowPrivateNetwork: ALLOW_PRIVATE_NETWORK_URLS,
    label: 'url',
  });
  if (!validated.ok) {
    return res.status(validated.status || 400).json({ success: false, error: validated.reason || 'Invalid or unsafe URL' });
  }
  url = validated.normalizedUrl;
  const officerVerdict = await officerUrlGuard.check(url);
  if (!officerVerdict.ok) {
    return res.status(400).json({ success: false, error: `URL refused: ${officerVerdict.reason}` });
  }

  try {
    const imageFetcher = require('../services/imageFetcher');
    const requestedCount = Math.max(1, Math.min(parseInt(count || '1', 10) || 1, 5));
    const shouldPersist = persist !== 'false';

    if (requestedCount > 1) {
      // -- Multi-image mode: return array of images for all officers --
      const images = await imageFetcher.fetchAllOfficerImages(url, {
        forceRefresh: refresh === 'true',
        maxCount: requestedCount,
      });

      const finalImages = [];
      for (const imageUrl of images) {
        let finalUrl = imageUrl;
        if (shouldPersist) {
          const saved = await downloadImage(imageUrl, url);
          if (saved?.savedPath) finalUrl = saved.savedPath;
        }
        finalImages.push(finalUrl);
      }

      // Per-role fields come only from the page's own role blocks, for roles that have a name (rule R3). The
      // position-ordered list stays available as `images`, but it is never read as "1st = primary, 2nd = alternate".
      const roleImages = { primary: null, alternate: null, appellate: null };
      const scraped = await runWebsiteLinkTask(() => scrapeInfoOfficersPage(url, {}), null, `extract-image roles:${url}`);
      if (scraped) {
        for (const role of Object.keys(roleImages)) {
          const photo = pickOfficerTableField(scraped[role] || {}, 'name') ? scraped[`${role}Photo`] : '';
          if (!photo) continue;
          let finalUrl = photo;
          if (shouldPersist) {
            const saved = await downloadImage(photo, url);
            if (saved?.savedPath) finalUrl = saved.savedPath;
          }
          roleImages[role] = finalUrl;
        }
      }

      res.json({
        success: true,
        imageUrl: roleImages.primary || null,
        images: finalImages,
        primaryImage: roleImages.primary,
        alternateImage: roleImages.alternate,
        appellateImage: roleImages.appellate,
      });
    } else {
      // -- Single-image mode (backward compatible) --
      const imageUrl = await imageFetcher.fetchOfficerImage(url, { forceRefresh: refresh === 'true' });

      let finalUrl = imageUrl || null;
      if (imageUrl && shouldPersist) {
        const saved = await downloadImage(imageUrl, url);
        if (saved?.savedPath) finalUrl = saved.savedPath;
      }

      res.json({ success: true, imageUrl: finalUrl });
    }
  } catch (error) {
    console.error('? [EXTRACT-IMAGE] Error:', error.message);
    res.json({ success: false, imageUrl: null, images: [], error: error.message });
  }
});

/**
 * ? Endpoint: POST /api/extract-images
 * Purpose: Batch extract profile images from multiple government webpages
 * Body: { urls: string[], refresh?: boolean, concurrency?: number }
 * Output: { success: boolean, results: Array<{ url, success, imageUrl, error? }> }
 */
router.post('/extract-images', async (req, res) => {
  const urlsRaw = req.body?.urls;
  const refresh = req.body?.refresh === true;
  const persist = req.body?.persist !== false;
  const concurrency = Math.max(1, Math.min(parseInt(req.body?.concurrency || '4', 10) || 4, 8));

  if (!Array.isArray(urlsRaw) || urlsRaw.length === 0) {
    return res.status(400).json({ success: false, error: 'Body must include urls: string[]' });
  }

  const rawUniqueUrls = Array.from(new Set(urlsRaw))
    .map((u) => (u == null ? '' : String(u)).trim())
    .filter(Boolean)
    .slice(0, 30);

  const validatedList = [];
  for (const candidate of rawUniqueUrls) {
    const result = await validateExternalHttpUrl(candidate, {
      allowPrivateNetwork: ALLOW_PRIVATE_NETWORK_URLS,
      label: 'url',
    });
    if (result.ok) {
      validatedList.push(result.normalizedUrl);
    }
  }

  const urls = Array.from(new Set(validatedList));

  if (urls.length === 0) {
    return res.status(400).json({ success: false, error: 'No valid http(s) URLs provided' });
  }

  try {
    const imageFetcher = require('../services/imageFetcher');

    const results = new Array(urls.length);
    let nextIndex = 0;

    const worker = async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= urls.length) return;
        const u = urls[i];
        try {
          if (!(await officerUrlGuard.check(u)).ok) continue;
          const imageUrl = await imageFetcher.fetchOfficerImage(u, { forceRefresh: refresh });
          let finalUrl = imageUrl || null;
          if (imageUrl && persist) {
            const saved = await downloadImage(imageUrl, u);
            if (saved?.savedPath) finalUrl = saved.savedPath;
          }
          results[i] = { url: u, success: true, imageUrl: finalUrl };
        } catch (err) {
          results[i] = { url: u, success: false, imageUrl: null, error: err?.message || String(err) };
        }
      }
    };

    await Promise.all(new Array(Math.min(concurrency, urls.length)).fill(0).map(() => worker()));
    res.json({ success: true, results });
  } catch (error) {
    console.error('? [EXTRACT-IMAGES] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * ? Endpoint: POST /api/clear-image-cache
 * Purpose: Clear all cached officer images (memory + disk)
 * Use this when image scraping logic is updated or to force fresh fetches
 */
router.post('/clear-image-cache', async (req, res) => {
  try {
    const imageFetcher = require('../services/imageFetcher');
    imageFetcher.clearImageCache();
    res.json({ success: true, message: 'Image cache cleared successfully' });
  } catch (error) {
    console.error('? [CLEAR-IMAGE-CACHE] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * ? Endpoint: GET /api/templates
 * Purpose: List available pre-saved email templates (text files)
 */
router.get('/templates', async (req, res) => {
  try {
    const templatesDir = path.join(__dirname, '../../frontend/pre_saved folder for email body');
    const allowedExtensions = new Set(['.txt', '.rtf', '.docx']);
    // Ensure directory exists
    try {
      await fs.access(templatesDir);
    } catch {
      return res.json({ success: true, templates: [] }); // Return empty if dir missing
    }

    const files = await fs.readdir(templatesDir);
    const templates = files
      .filter((name) => {
        const ext = path.extname(name).toLowerCase();
        return allowedExtensions.has(ext);
      })
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    res.json({ success: true, templates });
  } catch (error) {
    console.error('? Error listing templates:', error);
    res.status(500).json({ success: false, error: 'Failed to list templates' });
  }
});

/**
 * ? Endpoint: GET /api/templates/:filename
 * Purpose: Get content of a specific template
 */
router.get('/templates/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const allowedExtensions = new Set(['.txt', '.rtf', '.docx']);
    // Security check: prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ success: false, error: 'Invalid filename' });
    }

    const ext = path.extname(filename).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      return res.status(400).json({ success: false, error: 'Unsupported template type' });
    }

    const templatesDir = path.join(__dirname, '../../frontend/pre_saved folder for email body');
    const filePath = path.join(templatesDir, filename);

    // For rich templates we return HTML that Quill can paste/insert directly.
    // For .txt we return plain text (frontend converts newlines to <br/> and escapes HTML).
    let content = '';
    let format = 'text';

    if (ext === '.txt') {
      content = await fs.readFile(filePath, 'utf8');
      format = 'text';
    } else if (ext === '.rtf') {
      const rtf = await fs.readFile(filePath, 'utf8');
      content = await rtfToHtml.fromString(rtf);
      format = 'html';
    } else if (ext === '.docx') {
      const result = await mammoth.convertToHtml(
        { path: filePath },
        {
          convertImage: mammoth.images.inline(async (image) => {
            const buffer = await image.read();
            const base64 = Buffer.from(buffer).toString('base64');
            return { src: `data:${image.contentType};base64,${base64}` };
          }),
        }
      );
      content = (result && result.value) || '';
      format = 'html';
    }

    res.json({ success: true, content, format });
  } catch (error) {
    console.error(`? Error reading template ${req.params.filename}:`, error);
    res.status(500).json({ success: false, error: 'Failed to read template' });
  }
});

// ---------------------------------------------------------------------------------------
// ?? STAGE 2: SCHEMA-ENFORCED WEBPAGE SCRAPING (PRIORITY)
// Purpose: Scrape .gov.bd links and map unstructured HTML to exact 26-column database schema
// ---------------------------------------------------------------------------------------

/**
 * Helper: Extract images from HTML near officer names
 * Looks for <img> tags with src or data-src attributes
 */
function extractImageUrlFromHtml($, officerName, htmlSection, baseUrl = '') {
  if (!officerName || !htmlSection) return null;

  /**
   * Convert a potentially relative src to an absolute URL.
   * Returns null if src is empty or not resolvable.
   */
  function toAbsoluteUrl(src) {
    if (!src || !src.trim()) return null;
    src = src.trim();
    if (/^https?:\/\//i.test(src)) return src;
    if (baseUrl) {
      try {
        return new URL(src, baseUrl).href;
      } catch { /* fall through */ }
    }
    // Protocol-relative
    if (src.startsWith('//')) return 'https:' + src;
    return null;
  }

  try {
    const imgs = $(htmlSection).find('img');
    let bestImage = null;

    imgs.each((i, img) => {
      const $img = $(img);
      const rawSrc = $img.attr('src') || $img.attr('data-src') || $img.attr('data-lazy-src') || '';
      const alt = ($img.attr('alt') || '').toLowerCase();
      const ariaLabel = ($img.attr('aria-label') || '').toLowerCase();

      // Skip tiny tracker images / icons
      const w = parseInt($img.attr('width') || '0', 10);
      const h = parseInt($img.attr('height') || '0', 10);
      if ((w > 0 && w < 30) || (h > 0 && h < 30)) return;
      if (/icon|logo|sprite|spacer|pixel|tracking/i.test(rawSrc)) return;

      const abs = toAbsoluteUrl(rawSrc);
      if (!abs) return;

      // Prefer images whose alt/label match the officer name or common profile keywords
      const namePart = (officerName || '').toLowerCase().split(' ')[0];
      if (alt.includes('officer') || alt.includes('profile') || alt.includes('photo') ||
          ariaLabel.includes('officer') || ariaLabel.includes('profile') ||
          (namePart.length > 2 && alt.includes(namePart))) {
        bestImage = abs;
        return false; // Break
      }
      if (!bestImage) bestImage = abs; // First valid image as fallback
    });

    return bestImage; // null if nothing found � frontend shows silhouette avatar
  } catch (e) {
    console.warn(`??  Image extraction failed for ${officerName}:`, e.message);
    return null;
  }
}

/**
 * POST /api/stage2-scrape
 * Scrapes a .gov.bd webpage and maps data to 26-column schema
 * 
 * Request Body:
 * {
 *   "url": "https://example.gov.bd/contact",
 *   "llm_provider": "gemini" (optional, defaults to Gemini for large context)
 * }
 * 
 * Response: {
 *   "success": true,
 *   "data": { ...26-column schema },
 *   "raw_html_sections": { primary: "...", alternate: "...", appellate: "..." },
 *   "confidence": { primary: 0.95, alternate: 0.8, appellate: 0.6 }
 * }
 */
router.post('/stage2-scrape', [
  body('url').notEmpty().isURL().withMessage('Valid URL required'),
  body('llm_provider').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: errors.array() });
    }

    const { url, llm_provider = 'gemini' } = req.body;
    const validatedUrl = await validateExternalHttpUrl(url, {
      allowPrivateNetwork: ALLOW_PRIVATE_NETWORK_URLS,
      label: 'url',
    });
    if (!validatedUrl.ok) {
      return res.status(validatedUrl.status || 400).json({
        success: false,
        error: 'Invalid scrape URL',
        details: validatedUrl.reason,
      });
    }

    const safeUrl = validatedUrl.normalizedUrl;
    console.log(`\n?? [STAGE2] Scraping webpage schema: ${safeUrl}`);
    console.log(`   LLM Provider: ${llm_provider}`);

    // Step 1: Fetch the webpage
    let htmlContent = '';
    try {
      const response = await axiosGetWithGovTlsFallback(safeUrl, {
        timeout: isGovBdHostFromUrl(safeUrl) ? GOV_SCRAPE_TIMEOUT_MS : DEFAULT_SCRAPE_TIMEOUT_MS,
        // Every click of "স্ক্র্যাপ করুন" must genuinely re-fetch the live page, never a
        // stale cached/conditional response (some gov.bd hosts sit behind a caching layer).
        headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
      });
      htmlContent = response.data;
      console.log(`? [STAGE2] Fetched HTML (${htmlContent.length} bytes)`);
    } catch (fetchErr) {
      console.error(`? [STAGE2] Fetch failed:`, fetchErr.message);
      return res.status(400).json({ 
        success: false, 
        error: 'Failed to fetch webpage',
        details: fetchErr.message 
      });
    }

    // Step 2: Parse HTML with Cheerio and extract text sections
    const $ = cheerio.load(htmlContent);
    
    // Remove script/style tags
    $('script, style').remove();
    
    // Extract main contact/officer information text
    const bodyText = $('body').text();
    const tables = $('table').length;
    const articles = $('article, main, [role="main"]').html() || bodyText.substring(0, 5000);
    
    const scrapedText = articles || bodyText;
    console.log(`?? [STAGE2] Extracted text (${scrapedText.length} chars from ${tables} tables)`);

    // Step 3: Use Gemini to parse HTML into schema
    let parsedData = null;
    try {
      const geminiPrompt = `
You are a schema mapping expert. Parse this government website HTML and extract officer contact information into EXACTLY this JSON schema:

{
  "Ministry": "string",
  "Division": "string", 
  "Office": "string",
  "Primary_Officer_Name": "string",
  "Primary_Designation": "string",
  "Primary_Phone": "string",
  "Primary_Mobile": "string",
  "Primary_Email": "string",
  "Primary_Address": "string",
  "Primary_Image_URL": "absolute URL string or null",
  "Alternate_Officer_Name": "string",
  "Alternate_Designation": "string",
  "Alternate_Phone": "string",
  "Alternate_Mobile": "string",
  "Alternate_Email": "string",
  "Alternate_Address": "string",
  "Alternate_Image_URL": "absolute URL string or null",
  "Appellate_Officer_Name": "string",
  "Appellate_Designation": "string",
  "Appellate_Phone": "string",
  "Appellate_Mobile": "string",
  "Appellate_Email": "string",
  "Appellate_Address": "string",
  "Appellate_Image_URL": "absolute URL string or null",
  "Website_Link": "${safeUrl}",
  "Last_Updated": "YYYY-MM-DD"
}

HTML Content:
${scrapedText.substring(0, 8000)}

CRITICAL: Return ONLY valid JSON. Use empty strings for missing text fields. Use null (not empty string) for missing _Image_URL fields. Convert any relative image paths to absolute using base URL: ${safeUrl}. Combine Bangla and English names.`;

      const analysisLlmResult = await Promise.race([
        geminiAnalysis.runPromptWithProvider(geminiPrompt, {
          llmProvider: llm_provider,
          operation: 'stage2SchemaExtract',
          maxTokens: 2000,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Stage2 Gemini timeout')), 15000)),
      ]);

      const analysisText = analysisLlmResult.text || '';
      if (analysisText.trim()) {
        parsedData = geminiAnalysis.safeJsonParse(analysisText);
        if (!parsedData || typeof parsedData !== 'object' || Array.isArray(parsedData)) {
          console.warn(`⚠️  [STAGE2] JSON parse failed, falling back to blank schema`);
          parsedData = {};
        } else {
          console.log(`✅ [STAGE2] Schema parsed successfully via ${analysisLlmResult.providerUsed}`);
        }
      }
    } catch (geminiErr) {
      console.error(`❌ [STAGE2] Gemini parsing failed:`, geminiErr.message);
      // Continue with empty data
      parsedData = {};
    }

    // Step 4: Enhance with local image extraction � pass baseUrl for relative?absolute conversion
    try {
      if (!parsedData.Primary_Image_URL) {
        parsedData.Primary_Image_URL = extractImageUrlFromHtml($, parsedData.Primary_Officer_Name, 'body', safeUrl) ?? null;
      }
      if (!parsedData.Alternate_Image_URL) {
        parsedData.Alternate_Image_URL = extractImageUrlFromHtml($, parsedData.Alternate_Officer_Name, 'body', safeUrl) ?? null;
      }
      if (!parsedData.Appellate_Image_URL) {
        parsedData.Appellate_Image_URL = extractImageUrlFromHtml($, parsedData.Appellate_Officer_Name, 'body', safeUrl) ?? null;
      }
    } catch (imgErr) {
      console.warn(`??  [STAGE2] Image extraction fallback:`, imgErr.message);
    }

    // Step 5: Build confidence scores
    const confidence = {
      primary: (parsedData.Primary_Officer_Name ? 0.95 : 0) + 
               (parsedData.Primary_Mobile || parsedData.Primary_Phone ? 0.05 : 0),
      alternate: (parsedData.Alternate_Officer_Name ? 0.9 : 0) +
                 (parsedData.Alternate_Mobile || parsedData.Alternate_Phone ? 0.05 : 0),
      appellate: (parsedData.Appellate_Officer_Name ? 0.85 : 0) +
                 (parsedData.Appellate_Mobile || parsedData.Appellate_Phone ? 0.05 : 0)
    };

    console.log(`?? [STAGE2] Confidence scores:`, confidence);

    // Step 6: Return formatted response for VerificationGrid
    const schemaDefaults = {
      Ministry: '',
      Division: '',
      Office: '',
      Primary_Officer_Name: '',
      Primary_Designation: '',
      Primary_Phone: '',
      Primary_Mobile: '',
      Primary_Email: '',
      Primary_Address: '',
      Primary_Image_URL: null,
      Alternate_Officer_Name: '',
      Alternate_Designation: '',
      Alternate_Phone: '',
      Alternate_Mobile: '',
      Alternate_Email: '',
      Alternate_Address: '',
      Alternate_Image_URL: null,
      Appellate_Officer_Name: '',
      Appellate_Designation: '',
      Appellate_Phone: '',
      Appellate_Mobile: '',
      Appellate_Email: '',
      Appellate_Address: '',
      Appellate_Image_URL: null,
      Website_Link: safeUrl,
      Last_Updated: new Date().toISOString().split('T')[0]
    };

    return res.json({
      success: true,
      data: {
        ...schemaDefaults,
        ...parsedData,
        Website_Link: safeUrl,
      },
      raw_html_sections: {
        primary: $('[class*="primary"], [class*="duty"]').html()?.substring(0, 500) || '',
        alternate: $('[class*="alternate"], [class*="second"]').html()?.substring(0, 500) || '',
        appellate: $('[class*="appellate"], [class*="appeal"]').html()?.substring(0, 500) || ''
      },
      confidence,
      scraping_metadata: {
        url: safeUrl,
        tables_found: tables,
        html_bytes: htmlContent.length,
        extracted_chars: scrapedText.length,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('? Error in /stage2-scrape:', error);
    res.status(500).json({
      success: false,
      error: 'Schema scraping failed',
      details: error.message
    });
  }
});

// ---------------------------------------------------------------------------------------
// ?? STAGE 1: AI-POWERED NEWS INGESTION & EXTRACTION
// Purpose: Process raw news articles into structured UI data (3 bullets + entities)
// ---------------------------------------------------------------------------------------

/**
 * POST /api/stage1-summarize
 * Extracts structured summaries and entities from news text
 * 
 * Request Body:
 * {
 *   "text": "full news article text",
 *   "title": "article title (optional)",
 *   "llm_provider": "openai|gemini|cerebras"
 * }
 * 
 * Response: {
 *   "success": true,
 *   "summary_bullets": ["Bullet 1", "Bullet 2", "Bullet 3"],
 *   "entities": {
 *     "Government_Organization": ["Org1", "Org2"],
 *     "Entities": ["Entity1"],
 *     "Person_Names": ["Name1"],
 *     "Designations": ["Designation1"]
 *   }
 * }
 */
router.post('/stage1-summarize', [
  body('text').notEmpty().withMessage('Article text required'),
  body('title').optional().isString(),
  body('llm_provider').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: errors.array() });
    }

    const { text, title = '', llm_provider = 'openai' } = req.body;
    console.log(`\n?? [STAGE1] Summarizing news article (${text.length} chars)`);
    console.log(`   Title: ${title}`);
    console.log(`   LLM Provider: ${llm_provider}`);

    // Step 1: Generate 3-bullet summary using OpenAI
    let summaryBullets = [];
    try {
      const summaryPrompt = `Summarize this news article in EXACTLY 3 bullet points. Return ONLY a valid JSON array of 3 strings, nothing else.

Article: ${text.substring(0, 2000)}`;

      const summaryLlmResult = await Promise.race([
        geminiAnalysis.runPromptWithProvider(summaryPrompt, {
          llmProvider: 'openai',
          operation: 'stage1Summary',
          maxTokens: 300,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Stage1 summary timeout')), 15000)),
      ]);

      const summaryText = summaryLlmResult.text || '';
      const summaryParsed = geminiAnalysis.safeJsonParse(summaryText);
      if (Array.isArray(summaryParsed)) {
        summaryBullets = summaryParsed.slice(0, 3);
        while (summaryBullets.length < 3) summaryBullets.push('');
      } else if (summaryText.trim()) {
        // Plain text fallback: split by newlines
        summaryBullets = summaryText.split('\n').filter(Boolean).slice(0, 3);
        while (summaryBullets.length < 3) summaryBullets.push('');
      }
      console.log(`? [STAGE1] Generated ${summaryBullets.length} summary bullets via ${summaryLlmResult.providerUsed}`);
    } catch (summaryErr) {
      console.error(`? [STAGE1] Summary generation failed:`, summaryErr.message);
      summaryBullets = ['Unable to generate summary', '', ''];
    }

    // Step 2: Extract entities using Gemini
    let entities = {
      Government_Organization: [],
      Entities: [],
      Person_Names: [],
      Designations: []
    };

    try {
      const entityPrompt = `Extract entities from this news text and return ONLY valid JSON:

{
  "Government_Organization": ["org1", "org2"],
  "Entities": ["entity1"],
  "Person_Names": ["name1"],
  "Designations": ["title1"]
}

News Text: ${text.substring(0, 3000)}`;

      const entityLlmResult = await Promise.race([
        geminiAnalysis.runPromptWithProvider(entityPrompt, {
          llmProvider: 'gemini',
          operation: 'stage1Entities',
          maxTokens: 800,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Stage1 entity timeout')), 15000)),
      ]);

      const entityText = entityLlmResult.text || '';
      const parsed = geminiAnalysis.safeJsonParse(entityText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (Array.isArray(parsed.Government_Organization)) entities.Government_Organization = parsed.Government_Organization.slice(0, 10);
        if (Array.isArray(parsed.Entities)) entities.Entities = parsed.Entities.slice(0, 10);
        if (Array.isArray(parsed.Person_Names)) entities.Person_Names = parsed.Person_Names.slice(0, 10);
        if (Array.isArray(parsed.Designations)) entities.Designations = parsed.Designations.slice(0, 10);
        console.log(`? [STAGE1] Extracted entities via ${entityLlmResult.providerUsed}`);
      }
    } catch (entityErr) {
      console.error(`? [STAGE1] Entity extraction failed:`, entityErr.message);
    }

    return res.json({
      success: true,
      summary_bullets: summaryBullets.slice(0, 3),
      entities,
      article_metadata: {
        length: text.length,
        title,
        extraction_timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('? Error in /stage1-summarize:', error);
    res.status(500).json({
      success: false,
      error: 'Summary extraction failed',
      details: error.message
    });
  }
});

// ---------------------------------------------------------------------------------------
// ?? STAGE 3: REAL-TIME DYNAMIC VERIFICATION FALLBACK
// Purpose: Use Cerebras for ultra-fast fallback when local DB search returns nothing
// ---------------------------------------------------------------------------------------

/**
 * POST /api/stage3-fallback
 * Cerebras-based fallback for officer lookups not in local database
 * 
 * Request Body:
 * {
 *   "officer_name": "John Doe",
 *   "ministry": "Health",
 *   "context": "additional context (optional)"
 * }
 * 
 * Response: {
 *   "success": true,
 *   "officer_data": { ...office officer schema },
 *   "source": "cerebras_synthesis",
 *   "confidence": 0.75
 * }
 */
router.post('/stage3-fallback', [
  body('officer_name').notEmpty().withMessage('Officer name required'),
  body('ministry').optional().isString(),
  body('context').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: errors.array() });
    }

    const { officer_name, ministry = '', context = '' } = req.body;
    console.log(`\n? [STAGE3] Cerebras fallback for: ${officer_name} (${ministry})`);

    // Use Cerebras for ultra-fast inference
    const cerebrasPrompt = `As a government database expert, synthesize contact information for:
Officer: ${officer_name}
Ministry: ${ministry}
Context: ${context}

Return ONLY valid JSON matching this schema:
{
  "Primary_Officer_Name": "string",
  "Primary_Designation": "string",
  "Primary_Mobile": "string",
  "Primary_Email": "string",
  "Ministry": "string",
  "Office": "string",
  "Website_Link": "string",
  "confidence_note": "Generated from public synthesis"
}`;

    let fallbackData = {
      Primary_Officer_Name: officer_name,
      Primary_Designation: '',
      Primary_Mobile: '',
      Primary_Email: '',
      Ministry: ministry,
      Office: '',
      Website_Link: '',
      confidence_note: 'Generated from public synthesis'
    };

    try {
      // Call Cerebras (or fallback to gemini) for ultra-fast response
      const cerebrasLlmResult = await Promise.race([
        geminiAnalysis.runPromptWithProvider(cerebrasPrompt, {
          llmProvider: 'cerebras',
          operation: 'stage3Fallback',
          maxTokens: 400,
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Stage3 cerebras timeout')), 15000)),
      ]);

      const cerebrasText = cerebrasLlmResult.text || '';
      const parsed = geminiAnalysis.safeJsonParse(cerebrasText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fallbackData = { ...fallbackData, ...parsed };
        console.log(`? [STAGE3] Synthesized officer data via ${cerebrasLlmResult.providerUsed}`);
      }
    } catch (cerebrasErr) {
      console.error(`? [STAGE3] Cerebras call failed:`, cerebrasErr.message);
      // Return defaults
    }

    return res.json({
      success: true,
      officer_data: fallbackData,
      source: 'cerebras_synthesis',
      confidence: 0.65,
      fallback_note: 'This is synthesized data. Verify through official channels.',
      response_time: 'ultra-fast',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('? Error in /stage3-fallback:', error);
    res.status(500).json({
      success: false,
      error: 'Fallback lookup failed',
      details: error.message
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  SSE STREAM ENDPOINT  –  GET /api/analyze-stream?url=<encodedUrl>&provider=auto
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/analyze-stream', async (req, res) => {
  const { url: articleUrl, provider = 'auto' } = req.query;
  if (!articleUrl) return res.status(400).json({ error: 'url param required' });

  // ── SSE headers ──
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  const pingInterval = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch {}
  }, 25000);

  try {
    // ── Stage 1: Ingest article ──
    let articleText = '';
    let articleHtml = '';
    let articleTitle = '';
    let articleSource = '';

    try {
      const extractorModule = require('./playwrightExtractor');
      const extracted = await extractorModule.extractArticle(articleUrl);
      articleText   = extracted.text  || extracted.cleanText  || '';
      articleHtml   = extracted.html  || extracted.cleanHtml  || '';
      articleTitle  = extracted.title || '';
      articleSource = extracted.source || extracted.publisher || '';
    } catch (e1) {
      try {
        const axiosFast = require('./axiosFastExtractor');
        const extracted = await axiosFast.extractWithAxiosOnly(articleUrl);
        articleText   = extracted.text  || '';
        articleHtml   = extracted.html  || '';
        articleTitle  = extracted.title || '';
        articleSource = extracted.source || '';
      } catch (e2) {
        sendEvent('error', { message: `Article extraction failed: ${e2.message}` });
        clearInterval(pingInterval);
        return res.end();
      }
    }

    const wordCount = (articleText.match(/\S+/g) || []).length;
    sendEvent('ingestion_complete', { title: articleTitle, source: articleSource, wordCount });

    // ── Stage 2: Hashes ──
    const hashes = evidenceVault.computeHashes(articleText);
    sendEvent('hashes_ready', { hashes });

    // ── Stage 3: Quick LLM analysis + deterministic analytics ──
    const [quickResult, moneyMentions, timeline] = await Promise.all([
      geminiAnalysis.analyzeQuick(articleText, articleUrl, { llmProvider: provider }),
      Promise.resolve(analyticsEngine.extractMoneyMentions(articleText)),
      Promise.resolve(analyticsEngine.extractTimeline(articleText)),
    ]);

    const rtiScore       = analyticsEngine.computeRtiScore({
      entities:        quickResult.entities         || [],
      moneyMentions,
      legalImplications: quickResult.legalImplications || [],
      civicRelevance:  quickResult.civic_grievance  || false,
    });
    const corruptionRisk = analyticsEngine.corruptionRiskEngine(articleText, moneyMentions, timeline);
    const sourceCredibility = analyticsEngine.getSourceCredibility(articleUrl, articleText);

    sendEvent('analysis_complete', {
      ...quickResult,
      moneyMentions,
      timeline,
      rtiScore,
      corruptionRisk,
      sourceCredibility,
    });

    // ── Stage 4: Deep LLM analysis (parallel with cross-source) ──
    const [deepResult, crossSourceResult] = await Promise.all([
      geminiAnalysis.analyzeDeep(articleText, articleUrl, quickResult, { llmProvider: provider }),
      crossSourceIntelligence.discoverSimilarArticles({
        articleUrl,
        articleTitle,
        articleText,
        articlePubDate: quickResult.publishedDate || '',
        keywords:       quickResult.keywords      || [],
        entities:       quickResult.entities      || [],
        summary:        quickResult.summary       || '',
      }),
    ]);

    sendEvent('deep_analysis_done', deepResult);
    sendEvent('cross_source_ready', crossSourceResult);

    // ── Stage 5: Evidence vault capture ──
    let evidenceResult = {};
    try {
      evidenceResult = await evidenceVault.captureEvidence({
        articleUrl,
        articleHtml,
        articleText,
        analysisData: { ...quickResult, ...deepResult, moneyMentions, corruptionRisk, rtiScore },
      });
    } catch (evErr) {
      console.warn('[SSE] Evidence vault error:', evErr.message);
      evidenceResult = { error: evErr.message };
    }
    sendEvent('evidence_ready', evidenceResult);

    // ── Stage 6: Final merged payload ──
    sendEvent('research_complete', {
      article: { url: articleUrl, title: articleTitle, source: articleSource, wordCount, hashes },
      analysis: {
        ...quickResult,
        ...deepResult,
        moneyMentions,
        timeline,
        rtiScore,
        corruptionRisk,
        sourceCredibility,
      },
      crossSource: crossSourceResult,
      evidence:    evidenceResult,
    });

  } catch (err) {
    console.error('[SSE] analyze-stream error:', err);
    sendEvent('error', { message: err.message });
  } finally {
    clearInterval(pingInterval);
    res.end();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  EVIDENCE VAULT REST ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/evidence/:uuid/bundle.zip', async (req, res) => {
  try {
    const id = req.params.uuid;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ success: false, error: 'invalid id' });
    const dir = path.join(evidenceVault.VAULT_DIR, id);
    const names = await fs.readdir(dir).catch(() => null);
    if (!names) return res.status(404).json({ success: false, error: 'not found' });
    const JSZip = require('jszip');
    const zip = new JSZip();
    for (const name of names) zip.file(name, await fs.readFile(path.join(dir, name)));
    zip.file('README_VERIFY.txt', 'Verify: shasum -a 256 <file> against manifest.json; openssl ts -verify -in manifest.tsr -queryfile manifest.tsq -CAfile cacert.pem -untrusted tsa.crt\n');
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="jaani_evidence_${id}.zip"`);
    return res.send(buf);
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/evidence/:uuid/forensic-verify', async (req, res) => {
  const id = req.params.uuid;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ success: false, error: 'invalid id' });
  return res.json(await forensicEvidence.verifyForensicBundle(id));
});

// Listing every capture id would let anyone enumerate and download all evidence bundles (ids are
// otherwise unguessable UUIDs). Off unless explicitly enabled for local admin use. No UI calls it.
router.get('/evidence', async (req, res) => {
  if (String(process.env.EVIDENCE_LISTING_ENABLED || '').toLowerCase() !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const page    = Math.max(1, parseInt(req.query.page    || '1',  10));
    const perPage = Math.min(50, parseInt(req.query.perPage || '20', 10));
    const result  = await evidenceVault.listEvidence(page, perPage);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/evidence/:uuid', async (req, res) => {
  try {
    const entry = await evidenceVault.getEvidence(req.params.uuid);
    if (!entry) return res.status(404).json({ error: 'Evidence not found' });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/evidence/:uuid/verify', async (req, res) => {
  try {
    const result = await evidenceVault.verifyEvidence(req.params.uuid);
    if (!result) return res.status(404).json({ error: 'Evidence not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  JAANI STAGE 1 + STAGE 2 INTELLIGENCE STREAM
//  GET /api/jaani-stream?url=<encoded-url>
//
//  Stage 1: Scrape article → emit article_ready + legal_vault_ready (immediate)
//  Stage 2: 6 features concurrently via Promise.allSettled() — stream as ready
//    • executive_ready      — 1-sentence TL;DR (Gemini)
//    • core_analysis_ready  — summary + key takeaways (Gemini)
//    • ai_analytics_ready   — sentiment / bias / keywords / risk (Gemini)
//    • stakeholders_ready   — persons / orgs / locations (reuses extractBengaliGovernmentEntities)
//    • rti_ready            — RTI Act 2009 questions (Gemini)
//    • legal_vault_ready    — deterministic hashes + chain of custody (immediate)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/jaani-stream', async (req, res) => {
  const { url: rawUrl } = req.query;
  if (!rawUrl) return res.status(400).json({ error: 'url query param required' });

  // Security: validate protocol (prevent SSRF via non-HTTP schemes)
  let articleUrl;
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'URL must use http or https' });
    }
    articleUrl = parsed.href;
  } catch (e) {
    return res.status(400).json({ error: `Invalid URL: ${e.message}` });
  }

  // ── SSE headers ──────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  };

  const pingInterval = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) {}
  }, 20000);

  try {
    // ── STAGE 1: Scrape & clean article ─────────────────────────────────────
    let articleText = '';
    let articleHtml = '';
    let articleTitle = '';
    let articleAuthor = '';
    let articleDate = '';
    let articleSource = '';
    let heroImages = [];

    try {
      const extracted = await extractWithAxiosOnly(articleUrl);
      articleText   = extracted.text   || extracted.cleanText   || '';
      articleHtml   = extracted.html   || extracted.cleanHtml   || '';
      articleTitle  = extracted.title  || '';
      articleAuthor = extracted.author || '';
      articleDate   = extracted.date   || extracted.publishedDate || '';
      articleSource = extracted.source || extracted.publisher    || (new URL(articleUrl)).hostname;
      const media   = extractMediaFromHtml(extracted.rawHtml || extracted.html || '', articleUrl);
      heroImages    = (media.imageDetails || []).slice(0, 3).map((img) => ({ url: img.src || img.url, caption: img.caption || '' }));
    } catch (scrapeErr) {
      sendEvent('error', { message: `Scraping failed: ${scrapeErr.message}` });
      clearInterval(pingInterval);
      return res.end();
    }

    // Cryptographic hashes of extracted plain text
    const textBuf    = Buffer.from(articleText, 'utf8');
    const md5Hash    = crypto.createHash('md5').update(textBuf).digest('hex');
    const sha256Hash = crypto.createHash('sha256').update(textBuf).digest('hex');
    const timestamp  = new Date().toISOString();
    const charCount  = articleText.length;
    const wordCount  = (articleText.match(/\S+/g) || []).length;

    // Background: Wayback Machine archive (fire & forget — do not await)
    try {
      https.get(`https://web.archive.org/save/${articleUrl}`, (r) => r.resume()).on('error', () => {});
    } catch (_) {}

    // Emit article_ready immediately after scrape
    sendEvent('article_ready', {
      title: articleTitle,
      author: articleAuthor,
      date: articleDate,
      source: articleSource,
      url: articleUrl,
      html: articleHtml,
      text: articleText.slice(0, 8000),
      images: heroImages,
      hashes: { md5: md5Hash, sha256: sha256Hash },
      timestamp,
      char_count: charCount,
      word_count: wordCount,
    });

    // Emit legal_vault_ready immediately (deterministic — no AI needed)
    const tsCompact  = timestamp.replace(/[-T:.Z]/g, '').slice(0, 14);
    const waybackUrl = `https://web.archive.org/web/${tsCompact}/${articleUrl}`;
    sendEvent('legal_vault_ready', {
      url: articleUrl,
      wayback_url: waybackUrl,
      md5: md5Hash,
      sha256: sha256Hash,
      char_count: charCount,
      timestamp,
      chain_of_custody: [{
        event: 'Article Scraped by JAANI Intelligence Engine',
        timestamp,
        actor: 'JAANI v2',
        hash_sha256: sha256Hash,
      }],
    });

    // ── STAGE 2: Concurrent AI features ─────────────────────────────────────
    const truncated = articleText.slice(0, 4000);

    // Helper: call Gemini with hard 10 s timeout + 1 JSON-parse retry
    const callFeature = async (prompt) => {
      const attemptOnce = () => {
        let handle;
        const timeoutP = new Promise((_, rej) => {
          handle = setTimeout(() => rej(Object.assign(new Error('timeout'), { isTimeout: true })), 10000);
        });
        const callP = geminiAnalysis.callGeminiPrompt(prompt, { maxRetries: 0, baseDelayMs: 0 });
        return Promise.race([callP.finally(() => clearTimeout(handle)), timeoutP]);
      };

      for (let attempt = 0; attempt <= 1; attempt++) {
        try {
          const { text } = await attemptOnce();
          const parsed = geminiAnalysis.safeJsonParse(text);
          if (parsed) return parsed;
          // parsed is null → JSON parse failure; retry once
        } catch (err) {
          if (err.isTimeout || attempt >= 1) return null;
          // non-timeout error → retry once
        }
      }
      return null;
    };

    // Feature 1 — Executive Brief
    const feat1 = callFeature(
      `আপনি বাংলা সংবাদ বিশ্লেষক। সংবাদের এক বাক্যের সারসংক্ষেপ দিন (সর্বোচ্চ ২৫ শব্দ)। শুধুমাত্র JSON।\n\nসংবাদ:\n${truncated}\n\nJSON স্কিমা:\n{"tldr":"...","word_count":${wordCount}}`
    ).then((data) => sendEvent('executive_ready', data || { tldr: null, word_count: wordCount }))
     .catch(()   => sendEvent('executive_ready', { tldr: null, word_count: wordCount }));

    // Feature 2 — Core Analysis
    const feat2 = callFeature(
      `সংবাদের ৩-৪ বাক্যের সারসংক্ষেপ এবং ৪-৬টি মূল বিষয় বের করুন। শুধুমাত্র JSON।\n\nসংবাদ:\n${truncated}\n\nJSON স্কিমা:\n{"summary":"...","key_takeaways":["..."]}`
    ).then((data) => sendEvent('core_analysis_ready', data || { summary: null, key_takeaways: [] }))
     .catch(()   => sendEvent('core_analysis_ready', { summary: null, key_takeaways: [] }));

    // Feature 3 — AI Analytics
    const feat3 = callFeature(
      `You are a Bengali news analyst. Analyze the article. Return ONLY JSON.\n\nArticle:\n${truncated}\n\nJSON schema:\n{"sentiment":"negative|positive|neutral","sentiment_score":0.0,"bias_score":0,"bias_label":"...","top_keywords":["..."],"corruption_risk":"high|medium|low"}`
    ).then((data) => sendEvent('ai_analytics_ready', data || { sentiment: null, sentiment_score: null, bias_score: null, bias_label: null, top_keywords: [], corruption_risk: null }))
     .catch(()   => sendEvent('ai_analytics_ready', { sentiment: null, sentiment_score: null, bias_score: null, bias_label: null, top_keywords: [], corruption_risk: null }));

    // Feature 4 — Stakeholder Mapping (reuses existing entity extraction)
    const feat4 = (() => {
      let handle;
      const timeoutP = new Promise((_, rej) => {
        handle = setTimeout(() => rej(new Error('stakeholders timeout')), 12000);
      });
      return Promise.race([
        geminiAnalysis.extractBengaliGovernmentEntities(truncated).finally(() => clearTimeout(handle)),
        timeoutP,
      ])
        .then((data) => sendEvent('stakeholders_ready', data || { entities: [], status: 'failed' }))
        .catch(()   => sendEvent('stakeholders_ready', { entities: [], status: 'failed' }));
    })();

    // Feature 5 — RTI Angle Generator
    const feat5 = callFeature(
      `You are a Bangladesh RTI Act 2009 expert. Generate 4-6 specific, legally relevant RTI questions in Bengali based on the article's facts. Return ONLY JSON.\n\nArticle:\n${truncated}\n\nJSON schema:\n{"rti_score":85,"questions":["Bengali RTI question..."],"deadline_days":20}`
    ).then((data) => sendEvent('rti_ready', data || { rti_score: null, questions: [], deadline_days: 20 }))
     .catch(()   => sendEvent('rti_ready', { rti_score: null, questions: [], deadline_days: 20 }));

    // Wait for all AI features to complete before ending the stream
    await Promise.allSettled([feat1, feat2, feat3, feat4, feat5]);

  } catch (err) {
    console.error('[jaani-stream] error:', err.message);
    sendEvent('error', { message: err.message });
  } finally {
    clearInterval(pingInterval);
    res.end();
  }
});

module.exports = router;

