/**
 * Text integrity gate for officer data (Section 3, rule R11): classifies a value before it may be written to the
 * officer CSV. Node twin of scraper/jaani_scraper/integrity.py; both are tested against
 * shared/text_integrity_vectors.json so they cannot drift. No Bijoy converter here: the app only needs to refuse
 * legacy-font or broken text, never to recover it.
 *
 * classifyText(s, fontHint) -> EMPTY | ENGLISH_OK | UNICODE_OK | BIJOY_ANSI | VISUAL_ORDER_BROKEN | MIXED | UNKNOWN
 */
const STORABLE = new Set(['ENGLISH_OK', 'UNICODE_OK']);

// Same list as scraper/config/legacy_fonts.txt (a test compares them).
const LEGACY_FONT_PREFIXES = ['sutonny', 'bijoy', 'adarsha', 'sulekha', 'sunetra', 'shree', 'nikoshban', 'chandrabati', 'kongsho'];

const BENGALI_LETTER = /[অ-হৎড়-ৡৰৱ]/;
const BENGALI_BLOCK = /[ঀ-৿]/;
const HASANTA = '্';
const ZWNJ = '‌';
const ZWJ = '‍';
const SIGNS = new Set(['ঁ', 'ং', 'ঃ', '়']);
const DEP_VOWEL = new Set(['ৗ', 'ৢ', 'ৣ']);
for (let c = 0x09BE; c < 0x09CD; c += 1) DEP_VOWEL.add(String.fromCharCode(c));
const STRONG_SIGNATURE = new Set('†‡ˆ‰ŠšŒœŸƒ„…‹›˜™¯');
for (let c = 0x00A1; c < 0x0100; c += 1) STRONG_SIGNATURE.add(String.fromCharCode(c));

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const PHONE_RE = /^[+()\d\s./-]{5,}$/;
const VOWELLESS_OK = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'md', 'mst', 'ltd', 'phd', 'bcs', 'ndc', 'psc', 'hq', 'dc',
  'pwd', 'bd', 'rd', 'nd', 'th', 'sq', 'jr', 'sr', 'engr', 'cc', 'bcc', 'pbx', 'tnt', 'fax', 'tel', 'cell', 'mob', 'by',
  'my', 'dy', 'secy', 'gm', 'dgm', 'agm', 'dg', 'ddg', 'addl', 'jt', 'pps', 'ps', 'apps', 'aps', 'spl', 'vc', 'pvc',
  'rtd', 'mph', 'mbbs', 'llb', 'llm', 'bsc', 'msc', 'mss', 'mba', 'nbr', 'nsi', 'dmp', 'cmp', 'rmp', 'rab', 'bgb',
  'bpdb', 'lgd', 'lged', 'dncc', 'dscc', 'ctg', 'jpg', 'png', 'pdf', 'xls', 'xlsx', 'doc', 'docx', 'ppt', 'pptx',
  'txt', 'csv', 'svg', 'gif', 'bmp', 'html', 'php', 'www', 'http', 'https', 'pbx', 'kb', 'mb', 'gb', 'km', 'mm', 'cm',
  'kg', 'no', 'nos']);

