const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeText,
  contactHasOfficers,
  rowKey,
  matchEntityToContacts,
  findMinistryRow,
  findDivisionRow,
  resolveOfficeLadder,
  resolveDetectedOrgs,
  buildNoticeBn,
} = require('../utils/officeResolution');

// ─── test fixtures: simulates the CSV rows as contactLoader produces them ────

const homeMinistry = {
  Ministry: 'স্বরাষ্ট্র মন্ত্রণালয়', Division: 'স্বরাষ্ট্র মন্ত্রণালয়', Office: 'স্বরাষ্ট্র মন্ত্রণালয়',
  Primary_Officer: 'মো: তোফায়েল হোসেন', Alternate_Officer: 'নাসরীন সুলতানা', Appellate_Officer: 'মনজুর মোর্শেদ চৌধুরী',
  Website_Link: 'https://moha.gov.bd', office_name: 'স্বরাষ্ট্র মন্ত্রণালয়',
};

const policeHQ = {
  Ministry: 'স্বরাষ্ট্র মন্ত্রণালয়', Division: 'স্বরাষ্ট্র মন্ত্রণালয়', Office: 'পুলিশ হেডকোয়ার্টার্স বাংলাদেশ পুলিশ',
  Primary_Officer: '', Alternate_Officer: '', Appellate_Officer: '',
  Website_Link: 'https://police.portal.gov.bd', office_name: 'স্বরাষ্ট্র মন্ত্রণালয়',
};

const dmp = {
  Ministry: 'স্বরাষ্ট্র মন্ত্রণালয়', Division: 'পুলিশ হেডকোয়ার্টার্স বাংলাদেশ পুলিশ', Office: 'ঢাকা মেট্রোপলিটন পুলিশ',
  Primary_Officer: '', Alternate_Officer: '', Appellate_Officer: '',
  Website_Link: 'https://dmp.portal.gov.bd', office_name: 'স্বরাষ্ট্র মন্ত্রণালয় - পুলিশ হেডকোয়ার্টার্স বাংলাদেশ পুলিশ',
};

const fireService = {
  Ministry: 'স্বরাষ্ট্র মন্ত্রণালয়', Division: 'স্বরাষ্ট্র মন্ত্রণালয়', Office: 'ফায়ার সার্ভিস ও সিভিল ডিফেন্স অধিদপ্তর',
  Primary_Officer: 'মোঃ শহীদ আতাহার হোসেন', Alternate_Officer: '', Appellate_Officer: '',
  Website_Link: 'https://fireservice.gov.bd', office_name: 'স্বরাষ্ট্র মন্ত্রণালয়',
};

const prisonDept = {
  Ministry: 'স্বরাষ্ট্র মন্ত্রণালয়', Division: 'স্বরাষ্ট্র মন্ত্রণালয়', Office: 'কারা অধিদপ্তর',
  Primary_Officer: 'টিপু সুলতান', Alternate_Officer: '', Appellate_Officer: '',
  Website_Link: 'https://prison.gov.bd', office_name: 'স্বরাষ্ট্র মন্ত্রণালয়',
};

const electionComm = {
  Ministry: 'নির্বাচন কমিশন সচিবালয়', Division: 'নির্বাচন কমিশন সচিবালয়', Office: 'নির্বাচন কমিশন সচিবালয়',
  Primary_Officer: '', Alternate_Officer: '', Appellate_Officer: '',
  Website_Link: 'https://ecs.gov.bd', office_name: 'নির্বাচন কমিশন সচিবালয়',
};

const commerceMinistry = {
  Ministry: 'বাণিজ্য মন্ত্রণালয়', Division: 'বাণিজ্য মন্ত্রণালয়', Office: 'বাণিজ্য মন্ত্রণালয়',
  Primary_Officer: 'শাম্মী ইসলাম', Alternate_Officer: '', Appellate_Officer: '',
  Website_Link: 'https://mincom.gov.bd', office_name: 'বাণিজ্য মন্ত্রণালয়',
};

