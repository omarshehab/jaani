# TASK: Rebuild JAANI Section 3 (backend + frontend) with the same UI

Section 3 is the RTI Officers Directory: the cards under the analysis that show each office's Primary / Alternate / Appellate officer, and the "তুলনা ও সম্পাদনা" dialog. It currently shows irrelevant offices, blank cards, wrong warnings and the wrong email recipients. Patching the old cascade has not worked, so **rebuild the Section 3 logic on both sides**: how offices are chosen, how each one is resolved to a CSV row, what the API returns, and how the frontend holds and renders that state.

**The UI must look the same.** The four screenshots in `frontend/ui folder/` (`s3.1.png`–`s3.4.png`) are the visual contract (§3). Only the logic behind them changes, plus the text changes listed in §6.7.

Sections 1 and 2 are FROZEN. Section 4's UI is not touched.

Read first: `section files/s3_RTIod.md`, `section files/s2_na.md`, `section files/s1_rtn.md`.
- `s3_RTIod.md` is partly stale: it says 59 CSV rows and gives old line numbers. Use it for background and trust the code.
- `JAANI_CONTEXT_HANDOFF.md` is **not in the repo**. If the user has not supplied it, work from the three section files and say so in the report; do not guess its contents.

Standing rules:
- Find the root cause before changing anything.
- Never hand-edit CSV cells.
- Verify with real-browser screenshots only, never mockups.
- No `git commit`.
- Keep each file's existing line endings. Some files are CRLF; check with `git diff --stat` that no file shows as wholly changed.
- No new API spend for testing: use the cached "Previous news" entries.

---

## 0. Scope

### 0.1 Frozen (zero bytes changed)

- **Section 1:** `liveProxyReader.js`, `utils/egressGuardProxy.js`, the highlight utilities, `/prepare`, `/read`, `/analyze`.
- **Section 2:** all of `frontend/src/components/AnalysisAccordion.js` (including the "Section 3c-pre" RTI preview card), `rtiGazetteer.js`, `rtiDatabaseLookup.js`, `locationGazetteer.js`, `rtiActGuidance.js`, `geminiAnalysis.js`, `forensicEvidence.js`, `factCheck*.js`, `googleNewsDecoder.js`, `config/llmTaskRouting.js`, `/analyze-text`, `/extract-entities`, `/rti-guidance`, `/related-news`, `/download-pdf`.
- **Scraper:** `scraper/jaani_scraper/**` and `scraper/out/**`.
- **Dataset:** the repo-root `JAANI_RTI_OFFICERS_COMPLETE.csv` is never hand-edited.
- **Existing Section 3 utilities that already work:** `backend/utils/roleHeadings.js`, `officerDiff.js`, `officerUrlGuard.js`, `textIntegrity.js`, and `backend/services/imageFetcher.js`. Reuse them; don't rewrite them.

### 0.2 Rebuild (Section 3 only)

**Backend**
- `POST /verify-contact` in `backend/routes/api.js` (currently ~L4927). Replace the candidate cascade, the response assembly and the write-back. The handler should become thin.
- New pure module `backend/utils/officeResolution.js`: grounding, ladder, dedupe, notices. No I/O, fully unit-tested, same pattern as `roleHeadings.js` / `officerDiff.js`.
- Optional new `backend/services/officerVerification.js` for the orchestration (scrape, photos, per-match flags), so the logic moves out of `api.js`.
- Helpers in `api.js` used **only** by `/verify-contact` may be replaced or deleted. These are in scope if nothing else calls them (check with grep before deleting): `selectTopOfficesFromAnalysisSignals`, `rankTopOfficesForRequestedText`, `scoreOfficeCandidateForRequestedText`, `selectTopOfficesByKeyword`, and the home-grown `searchWebForOffice`.
- Keep and reuse unchanged: `scrapeInfoOfficersPage`, `toNormalizedOfficerRecord`, `persistOfficerPhotosLocally`, `runWebsiteLinkTask`.
- `backend/data/contactLoader.js`: **additive only**. You may add one exported function that updates a row by exact `Ministry|Division|Office` key. Existing functions must be unchanged; the diff must contain additions only.

