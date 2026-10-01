const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const textIntegrity = require('../utils/textIntegrity');

// Cache for loaded contacts
let contactsCache = null;
let lastLoadTime = null;
let lastCsvSignature = null;
let singletonInitialized = false;
const PRIMARY_DATASET_PATH = path.resolve(__dirname, '..', '..', 'JAANI_RTI_OFFICERS_COMPLETE.csv');
// JAANI_RTI_OFFICERS_COMPLETE.csv is the ONLY officer/contact dataset: it is read from and written
// to here, and nothing else (no fallback CSVs, no mirror copy, no scraped-JSON merge) feeds contacts.
const CSV_CANDIDATES = [PRIMARY_DATASET_PATH];
const CSV_TARGET_CANDIDATES = [PRIMARY_DATASET_PATH];

function normalizeCsvHeaderName(value) {
  return (value || '')
    .toString()
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u0980-\u09ff]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function escapeCsvCell(value) {
  const raw = value == null ? '' : String(value);
  if (!/[",\n\r]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

function normalizeMatchToken(value) {
  return (value || '')
    .toString()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b\u200c\u200d]/g, '')
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePhoneToken(value) {
  return (value || '').toString().replace(/[^0-9+]/g, '').trim();
}

function normalizeEmailToken(value) {
  return normalizeMatchToken(value).replace(/\s+/g, '');
}

function safeDateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function getContactValue(contact = {}, keys = []) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(contact, key) && hasText(contact[key])) {
      return contact[key].toString().trim();
    }
  }
  return '';
}

function normalizeContactForCsv(contact = {}) {
  const ministry = getContactValue(contact, ['Ministry', 'ministry']);
  const division = getContactValue(contact, ['Division', 'division']);
  const department = getContactValue(contact, ['Department', 'department']);
  const officeLabel = getContactValue(contact, ['Office', 'office']);
  const officeName = getContactValue(contact, ['office_name', 'Office_Name', 'office']);

  return {
    ministry,
    division,
    department,
    office: officeLabel || officeName || department,

    primaryOfficer: getContactValue(contact, ['Primary_Officer', 'Primary_Officer_Name', 'duty_officer', 'name', 'Duty Officer']),
    primaryDesignation: getContactValue(contact, ['Primary_Designation', 'designation', 'Designation']),
    primaryPhone: getContactValue(contact, ['Primary_Phone']),
    // 'phone'/'email' are OFFICE-level fields (filled as primary's "|| alternate's" on load). They must not be a
    // Primary_* source on write-back, or an office with no primary officer gets the alternate's contact details
    // persisted into Primary_Mobile/Primary_Email.
    primaryMobile: getContactValue(contact, ['Primary_Mobile', 'duty_officer_mobile', 'Mobile', 'Duty Officer Mobile']),
    primaryEmail: getContactValue(contact, ['Primary_Email', 'duty_officer_email', 'E-mail', 'Duty Officer E-mail']),
    primaryAddress: getContactValue(contact, ['Primary_Address']),
    primaryImage: getContactValue(contact, ['Primary_Image_URL', 'Primary_Photo']),

    alternateOfficer: getContactValue(contact, ['Alternate_Officer', 'Alternate_Officer_Name', 'alternate_duty_officer', 'Alternate Duty Officer']),
    alternateDesignation: getContactValue(contact, ['Alternate_Designation', 'alternate_designation', 'Alternate Designation']),
    alternatePhone: getContactValue(contact, ['Alternate_Phone']),
    alternateMobile: getContactValue(contact, ['Alternate_Mobile', 'alternate_mobile', 'Alternate Mobile']),
    alternateEmail: getContactValue(contact, ['Alternate_Email', 'alternate_email', 'Alternate_E-mail', 'Alternate E-mail']),
    alternateAddress: getContactValue(contact, ['Alternate_Address']),
    alternateImage: getContactValue(contact, ['Alternate_Image_URL', 'Alternate_Photo']),

    appellateOfficer: getContactValue(contact, ['Appellate_Officer', 'Appellate_Name', 'Appellate_Officer_Name']),
    appellateDesignation: getContactValue(contact, ['Appellate_Designation']),
    appellatePhone: getContactValue(contact, ['Appellate_Phone']),
    appellateMobile: getContactValue(contact, ['Appellate_Mobile']),
    appellateEmail: getContactValue(contact, ['Appellate_Email']),
    appellateAddress: getContactValue(contact, ['Appellate_Address']),
    appellateImage: getContactValue(contact, ['Appellate_Image_URL', 'Appellate_Photo']),

    websiteLink: getContactValue(contact, ['Website_Link', 'website_link', 'Website Link']),
    officeName,
    updatedAt: getContactValue(contact, ['Last_Updated', 'last_updated', 'Last time checked', 'last_time_checked']) || safeDateStamp(),
  };
}

