/**
 * JANI - Gov.bd Directory Discovery Crawler
 * ========================================
 * Discovers likely officer list / contact directory pages across gov.bd/portal.gov.bd.
 *
 * Why: You asked for “scrape all gov.bd officer list/contact details”.
 * We cannot use Google directly here, so we do a respectful crawl from known seeds
 * and collect candidate directory URLs for later scraping.
 *
 * Output:
 * - backend/data/govbd_directory_urls.json
 *
 * Usage:
 *   node scripts/discover_govbd_directories.js
 *   node scripts/discover_govbd_directories.js --maxPages 400 --delayMs 1200
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const RobotsParser = require('robots-parser');

const argv = process.argv.slice(2);
const getArg = (name, fallback) => {
  const idx = argv.indexOf(name);
  if (idx === -1) return fallback;
  const val = argv[idx + 1];
  return val ?? fallback;
};

const MAX_PAGES = Number(getArg('--maxPages', '250'));
const DELAY_MS = Number(getArg('--delayMs', '1500'));

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_FILE = path.join(DATA_DIR, 'govbd_directory_urls.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isGovDomain = (hostname) => {
  const h = (hostname || '').toLowerCase();
  return h.endsWith('.gov.bd') || h.endsWith('.portal.gov.bd') || h === 'bangladesh.gov.bd' || h.endsWith('.bangladesh.gov.bd');
};

// URLs that look like officer list / directory / contact pages
const isDirectoryCandidate = (urlStr) => {
  const u = urlStr.toLowerCase();
  return (
    u.includes('/site/view/officer_list') ||
    u.includes('officer_list') ||
    u.includes('officer-list') ||
    u.includes('office_directory') ||
    u.includes('directory') ||
    u.includes('contact') ||
    u.includes('phonebook') ||
    u.includes('staff') ||
    u.includes('personnel')
  );
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

async function fetchRobots(hostname) {
  const robotsUrl = `https://${hostname}/robots.txt`;
  try {
    const res = await axios.get(robotsUrl, { timeout: 15000, validateStatus: () => true });
    const body = typeof res.data === 'string' ? res.data : '';
    return RobotsParser(robotsUrl, body);
  } catch {
    // If robots fetch fails, be conservative but don’t hard-block.
    return RobotsParser(robotsUrl, 'User-agent: *\nDisallow:');
  }
}

async function main() {
  await fsp.mkdir(DATA_DIR, { recursive: true });

  // Seed list: you can add more here safely.
  const seeds = [
    'http://www.bangladesh.gov.bd/site/view/officer_list',
    'https://bangladesh.gov.bd/site/view/officer_list',
    'https://cabinet.portal.gov.bd/',
    'https://mopa.gov.bd/',
    'https://mof.gov.bd/',
    'https://moha.gov.bd/',
    'https://mofa.gov.bd/',
    'https://minlaw.gov.bd/',
    'https://moedu.gov.bd/',
    'https://mohfw.gov.bd/',
    'https://moa.gov.bd/'
  ];

  const queue = [];
  const seen = new Set();
  const candidates = new Set();
  const perHostRobots = new Map();

  const enqueue = (urlStr) => {
    const n = normalizeUrl(urlStr);
    if (!n) return;
    if (seen.has(n)) return;
    seen.add(n);
    queue.push(n);
  };

  seeds.forEach(enqueue);

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

    // robots.txt check
    if (!perHostRobots.has(urlObj.hostname)) {
      perHostRobots.set(urlObj.hostname, await fetchRobots(urlObj.hostname));
    }
    const robots = perHostRobots.get(urlObj.hostname);
    const allowed = robots?.isAllowed(current, 'JANI/1.0');
    if (allowed === false) continue;

    try {
      const res = await axios.get(current, {
        timeout: 20000,
        headers: {
          'User-Agent': 'JANI/1.0 (civic-tech; directory discovery; contact: admin@local)',
          'Accept': 'text/html,application/xhtml+xml'
        },
        validateStatus: () => true
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

      pagesFetched++;

      if (isDirectoryCandidate(current)) {
        candidates.add(current);
      }

      const $ = cheerio.load(html);
      $('a[href]').each((_, a) => {
        const href = $(a).attr('href');
        if (!href) return;
        try {
          const abs = new URL(href, current).toString();
          const absObj = new URL(abs);
          if (!isGovDomain(absObj.hostname)) return;

          // Keep crawl shallow-ish by only following “interesting” URLs.
          const isInteresting = isDirectoryCandidate(abs) || /\/site\/(view|page)\//i.test(abs) || /\/site\/page\//i.test(abs);
          if (isInteresting) enqueue(abs);

          if (isDirectoryCandidate(abs)) candidates.add(normalizeUrl(abs));
        } catch {
          return;
        }
      });

    } catch {
      // ignore
    }

    await sleep(DELAY_MS);
  }

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      maxPages: MAX_PAGES,
      delayMs: DELAY_MS,
      pagesFetched,
      seenUrls: seen.size,
      candidateCount: candidates.size
    },
    candidates: Array.from(candidates).filter(Boolean).sort()
  };

  await fsp.writeFile(OUT_FILE, JSON.stringify(out, null, 2), 'utf8');
  console.log(`✅ Wrote ${out.candidates.length} candidate directory URLs to: ${OUT_FILE}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('❌ Discovery failed:', e);
    process.exit(1);
  });
}