**Frontend**
- `frontend/src/components/VerificationGrid.js`: rebuild the state and logic. Keep the rendered layout and styling (§3). Moving logic into new files (for example `frontend/src/hooks/useOfficerVerification.js`) is fine.
- The Section 3 blocks in `frontend/src/pages/Home.js`: `buildVerificationRecordFromExtraction`, `deriveOfficeQueryFromAnalysis`, `startVerification`, `handleVerifyContact`, `handleRetryVerification`, `handleUseCacheVerification`, `handleFallbackSearch`, `handleContactUpdated`, the image-prefetch effect, the `<VerificationGrid>` render sites and the email-recipient seeding.
- `frontend/src/hooks/useIntelligentPipeline.js` and the `verifyContact` wrapper in `frontend/src/api/axiosConfig.js`, only if the new response fields need it.
- `frontend/src/i18n/bn.json` / `en.json`: you may add a `verification.*` block. Do not change existing keys.

### 0.3 Enforcement

1. Before touching anything, copy every file named in §0.1 and §0.2 into `/tmp/s3rebuild_baseline/` and record `sha256sum` of every frozen file.
2. After finishing, re-hash the frozen files; they must be identical. `diff` the shared editable files (`api.js`, `Home.js`, `contactLoader.js`, `axiosConfig.js`) against the baseline. Every hunk must fall inside Section 3 code. Paste the hunk list in the report.
3. If you need Section 2's data, `require` an exported symbol read-only. `rtiGazetteer.js` already exports `matchGovernmentBodies`, `pickRowForBody`, `rowHasOfficers`, `parentRowWithOfficers`, `normalizeText`. Read what each one does before relying on it. If something you need isn't exported, derive it from the CSV columns; do not edit the file.
4. Section 2 legitimately shows a duplicate Home Ministry card (DMP and Police both map to it). Do not touch that.

---

## 1. Ground truth, verified in the repo on 2026-09-30

**CSV: 245 rows, 26 columns, no duplicate `Ministry|Division|Office` keys.** Rows use four hierarchy encodings:

| Count | Encoding | Meaning |
|---|---|---|
| 42 | `Ministry == Division == Office` | the ministry-level row |
| 25 | `Division == Office`, `Division != Ministry` | a division-level row |
| 53 | `Division == Ministry`, `Office` differs | an office directly under the ministry |
| 52 | `Division` equals another row's `Office` | an office under a parent that has its own row |
| 73 | `Division` has no row of its own | an office whose division rung does not exist |

- 44 ministries appear; **2 have no ministry-level row** (অর্থ মন্ত্রণালয়, নৌ-পরিবহন মন্ত্রণালয়).
- 51 rows have no named officer in any role.

**The DMP chain (test article):**

| Rung | Row (`Ministry \| Division \| Office`) | Officers |
|---|---|---|
| office | স্বরাষ্ট্র মন্ত্রণালয় \| পুলিশ হেডকোয়ার্টার্স বাংলাদেশ পুলিশ \| ঢাকা মেট্রোপলিটন পুলিশ (`dmp.portal.gov.bd`) | none |
| division | স্বরাষ্ট্র মন্ত্রণালয় \| স্বরাষ্ট্র মন্ত্রণালয় \| পুলিশ হেডকোয়ার্টার্স বাংলাদেশ পুলিশ (`police.portal.gov.bd`) | **none** |
| ministry | স্বরাষ্ট্র মন্ত্রণালয় \| স্বরাষ্ট্র মন্ত্রণালয় \| স্বরাষ্ট্র মন্ত্রণালয় (`moha.gov.bd`) | populated (মো: তোফায়েল হোসেন / নাসরীন সুলতানা / আপীল) |

So this article exercises "office empty → division row exists but empty → ministry". It is **not** the "no division row" case.

**Other rows used by the screenshots:**
- নির্বাচন কমিশন সচিবালয়: `Ministry == Division == Office`, no officers, site `ecs.gov.bd`. It has no parent to climb to.
- বাণিজ্য মন্ত্রণালয় (ministry row): Primary শাম্মী ইসলাম (১৬৫২৮); Alternate empty.
- বাংলাদেশ প্রতিযোগিতা কমিশন: directly under বাণিজ্য মন্ত্রণালয়, fully populated.

