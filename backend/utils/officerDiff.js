/**
 * DB-vs-live officer diff (Section 3). Extracted so it's directly unit-testable, the same reason
 * roleHeadings.js was pulled out of api.js earlier -- these are pure functions with no route/axios/
 * cheerio dependency. api.js's own `pickOfficerTableField`/`OFFICER_TABLE_FIELD_PATTERNS` and
 * `normalizeForMatch` are NOT imported from here; small, stable copies live below instead (same
 * "mirrors... kept in sync" choice roleHeadings.js's normalizeHeadingText already made for
 * normalizeForMatch) rather than threading them as parameters through a dozen existing call sites.
 *
 * Built for the fix to api.js's /verify-contact, which previously echoed one merged record into
 * both `databaseRecord` and `liveScrapedRecord` and hardcoded `discrepancies` to all-false (see
 * that endpoint's doc comment history) -- there was no real DB-vs-live comparison before this.
 */

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

function normalizeForMatch(value) {
  return (value || '')
    .toString()
    .normalize('NFC')
    .toLowerCase()
    .replace(/য়/g, 'য়')
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/[‐‑‒–—\-]+/g, ' - ')
    .replace(/[​‌‍]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const DIFF_ROLES = [
  ['primary', 'Primary'],
  ['alternate', 'Alternate'],
  ['appellate', 'Appellate'],
];

// Digits-only comparison for phone/mobile: the CSV and a freshly scraped page legitimately format the
// same number differently (dashes, spaces, a leading +৮৮/৮৮/০, Bengali vs Latin digits) without the
// underlying number actually differing. Comparing raw strings here would flag cosmetic noise as a
// discrepancy on almost every row.
const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';
function normalizePhoneForDiff(value) {
  const ascii = (value || '').toString().replace(/[০-৯]/g, (d) => String(BENGALI_DIGITS.indexOf(d)));
  let digits = ascii.replace(/\D/g, '');
  if (digits.startsWith('88')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

// Builds a CSV-key-shaped record (Primary_Officer_Name, Alternate_Designation, ...) directly from a
// scrapeInfoOfficersPage() result, WITHOUT mutating/merging into any existing record -- unlike
// applyScrapedOfficers (api.js), which is the write path. This is the read-only "what does the live
// page say" snapshot the diff needs. Mirrors applyScrapedOfficers's name-gating (the R3 fix): a role
// with no scraped officer name carries no scraped contact details either, so an empty primary role on
// the live page is never compared field-by-field against a filled-in CSV row and reported as "differs".
function buildLiveScrapedRecord(scraped) {
  if (!scraped || typeof scraped !== 'object') return null;
  const live = {};
  for (const [role, prefix] of DIFF_ROLES) {
    const table = scraped[role] || {};
    const name = pickOfficerTableField(table, 'name');
    if (!name) continue; // ungated role: nothing on the live page to compare for this role
    live[`${prefix}_Officer_Name`] = name;
    if (role === 'appellate') live.Appellate_Name = name;
    live[`${prefix}_Designation`] = pickOfficerTableField(table, 'designation');
    live[`${prefix}_Phone`] = pickOfficerTableField(table, 'phone');
    live[`${prefix}_Mobile`] = pickOfficerTableField(table, 'mobile');
    live[`${prefix}_Email`] = pickOfficerTableField(table, 'email');
    live[`${prefix}_Address`] = pickOfficerTableField(table, 'address');
  }
  return Object.keys(live).length ? live : null;
}

const DIFF_FIELDS = [
  ['Officer_Name', 'name', 'text'],
  ['Designation', 'designation', 'text'],
  ['Phone', 'phone', 'phone'],
  ['Mobile', 'mobile', 'phone'],
  ['Email', 'email', 'text'],
  ['Address', 'address', 'text'],
];

// Real field-by-field DB-vs-live diff, per role. A field is flagged only when BOTH sides have a
// non-empty value AND they differ after normalization -- a blank on either side is "nothing to
// compare", never a manufactured discrepancy (same standard as this session's other integrity fixes:
// a missing/failed scrape must never be presented as if it were a confirmed difference).
function computeOfficerDiscrepancies(databaseSnapshot, liveScrapedRecord) {
  if (!databaseSnapshot || !liveScrapedRecord) return null;
  const out = {};
  let anyCompared = false;
  for (const [role, prefix] of DIFF_ROLES) {
    const roleDiff = {};
    for (const [suffix, diffKey, kind] of DIFF_FIELDS) {
      const dbVal = (databaseSnapshot[`${prefix}_${suffix}`] || '').toString().trim();
      const liveVal = (liveScrapedRecord[`${prefix}_${suffix}`] || '').toString().trim();
      if (!dbVal || !liveVal) { roleDiff[diffKey] = false; continue; }
      anyCompared = true;
      const differs = kind === 'phone'
        ? normalizePhoneForDiff(dbVal) !== normalizePhoneForDiff(liveVal)
        : normalizeForMatch(dbVal) !== normalizeForMatch(liveVal);
      roleDiff[diffKey] = differs;
      if (differs) roleDiff[`${diffKey}_live`] = liveVal;
    }
    out[role] = roleDiff;
  }
  return anyCompared ? out : null;
}

module.exports = {
  normalizePhoneForDiff,
  buildLiveScrapedRecord,
  computeOfficerDiscrepancies,
  DIFF_ROLES,
  DIFF_FIELDS,
};
