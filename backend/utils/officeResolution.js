/**
 * officeResolution.js
 *
 * Pure-logic module for Section 3 (RTI Officer Directory):
 *
 * Simple rule: take Section 2's detected organizations, match each against
 * the CSV's Ministry / Division / Office columns.  If matched → show that row.
 * If the matched row has no officers → climb the ladder (office → division → ministry).
 * Deduplicate: same resolved row shown only once.
 *
 * Zero I/O, fully unit-testable.
 */

'use strict';

// ─── helpers ──────────────────────────────────────────────────────────────────

function normalizeText(s) {
  return (s || '')
    .toString()
    .normalize('NFKC')
    .replace(/[​‌‍]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function hasOfficerName(name) {
  const n = (name || '').toString().trim().toLowerCase();
  return n.length > 0 && n !== 'test' && n !== 'n/a' && n !== 'na' && n !== '-';
}

function contactHasOfficers(contact) {
  return hasOfficerName(contact?.Primary_Officer || contact?.Primary_Officer_Name)
    || hasOfficerName(contact?.Alternate_Officer || contact?.Alternate_Officer_Name)
    || hasOfficerName(contact?.Appellate_Officer || contact?.Appellate_Name || contact?.Appellate_Officer_Name);
}

function rowKey(contact) {
  const m = (contact?.Ministry || '').toString().trim();
  const d = (contact?.Division || '').toString().trim();
  const o = (contact?.Office || '').toString().trim();
  return `${m}|${d}|${o}`;
}

// ─── match a single entity name against CSV columns ──────────────────────────

/**
 * Match an entity name against all contacts' Ministry, Division, Office columns.
 * Returns all contacts where any of those columns matches.
 */
/**
 * Match an entity name against contacts.  Priority:
 * 1. Exact Office match → return that one row
 * 2. Ministry-level row (M==D==O) → return that one row (not all rows under the ministry)
 * 3. Division-level row match → return that one row
 * Returns at most one contact (the best match), or [].
 */
function matchEntityToContacts(entityName, contacts) {
  const needle = normalizeText(entityName);
  if (!needle) return [];

  // 1. Exact Office column match
  const officeMatch = contacts.find((c) => normalizeText(c?.Office) === needle);
  if (officeMatch) return [officeMatch];

  // 2. Ministry-level row (M==D==O)
  const ministryRow = contacts.find((c) => {
    const m = normalizeText(c?.Ministry);
    return m === needle && m === normalizeText(c?.Division) && m === normalizeText(c?.Office);
  });
  if (ministryRow) return [ministryRow];

  // 3. Division column match → find the division-level row (Division==Office)
  const divisionRow = contacts.find((c) =>
    normalizeText(c?.Division) === needle && normalizeText(c?.Office) === needle
  );
  if (divisionRow) return [divisionRow];

  return [];
}

// ─── ladder: climb from an empty row to its parent ───────────────────────────

function findMinistryRow(contacts, ministryName) {
  const needle = normalizeText(ministryName);
  if (!needle) return null;
  return contacts.find((c) => {
    const m = normalizeText(c?.Ministry);
    return m === needle && m === normalizeText(c?.Division) && m === normalizeText(c?.Office);
  }) || null;
}

/**
 * Find the "parent division" row for a child office.
 * The division row is the one whose Office column equals the child's Division column,
 * within the same Ministry.  This covers:
 *  - Division-level rows (Division==Office, e.g. আইন ও বিচার বিভাগ)
 *  - Intermediate rows (like Police HQ where Office = পুলিশ হেডকোয়ার্টার্স বাংলাদেশ পুলিশ)
 */
function findDivisionRow(contacts, divisionName, ministryName) {
  const dNeedle = normalizeText(divisionName);
  const mNeedle = normalizeText(ministryName);
  if (!dNeedle || dNeedle === mNeedle) return null;  // division == ministry → no separate division
  // Find a row whose Office matches the target's Division, same Ministry
  return contacts.find((c) => {
    return normalizeText(c?.Ministry) === mNeedle
      && normalizeText(c?.Office) === dNeedle;
  }) || null;
}

/**
 * Given a matched contact row, resolve up the ladder if it has no officers.
 * Returns { resolved, rung, skipped }.
 */
function resolveOfficeLadder(contact, contacts) {
  const skipped = [];
  const m = (contact.Ministry || '').trim();
  const d = (contact.Division || '').trim();
  const o = (contact.Office || '').trim();

  // Rung 1: office itself
  if (contactHasOfficers(contact)) {
    return { resolved: contact, rung: 'office', skipped };
  }
  skipped.push({ rung: 'office', label: o, reason: 'no_officers' });

  // Rung 2: division row (Division==Office within same Ministry, different from the matched row)
  const divRow = findDivisionRow(contacts, d, m);
  if (divRow && rowKey(divRow) !== rowKey(contact)) {
    if (contactHasOfficers(divRow)) {
      return { resolved: divRow, rung: 'division', skipped };
    }
    skipped.push({ rung: 'division', label: d, reason: 'no_officers' });
  } else if (normalizeText(d) !== normalizeText(m) && normalizeText(d) !== normalizeText(o)) {
    skipped.push({ rung: 'division', label: d, reason: 'no_row' });
  }

  // Rung 3: ministry row (M==D==O)
  const minRow = findMinistryRow(contacts, m);
  if (minRow && rowKey(minRow) !== rowKey(contact)) {
    if (contactHasOfficers(minRow)) {
      return { resolved: minRow, rung: 'ministry', skipped };
    }
    skipped.push({ rung: 'ministry', label: m, reason: 'no_officers' });
  } else if (!minRow) {
    skipped.push({ rung: 'ministry', label: m, reason: 'no_row' });
  }

  // Rung 4: none
  return { resolved: null, rung: 'none', skipped };
}

// ─── main: match detected orgs, resolve, dedupe ─────────────────────────────

/**
 * @param {string[]} detectedOrgs   Section 2's detected organization names
 * @param {object[]} contacts       All loaded contacts (from contactLoader)
 * @param {object}   [gazetteer]    rtiGazetteer module (optional, for alias matching)
 * @param {object}   [options]      { maxCards: 4 }
 * @returns {Array<{ requestedEntities, matchedContact, resolution }>}
 */
function resolveDetectedOrgs(detectedOrgs, contacts, gazetteer, options = {}) {
  const maxCards = options.maxCards || 4;
  const results = [];
  const seenResolvedKeys = new Set();

  for (const orgName of detectedOrgs) {
    if (results.length >= maxCards) break;
    if (!orgName || typeof orgName !== 'string') continue;
    const trimmed = orgName.trim();
    if (!trimmed) continue;

    // Step 1: direct match against Ministry/Division/Office columns
    let matched = matchEntityToContacts(trimmed, contacts);

    // Step 2: if no direct match, try gazetteer aliases
    if (matched.length === 0 && gazetteer?.matchGovernmentBodies) {
      const gzResult = gazetteer.matchGovernmentBodies(trimmed);
      const gzMatch = gzResult?.matches?.find((m) => m.method === 'exact' || m.method === 'agency_parent');
      if (gzMatch) {
        const pickedRow = gazetteer.pickRowForBody(gzMatch);
        if (pickedRow) {
          // Find the corresponding loaded contact
          const c = contacts.find((ct) =>
            normalizeText(ct?.Office) === normalizeText(pickedRow.office)
            && normalizeText(ct?.Ministry) === normalizeText(pickedRow.ministry)
            && normalizeText(ct?.Division) === normalizeText(pickedRow.division)
          );
          if (c) matched = [c];
        }
      }
    }

    if (matched.length === 0) continue;  // not in CSV → skip, never pad

    // For each matched row, resolve up the ladder and dedupe
    for (const contact of matched) {
      if (results.length >= maxCards) break;
      const ladder = resolveOfficeLadder(contact, contacts);
      const resolvedKey = ladder.resolved ? rowKey(ladder.resolved) : `none:${rowKey(contact)}`;

      if (seenResolvedKeys.has(resolvedKey)) {
        // Merge entity name into existing card
        const existing = results.find((r) => r._resolvedKey === resolvedKey);
        if (existing && !existing.requestedEntities.includes(trimmed)) {
          existing.requestedEntities.push(trimmed);
        }
        continue;
      }

      seenResolvedKeys.add(resolvedKey);
      results.push({
        _resolvedKey: resolvedKey,
        requestedEntities: [trimmed],
        matchedContact: contact,
        resolution: {
          resolved: ladder.resolved,
          rung: ladder.rung,
          skipped: ladder.skipped,
          requestedRowKey: rowKey(contact),
          resolvedRowKey: ladder.resolved ? rowKey(ladder.resolved) : null,
        },
      });
    }
  }

  // Clean up internal key
  return results.map(({ _resolvedKey, ...rest }) => rest);
}

// ─── Bengali notice ──────────────────────────────────────────────────────────

function buildNoticeBn(resolution) {
  const { rung, skipped } = resolution;
  if (rung === 'office') return '';

  const requestedOffice = resolution.requestedRowKey
    ? resolution.requestedRowKey.split('|')[2]
    : '';

  if (rung === 'ai_fallback') {
    const resolvedMin = resolution.resolved?.Ministry || '';
    return `«${requestedOffice}» ডেটাসেটে কিউরেট করা নেই, তাই AI বিশ্লেষণ অনুযায়ী সম্ভাব্য সংশ্লিষ্ট মন্ত্রণালয় ${resolvedMin}-এর তথ্য দেখানো হচ্ছে -- এটি একটি অনুমানভিত্তিক মিল, নিশ্চিত করে নিন।`;
  }

  if (rung === 'division') {
    const resolvedDiv = resolution.resolved?.Division || '';
    return `«${requestedOffice}»-এর নিজস্ব RTI কর্মকর্তার তথ্য ডেটাসেটে নেই, তাই ${resolvedDiv}-এর তথ্য দেখানো হচ্ছে।`;
  }

  if (rung === 'ministry') {
    const resolvedMin = resolution.resolved?.Ministry || resolution.resolved?.Office || '';
    const divSkipped = skipped.find((s) => s.rung === 'division');
    if (divSkipped) {
      return `«${requestedOffice}» ও «${divSkipped.label}»-এ কোনো RTI কর্মকর্তার তথ্য নেই, তাই ${resolvedMin}-এর তথ্য দেখানো হচ্ছে।`;
    }
    return `«${requestedOffice}»-এর নিজস্ব RTI কর্মকর্তার তথ্য ডেটাসেটে নেই, তাই ${resolvedMin}-এর তথ্য দেখানো হচ্ছে।`;
  }

  if (rung === 'none') {
    return `«${requestedOffice}», এর বিভাগ ও মন্ত্রণালয়ের কোনোটিতেই RTI কর্মকর্তার তথ্য পাওয়া যায়নি।`;
  }

  return '';
}

module.exports = {
  normalizeText,
  hasOfficerName,
  contactHasOfficers,
  rowKey,
  matchEntityToContacts,
  findMinistryRow,
  findDivisionRow,
  resolveOfficeLadder,
  resolveDetectedOrgs,
  buildNoticeBn,
};