**Test article (Prothom Alo, DMP, 2026-09-30):**
- DMP detained 40 "active members" of the banned Awami League in 24 hours; 401 arrested in regular drives; 26 cases. Dhaka.
- AI category: Law & Justice (90%).
- Detected organisations: ঢাকা মহানগর পুলিশ, ডিএমপি, পুলিশ, ডিএমপির গণমাধ্যম ও জনসংযোগ বিভাগ, ঢাকা মেট্রোপলিটন পুলিশ, স্বরাষ্ট্র মন্ত্রণালয়.
- Section 2 (correct): shows স্বরাষ্ট্র মন্ত্রণালয়'s officers with the escalation notice.
- Section 3 (broken) shows 4 cards:
  1. `স্বরাষ্ট্র মন্ত্রণালয় - ঢাকা মেট্রোপলিটন পুলিশ`: all three roles empty.
  2. `আইন, বিচার ও সংসদ বিষয়ক মন্ত্রণালয়`: irrelevant, empty.
  3. `কৃষি মন্ত্রণালয়`: irrelevant, populated.
  4. `স্বরাষ্ট্র মন্ত্রণালয়`: the only correct card, last, populated, yet showing "role missing" chips.

**Test baseline:** `cd backend && npm test` → 281 Node tests pass (`node --test`). The scraper suite and `compat-check` are reported as 419 and 51/51; confirm both before starting.

---

## 2. Defects

From the DMP article:

- **D1 Irrelevant offices.** Law & Justice (probably from the AI category or `related_ministries`) and Agriculture (cause unknown) are not in the article. The cascade pads up to the cap of 4.
- **D2 Dead-end blank card.** A row with no officers renders "Officer data not available" instead of climbing to its parent.
- **D3 Duplicate resolution.** Several entities resolve to the same officers and must collapse into one card.
- **D4 Wrong status per card.** "partial role data", "role missing" chips and "Incomplete Officer Data" appear on fully populated cards, because response-level `officer_slots` / `partial_success` / `network_status` (computed for `matches[0]`) are applied to every card.
- **D5 English strings** in Section 3. See §6.7.
- **D6 Recipient contamination (legal risk).** Section 4's recipient list takes `Primary_Email` from every match; a police story gets `admin2@moa.gov.bd` (Agriculture).
- **D7 CSV write-back risk.** `syncVerifiedRecordToCsv(matches[0], auto-reconcile, allowInsert:true, minMatchScore:130)` matches rows by fuzzy score. Fallback officers must never be written into the requested row, and no row may be inserted. This is the same failure family as the earlier `lawjusticediv` pollution.
- **D8 Ordering.** The article's primary target must be card 1.

From the screenshots:

- **D9 Crash on a card** (`s3.1.png`, card 2 নির্বাচন কমিশন সচিবালয়): the card is replaced by the raw error `null is not an object (evaluating 'result.success')`. Find which call returns `null` (start at `VerificationGrid.js` ~L610 and `handleScrapeOfficerDetails` ~L659) and make every Section 3 fetch handle a null/failed result with a Bengali message inside the card. No raw JavaScript error text may reach the user.
- **D10 Stale data not flagged** (`s3.3.png`, `s3.4.png`): for বাণিজ্য মন্ত্রণালয় the dataset says Primary = শাম্মী ইসলাম (১৬৫২৮), উপসচিব (আইন শাখা), while the live page in the right pane shows মোঃ সারোয়ার সালাম (১৭৭৮৪), সিনিয়র সহকারী সচিব. The dialog says "0 পরিবর্তন" and highlights nothing. The DB-vs-live comparison must work per card and highlight differing fields (use `officerDiff.js`).
- **D11 Role with no published name** (`s3.4.png`): the live Alternate block has a designation, phone and email but an empty নাম. Keep the existing name-gating: the role stays "not published" and nothing is borrowed. In the dialog, show the live values as a suggestion for manual review; never auto-write them.
- **D12 Empty form for a rung-4 office** (`s3.2.png`): নির্বাচন কমিশন সচিবালয় has no officers and no parent. It should show the compact "no data" card (§6.4), with the dialog still available for manual entry.

Mark each of D1–D12 confirmed or refuted in Phase 0. If the facts contradict a hypothesis here, state the real root cause and adapt; do not force the design onto wrong facts.

---

## 3. UI contract: what "same UI" means

Take baseline screenshots of the current app in the same states as `s3.1`–`s3.4` (1280 px wide) **before** changing anything, and again after. They must match in layout, colours, fonts, spacing and components.