function resolveExistingTargetCsvPath() {
  for (const candidate of CSV_TARGET_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return PRIMARY_DATASET_PATH;
}

function getRowValueByNormalizedHeader(row = {}, normalizedKeys = []) {
  if (!row || typeof row !== 'object') return '';
  const wanted = new Set((normalizedKeys || []).map((k) => normalizeCsvHeaderName(k)).filter(Boolean));
  if (wanted.size === 0) return '';

  for (const [k, v] of Object.entries(row)) {
    if (wanted.has(normalizeCsvHeaderName(k)) && hasText(v)) return String(v).trim();
  }
  return '';
}

function resolveHeaderKey(headerLookup = new Map(), normalizedCandidates = []) {
  for (const candidate of normalizedCandidates) {
    const normalized = normalizeCsvHeaderName(candidate);
    if (normalized && headerLookup.has(normalized)) return headerLookup.get(normalized);
  }
  return '';
}

function extractRowMatchSignals(row = {}) {
  const ministry = getRowValueByNormalizedHeader(row, ['ministry']);
  const division = getRowValueByNormalizedHeader(row, ['division']);
  const department = getRowValueByNormalizedHeader(row, ['department']);
  const office = getRowValueByNormalizedHeader(row, ['office', 'office_name']);
  const website = getRowValueByNormalizedHeader(row, ['website_link', 'website link']);

  const primaryEmail = getRowValueByNormalizedHeader(row, ['primary_email', 'duty_officer_e_mail', 'duty_officer_email', 'email', 'e_mail']);
  const alternateEmail = getRowValueByNormalizedHeader(row, ['alternate_email', 'alternate_e_mail']);
  const appellateEmail = getRowValueByNormalizedHeader(row, ['appellate_email']);

  const primaryMobile = getRowValueByNormalizedHeader(row, ['primary_mobile', 'mobile', 'duty_officer_mobile']);
  const alternateMobile = getRowValueByNormalizedHeader(row, ['alternate_mobile']);
  const appellateMobile = getRowValueByNormalizedHeader(row, ['appellate_mobile']);

  const primaryOfficer = getRowValueByNormalizedHeader(row, ['primary_officer', 'primary_officer_name', 'duty_officer']);
  const alternateOfficer = getRowValueByNormalizedHeader(row, ['alternate_officer', 'alternate_officer_name', 'alternate_duty_officer']);
  const appellateOfficer = getRowValueByNormalizedHeader(row, ['appellate_officer', 'appellate_name', 'appellate_officer_name']);

  return {
    office: normalizeMatchToken([office, ministry, department, division].filter(Boolean).join(' - ')),
    website: normalizeMatchToken(website),
    emails: [primaryEmail, alternateEmail, appellateEmail].map(normalizeEmailToken).filter(Boolean),
    mobiles: [primaryMobile, alternateMobile, appellateMobile].map(normalizePhoneToken).filter(Boolean),
    names: [primaryOfficer, alternateOfficer, appellateOfficer].map(normalizeMatchToken).filter(Boolean),
  };
}

function scoreCsvRowMatch(row = {}, update = {}, options = {}) {
  const signals = extractRowMatchSignals(row);

  const officeWanted = normalizeMatchToken(update.officeName || update.office || update.department || update.ministry || options.requestedOffice || '');
  const websiteWanted = normalizeMatchToken(update.websiteLink || options.websiteLink || '');
  const identifierWantedRaw = (options.originalIdentifier || '').toString().trim();
  const identifierWanted = normalizeMatchToken(identifierWantedRaw);
  const identifierPhone = normalizePhoneToken(identifierWantedRaw);
  const identifierEmail = normalizeEmailToken(identifierWantedRaw);

  const emailWanted = [update.primaryEmail, update.alternateEmail, update.appellateEmail]
    .map(normalizeEmailToken)
    .filter(Boolean);
  const mobileWanted = [update.primaryMobile, update.alternateMobile, update.appellateMobile]
    .map(normalizePhoneToken)
    .filter(Boolean);
  const nameWanted = [update.primaryOfficer, update.alternateOfficer, update.appellateOfficer]
    .map(normalizeMatchToken)
    .filter(Boolean);

  let score = 0;

  if (identifierEmail && signals.emails.includes(identifierEmail)) score += 260;
  if (identifierPhone && signals.mobiles.includes(identifierPhone)) score += 240;
  if (identifierWanted && signals.office.includes(identifierWanted)) score += 140;

  if (websiteWanted) {
    if (signals.website === websiteWanted) {
      score += 260;
    } else if (signals.website && websiteWanted && signals.website.includes(websiteWanted)) {
      score += 180;
    } else {
      try {
        const rowHost = new URL(signals.website).hostname;
        const wantedHost = new URL(websiteWanted).hostname;
        if (rowHost && wantedHost && rowHost === wantedHost) score += 150;
      } catch {
        // ignore URL parse failures
      }
    }
  }

  if (officeWanted) {
    if (signals.office === officeWanted) {
      score += 220;
    } else if (signals.office.includes(officeWanted) || officeWanted.includes(signals.office)) {
      score += 140;
    }
  }

  for (const email of emailWanted) {
    if (signals.emails.includes(email)) {
      score += 210;
      break;
    }
  }

  for (const mobile of mobileWanted) {
    if (signals.mobiles.includes(mobile)) {
      score += 180;
      break;
    }
  }

  for (const name of nameWanted) {
    if (signals.names.includes(name)) {
      score += 120;
      break;
    }
    if (signals.names.some((existing) => existing.includes(name) || name.includes(existing))) {
      score += 75;
      break;
    }
  }

  return score;
}

function applyContactUpdateToCsvRow(row = {}, headerLookup = new Map(), normalizedUpdate = {}, options = {}) {
  const mode = (options.mode || 'manual').toString().toLowerCase();
  const onlyFillMissing = mode === 'auto-reconcile' || mode === 'reconcile';
  const changes = [];

  // Ministry/Division/Office identify the row; the automatic path never edits them (only the owner's manual Save may).
  const assignmentRules = [
    ...(onlyFillMissing ? [] : [
      { value: normalizedUpdate.ministry, headers: ['ministry'] },
      { value: normalizedUpdate.division, headers: ['division'] },
      { value: normalizedUpdate.department, headers: ['department'] },
      { value: normalizedUpdate.office, headers: ['office', 'office_name'] },
    ]),

    { value: normalizedUpdate.primaryOfficer, headers: ['primary_officer_name', 'primary_officer', 'duty_officer'] },
    { value: normalizedUpdate.primaryDesignation, headers: ['primary_designation', 'designation'] },
    { value: normalizedUpdate.primaryPhone, headers: ['primary_phone'] },
    { value: normalizedUpdate.primaryMobile, headers: ['primary_mobile', 'mobile', 'duty_officer_mobile'] },
    { value: normalizedUpdate.primaryEmail, headers: ['primary_email', 'duty_officer_e_mail', 'duty_officer_email', 'email', 'e_mail'] },
    { value: normalizedUpdate.primaryAddress, headers: ['primary_address', 'address'] },
    { value: normalizedUpdate.primaryImage, headers: ['primary_image_url', 'primary_photo'] },

    { value: normalizedUpdate.alternateOfficer, headers: ['alternate_officer_name', 'alternate_officer', 'alternate_duty_officer'] },
    { value: normalizedUpdate.alternateDesignation, headers: ['alternate_designation'] },
    { value: normalizedUpdate.alternatePhone, headers: ['alternate_phone'] },
    { value: normalizedUpdate.alternateMobile, headers: ['alternate_mobile'] },
    { value: normalizedUpdate.alternateEmail, headers: ['alternate_email', 'alternate_e_mail'] },
    { value: normalizedUpdate.alternateAddress, headers: ['alternate_address'] },
    { value: normalizedUpdate.alternateImage, headers: ['alternate_image_url', 'alternate_photo'] },

    { value: normalizedUpdate.appellateOfficer, headers: ['appellate_officer_name', 'appellate_officer', 'appellate_name'] },
    { value: normalizedUpdate.appellateDesignation, headers: ['appellate_designation'] },
    { value: normalizedUpdate.appellatePhone, headers: ['appellate_phone'] },
    { value: normalizedUpdate.appellateMobile, headers: ['appellate_mobile'] },
    { value: normalizedUpdate.appellateEmail, headers: ['appellate_email'] },
    { value: normalizedUpdate.appellateAddress, headers: ['appellate_address'] },
    { value: normalizedUpdate.appellateImage, headers: ['appellate_image_url', 'appellate_photo'] },

    { value: normalizedUpdate.websiteLink, headers: ['website_link', 'website link'] },
  ];

  for (const rule of assignmentRules) {
    const headerKey = resolveHeaderKey(headerLookup, rule.headers);
    if (!headerKey) continue;
    if (!hasText(rule.value)) continue;

    const current = hasText(row[headerKey]) ? String(row[headerKey]).trim() : '';
    const next = String(rule.value).trim();
    if (!next) continue;
    // Image columns hold the photo's source URL; the app's local cached copy (/shared/...) is never written there.
    if (/(_image_url|_photo)$/i.test(headerKey) && !/^https?:\/\//i.test(next)) continue;

    // Text integrity gate (rule R11): legacy-font (Bijoy) or broken text never reaches the CSV on the automatic
    // path; when the owner types it in manual mode it is stored, but the caller gets a visible warning.
    if (!/(_image_url|_photo|website_link|website link)$/i.test(headerKey) && !textIntegrity.isStorable(next)) {
      if (Array.isArray(options.integrityWarnings)) {
        options.integrityWarnings.push({ field: headerKey, class: textIntegrity.classifyText(next), value: next.slice(0, 120), stored: !onlyFillMissing });
      }
      if (onlyFillMissing) {
        console.warn(`⚠️ [CSV] ${headerKey} refused by the text integrity gate (${textIntegrity.classifyText(next)})`);
        continue;
      }
    }

    if (onlyFillMissing) {
      if (!current || current !== next) {
        row[headerKey] = next;
        changes.push(headerKey);
      }
      continue;
    }

    if (current !== next) {
      row[headerKey] = next;
      changes.push(headerKey);
    }
  }

  // The row changed now, so it is stamped with today's date; an incoming Last_Updated (the UI sends the whole record
  // back on Save) is the old date and must not be written again (brief 15.4).
  const updateDate = safeDateStamp();
  const lastUpdatedHeader = resolveHeaderKey(headerLookup, ['last_updated', 'last_time_checked', 'last time checked']);
  if (lastUpdatedHeader && changes.length > 0) {
    row[lastUpdatedHeader] = updateDate;
    if (!changes.includes(lastUpdatedHeader)) changes.push(lastUpdatedHeader);
  }

  return changes;
}

function upsertContactInCsv(contact = {}, options = {}) {
  const csvPath = resolveExistingTargetCsvPath();
  if (!csvPath || !fs.existsSync(csvPath)) {
    return {
      success: false,
      path: csvPath || '',
      updated: false,
      inserted: false,
      reason: 'csv_not_found',
    };
  }

  try {
    const csvContent = fs.readFileSync(csvPath, 'utf8');
    const headerRows = parse(csvContent, {
      bom: false,
      to_line: 1,
      relax_column_count: true,
      skip_empty_lines: false,
    });
    const rawHeaders = Array.isArray(headerRows[0]) ? headerRows[0].map((h) => (h == null ? '' : String(h))) : [];
    if (rawHeaders.length === 0) {
      return {
        success: false,
        path: csvPath,
        updated: false,
        inserted: false,
        reason: 'csv_header_missing',
      };
    }

    const recordHeaders = rawHeaders.map((h) => h.replace(/^\uFEFF/, ''));
    const rows = parse(csvContent, {
      columns: recordHeaders,
      from_line: 2,
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    });

    const normalizedUpdate = normalizeContactForCsv(contact || {});
    const integrityWarnings = [];
    options = { ...options, integrityWarnings };
    const headerLookup = new Map();
    for (const key of recordHeaders) {
      const normalized = normalizeCsvHeaderName(key);
      if (normalized && !headerLookup.has(normalized)) headerLookup.set(normalized, key);
    }

    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const score = scoreCsvRowMatch(rows[i], normalizedUpdate, {
        originalIdentifier: options.originalIdentifier || '',
        requestedOffice: options.requestedOffice || '',
        websiteLink: normalizedUpdate.websiteLink,
      });

      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    // Row identity first: when the update names an Office that is exactly one row's Office, that row is the target.
    // Shared officers (the same mobile/e-mail/name on a ministry and a division page) must never make one body's
    // update land on, and rename, another body's row (brief 15.5; the app's office_name is "Ministry - Office").
    const officeHeader = resolveHeaderKey(headerLookup, ['office', 'office_name']);
    const officeWantedExact = normalizeMatchToken(normalizedUpdate.office || '');
    if (officeHeader && officeWantedExact) {
      const identity = [];
      rows.forEach((r, i) => { if (normalizeMatchToken(r[officeHeader] || '') === officeWantedExact) identity.push(i); });
      if (identity.length === 1) {
        bestIndex = identity[0];
        bestScore = Math.max(bestScore, scoreCsvRowMatch(rows[bestIndex], normalizedUpdate, {
          originalIdentifier: options.originalIdentifier || '',
          requestedOffice: options.requestedOffice || '',
          websiteLink: normalizedUpdate.websiteLink,
        }), Number.isFinite(options.minMatchScore) ? options.minMatchScore : 140);
      }
    }

    const minMatchScore = Number.isFinite(options.minMatchScore)
      ? options.minMatchScore
      : 140;

    let inserted = false;
    let updated = false;
    let changedFields = [];

    if (bestIndex >= 0 && bestScore >= minMatchScore) {
      changedFields = applyContactUpdateToCsvRow(rows[bestIndex], headerLookup, normalizedUpdate, options);
      updated = changedFields.length > 0;
    } else if (options.allowInsert !== false) {
      const minimumIdentity = hasText(normalizedUpdate.office) || hasText(normalizedUpdate.officeName)
        || hasText(normalizedUpdate.websiteLink) || hasText(normalizedUpdate.primaryOfficer)
        || hasText(normalizedUpdate.primaryEmail) || hasText(normalizedUpdate.primaryMobile);

      if (minimumIdentity) {
        const newRow = {};
        for (const key of recordHeaders) newRow[key] = '';
        changedFields = applyContactUpdateToCsvRow(newRow, headerLookup, normalizedUpdate, {
          ...options,
          mode: 'manual',
        });
        rows.push(newRow);
        inserted = changedFields.length > 0;
        updated = inserted;
      }
    }

    if (!updated && !inserted) {
      return {
        success: true,
        path: csvPath,
        updated: false,
        inserted: false,
        rowIndex: bestIndex,
        score: bestScore,
        changedFields: [],
        integrity_warnings: integrityWarnings,
      };
    }

    const headerLine = rawHeaders.map(escapeCsvCell).join(',');
    const dataLines = rows.map((row) => recordHeaders.map((key) => escapeCsvCell(row[key] || '')).join(','));
    const output = [headerLine, ...dataLines].join('\n');

    fs.writeFileSync(csvPath, output, 'utf8');

    const syncedTargets = [];
    const writeTargets = [PRIMARY_DATASET_PATH].filter((targetPath) => targetPath && targetPath !== csvPath);

    for (const targetPath of writeTargets) {
      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, output, 'utf8');
        syncedTargets.push(targetPath);
      } catch (syncErr) {
        console.warn(`⚠️ Failed to sync officers CSV to ${targetPath}: ${syncErr.message}`);
      }
    }

    // invalidate and refresh cache
    contactsCache = null;
    lastLoadTime = null;
    lastCsvSignature = null;
    singletonInitialized = false;
    initializeContactsSingleton({ forceReload: true });

    return {
      success: true,
      path: csvPath,
      syncedTargets,
      updated,
      inserted,
      rowIndex: bestIndex,
      score: bestScore,
      changedFields,
      totalRows: rows.length,
      integrity_warnings: integrityWarnings,
    };
  } catch (error) {
    return {
      success: false,
      path: csvPath,
      updated: false,
      inserted: false,
      reason: error.message || 'csv_upsert_failed',
      error,
    };
  }
}

