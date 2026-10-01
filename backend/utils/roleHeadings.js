/**
 * RTI role-heading classification (Section 3, spec 6.2).
 *
 * Mirrors the Python scraper's classify_heading() in spirit (parallel logic, not a shared/imported module -- the
 * two run in different languages against the same class of pages). The rule that matters: a PLURAL/CONTAINER
 * heading ("দায়িত্বপ্রাপ্ত কর্মকর্তাগণ", "কর্মকর্তাবৃন্দ") names a section that holds officers, not an officer, and
 * must be excluded before any role substring test -- "দায়িত্বপ্রাপ্ত কর্মকর্তা" is a substring of both that
 * container form and of "বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা", so a substring test alone cannot tell the three apart.
 *
 * Live bug this was written from (lawjusticediv.gov.bd/views/info-officers, fixed 2026-09-29): the page's
 * headings are
 *   <h2> দায়িত্বপ্রাপ্ত কর্মকর্তাগণ      (container -- the section title, no officer of its own)
 *   <h3> বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা  (alternate)
 *   <h3> আপীল কর্তৃপক্ষ                  (appellate)
 * There is no primary officer on that page. The old heading search picked the shortest element whose text
 * *contained* the needle -- for primary that was the <h2> container -- and returned the table that followed it,
 * which was the ALTERNATE's. findRoleHeadingElement() below is what api.js actually calls; it never accepts a
 * match that classifies as anything other than the requested role.
 */

const ROLE_CONTAINER_RE = /কর্মকর্তাগণ|কর্মকর্তাবৃন্দ|কর্মকর্তাদের|officers\b/i;

// Bengali য় has two encodings that occur interchangeably on real government pages -- precomposed U+09DF, and
// য (U+09AF) + nukta (U+09BC) written as two codepoints. These are NOT canonically equivalent, so
// String.prototype.normalize('NFC') does not unify them (verified: "য়".normalize('NFC') stays two
// codepoints). Without this, a heading whose source HTML happens to use the other encoding than the one baked
// into this file's own regex literals silently fails to classify -- this is how "বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা"
// on the live lawjusticediv.gov.bd page (precomposed) failed to match this file's needle strings (decomposed)
// until this normalization was added. Kept in sync with the same fix in api.js's normalizeForMatch().
function normalizeHeadingText(value) {
  return (value || '').toString()
    .normalize('NFC')
    .replace(/য়/g, 'য়')
    .replace(/\s+/g, ' ')
    .trim();
}

/** -> 'primary' | 'alternate' | 'appellate' | 'container' | null */
function classifyRoleHeading(text) {
  const t = normalizeHeadingText(text).replace(/[ঃ:]\s*$/, '');
  if (!t || t.length > 70) return null;                 // long text is prose, not a heading
  if (ROLE_CONTAINER_RE.test(t)) return 'container';    // early return, before any role check
  const hasAppeal = /আপ[ীি]ল/.test(t);
  const hasAlt = /বিকল্প|alternat/i.test(t);
  if (hasAppeal && /কর্তৃপক্ষ|authority|কর্মকর্তা/.test(t)) return 'appellate';
  if (hasAlt && /কর্মকর্তা|officer/i.test(t)) return 'alternate';
  if (!hasAlt && !hasAppeal
      && /দায়িত্বপ্রাপ্ত\s*কর্মকর্তা|তথ্য\s*প্রদানকারী\s*কর্মকর্তা|designated\s*officer/i.test(t)) {
    return 'primary';
  }
  return null;
}

/**
 * The element whose text names `role`'s heading, or null.
 *
 * Candidate search: the shortest element (by matched-text length) among h1-h4/div/span/strong that CONTAINS
 * `needle` as a substring -- unchanged from before the fix, so page templates that never worked any other way
 * (e.g. the national-portal widget template, where no element's own text matches classifyRoleHeading at all and
 * the officer still has to be found some other way downstream) keep behaving exactly as they did.
 *
 * The one new constraint: a candidate is accepted only if its own text classifies as EXACTLY `role`. This can
 * only REJECT a wrong candidate (a container, or a different role) -- it never changes which element the
 * substring search would otherwise have picked, so it cannot introduce a new false positive on a template this
 * search already worked for.
 */
function findRoleHeadingElement($, needle, role) {
  const normalizedNeedle = normalizeHeadingText(needle).toLowerCase();
  let best = null;
  let bestLength = Infinity;
  for (const el of $('h1,h2,h3,h4,div,span,strong').toArray()) {
    const text = normalizeHeadingText($(el).text());
    const lower = text.toLowerCase();
    if (text && lower.includes(normalizedNeedle) && text.length < bestLength) {
      best = el;
      bestLength = text.length;
    }
  }
  if (!best) return null;
  const kind = classifyRoleHeading($(best).text());
  return (kind && kind !== role) ? null : best;
}

module.exports = { classifyRoleHeading, findRoleHeadingElement, ROLE_CONTAINER_RE };
