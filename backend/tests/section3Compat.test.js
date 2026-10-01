/**
 * Section 3 compatibility with the 245-row dataset (brief sections 15.2, 15.3, 15.5).
 * contactLoader resolves the dataset relative to its own file, so each test loads an isolated copy of it next to a
 * temporary CSV; the real repo-root CSV is never read or written.
 * Run: node --test tests/section3Compat.test.js
 */
const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const REPO = path.resolve(BACKEND, '..');
const S3_CSV = path.join(REPO, 's3', 'JAANI_RTI_OFFICERS_COMPLETE.csv');

function isolatedLoader(csvText) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jaani-s3-'));
  fs.mkdirSync(path.join(root, 'backend', 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'backend', 'utils'), { recursive: true });
  fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
  fs.copyFileSync(path.join(BACKEND, 'data', 'contactLoader.js'), path.join(root, 'backend', 'data', 'contactLoader.js'));
  for (const f of fs.readdirSync(path.join(BACKEND, 'utils'))) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(BACKEND, 'utils', f), path.join(root, 'backend', 'utils', f));
  }
  const vectors = path.join(REPO, 'shared', 'text_integrity_vectors.json');
  if (fs.existsSync(vectors)) fs.copyFileSync(vectors, path.join(root, 'shared', 'text_integrity_vectors.json'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'));
  const csvPath = path.join(root, 'JAANI_RTI_OFFICERS_COMPLETE.csv');
  fs.writeFileSync(csvPath, csvText, 'utf8');
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const loader = require(path.join(root, 'backend', 'data', 'contactLoader.js'));
  return { loader, csvPath, root };
}

function parseCsv(text) {
  // eslint-disable-next-line global-require
  const { parse } = require('csv-parse/sync');
  return parse(text, { columns: true, bom: true, skip_empty_lines: true });
}

function toCsv(rows) {
  const header = Object.keys(rows[0]);
  const esc = (v) => (/[",\r\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return `${[header.join(','), ...rows.map((r) => header.map((h) => esc(r[h] || '')).join(','))].join('\r\n')}\r\n`;
}

const S3_TEXT = fs.readFileSync(S3_CSV, 'utf8');
const S3_ROWS = parseCsv(S3_TEXT);

describe('15.5 row matching at 245 rows', () => {
  const variants = {
    original: S3_ROWS,
    reversed: [...S3_ROWS].reverse(),
    rti_url_replaced: S3_ROWS.map((r) => ({ ...r, Website_Link: r.Website_Link.replace(/\/views\/info-officers$/, '/site/view/information_officers') })),
  };
  for (const [name, rows] of Object.entries(variants)) {
    it(`every row is the unique winner for its own identity (${name})`, () => {
      const { loader } = isolatedLoader(toCsv(rows));
      const failures = [];
      rows.forEach((row, i) => {
        const original = S3_ROWS.find((r) => r.Office === row.Office && r.Division === row.Division);
        const contact = { Ministry: row.Ministry, Division: row.Division, Office: row.Office, office_name: row.Office,
          Website_Link: original.Website_Link };
        const res = loader.upsertContactInCsv(contact, { mode: 'auto-reconcile', allowInsert: false, minMatchScore: 130,
          requestedOffice: row.Office });
        if (res.rowIndex !== i || !(res.score >= 130)) failures.push(`${row.Office}: got row ${res.rowIndex} score ${res.score}`);
      });
      assert.deepStrictEqual(failures, []);
    });
  }
});

describe('15.2 / 15.3 auto-reconcile write path', () => {
  const moha = { ...S3_ROWS.find((r) => r.Office === 'স্বরাষ্ট্র মন্ত্রণালয়') };
  Object.assign(moha, {
    Primary_Officer_Name: 'মোঃ শিমুল আকতার', Primary_Designation: 'উপসচিব (প্রশাসন-১)', Primary_Email: 'rti@moha.gov.bd',
    Alternate_Officer_Name: 'নাসরীন সুলতানা',
  });
  const base = S3_ROWS.map((r) => (r.Office === moha.Office ? moha : r));

  it('a live scrape of the row\'s own page updates a changed name and never blanks a value', () => {
    const { loader, csvPath } = isolatedLoader(toCsv(base));
    const res = loader.upsertContactInCsv({
      Office: moha.Office, office_name: moha.Office, Website_Link: moha.Website_Link,
      Primary_Officer: 'মো: তোফায়েল হোসেন (১৬২৯৪)', Primary_Designation: 'উপসচিব ( প্রশাসন-১ শাখা)', Primary_Email: '',
    }, { mode: 'auto-reconcile', minMatchScore: 130, requestedOffice: moha.Office });
    assert.strictEqual(res.success, true);
    const row = parseCsv(fs.readFileSync(csvPath, 'utf8')).find((r) => r.Office === moha.Office);
    assert.strictEqual(row.Primary_Officer_Name, 'মো: তোফায়েল হোসেন (১৬২৯৪)');
    assert.strictEqual(row.Primary_Designation, 'উপসচিব ( প্রশাসন-১ শাখা)');
    assert.strictEqual(row.Primary_Email, 'rti@moha.gov.bd');
    assert.strictEqual(row.Alternate_Officer_Name, 'নাসরীন সুলতানা');
  });

  it('auto-reconcile refuses legacy-font (Bijoy) text and reports integrity_warnings', () => {
    const { loader, csvPath } = isolatedLoader(toCsv(base));
    const res = loader.upsertContactInCsv({ Office: moha.Office, office_name: moha.Office, Website_Link: moha.Website_Link,
      Primary_Phone: '+৮৮-০২-২২৩৩৫৪৫২১', Alternate_Designation: 'mnKvix mwPe|' },
    { mode: 'auto-reconcile', minMatchScore: 130 });
    const row = parseCsv(fs.readFileSync(csvPath, 'utf8')).find((r) => r.Office === moha.Office);
    assert.strictEqual(row.Alternate_Designation, '');
    assert.strictEqual(row.Primary_Phone, '+৮৮-০২-২২৩৩৫৪৫২১');
    assert.ok(Array.isArray(res.integrity_warnings) && res.integrity_warnings.length === 1);
    assert.strictEqual(res.integrity_warnings[0].class, 'BIJOY_ANSI');
  });

  it('manual mode (the owner typing) stores the value but returns a visible warning', () => {
    const { loader, csvPath } = isolatedLoader(toCsv(base));
    const res = loader.upsertContactInCsv({ Office: moha.Office, office_name: moha.Office, Website_Link: moha.Website_Link,
      Alternate_Designation: 'mnKvix mwPe|' }, { mode: 'manual', minMatchScore: 120 });
    const row = parseCsv(fs.readFileSync(csvPath, 'utf8')).find((r) => r.Office === moha.Office);
    assert.strictEqual(row.Alternate_Designation, 'mnKvix mwPe|');
    assert.ok(res.integrity_warnings && res.integrity_warnings.length === 1);
  });

  it('a save on a new row updates exactly that row (no twin) and stamps Last_Updated (15.4)', () => {
    const target = S3_ROWS.find((r) => /\.org\.bd\//.test(r.Website_Link));
    const { loader, csvPath } = isolatedLoader(S3_TEXT);
    const res = loader.upsertContactInCsv({ ...target, office_name: target.Office, Primary_Officer: 'জনাব পরীক্ষা',
      Primary_Designation: 'পরিচালক' }, { mode: 'manual', minMatchScore: 120, originalIdentifier: target.Office });
    assert.strictEqual(res.updated, true);
    assert.strictEqual(res.inserted, false);
    const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
    assert.strictEqual(rows.length, 245);
    const row = rows.find((r) => r.Office === target.Office);
    assert.strictEqual(row.Primary_Officer_Name, 'জনাব পরীক্ষা');
    assert.strictEqual(row.Last_Updated, new Date().toISOString().slice(0, 10));
  });

  it('an officer shared by two bodies never makes one body overwrite (and rename) the other row', () => {
    const shared = { Primary_Officer_Name: 'মো: তোফায়েল হোসেন (১৬২৯৪)', Primary_Mobile: '০১৭১২০৬৩০৮৯', Primary_Email: 'admin1@moha.gov.bd' };
    const bpdbRow = S3_ROWS.find((r) => r.Office === 'বাংলাদেশ বিদ্যুৎ উন্নয়ন বোর্ড');
    // Both bodies' pages on one portal host (as on a shared portal / the mock portal): host match adds to MoHA's score.
    const sharedHost = new URL(bpdbRow.Website_Link).origin;
    const rows = S3_ROWS.map((r) => (r.Office === moha.Office
      ? { ...moha, ...shared, Website_Link: `${sharedHost}/moha/views/info-officers` } : r));
    const { loader, csvPath } = isolatedLoader(toCsv(rows));
    const res = loader.upsertContactInCsv({
      // office_name as the app sends it: "Ministry - Office" (toNormalizedOfficerRecord)
      Ministry: bpdbRow.Ministry, Division: bpdbRow.Division, Office: bpdbRow.Office,
      office_name: `${bpdbRow.Ministry} - ${bpdbRow.Office}`,
      Website_Link: bpdbRow.Website_Link, Primary_Officer: shared.Primary_Officer_Name, Primary_Mobile: shared.Primary_Mobile,
      Alternate_Officer: 'নাসরীন সুলতানা (১৬২১৮)',
    }, { mode: 'auto-reconcile', minMatchScore: 130, originalIdentifier: shared.Primary_Mobile, requestedOffice: bpdbRow.Office });
    const after = parseCsv(fs.readFileSync(csvPath, 'utf8'));
    assert.strictEqual(after.length, 245);
    const mohaAfter = after.find((r) => r.Office === moha.Office);
    assert.ok(mohaAfter, 'MoHA row still exists under its own name');
    assert.strictEqual(mohaAfter.Alternate_Officer_Name, 'নাসরীন সুলতানা');
    assert.strictEqual(after.find((r) => r.Office === bpdbRow.Office).Alternate_Officer_Name, 'নাসরীন সুলতানা (১৬২১৮)');
    assert.ok(res.updated);
  });

  it('a local cached photo path is never written into the CSV Image_URL columns', () => {
    const remote = 'https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/a/b/V2Ministry/o/office-moha/p.jpg';
    const rows = S3_ROWS.map((r) => (r.Office === moha.Office ? { ...moha, Primary_Image_URL: remote } : r));
    const { loader, csvPath } = isolatedLoader(toCsv(rows));
    loader.upsertContactInCsv({ Office: moha.Office, Website_Link: moha.Website_Link, Primary_Officer: moha.Primary_Officer_Name,
      Primary_Photo: '/shared/image data from link/abc.jpg', Alternate_Photo: '/shared/officer_photos/x/alternate.jpg' },
    { mode: 'auto-reconcile', minMatchScore: 130 });
    const row = parseCsv(fs.readFileSync(csvPath, 'utf8')).find((r) => r.Office === moha.Office);
    assert.strictEqual(row.Primary_Image_URL, remote);
    assert.strictEqual(row.Alternate_Image_URL, '');
  });
});

