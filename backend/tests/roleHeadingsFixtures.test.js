/**
 * Section 3 regression: a page whose only officer sections are Alternate and Appellate must never be given a
 * Primary officer. Live case, lawjusticediv.gov.bd/views/info-officers (fixture captured 2026-09-29):
 *   <h2> দায়িত্বপ্রাপ্ত কর্মকর্তাগণ      -- plural CONTAINER, not a role
 *   <h3> বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা  -- alternate (মো. সাইফুদ্দীন হোসাইন, has a photo)
 *   <h3> আপীল কর্তৃপক্ষ                  -- appellate (লিয়াকত আলী মোল্লা, has a photo)
 * Before the fix, the page-wide search for "দায়িত্বপ্রাপ্ত কর্মকর্তা" matched the <h2> container (it is a
 * substring of both the container and of "বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা"), and being the SHORTEST match won;
 * the table after it was the Alternate's, so the Alternate's name/phone/e-mail/address were written into Primary.
 *
 * Split from roleHeadings.test.js (classification-only tests) and further from roleHeadingsMohaControl.test.js
 * (the Template A control case) -- see that file's header for why the moha fixture lives on its own: loading
 * it and lawjusticediv_info_officers.html via cheerio in the same `node --test` process reproducibly hung.
 */
const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { classifyRoleHeading, findRoleHeadingElement } = require('../utils/roleHeadings');

function loadFixture(name) {
  return cheerio.load(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

describe('findRoleHeadingElement (the function api.js actually calls)', () => {
  it('lawjusticediv: rejects the container as a primary heading, so no primary element is returned', () => {
    const $ = loadFixture('lawjusticediv_info_officers.html');
    assert.strictEqual(findRoleHeadingElement($, 'দায়িত্বপ্রাপ্ত কর্মকর্তা', 'primary'), null);
  });

  it('lawjusticediv: still finds the real alternate and appellate headings', () => {
    // Compared through classifyRoleHeading rather than by literal string equality: this source file's own
    // Bengali literals and the live page's HTML are not guaranteed to use the same encoding of য় (see the
    // normalizeHeadingText comment in roleHeadings.js) -- two strings that render identically can still fail
    // strictEqual. Whether the element classifies as the right role is what actually matters here.
    const $ = loadFixture('lawjusticediv_info_officers.html');
    const alt = findRoleHeadingElement($, 'বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা', 'alternate');
    const app = findRoleHeadingElement($, 'আপীল কর্তৃপক্ষ', 'appellate');
    assert.ok(alt, 'alternate heading should be found');
    assert.ok(app, 'appellate heading should be found');
    assert.strictEqual(classifyRoleHeading($(alt).text()), 'alternate');
    assert.strictEqual(classifyRoleHeading($(app).text()), 'appellate');
  });

  it('rejects a candidate that classifies as a different role, without picking a different element', () => {
    // A page whose only "candidate" for primary is itself the alternate heading (no container at all):
    // the search must return null, not silently accept the alternate's heading as primary.
    const $ = cheerio.load('<div><h3>বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা</h3><p>নাম: জনাব করিম</p></div>');
    assert.strictEqual(findRoleHeadingElement($, 'দায়িত্বপ্রাপ্ত কর্মকর্তা', 'primary'), null);
  });

});
