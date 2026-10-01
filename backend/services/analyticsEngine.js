/**
 * Analytics Engine
 * Deterministic (non-LLM) analytics for JAANI news analysis.
 * Provides: money extraction, timeline parsing, RTI score, corruption risk,
 * source credibility registry, and disk-persisted pattern library.
 */

'use strict';

const path = require('path');
const fs = require('fs').promises;

// ── Paths ──────────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');
const PATTERNS_FILE = path.join(DATA_DIR, 'patterns.json');

// ── NFC normalise Bengali text ─────────────────────────────────────────────────
function nfc(s) { return (s || '').normalize('NFC'); }

// ── Bengali digit → ASCII digit ───────────────────────────────────────────────
function bnToAsciiNum(s) {
  return (s || '').replace(/[০-৯]/g, d => String.fromCharCode(d.charCodeAt(0) - 0x09E6 + 0x30));
}

// ══════════════════════════════════════════════════════════════════════════════
//  1.  MONEY EXTRACTION
// ══════════════════════════════════════════════════════════════════════════════

const UNIT_MULTIPLIER = {
  'কোটি': 10_000_000,  'crore': 10_000_000,
  'লাখ':  100_000,     'লক্ষ': 100_000,     'lakh':  100_000,
  'হাজার': 1_000,      'thousand': 1_000,
  'মিলিয়ন': 1_000_000, 'million': 1_000_000,
  'বিলিয়ন': 1_000_000_000, 'billion': 1_000_000_000,
};

// All patterns capture: (numericPart)(unit)(optional currency)
const MONEY_PATTERNS = [
  // Bengali: ৳৫০ কোটি টাকা  /  ৫০ কোটি টাকা  / ৫০ লাখ ডলার
  /([৳\u09F3]?\s*)([\d,৳০-৯]+(?:[.,]\d+)?)\s*(কোটি|লাখ|লক্ষ|হাজার|মিলিয়ন|বিলিয়ন)\s*(টাকা|ডলার|ইউরো|পাউন্ড|রুপি)?/gi,
  // English: 50 crore taka / 50 million dollars
  /([\d,]+(?:\.\d+)?)\s*(crore|lakh|million|billion|thousand)\s*(taka|BDT|dollar|USD|EUR|GBP)?/gi,
  // Symbol-prefixed: ৳50,000  /  Tk.5000  /  BDT 5,000
  /(?:[৳\u09F3]|BDT|Tk\.?)\s*([\d,]+(?:\.\d+)?)/gi,
];

function extractMoneyMentions(text) {
  if (!text) return [];
  const t = nfc(text);
  const results = [];
  const seen = new Set();

  for (const pat of MONEY_PATTERNS) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(t)) !== null) {
      const raw = m[0].trim();
      const key = raw.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      // 50-char context window
      const ctx = t.slice(Math.max(0, m.index - 45), m.index + raw.length + 45)
                   .replace(/\s+/g, ' ').trim();

      // Numeric value
      const numStr = bnToAsciiNum((m[2] || m[1] || '').replace(/[,৳\u09F3\s]/g, ''));
      const unit   = (m[3] || m[2] || '').toLowerCase();
      const mult   = UNIT_MULTIPLIER[unit] || 1;
      const numeric_value = Math.round((parseFloat(numStr) || 0) * mult);

      const currency = /ডলার|dollar|USD/i.test(raw) ? 'USD'
                     : /ইউরো|EUR/i.test(raw)          ? 'EUR'
                     : /পাউন্ড|GBP/i.test(raw)         ? 'GBP'
                     : 'BDT';

      results.push({ label: ctx, amount: raw, numeric_value, currency });
      if (results.length >= 20) break;
    }
    if (results.length >= 20) break;
  }

  return results;
}

// ══════════════════════════════════════════════════════════════════════════════
//  2.  TIMELINE EXTRACTION
// ══════════════════════════════════════════════════════════════════════════════

const BN_MONTHS = 'জানুয়ারি|ফেব্রুয়ারি|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর';
const EN_MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';

