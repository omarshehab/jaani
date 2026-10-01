/**
 * RTI 2009 Officer Collector (gov.bd style)
 * =======================================
 * Discovers and scrapes "information officers" pages across Bangladesh govt sites,
 * starting from your existing RTI OFFICERS.csv Website_Link values as seeds.
 *
 * What it collects (when present on page):
 * - Designated (Primary) officer: নাম/পদবি/ফোন/মোবাইল/ইমেইল/ঠিকানা + photo
 * - Alternate officer: নাম/পদবি/ফোন/মোবাইল/ইমেইল/ঠিকানা + photo
 * - Appellate authority: নাম/পদবি/ফোন/মোবাইল/ইমেইল/ঠিকানা
 *
 * Output:
 * - backend/data/rti_officers_enriched.csv (default)
 *
 * Usage:
 *   node scripts/collect_rti_officers_govbd.js
 *   node scripts/collect_rti_officers_govbd.js --maxPages 300 --delayMs 1200
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const https = require('https');
const axios = require('axios');
const cheerio = require('cheerio');
const RobotsParser = require('robots-parser');
const { parse } = require('csv-parse/sync');

const argv = process.argv.slice(2);
const getArg = (name, fallback) => {
  const idx = argv.indexOf(name);
  if (idx === -1) return fallback;
  const val = argv[idx + 1];
  return val ?? fallback;
};

const MAX_PAGES = Number(getArg('--maxPages', '220'));
const DELAY_MS = Number(getArg('--delayMs', '1200'));
const OUT_CSV = getArg('--outCsv', path.join(__dirname, '..', 'data', 'rti_officers_enriched.csv'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isGovDomain = (hostname) => {
  const h = (hostname || '').toLowerCase();
  return h.endsWith('.gov.bd') || h.endsWith('.portal.gov.bd') || h === 'bangladesh.gov.bd' || h.endsWith('.bangladesh.gov.bd');
};

const normalizeUrl = (urlStr) => {
  try {
    const u = new URL(urlStr);
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
};

const isInfoOfficersUrl = (urlStr) => {
  const u = (urlStr || '').toLowerCase();
  return (
    u.includes('/views/info-officers/') ||
    u.includes('/site/view/information_officers/') ||
    u.includes('information_officers')
  );
};

const INSECURE_TLS_AGENT = new https.Agent({ rejectUnauthorized: false });

async function axiosGetWithGovTlsFallback(url, config) {
  try {
    return await axios.get(url, config);
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
    if (!shouldRetry || !isGovDomain(host)) throw err;

    // Some gov sites have incomplete TLS chains; retry with insecure agent.
    return await axios.get(url, { ...config, httpsAgent: INSECURE_TLS_AGENT });
  }
}

async function fetchRobots(hostname) {
  const robotsUrl = `https://${hostname}/robots.txt`;
  try {
    const res = await axios.get(robotsUrl, { timeout: 15000, validateStatus: () => true });
    const body = typeof res.data === 'string' ? res.data : '';
    return RobotsParser(robotsUrl, body);
  } catch {
    // conservative default: allow
    return RobotsParser(robotsUrl, 'User-agent: *\nDisallow:');
  }
}

function normalizeBanglaLabel(label = '') {
  return (label || '')
    .toString()
    .replace(/\s+/g, ' ')
    .replace(/[：:]+/g, ':')
    .trim()
    .replace(/\s*:\s*$/g, '')
    .trim();
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

function resolveUrl(baseUrl, href) {
  if (!href) return '';
  const h = href.toString().trim();
  if (!h) return '';
  try {
    return h.startsWith('http') ? h : new URL(h, baseUrl).href;
  } catch {
    return '';
  }
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

function findHeadingEl($, needleBn) {
  const n = (needleBn || '').toString().trim();
  if (!n) return null;
  const normNeedle = n.replace(/\s+/g, '');
  const candidates = $('h1,h2,h3,h4,div,span,strong').toArray();
  for (const el of candidates) {
    const t = normalizeBanglaValue($(el).text()).replace(/\s+/g, '');
    if (t && t.includes(normNeedle)) return el;
  }
  return null;
}

function findNextTable($, headingEl) {
  if (!headingEl) return null;
  const $h = $(headingEl);
  const tbl = $h.nextAll('table').first();
  if (tbl && tbl.length) return tbl.get(0);
  // Some portal pages wrap tables inside divs after the heading.
  const nested = $h.nextAll().find('table').first();
  if (nested && nested.length) return nested.get(0);
  return null;
}

function findNearestImage($, headingEl, baseUrl) {
  if (!headingEl) return '';
  const $h = $(headingEl);
  const parent = $h.parent();
  const candidates = parent.find('img');
  for (const img of candidates.toArray()) {
    const src = $(img).attr('src') || $(img).attr('data-src') || '';
    const resolved = resolveUrl(baseUrl, src);
    if (resolved) return resolved;
  }
  let prev = $h.prev();
  for (let i = 0; i < 8 && prev && prev.length; i += 1) {
    const imgs = prev.find('img');
    for (const img of imgs.toArray()) {
      const src = $(img).attr('src') || $(img).attr('data-src') || '';
      const resolved = resolveUrl(baseUrl, src);
      if (resolved) return resolved;
    }
    prev = prev.prev();
  }
  return '';
}

async function scrapeInfoOfficersPage(url) {
  const res = await axiosGetWithGovTlsFallback(url, {
    headers: {
      'User-Agent': 'JANI/1.0 (RTI officer collector; contact: local)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'bn-BD,bn;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: () => true,
  });

  if (res.status < 200 || res.status >= 400) return null;
  const html = typeof res.data === 'string' ? res.data : '';
  if (!html || html.length < 200) return null;

  const $ = cheerio.load(html);

  const title = normalizeBanglaValue($('h1').first().text()) || normalizeBanglaValue($('title').text());

  const primaryHeading = findHeadingEl($, 'দায়িত্বপ্রাপ্ত কর্মকর্তা');
  const alternateHeading = findHeadingEl($, 'বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা');
  const appellateHeading = findHeadingEl($, 'আপীল কর্তৃপক্ষ');

  const primaryTable = findNextTable($, primaryHeading);
  const alternateTable = findNextTable($, alternateHeading);
  const appellateTable = findNextTable($, appellateHeading);

  const primary = primaryTable ? extractKeyValueTable($, primaryTable) : {};
  const alternate = alternateTable ? extractKeyValueTable($, alternateTable) : {};
  const appellate = appellateTable ? extractKeyValueTable($, appellateTable) : {};

  // cleanup email spaces
  for (const obj of [primary, alternate, appellate]) {
    for (const k of Object.keys(obj)) {
      if (k.replace(/\s+/g, '').includes('ইমেইল')) {
        obj[k] = compactEmailValue(obj[k]);
      }
    }
  }

  const primaryPhoto = findNearestImage($, primaryHeading, url);
  const alternatePhoto = findNearestImage($, alternateHeading, url);

  const discoveredLinks = new Set();
  $('a[href]').each((_, a) => {
    const href = ($(a).attr('href') || '').trim();
    if (!href) return;
    if (isInfoOfficersUrl(href)) {
      const abs = resolveUrl(url, href);
      if (abs) discoveredLinks.add(normalizeUrl(abs));
    }
  });

  return {
    url,
    title,
    primary,
    alternate,
    appellate,
    primaryPhoto,
    alternatePhoto,
    discoveredLinks: Array.from(discoveredLinks).filter(Boolean).slice(0, 50),
  };
}

function readRtiCsvSeeds() {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'RTI OFFICERS.csv'),
    path.resolve(__dirname, '..', '..', 'RTI officers - Sheet3.csv'),
  ];
  const csvPath = candidates.find((p) => fs.existsSync(p));
  if (!csvPath) return { csvPath: null, rows: [] };
  const csv = fs.readFileSync(csvPath, 'utf8');
  const rows = parse(csv, { columns: true, skip_empty_lines: true, relax_column_count: true, trim: true });
  return { csvPath, rows };
}

function csvEscape(v) {
  const s = (v ?? '').toString();
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function main() {
  await fsp.mkdir(path.dirname(OUT_CSV), { recursive: true });

  const { rows } = readRtiCsvSeeds();

  const seeds = new Set();
  const domainMeta = new Map(); // hostname -> { Ministry, Department }

  for (const r of rows) {
    const url = r.Website_Link || r.website_link || r['Website Link'] || r['Website_Link'];
    if (!url) continue;
    const n = normalizeUrl(url);
    if (!n) continue;
    seeds.add(n);
    try {
      const u = new URL(n);
      if (!isGovDomain(u.hostname)) continue;
      if (!domainMeta.has(u.hostname)) {
        domainMeta.set(u.hostname, {
          Ministry: r.Ministry || r.ministry || '',
          Department: r.Department || r.department || '',
        });
      }
    } catch {
      // ignore
    }
  }

  // Add a few safe default seeds (optional)
  [
    'https://bangladesh.gov.bd/',
    'https://lgd.gov.bd/',
    'https://cabinet.gov.bd/',
  ].forEach((u) => seeds.add(normalizeUrl(u)));

  const queue = [];
  const seen = new Set();
  const perHostRobots = new Map();

  const enqueue = (u) => {
    const n = normalizeUrl(u);
    if (!n) return;
    if (seen.has(n)) return;
    seen.add(n);
    queue.push(n);
  };

  Array.from(seeds).forEach(enqueue);

  const scrapedByUrl = new Map();

  let pagesFetched = 0;

  while (queue.length > 0 && pagesFetched < MAX_PAGES) {
    const current = queue.shift();

    let urlObj;
    try {
      urlObj = new URL(current);
    } catch {
      continue;
    }

    if (!isGovDomain(urlObj.hostname)) continue;

    if (!perHostRobots.has(urlObj.hostname)) {
      perHostRobots.set(urlObj.hostname, await fetchRobots(urlObj.hostname));
    }
    const robots = perHostRobots.get(urlObj.hostname);
    const allowed = robots?.isAllowed(current, 'JANI/1.0');
    if (allowed === false) continue;

    // If this looks like an info-officers page, scrape it.
    if (isInfoOfficersUrl(current) && !scrapedByUrl.has(current)) {
      const scraped = await scrapeInfoOfficersPage(current);
      pagesFetched += 1;

      if (scraped) {
        scrapedByUrl.set(current, scraped);
        // enqueue discovered
        (scraped.discoveredLinks || []).forEach(enqueue);
      }

      await sleep(DELAY_MS);
      continue;
    }

    // Otherwise, fetch and discover more info-officers links.
    try {
      const res = await axiosGetWithGovTlsFallback(current, {
        timeout: 20000,
        headers: {
          'User-Agent': 'JANI/1.0 (RTI officer collector; discovery)',
          'Accept': 'text/html,application/xhtml+xml'
        },
        validateStatus: () => true,
      });

      if (res.status < 200 || res.status >= 400) {
        await sleep(DELAY_MS);
        continue;
      }

      const html = typeof res.data === 'string' ? res.data : '';
      if (!html || html.length < 200) {
        await sleep(DELAY_MS);
        continue;
      }

      pagesFetched += 1;

      const $ = cheerio.load(html);
      $('a[href]').each((_, a) => {
        const href = $(a).attr('href');
        if (!href) return;
        const abs = resolveUrl(current, href);
        if (!abs) return;
        try {
          const absObj = new URL(abs);
          if (!isGovDomain(absObj.hostname)) return;
          if (isInfoOfficersUrl(abs)) enqueue(abs);
          // keep crawl constrained: only follow likely portal pages
          const interesting = isInfoOfficersUrl(abs) || /\/site\/(view|page)\//i.test(abs) || /\/views\//i.test(abs);
          if (interesting) enqueue(abs);
        } catch {
          return;
        }
      });

    } catch {
      // ignore
    }

    await sleep(DELAY_MS);
  }

  // Build output rows
  const outRows = [];
  for (const scraped of scrapedByUrl.values()) {
    const host = (() => {
      try { return new URL(scraped.url).hostname; } catch { return ''; }
    })();
    const meta = domainMeta.get(host) || { Ministry: '', Department: '' };

    const p = scraped.primary || {};
    const a = scraped.alternate || {};
    const ap = scraped.appellate || {};

    const row = {
      Ministry: meta.Ministry,
      Department: meta.Department,
      Primary_Officer: (p['নাম'] || '').trim(),
      Primary_Designation: (p['পদবি'] || '').trim(),
      Primary_Phone: (p['ফোন'] || '').trim(),
      Primary_Mobile: (p['মোবাইল'] || '').trim(),
      Primary_Email: compactEmailValue(p['ইমেইল'] || ''),
      Primary_Address: (p['ঠিকানা'] || '').trim(),

      Alternate_Officer: (a['নাম'] || '').trim(),
      Alternate_Designation: (a['পদবি'] || '').trim(),
      Alternate_Phone: (a['ফোন'] || '').trim(),
      Alternate_Mobile: (a['মোবাইল'] || '').trim(),
      Alternate_Email: compactEmailValue(a['ইমেইল'] || ''),
      Alternate_Address: (a['ঠিকানা'] || '').trim(),

      Appellate_Name: (ap['নাম'] || '').trim(),
      Appellate_Designation: (ap['পদবি'] || '').trim(),
      Appellate_Phone: (ap['ফোন'] || '').trim(),
      Appellate_Mobile: (ap['মোবাইল'] || '').trim(),
      Appellate_Email: compactEmailValue(ap['ইমেইল'] || ''),
      Appellate_Address: (ap['ঠিকানা'] || '').trim(),

      Website_Link: scraped.url,
      Primary_Photo: scraped.primaryPhoto || '',
      Alternate_Photo: scraped.alternatePhoto || '',
      Source_Title: scraped.title || '',
      Source_Domain: host,
      Discovered_Count: Array.isArray(scraped.discoveredLinks) ? scraped.discoveredLinks.length : 0,
      Scraped_At: new Date().toISOString(),
    };

    // Keep only useful rows (must have at least a primary officer or email)
    if (row.Primary_Officer || row.Primary_Email || row.Primary_Mobile) {
      outRows.push(row);
    }
  }

  const headers = [
    'Ministry','Department',
    'Primary_Officer','Primary_Designation','Primary_Phone','Primary_Mobile','Primary_Email','Primary_Address',
    'Alternate_Officer','Alternate_Designation','Alternate_Phone','Alternate_Mobile','Alternate_Email','Alternate_Address',
    'Appellate_Name','Appellate_Designation','Appellate_Phone','Appellate_Mobile','Appellate_Email','Appellate_Address',
    'Website_Link','Primary_Photo','Alternate_Photo','Source_Title','Source_Domain','Discovered_Count','Scraped_At'
  ];

  const csvLines = [headers.join(',')];
  for (const r of outRows) {
    csvLines.push(headers.map((h) => csvEscape(r[h] || '')).join(','));
  }

  await fsp.writeFile(OUT_CSV, `${csvLines.join('\n')}\n`, 'utf8');

  console.log(`✅ Scraped pages: ${scrapedByUrl.size}`);
  console.log(`✅ Output rows: ${outRows.length}`);
  console.log(`✅ Wrote: ${OUT_CSV}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('❌ Collector failed:', e);
    process.exit(1);
  });
}
