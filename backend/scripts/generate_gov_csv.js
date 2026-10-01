/**
 * Generate CSV exports from backend/data/gov_contacts.json
 *
 * Outputs:
 * - backend/data/gov_contacts_all.csv
 * - backend/data/gov_organizations_all.csv
 *
 * Usage:
 *   node scripts/generate_gov_csv.js
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const INPUT_JSON = path.join(DATA_DIR, 'gov_contacts.json');
const OUT_CONTACTS = path.join(DATA_DIR, 'gov_contacts_all.csv');
const OUT_ORGS = path.join(DATA_DIR, 'gov_organizations_all.csv');

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function normalizeStr(value) {
  return (value ?? '').toString().trim();
}

function addOrg(orgMap, name, type, source) {
  const n = normalizeStr(name);
  if (!n) return;
  const key = `${type}::${n}`.toLowerCase();
  if (!orgMap.has(key)) {
    orgMap.set(key, {
      name: n,
      type,
      sources: new Set(source ? [source] : []),
      count: 1
    });
  } else {
    const item = orgMap.get(key);
    item.count += 1;
    if (source) item.sources.add(source);
  }
}

async function main() {
  if (!fs.existsSync(INPUT_JSON)) {
    console.error(`❌ Missing input file: ${INPUT_JSON}`);
    console.error('Run the scraper first: node scripts/scrape_bd_gov.js');
    process.exit(1);
  }

  const raw = await fsp.readFile(INPUT_JSON, 'utf8');
  const parsed = JSON.parse(raw);
  const contacts = Array.isArray(parsed) ? parsed : (parsed.contacts || []);

  // Contacts CSV
  const contactHeader = [
    'name',
    'designation',
    'ministry',
    'department',
    'office',
    'email',
    'phone',
    'source',
    'scrapedAt'
  ];

  const contactRows = [contactHeader.join(',')];
  for (const c of contacts) {
    const row = [
      normalizeStr(c.name || c.n),
      normalizeStr(c.designation || c.d),
      normalizeStr(c.ministry || c.m),
      normalizeStr(c.department),
      normalizeStr(c.office || c.office_name),
      normalizeStr(c.email || c.e),
      normalizeStr(c.phone || c.p || c.mobile),
      normalizeStr(c.source),
      normalizeStr(c.scrapedAt)
    ].map(csvEscape);

    // Only include rows that at least have a name
    if (row[0]) {
      contactRows.push(row.join(','));
    }
  }

  await fsp.writeFile(OUT_CONTACTS, contactRows.join('\n'), 'utf8');

  // Organizations/Offices/Ministries CSV
  const orgMap = new Map();
  for (const c of contacts) {
    const source = normalizeStr(c.source);
    addOrg(orgMap, c.ministry || c.m, 'MINISTRY', source);
    addOrg(orgMap, c.department, 'DEPARTMENT', source);
    addOrg(orgMap, c.office || c.office_name, 'OFFICE', source);
    // If your data ever includes explicit org fields
    addOrg(orgMap, c.organization || c.org, 'ORG', source);
  }

  const orgHeader = ['type', 'name', 'occurrences', 'sourceCount', 'sources'];
  const orgRows = [orgHeader.join(',')];

  const orgList = Array.from(orgMap.values())
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));

  for (const o of orgList) {
    const sources = Array.from(o.sources).filter(Boolean).sort();
    const row = [
      o.type,
      o.name,
      o.count,
      sources.length,
      sources.join(' | ')
    ].map(csvEscape);
    orgRows.push(row.join(','));
  }

  await fsp.writeFile(OUT_ORGS, orgRows.join('\n'), 'utf8');

  console.log(`✅ Wrote contacts CSV: ${OUT_CONTACTS}`);
  console.log(`✅ Wrote organizations CSV: ${OUT_ORGS}`);
  console.log(`   Contacts: ${contacts.length}`);
  console.log(`   Orgs: ${orgList.length}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('❌ CSV generation failed:', e);
    process.exit(1);
  });
}