const competitionComm = {
  Ministry: 'বাণিজ্য মন্ত্রণালয়', Division: 'বাণিজ্য মন্ত্রণালয়', Office: 'বাংলাদেশ প্রতিযোগিতা কমিশন',
  Primary_Officer: 'মো. আবু হেনা মো. রাজী হাসান', Alternate_Officer: 'তানভীর আহমেদ', Appellate_Officer: 'কাজী মো. ওয়াসিমুল ইসলাম',
  Website_Link: 'https://ccb.gov.bd', office_name: 'বাণিজ্য মন্ত্রণালয় - বাংলাদেশ প্রতিযোগিতা কমিশন',
};

const lawMinistry = {
  Ministry: 'আইন, বিচার ও সংসদ বিষয়ক মন্ত্রণালয়', Division: 'আইন, বিচার ও সংসদ বিষয়ক মন্ত্রণালয়', Office: 'আইন, বিচার ও সংসদ বিষয়ক মন্ত্রণালয়',
  Primary_Officer: '', Alternate_Officer: '', Appellate_Officer: '',
  Website_Link: 'https://minlaw.gov.bd', office_name: 'আইন, বিচার ও সংসদ বিষয়ক মন্ত্রণালয়',
};

const lawJusticeDiv = {
  Ministry: 'আইন, বিচার ও সংসদ বিষয়ক মন্ত্রণালয়', Division: 'আইন ও বিচার বিভাগ', Office: 'আইন ও বিচার বিভাগ',
  Primary_Officer: '', Alternate_Officer: '', Appellate_Officer: '',
  Website_Link: 'https://lawjusticediv.gov.bd', office_name: 'আইন, বিচার ও সংসদ বিষয়ক মন্ত্রণালয় - আইন ও বিচার বিভাগ',
};

const infoMinistry = {
  Ministry: 'তথ্য ও সম্প্রচার মন্ত্রণালয়', Division: 'তথ্য ও সম্প্রচার মন্ত্রণালয়', Office: 'তথ্য ও সম্প্রচার মন্ত্রণালয়',
  Primary_Officer: 'খাদিজা তাহেরা ববি', Alternate_Officer: '', Appellate_Officer: '',
  Website_Link: 'https://moi.gov.bd', office_name: 'তথ্য ও সম্প্রচার মন্ত্রণালয়',
};

const btv = {
  Ministry: 'তথ্য ও সম্প্রচার মন্ত্রণালয়', Division: 'তথ্য ও সম্প্রচার মন্ত্রণালয়', Office: 'বাংলাদেশ টেলিভিশন',
  Primary_Officer: 'মো: সিরাজুল হক ভূঞা', Alternate_Officer: '', Appellate_Officer: '',
  Website_Link: 'https://btv.gov.bd', office_name: 'তথ্য ও সম্প্রচার মন্ত্রণালয়',
};

const agriMinistry = {
  Ministry: 'কৃষি মন্ত্রণালয়', Division: 'কৃষি মন্ত্রণালয়', Office: 'কৃষি মন্ত্রণালয়',
  Primary_Officer: 'উম্মুল বানীন দ্যুতি', Alternate_Officer: '', Appellate_Officer: '',
  Website_Link: 'https://moa.gov.bd', office_name: 'কৃষি মন্ত্রণালয়',
};

const allContacts = [
  homeMinistry, policeHQ, dmp, fireService, prisonDept,
  electionComm, commerceMinistry, competitionComm,
  lawMinistry, lawJusticeDiv, infoMinistry, btv, agriMinistry,
];

// ─── unit tests ──────────────────────────────────────────────────────────────

