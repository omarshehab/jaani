/**
 * Import/merge Bangla RTI officers CSV sheet into backend/data/gov_contacts.json.
 *
 * This enriches existing contacts (adds phone/department/website/lastChecked)
 * and adds missing contacts if they don't already exist.
 *
 * Usage:
 *   node scripts/import_rti_sheet_csv.js --input "../RTI officers - Sheet3.csv"
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { parse } = require('csv-parse/sync');

const DATA_DIR = path.join(__dirname, '..', 'data');
const GOV_JSON = path.join(DATA_DIR, 'gov_contacts.json');

function normalize(v) {
  return (v ?? '').toString().replace(/\s+/g, ' ').trim();
}

function normalizeKey(v) {
  return normalize(v).toLowerCase();
}

function compactPhone(phone) {
  const p = normalize(phone);
  if (!p) return '';
  // Keep digits, +, hyphen, comma, space (Bangla digits are kept as-is)
  return p.replace(/[^0-9+\u09E6-\u09EF\- ,]/g, '').replace(/\s+/g, ' ').trim();
}

function compactEmail(email) {
  return normalize(email).replace(/\s+/g, '').replace(/,+$/g, '').trim();
}

function getArg(name) {
  const idx = process.argv.findIndex(a => a === name || a.startsWith(name + '='));
  if (idx === -1) return null;
  const arg = process.argv[idx];
  if (arg.includes('=')) return arg.split('=').slice(1).join('=');
  return process.argv[idx + 1] || null;
}

function upsertContact(contacts, incoming) {
  const emailKey = incoming.email ? normalizeKey(incoming.email) : '';
  const nameKey = incoming.name ? normalizeKey(incoming.name) : '';
  const ministryKey = incoming.ministry ? normalizeKey(incoming.ministry) : '';

  let existing = null;
  if (emailKey) {
    existing = contacts.find(c => normalizeKey(c.email) === emailKey);
  }
  if (!existing && nameKey && ministryKey) {
    existing = contacts.find(c => normalizeKey(c.name) === nameKey && normalizeKey(c.ministry) === ministryKey);
  }

  if (!existing) {
    contacts.push(incoming);
    return { action: 'added' };
  }

  // Enrich without overwriting existing good data
  for (const k of ['phone', 'department', 'website', 'lastChecked', 'designation']) {
    if (!existing[k] && incoming[k]) existing[k] = incoming[k];
  }

  // Preserve role if missing
  if (!existing.role && incoming.role) existing.role = incoming.role;

  // Merge sources
  if (incoming.source) {
    existing.sources = Array.isArray(existing.sources) ? existing.sources : (existing.source ? [existing.source] : []);
    if (!existing.sources.includes(incoming.source)) existing.sources.push(incoming.source);
  }

  return { action: 'updated' };
}

async function main() {
  const inputArg = getArg('--input');
  const inputPath = path.resolve(__dirname, inputArg || path.join(__dirname, '..', '..', 'RTI officers - Sheet3.csv'));

  if (!fs.existsSync(inputPath)) {
    console.error(`❌ Input CSV not found: ${inputPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(GOV_JSON)) {
    console.error(`❌ Missing gov contacts JSON: ${GOV_JSON}`);
    process.exit(1);
  }

  const csvRaw = await fsp.readFile(inputPath, 'utf8');
  const records = parse(csvRaw, {
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
    bom: true
  });

  if (!records || records.length < 2) {
    console.error('❌ CSV appears empty/unparseable');
    process.exit(1);
  }

  // First row is header (Bangla)
  const header = records[0];
  const rows = records.slice(1);

  const govRaw = await fsp.readFile(GOV_JSON, 'utf8');
  const govParsed = JSON.parse(govRaw);
  const contacts = Array.isArray(govParsed) ? govParsed : (govParsed.contacts || []);

  let added = 0;
  let updated = 0;
  const sourceLabel = 'RTI officers - Sheet3.csv';
  const nowIso = new Date().toISOString();

  for (const r of rows) {
    // Expected columns (some are blank columns in the sheet):
    // 0 ministry, 1 dept, 2 designated name, 3 blank, 4 designated mobile, 5 designated email,
    // 6 alternate name, 7 blank, 8 alternate designation, 9 alt mobile, 10 alt email, 11 website, 12 last checked
    const ministry = normalize(r[0]);
    const department = normalize(r[1]);

    const desigName = normalize(r[2]);
    const desigPhone = compactPhone(r[4]);
    const desigEmail = compactEmail(r[5]);

    const altName = normalize(r[6]);
    const altDesignation = normalize(r[8]);
    const altPhone = compactPhone(r[9]);
    const altEmail = compactEmail(r[10]);

    const website = normalize(r[11]);
    const lastChecked = normalize(r[12]);

    // Skip row if it has no ministry and no officer
    if (!ministry && !desigName && !altName) continue;

    if (desigName) {
      const incoming = {
        name: desigName,
        designation: '',
        ministry: ministry,
        department: department,
        phone: desigPhone,
        email: desigEmail,
        website: website,
        lastChecked: lastChecked,
        role: 'designated',
        source: sourceLabel,
        scrapedAt: nowIso
      };
      const result = upsertContact(contacts, incoming);
      if (result.action === 'added') added++;
      if (result.action === 'updated') updated++;
    }

    if (altName) {
      const incoming = {
        name: altName,
        designation: altDesignation,
        ministry: ministry,
        department: department,
        phone: altPhone,
        email: altEmail,
        website: website,
        lastChecked: lastChecked,
        role: 'alternate',
        source: sourceLabel,
        scrapedAt: nowIso
      };
      const result = upsertContact(contacts, incoming);
      if (result.action === 'added') added++;
      if (result.action === 'updated') updated++;
    }
  }

  const out = Array.isArray(govParsed)
    ? contacts
    : {
        ...govParsed,
        metadata: {
          ...(govParsed.metadata || {}),
          updatedAt: nowIso,
          totalContacts: contacts.length,
          sources: Array.from(new Set([...(govParsed.metadata?.sources || []), sourceLabel]))
        },
        contacts
      };

  await fsp.writeFile(GOV_JSON, JSON.stringify(out, null, 2), 'utf8');

  console.log(`✅ Imported RTI sheet: ${path.basename(inputPath)}`);
  console.log(`   Updated gov contacts: +${added} added, ${updated} enriched`);
  console.log(`   Total contacts now: ${contacts.length}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('❌ Import failed:', e);
    process.exit(1);
  });
}