function hasText(value) {
  return value != null && value.toString().trim().length > 0;
}

function pickRowValue(row, keys = []) {
  for (const key of keys) {
    if (!key) continue;
    const value = row[key];
    if (hasText(value)) return value.toString().trim();
  }

  if (keys.length > 0) {
    const normalizedWanted = keys
      .map((k) => (k || '').toString().replace(/^\uFEFF/, '').trim().toLowerCase())
      .filter(Boolean);
    if (normalizedWanted.length > 0) {
      for (const [rawKey, rawValue] of Object.entries(row || {})) {
        const normalizedKey = (rawKey || '').toString().replace(/^\uFEFF/, '').trim().toLowerCase();
        if (normalizedWanted.includes(normalizedKey) && hasText(rawValue)) {
          return rawValue.toString().trim();
        }
      }
    }
  }

  return '';
}

function normalizeIdentityValue(value) {
  return (value || '').toString().trim().toLowerCase();
}

function buildContactIdentity(contact = {}) {
  const office = normalizeIdentityValue(contact.office_name || contact.Office || '');
  const website = normalizeIdentityValue(contact.website_link || contact.Website_Link || contact['Website Link'] || '');
  const email = normalizeIdentityValue(contact.email || contact.Primary_Email || contact.Alternate_Email || '');
  const name = normalizeIdentityValue(contact.name || contact.duty_officer || contact.Primary_Officer || contact['Duty Officer'] || '');

  if (office) return `office:${office}`;
  if (website) return `website:${website}`;
  if (email) return `email:${email}`;
  if (name) return `name:${name}`;
  return '';
}

