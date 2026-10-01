/**
 * DB-vs-live officer diff (Section 3). Replaces the old /verify-contact behavior where
 * `databaseRecord`/`liveScrapedRecord` were literally the same object and `discrepancies` was
 * hardcoded to all-false in every response branch (see api.js's old doc comment: "Strategy: Clone
 * DB record and intentionally modify to simulate discrepancies" -- that strategy was never
 * implemented). These are the real functions api.js now calls.
 */
const { describe, it } = require('node:test');
const assert = require('assert');
const {
  normalizePhoneForDiff,
  buildLiveScrapedRecord,
  computeOfficerDiscrepancies,
} = require('../utils/officerDiff');

describe('normalizePhoneForDiff', () => {
  it('treats cosmetically different formattings of the same number as equal', () => {
    assert.strictEqual(normalizePhoneForDiff('+৮৮০২-৫৮৩১৫৪৮৫'), normalizePhoneForDiff('০২৫৮৩১৫৪৮৫'));
    assert.strictEqual(normalizePhoneForDiff('+৮৮০১৭১২৭৫১৭৮৩'), normalizePhoneForDiff('০১৭১২৭৫১৭৮৩'));
  });

  it('still tells genuinely different numbers apart', () => {
    assert.notStrictEqual(normalizePhoneForDiff('01711945797'), normalizePhoneForDiff('01999999999'));
  });
});

describe('buildLiveScrapedRecord', () => {
  it('extracts a CSV-key-shaped record from a scrapeInfoOfficersPage()-style result', () => {
    const scraped = {
      primary: { 'নাম': 'মাহবুবুর রহমান খান', 'পদবি': 'সচিব', 'মোবাইল': '01711945797', 'ইমেইল': 'secretary@ccb.gov.bd' },
      alternate: {},
      appellate: { 'নাম': 'এ এইচ এম আহসান', 'পদবি': 'চেয়ারপার্সন' },
    };
    const live = buildLiveScrapedRecord(scraped);
    assert.strictEqual(live.Primary_Officer_Name, 'মাহবুবুর রহমান খান');
    assert.strictEqual(live.Primary_Designation, 'সচিব');
    assert.strictEqual(live.Primary_Mobile, '01711945797');
    assert.strictEqual(live.Appellate_Officer_Name, 'এ এইচ এম আহসান');
    assert.strictEqual(live.Appellate_Name, 'এ এইচ এম আহসান');
  });

  it('name-gates a role with no scraped name -- no contact details leak in without a name (mirrors applyScrapedOfficers R3 fix)', () => {
    const scraped = {
      primary: {},
      alternate: { 'পদবি': 'সিনিয়র সহকারী সচিব', 'মোবাইল': '01711000000' }, // details with no নাম
      appellate: {},
    };
    const live = buildLiveScrapedRecord(scraped);
    assert.strictEqual(live, null, 'no role had a scraped name -- there is nothing to compare');
  });

  it('returns null for a scrape that found nothing at all', () => {
    assert.strictEqual(buildLiveScrapedRecord(null), null);
    assert.strictEqual(buildLiveScrapedRecord({ primary: {}, alternate: {}, appellate: {} }), null);
  });
});

describe('computeOfficerDiscrepancies', () => {
  it('flags a field only when both sides are non-empty AND differ after normalization', () => {
    const db = { Primary_Officer_Name: 'মাহবুবুর রহমান খান', Primary_Phone: '০২-৫৮৩১৫৪৮৫' };
    const live = { Primary_Officer_Name: 'মাহবুবুর রহমান খান', Primary_Phone: '+৮৮০২৫৮৩১৫৪৮৫' };
    const diff = computeOfficerDiscrepancies(db, live);
    assert.strictEqual(diff.primary.name, false, 'identical names must not be flagged');
    assert.strictEqual(diff.primary.phone, false, 'same number, different formatting, must not be flagged');
  });

  it('flags a genuine mismatch and carries the live value for display', () => {
    const db = { Primary_Officer_Name: 'শাম্মী ইসলাম' };
    const live = { Primary_Officer_Name: 'মোঃ সারোয়ার সালাম' };
    const diff = computeOfficerDiscrepancies(db, live);
    assert.strictEqual(diff.primary.name, true);
    assert.strictEqual(diff.primary.name_live, 'মোঃ সারোয়ার সালাম');
  });

  it('never flags a field where the live side is blank -- a missed scrape is not a discrepancy', () => {
    const db = { Primary_Officer_Name: 'মাহবুবুর রহমান খান', Primary_Email: 'secretary@ccb.gov.bd' };
    const live = { Primary_Officer_Name: 'মাহবুবুর রহমান খান' }; // scrape found no email at all
    const diff = computeOfficerDiscrepancies(db, live);
    assert.strictEqual(diff.primary.email, false);
  });

  it('returns null when there is nothing to compare at all (e.g. fast pass with no live scrape)', () => {
    assert.strictEqual(computeOfficerDiscrepancies(null, { Primary_Officer_Name: 'x' }), null);
    assert.strictEqual(computeOfficerDiscrepancies({ Primary_Officer_Name: 'x' }, null), null);
    assert.strictEqual(
      computeOfficerDiscrepancies({ Primary_Officer_Name: '' }, { Primary_Officer_Name: '' }),
      null,
      'both sides blank on every field -- honestly nothing was compared',
    );
  });
});