const DATE_PATTERNS = [
  new RegExp(`([১-৩]?[০-৯])\\s*(${BN_MONTHS})[,\\s]*([১-২][০-৯]{3})`, 'g'),
  new RegExp(`(\\d{1,2})\\s*(${EN_MONTHS})[,\\s]*(\\d{4})`, 'gi'),
  new RegExp(`(${EN_MONTHS})\\s+\\d{1,2},?\\s+\\d{4}`, 'gi'),
  /\b(\d{4}-\d{2}-\d{2})\b/g,
  /(?:গতকাল|আজ|আগামীকাল|গত\s+(?:সোম|মঙ্গল|বুধ|বৃহস্পতি|শুক্র|শনি|রবি)বার|গত\s+সপ্তাহ|গত\s+মাস)/g,
];

function extractTimeline(text) {
  if (!text) return [];
  const t = nfc(text);
  const results = [];
  const seen = new Set();

  for (const pat of DATE_PATTERNS) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(t)) !== null) {
      const dateStr = m[0].trim();
      const lk = dateStr.toLowerCase();
      if (seen.has(lk)) continue;
      seen.add(lk);

      const end   = Math.min(t.length, m.index + dateStr.length + 100);
      const event = t.slice(Math.max(0, m.index - 10), end).replace(/\s+/g, ' ').trim().slice(0, 160);
      results.push({ date: dateStr, event });
      if (results.length >= 10) break;
    }
    if (results.length >= 10) break;
  }

  return results;
}

// ══════════════════════════════════════════════════════════════════════════════
//  3.  RTI SCORE
// ══════════════════════════════════════════════════════════════════════════════

/**
 * computeRtiScore – 0-100 score estimating RTI relevance.
 * @param {Object} opts
 * @param {Array}  opts.entities          – normalised entity array
 * @param {Array}  opts.moneyMentions     – output of extractMoneyMentions
 * @param {Array}  opts.legalImplications – array of strings
 * @param {number} opts.civicRelevance    – 0-1 float (default 0.5)
 */
function computeRtiScore({ entities = [], moneyMentions = [], legalImplications = [], civicRelevance = 0.5 } = {}) {
  let score = civicRelevance * 30;

  const orgs    = entities.filter(e => /^(ORG|ORGANIZATION|MINISTRY|DEPARTMENT|GOV)$/i.test(e.label || e.type || ''));
  const persons = entities.filter(e => /^(PER|PERSON)$/i.test(e.label || e.type || ''));

  score += orgs.length > 0   ? 15 : 0;
  score += Math.min(moneyMentions.length * 5, 25);
  score += legalImplications.length > 0 ? 20 : 0;
  score += persons.length > 0 ? 10 : 0;

  return Math.min(Math.round(score), 100);
}

// ══════════════════════════════════════════════════════════════════════════════
//  4.  ACCOUNTABILITY CHAIN  (org → ministerial hierarchy)
// ══════════════════════════════════════════════════════════════════════════════

// Simple hard-coded lookup for common BD ministries
const ORG_HIERARCHY = {
  'পুলিশ': ['স্বরাষ্ট্র মন্ত্রণালয়', 'বাংলাদেশ পুলিশ'],
  'র‌্যাব': ['স্বরাষ্ট্র মন্ত্রণালয়', 'র‌্যাপিড অ্যাকশন ব্যাটালিয়ন'],
  'বিআরটিএ': ['সড়ক পরিবহন ও মহাসড়ক বিভাগ', 'বাংলাদেশ সড়ক পরিবহন কর্তৃপক্ষ'],
  'দুদক': ['দুর্নীতি দমন কমিশন'],
  'শিক্ষা': ['শিক্ষা মন্ত্রণালয়'],
  'স্বাস্থ্য': ['স্বাস্থ্য ও পরিবার কল্যাণ মন্ত্রণালয়'],
};

function buildAccountabilityChain(orgs = []) {
  const chain = [];
  for (const org of orgs.slice(0, 5)) {
    const name = (org.text || org.name || '').toString();
    let parent = null;
    for (const [keyword, hierarchy] of Object.entries(ORG_HIERARCHY)) {
      if (name.includes(keyword)) {
        parent = hierarchy;
        break;
      }
    }
    chain.push({ name, parent_chain: parent || [] });
  }
  return chain;
}

// ══════════════════════════════════════════════════════════════════════════════
//  5.  CORRUPTION RISK ENGINE
// ══════════════════════════════════════════════════════════════════════════════

