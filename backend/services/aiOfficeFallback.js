/**
 * aiOfficeFallback.js
 *
 * Section 3's deterministic resolution (officeResolution.js exact match, then
 * rtiGazetteer.js's curated alias/AGENCY_PARENTS list) only covers entities someone has
 * explicitly curated. Anything else -- an uncurated agency, a new institution, a spelling
 * variant nobody anticipated -- was silently skipped, never shown, never explained.
 *
 * This module is the last-resort fallback: for an entity neither step resolved, ask an LLM
 * to pick the single best-fit Ministry from the CSV's own ministry list (never a name it
 * invents), then let the existing office->division->ministry ladder take it from there.
 * Never fabricates a match: an unclear or non-governmental name gets `null`, not a guess.
 *
 * Classifications are cached (in-memory + a small JSON file) keyed by normalized entity name,
 * so the same entity is never re-classified by an LLM call on every request.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const officeResolution = require('../utils/officeResolution');

const CACHE_PATH = path.join(__dirname, '../data/aiFallbackCache.json');

let cache = null;
let geminiAnalysis = null;
function getGeminiAnalysis() {
  if (!geminiAnalysis) geminiAnalysis = require('./geminiAnalysis');
  return geminiAnalysis;
}

function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
  } catch {
    cache = {};
  }
  return cache;
}

function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`⚠️ [AI fallback] cache write failed: ${err.message}`);
  }
}

// LLMs occasionally mis-transcribe a long Bengali conjunct (e.g. "মন্ত্রণালয়" -> "মন্ত্রণয়")
// even while clearly meaning one specific list entry. Rejecting anything not byte-for-byte in
// the list (the original behavior) throws away an otherwise-correct classification over a typo.
// This finds the closest list entry by edit distance and accepts it only when the typo is small
// relative to the string's length -- never picks a DIFFERENT ministry/office, only forgives noise.
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function closestListMatch(candidate, list) {
  if (!candidate) return null;
  if (list.includes(candidate)) return candidate;
  let best = null;
  let bestDist = Infinity;
  for (const item of list) {
    const d = levenshtein(candidate, item);
    if (d < bestDist) { bestDist = d; best = item; }
  }
  const limit = Math.max(1, Math.floor(best?.length * 0.1 || 0));
  return best && bestDist <= limit ? best : null;
}

function ministryList(contacts) {
  const seen = new Set();
  const out = [];
  contacts.forEach((c) => {
    const m = (c?.Ministry || '').toString().trim();
    if (m && !seen.has(m)) { seen.add(m); out.push(m); }
  });
  return out;
}

// Distinct Office names under one ministry (excluding the ministry-level row itself, where
// Office === Ministry) -- used for the second, more specific classification pass.
function officesUnderMinistry(contacts, ministryName) {
  const seen = new Set();
  const out = [];
  contacts.forEach((c) => {
    if ((c?.Ministry || '').toString().trim() !== ministryName) return;
    const office = (c?.Office || '').toString().trim();
    if (office && office !== ministryName && !seen.has(office)) { seen.add(office); out.push(office); }
  });
  return out;
}

function buildPrompt(entityName, ministries) {
  return [
    'তুমি বাংলাদেশ সরকারের প্রশাসনিক কাঠামো বিশেষজ্ঞ।',
    'নিচের প্রতিষ্ঠান/সংস্থার নাম দেখে বলো তথ্য অধিকার (RTI) আবেদন কোন মন্ত্রণালয়ের কাছে পাঠানো উচিত।',
    'নামটি ইংরেজি বা বাংলা, যে ভাষাতেই হোক -- এর প্রকৃত অর্থ/অনুবাদ বুঝে মিল খুঁজো, শুধু বানানের মিল দেখো না।',
    '',
    `প্রতিষ্ঠানের নাম: "${entityName}"`,
    '',
    'শুধুমাত্র নিচের তালিকা থেকে হুবহু একই বানানে একটি মন্ত্রণালয়ের নাম বেছে নাও। তালিকার বাইরে কোনো নাম লিখবে না বা অনুমান করবে না।',
    ministries.map((m) => `- ${m}`).join('\n'),
    '',
    'যদি এই নামটি বাংলাদেশ সরকারের বাস্তব কোনো প্রতিষ্ঠান না হয়, অথবা তালিকার কোনো মন্ত্রণালয়ের সাথে স্পষ্ট সম্পর্ক না থাকে, তাহলে ministry এর মান null দাও -- অনুমান করে কিছু বসিও না।',
    '',
    'শুধুমাত্র এই JSON ফরম্যাটে উত্তর দাও, অন্য কোনো টেক্সট লিখবে না:',
    '{"ministry": "<তালিকার হুবহু নাম অথবা null>", "confidence": "high অথবা medium অথবা low"}',
  ].join('\n');
}

function buildOfficePrompt(entityName, ministryName, offices) {
  return [
    'তুমি বাংলাদেশ সরকারের প্রশাসনিক কাঠামো বিশেষজ্ঞ।',
    `নিচের প্রতিষ্ঠানের নাম "${ministryName}"-এর অধীনে একটি নির্দিষ্ট দপ্তর/অধিদপ্তর/বিভাগ কিনা দেখো।`,
    'নামটি ইংরেজি বা বাংলা, যে ভাষাতেই হোক -- এর প্রকৃত অর্থ/অনুবাদ বুঝে মিল খুঁজো, শুধু বানানের মিল দেখো না।',
    '',
    `প্রতিষ্ঠানের নাম: "${entityName}"`,
    '',
    `"${ministryName}"-এর অধীনে এই দপ্তরগুলো আছে -- হুবহু একই বানানে একটি বেছে নাও, শুধু যদি এটি স্পষ্টভাবে একটির সাথে মেলে:`,
    offices.map((o) => `- ${o}`).join('\n'),
    '',
    `এগুলোর কোনোটির সাথেই স্পষ্ট মিল না থাকলে (অর্থাৎ সাধারণভাবে "${ministryName}"-কেই বোঝাচ্ছে, কোনো নির্দিষ্ট দপ্তর না), office এর মান null দাও -- অনুমান করে কিছু বসিও না।`,
    '',
    'শুধুমাত্র এই JSON ফরম্যাটে উত্তর দাও, অন্য কোনো টেক্সট লিখবে না:',
    '{"office": "<তালিকার হুবহু নাম অথবা null>"}',
  ].join('\n');
}

/**
 * Classify one unmatched entity name against the CSV's own ministry list.
 * Returns { ministry, confidence } or null (never a fabricated / off-list name).
 * Cached by normalized entity name -- an LLM call happens at most once per distinct entity.
 */
