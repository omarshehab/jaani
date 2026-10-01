/**
 * Brief 15.9: the on-demand officer scrape refuses loopback, cloud metadata, non-allowed suffixes, odd ports and
 * redirects to internal addresses, while a normal gov.bd page still works. DNS is faked; nothing leaves the machine.
 * Run: node --test tests/officerUrlGuard.test.js
 */
const { describe, it } = require('node:test');
const assert = require('assert');
const { createOfficerUrlGuard } = require('../utils/officerUrlGuard');

const PUBLIC = { 'moha.gov.bd': ['103.48.18.141'], 'rebind.gov.bd': ['127.0.0.1'], 'evil.gov.bd': ['169.254.169.254'] };
const guard = (extra = {}) => createOfficerUrlGuard({
  resolve: async (h) => { if (!PUBLIC[h]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); return PUBLIC[h]; },
  log: () => {},
  ...extra,
});

describe('officer URL guard', () => {
  for (const [url, reason] of [
    ['http://127.0.0.1/admin', 'host suffix'],
    ['http://169.254.169.254/latest/meta-data/', 'host suffix'],
    ['https://example.com/views/info-officers', 'host suffix'],
    ['https://moha.gov.bd:8080/views/info-officers', 'port'],
    ['ftp://moha.gov.bd/', 'scheme'],
    ['https://rebind.gov.bd/views/info-officers', 'private'],
    ['https://evil.gov.bd/views/info-officers', 'private'],
  ]) {
    it(`refuses ${url}`, async () => {
      const v = await guard().check(url);
      assert.strictEqual(v.ok, false);
      assert.match(v.reason, new RegExp(reason));
    });
  }

  it('accepts a normal gov.bd page and the national portal image store', async () => {
    assert.strictEqual((await guard().check('https://moha.gov.bd/views/info-officers')).ok, true);
    const img = 'https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/axvjbnqprylg/b/V2Ministry/o/office-moha/2026/5/a.jpg';
    PUBLIC['objectstorage.ap-dcc-gazipur-1.oraclecloud15.com'] = ['140.238.1.1'];
    assert.strictEqual((await guard().check(img, { kind: 'image' })).ok, true);
    assert.strictEqual((await guard().check(img)).ok, false);
  });

  it('a redirect to an internal address is refused before it is requested', async () => {
    const requested = [];
    const doGet = async (url) => {
      requested.push(url);
      return { status: 302, headers: { location: 'http://127.0.0.1:8080/admin' } };
    };
    await assert.rejects(guard().getWithRedirects('https://moha.gov.bd/views/info-officers', doGet), /officer URL refused/);
    assert.deepStrictEqual(requested, ['https://moha.gov.bd/views/info-officers']);
  });

  it('connect-time lookup refuses a name that re-resolves to a private address (DNS rebinding)', async () => {
    await assert.rejects(guard().lookup('rebind.gov.bd'), /private\/reserved/);
    assert.deepStrictEqual(await guard().lookup('moha.gov.bd'), { address: '103.48.18.141', family: 4 });
  });

  it('test mode lets only the loopback mock portal through', async () => {
    const g = guard({ allowPrivateNetwork: true });
    assert.strictEqual((await g.check('http://127.0.0.1:61234/moha/views/info-officers')).ok, true);
    assert.strictEqual((await g.check('https://example.com/x')).ok, false);
  });
});