function corruptionRiskEngine(text, moneyMentions = [], timeline = []) {
  if (!text) return { risk_level: 'low', flags: [], risk_score: 0, recommended_action: null };

  const t = nfc(text);
  const flags = [];
  let riskScore = 0;

  const totalMoney = moneyMentions.reduce((s, m) => s + (m.numeric_value || 0), 0);

  // Rule 1: Large untendered amount
  if (totalMoney >= 100_000_000 && !/দরপত্র|প্রতিযোগিতা|টেন্ডার|tender|bidding|procurement/i.test(t)) {
    flags.push({ rule: '১০০ কোটি+ টাকার বরাদ্দ, দরপত্রের উল্লেখ নেই', evidence: moneyMentions[0]?.amount || '', severity: 2 });
    riskScore += 25;
  }

  // Rule 2: Direct procurement keyword
  if (/সরাসরি\s*ক্রয়|direct\s*procurement|single[\s-]source/i.test(t)) {
    flags.push({ rule: 'সরাসরি ক্রয় / একক উৎস ক্রয়', evidence: '', severity: 3 });
    riskScore += 30;
  }

  // Rule 3: Foreign grant without parliamentary mention
  if (/বৈদেশিক\s*অনুদান|foreign\s*grant|foreign\s*aid/i.test(t) && !/সংসদ|parliament/i.test(t)) {
    flags.push({ rule: 'বৈদেশিক অনুদান, সংসদীয় অনুমোদনের উল্লেখ নেই', evidence: '', severity: 2 });
    riskScore += 20;
  }

  // Rule 4: Abnormally fast infrastructure
  const monthMatch = t.match(/(\d+)\s*(?:মাস|month)/i);
  if (monthMatch && parseInt(monthMatch[1]) < 12 && /নির্মাণ|construction|infrastructure/i.test(t)) {
    flags.push({ rule: 'অবকাঠামো প্রকল্পে অস্বাভাবিক স্বল্পমেয়াদ', evidence: monthMatch[0], severity: 2 });
    riskScore += 15;
  }

  // Rule 5: Explicit corruption keywords
  if (/দুর্নীতি|অনিয়ম|corruption|irregularity|embezzlement|misappropriation/i.test(t)) {
    flags.push({ rule: 'দুর্নীতি বা অনিয়মের প্রত্যক্ষ উল্লেখ', evidence: '', severity: 3 });
    riskScore += 20;
  }

  // Rule 6: No-bid contract
  if (/বিনা\s*দরপত্র|without\s*tender|no[\s-]bid/i.test(t)) {
    flags.push({ rule: 'দরপত্র ছাড়া চুক্তি', evidence: '', severity: 3 });
    riskScore += 25;
  }

  riskScore = Math.min(riskScore, 100);

  const risk_level = riskScore >= 60 ? 'critical'
                   : riskScore >= 35 ? 'high'
                   : riskScore >= 15 ? 'medium'
                   : 'low';

  const recommended_action =
    risk_level === 'critical' ? 'অবিলম্বে RTI আবেদন দাখিল করুন এবং দুদকে অভিযোগ বিবেচনা করুন।'
  : risk_level === 'high'     ? 'RTI আবেদনের মাধ্যমে সংশ্লিষ্ট নথিপত্র চাওয়ার পরামর্শ দেওয়া হচ্ছে।'
  : risk_level === 'medium'   ? 'তদন্তমূলক RTI প্রশ্ন পাঠানো যেতে পারে।'
  : null;

  return { risk_level, flags, risk_score: riskScore, recommended_action };
}

// ══════════════════════════════════════════════════════════════════════════════
//  6.  SOURCE CREDIBILITY REGISTRY
// ══════════════════════════════════════════════════════════════════════════════

const SOURCE_REGISTRY = {
  'prothomalo.com':     { score: 82, bias: 'center-left',  name: 'প্রথম আলো' },
  'thedailystar.net':   { score: 85, bias: 'center',       name: 'The Daily Star' },
  'bdnews24.com':       { score: 76, bias: 'center',       name: 'bdnews24' },
  'dhakatribune.com':   { score: 78, bias: 'center',       name: 'Dhaka Tribune' },
  'samakal.com':        { score: 72, bias: 'center-right', name: 'সমকাল' },
  'kalerkantho.com':    { score: 70, bias: 'center-right', name: 'কালের কণ্ঠ' },
  'ittefaq.com.bd':     { score: 74, bias: 'center',       name: 'ইত্তেফাক' },
  'jugantor.com':       { score: 71, bias: 'center-right', name: 'যুগান্তর' },
  'manabzamin.net':     { score: 68, bias: 'center',       name: 'মানবজমিন' },
  'mzamin.com':         { score: 68, bias: 'center',       name: 'মানবজমিন' },
  'somoynews.tv':       { score: 65, bias: 'center',       name: 'সময় নিউজ' },
  'banglatribune.com':  { score: 72, bias: 'center',       name: 'বাংলা ট্রিবিউন' },
  'risingbd.com':       { score: 66, bias: 'center',       name: 'রাইজিং বিডি' },
  'bbc.com':            { score: 90, bias: 'center',       name: 'BBC' },
  'bbc.co.uk':          { score: 90, bias: 'center',       name: 'BBC' },
  'reuters.com':        { score: 92, bias: 'center',       name: 'Reuters' },
  'aljazeera.com':      { score: 82, bias: 'center-left',  name: 'Al Jazeera' },
  'tbsnews.net':        { score: 74, bias: 'center',       name: 'TBS News' },
  'newagebd.net':       { score: 76, bias: 'center-left',  name: 'New Age' },
  'daily-bangladesh.com': { score: 60, bias: 'unknown',   name: 'Daily Bangladesh' },
};