**Card** (`s3.1.png`), top to bottom:
- Numbered line above the card: `1: <মন্ত্রণালয়> - <অফিস>`.
- Dark-green header: "যাচাইকৃত তথ্যভাণ্ডার", the sub-label "RTI OFFICER DIRECTORY", the "যাচাইকৃত" badge, and the two buttons "স্ক্র্যাপ করুন" and "তুলনা ও সম্পাদনা" on the right.
- Office block: label "অফিস / দপ্তর", the office title, and the `মন্ত্রণালয় — অফিস` sub-line.
- Three role cards: দায়িত্বপ্রাপ্ত কর্মকর্তা (ক) with a green header; বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা (খ) with a maroon header; আপীল কর্তৃপক্ষ with a blue header, full width below. Each has a photo, name, designation in italics, ফোন / মোবাইল / ইমেইল / ঠিকানা rows and a "vCard ডাউনলোড" button.
- Footer: the website link, then the dark strip "JAANI — তথ্য অধিকার আইন ২০০৯ … গণপ্রজাতন্ত্রী বাংলাদেশ সরকার".
- Hint line under the card.

**Dialog** (`s3.2.png`–`s3.4.png`):
- Header "তথ্য যাচাই ও হালনাগাদ" with the "N পরিবর্তন" counter and the close button.
- Left pane: the info banner, then field groups অফিস / দপ্তর, দায়িত্বপ্রাপ্ত কর্মকর্তা (ক), বিকল্প কর্মকর্তা (খ), আপীল কর্তৃপক্ষ, with rounded outlined fields.
- Right pane: the browser-style frame (three dots, URL bar, reload, the "লাইভ ট্যাব" button), the proxied live page, and the green status strip.
- Footer: the change summary on the left; "বাতিল" and "পরিবর্তন সংরক্ষণ" on the right.

**Allowed visible changes, and nothing else:**
- The per-card notice and the "সংবাদে উল্লিখিত: …" sub-line (§6.4).
- English → Bengali strings (§6.7).
- Warnings that disappear from cards that have full data (D4).
- Red/yellow discrepancy highlighting where data really differs (D10).
- The compact rung-4 card replacing an empty three-card grid.

`s3.1.png` also shows Section 2's old "Download evidence bundle (ZIP)" button. That is outdated (it now reads "Download PDF") and is not part of this task.

---

## 4. PHASE 0: diagnose before coding (no source edits)

Use the cached "Previous news" entry for the DMP article. Add a temporary debug log to `/verify-contact` (remove it afterwards) and produce this table:

| card | resolved row key | which strategy produced it (1–4 / web search / fuzzy / last resort) | score | grounded in the article text? (matched string) |

Also capture:
- The exact `office_name` string and `mlAnalysis` payload `Home.js` sends.
- Whether `mentioned_gov_orgs`, `gov_body_matches` and `enriched_entities` from Section 2 are present in `analysisData`.
- Why the DMP and Police HQ rows have no officers: blank portal page, scrape failure, or never scraped.
- How `officer_slots` / `partial_success` / `network_status` are computed and consumed.
- The call that returns `null` in D9.
- Why D10's difference is not flagged.

---

## 5. Backend design

### 5.1 Candidates: grounded only

- Candidates are the government bodies actually present in the article: Section 2's `gov_body_matches` / `mentioned_gov_orgs` / `enriched_entities`, read from `analysisData` and sent in the request. Add `rti_target_office` **only if** its name or an alias literally appears in the article text.
- Drop everything else:
  - AI-category and `related_ministries` guesses
  - keyword n-gram padding
  - LLM and web-search office lookups
  - the hard-coded three offices
  - the "first 3 CSV rows" last resort
- Never pad. One correct card beats four noisy ones. Keep the hard cap of 4.
- Order: the primary target first, then by first appearance in the article.
- For Bengali matching use the normalisation in `roleHeadings.js` or `rtiGazetteer.normalizeText`, not `api.js`'s `normalizeForMatch` (it has a য় normalisation gap).
- A direct request with no analysis (the `curl` examples in `s3_RTIod.md` §10, or a manual search) still works: match `office_name` against the CSV by exact normalised name or alias only.

### 5.2 Resolution ladder (pure function in `officeResolution.js`)

Rungs, in order: **office → division → ministry → none.**

Parents come from the row's own columns:
- **Division rung:** the row whose `Office` equals this row's `Division`, within the same `Ministry`, when that is a different row.
- **Ministry rung:** the row with `Ministry == Division == Office` for this row's `Ministry`. If the ministry has no such row, there is no ministry rung. Do not fan out into the ministry's other rows.
- A row that is itself the ministry row has no parents.
- An entity with no CSV row at all (for example "পুলিশ") gets its parent from the gazetteer's agency → parent mapping through an existing export; otherwise rung 4.

