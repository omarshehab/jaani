/*
 * Section 15.1 / 15.11: drive the four Section 3 flows in the real UI and store screenshots + API responses.
 *   node scraper/compat/ui_flows.js <frontend-url> <out-dir> [article-url]
 * Flows: fast (DB) verify, live scrape (slow pass / retry), Edit + Save, cached data.
 * Uses the repo's Playwright; run it against a sandboxed backend (compat/sandbox.py), never the live one.
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.join(__dirname, '..', '..', 'node_modules', 'playwright'));

const [,, BASE = 'http://localhost:3010', OUT = 'ui_out',
  ARTICLE = 'https://www.prothomalo.com/bangladesh/crime/diag0jvbhb'] = process.argv;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const log = [];
  const note = (m) => { log.push(`${new Date().toISOString()} ${m}`); console.log(m); };
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const verifyResponses = [];
  page.on('response', async (r) => {
    if (r.url().includes('/api/verify-contact') || r.url().includes('/api/contacts/update')) {
      let body = null;
      try { body = await r.json(); } catch (e) { body = null; }
      verifyResponses.push({ url: r.url(), status: r.status(), at: Date.now(), body });
      note(`response ${r.status()} ${r.url().replace(/^.*\/api/, '/api')}`);
    }
  });
  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
    note(`screenshot ${name}`);
  };
  const section3 = page.getByText('তুলনা ও সম্পাদনা').first();
  const result = { flows: {} };
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120000 });
    const input = page.locator('input[type="text"], input[type="url"], textarea').first();
    await input.fill(ARTICLE);
    await input.press('Enter');
    note('article submitted');

    // 1. fast (DB) verify: first verify-contact response + cards on screen
    await page.waitForFunction(() => document.body.innerText.includes('তুলনা ও সম্পাদনা'), null, { timeout: 240000 });
    await section3.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    await shot('1_fast_verify');
    result.flows.fast_verify = { ok: true, verify_calls: verifyResponses.length };

    // 2. live scrape: wait for the second (enrich_web) verify-contact response, or use the retry button
    const t0 = Date.now();
    while (verifyResponses.filter((r) => r.url.includes('verify-contact')).length < 2 && Date.now() - t0 < 150000) {
      await page.waitForTimeout(1000);
    }
    const retry = page.getByRole('button', { name: 'Try Manual Search' });
    if (await retry.count()) {
      note('retry button visible: clicking');
      await retry.first().click();
      await page.waitForResponse((r) => r.url().includes('/api/verify-contact'), { timeout: 150000 });
    }
    await section3.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2000);
    await shot('2_live_scrape');
    result.flows.live_scrape = { ok: true, verify_calls: verifyResponses.filter((r) => r.url.includes('verify-contact')).length,
      retry_button_shown: (await retry.count()) > 0 };

    // 3. Edit + Save
    await section3.click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ timeout: 30000 });
    await page.waitForTimeout(4000);
    await shot('3a_edit_dialog');
    const iframe = dialog.locator('iframe');
    result.flows.edit = { ok: true, iframe: await iframe.count(), iframe_src: (await iframe.count()) ? await iframe.first().getAttribute('src') : '' };
    const fields = dialog.locator('input[type="text"], textarea');
    let edited = '';
    for (let i = 0; i < await fields.count(); i += 1) {
      const f = fields.nth(i);
      const v = await f.inputValue();
      if (v && /[ঀ-৿]/.test(v) && !/@/.test(v)) {
        await f.fill(`${v} (যাচাই)`);
        edited = v;
        break;
      }
    }
    note(`edited field: ${edited}`);
    const save = dialog.getByRole('button', { name: /পরিবর্তন সংরক্ষণ/ });
    const [saveResp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/contacts/update'), { timeout: 30000 }),
      save.click(),
    ]);
    await page.waitForTimeout(2000);
    await shot('3b_after_save');
    result.flows.save = { ok: saveResp.status() === 200, status: saveResp.status(), edited };

    // 4. cached data
    const cache = page.getByRole('button', { name: 'Fetch from Local Cache' });
    if (await cache.count()) {
      await cache.first().click();
      await page.waitForResponse((r) => r.url().includes('/api/verify-contact'), { timeout: 60000 });
      await page.waitForTimeout(1500);
      await shot('4_cached_data');
      result.flows.cached = { ok: true, button_shown: true };
    } else {
      await shot('4_cached_data_button_not_shown');
      result.flows.cached = { ok: true, button_shown: false, note: 'shown only when verification is degraded' };
    }
    const cards = await page.evaluate(() => document.body.innerText.includes('তথ্য পাওয়া যায়নি'));
    result.empty_role_text_present = cards;
  } catch (e) {
    result.error = String(e).slice(0, 500);
    await shot('error');
  } finally {
    fs.writeFileSync(path.join(OUT, 'ui_result.json'), JSON.stringify({ ...result, log, verifyResponses }, null, 1));
    await browser.close();
  }
})();