function norm(s) {
  if (s === null || s === undefined) return '';
  return String(s).normalize('NFC').replace(/[​⁠﻿­]/g, '').replace(/ /g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function isLegacyFont(fontName) {
  if (!fontName) return null;
  return String(fontName).split(',').some((raw) => {
    let n = raw.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
    if (/^[a-z]{6}\+/.test(n)) n = n.slice(7);
    n = n.replace(/ /g, '');
    return LEGACY_FONT_PREFIXES.some((p) => n.startsWith(p));
  });
}

function englishToken(t) {
  if (EMAIL_RE.test(t) || URL_RE.test(t) || PHONE_RE.test(t)) return true;
  const core = t.replace(/^[^\w]+|[^\w]+$/g, '');
  return !core || /^\d+$/.test(core);
}

// 'strong' | 'weak' | '' (same rules as bijoy_evidence() in integrity.py; weak evidence alone never decides)
function bijoyEvidence(t) {
  if ([...t].some((c) => STRONG_SIGNATURE.has(c))) return 'strong';
  if (englishToken(t)) return '';
  const core = t.replace(/^[(["']+|[)\]"'.,;:!?]+$/g, '');
  const letters = core.replace(/[^A-Za-z]/g, '');
  if (!letters) return (core.includes('`') || core.endsWith('|')) ? 'strong' : '';
  if (/[a-z][A-Z]/.test(core) && !/^(Mc|Mac|De|Di|La|Le|O')[A-Z][a-z]+$/.test(core)) return 'strong';
  if (core.includes('`') || /\w\|/.test(core)) return 'strong';
  if (letters === letters.toUpperCase()) return '';
  if (letters.length >= 2 && !/[aeiouyAEIOUY]/.test(letters) && !VOWELLESS_OK.has(letters.toLowerCase())) return 'weak';
  return '';
}

function structureProblems(word) {
  const probs = [];
  if (word.includes('�')) probs.push('replacement_char');
  const chars = [...word].filter((c) => c !== ZWNJ && c !== ZWJ);
  if (!chars.length) return probs;
  if (DEP_VOWEL.has(chars[0]) || chars[0] === HASANTA || ['ঁ', 'ং', '়'].includes(chars[0])) {
    probs.push('leading_mark');
  }
  if (word.endsWith(`র${HASANTA}`)) probs.push('detached_reph');
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const a = chars[i];
    const b = chars[i + 1];
    if (DEP_VOWEL.has(a) && DEP_VOWEL.has(b)) probs.push('double_matra');
    if (a === HASANTA && (DEP_VOWEL.has(b) || b === HASANTA || SIGNS.has(b))) probs.push('hasanta_before_mark');
    if (DEP_VOWEL.has(a) && b === HASANTA) probs.push('matra_before_hasanta');
  }
  return probs;
}

function bnWords(s) {
  return s.split(/[^ঀ-৿‌‍]+/).filter((w) => BENGALI_BLOCK.test(w));
}

function classifyText(value, fontHint = null) {
  const s = norm(value);
  if (!s) return 'EMPTY';
  const hasBn = BENGALI_LETTER.test(s);
  const strong = [...s].filter((c) => STRONG_SIGNATURE.has(c)).length;
  const legacy = isLegacyFont(fontHint);
  if (legacy) return hasBn ? 'MIXED' : 'BIJOY_ANSI';
  if (legacy === false && !hasBn && !BENGALI_BLOCK.test(s) && !s.includes('\ufffd')) return 'ENGLISH_OK';
  if (s.includes('�')) return (hasBn || BENGALI_BLOCK.test(s)) ? 'VISUAL_ORDER_BROKEN' : 'UNKNOWN';
  if (hasBn) {
    if (strong) return 'MIXED';
    const words = bnWords(s);
    const bad = words.filter((w) => w !== 'ঃ' && structureProblems(w).length);
    return bad.length ? 'VISUAL_ORDER_BROKEN' : 'UNICODE_OK';
  }
  if (BENGALI_BLOCK.test(s)) {
    if (strong) return 'MIXED';
    return bnWords(s).some((w) => w !== 'ঃ' && structureProblems(w).length) ? 'VISUAL_ORDER_BROKEN' : 'UNICODE_OK';
  }
  const tokens = s.split(' ');
  const ev = tokens.map(bijoyEvidence);
  const strongTokens = ev.filter((e) => e === 'strong').length;
  const weakTokens = ev.filter((e) => e === 'weak').length;
  const score = (strongTokens + 0.5 * weakTokens) / tokens.length;
  if (strong >= 2 || (strongTokens && score >= 0.5)) {
    // One ASCII token with only an internal capital ("myGov", "iBAS++" in live menus) is not enough evidence.
    if (tokens.length === 1 && !strong) return 'UNKNOWN';
    return 'BIJOY_ANSI';
  }
  if (!strongTokens && !weakTokens) return 'ENGLISH_OK';
  return 'UNKNOWN';
}

function isStorable(value, fontHint = null) {
  const c = classifyText(value, fontHint);
  return c === 'EMPTY' || STORABLE.has(c);
}

const WARNING_BN = 'কিছু তথ্য পুরনো ফন্টে (বিজয়) লেখা, পড়া যায়নি';

/**
 * Split {field: value} into values that may be stored and warnings for the ones that may not.
 * Only text fields are judged; image URLs and links are Latin by definition.
 */
function screenFields(fields = {}) {
  const accepted = {};
  const warnings = [];
  Object.entries(fields || {}).forEach(([field, value]) => {
    if (typeof value !== 'string' || /(_Image_URL|_Photo|Website_Link|website_link|Last_Updated)$/i.test(field)) {
      accepted[field] = value;
      return;
    }
    const cls = classifyText(value);
    if (cls === 'EMPTY' || STORABLE.has(cls)) {
      accepted[field] = value;
    } else {
      warnings.push({ field, class: cls, value: String(value).slice(0, 120) });
    }
  });
  return { accepted, warnings };
}

module.exports = {
  classifyText, isStorable, isLegacyFont, structureProblems, screenFields, norm, STORABLE, WARNING_BN,
  LEGACY_FONT_PREFIXES,
};
