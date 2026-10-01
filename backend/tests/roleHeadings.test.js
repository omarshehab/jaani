/**
 * classifyRoleHeading (Section 3, spec 6.2): a PLURAL/CONTAINER heading like "দায়িত্বপ্রাপ্ত কর্মকর্তাগণ" must
 * never classify as a role -- "দায়িত্বপ্রাপ্ত কর্মকর্তা" is a substring of both that container form and of
 * "বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা", so a caller cannot tell them apart with a substring test alone.
 *
 * Fixture-backed tests for the live bug this classification exists to fix (lawjusticediv.gov.bd) are in
 * roleHeadingsFixtures.test.js -- see that file's header for why they are split out.
 */
const { describe, it } = require('node:test');
const assert = require('assert');
const { classifyRoleHeading } = require('../utils/roleHeadings');

describe('classifyRoleHeading (spec 6.2)', () => {
  it('treats a plural container heading as a container, never a role', () => {
    assert.strictEqual(classifyRoleHeading('দায়িত্বপ্রাপ্ত কর্মকর্তাগণ'), 'container');
    assert.strictEqual(classifyRoleHeading('কর্মকর্তাবৃন্দ'), 'container');
    assert.strictEqual(classifyRoleHeading('Information Officers'), 'container');
  });

  it('still classifies the real single-role headings', () => {
    assert.strictEqual(classifyRoleHeading('দায়িত্বপ্রাপ্ত কর্মকর্তা'), 'primary');
    assert.strictEqual(classifyRoleHeading('তথ্য প্রদানকারী কর্মকর্তা'), 'primary');
    assert.strictEqual(classifyRoleHeading('বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা'), 'alternate');
    assert.strictEqual(classifyRoleHeading('আপীল কর্তৃপক্ষ'), 'appellate');
    assert.strictEqual(classifyRoleHeading('আপিল কর্তৃপক্ষ'), 'appellate');
  });

  it('never reads "বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা" as primary (substring trap)', () => {
    assert.notStrictEqual(classifyRoleHeading('বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা'), 'primary');
  });
});