function getSourceCredibility(url, articleText = '') {
  let hostname = '';
  try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch {}

  const registry = SOURCE_REGISTRY[hostname] || { score: 60, bias: 'unknown', name: hostname || 'Unknown' };

  const hasQuotes        = (articleText.match(/[""''""]/g) || []).length > 2;
  const namedSources     = (articleText.match(/(?:বলেন|জানান|বলেছেন|said|stated|told)/g) || []).length;
  const hasOfficialDocs  = /আইন|অধ্যাদেশ|গেজেট|official|act \d{4}|law no\./i.test(articleText);
  const hasOpposingView  = /বিরোধী|অন্যদিকে|however|opposition/i.test(articleText);

  const bonus = (hasQuotes ? 5 : 0) + (hasOfficialDocs ? 5 : 0) + (hasOpposingView ? 3 : 0) + Math.min(namedSources * 2, 10);

  return {
    source_name:          registry.name || hostname,
    source_base_score:    registry.score,
    source_bias_label:    registry.bias,
    article_quality_bonus: bonus,
    composite_credibility: Math.min(registry.score + bonus, 100),
    quality_factors: {
      has_quotes: hasQuotes,
      named_sources_count: namedSources,
      has_official_doc_reference: hasOfficialDocs,
      has_opposing_viewpoint: hasOpposingView,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  7.  PATTERN LIBRARY  (disk-persisted, Jaccard similarity)
// ══════════════════════════════════════════════════════════════════════════════

let _patternsCache = null;

async function _ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadPatterns() {
  if (_patternsCache) return _patternsCache;
  try {
    await _ensureDataDir();
    const raw = await fs.readFile(PATTERNS_FILE, 'utf8');
    _patternsCache = JSON.parse(raw);
  } catch {
    _patternsCache = [];
  }
  return _patternsCache;
}

async function appendPattern(entry) {
  const patterns = await loadPatterns();
  patterns.push({ ...entry, saved_at: new Date().toISOString() });
  if (patterns.length > 500) patterns.splice(0, patterns.length - 500);
  _patternsCache = patterns;
  try {
    await _ensureDataDir();
    await fs.writeFile(PATTERNS_FILE, JSON.stringify(patterns, null, 2), 'utf8');
  } catch (e) {
    console.warn('[analyticsEngine] pattern write failed:', e.message);
  }
}

function _kwJaccard(kws1 = [], kws2 = []) {
  const s1 = new Set((kws1).map(k => k.toLowerCase()));
  const s2 = new Set((kws2).map(k => k.toLowerCase()));
  const inter = [...s1].filter(x => s2.has(x)).length;
  const union = new Set([...s1, ...s2]).size;
  return union === 0 ? 0 : inter / union;
}

async function findSimilarPatterns(keywords = [], url = '', limit = 3) {
  const patterns = await loadPatterns();
  return patterns
    .filter(p => p.url !== url)
    .map(p => ({ ...p, similarity: _kwJaccard(keywords, p.keywords || []) }))
    .filter(p => p.similarity > 0.2)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

// ══════════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ══════════════════════════════════════════════════════════════════════════════

module.exports = {
  extractMoneyMentions,
  extractTimeline,
  computeRtiScore,
  buildAccountabilityChain,
  corruptionRiskEngine,
  getSourceCredibility,
  loadPatterns,
  appendPattern,
  findSimilarPatterns,
  SOURCE_REGISTRY,
};
