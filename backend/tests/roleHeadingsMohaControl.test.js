/**
 * Control case for the lawjusticediv fix in roleHeadingsFixtures.test.js: on a page that DOES have a genuine
 * primary heading, findRoleHeadingElement must keep finding it, not just correctly reject the container case.
 *
 * moha_info_officers.html (the "Template A" / national-portal widget layout) has a real, working structural
 * heading -- <h3 class="info-officer-view-widget-heading">দায়িত্বপ্রাপ্ত কর্মকর্তা</h3>, followed by a table
 * naming মো: তোফায়েল হোসেন -- contrary to this file's own first draft, which claimed the page "carries no
 * textual role heading at all" and built a synthetic fixture asserting null for primary. That claim was wrong:
 * it came from an exploratory script that (unjustifiably) skipped any element with more than 3 children, which
 * hid this exact heading. Verified directly against the real fixture:
 *   node -e "const fs=require('fs'),c=require('cheerio'),{findRoleHeadingElement}=require('./utils/roleHeadings');
 *   const \$=c.load(fs.readFileSync('../scraper/tests/fixtures/live/moha_info_officers.html','utf8'));
 *   const h=findRoleHeadingElement(\$,'দায়িত্বপ্রাপ্ত কর্মকর্তা','primary');
 *   console.log(\$(h).nextAll().find('table').first().text());"
 * -> "নাম: মো: তোফায়েল হোসেন (১৬২৯৪) পদবি: উপসচিব ( প্রশাসন-১ শাখা) ..."
 *
 * This uses a minimal synthetic reproduction of that same structure rather than loading the real ~84KB fixture:
 * loading that file via cheerio inside `node --test` on this Node build (v26.5.0) reproducibly hung and was
 * killed by the runner around 50-60s, while the identical call finishes in ~1-4ms under plain `node` (confirmed
 * directly, repeatedly, with timing: 187 candidate elements out of 668 total, ~1ms to scan) -- an environment/
 * instrumentation quirk on this specific file+runner combination, not a defect or a real scan-size problem.
 */
const { describe, it } = require('node:test');
const assert = require('assert');
const cheerio = require('cheerio');
const { findRoleHeadingElement } = require('../utils/roleHeadings');

describe('findRoleHeadingElement: Template A control case (moha_info_officers.html structure)', () => {
  it('finds the real primary heading and the officer table that follows it', () => {
    const $ = cheerio.load(
      '<html><body>'
      + '<nav><div class="mega-menu-dropdown"><ul>'
      + '<li><a>কর্মকর্তাবৃন্দ</a></li><li><a>কর্মবন্টন</a></li><li><a>তথ্য প্রদানকারী কর্মকর্তা</a></li>'
      + '<li><a>অভিযোগ নিষ্পত্তি প্রতিবেদন</a></li><li><a>প্রশাসনিক আদেশ</a></li>'
      + '</ul></div></nav>'
      + '<div class="info-officer-view-widget-body">'
      + '<h3 class="info-officer-view-widget-heading">দায়িত্বপ্রাপ্ত কর্মকর্তা</h3>'
      + '<table><tr><td>নাম:</td><td>মো: তোফায়েল হোসেন (১৬২৯৪)</td></tr>'
      + '<tr><td>পদবি:</td><td>উপসচিব</td></tr></table>'
      + '</div>'
      + '</body></html>',
    );
    const primary = findRoleHeadingElement($, 'দায়িত্বপ্রাপ্ত কর্মকর্তা', 'primary');
    assert.ok(primary, 'the real primary heading should be found, not rejected');
    const table = $(primary).nextAll('table').first().length ? $(primary).nextAll('table').first()
      : $(primary).nextAll().find('table').first();
    assert.ok(table.length, 'a table should follow the primary heading');
    assert.ok(table.text().includes('তোফায়েল হোসেন'), 'that table should name the real primary officer');
  });

  it('the menu-only role mention (no genuine heading) still finds nothing, unlike the case above', () => {
    // Same mega-menu, but this time nothing in the content itself names a role -- reproduces lawjusticediv's
    // shape (container heading only, real officers under different, correctly-classified headings) rather than
    // moha's shape (a genuine, correctly-formed primary heading).
    const $ = cheerio.load(
      '<html><body>'
      + '<nav><div class="mega-menu-dropdown"><ul>'
      + '<li><a>কর্মকর্তাবৃন্দ</a></li><li><a>কর্মবন্টন</a></li><li><a>তথ্য প্রদানকারী কর্মকর্তা</a></li>'
      + '<li><a>অভিযোগ নিষ্পত্তি প্রতিবেদন</a></li><li><a>প্রশাসনিক আদেশ</a></li>'
      + '</ul></div></nav>'
      + '<div class="widget"><div class="officer-card"><span class="name">জনাব করিম</span></div></div>'
      + '</body></html>',
    );
    assert.strictEqual(findRoleHeadingElement($, 'দায়িত্বপ্রাপ্ত কর্মকর্তা', 'primary'), null);
  });
});