Rules:
- A rung "has officers" if, after the existing name-gating, at least one role has a non-empty, non-placeholder `*_Officer_Name` (`test` and similar count as empty).
- Live scraping: try a rung's own `Website_Link` only when that rung's row has no officers. Do not scrape a division or ministry row that already has CSV data. Respect the existing timeouts and the 120 s overall cap.
- Resolve at the first rung with at least one named role. **Never mix roles across rungs** (no Primary from one row and Alternate from another). Missing roles inside the resolved row stay "not published".
- Record every skipped rung: `{ rung, label, reason }`, with reason `no_row` | `no_officers` | `page_blank` | `no_rti_page` | `scrape_failed`.

### 5.3 Dedupe

Key = the resolved `Ministry|Division|Office`. Entities resolving to the same row collapse into one card carrying `requestedEntities`.

For the DMP article the result must be **exactly one card: স্বরাষ্ট্র মন্ত্রণালয়**, with `requestedEntities` = ঢাকা মেট্রোপলিটন পুলিশ / ডিএমপি / পুলিশ, and both the DMP and Police HQ rungs recorded as skipped.

### 5.4 Response contract (`/verify-contact`)

Keep the existing top-level keys for backward compatibility. Add, per item of `matches[]`:

```
resolution: { requestedEntities, requestedRowKey, resolvedRowKey,
              rung: 'office'|'division'|'ministry'|'none',
              skipped: [{ rung, label, reason }], noticeBn }
officer_slots, partial_success, network_status, discrepancies, liveScrapedRecord
```

- `discrepancies` compares the resolved row's own CSV snapshot with its own live scrape, never the requested row against the fallback row.
- `databaseRecord` and `liveScrapedRecord` must be two distinct objects when a live scrape ran (today they are the same object).

### 5.5 Persistence

- Write back only to the **resolved** row, matched by exact row key, with that row's own scraped data, `allowInsert: false`. Use the new exact-key function in `contactLoader.js`; do not go through the fuzzy `scoreCsvRowMatch`.
- Never write a parent's officers into a child row. Never insert a row.
- The manual Save (`POST /contacts/update`) targets the resolved row by exact key as well.
- Every URL scraped or proxied in Section 3 goes through `officerUrlGuard.js` (there is an open SSRF note on this path in `s3_RTIod.md` §7).

---

## 6. Frontend design

### 6.1 State
One state object per card, built from that card's own `matches[i]` fields. No card reads response-level flags.

### 6.2 Warnings
Banner, chips and network status render from the card's own flags. A card with full data shows no warning. "আংশিক নেটওয়ার্ক" appears only when that card's own fetch failed.

### 6.3 Targets
The edit dialog, "স্ক্র্যাপ করুন", "তুলনা ও সম্পাদনা", the live-compare iframe and the footer link all use the **resolved** row's `Website_Link` (for the DMP article, `moha.gov.bd`, not `dmp.portal.gov.bd`). Save posts against the resolved row only.

### 6.4 Notices (Bengali, one per card)
The wording follows Section 2's pattern. Put the templates in Section 3 code; do not edit Section 2.

- Division rung: `«{অফিস}»-এর নিজস্ব RTI কর্মকর্তার তথ্য ডেটাসেটে নেই, তাই {বিভাগ}-এর তথ্য দেখানো হচ্ছে।`
- Ministry rung: `«{অফিস}» ও «{বিভাগ}»-এ কোনো RTI কর্মকর্তার তথ্য নেই, তাই {মন্ত্রণালয়}-এর তথ্য দেখানো হচ্ছে।` Drop the division clause when no division rung exists.
- None: `«{সংস্থা}», এর বিভাগ ও মন্ত্রণালয়ের কোনোটিতেই RTI কর্মকর্তার তথ্য পাওয়া যায়নি।` Render it as one compact info card in the existing card frame: no empty role cards, the two header buttons still available for manual entry.
- Sub-line on every card: `সংবাদে উল্লিখিত: <requestedEntities>`.
- Never show "খালি / তথ্য নেই" as the final state of a rung that still has a parent to try.

### 6.5 Recipients for Section 4
Seed only from the deduped, resolved cards. Flag recipients that come from a division or ministry fallback in the state, so Section 4 can label them later. Do not change Section 4's UI.

### 6.6 AI fallback
Remove the automatic "Stage 3 AI-synthesised" officer data from the automatic path; rung 4 replaces it. "ম্যানুয়ালি খুঁজুন" may stay as an explicit user action, clearly labelled unverified, and it never seeds recipients.

