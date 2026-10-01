/**
 * Node twin of scraper/tests/test_integrity.py: the same shared vectors must classify the same way here.
 * Run: node --test tests/textIntegrity.test.js
 */
const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ti = require('../utils/textIntegrity');

const REPO = path.resolve(__dirname, '..', '..');
const V = JSON.parse(fs.readFileSync(path.join(REPO, 'shared', 'text_integrity_vectors.json'), 'utf8'));

describe('textIntegrity: shared classification vectors', () => {
  V.classify.forEach((v) => {
    it(`${JSON.stringify(v.text).slice(0, 40)} -> ${v.expected}`, () => {
      assert.strictEqual(ti.classifyText(v.text, v.font_hint), v.expected);
    });
  });
});

describe('textIntegrity: every Bijoy vector is refused and every converted form is accepted', () => {
  V.bijoy_to_unicode.filter((v) => v.kind === 'line').forEach((v) => {
    it(`refuses ${v.bijoy}`, () => {
      assert.strictEqual(ti.classifyText(v.bijoy), 'BIJOY_ANSI');
      assert.strictEqual(ti.isStorable(v.bijoy), false);
    });
  });
  V.bijoy_to_unicode.forEach((v) => {
    it(`accepts ${v.unicode}`, () => {
      assert.strictEqual(ti.isStorable(v.unicode), true);
    });
    if (v.font) {
      it(`refuses ${v.bijoy} when the font is known`, () => {
        assert.strictEqual(ti.isStorable(v.bijoy, v.font), false);
      });
    }
  });
});

describe('textIntegrity: behaviour', () => {
  it('uses the same legacy font list as the Python tool', () => {
    const txt = fs.readFileSync(path.join(REPO, 'scraper', 'config', 'legacy_fonts.txt'), 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.deepStrictEqual(ti.LEGACY_FONT_PREFIXES, txt);
  });

  it('screenFields keeps good values and reports refused ones', () => {
    const { accepted, warnings } = ti.screenFields({
      Primary_Officer_Name: 'মো: তোফায়েল হোসেন (১৬২৯৪)',
      Primary_Designation: 'mnKvix mwPe|',
      Primary_Email: 'admin1@moha.gov.bd',
      Primary_Image_URL: 'https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/x/b/V2Ministry/o/office-moha/a.jpg',
    });
    assert.deepStrictEqual(Object.keys(accepted).sort(), ['Primary_Email', 'Primary_Image_URL', 'Primary_Officer_Name']);
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].field, 'Primary_Designation');
    assert.strictEqual(warnings[0].class, 'BIJOY_ANSI');
  });

  it('never stores the visual-order sample', () => {
    assert.strictEqual(ti.isStorable('দোভিত্বপ্রোপ্ত কর্ মকিমো'), false);
  });
});