// Guards against a non-string value that reached here already stringified upstream
// (e.g. a stray object in mlAnalysis.gov_body_matches) -- never worth an LLM call or a cache slot.
const JUNK_ENTITY_RE = /^\[object \w+\]$|^(undefined|null|nan|n\/a)$/i;

async function classifyEntity(entityName, contacts, { llmProvider = 'auto' } = {}) {
  if (JUNK_ENTITY_RE.test((entityName || '').toString().trim())) return null;
  const key = officeResolution.normalizeText(entityName);
  if (!key || key.length < 2) return null;

  const c = loadCache();
  if (Object.prototype.hasOwnProperty.call(c, key)) return c[key];

  const ministries = ministryList(contacts);
  const prompt = buildPrompt(entityName, ministries);

  let result = null;
  try {
    const ga = getGeminiAnalysis();
    const out = await ga.runPromptWithProvider(prompt, {
      llmProvider,
      operation: 'office_fallback_classify',
      maxTokens: 150,
      timeoutMs: 12000,
    });
    const parsed = ga.safeJsonParse(out.text);
    const rawMinistry = (parsed?.ministry || '').toString().trim();
    const ministry = rawMinistry.toLowerCase() === 'null' ? null : closestListMatch(rawMinistry, ministries);
    if (ministry) {
      result = { ministry, confidence: ['high', 'medium', 'low'].includes(parsed?.confidence) ? parsed.confidence : 'medium' };
    }
  } catch (err) {
    // A classification failure is not a request failure -- the entity is simply skipped,
    // same as before this module existed.
    console.warn(`⚠️ [AI fallback] classify failed for "${entityName}": ${err.message}`);
  }

  c[key] = result;
  saveCache();
  return result;
}

