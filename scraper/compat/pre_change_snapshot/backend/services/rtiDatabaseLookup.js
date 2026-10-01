const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

// ===== Cache & Singleton =====
let databaseCache = null;
let indexCache = null;
let lastLoadTime = null;

// The one RTI officer dataset (JAANI_RTI_OFFICERS_COMPLETE.csv), shared with Section 3.
const { PRIMARY_DATASET_PATH: RTI_MAIN_CSV } = require('../data/contactLoader');
let loadedSignature = '';

function csvSignature() {
  try {
    const st = fs.statSync(RTI_MAIN_CSV);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

// ===== Safety Limits (Prevent Infinite Retries) =====
const MATCH_TIMEOUT_MS = 1000;  // 1 second timeout - fallback renders fast if stuck
const MAX_MATCH_ATTEMPTS = 50;
/**
 * Normalize text for matching: lowercase, remove extra spaces, handle Bengali characters
 * Matches the frontend's normalizeMatchToken pattern
 */
function normalizeMatchToken(value) {
  return (value || '')
    .toString()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b\u200c\u200d]/g, '') // Zero-width chars
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build whitespace-agnostic regex from entity name
 * Matches the frontend's buildWhitespaceAgnosticRegex pattern
 */
function buildWhitespaceAgnosticRegex(value) {
  if (!value) return null;
  const normalized = normalizeMatchToken(value);
  if (!normalized) return null;

  const parts = normalized.split(/\s+/);
  const escapedParts = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = escapedParts.join('[\\s\\u00A0]+');
  try {
    return new RegExp(pattern, 'gi');
  } catch {
    return null;
  }
}

/**
 * Similarity score between two normalized strings (0-100)
 * Used as fallback when regex matching succeeds but we need to rank results
 */
function calculateSimilarity(a, b) {
  const minLen = Math.min(a.length, b.length);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 100;

  let matches = 0;
  for (let i = 0; i < minLen; i++) {
    if (a[i] === b[i]) matches++;
  }
  return Math.round((matches / maxLen) * 100);
}

/**
 * Extract field value, handling multiple possible column names
 */
function getFieldValue(row, possibleKeys = []) {
  for (const key of possibleKeys) {
    if (row[key] && String(row[key]).trim()) {
      return String(row[key]).trim();
    }
  }
  return '';
}

/**
 * Load and parse the RTI officer dataset (JAANI_RTI_OFFICERS_COMPLETE.csv)
 */
function loadDatabase() {
  if (!fs.existsSync(RTI_MAIN_CSV)) {
    console.warn(`[RTI Lookup] Database file not found: ${RTI_MAIN_CSV}`);
    return [];
  }

  try {
    const csvContent = fs.readFileSync(RTI_MAIN_CSV, 'utf8');
    const rows = parse(csvContent, {
      columns: true,
      trim: true,
      skip_empty_lines: true,
      bom: true,
      relax_column_count: true,
    });

    const processed = rows.map((row, idx) => ({
      _rowIndex: idx,
      ministry: getFieldValue(row, ['Ministry', 'ministry', 'MINISTRY']),
      division: getFieldValue(row, ['Division', 'division', 'DIVISION']),
      office: getFieldValue(row, ['Office', 'office', 'OFFICE']),
      primaryOfficer: getFieldValue(row, ['Primary_Officer_Name', 'Primary_Officer', 'primary_officer_name']),
      primaryDesignation: getFieldValue(row, ['Primary_Designation', 'primary_designation']),
      primaryPhone: getFieldValue(row, ['Primary_Phone', 'primary_phone']),
      primaryMobile: getFieldValue(row, ['Primary_Mobile', 'primary_mobile']),
      primaryEmail: getFieldValue(row, ['Primary_Email', 'primary_email']),
      primaryAddress: getFieldValue(row, ['Primary_Address', 'primary_address']),
      primaryImageUrl: getFieldValue(row, ['Primary_Image_URL', 'Primary_Image', 'primary_image_url']),
      alternateOfficer: getFieldValue(row, ['Alternate_Officer_Name', 'Alternate_Officer', 'alternate_officer_name']),
      alternateDesignation: getFieldValue(row, ['Alternate_Designation', 'alternate_designation']),
      alternatePhone: getFieldValue(row, ['Alternate_Phone', 'alternate_phone']),
      alternateMobile: getFieldValue(row, ['Alternate_Mobile', 'alternate_mobile']),
      alternateEmail: getFieldValue(row, ['Alternate_Email', 'alternate_email']),
      alternateAddress: getFieldValue(row, ['Alternate_Address', 'alternate_address']),
      alternateImageUrl: getFieldValue(row, ['Alternate_Image_URL', 'Alternate_Image', 'alternate_image_url']),
      appellateOfficer: getFieldValue(row, ['Appellate_Officer_Name', 'Appellate_Officer', 'appellate_officer_name']),
      appellateDesignation: getFieldValue(row, ['Appellate_Designation', 'appellate_designation']),
      appellatePhone: getFieldValue(row, ['Appellate_Phone', 'appellate_phone']),
      appellateMobile: getFieldValue(row, ['Appellate_Mobile', 'appellate_mobile']),
      appellateEmail: getFieldValue(row, ['Appellate_Email', 'appellate_email']),
      appellateAddress: getFieldValue(row, ['Appellate_Address', 'appellate_address']),
      appellateImageUrl: getFieldValue(row, ['Appellate_Image_URL', 'Appellate_Image', 'appellate_image_url']),
      websiteLink: getFieldValue(row, ['Website_Link', 'website_link', 'Website']),
      lastUpdated: getFieldValue(row, ['Last_Updated', 'last_updated']),
    }));

    console.log(`[RTI Lookup] Loaded ${processed.length} database entries from ${path.basename(RTI_MAIN_CSV)}`);
    return processed;
  } catch (error) {
    console.error(`[RTI Lookup] Error loading database:`, error.message);
    return [];
  }
}

/**
 * Build optimized lookup indices for fast searching
 * Indices organized by ministry, division, office, and all officer names
 */
function buildIndices(data) {
  const indices = {
    byMinistry: new Map(),      // ministry name → [rows]
    byDivision: new Map(),      // division name → [rows]
    byOffice: new Map(),        // office name → [rows]
    byOfficerName: new Map(),   // officer name → [rows]
    byMinistryNorm: new Map(),  // normalized ministry → [rows]
    byDivisionNorm: new Map(),  // normalized division → [rows]
    byOfficeNorm: new Map(),    // normalized office → [rows]
    byOfficerNameNorm: new Map(),  // normalized officer name → [rows]
  };

  for (const row of data) {
    // Ministry indices
    if (row.ministry) {
      const key = row.ministry;
      const normKey = normalizeMatchToken(key);
      indices.byMinistry.set(key, (indices.byMinistry.get(key) || []).concat([row]));
      if (normKey) indices.byMinistryNorm.set(normKey, (indices.byMinistryNorm.get(normKey) || []).concat([row]));
    }

    // Division indices
    if (row.division) {
      const key = row.division;
      const normKey = normalizeMatchToken(key);
      indices.byDivision.set(key, (indices.byDivision.get(key) || []).concat([row]));
      if (normKey) indices.byDivisionNorm.set(normKey, (indices.byDivisionNorm.get(normKey) || []).concat([row]));
    }

    // Office indices
    if (row.office) {
      const key = row.office;
      const normKey = normalizeMatchToken(key);
      indices.byOffice.set(key, (indices.byOffice.get(key) || []).concat([row]));
      if (normKey) indices.byOfficeNorm.set(normKey, (indices.byOfficeNorm.get(normKey) || []).concat([row]));
    }

    // Officer name indices
    const officerNames = [row.primaryOfficer, row.alternateOfficer, row.appellateOfficer].filter(Boolean);
    for (const name of officerNames) {
      const key = name;
      const normKey = normalizeMatchToken(key);
      indices.byOfficerName.set(key, (indices.byOfficerName.get(key) || []).concat([row]));
      if (normKey) indices.byOfficerNameNorm.set(normKey, (indices.byOfficerNameNorm.get(normKey) || []).concat([row]));
    }
  }

  return indices;
}

/**
 * Get or refresh cached database
 */
function getDatabase(forceRefresh = false) {
  // Section 3 writes verified officer data back into the CSV, so reload when the file changes.
  const signature = csvSignature();
  if (databaseCache && indexCache && !forceRefresh && signature === loadedSignature) {
    return { data: databaseCache, indices: indexCache, signature };
  }

  const data = loadDatabase();
  const indices = buildIndices(data);

  databaseCache = data;
  indexCache = indices;
  lastLoadTime = Date.now();
  loadedSignature = signature;

  return { data, indices, signature };
}

/**
 * Match a single entity against database
 * Returns best matching row(s) with confidence scores
 * With timeout & attempt limits to prevent infinite loops
 */
function matchEntity(entityName, entityType = 'ORG') {
  if (!entityName || !entityName.trim()) {
    return { matched: false, candidates: [], entityName };
  }

  const startTime = Date.now();
  const deadline = startTime + MATCH_TIMEOUT_MS;
  let attemptCount = 0;
  let warnedTimeout = false;
  let warnedAttempts = false;

  const { data, indices } = getDatabase();
  const normalized = normalizeMatchToken(entityName);
  const regex = buildWhitespaceAgnosticRegex(entityName);
  const candidates = [];

  // Normalize entity type for Bengali context
  let type = (entityType || '').toUpperCase();
  if (["PER", "PERSON", "OFFICER"].includes(type)) type = "PER";
  else type = "ORG";

  const shouldAbort = () => {
    if (Date.now() > deadline) {
      if (!warnedTimeout) {
        warnedTimeout = true;
        console.warn(`[RTI] Timeout (${MATCH_TIMEOUT_MS}ms) for entity: ${entityName}`);
      }
      return true;
    }
    attemptCount += 1;
    if (attemptCount > MAX_MATCH_ATTEMPTS) {
      if (!warnedAttempts) {
        warnedAttempts = true;
        console.warn(`[RTI] Max attempts (${MAX_MATCH_ATTEMPTS}) exceeded for: ${entityName}`);
      }
      return true;
    }
    return false;
  };

  // Try exact and normalized matches for organizations
  if (type === 'ORG') {
    // Priority 1: Exact matches (Ministries) - FAST RETURN
    for (const [key, rows] of indices.byMinistry) {
      if (shouldAbort()) return { matched: false, candidates: [], entityName };
      if (key === entityName || normalizeMatchToken(key) === normalized) {
        candidates.push(...rows.map((row) => ({ row, field: 'ministry', matchType: 'exact', confidence: 100, entityName })));
        return { matched: true, candidates: candidates.slice(0, 5), entityName }; // Early return
      }
    }

    // Priority 2: Exact matches (Divisions)
    for (const [key, rows] of indices.byDivision) {
      if (shouldAbort()) return { matched: false, candidates: [], entityName };
      if (key === entityName || normalizeMatchToken(key) === normalized) {
        candidates.push(...rows.map((row) => ({ row, field: 'division', matchType: 'exact', confidence: 95, entityName })));
        return { matched: true, candidates: candidates.slice(0, 5), entityName }; // Early return
      }
    }

    // Priority 3: Exact matches (Offices)
    for (const [key, rows] of indices.byOffice) {
      if (shouldAbort()) return { matched: false, candidates: [], entityName };
      if (key === entityName || normalizeMatchToken(key) === normalized) {
        candidates.push(...rows.map((row) => ({ row, field: 'office', matchType: 'exact', confidence: 90, entityName })));
        return { matched: true, candidates: candidates.slice(0, 5), entityName }; // Early return
      }
    }

    // Priority 4: Partial matches (only if no exact match)
    if (candidates.length === 0) {
      for (const [key, rows] of indices.byMinistry) {
        if (shouldAbort()) break;
        if (key.includes(entityName) || entityName.includes(key)) {
          candidates.push(...rows.map((row) => ({ row, field: 'ministry', matchType: 'partial', confidence: 85, entityName })));
        }
      }
    }
  }

  // Try exact and normalized matches for persons/officers
  if (type === 'PER') {
    for (const [key, rows] of indices.byOfficerName) {
      if (shouldAbort()) return { matched: false, candidates: [], entityName };
      if (key === entityName || normalizeMatchToken(key) === normalized) {
        candidates.push(...rows.map((row) => ({ row, field: 'officer', matchType: 'exact', confidence: 100, entityName })));
        return { matched: true, candidates: candidates.slice(0, 5), entityName }; // Early return
      }
    }

    if (regex && candidates.length === 0) {
      for (const [key, rows] of indices.byOfficerName) {
        if (shouldAbort()) break;
        if (regex.test(key)) {
          const sim = calculateSimilarity(normalized, normalizeMatchToken(key));
          candidates.push(
            ...rows.map((row) => ({
              row,
              field: 'officer',
              matchType: 'regex',
              confidence: 75 + Math.round(sim / 4),
              entityName,
            }))
          );
        }
      }
    }
  }

  // Remove duplicates and sort by confidence
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const key = `${candidate.row._rowIndex}|${candidate.field}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(candidate);
    }
  }

  unique.sort((a, b) => b.confidence - a.confidence);

  return {
    matched: unique.length > 0,
    candidates: unique.slice(0, 5), // Top 5 matches
    entityName,
  };
}

/**
 * Enrich multiple entities with database lookup
 * With 3-level fallback: Entity > CSV Fallback > Hardcoded Fallback
 * Never gets stuck - always renders something
 */
function enrichEntities(entities = []) {
  const enriched = [];

  for (const entity of entities) {
    const entityName = (entity.text || entity.name || '').trim();
    const entityType = (entity.label || entity.type || 'ORG').toUpperCase();

    if (!entityName) continue;

    try {
      // LEVEL 1: Try to match the entity itself
      const match = matchEntity(entityName, entityType);

      if (match.matched && match.candidates.length > 0) {
        const topMatch = match.candidates[0];
        enriched.push({
          originalEntity: entityName,
          extractedType: entityType,
          databaseMatch: {
            ministry: topMatch.row.ministry,
            division: topMatch.row.division,
            office: topMatch.row.office,
            matchedField: topMatch.field,
            matchType: topMatch.matchType,
            confidence: topMatch.confidence,
            officers: {
              primary: {
                name: topMatch.row.primaryOfficer,
                designation: topMatch.row.primaryDesignation,
                mobile: topMatch.row.primaryMobile,
                email: topMatch.row.primaryEmail,
                image: topMatch.row.primaryImageUrl,
              },
              alternate: {
                name: topMatch.row.alternateOfficer,
                designation: topMatch.row.alternateDesignation,
                mobile: topMatch.row.alternateMobile,
                email: topMatch.row.alternateEmail,
                image: topMatch.row.alternateImageUrl,
              },
              appellate: {
                name: topMatch.row.appellateOfficer,
                designation: topMatch.row.appellateDesignation,
                mobile: topMatch.row.appellateMobile,
                email: topMatch.row.appellateEmail,
                image: topMatch.row.appellateImageUrl,
              },
            },
            websiteLink: topMatch.row.websiteLink,
            lastUpdated: topMatch.row.lastUpdated,
          },
          candidates: match.candidates.slice(1, 3).map((c) => ({
            field: c.field,
            matchType: c.matchType,
            confidence: c.confidence,
            ministry: c.row.ministry,
            division: c.row.division,
            office: c.row.office,
          })),
        });
      } else {
        // No real database match for this entity. Never fabricate a ministry/
        // office/officer to fill the slot — leave every field genuinely blank
        // so the UI can show "no match" honestly instead of a fake office.
        enriched.push({
          originalEntity: entityName,
          extractedType: entityType,
          databaseMatch: {
            ministry: '',
            division: '',
            office: '',
            matchedField: 'NO_MATCH',
            matchType: 'FALLBACK',
            confidence: 0,
            officers: {
              primary: { name: '', designation: '', mobile: '', email: '', image: '' },
              alternate: { name: '', designation: '', mobile: '', email: '', image: '' },
              appellate: { name: '', designation: '', mobile: '', email: '', image: '' },
            },
            websiteLink: '',
            lastUpdated: '',
            isFallback: true,
          },
          candidates: [],
        });
      }
    } catch (error) {
      // No real match could be determined due to an error — same rule applies:
      // leave fields blank rather than filling them with fabricated data.
      console.error(`[RTI] Error enriching "${entityName}":`, error.message);
      enriched.push({
        originalEntity: entityName,
        extractedType: entityType,
        databaseMatch: {
          ministry: '',
          division: '',
          office: '',
          matchedField: 'ERROR',
          matchType: 'FALLBACK',
          confidence: 0,
          officers: {
            primary: { name: '', designation: '', mobile: '', email: '', image: '' },
            alternate: { name: '', designation: '', mobile: '', email: '', image: '' },
            appellate: { name: '', designation: '', mobile: '', email: '', image: '' },
          },
          websiteLink: '',
          lastUpdated: '',
          isFallback: true,
          errorMessage: error.message,
        },
        candidates: [],
      });
    }
  }

  return enriched;
}

/**
 * Get all ministries in database
 */
function getAllMinistries() {
  const { data } = getDatabase();
  const ministries = new Set();
  for (const row of data) {
    if (row.ministry) ministries.add(row.ministry);
  }
  return Array.from(ministries).sort();
}

/**
 * Get divisions for a specific ministry
 */
function getDivisionsForMinistry(ministry) {
  const { indices } = getDatabase();
  const normalized = normalizeMatchToken(ministry);
  const rows = indices.byMinistry.get(ministry) || indices.byMinistryNorm.get(normalized) || [];
  const divisions = new Set();
  for (const row of rows) {
    if (row.division) divisions.add(row.division);
  }
  return Array.from(divisions).sort();
}

/**
 * Get offices for a specific division
 */
function getOfficesForDivision(division) {
  const { indices } = getDatabase();
  const normalized = normalizeMatchToken(division);
  const rows = indices.byDivision.get(division) || indices.byDivisionNorm.get(normalized) || [];
  const offices = new Set();
  for (const row of rows) {
    if (row.office) offices.add(row.office);
  }
  return Array.from(offices).sort();
}

/**
 * Get full details for a ministry/division/office
 */
function getOfficDetails(ministry, division, office) {
  const { data } = getDatabase();
  const candidates = data.filter((row) => {
    const ministryMatch = !ministry || row.ministry === ministry || normalizeMatchToken(row.ministry) === normalizeMatchToken(ministry);
    const divisionMatch = !division || row.division === division || normalizeMatchToken(row.division) === normalizeMatchToken(division);
    const officeMatch = !office || row.office === office || normalizeMatchToken(row.office) === normalizeMatchToken(office);
    return ministryMatch && divisionMatch && officeMatch;
  });
  return candidates;
}

function pickBestRow({ ministry = '', division = '', office = '', officerNames = [] } = {}) {
  const { data } = getDatabase();
  const normalizedMinistry = normalizeMatchToken(ministry);
  const normalizedDivision = normalizeMatchToken(division);
  const normalizedOffice = normalizeMatchToken(office);
  const normalizedOfficerNames = (Array.isArray(officerNames) ? officerNames : [])
    .map((value) => normalizeMatchToken(value))
    .filter(Boolean);

  let bestRow = null;
  let bestScore = -1;

  for (const row of data) {
    let score = 0;
    if (normalizedMinistry && normalizeMatchToken(row.ministry) === normalizedMinistry) score += 0.5;
    if (normalizedDivision && normalizeMatchToken(row.division) === normalizedDivision) score += 0.2;
    if (normalizedOffice && normalizeMatchToken(row.office) === normalizedOffice) score += 0.2;

    for (const officerName of normalizedOfficerNames) {
      if (!officerName) continue;
      if (normalizeMatchToken(row.primaryOfficer) === officerName) score += 0.35;
      if (normalizeMatchToken(row.alternateOfficer) === officerName) score += 0.25;
      if (normalizeMatchToken(row.appellateOfficer) === officerName) score += 0.25;
    }

    if (score > bestScore) {
      bestScore = score;
      bestRow = row;
    }
  }

  if (!bestRow || bestScore <= 0) return null;
  return {
    row: bestRow,
    confidence: Math.max(0, Math.min(0.99, Number(bestScore.toFixed(2)))),
  };
}

function enrichOfficerSlot(slot = {}, row = null, confidence = 0, role = 'primary') {
  const src = slot && typeof slot === 'object' ? slot : {};
  const record = row || {};

  const mapping = {
    primary: {
      name: record.primaryOfficer,
      designation: record.primaryDesignation,
      phone: record.primaryPhone,
      mobile: record.primaryMobile,
      email: record.primaryEmail,
      address: record.primaryAddress,
      image: record.primaryImageUrl,
    },
    alternate: {
      name: record.alternateOfficer,
      designation: record.alternateDesignation,
      phone: record.alternatePhone,
      mobile: record.alternateMobile,
      email: record.alternateEmail,
      address: record.alternateAddress,
      image: record.alternateImageUrl,
    },
    appellate: {
      name: record.appellateOfficer,
      designation: record.appellateDesignation,
      phone: record.appellatePhone,
      mobile: record.appellateMobile,
      email: record.appellateEmail,
      address: record.appellateAddress,
      image: record.appellateImageUrl,
    },
  };

  const roleData = mapping[role] || {};
  const hasDbMatch = Boolean(row);

  // Officer slots come from the CSV row only: an official quoted in the news is not the
  // RTI Designated/Appellate Officer, so extracted names never fill these slots.
  void src;
  return {
    name: roleData.name || '',
    designation: roleData.designation || '',
    phone: roleData.phone || '',
    mobile: roleData.mobile || '',
    email: roleData.email || '',
    address: roleData.address || '',
    image: roleData.image || '',
    database_match: hasDbMatch,
    match_confidence: hasDbMatch ? confidence : 0,
  };
}

function buildStructuredExtraction(extractedData = {}) {
  const entities = Array.isArray(extractedData.entities) ? extractedData.entities : [];
  const officers = entities.filter((entity) => entity && (entity.name || entity.title));

  const ministry = officers.find((item) => item.ministry)?.ministry || '';
  const division = officers.find((item) => item.division)?.division || '';
  const district = officers.find((item) => item.district)?.district || '';
  const office = extractedData.office || '';

  const primarySource = officers[0] || null;
  const alternateSource = officers[1] || null;
  const appellateSource = officers.find((item) => /আপীল|আপিল|appellate/i.test(item.title || '')) || null;

  return {
    ministry,
    division,
    district,
    office,
    officers: {
      primary: primarySource ? { name: primarySource.name || '', designation: primarySource.title || '' } : null,
      alternate: alternateSource ? { name: alternateSource.name || '', designation: alternateSource.title || '' } : null,
      appellate: appellateSource ? { name: appellateSource.name || '', designation: appellateSource.title || '' } : null,
    },
    provider: extractedData.provider || 'unknown',
    status: extractedData.status || 'failed',
    entities,
  };
}

/**
 * Shape /api/extract-entities output for Section 3's hand-off: the CSV row for the body the
 * article is about (deterministic gazetteer match over the article text, with the extractor's
 * ministry/office names as a secondary cross-check) plus the officials the article names.
 */
async function enrichWithRTIDatabase(extractedData = {}, { articleText = '' } = {}) {
  const structured = buildStructuredExtraction(extractedData);
  const entities = structured.entities || [];
  const aiNames = [];
  entities.forEach((e) => [e.ministry, e.division, e.office, e.type !== 'officer' ? e.name : ''].forEach((v) => {
    if (v && !aiNames.includes(v)) aiNames.push(v);
  }));

  const gazetteer = require('./rtiGazetteer');
  const { matches } = gazetteer.matchGovernmentBodies(articleText, aiNames);
  const top = matches[0] || null;
  const matchedRow = top ? gazetteer.pickRowForBody(top) : null;
  const confidence = !top ? 0 : (gazetteer.MATCH_CONFIDENCE[top.method] || 0.5);

  const newsPersons = entities
    .filter((e) => e.type === 'officer' && e.name)
    .map((e) => ({ name: e.name, designation: e.title || '', office: e.office || '', ministry: e.ministry || '' }));

  return {
    ...structured,
    ministry: matchedRow?.ministry || structured.ministry || '',
    division: matchedRow?.division || structured.division || '',
    office: matchedRow?.office || structured.office || '',
    officers: {
      primary: enrichOfficerSlot({}, matchedRow, confidence, 'primary'),
      alternate: enrichOfficerSlot({}, matchedRow, confidence, 'alternate'),
      appellate: enrichOfficerSlot({}, matchedRow, confidence, 'appellate'),
    },
    news_persons: newsPersons,
    matched_body: top ? { canonical: top.canonical, level: top.level, method: top.method, agencies: top.agencies } : null,
    database_enriched: Boolean(matchedRow),
    database_row_index: matchedRow?._rowIndex ?? null,
  };
}

module.exports = {
  // Core functions
  matchEntity,
  enrichEntities,
  enrichWithRTIDatabase,
  normalizeMatchToken,
  buildWhitespaceAgnosticRegex,

  // Database navigation
  getAllMinistries,
  getDivisionsForMinistry,
  getOfficesForDivision,
  getOfficDetails,

  // Internal
  getDatabase,
  buildIndices,
  calculateSimilarity,
};