### 6.7 Strings: Bengali only in Section 3
Replace at least these:

- Card and banner text: "Verification completed with partial role data…", "Fetch from Local Cache", "Try Manual Search", "Primary/Alternate/Appellate role missing", "Incomplete Officer Data…", "Network Status: PARTIAL…", "Officer data not available", "Enable website scraping to fetch additional details".
- Dialog field labels (`s3.2.png`): "Primary Designation", "Primary Phone", "Primary Address", "Alternate Phone", "Alternate Address", and the matching Appellate labels.
- Dialog status text: "Loading website iframe", "85% complete", "ETA: 2s left", "Backend proxy সক্রিয়".

Suggested button and chip text: "স্থানীয় ক্যাশ থেকে আনুন", "ম্যানুয়ালি খুঁজুন", "প্রাথমিক/বিকল্প/আপীল কর্মকর্তার তথ্য নেই".

Leave Section 4's Compose block ("Compose", "Not connected", "Verify / Connect") alone and list it in the report.

### 6.8 Keep
Keep the earlier Bug B/C fixes, the role-gated photos (no borrowed images) and the vCard download.

---

## 7. Tests (all must pass; report counts)

**Node**: new `backend/tests/officeResolution.test.js` (pure logic), covering:
- office has data (no climb)
- office empty, division has data
- **office empty, division row exists but empty, ministry has data (the DMP case)**
- office empty, no division row, ministry has data
- ministry without a ministry-level row → rung 4
- ministry row itself empty with no parent → rung 4 (নির্বাচন কমিশন সচিবালয়)
- partial roles at one rung (no cross-row mixing)
- three entities deduped to one card
- an ungrounded AI ministry excluded
- placeholder names treated as empty
- all four hierarchy encodings from §1

The existing 281 tests stay green.

**Python**: the scraper suite stays untouched and green.

**`compat-check`**: extend the fixtures with a blank DMP-style page, a blank division page, a populated ministry page and a division-level case. The existing matrix stays green, including the `moha` and `lawjusticediv` role-heading controls.

**CSV safety** (run on a sandbox copy, as `compat-check` does):
- After the DMP article, the DMP and Police HQ rows are byte-identical to before.
- No rows are inserted.
- The "identical name + phone + email across two roles or rows" audit over all 245 rows returns 0.

**Real browser** (Playwright against `localhost:3000`, cached "Previous news", view every screenshot yourself before claiming success):
1. DMP article → exactly one card (স্বরাষ্ট্র মন্ত্রণালয়) with the ministry-rung notice naming DMP and Police HQ, populated roles, no warning banner, and no Law or Agriculture card.
2. Section 4's recipients contain only the Home Ministry emails.
3. UI parity: before/after screenshots of the card and the dialog in the `s3.1`–`s3.4` states.
4. Sections 1 and 2 unchanged (Live Page button present, Section 2 cards identical).
5. Rung "division" and rung "none" cases (compat sandbox or a second cached article). The নির্বাচন কমিশন সচিবালয় card shows the compact notice and no JavaScript error (D9, D12).
6. বাণিজ্য মন্ত্রণালয় + বাংলাদেশ প্রতিযোগিতা কমিশন → two cards, in article order. The বাণিজ্য মন্ত্রণালয় dialog flags the Primary officer difference (D10).

---

## 8. Report format

1. The Phase 0 table and root causes; D1–D12 each marked confirmed or refuted.
2. Files changed with line ranges; the frozen-file hash proof; the baseline-diff hunk list; `git diff --stat` showing no wholesale line-ending changes.
3. Test counts and screenshot paths.
4. Issues found in Sections 1, 2 or 4: list only, do not fix.
5. Update `section files/s3_RTIod.md` to describe the rebuilt section (245 rows, the ladder, the new response contract, the current line numbers).
6. Stop before commit; draft a commit message for review.

---

## 9. Out of scope: list, don't fix

- **Evidence certificate:** the chain of custody can log the Internet Archive save as HTTP 429 while section 4 of the certificate shows a snapshot URL stamped earlier than the capture (a pre-existing snapshot presented as this capture's copy). Needs a follow-up in the evidence module.
- **Section 4's Compose UI** is entirely English.
- **`normalizeForMatch` in `api.js`** has a য় (U+09DF vs U+09AF+U+09BC) normalisation gap. Don't fix it there; just don't use it for grounding.
- **Section 4 → Postmark** transport switch is planned separately. Do not start it.