describe('officeResolution', () => {

  describe('normalizeText', () => {
    it('lowercases and trims', () => {
      assert.equal(normalizeText('  Hello  World  '), 'hello world');
    });
    it('removes ZWJ/ZWNJ', () => {
      assert.equal(normalizeText('ক‌খ'), 'কখ');
    });
  });

  describe('contactHasOfficers', () => {
    it('returns true for a row with a named primary officer', () => {
      assert.equal(contactHasOfficers(homeMinistry), true);
    });
    it('returns false for empty officers', () => {
      assert.equal(contactHasOfficers(dmp), false);
    });
    it('treats "test" as empty', () => {
      assert.equal(contactHasOfficers({ Primary_Officer: 'test' }), false);
    });
  });

  describe('rowKey', () => {
    it('joins Ministry|Division|Office', () => {
      assert.equal(rowKey(dmp), 'স্বরাষ্ট্র মন্ত্রণালয়|পুলিশ হেডকোয়ার্টার্স বাংলাদেশ পুলিশ|ঢাকা মেট্রোপলিটন পুলিশ');
    });
  });

  describe('matchEntityToContacts', () => {
    it('matches against Office column', () => {
      const matches = matchEntityToContacts('ঢাকা মেট্রোপলিটন পুলিশ', allContacts);
      assert.equal(matches.length, 1);
      assert.equal(matches[0], dmp);
    });

    it('matches against Ministry column → returns the ministry-level row (M==D==O), not all rows', () => {
      const matches = matchEntityToContacts('স্বরাষ্ট্র মন্ত্রণালয়', allContacts);
      // Should return exactly the M==D==O row, not all rows under the ministry
      assert.equal(matches.length, 1);
      assert.equal(matches[0], homeMinistry);
    });

    it('returns empty for unrelated entity', () => {
      const matches = matchEntityToContacts('কৃষি মন্ত্রণালয়', [dmp, policeHQ]);
      assert.equal(matches.length, 0);
    });
  });

  describe('resolveOfficeLadder', () => {
    it('office has data: no climb', () => {
      const result = resolveOfficeLadder(fireService, allContacts);
      assert.equal(result.rung, 'office');
      assert.equal(result.resolved, fireService);
      assert.equal(result.skipped.length, 0);
    });

    it('DMP case: office empty, division exists but empty, ministry has data', () => {
      const result = resolveOfficeLadder(dmp, allContacts);
      assert.equal(result.rung, 'ministry');
      assert.equal(result.resolved, homeMinistry);
      assert.equal(result.skipped.length, 2);
      assert.equal(result.skipped[0].rung, 'office');
      assert.equal(result.skipped[1].rung, 'division');
      assert.equal(result.skipped[1].reason, 'no_officers');
    });

    it('Police HQ: office empty, no separate division rung, ministry has data', () => {
      const result = resolveOfficeLadder(policeHQ, allContacts);
      assert.equal(result.rung, 'ministry');
      assert.equal(result.resolved, homeMinistry);
    });

    it('ministry row itself empty with no parent → rung none', () => {
      const result = resolveOfficeLadder(electionComm, allContacts);
      assert.equal(result.rung, 'none');
      assert.equal(result.resolved, null);
    });

    it('partial roles at one rung — no cross-row mixing', () => {
      const result = resolveOfficeLadder(fireService, allContacts);
      // fireService has only Primary, no Alternate/Appellate — still resolved at office rung
      assert.equal(result.rung, 'office');
      assert.equal(result.resolved, fireService);
    });

    it('law ministry empty + law/justice division also empty → rung none', () => {
      const result = resolveOfficeLadder(lawJusticeDiv, allContacts);
      assert.equal(result.rung, 'none');
      assert.equal(result.resolved, null);
    });
  });

  describe('resolveDetectedOrgs', () => {
    it('DMP article: multiple entities resolve to one card (Home Ministry)', () => {
      const detected = [
        'ঢাকা মেট্রোপলিটন পুলিশ',
        'পুলিশ হেডকোয়ার্টার্স বাংলাদেশ পুলিশ',
        'স্বরাষ্ট্র মন্ত্রণালয়',
      ];
      const results = resolveDetectedOrgs(detected, allContacts);
      // All three resolve to homeMinistry → deduplicated to one card
      assert.equal(results.length, 1);
      assert.equal(results[0].resolution.rung, 'ministry');
      assert.equal(results[0].resolution.resolved, homeMinistry);
      assert.ok(results[0].requestedEntities.length >= 2);
    });

    it('DMP + fire service: 2 cards (both under Home Ministry but fire has its own officers)', () => {
      const detected = [
        'ঢাকা মেট্রোপলিটন পুলিশ',
        'ফায়ার সার্ভিস ও সিভিল ডিফেন্স অধিদপ্তর',
      ];
      const results = resolveDetectedOrgs(detected, allContacts);
      assert.equal(results.length, 2);
      // DMP → home ministry (ladder); fire service → own row
      assert.equal(results[0].resolution.rung, 'ministry');
      assert.equal(results[1].resolution.rung, 'office');
    });

    it('ungrounded entity (কৃষি) excluded when not in detected list', () => {
      const detected = ['ঢাকা মেট্রোপলিটন পুলিশ'];
      const results = resolveDetectedOrgs(detected, allContacts);
      assert.ok(results.every((r) => !r.requestedEntities.includes('কৃষি মন্ত্রণালয়')));
    });

    it('cap at 4 cards', () => {
      const detected = [
        'স্বরাষ্ট্র মন্ত্রণালয়',
        'বাণিজ্য মন্ত্রণালয়',
        'তথ্য ও সম্প্রচার মন্ত্রণালয়',
        'নির্বাচন কমিশন সচিবালয়',
        'কৃষি মন্ত্রণালয়',
      ];
      const results = resolveDetectedOrgs(detected, allContacts, null, { maxCards: 4 });
      assert.ok(results.length <= 4);
    });

    it('commerce + competition commission → 2 separate cards', () => {
      const detected = ['বাণিজ্য মন্ত্রণালয়', 'বাংলাদেশ প্রতিযোগিতা কমিশন'];
      const results = resolveDetectedOrgs(detected, allContacts);
      assert.equal(results.length, 2);
    });

    it('Election Commission (M==D==O, no officers, no parent) → rung none', () => {
      const detected = ['নির্বাচন কমিশন সচিবালয়'];
      const results = resolveDetectedOrgs(detected, allContacts);
      assert.equal(results.length, 1);
      assert.equal(results[0].resolution.rung, 'none');
    });

    it('placeholder names treated as empty', () => {
      const testContact = { ...homeMinistry, Primary_Officer: 'test', Alternate_Officer: '', Appellate_Officer: '' };
      const testContacts = [testContact, ...allContacts.filter((c) => c !== homeMinistry)];
      // homeMinistry replaced with one with 'test' as name → should climb or return none
      const result = resolveOfficeLadder(testContact, testContacts);
      // The ministry row now has 'test' as primary → contactHasOfficers returns false
      assert.equal(result.rung, 'none');
    });
  });

  describe('buildNoticeBn', () => {
    it('office rung → empty notice', () => {
      const notice = buildNoticeBn({ rung: 'office', skipped: [], requestedRowKey: 'a|b|c' });
      assert.equal(notice, '');
    });

    it('ministry rung with division skipped → names both', () => {
      const notice = buildNoticeBn({
        rung: 'ministry',
        skipped: [
          { rung: 'office', label: 'DMP', reason: 'no_officers' },
          { rung: 'division', label: 'Police HQ', reason: 'no_officers' },
        ],
        requestedRowKey: 'M|D|DMP',
        resolved: { Ministry: 'স্বরাষ্ট্র মন্ত্রণালয়', Office: 'স্বরাষ্ট্র মন্ত্রণালয়' },
      });
      assert.ok(notice.includes('DMP'));
      assert.ok(notice.includes('Police HQ'));
      assert.ok(notice.includes('স্বরাষ্ট্র মন্ত্রণালয়'));
    });

    it('none rung → failure notice', () => {
      const notice = buildNoticeBn({
        rung: 'none',
        skipped: [],
        requestedRowKey: 'M|D|Office',
      });
      assert.ok(notice.includes('পাওয়া যায়নি'));
    });
  });
});