/**
 * Second, more specific pass: given the entity already placed under one ministry, check whether
 * it actually names one of that ministry's own offices/directorates/divisions (translating
 * across English/Bengali the same as the ministry pass) -- so a "perfect" match lands on the
 * exact office, not just the parent ministry, whenever the CSV has that office's own row.
 * Returns the exact CSV office name, or null (stays at ministry level).
 */
async function classifyOfficeWithinMinistry(entityName, ministryName, contacts, { llmProvider = 'auto' } = {}) {
  const key = `office::${officeResolution.normalizeText(entityName)}::${ministryName}`;
  const c = loadCache();
  if (Object.prototype.hasOwnProperty.call(c, key)) return c[key];

  const offices = officesUnderMinistry(contacts, ministryName);
  if (offices.length === 0) {
    c[key] = null;
    saveCache();
    return null;
  }

  const prompt = buildOfficePrompt(entityName, ministryName, offices);
  let result = null;
  try {
    const ga = getGeminiAnalysis();
    const out = await ga.runPromptWithProvider(prompt, {
      llmProvider,
      operation: 'office_fallback_classify_office',
      maxTokens: 150,
      timeoutMs: 12000,
    });
    const parsed = ga.safeJsonParse(out.text);
    const rawOffice = (parsed?.office || '').toString().trim();
    result = rawOffice.toLowerCase() === 'null' ? null : closestListMatch(rawOffice, offices);
  } catch (err) {
    console.warn(`⚠️ [AI fallback] office classify failed for "${entityName}" under "${ministryName}": ${err.message}`);
  }

  c[key] = result;
  saveCache();
  return result;
}

/**
 * Given entity names that officeResolution.resolveDetectedOrgs() could not resolve at all
 * (no CSV row, no gazetteer alias), classify each via AI in two passes -- ministry, then (within
 * that ministry) a specific office -- and resolve to the most specific real CSV row that
 * actually has officers, climbing the same office->division->ministry ladder from there.
 * Entities the AI can't place, or that resolve to a row with no officers on file, are dropped --
 * never padded.
 */
async function resolveUnmatchedEntities(entityNames, contacts, { llmProvider = 'auto' } = {}) {
  const cards = [];
  for (const entityName of entityNames) {
    const classification = await classifyEntity(entityName, contacts, { llmProvider });
    if (!classification) continue;

    let resolvedRow = officeResolution.findMinistryRow(contacts, classification.ministry);
    if (!resolvedRow) continue;

    const officeName = await classifyOfficeWithinMinistry(entityName, classification.ministry, contacts, { llmProvider });
    if (officeName) {
      const officeRow = contacts.find((ct) =>
        officeResolution.normalizeText(ct?.Office) === officeResolution.normalizeText(officeName)
        && (ct?.Ministry || '').toString().trim() === classification.ministry
      );
      if (officeRow) {
        const ladder = officeResolution.resolveOfficeLadder(officeRow, contacts);
        if (ladder.resolved) resolvedRow = ladder.resolved;
      }
    }

    if (!officeResolution.contactHasOfficers(resolvedRow)) continue;

    cards.push({
      requestedEntities: [entityName],
      matchedContact: resolvedRow,
      resolution: {
        resolved: resolvedRow,
        rung: 'ai_fallback',
        skipped: [],
        requestedRowKey: officeResolution.rowKey(resolvedRow),
        resolvedRowKey: officeResolution.rowKey(resolvedRow),
        aiConfidence: classification.confidence,
      },
    });
  }
  return cards;
}

module.exports = {
  classifyEntity,
  resolveUnmatchedEntities,
};