function mergeContactRecords(base = {}, incoming = {}) {
  const merged = { ...base };

  for (const [key, value] of Object.entries(incoming)) {
    if (Array.isArray(value)) {
      const current = Array.isArray(merged[key]) ? merged[key] : [];
      const combined = Array.from(new Set([...current, ...value].filter((item) => hasText(item))));
      if (combined.length > 0) merged[key] = combined;
      continue;
    }

    if (!hasText(merged[key]) && hasText(value)) {
      merged[key] = value;
    }
  }

  return merged;
}

function getCsvSourcePath() {
  for (const candidate of CSV_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Loads contacts from JAANI_RTI_OFFICERS_COMPLETE.csv (the only dataset), de-duplicated,
 * cached until the file changes.
 */
function loadAllContacts(options = {}) {
  const forceReload = Boolean(options?.forceReload);

  if (contactsCache && !forceReload) {
    return contactsCache;
  }

  // Check CSV signature (mtime/size) to invalidate cache when the source changes
  const rtiCsvPath = getCsvSourcePath();
  let currentCsvSignature = null;
  try {
    if (rtiCsvPath && fs.existsSync(rtiCsvPath)) {
      const stat = fs.statSync(rtiCsvPath);
      currentCsvSignature = `${rtiCsvPath}:${stat.mtimeMs}:${stat.size}`;
    }
  } catch {
    currentCsvSignature = null;
  }

  const cacheSignature = `${currentCsvSignature || 'no-csv'}`;

  console.log('🔄 Loading contacts...');
  const startTime = Date.now();
  
  let allContacts = [];

  // Load RTI officers CSV (Bangla) from workspace root
  try {
    if (rtiCsvPath && fs.existsSync(rtiCsvPath)) {
      const csvContent = fs.readFileSync(rtiCsvPath, 'utf8');
      const headerLine = csvContent.split(/\r?\n/)[0] || '';
      const normalizedHeaderLine = headerLine.replace(/^\uFEFF/, '');
      const usesPrimarySchema = /(Primary_Officer|Primary_Officer_Name|Primary_Designation|Primary_Image_URL|Appellate_Officer_Name)/i
        .test(normalizedHeaderLine);

      const records = usesPrimarySchema
        ? parse(csvContent, {
            columns: true,
            bom: true,
            skip_empty_lines: true,
            relax_column_count: true,
            trim: true,
          })
        : parse(csvContent, {
            columns: [
              'Ministry',
              'Department',
              'Duty Officer',
              '_unused1',
              'Duty Officer Mobile',
              'Duty Officer E-mail',
              'Alternate Duty Officer',
              '_unused2',
              'Alternate Designation',
              'Alternate Mobile',
              'Alternate E-mail',
              'Website Link',
              'Last time checked',
            ],
            from_line: 2,
            bom: true,
            skip_empty_lines: true,
            relax_column_count: true,
            trim: true,
          });

      const csvContacts = records.map((row) => {
        if (usesPrimarySchema) {
          const ministry = pickRowValue(row, ['Ministry', '\ufeffMinistry']);
          const division = pickRowValue(row, ['Division']);
          const officeLabel = pickRowValue(row, ['Office']);
          const department = pickRowValue(row, ['Department', 'Office']) || division;
          const primaryOfficer = pickRowValue(row, ['Primary_Officer', 'Primary_Officer_Name', 'Duty Officer']);
          const primaryDesignation = pickRowValue(row, ['Primary_Designation']);
          const primaryPhone = pickRowValue(row, ['Primary_Phone']);
          const primaryMobile = pickRowValue(row, ['Primary_Mobile', 'Duty Officer Mobile']);
          const primaryEmail = pickRowValue(row, ['Primary_Email', 'Duty Officer E-mail', 'Duty Officer Email']);
          const primaryAddress = pickRowValue(row, ['Primary_Address']);
          const alternateOfficer = pickRowValue(row, ['Alternate_Officer', 'Alternate_Officer_Name', 'Alternate Duty Officer']);
          const alternateDesignation = pickRowValue(row, ['Alternate_Designation', 'Alternate Designation']);
          const alternatePhone = pickRowValue(row, ['Alternate_Phone']);
          const alternateMobile = pickRowValue(row, ['Alternate_Mobile', 'Alternate Mobile']);
          const alternateEmail = pickRowValue(row, ['Alternate_Email', 'Alternate E-mail', 'Alternate Email']);
          const alternateAddress = pickRowValue(row, ['Alternate_Address']);
          const websiteLink = pickRowValue(row, ['Website_Link', 'Website Link']);

          const primaryPhoto = pickRowValue(row, ['Primary_Photo', 'Primary_Image_URL']);
          const alternatePhoto = pickRowValue(row, ['Alternate_Photo', 'Alternate_Image_URL']);

          const appellateName = pickRowValue(row, ['Appellate_Name', 'Appellate_Officer', 'Appellate_Officer_Name']);
          const appellateDesignation = pickRowValue(row, ['Appellate_Designation']);
          const appellatePhone = pickRowValue(row, ['Appellate_Phone']);
          const appellateMobile = pickRowValue(row, ['Appellate_Mobile']);
          const appellateEmail = pickRowValue(row, ['Appellate_Email']);
          const appellateAddress = pickRowValue(row, ['Appellate_Address']);
          const appellatePhoto = pickRowValue(row, ['Appellate_Photo', 'Appellate_Image_URL']);

          if (!ministry && !department && !primaryOfficer && !websiteLink) {
            return null;
          }

          const officeParts = [ministry, department].filter((part, idx, list) => part && list.indexOf(part) === idx);
          const officeName = officeParts.join(' - ');

          return {
            ministry,
            department,
            name: primaryOfficer,
            duty_officer: primaryOfficer,
            Primary_Officer: primaryOfficer,
            Primary_Officer_Name: primaryOfficer,
            Primary_Designation: primaryDesignation,
            Primary_Phone: primaryPhone,
            duty_officer_mobile: primaryMobile,
            Primary_Mobile: primaryMobile,
            duty_officer_email: primaryEmail,
            Primary_Email: primaryEmail,
            Primary_Address: primaryAddress,
            alternate_duty_officer: alternateOfficer,
            Alternate_Officer: alternateOfficer,
            Alternate_Officer_Name: alternateOfficer,
            alternate_designation: alternateDesignation,
            Alternate_Designation: alternateDesignation,
            Alternate_Phone: alternatePhone,
            alternate_mobile: alternateMobile,
            Alternate_Mobile: alternateMobile,
            alternate_email: alternateEmail,
            Alternate_Email: alternateEmail,
            Alternate_Address: alternateAddress,
            office_name: officeName || ministry || department || officeLabel || division,
            email: primaryEmail || alternateEmail,
            phone: primaryMobile || alternateMobile || primaryPhone || alternatePhone,
            website_link: websiteLink,
            Website_Link: websiteLink,
            Primary_Photo: primaryPhoto,
            Alternate_Photo: alternatePhoto,
            Appellate_Officer: appellateName,
            Appellate_Name: appellateName,
            Appellate_Officer_Name: appellateName,
            Appellate_Designation: appellateDesignation,
            Appellate_Phone: appellatePhone,
            Appellate_Mobile: appellateMobile,
            Appellate_Email: appellateEmail,
            Appellate_Address: appellateAddress,
            Appellate_Photo: appellatePhoto,
            Ministry: ministry,
            Department: department,
            Division: division,
            Office: officeLabel,
            source: path.basename(rtiCsvPath),
          };
        }

        let ministry = pickRowValue(row, ['Ministry', '\ufeffMinistry']);
        let department = row['Department'] || '';
        const dutyOfficer = row['Duty Officer'] || '';
        const dutyMobile = row['Duty Officer Mobile'] || '';
        const dutyEmail = row['Duty Officer E-mail'] || '';
        const alternateOfficer = row['Alternate Duty Officer'] || '';
        const alternateDesignation = row['Alternate Designation'] || '';
        const alternateMobile = row['Alternate Mobile'] || '';
        const alternateEmail = row['Alternate E-mail'] || '';
        const websiteLink = row['Website Link'] || '';
        const lastChecked = row['Last time checked'] || '';

        if (!ministry && !department && !dutyOfficer && !websiteLink) {
          return null;
        }

        if (!ministry && department && /মন্ত্রণালয়|মন্ত্রণালয়/.test(department)) {
          ministry = department;
          department = '';
        }

        const officeName = [ministry, department].filter(Boolean).join(' - ');

        return {
          ministry,
          department,
          name: dutyOfficer,
          duty_officer: dutyOfficer,
          duty_officer_mobile: dutyMobile,
          duty_officer_email: dutyEmail,
          alternate_duty_officer: alternateOfficer,
          alternate_designation: alternateDesignation,
          alternate_mobile: alternateMobile,
          alternate_email: alternateEmail,
          office_name: officeName || ministry || department,
          email: dutyEmail || alternateEmail,
          phone: dutyMobile || alternateMobile,
          website_link: websiteLink,
          'Website Link': websiteLink,
          last_time_checked: lastChecked,
          'Last time checked': lastChecked,
          source: path.basename(rtiCsvPath),
        };
      }).filter(Boolean);

      allContacts = csvContacts;
      lastCsvSignature = cacheSignature;
      console.log(`📄 Loaded ${csvContacts.length} contacts from ${path.basename(rtiCsvPath)} (CSV is authoritative)`);
    }
  } catch (err) {
    console.error('❌ Error loading RTI officers CSV:', err.message);
  }

  // Merge duplicates by office/website/email so fragmented rows become complete records.
  const uniqueContacts = [];
  const seen = new Map();

  allContacts.forEach((contact) => {
    const key = buildContactIdentity(contact);
    if (!key) return;

    const existingIndex = seen.get(key);
    if (existingIndex === undefined) {
      seen.set(key, uniqueContacts.length);
      uniqueContacts.push({ ...contact });
      return;
    }

    uniqueContacts[existingIndex] = mergeContactRecords(uniqueContacts[existingIndex], contact);
  });

  const loadTime = Date.now() - startTime;
  console.log(`✅ Loaded ${uniqueContacts.length} unique contacts in ${loadTime}ms`);
  
  // Update cache
  contactsCache = uniqueContacts;
  lastLoadTime = Date.now();
  singletonInitialized = true;
  
  return uniqueContacts;
}

function initializeContactsSingleton(options = {}) {
  return loadAllContacts({ forceReload: Boolean(options?.forceReload) });
}

function getContacts() {
  if (!contactsCache) {
    console.warn('⚠️ Contacts requested before startup preload; loading synchronously.');
    initializeContactsSingleton();
  }
  return contactsCache || [];
}

module.exports = {
  PRIMARY_DATASET_PATH,
  get contacts() { return getContacts(); },
  getContacts,
  initializeContactsSingleton,
  loadAllContacts,
  getCsvSourcePath,
  upsertContactInCsv,
  get singletonInitialized() { return singletonInitialized; },
};
