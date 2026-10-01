# Section 3 — "RTI Officers Directory" (verification) (RTIod)

> JAANI has four main sections: 1. Read The News → 2. News Analysis (What's in the news?) → **3. Officers Directory (verification)** → 4. Send Message (RTI mail).
> This document covers **Section 3 only**: what it does, every file involved, the resolution/verification pipeline, the data model, legacy code, security notes, requirements from chat history, and open problems.
>
> Snapshot date: 2026-10-01, branch `section-1-read-the-news-v3`. **All Section 3 code described here is in the uncommitted working tree** (no Section-3-specific commit has been made since `10cd927`); `git status` shows the touched files. Line numbers refer to the working tree on that date; `api.js` changes often, so search by function name if a line number no longer matches.
> This revision supersedes the 2026-09-29 snapshot of this document: the matching architecture, the dataset size, and most of that revision's open problems have all changed since. Superseded content is not repeated; see git history for the prior text if needed.
> Sources: the live codebase, `chat history/JAANI07_chat.md`, plus the session transcript for 2026-09-30/10-01 (no separate chat-log file for that session existed at write time — requirements are captured directly in §9.2), and `s1_rtn.md`/`s2_na.md` for cross-references.

---

## 1. What the section must do (requirements the user has given)

| # | Requirement | Where it came from | Current |
|---|---|---|---|
| R1 | Use `JAANI_RTI_OFFICERS_COMPLETE.csv` as the officers dataset; no blockage; image extraction must succeed | JAANI07_chat.md L7 | Met (§4.1); "image extraction must always succeed" drove the 3-tier photo pipeline (§5.3) |
| R2 | 26-column canonical schema, exactly 3 officer roles per office (Primary/Alternate/Appellate), blanks stay blank | JAANI07_chat.md L10 | Met — matches the CSV header exactly (§3) |
| R3 | Officer photos must show for every role that has an officer, never borrowed or fabricated from another role | JAANI07_chat.md (screenshot feedback, L60) | Met — role-gated photo assignment (§5.3) |
| R4 | Confirm the CSV loads, then verify offices to populate/persist photo URLs | JAANI07_chat.md L98 | Superseded by iterative growth — see §8 P7 |
| R5 | Keep the four-section structure; only OpenAI + Grok (xAI) + Kimi as LLM providers; Playwright/Wayback must work as fallbacks | Master brief; JAANI07_chat.md | Met — `llm_provider` param normalized via `geminiAnalysis.normalizeLlmProvider`; 3-tier image fallback includes Playwright and Wayback (§5.3) |
| R6 | No fabricated/borrowed officer data anywhere | JAANI07_chat.md; carried from Section 2's "never fabricate" rule | Met — `enrichOfficerSlot`/`enrichEntities` in `rtiDatabaseLookup.js`, and every resolver added since (§4.2), leave a field blank or drop the entity rather than guess |
| R7 | Every detected government body Section 2 lists — in English or Bengali — must resolve to the *correct* CSV row, translating where needed, never a near-miss like the wrong ministry | 2026-09-30/10-01 session | Met — two-stage AI fallback classification (§4.2/§4.3) with edit-distance tolerance for LLM spelling slips; deterministic gazetteer word-boundary bug fixed (§8, formerly-open MoHA false-positive) |
| R8 | A manual way to pull in an office the automatic detection missed — free-text search and a browsable multi-select list — that behaves exactly like a detected match (same resolution pipeline, same card) | 2026-09-30/10-01 session | Met — §4.4 |
| R9 | Section 3 must only ever show cards for organizations Section 2 actually detected (or the user manually added) — no pre-populated placeholder card from a raw single-officer guess before the real detection pipeline runs | 2026-10-01 session ("no pre saved in section 3...just show those are detected in organization") | Met — the `buildVerificationRecordFromExtraction`/`verification_prefetch` shortcut in `Home.js` was removed; the first Section 3 paint now always comes from the detected-organizations pipeline |

---

## 2. What the user sees

Section 3 is **not a separate page or accordion tab** — it renders inline in `Home.js`, below Sections 1–2, auto-triggered once Section 2's analysis (`/api/analyze-text` + `/api/extract-entities`) lands. A lightweight *preview* of the same data still appears inside Section 2's accordion (`AnalysisAccordion.js`, "Section 3c-pre: RTI Officer Cards" — documented in `s2_na.md`); the full editable experience described here is the separate `VerificationGrid` component.

Above the resolved cards sits a manual-lookup bar (`Home.js` ~L1533-1605): a free-text search box ("অফিস মিস হয়েছে? মন্ত্রণালয় / বিভাগ / দপ্তরের নাম লিখুন...") and, beside it, a checkbox multi-select `Autocomplete` ("তালিকা থেকে একাধিক দপ্তর বেছে নিন...") grouped by ministry, backed by `GET /api/offices-list`. Either path calls the same `/api/verify-contact` resolution used for automatic detection and adds its result as an additional card — it can never be silently overwritten by a slower automatic response landing afterward (§4.4).

For each resolved office, the user sees a `<VerificationGrid>`: three ID-card style `OfficerCard`s side by side — **Primary / Alternate / Appellate** — each with photo, name, designation, phone, mobile, email, address, and a "download vCard" button. A role with no data renders "— তথ্য পাওয়া যায়নি —" at reduced opacity rather than being hidden. A per-card Bengali notice line explains any ladder climb (e.g. "«X»-এর নিজস্ব তথ্য নেই, তাই Y-এর তথ্য দেখানো হচ্ছে") or an AI-fallback classification ("...AI বিশ্লেষণ অনুযায়ী..."), so the user always knows whether a card is an exact match or an inferred one. An **Edit** dialog opens a live iframe of the actual government website (proxied through the backend so it can be embedded) next to editable fields, for manual visual comparison and correction, with a **Save** button that writes the correction back into the CSV, plus a "স্ক্র্যাপ করুন" (scrape) button that always re-fetches the live page fresh (no-cache headers, §5.3) via whichever LLM provider is actually configured (`'auto'`, not hardcoded). A **retry** button re-runs verification with live web enrichment on; a **use cached data** button forces DB-only. If no office can be matched at all, a "Stage 3 AI-synthesized" fallback dialog shows AI-guessed office data with an explicit "for reference only, not DB/web-verified" warning.

---

## 3. Data: `JAANI_RTI_OFFICERS_COMPLETE.csv`

The **single, living, self-updating dataset** — at the repo root, not `backend/data/`. `contactLoader.js` reads only this file. **280 data rows** + 1 header (grown from 59 at the 2026-09-29 snapshot, then 245 → 279 → 280 across the 2026-09-30/10-01 session via a rigorous verify-before-write discipline: every new `.gov.bd` domain confirmed reachable via WebSearch before being added, every merge backed up first and test-suite-checked after), 26 columns:

```
Ministry, Division, Office,
Primary_Officer_Name, Primary_Designation, Primary_Phone, Primary_Mobile, Primary_Email, Primary_Address, Primary_Image_URL,
Alternate_Officer_Name, Alternate_Designation, Alternate_Phone, Alternate_Mobile, Alternate_Email, Alternate_Address, Alternate_Image_URL,
Appellate_Officer_Name, Appellate_Designation, Appellate_Phone, Appellate_Mobile, Appellate_Email, Appellate_Address, Appellate_Image_URL,
Website_Link, Last_Updated
```

Not every row has officer data — many are intentionally blank placeholders (a real office confirmed to exist, with a real `Website_Link`, but the government page itself has no officer table yet, or the page is genuinely inaccessible). This is by design (R6/"you can't always find 100%" — a standing instruction from the session that expanded the dataset): a blank row is never padded, and the office→division→ministry ladder (§4.2) exists specifically so a blank leaf office still resolves to a real, populated parent authority rather than showing nothing or a fabricated card.

It is not a static seed file: Section 3's own verification endpoint writes back into it (§5.4), and `Last_Updated` is stamped whenever a field actually changes. Section 2's `rtiDatabaseLookup.js` reads the same file for its read-only enrichment pass, and re-checks its mtime/size signature on every call specifically so it picks up Section 3's writes on the *next* analysis run (see `s2_na.md` §4.3/§5.3). `rtiGazetteer.js` (§4.2) also rebuilds its own cache on the same CSV-signature check, so a CSV edit is picked up by matching too, not just by the enrichment pass.

Legacy/orphaned data files not read by anything running today: `backend/data/gov_contacts_all.csv`, `gov_contacts.json`, `gov_contacts_compact.json`, `contacts.js`, `rti_officers_enriched.csv`, `scraped_contacts/rti_officers_all.json` — artifacts of the offline collection scripts in §6.

---

## 4. End-to-end flow

### 4.1 Automatic (article-driven) resolution

```
[AnalysisAccordion / Home.js — Section 2 analysis lands: /api/analyze-text + /api/extract-entities]
        │
        ▼
[Home.startVerification(mergedData)]  (frontend/src/pages/Home.js, ~L663-692)
        │  No pre-populated card is painted here anymore (R9) — the function only derives an
        │  office query and hands off to the real resolution call below.
        │
        │ deriveOfficeQueryFromAnalysis(data)
        │   prefers analysis.related_offices, else rti_target_office /
        │   related_office / related_ministry
        ▼
   two sequential background calls to handleVerifyContact
        │
        ├─ FAST PASS   enrichWeb:false, allowDbFallback:false   (CSV only, ~instant —
        │               unless the top office's CSV row is missing officer data for
        │               any role, in which case the backend still live-scrapes anyway,
        │               see §8 P2)
        │
        └─ SLOW PASS   enrichWeb:true,  allowDbFallback:true    (adds live gov.bd
                        scraping + photo fetching, up to 120s)
        │
        │ verifyContact(officeName, enrichWeb, {llm_provider, mlAnalysis})
        │   axiosConfig.js → POST /api/verify-contact
        │   mlAnalysis = { gov_body_matches, mentioned_gov_orgs, enriched_entities,
        │                   rti_target_office, related_ministry(ies), entities,
        │                   verified_entities } — every organization Section 2 detected,
        │                   not just its single best guess (R7)
        ▼
[backend POST /api/verify-contact]  (backend/routes/api.js:4757+)
        │  build detectedOrgs[]: office_name (whole string, THEN comma/pipe/newline-split
        │     segments — a whole-string-first pass so ministry names that contain a
        │     literal comma aren't fragmented) ∪ gov_body_matches ∪ mentioned_gov_orgs
        │     ∪ enriched_entities, deduped
        │  officeResolution.resolveDetectedOrgs(detectedOrgs, contacts, rtiGazetteer,
        │     {maxCards: Infinity})                                          §4.2
        │  AI fallback pass over anything still unresolved                   §4.3
        │  per resolved office (no cap — every genuinely detected org gets its own card):
        │    shouldScrapeWebsite = websiteLink && (enrich_web || missing-role-info)
        │    → scrapeInfoOfficersPage(websiteLink)                           §5.3
        │    → enrichFromDiscoveredInfoOfficerLinks (secondary pages)
        │    → imageFetcher.fetchAllOfficerImages (role-gated)               §5.3
        │    → toNormalizedOfficerRecord, persistOfficerPhotosLocally
        │    → databaseSnapshot captured BEFORE the scrape merges in, so
        │      computeOfficerDiscrepancies can genuinely compare DB vs. live   §5.4
        │  syncVerifiedRecordToCsv(matches[0], mode:'auto-reconcile')         §5.4 — WRITES BACK
        │  res.json({ matches[], databaseRecord, liveScrapedRecord,
        │             discrepancies, discrepancies_by_match[], officer_slots,
        │             partial_success, network_status,
        │             llm_provider_used, llm_reasoning_details })
        ▼
[Home.js: verificationData state]
        │  dedupe matches; seed Section 4's email recipient list from every
        │  match's Primary_Email; batch-prefetch images (POST /api/extract-images)
        ▼
[VerificationGrid × N]  (frontend/src/components/VerificationGrid.js)
        │  OfficerCard × 3 (Primary/Alternate/Appellate) per match
        │  Edit dialog → live compare iframe (GET /api/webview, SSRF-guarded)
        │              → Save → POST /api/contacts/update → CSV write
        │              → "স্ক্র্যাপ করুন" → POST /api/stage2-scrape (always
        │                re-fetches live, 'auto' provider, no-cache headers)
        ▼
 Verified officer cards, correctable, feeding Section 4's recipients
```

### 4.2 Deterministic resolution: `officeResolution.js` + `rtiGazetteer.js`

The old 4-strategy scoring cascade this document described at the 2026-09-29 snapshot (`selectTopOfficesFromAnalysisSignals`, `rankTopOfficesForRequestedText`, `selectTopOfficesByKeyword`, hardcoded-office last resort) **no longer exists** — it has been fully replaced by a smaller, pure, unit-tested module.

- **[backend/utils/officeResolution.js](../backend/utils/officeResolution.js)** (279 lines, zero I/O, fully unit-testable) — `matchEntityToContacts` tries, in order: (1) exact `Office` column match, (2) ministry-level row (`Ministry==Division==Office`), (3) division-level row (`Division==Office`). `resolveOfficeLadder` then climbs office → division → ministry, stopping at the first rung with a real, non-placeholder officer (`contactHasOfficers`) — never fabricates, never pads. `resolveDetectedOrgs` runs this per detected entity, deduplicating by resolved row so two different mentions of the same office produce one card, and merges their `requestedEntities` so the card shows everything the article actually said that led to it.
- **[backend/services/rtiGazetteer.js](../backend/services/rtiGazetteer.js)** (598 lines) — the fallback when an entity has no CSV row of its own: an Aho-Corasick scan over curated `ALIASES` (short forms, English names) and `AGENCY_PARENTS` (agencies with no row of their own, mapped to the CSV row that's their real parent, e.g. ডিএমপি → স্বরাষ্ট্র মন্ত্রণালয়). `matchGovernmentBodies` also powers Section 2's own "mentioned_gov_orgs" detection, so the same gazetteer grounds both sections. A leftmost-longest scan with a real start-of-word boundary check; a pattern ending in a Latin letter/digit (an English alias like "MoHA") also now requires a real end-of-word boundary (added this session — see §8, formerly a live false-positive where "MoHA" matched as a bare substring inside "**Moha**mmad", a person's name).

### 4.3 Last-resort AI fallback: `aiOfficeFallback.js`

**[backend/services/aiOfficeFallback.js](../backend/services/aiOfficeFallback.js)** (279 lines) — new this session. Anything §4.2 can't place (no CSV row, no curated alias) is not simply dropped; it's classified by an LLM in two passes:

1. `classifyEntity` — pick the single best-fit **ministry** from the CSV's own 45-name list (never an invented name). The prompt explicitly instructs cross-lingual matching (an English entity name against the Bengali ministry list) so this also satisfies R7's translation requirement.
2. `classifyOfficeWithinMinistry` — given that ministry, check whether the entity actually names one of *that ministry's own offices* (a much smaller, cheap second prompt), so a match lands on the precise office when the CSV has it, not just the parent ministry.

Both passes validate the LLM's answer against the real list by exact match, then by edit distance (`closestListMatch`, ≤10% of the target string's length) — tolerates a minor Bengali-conjunct spelling slip (observed live: "মৎস্য ও প্রাণিসম্পদ মন্ত্রণালয়" misspelled as "...মন্ত্রণয়") without ever accepting a genuinely different name. An entity that can't be placed gets `null`, never a guess. Classifications are cached (`backend/data/aiFallbackCache.json`, in-memory + on-disk) keyed by normalized entity name (and `office::<entity>::<ministry>` for the second pass), so a given entity is classified by an LLM at most once ever, not once per request. Resolved via the same `resolveOfficeLadder`-equivalent climb as §4.2, so a specific-but-blank office still falls back to a populated parent.

Wired into `POST /api/verify-contact`: after `resolveDetectedOrgs`, any detected org not covered by any returned card is passed to `resolveUnmatchedEntities`, and any resulting cards are merged in (deduped against the deterministic cards by resolved row). A classification failure or provider timeout is non-fatal — that entity is simply left unresolved, exactly as if this module didn't exist.

### 4.4 Manual resolution: search bar and browse dropdown

Both added this session (R8), both reuse `POST /api/verify-contact` directly — a manual lookup goes through the exact same §4.2/§4.3 pipeline as an automatically-detected one, so it can resolve via the ladder or the AI fallback too.

- **Search bar** (`handleManualOfficeSearch`, `Home.js`) — free text, `enrich_web:false` for speed, no `mlAnalysis` (the office-name segment-splitting in `/verify-contact` itself is enough).
- **Browse dropdown** (`handleAddSelectedOffices`, `ensureOfficesListLoaded`, `Home.js`) — a checkbox multi-select `Autocomplete` over `GET /api/offices-list` (new endpoint, `api.js`, every distinct Ministry/Division/Office row, deduped and sorted). Each checked option's exact `Office` string is sent to `/verify-contact`, so it always resolves via §4.2's exact-match step — no AI fallback ever needed for a dropdown pick.

Both write into a **separate** `manualMatches` state, not into `verificationData` directly. This matters: the automatic pipeline (§4.1) does `setVerificationData(verifyResult)` — a full replace — whenever its slow pass resolves, which previously could silently wipe out a manual addition that landed first (a real race, found and fixed this session). Rendering combines `verificationData.matches` and `manualMatches` at render time, so a manual addition survives regardless of when the automatic call finishes. `manualMatches` is cleared whenever a new article is submitted.

Every request in the flows above is guarded the same way as Sections 1–2 — a slow/older verification call can be superseded via `requestVersionRef`; not separately re-verified in this revision.

---

## 5. File inventory and pipeline detail

### 5.1 Frontend

| File | Role | Key symbols |
|---|---|---|
| [frontend/src/pages/Home.js](../frontend/src/pages/Home.js) (1,877 lines) | Section 2→3 hand-off, orchestration, manual search/browse, retry/cache controls, email-recipient seeding | `deriveOfficeQueryFromAnalysis`; `startVerification` (~L663-692, no pre-population — R9); `handleVerifyContact`; `handleRetryVerification`; `handleUseCacheVerification`; `handleManualOfficeSearch` (~L1037); `ensureOfficesListLoaded`/`handleAddSelectedOffices` (~L1070-1120); `handleContactUpdated`; image-prefetch effect; `<VerificationGrid>` render site (combines `verificationData.matches` ∪ `manualMatches`, ~L1590+) |
| [frontend/src/components/VerificationGrid.js](../frontend/src/components/VerificationGrid.js) (1,966 lines) | **The Section 3 UI** — ID-card display, edit dialog, live-compare iframe, save, re-scrape | `FIELD_LABELS`; `GOV` theme constants; `OfficerCard` (hoisted to module scope to avoid `<img>` remount on frequent re-render); main component; image-fetch effect (`GET /api/extract-image?url=…&count=3`); `handleScrapeOfficerDetails` (manual re-scrape, calls `stage2ScrapeSchema(govUrl, 'auto')` — changed from a hardcoded `'gemini'` this session, since Gemini isn't configured in every deployment); `handleSave` (→ `POST /api/contacts/update`); live-compare `<iframe src=".../api/webview?url=...">` |
| [frontend/src/components/AnalysisAccordion.js](../frontend/src/components/AnalysisAccordion.js) (1,387 lines) | Only the Section-2-side *preview* card (documented in `s2_na.md`) plus `.officer-highlight` CSS reused from Section 1. The Read The News view switcher here is Section 1's, not Section 3's — see `s1_rtn.md` for the Wayback-tab removal and Live-tab allowlist expansion made the same session | — |
| [frontend/src/api/axiosConfig.js](../frontend/src/api/axiosConfig.js) (457 lines) | API client | `verifyContact`; `getOfficesList` (new, backs §4.4's dropdown); `buildApiUrl`/`buildAssetUrl` |
| [frontend/src/hooks/useIntelligentPipeline.js](../frontend/src/hooks/useIntelligentPipeline.js) | `stage2ScrapeSchema` (manual single-office re-scrape from the edit dialog); `stage3FallbackLookup` (AI-synthesized last-resort office guess) | — |

No dedicated `OfficerDirectory.js`/`ContactVerification.js`/`VerifyOfficer.js` file exists; everything lives in `VerificationGrid.js` + `Home.js`.

### 5.2 Backend: resolution and endpoints (`backend/routes/api.js`, 7,738 lines)

| Endpoint | Line | Purpose |
|---|---|---|
| `GET /offices-list` | ~4721 | New this session — every distinct (Ministry, Division, Office), for §4.4's dropdown |
| `POST /verify-contact` | ~4757 | The core resolution + scrape + write-back endpoint; see §4.1-4.3 |
| `GET /contacts` | ~5193 | Simple stripped-down listing of all CSV contacts; not used by the live verification flow (diagnostic/legacy) |
| `POST /contacts/update` | ~5227 | Manual Save from `VerificationGrid`'s edit dialog — CSV-only now (the dead MongoDB branch this doc previously described was deleted along with `models/Contact.js`, see §6) |
| `GET /webview` | ~6428 | SSRF-guarded (`validateExternalHttpUrl`) proxy that strips security headers so a gov.bd page can be iframed for the edit dialog's live-compare view |
| `GET /extract-image` / `POST /extract-images` | ~6530 / ~6622 | Single-URL and batch officer-photo extraction, backed by `imageFetcher.js` |
| `POST /stage2-scrape` | — (see `useIntelligentPipeline.js`) | The manual "স্ক্র্যাপ করুন" re-scrape; fetch now sends `Cache-Control: no-cache` / `Pragma: no-cache` (added this session) so every click is a genuine live re-fetch, never a stale cached response |

Input to `/verify-contact`: `{ office_name, enrich_web=false, llm_provider='auto', mlAnalysis={} }`. Resolution itself is §4.2/§4.3, not this file — `api.js` only builds `detectedOrgs[]`, calls `officeResolution.resolveDetectedOrgs`, then `aiOfficeFallback.resolveUnmatchedEntities` for anything left over.

### 5.3 Live scraping and photo pipeline

- `scrapeInfoOfficersPage(url, options)` — the core scraper. Normalizes any bare `*.gov.bd` root to `/views/info-officers` (`normalizeGovInfoOfficerUrl` — the standard Bangladesh National Portal officer-listing path); if that fails, `findWideOfficerLink` crawls the homepage for a link containing "info-officers"/"information_officers"/"rti". Every fetch on this path now goes through **`backend/utils/officerUrlGuard.js`** (109 lines, new — `createOfficerUrlGuard({allowPrivateNetwork})`, `.check()`/`.getWithRedirects()`) instead of a bare `axiosGetWithGovTlsFallback` call, closing the SSRF gap the 2026-09-29 snapshot of this document flagged as open (former P3; has its own test file, `tests/officerUrlGuard.test.js`). Uses Cheerio to locate the Bengali headings দায়িত্বপ্রাপ্ত কর্মকর্তা (primary), বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা (alternate), আপীল কর্তৃপক্ষ (appellate) — picking the **shortest** matching element to avoid grabbing an oversized wrapper `<div>` — then reads the officer-detail table following each heading via `pickOfficerTableField`/`OFFICER_TABLE_FIELD_PATTERNS`, a resilient Bengali-label regex extractor tolerant of label variants across different gov.bd portal templates.
- `imageFetcher.js` (1,105 lines) — officer photo pipeline, used only by Section 3 (`/verify-contact`, `/extract-image`, `/extract-images`). 3-tier strategy per `fetchOfficerImage`/`fetchAllOfficerImages`: (1) Playwright/Chromium headless, (2) Cheerio static-HTML fallback, (3) Wayback Machine. Two-tier caching (in-memory + on-disk).
- Photos are attributed to a role **only if that role already has a confirmed officer name** (R3).
- `persistOfficerPhotosLocally` / `syncOfficerPhotoFolder` — downloads remote photo URLs into `shared/officer_photos/<office-slug>/<role>.<ext>` so photos survive even if the source site later removes them.
- `runWebsiteLinkTask` — generic timeout wrapper (`WEBSITE_LINK_MAX_WAIT_MS`, default 7000ms) around every website-touching sub-task, so one slow gov.bd site can't hang the whole request.

### 5.4 Normalization, DB-vs-live diff, and CSV write-back

- `toNormalizedOfficerRecord` (~L892) — canonicalizes a record to `Primary_*/Alternate_*/Appellate_*`.
- `hasMissingOfficerRoleInfo` / `getOfficerRoleFoundStatus` (~L950-979) — drive both the scrape-trigger logic and the `officer_slots` UI flags.
- **`backend/utils/officerDiff.js`** (130 lines, new) — `buildLiveScrapedRecord`/`computeOfficerDiscrepancies`. Before a scrape merges into the working record, `api.js` captures `databaseSnapshot = {...contact}` (the true pre-scrape CSV values); `computeOfficerDiscrepancies(databaseSnapshot, liveScrapedRecord)` then produces a real per-field diff. This is the feature the 2026-09-29 snapshot of this document flagged as **not actually implemented** (former P1: `databaseRecord`/`liveScrapedRecord` were the same object, `discrepancies` hardcoded to all-`false`) — it has since been built. `discrepancies`/`discrepancies_by_match` are `null` (not a fabricated all-false object) whenever no live scrape actually ran for that match. `VerificationGrid.js` highlights any flagged field in red.
- `syncVerifiedRecordToCsv` — wraps `contactLoader.upsertContactInCsv(mode:'auto-reconcile', allowInsert:true, minMatchScore:130)`, writing the best match back into the CSV after every `/verify-contact` call, automatic or not.
- `backend/data/contactLoader.js` (839 lines): `PRIMARY_DATASET_PATH` = repo-root CSV. `loadAllContacts` parses the CSV, dedupes by `buildContactIdentity` (office > website > email > name), merges fragments via `mergeContactRecords` (fills blanks only, never overwrites), and caches keyed on `mtimeMs:size` so any writer invalidates it automatically. `upsertContactInCsv` — the single write path (used by both the auto-sync above and the manual save below): scores every existing row against the incoming update via `scoreCsvRowMatch`, gated by `minMatchScore` to decide "update row" vs. "insert new row", applies changes via `applyContactUpdateToCsvRow` (`auto-reconcile` mode fills only genuinely-changed/missing fields; `manual` mode overwrites), rewrites the whole file, force-reloads the cache.
- `POST /contacts/update` — the manual Save from `VerificationGrid`'s edit dialog. **CSV-only now.** The 2026-09-29 snapshot of this document described a dead "MODE 1: MongoDB" branch here (`Contact.findByIdAndUpdate`, always silently failing); that branch, and the models it depended on, were deleted this session (former P5 — see §6).

### 5.5 Section 2 coupling: `rtiDatabaseLookup.js`

Documented in `s2_na.md` as Section 2's read-only enrichment engine, but architecturally tied to Section 3: it imports `PRIMARY_DATASET_PATH` directly from `contactLoader.js`. `getDatabase()` re-checks the CSV's mtime/size signature on every call *specifically* because Section 3 writes verified data back into the CSV mid-session. `matchEntity` has hard safety limits (`MATCH_TIMEOUT_MS=1000`, `MAX_MATCH_ATTEMPTS=50`) so it can never hang the analysis pipeline. `enrichEntities`/`enrichOfficerSlot` never fabricate — an unmatched officer field stays blank.

---

## 6. Legacy and orphaned code

- **MongoDB scaffolding, unused in this deployment — since deleted.** `backend/models/Contact.js`, `backend/models/Template.js`, `backend/config/db.js`, `backend/scripts/seed.js`, and `/contacts/update`'s dead MongoDB branch were all present as of 2026-09-29 and have since been removed entirely (confirmed absent from the working tree). This is the resolution of that snapshot's P5.
- **`backend/utils/urlValidator.js` / `backend/utils/scraperMapper.js`** — also since deleted (former P4). The live SSRF guards are `validateExternalHttpUrl`/`utils/egressGuardProxy.js` (Section 1's reader) and `utils/officerUrlGuard.js` (Section 3's scraping path, §5.3).
- **Offline data-collection scripts** (`backend/scripts/`), none invoked by the running server, all targeting the old `gov_contacts*.json`/MongoDB rather than today's live CSV — still present (not part of this session's cleanup):
  - `collect_rti_officers_govbd.js`, `discover_govbd_directories.js`, `generate_gov_csv.js`, `govCorpScraper.js`, `import_rti_sheet_csv.js`, `scrape_bd_gov.js`, `convertCSVContacts.js`, `batch_officer_photos.py`.
- `backend/routes/admin.js` and `backend/routes/gps-v2.js` / `frontend/public/jaani-gps-v2.js` — confirmed **unrelated** to officer verification (activity analytics and GPS location-tracking respectively).

---

## 7. Security model

| Surface | Protection |
|---|---|
| `/api/webview` (live-compare iframe) | `validateExternalHttpUrl(url, {allowPrivateNetwork: ALLOW_PRIVATE_NETWORK_URLS})` before fetching; strips CSP/X-Frame-Options/COOP/COEP/CORP/HSTS deliberately so the gov.bd page can be iframed for manual comparison |
| Officer-scraping path (`scrapeInfoOfficersPage`, `imageFetcher.fetchOfficerImage`/`fetchAllOfficerImages`) | Now goes through `officerUrlGuard.check()`/`.getWithRedirects()` (§5.3) — this closes the SSRF gap the prior snapshot of this document flagged as open |
| `getStealthHeaders` | Browser-impersonation headers used against gov.bd sites to get past basic bot-blocking — intentional and documented, not itself a vulnerability |
| CSV write path (`upsertContactInCsv`, auto or manual) | No auth/rate-limit visible in the traced code — any client that can reach the backend can rewrite officer contact records, which then flow into Section 4's auto-filled recipient list; still an open data-integrity risk (§8 P9) |
| Officer photos | Downloaded and re-served from `/shared/officer_photos/...` (server-side, not hotlinked) |
| AI fallback classification (§4.3) | Never writes to the CSV itself — only picks among names already in the CSV's own ministry/office lists, validated by exact match or bounded edit distance; a misclassification can at worst show the wrong *existing* office, never fabricate a new one |
| `GET /offices-list` | Read-only listing of already-public CSV data (Ministry/Division/Office names only, no officer PII); no new exposure |

---

## 8. Open problems

| # | Problem | Where | Confidence | Impact |
|---|---|---|---|---|
| P2 | The "fast, DB-only" pass (`enrich_web:false`) is not guaranteed fast: the backend still live-scrapes whenever the top-ranked office's CSV row is missing officer data for any role (`shouldScrapeWebsite`, `api.js` ~L4941), undermining the documented fast/slow two-phase latency guarantee for any office with an incomplete row | `api.js` `shouldScrapeWebsite` logic | Confirmed, still open | Any incomplete-row office makes the "instant" first pass network-dependent |
| P7 | The dataset has grown iteratively (59 → 245 → 279 → 280 rows) rather than through one confirmed batch pass across a fixed target count; "you can't always find 100%" is now an explicit accepted constraint (§3), not an open question the way the 2026-09-29 snapshot framed it. What's unconfirmed: whether every populated row's photo extraction was re-verified after the dataset's later growth phases | §3; session history | Open, lower severity than before | Unknown whether photo-extraction success has been re-measured across the full 280-row set (as opposed to each individual batch at the time it was added, which *was* verified) |
| P8 | No "live officer-freshness check" exists — `Last_Updated` is stamped on write, but there is no proactive staleness warning, scheduled re-verification job, or UI signal for an aging record | Whole section | Confirmed (by absence) | A record verified once can silently go stale with no prompt to re-check |
| P9 | No auth/rate-limit found on the CSV write path (§7) | `contactLoader.upsertContactInCsv` callers | Confirmed (by absence in traced code) | Possible data-integrity risk on a public-facing tool |
| P10 | The AI fallback (§4.3) makes a real LLM call (two, worst case) for every genuinely uncurated entity the first time it's seen — cached forever after, but the cache (`backend/data/aiFallbackCache.json`) never invalidates or expires even if the CSV later changes (an office gains a row of its own, or a ministry is renamed), and isn't gitignored, so it will accumulate indefinitely and could go stale relative to the dataset | `aiOfficeFallback.js` `loadCache`/`saveCache` | Confirmed (by design, not yet a problem in practice) | A stale cache entry could keep resolving an entity one rung higher (or to a now-wrong office) than the current CSV would justify; no cache-busting mechanism exists yet |
| P11 | The gazetteer's generic `AGENCY_PARENTS` entry for medical colleges (`['মেডিকেল কলেজ']` → DGME, added this session) matches any text containing that bare phrase — correct for the ~40 government medical colleges it's meant to generalize over, but has no allowlist/denylist, so an article mentioning a *private* medical college would also route to DGME, which is only the right authority for government ones | `rtiGazetteer.js` `AGENCY_PARENTS` | Confirmed (by design) | Low real-world impact (most Bangladeshi news coverage naming a "মেডিকেল কলেজ" by context is about a government one) but not verified against a private-college example |
| P12 | `manualMatches` (§4.4) lives only in React state — a manually-added card is lost on page refresh/re-submission, unlike the automatic pipeline's results which are at least re-derivable from the same article | `Home.js` `manualMatches` state | Confirmed (by design) | Minor UX gap, not a correctness issue |

**Resolved since the 2026-09-29 snapshot** (kept here for continuity, not re-verified beyond what §4-§6 already show): former P1 (DB-vs-live diff was fake) — built, §5.4. Former P3 (no SSRF guard on the scrape path) — `officerUrlGuard.js`, §5.3/§7. Former P4 (`urlValidator.js`/`scraperMapper.js` dead code) — deleted, §6. Former P5 (MongoDB scaffolding) — deleted, §6. Former P6 (`discrepancies` payload unread by the frontend) — now real and read (`VerificationGrid.js` highlights flagged fields in red).

---

## 9. Requirements and decisions from chat history (detail)

### 9.1 From `chat history/JAANI07_chat.md` (unchanged from the 2026-09-29 snapshot)

- "use this as officers dataset @JAANI_RTI_OFFICERS_COMPLETE.csv ... no blockage ... image extraction must be successful" (L7) — set the CSV as canonical and made "images must never fail" a hard requirement, driving the 3-tier Playwright→Cheerio→Wayback pipeline in `imageFetcher.js`.
- CSV schema requirement (L10): 26-column canonical schema, exactly 3 roles per office, blanks stay blank.
- Screenshot feedback (L60): photo-extraction complaints that led to the heading-length-based fix stopping a wrapper `<div>` from being matched instead of the real Bengali heading.
- Explicit plan (L98): point `contactLoader.js` at `JAANI_RTI_OFFICERS_COMPLETE.csv`, then batch-run `verify-contact` with `enrich_web:true` to populate and persist photo URLs.
- Provider/tooling constraints: keep the 4-section structure; only OpenAI + Grok + Kimi as LLM providers; make sure Playwright/Wayback work and explore all fallback options.
- Live debugging evidence (L361-615): a `sed`-based hot-fix applied live to `VerificationGrid.js` to stop alternate/appellate role images incorrectly defaulting to the primary image — the concrete origin of R3.

### 9.2 From the 2026-09-30/10-01 session (this document's author's direct participation — no separate chat-log file)

- **Ministry-coverage minimum bar**: "the min standard is you need to cover all kinds of ministries at least" — every one of the 44-45 ministries must have at least some officer data or an explained, investigated reason it doesn't; closed almost completely, the 1-2 remaining gaps are externally blocked (Cloudflare) or genuinely undocumented at source, not fixable by more scraping.
- **Explicit "not 100%" release from the same conversation**: "IT IS ALWAYS POSSIBLE THAT SOME DIVISION OR OFFICES DOES NOT HAVE ANY OFFICER OR 50% INFO ... YOU CANT ALWAYS FIND 100%" — directly shaped the decision to keep genuinely-blank CSV rows rather than treat them as failures, and to lean on the office→division→ministry ladder instead (§3, §4.2).
- **Scope boundary, explicitly chosen over a much larger expansion**: offered the full ~800-entity bangladesh.gov.bd national directory (57 ministries / 287 departments / 473 "other" bodies); the user chose "just the 287 অধিদপ্তর (departments)" and explicitly declined the 473-entity "other" tier (boards, trusts, companies, universities, medical colleges) for bulk addition. Universities/medical colleges were later handled not by bulk row-addition but by the AGENCY_PARENTS generalization in §4.2 (a specific medical college needing a CSV row was rejected in favor of "for medical colleges, route to DGME generically" — see P11).
- **Translation requirement**: "if it is in english, you obviously need to translate in bangla as the dataset is in bengali" → R7, §4.3.
- **The MoHA/"Mohammad" false positive**: a real article about the Agriculture Minister, "Mohammad Amin Ur Rashid," was wrongly tagged with স্বরাষ্ট্র মন্ত্রণালয় (Home Ministry) because the gazetteer's "MoHA" alias had no end-of-word boundary check and matched inside the minister's own name. Found via direct reproduction (not by guesswork) and fixed in `rtiGazetteer.js`'s `scanNormalized` (§4.2).
- **"No pre saved in section 3...just show those are detected in organization"** → R9; removed `buildVerificationRecordFromExtraction`/`verification_prefetch` from `Home.js`.
- **Search bar / dropdown request, with an explicit bug report** ("the search bar is available...but is not connected with dataset because nothing is shown") that traced to the `manualMatches` race condition (§4.4), not a resolution-logic bug — the search bar itself worked in isolation every time it was tested; the failure only showed up when a slower automatic verification call landed afterward and overwrote it.
- **"There will always be a try to live scraping when clicked on the button"** → the scrape button's hardcoded `'gemini'` provider (unconfigured in this deployment) was changed to `'auto'`, and the backend fetch got no-cache headers, so a click is never silently a no-op or a stale-cache hit.
- **Section 1 asks bundled into the same session but out of this document's scope**: "ensure all kinds of papers link will work" (kalerkantho.com losing all but its first paragraph — a CMS pattern where each paragraph is wrapped in its own same-class `<article>` tag — fixed in both `playwrightExtractor.js` and `api.js`'s cheerio path), "remove wayback archive...strengthen the power of live tab" (Wayback tab removed from `AnalysisAccordion.js`, reader allowlist expanded from 4 to 21 curated outlets). See `s1_rtn.md`.

---

## 10. How to run and check it

```bash
# backend (5005)
cd backend && node index.js

# frontend (3000, proxies /api → 5005)
cd frontend && BROWSER=none npm start

# DB-only verification for one office
curl -s -X POST localhost:5005/api/verify-contact -H 'Content-Type: application/json' \
  -d '{"office_name":"স্বরাষ্ট্র মন্ত্রণালয়","enrich_web":false}' | head -c 1500

# live-enriched verification (up to 120s)
curl -s -X POST localhost:5005/api/verify-contact -H 'Content-Type: application/json' \
  -d '{"office_name":"স্বরাষ্ট্র মন্ত্রণালয়","enrich_web":true}' | head -c 1500

# multi-organization resolution grounded on Section 2's detected orgs (R7/§4.1)
curl -s -X POST localhost:5005/api/verify-contact -H 'Content-Type: application/json' \
  -d '{"office_name":"x","mlAnalysis":{"gov_body_matches":["Department of Fisheries","কুমিল্লা মেডিকেল কলেজ"]},"enrich_web":false}' | python3 -m json.tool

# the browse dropdown's backing list (§4.4)
curl -s localhost:5005/api/offices-list | python3 -m json.tool | head -20

# officer photo extraction for one gov.bd office page
curl -s "localhost:5005/api/extract-image?url=https://moha.gov.bd/views/info-officers&count=3"

# list all CSV contacts (diagnostic)
curl -s localhost:5005/api/contacts | head -c 1000

# backend test suite (includes officerUrlGuard.test.js and the office-resolution tests)
cd backend && node --test tests/**/*.test.js
```
After frontend changes, hard-refresh the browser (Cmd+Shift+R).
