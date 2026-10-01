# Section 2 — "News Analysis (What's in the news?)" (NA)

> JAANI has four main sections: 1. Read The News → **2. News Analysis (What's in the news?)** → 3. Officers Directory (verification) → 4. Send Message (RTI mail).
> This document is the reference for **Section 2**: what it must do, what the user sees, every file involved, how each pipeline works, the security model, measurements, open items, and how the section got here.
>
> Snapshot: 2026-09-28, branch `section-1-read-the-news-v3` (on top of commit `10cd927`). **All Section 2 work described here is uncommitted.** Line numbers are for the working tree on that date; `api.js` changes often, so search by function name if a number no longer matches.
> Sources: the codebase; the chat histories in `chat history/` (mainly `JAANI07_chat.md`, `chat history of news extraction.md`, `JAANI 01_CHAT HISTORY.MD`, `JAANI02 CHAT HISTORY.MD`, `jaani05 history.md`); `s1_rtn.md`; the v2 execution directive; and live runs on 2026-09-27/28.

---

## 1. Requirements and status

Later requests override earlier ones.

| # | Requirement | Source | Status |
|---|---|---|---|
| R1 | AI summary of the article | Original brief; 20-feature spec | Met: "AI Executive Summary" |
| R2 | Key points as bullets | 20-feature spec; master prompt | Met: "Key Highlights" (≤6; up to 220 characters each) |
| R3 | All metadata: date, author, publisher, word count, reading time | Original brief; JAANI07 | Met: one metadata card (adds site name, canonical URL, modified date, subtitle) |
| R4 | Detected people (with designation), organisations, locations | Original brief; master prompt | Met: persons from two extractors merged; organisations incl. gazetteer matches; locations from a fixed list |
| R5 | Detected government offices + RTI target office | jaani05; master prompt | Met: Government Context box |
| R6 | Keywords | JAANI02 | Drive Section 1 highlighting and appear in the PDF; the separate keyword box was removed at the user's request (JAANI07) |
| R7 | Top related ministries | JAANI02 | Met: AI suggestions shown only when they match the RTI dataset |
| R8 | Same news in other newspapers (combined title/summary/date search) | JAANI07 | Met: publisher URLs, not Google redirects |
| R9 | Related news | 20-feature spec; JAANI07 | Met, with a fact-check subsection |
| R10 | Working PDF download | JAANI07; user 2026-09-30 | Met: **one combined PDF** `news_summary_<timestamp>.pdf` (summary + full evidence certificate + both screenshots + preserved text + custody log); the raw files are a separate optional ZIP (§5.6) |
| R11 | Court-oriented technical/legal proof in the download | JAANI07; master prompt | Met: server-only evidence, two screenshots, hashes, RFC 3161 timestamp, Internet Archive, custody log, independently verifiable |
| R12 | No sentiment/"unrelated info" | JAANI 01 | Sentiment absent; category confidence shown once (badge row) |
| R13 | Remove the two noise boxes | JAANI07 | Done |
| R14 | `+` button opens the section | JAANI07 | Done |
| R15 | Never show fake fallback office data | JAANI07 | Met in UI and backend (no fabricated records anywhere) |
| R16 | Hosted-LLM intelligence only; libraries/fixed lists preferred over AI where they can do the job | JAANI07; v2 directive | Met: no heuristic stand-ins for AI output; deterministic gazetteers, keyword scans and lists wherever possible |
| R17 | Keep the four-section structure; no UI restructuring | Master brief; v2 directive | Held: new content lives inside existing cards |
| R18 | Speed | JAANI07 | Section 2 visible ~16.8 s after submit (was ~19 s) |
| R19 | Bengali-first UI, i18n, AI disclaimer | Master prompt | Met for Section 2 (bn/en; other languages fall back to bn) |
| R20 | One RTI dataset only: `JAANI_RTI_OFFICERS_COMPLETE.csv` | v2 directive | Met: nothing else reachable from any RTI path |
| R21 | No hard-coded model; route by task, chosen empirically | v2 directive | Met: `config/llmTaskRouting.js` + 10-article pilot |
| R22 | RTI Act 2009 routing, deadlines, exemptions inside the RTI card | v2 directive | Met: every line cites its section |
| R23 | Fact-checker, never inventing fact-checks | v2 directive; user | Met: local index of fact-checkers' feeds; AI only formulates queries and picks among retrieved items |
| R24 | Evidence retention | User decision | 90 days, startup sweep (enabled) |

---

## 2. What the user sees

The section is the second `AccordionSection` in [AnalysisAccordion.js](../frontend/src/components/AnalysisAccordion.js), titled via `t('newsAnalysis.title')` ([L920](../frontend/src/components/AnalysisAccordion.js#L920)). It's collapsed by default. Blocks, top to bottom:

| # | Block | Shown when | Data source |
|---|---|---|---|
| 0 | Skeletons | analysis pending | `ai_status === 'pending'` |
| 1 | Badges: provider, language, category, "(N% confidence)" | values present | `source`, `language`, `category`, `category_confidence` |
| – | AI disclaimer | always ([L982](../frontend/src/components/AnalysisAccordion.js#L982)) | i18n |
| – | "AI analysis unavailable" notice | every provider failed ([L985](../frontend/src/components/AnalysisAccordion.js#L985)) | `ai_status === 'unavailable'` + reason |
| 2 | AI Executive Summary + "Civic concern" line | summary present | `summary`, `civic_grievance` |
| 3 | Key Highlights | highlights present | `highlights` |
| 4 | Government Context: RTI target office, gazetteer-matched bodies, "possibly related (AI, matched to the RTI dataset)", 💡 reasoning | any of those present ([L1116](../frontend/src/components/AnalysisAccordion.js#L1116)) | `rti_target_office`, `mentioned_gov_orgs`, `related_ministries_verified`, `ministry_reasoning` |
| 5 | Detected Persons (with designation) / Detected Organizations | lists non-empty ([L1173](../frontend/src/components/AnalysisAccordion.js#L1173)) | merged `entities` (§5.3) |
| 6 | Detected Locations | places found | `LOC` entities from the location gazetteer |
| 7 | RTI officer card(s) + **RTI Actionability panel** (routing, deadlines, exemptions, notes, questions, money) | a real CSV match exists ([L1247](../frontend/src/components/AnalysisAccordion.js#L1247), panel [L1321](../frontend/src/components/AnalysisAccordion.js#L1321)) | `enriched_entities` + `/api/rti-guidance` |
| 8 | Metadata card | always | extraction metadata + word count + provider/model |
| 9 | Same news in other newspapers | always (or "searching…"/empty text) | `/api/related-news` → `sameStory` |
| 10 | Related news + "Related fact-checks" subsection | always / fact-checks when matched ([L1365](../frontend/src/components/AnalysisAccordion.js#L1365)) | `related`, `factChecks` |
| 11 | Source link + **Download PDF** (one combined PDF) with progress bar during capture | summary present ([L1427](../frontend/src/components/AnalysisAccordion.js#L1427)) | `/api/download-pdf` |

Keywords and entities also drive Section 1's article highlighting (see `s1_rtn.md` §5.2); `LOC` entities are ignored by the highlighter.

---

## 3. End-to-end flow

```
[HeroSection] URL + provider (Auto/OpenAI/Grok/Kimi)
      ▼
[Home.handleAnalyzeUrl]  frontend/src/pages/Home.js:561
  Phase 0  Dexie cache hit (24 h) → full analysis restored; RTI guidance re-fetched (deadlines count from today)
  Phase 1  POST /api/analyze → article rendered (7–8 s)
           └ background: forensic capture of the URL (server-only; deduped per 6 h)
  Phase 2  in parallel:
           POST /api/analyze-text     → analyzeQuick: gazetteer → entity consensus → main LLM prompt
                                         → summary, highlights, category, keywords, entities (+gazetteer ORG/LOC),
                                           enriched_entities (RTI cards), mentioned_gov_orgs, related_ministries_verified …
           POST /api/extract-entities → officials with designation (news_persons) + CSV row for Section 3
           → mergeNewsPersons (Home.js:53) → one entity list; ai_status done | unavailable | failed
  Phase 3  salience polling (Section 1)
  then     POST /api/rti-guidance (Home.js:641)  → RTI Actionability panel
           Section 3 hand-off (startVerification)
      ▼
[AnalysisAccordion]
  related-news effect: fires title-only first, again when keywords/summary/entities arrive
    → GET /api/related-news → sameStory / related (publisher URLs) / factChecks
  Download → POST /api/download-pdf → capture (reuse earliest complete, or capture now) → one combined PDF
```

---

## 4. File inventory

### 4.1 Frontend

| File | Role | Key symbols |
|---|---|---|
| [components/AnalysisAccordion.js](../frontend/src/components/AnalysisAccordion.js) (1,441 lines) | The whole Section 2 UI (and Section 1) | `HIGHLIGHT_SX` L32; `AccordionSection` L97; `bnDate`/`GuidanceLine`/`RtiActionability` L185–290; component L291; `relatedGovernmentOrgs`/`shouldShowGovOrgBox` L440–446; entity splits L463+; `isRealDatabaseMatch` L493; related-news effect L517; `articleMetaRows` L554; `handleDownloadPDF` (ZIP-aware) L579 |
| [pages/Home.js](../frontend/src/pages/Home.js) | Orchestration, merges, prop mapping | `mergeNewsPersons` L53; `deriveOfficeQueryFromAnalysis` L187; `extractEntitiesFromNews` (passes provider) L204; `handleAnalyzeUrl` L561; `startRtiGuidance` L641; `startVerification` L658; entity merge L813; `<AnalysisAccordion …>` L1369 |
| [api/axiosConfig.js](../frontend/src/api/axiosConfig.js) | `analyzeText`, `extractEntitiesFromNews` (+`llm_provider`); unused wrappers remain (§9) | — |
| [i18n/bn.json](../frontend/src/i18n/bn.json), [i18n/en.json](../frontend/src/i18n/en.json) | `newsAnalysis.*` labels, disclaimer, download texts | — |
| [db/jaaniDB.js](../frontend/src/db/jaaniDB.js) | Caches the full merged analysis 24 h (RTI guidance is not cached) | `cacheArticle` |

### 4.2 Backend: routes

[routes/api.js](../backend/routes/api.js) (8,402 lines):

| Symbol | Line | Role |
|---|---|---|
| background capture in `/api/analyze` | L4058 | URL-only forensic capture after extraction |
| `analyzeTextController` | L4075 | `/api/analyze-text` → `analyzeQuick` + salience kick-off |
| `extractEntitiesController` | L4161 | `/api/extract-entities` → `extractBengaliGovernmentEntities` + `enrichWithRTIDatabase` |
| `POST /rti-guidance` | L4205 | RTI Act guidance |
| `POST /download-pdf` | L4527 | evidence capture (reuse/cold/retry-incomplete) → one combined PDF (ZIP only with `format:'zip'`) |
| `loadEvidenceScreenshots` / `buildEvidenceZip` / `compareEvidenceText` | L3163 / L3208 / L3249 | screenshot pages, bundle, client-vs-capture divergence |
| `sanitizePdfArticleHtml` / `buildPdfHtml` / `buildForensicHtml` / `renderPdfBufferFromHtml` | L3270 / L3282 / L3610 / L3744 | PDF assembly (sanitized, escaped, JS off, CSS named pages) |
| `searchGoogleNewsRss` / `isFactCheckItem` / `GET /related-news` | L6929 / L6961 / L6974 | same-story scoring, fact-checker exclusion, publisher-URL resolution, fact-check lookup |
| `GET /evidence/:uuid/bundle.zip` / `GET /evidence` | L8143 / L8171 | raw bundle by capture ID; listing (off unless `EVIDENCE_LISTING_ENABLED=true`) |

### 4.3 Backend: services, config, utils

| File | Role | Key symbols |
|---|---|---|
| [services/geminiAnalysis.js](../backend/services/geminiAnalysis.js) (2,081) | All Section 2 LLM work | `getProviderRuntimeConfig` L76; `DEFAULT_TEMPERATURE_ONLY` L377; `callOpenAiCompatiblePrompt` L379 (returns `modelUsed`, `usage`; `max_completion_tokens` for OpenAI; Kimi headroom); `runPromptWithProvider` L470 (`task`, `validate`, pinned orders); `buildBengaliGovernmentEntityPrompt` L746; `extractBengaliGovernmentEntities` L802; `extractGovernmentEntitiesConsensus` L904; `isInvalidEntityText`/`normalizeTextList` L970/L1013; `analyzeQuick` L1087; `verifyRelatedMinistries` L1228; `buildGovernmentContext` L1246; `unavailableQuickAnalysis` L1311 |
| [services/rtiGazetteer.js](../backend/services/rtiGazetteer.js) (521, new) | Deterministic government-body matcher | `ALIASES` L19; `AGENCY_PARENTS` L90; `normalizeText` L144; `buildAutomaton` L158; `fuzzyScan` L327; `matchGovernmentBodies` L376; `pickRowForBody` L447; `buildEnrichedEntities` L476 |
| [services/locationGazetteer.js](../backend/services/locationGazetteer.js) (100, new) | 8 divisions + 64 districts | `detectLocations` |
| [services/rtiDatabaseLookup.js](../backend/services/rtiDatabaseLookup.js) | CSV rows (single dataset), reloads on file change | `RTI_MAIN_CSV` L11; `getDatabase` L202; `enrichEntities` L359; `enrichWithRTIDatabase` L656 (CSV-only officer slots, `news_persons`) |
| [services/rtiActGuidance.js](../backend/services/rtiActGuidance.js) (359, new) | RTI Act 2009 guidance | `prescreenUrgency` L41; `checkSection32Schedule` L65; `computeDeadline` L113; `moneyMentions` L140; `checkSection7Exemption` L212; `generateSuggestedQuestions` L237; `buildRtiGuidance` L260 |
| [services/googleNewsDecoder.js](../backend/services/googleNewsDecoder.js) (112, new) | Google News → publisher URL | `resolvePublisherUrls`, `articleIdFromUrl` |
| [services/factCheckIndex.js](../backend/services/factCheckIndex.js) (227, new) | Feed poller + BM25 retrieval | `pollAll`, `search`, `stats` |
| [services/factCheckLookup.js](../backend/services/factCheckLookup.js) (110, new) | Query formulation → retrieval → judgment | `findRelatedFactChecks` |
| [services/forensicEvidence.js](../backend/services/forensicEvidence.js) (690) | Evidence capture, verification, retention | `guardedLookup` L29; `assertPublicUrl` L43; `captureRawHttp` L73; `fullPageShot` L170; `captureRender` L206; `captureWayback` L290; `deriveArticleFromCapture` L420; `removeStalePartials` L462; `captureForensicEvidence` L480; `sweepExpiredCaptures` L621; `verifyForensicBundle` L662 |
| [services/liveProxyReader.js](../backend/services/liveProxyReader.js) | Section 1 reader; exports the SSRF classifier used here | SSRF comment L153; `isPublicHost` L166; `getBrowser` (with egress proxy) L253 |
| [utils/egressGuardProxy.js](../backend/utils/egressGuardProxy.js) (105, new) | Per-connection SSRF enforcement for headless browsers | `startEgressGuardProxy`, `resolvePublic` |
| [config/llmTaskRouting.js](../backend/config/llmTaskRouting.js) (88, new) | Task → tier → model; pinned provider orders | `TASK_TIERS`, `TASK_PROVIDER_ORDER`, `resolveTaskModel` |
| [data/contactLoader.js](../backend/data/contactLoader.js) | The single dataset (also Section 3) | `PRIMARY_DATASET_PATH` L10; `loadAllContacts` L538 |
| [index.js](../backend/index.js) | CORS `exposedHeaders` L125; retention sweep L461; fact-check cron L473 | — |
| `services/analyticsEngine.js` | `extractMoneyMentions` reused by the guidance (phrases only) | — |
| `services/adBlockEngine.js` | Reused for the evidence reading-view screenshot | — |

### 4.4 Scripts, tests, data

| Path | Role |
|---|---|
| `backend/scripts/evalTaskRouting.js` | Task-routing pilot (`--limit`, `--same-articles`, `--only p/tier`) |
| `backend/scripts/evalFactCheck.js` | Fact-check hit-rate test |
| `backend/scripts/sweepEvidence.js` | Retention sweep by hand (`--dry-run`, `--days`) |
| `backend/tests/providerFallthrough.test.js` | 8 cases, fake local providers; `npm test` (`node --test`) |
| `JAANI_RTI_OFFICERS_COMPLETE.csv` | The only RTI dataset (59 rows, 26 columns) |
| `backend/data/evidence_vault/` | Captures + `url_index.json` (git-ignored) |
| `backend/data/factcheck_index/index.json` | Fact-check index (git-ignored) |
| `backend/data/eval/` | Pilot and hit-rate outputs, summary review sheet (git-ignored) |

---

## 5. Pipelines

### 5.1 Main analysis: `analyzeQuick`

1. `rtiGazetteer.matchGovernmentBodies(text)`: deterministic bodies, passed to the LLM as context.
2. `extractGovernmentEntitiesConsensus`: two providers in parallel (task `entity_consensus`), merged.
3. The main prompt (task `summary_and_highlights`) with a validator: the summary must be ≥20 characters, otherwise the next provider is tried.
4. `buildGovernmentContext`: gazetteer matches plus the LLM's organisation names as a cross-check. Adds gazetteer ORG entities and location-gazetteer LOC entities, builds `enriched_entities` (RTI cards) and `mentioned_gov_orgs`.
5. `verifyRelatedMinistries`: keeps only AI suggestions that resolve to a dataset ministry or division.
6. If every provider fails: `unavailableQuickAnalysis`. No summary, category or keywords are invented; the gazetteer results are kept.

### 5.2 Gazetteers

- **Government bodies** (`rtiGazetteer.js`):
  - Built from the CSV's Ministry/Division/Office columns, plus curated aliases (short forms, English names, former names such as প্রধান উপদেষ্টার কার্যালয়) and an **agency → parent** table (~40 groups: ডিএমপি/পুলিশ/র‍্যাব → স্বরাষ্ট্র মন্ত্রণালয়, এনবিআর → অভ্যন্তরীণ সম্পদ বিভাগ, রাজউক → গৃহায়ন ও গণপূর্ত …).
  - Normalization: NFC, `ত্‍`→`ৎ`, zero-width characters stripped, Bengali digits to ASCII, hyphens joined, punctuation to spaces.
  - Matching: a hand-written UTF-16 Aho-Corasick with leftmost-longest selection, a word-start boundary and strict suffix rules for short generic words. (`modern-ahocorasick` was rejected: it matches whole grapheme clusters, so "মন্ত্রণালয়ের" never matched.)
  - Fuzzy fallback: grapheme edit distance ≤15% near anchor words.
  - Cost: ~1.3 ms per article after a ~17 ms first build.
  - A ministry with no row of its own shows one card per division row.
- **Locations** (`locationGazetteer.js`): 72 entries (8 divisions + 64 districts, Bengali variants + English, রাজধানী → ঢাকা), the same matcher, with case suffixes allowed (…র, …ের, …ে, …গামী).

### 5.3 Officials and the entity merge

`extractBengaliGovernmentEntities` (task `person_designation_extraction`) follows the user's provider, then the auto order. Its prompt includes the gazetteer's bodies, so each official is attached to a known body. `enrichWithRTIDatabase` picks the CSV row with the gazetteer and fills officer slots **only from the CSV**; the officials named in the news go to `news_persons`. `Home.mergeNewsPersons` adds them to Section 2's entities as PER with their designation, and drops longer phrases that merely wrap a known official's name.

### 5.4 RTI guidance: `/api/rti-guidance` → `buildRtiGuidance`

| Item | How | Section cited |
|---|---|---|
| Routing to the Designated Officer; escalation note for an agency without its own row | gazetteer + CSV | s.10 |
| Appellate authority | CSV | s.2(a), s.24 |
| Deadlines: reply-by (20 or 30 working days), refusal-reasons-by (10), appeal-by (30 days after the reply date) → 15-day decision → complaint (30 days) | Asia/Dhaka calendar, Fri/Sat excluded, holiday caveat shown | s.9(1)/(2)/(3), 24, 25 |
| 24-hour urgency | deterministic keyword pre-screen (clear yes/no); flagship LLM only when ambiguous | s.9(4) |
| Schedule bodies (NSI, DGFI, CID, SSF, SB, NBR/RAB intelligence …) | fixed list | s.32 |
| Exemption plausibility (≤2 flags naming the specific information at risk) | flagship LLM, **pinned to OpenAI gpt-6-astra first**; a fallback answer is marked "degraded" in the UI | s.7 |
| Fee note / multi-unit trade-off / missing-officer disclosure gap | fixed text | s.9(6)–(7), s.9(2), s.6(3)(d) |
| 2 Form "ক" item-২ questions (record-seeking) | cheap LLM | — |
| Money mentioned | `analyticsEngine.extractMoneyMentions`, currency-filtered phrases only | — |

### 5.5 Related news, publisher URLs, fact-checks: `/api/related-news`

- **Search:** up to 4 Google News RSS queries (exact title; title + entity; summary lead; entities + keywords). Scoring: 0.4 title similarity + 0.2 context + 0.2 date closeness + 0.2 shared numbers. "Same story" requires a score ≥0.5 and a title ≥0.35 or numbers ≥0.6.
- **Fact-checker exclusion:** sources/domains of Rumor Scanner, FactWatch, Dismislab, AFP Fact Check and BOOM, and debunk-style headlines, never count as "same news".
- **Publisher URLs** (`googleNewsDecoder`): one signature GET per item, then ONE batched `batchexecute` POST; in-memory cache; 12 s budget. Unresolved links are labelled "via Google News".
- **Fact-checks** (only on the post-analysis call):
  1. The cheap LLM writes 2–4 search phrases (fallback: the title and keywords).
  2. Deterministic BM25 retrieval over the local index.
  3. The flagship LLM picks among the **retrieved** items only; any other IDs are discarded, and it fails closed.
  4. Everything displayed is copied from the index; the model never writes or recalls a fact-check.
- **Index** (`factCheckIndex`): the public RSS feeds of Rumor Scanner (bn, en), FactWatch, Dismislab and BOOM, polled every 6 h. robots.txt is checked and Crawl-delay honoured (FactWatch: 60 s). UA `JAANI/1.0 (civic-tech; bangladesh)`. Atomic JSON store, reloaded when the file changes. AFP has no usable Bangla feed and is not covered (by decision, its site is not scraped).

### 5.6 Evidence: capture → one combined PDF → retention

- **Capture** (`captureForensicEvidence({ articleUrl })`, **URL only**):
  - SSRF-checked before any fetch or disk write.
  - Raw HTTP with the redirect chain (every hop checked; guarded DNS lookup at connect time), TLS chain, DNS.
  - **Two renders** through the egress proxy: the original page (`screenshot_fullpage.png`) and a reading view through `adBlockEngine` (`screenshot_adblocked.png`). Pages up to 15,500 px are captured in one shot; taller pages are 8,000 px segments stitched with `sharp` into one PNG (cap 60,000 px, recorded).
  - Internet Archive save (3 attempts, backoff) + CDX list.
  - **Preserved text, title, dates and author derived from the capture's own rendered DOM** (or raw body), recorded as `text_source`.
  - SHA-256/SHA-512/MD5 per file → `manifest.json` → FreeTSA RFC 3161 token (`manifest.tsr`/`.tsq`) → custody log → `forensic.json`.
  - **Atomic:** written to `.partial-<id>` and renamed into place; stale staging folders (>1 h) are removed at the next capture; `url_index.json` is replaced atomically.
- **Certificate PDF** (`/api/download-pdf`):
  - Client-sent text is display-only. The summary page is labelled "not evidence"; the header title and date come from the capture.
  - A client-vs-capture divergence check is logged and sent as `X-Evidence-Client-Text-Match`.
  - Article HTML is sanitized (allowlist), every field is escaped, and the Chromium context has JS disabled.
  - Each screenshot goes on its own CSS named page (595 pt wide, height to fit, scaled down proportionally above 14,400 pt, never cropped); the PDF embeds JPEG copies, while the hashes refer to the PNGs.
  - Captures made before 2026-09-28 are marked "text provenance not recorded — treat as unverified".
- **Download = one combined PDF** (user decision 2026-09-30: the ZIP was not user-friendly). The browser saves it as `news_summary_<timestamp>.pdf`. It holds the summary page, the full certificate (sections 1–10), both screenshots on their own pages, the preserved text, the custody log and the verification steps. The UI shows a progress bar plus an explanation during a cold capture.
- **Raw files (optional):** the hashes cover the raw capture files, which are not inside the PDF. Section 9 of the certificate points to `GET /api/evidence/<capture id>/bundle.zip`. `POST /api/download-pdf` with `format:'zip'` returns `JAANI_evidence_<domain>_<YYYYMMDD>_<id8>.zip` (PDF + raw files + `README_VERIFY.txt`).
- **Capture selection:** the PDF uses the **earliest complete** capture (one with both `raw_http_response_body.html` and `screenshot_fullpage.png`). If only incomplete captures exist (made while the network or the browser was down), a new capture is taken, at most once per 5 minutes. Incomplete attempts are listed in the certificate as such and no longer count as a "recent capture" for the 6-hour dedupe.
- **Retention:** `sweepExpiredCaptures` runs 30 s after server start (`EVIDENCE_RETENTION_DAYS`, 90). It covers current and older capture formats and empty folders, logs each deletion, and rewrites the index once.

### 5.7 LLM task routing and fall-through

| Task | Tier | Notes |
|---|---|---|
| `entity_consensus`, `person_designation_extraction`, `summary_and_highlights`, `suggested_rti_questions`, `fact_check_query_formulation` | cheap | |
| `section7_exemption_judgment` | flagship | provider order pinned `openai → grok → kimi` |
| `urgency_confirmation`, `fact_check_match_judgment` | flagship | |

- Model resolution: `TASK_<TASK>_<P>_MODEL` → `TASK_<TIER>_<P>_MODEL` → `<P>_MODEL` (provider defaults live only in the config).
- `runPromptWithProvider({ validate })`: an empty or parseable-but-empty answer is treated as a provider failure and the next provider is tried. An explicit empty result (e.g. fact-check `matches: []`) is valid.
- A model that accepts only the default temperature is detected from the provider's 400 and remembered per model.

---

## 6. Security model

| Surface | Protection |
|---|---|
| PDF rendering | `sanitize-html` allowlist; `safeText` on every field; `javaScriptEnabled:false` |
| Evidence integrity | Capture accepts only the URL; text/metadata derived server-side; provenance recorded and timestamped; atomic writes; hash + RFC 3161 verification |
| SSRF: evidence browser and Live Page reader | `utils/egressGuardProxy.js`: every connection (incl. **redirect hops**, which `page.route()` never sees) is resolved, refused if private/reserved (Section 1's `isLocalHostname`/`isPrivateOrReservedIp`), and connected to the checked address. The browser is launched with `bypass: '<-loopback>'`. The reader pairs one proxy with its long-lived browser (recreated together after a crash; block list capped at 200). `page.route()` still does first-request checks and ad filtering |
| SSRF: evidence raw HTTP/TLS | `assertFetchableUrl` + `isPublicHost` per hop; `guardedLookup` at connect time |
| Evidence exposure | Listing off by default; capture IDs are unguessable UUIDs; 90-day retention |
| Data | One RTI dataset; chat logs with pasted keys git-ignored; evidence/fact-check/eval data git-ignored |

---

## 7. Measurements (reference article `prothomalo.com/bangladesh/crime/diag0jvbhb`)

| Measure | Result |
|---|---|
| Article visible / Section 2 visible / RTI guidance / fact-check-enriched related news | 7.9 s / **16.8 s** (was 19 s) / 22.5–24 s / 25–26 s |
| Related news cold / cached | ~12–13 s / ~2.5 s (16/16 links resolved) |
| Cold evidence capture / cold download via UI | ~78–98 s / 64 s (Dhaka Post) |
| Reader snapshots after the SSRF fix | Prothom Alo 3.2–3.6 s, **14 images**; Dhaka Post 3.2–5.5 s, 6 images (no regression) |
| Security tests | Script/`onerror`/`iframe` injection: not executed. SSRF canary (redirect → 127.0.0.1, → localtest.me, direct): 0 hits in both browsers, also after a crash/relaunch |
| Evidence ZIP | All manifest hashes match; `openssl ts -verify` → Verification: OK |
| Forgery test | Forged client text/title/date/author: 0 occurrences in vault files |
| Tests | `npm test`: 8/8 |

**Task-routing pilot** (9 articles, tokens as reported by the APIs):

| Provider / tier | Model | Person extraction | Summary |
|---|---|---|---|
| OpenAI cheap | gpt-4o-mini | 3.7 s, JSON 89 %, 14 persons, 0 not in article | 2.6 s, 100 % |
| OpenAI flagship | gpt-6-astra | 5.1 s, 89 %, 8 persons | 8.0 s, 100 % |
| Grok cheap | grok-4.20-non-reasoning | 3.4 s, 100 %, 21 persons | 5.1 s, 100 % |
| Grok flagship | grok-4.7 | 27 s, 67 % (timeouts) | 31 s, 78 % |
| Kimi | kimi-k3 | 21 s, 78 % | 31 s, 100 % |

Defaults: cheap = gpt-4o-mini / grok-4.20-non-reasoning / kimi-k3; flagship = gpt-6-astra / **grok-4.20-non-reasoning (a cheap-model stopgap; grok-4.7 too slow)** / kimi-k3. Summary faithfulness still needs a Bengali reader (review sheet in `backend/data/eval/`).

**Fact-check hit rate:**
- Index: 411 items.
- Positives: 20/20 kept. This is an easy test, because each query was built from the fact-check's own text.
- False positives: 0/9 on ordinary news articles.
- Reference article: 4 candidates, all correctly rejected.

---

## 8. Problem status (from the original audit)

| # | Problem | Status |
|---|---|---|
| P1 | Government Context never rendered | Fixed |
| P2 | Related news ran title-only | Fixed (re-runs when AI data lands) |
| P3 | Corrupted Bengali in the PDF | Fixed |
| P4 | PDF content gaps | Fixed |
| P5 | Client JS executed in the server's PDF browser | Fixed |
| P6 | Two extractors disagreed; the official was missing | Fixed (merge) |
| P7 | Designations missing | Fixed |
| P8 | Locations rarely shown | Fixed (location gazetteer) |
| P9 | Weak/unused ministry fields | Fixed (gazetteer context; verified related ministries; grievance shown) |
| P10 | Long highlights silently dropped | Fixed (220-character cap) |
| P11 | RTI cards almost never appeared | Fixed (single dataset + gazetteer + agency→parent) |
| P12 | Heuristic/fabricated fallbacks | Fixed (explicit "unavailable") |
| P13 | Redundant metadata | Fixed |
| P14 | Google redirect links | Fixed (publisher URLs) |
| P15 | Evidence exposure and growth | Fixed (listing off; 90-day retention) |
| P16 | Speed | Improved; remaining costs documented (§10) |
| P17 | extract-entities ignored the provider choice | Fixed (task routing) |
| P18 | Silent empty section on AI failure | Fixed |
| P19 | Chat logs with keys not git-ignored | Fixed; **key rotation is a manual follow-up** |
| P20 | No i18n/disclaimer | Fixed for Section 2 (bn/en) |

---

## 9. Orphaned or legacy code (not reachable from the UI)

`POST /api/news-summary` + `generateFullSummary` + `fetchRelatedSourcesGoogleNewsRss` (old 20-feature backend); `POST /api/stage1-summarize`; `GET /api/analyze-stream` + `analyticsEngine`'s other functions + `crossSourceIntelligence.js` + `evidenceVault.captureEvidence` + `analyzeDeep` (removed 6-tab dashboard); `services/articleProcessor.js` (never required); `extractEarlyRtiOffice`; axiosConfig wrappers `getNewsSummary`, `analyzeSentiment`, `detectBias`, `analyzeLegalImplications`, `searchRelatedNews`, `stage1SummarizeNews`. The `GET /api/fact-check` stub and `searchFactChecks` were **removed**. Chat logs inside `frontend/src`/`backend` remain as clutter.

---

## 10. Open items and known costs

- **Manual:** rotate the API keys that were pasted in the chat logs.
- **Known costs:** Section 2 ~17 s after submit; cold related news ~12–13 s (Google News signature pages; the cache is per process); cold evidence capture ~60–80 s.
- **Coverage:** AFP Fact Check (no Bangla feed; not scraped by decision); BOOM history grows only through polling.
- **Deadline maths:** no public-holiday calendar (caveat shown).
- **Money extractor:** `analyticsEngine` gives English amounts a value of 0 (only phrases are displayed).
- **Other languages:** Section 2 labels fall back to Bengali in hi/ur/ar/es.
- **Test watch mode:** `npm run test:watch` still uses mocha, which doesn't start under Node 26.
- **Not built, by decision:** OpenTimestamps (no maintained library; capture-time and verification-time dependencies on calendar servers; FreeTSA + the Internet Archive are two independent proofs); Section 4 appeal/complaint letters; the live officer-freshness check.

---

## 11. Configuration

| Env var | Default | Effect |
|---|---|---|
| `LLM_AUTO_ORDER` | `openai,grok,kimi` | provider order for Auto |
| `OPENAI_MODEL` / `GROK_MODEL` / `KIMI_MODEL` | gpt-4o-mini / grok-4.20-non-reasoning / kimi-k3 | provider defaults |
| `TASK_CHEAP_<P>_MODEL` / `TASK_FLAGSHIP_<P>_MODEL` | set in `backend/.env` (§7) | tier models |
| `TASK_<TASK>_<P>_MODEL`, `TASK_<TASK>_PROVIDER_ORDER` | unset | per-task overrides |
| `LLM_PROVIDER_TIMEOUT_MS` / `ENTITY_EXTRACT_TIMEOUT_MS` | 15000 / 8000 (Kimi ≥30000) | timeouts |
| `ANALYZE_MAX_WORDS` / `ANALYZE_QUICK_MAX_TOKENS` / `NEWS_EXTRACT_MAX_WORDS` | 2000 / 900 / 2500 | budgets |
| `FACTCHECK_POLL` | on | `off` disables feed polling (second instances) |
| `EVIDENCE_RETENTION_DAYS` | 90 | retention; 0 disables |
| `EVIDENCE_LISTING_ENABLED` | false | `GET /api/evidence` listing |
| `ALLOW_PRIVATE_NETWORK_URLS` | false | URL validation for the download route |
| `ALLOW_INSECURE_GOV_TLS` | true | TLS bypass for .gov.bd in raw capture |

---

## 12. How to run and verify

```bash
cd backend && node index.js          # 5005 (+ reader 5002); retention sweep at +30 s, fact-check poll at +60 s
cd frontend && BROWSER=none npm start   # 3000
cd backend && npm test                  # 8 provider fall-through tests

node scripts/sweepEvidence.js --dry-run                         # what retention would delete
node scripts/evalTaskRouting.js --limit 10 --same-articles      # task-routing pilot
node scripts/evalFactCheck.js --n 20                            # fact-check hit rate

# verify a downloaded bundle
unzip JAANI_evidence_*.zip -d b && cd b
shasum -a 256 <file>        # compare with manifest.json "files"
curl -sO https://freetsa.org/files/cacert.pem && curl -sO https://freetsa.org/files/tsa.crt
openssl ts -verify -in manifest.tsr -queryfile manifest.tsq -CAfile cacert.pem -untrusted tsa.crt
```

A second server instance: `FACTCHECK_POLL=off PORT=5105 READER_PORT=5102 READER_PUBLIC_ORIGIN=http://localhost:5102 node index.js` (frontend: `PORT=3010 REACT_APP_BACKEND_URL=http://localhost:5105 …`; 3010 is an allowed CORS origin).

---

## 13. History and decision log

**Before this work (from the chat histories):**
1. MVP summary + `related_office`.
2. Sentiment removed.
3. 20-feature, 5-tab News Summary Box.
4. CSV keyword highlighting (later removed).
5. LLM analysis replaced local ML.
6. 6-tab Intelligence Dashboard (removed in JAANI07).
7. JAANI07: the `+` fix, fake office cards removed, related news, the forensic PDF.

**2026-09-27/28:**

| Step | What happened |
|---|---|
| Audit | 20 problems (P1–P20) found and confirmed live |
| Stage A | P5 security fix; single dataset (removed `my.csv`, 7 fallback CSVs, the mirror write, the 57 scraped JSONs, the `contacts.js` fallback); government-body gazetteer; entity merge; P1–P4, P10, P12, P13, P18, P19 |
| Evidence forgery fix | The PDF route had made new captures from client text; now URL-only, server-derived, provenance recorded; verified with forged input |
| Stage B | Task routing (P17); RTI guidance; Google News decoding (P14); fact-checker (feed index, stub retired); dual screenshots, stitching, IA retry; 10-article pilot; fact-check hit-rate test |
| Hardening | Egress proxy for the evidence browser (redirect hops proven unguarded); validator-based provider fall-through + tests; Section 7 pinned to gpt-6-astra with a "degraded" flag |
| Reader fix | Same proxy for Section 1's reader (it had served an internal page via a redirect); `s1_rtn.md` corrected |
| Stage C | Atomic vault writes; location gazetteer (P8); verified related ministries (P9); evidence listing off (P15); i18n + disclaimer (P20); full Step 9 verification |
| Single PDF (2026-09-30) | Download switched back to one combined PDF (`news_summary_<ts>.pdf`); ZIP only on request. Found via the user's example: a capture made at 06:34 UTC while Playwright's browser binary was missing and the network was timing out had no screenshots or raw body, and was being reused as the earliest capture; fixed by preferring the earliest complete capture and retrying |
| Bundle + retention | ZIP evidence bundle (now optional); 90-day retention (first sweep removed 242 older-format test-run captures from 2026-05-20, 14:39–15:12 UTC; 30 kept, all verified); `npm test` → `node --test` |

**Decisions:**
- Staged execution (A/B/C).
- A 10-article pilot rather than 50–100.
- LLMs never recall fact-checks; the local feed index is authoritative.
- Hand-rolled Google News decoder; no Google News npm package.
- No OpenTimestamps.
- A custom Bengali-suffix matcher instead of `modern-ahocorasick`.
- Dataset-sourced blocks stay visible when the AI is down.
- The Grok flagship slot uses a fast model as a stopgap.
- Section 7 pinned to OpenAI.
- AFP not scraped.
- The 13 s cold related-news cost accepted.
- 90-day retention, with the 242 test-run captures deleted.
- One combined PDF as the download; the raw-file ZIP is optional.
