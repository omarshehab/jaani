# Section 1 — "Read The News" (RTN)

> JAANI has four main sections: **1. Read The News** → 2. News Analysis (What's in the news?) → 3. Officers Directory (verification) → 4. Send Message (RTI mail).
> This document covers **Section 1 only**: every file involved, what it does, how data flows, what was tried before, and what is still open.
>
> Snapshot date: 2026-09-27, branch `section-1-read-the-news-v3` (commit `10cd927` plus uncommitted follow-up work described in §8). Line numbers refer to the working tree on that date; `api.js` changes often, so search by function name if a line number no longer matches.
> Sources: the live codebase, plus the chat histories in `chat history/` (mainly `JAANI07_chat.md`, `chat history of news extraction.md`, `JAANI 01_CHAT HISTORY.MD` and `prev_chat history.md`), plus the working session that rebuilt this section (Stages 1–7 and two follow-up passes, §8).

---

## 1. What the section must do (requirements the user has given)

These come from the chat histories and the rebuild session. Later requests override earlier ones; the "Current" column says where the requirement stands today.

| # | Requirement | Where it came from | Current |
|---|---|---|---|
| R1 | The user pastes a news URL, and the full article is shown inside the "Read The News" accordion. | Original MVP brief (JAANI 01) | Met |
| R2 | **Exact replica of the source layout**: title, subtitle, author and date, then each image **in its original position** with **its own caption**, then paragraphs in DOM order. | news-extraction chat; JAANI07 | Met for the extracted-text view (`sanitizeArticleHtml`); the Live Page view goes further and serves the real rendered page (§4) |
| R3 | **Ads are not shown.** | news-extraction chat; JAANI07 | Extracted view: text marker. Live Page view: same-size "ব্লক করা হয়েছে" placeholders, cookie bars removed, paywalls flagged not bypassed (§6) |
| R4 | **Highlight on keywords**, at word level and never on whole lines. | JAANI07 (repeated several times) | Met — AI keywords only (§5.2), blue |
| R5 | **Underline on officials, ministers and other government people, including their designation.** | JAANI07 | Met — blue underline (§5.2) |
| R6 | Highlighted background for government organisations and ministries. | Master Implementation Brief | Met — light blue (§5.2) |
| R7 | **Videos: link or embed only**, never download or re-host. | news-extraction chat | Met in the extracted view; the Live Page view turns video embeds into a "▶ ভিডিও দেখুন" link, since it runs no scripts |
| R8 | **Correct Bangla rendering.** | news-extraction chat | Met (iconv charset decoding, Bengali font stack) |
| R9 | **"View original" fallback** that can't be blocked by embedding rules. | news-extraction chat | Met, and widened: Live Page / Extracted Text / Wayback Archive / open in new tab (§4) |
| R10 | **Blocked sites must still work** (e.g. Dhaka Post 403). | JAANI07 | Met for extraction (Wayback CDX fallback) and for the Live Page view (Dhaka Post is allowlisted) |
| R11 | **Speed**: user asked for 5–6 seconds; the `+` must open instantly. | JAANI07 | Article renders in ~7–12s (extraction only; AI runs after, in parallel — §3). Not at the 5–6s target; §7 problem P1 |
| R12 | The `+` button must actually open the section. | JAANI07 | Fixed (accordion component hoisted to module scope) |
| R13 | Remove noise boxes. | JAANI07 | Fixed; the Read The News Debug box was also removed in the rebuild (§8) |
| R14 | Keep the four-stage structure; no MongoDB, local ML, Twilio or Puppeteer. | Master Implementation Brief | Held — the salience ensemble (§4) uses hosted LLMs only, no local NLP/ML model |
| R15 | No manual/CSV keyword dataset — keyword highlights come from AI only. | Follow-up directive, 2026-09-27 | Met (§8) |

---

## 2. End-to-end flow (current)

```
[HeroSection input bar]  ── user pastes URL + picks AI provider (Auto/OpenAI/Grok/Kimi)
        │ onSubmit(url)
        ▼
[Home.handleAnalyzeUrl]  (frontend/src/pages/Home.js:524)
        │
        │ Phase 0 — browser cache (Dexie, 24h TTL): a hit skips everything below and
        │           renders straight from IndexedDB (§4.4)
        │
        │ Phase 1 — POST /api/analyze {url}  → article (title, images, articleHtml, media)
        │           setAnalysisData(...) — THE ARTICLE IS ON SCREEN HERE, before any AI call
        │
        │ Phase 2 — POST /api/analyze-text + POST /api/extract-entities, IN PARALLEL
        │           (Promise.allSettled — one failing keeps the other's result)
        │           merge → entities, keywords, reader_token, url_hash, salience_pending
        │
        │ Phase 3 — GET /api/salience-status?urlHash=  polled every 2s (≤90s), background
        │           → sentenceHighlights arrive later, merged into the same article
        │
        │ officer verification kicked off from the Phase 2 result (feeds Section 3)
        ▼
[AnalysisAccordion]  (frontend/src/components/AnalysisAccordion.js)
        │ "Read The News" AccordionSection (collapsed by default)
        │   view modes: Live Page (Highlighted) [default if allowlisted] / Extracted Text /
        │               Wayback Archive / open in new tab
        │   Extracted Text: highlightHTMLEntities(articleHtml, entities, geminiKeywords,
        │                    sentenceHighlights) — one shared matcher, sentences first then words
        │   Live Page: iframe → backend reader (own origin), which injects the SAME highlights
        │               server-side and reloads (&v=s<N>) once sentence highlights land
        ▼
 Rendered article, highlighted, ads/cookie-bars/paywall handled, cached for next time
```

Every request in Phases 1–3 is guarded by a `requestVersionRef`/`requestId` pair: if the user submits a new URL while an older one is still in flight, the older AI calls are aborted and can never overwrite the newer article's state (verified — see §4.1).

---

## 3. File inventory

### 3.1 Frontend

| File | Role | Key symbols |
|---|---|---|
| [frontend/src/pages/Home.js](../frontend/src/pages/Home.js) | Owns the whole flow: cache lookup, extraction, the two parallel AI calls, salience polling, officer hand-off. | `handleAnalyzeUrl` [L524](../frontend/src/pages/Home.js#L524) (Phase 0 [L640](../frontend/src/pages/Home.js#L640), Phase 1 [L673](../frontend/src/pages/Home.js#L673), Phase 2 [L727](../frontend/src/pages/Home.js#L727), Phase 3 helper [L564](../frontend/src/pages/Home.js#L564)); `<AnalysisAccordion …>` [L1305](../frontend/src/pages/Home.js#L1305); `requestVersionRef`/`analyzeAbortRef` cancel stale requests |
| [frontend/src/components/AnalysisAccordion.js](../frontend/src/components/AnalysisAccordion.js) | **The Read The News UI**, plus Section 2 in the same component. | `HIGHLIGHT_SX` (shared colours) [L30](../frontend/src/components/AnalysisAccordion.js#L30); `AccordionSection` (hoisted, fixes the `+` remount bug) [L95](../frontend/src/components/AnalysisAccordion.js#L95); component props [L188](../frontend/src/components/AnalysisAccordion.js#L188); view-mode state [L233](../frontend/src/components/AnalysisAccordion.js#L233); `readerSrc`/`showLivePage` [L305-306](../frontend/src/components/AnalysisAccordion.js#L305); `highlightedArticleHtml` [L404](../frontend/src/components/AnalysisAccordion.js#L404); Read The News JSX from [L532](../frontend/src/components/AnalysisAccordion.js#L532); News Analysis JSX from [L782](../frontend/src/components/AnalysisAccordion.js#L782) |
| [frontend/src/utils/highlightHTMLEntities.js](../frontend/src/utils/highlightHTMLEntities.js) | The **single** highlight-matching implementation, used by both the frontend and (loaded as plain script) the backend reader. DOMParser/TreeWalker, whitespace-agnostic, earliest-match-wins, designation-aware for officers. | Colours [L27-31](../frontend/src/utils/highlightHTMLEntities.js#L27); `buildWhitespaceAgnosticRegex` L41; `highlightDomTree(root, entities, keywords, win, sentenceHighlights)` [L192](../frontend/src/utils/highlightHTMLEntities.js#L192) (sentence pass runs first, then entities/keywords, so word spans nest inside sentence spans); `highlightHTMLEntities(...)` [L198](../frontend/src/utils/highlightHTMLEntities.js#L198) (DOM path + regex fallback for SSR) |
| [frontend/src/utils/keywordUtils.js](../frontend/src/utils/keywordUtils.js) | `buildKeywordRegex`/`findKeywordsInText`/`normalizeKeyword`. **On disk but unused** — the dataset-keyword pass that used it was removed 2026-09-27 (§8). | — |
| [frontend/src/index.css](../frontend/src/index.css) | `.keyword-highlight` rule, kept in sync with the inline styles below. | — |
| [frontend/src/db/jaaniDB.js](../frontend/src/db/jaaniDB.js) | Browser cache (§4.4). | `computeUrlHash` L36; `getCachedArticle`/`cacheArticle` L58/70; `updateSentenceHighlights` L97; `initDB()` called once from `src/index.js` |
| [frontend/src/api/axiosConfig.js](../frontend/src/api/axiosConfig.js) | API client. `analyzeUrl` → `/api/analyze` (120s), `analyzeText` → `/api/analyze-text` (120s), `extractEntitiesFromNews` → `/api/extract-entities` (30s), `getLlmStatus` → `/api/llm-status`, `buildReaderUrl`/`buildReaderPrepareUrl` for the Live Page iframe. | — |
| [frontend/src/components/HeroSection.js](../frontend/src/components/HeroSection.js) | URL input bar, AI provider chips (Auto/OpenAI/Grok/Kimi), live provider status. Reads `rti_last_analyzed_url` from localStorage. | `LLM_PROVIDER_OPTIONS` L48; `handleSubmit` L82 |
| [frontend/src/components/ProgressWithETA.js](../frontend/src/components/ProgressWithETA.js) + [hooks/useTimedProgress.js](../frontend/src/hooks/useTimedProgress.js) | "Analyzing… 📰" progress bar while Phase 1 runs. | — |
| [frontend/package.json](../frontend/package.json) | `"proxy": "http://localhost:5005"` (CRA dev proxy). | — |
| `frontend/.env` | `REACT_APP_BACKEND_URL=http://localhost:5005`, `REACT_APP_READER_ORIGIN=http://localhost:5002` | — |
| [frontend/public/index.html](../frontend/public/index.html) | Clears stale `BACKEND_URL`/`BACKEND_NGROK_URL`/`analysisCache`/`history` keys from old sessions at startup. | — |

**localStorage usage today** (audited 2026-09-27): `rti_last_analyzed_url`, `i18nextLng` (UI language), and the activity tracker's offline queue. No article data lives in localStorage — that is Dexie's job (§4.4).

### 3.2 Backend

| File | Role | Key symbols |
|---|---|---|
| [backend/routes/api.js](../backend/routes/api.js) (~8,200 lines) | Routes and extraction orchestration. | see §4 |
| [backend/routes/axiosFastExtractor.js](../backend/routes/axiosFastExtractor.js) | Third extraction fallback. | `extractWithAxiosOnly`, `extractMediaFromHtml`, `extractTextFromUrl` (used by `/api/verify-contact`, Section 3 — not dead) |
| [backend/routes/playwrightExtractor.js](../backend/routes/playwrightExtractor.js) | Second extraction stage for JS-rendered pages. | `extractWithPlaywright(url,{siteType})`; `isNonArticleImage` (whole-word ad/logo/icon filter, fixed 2026-09-26 — §7 P3 in the old numbering, now folded into history §8) |
| [backend/services/geminiAnalysis.js](../backend/services/geminiAnalysis.js) | Produces the `entities` (PER/ORG) and `keywords` behind RTN highlighting. | `analyzeQuick`, `extractGovernmentEntitiesConsensus`, `extractBengaliGovernmentEntities` |
| [backend/services/rtiDatabaseLookup.js](../backend/services/rtiDatabaseLookup.js) | CSV entity enrichment — matters for Section 2/3, part of the same response. | — |
| [backend/services/forensicEvidence.js](../backend/services/forensicEvidence.js) | Background evidence capture on every `/api/analyze` (screenshot, hashes, TSA, Internet Archive). Feeds the Section 2 PDF download. | — |
| [backend/services/liveProxyReader.js](../backend/services/liveProxyReader.js) | **The Live Page reader** — see §4.2. | see table below |
| [backend/services/adBlockEngine.js](../backend/services/adBlockEngine.js) | Ad/tracker/annoyance/paywall handling used by the reader — see §6. | — |
| [backend/services/salienceEnsemble.js](../backend/services/salienceEnsemble.js) | Sentence-salience ranking — see §4.3. | — |
| [backend/services/salienceStore.js](../backend/services/salienceStore.js) | 50-entry, 15-minute in-memory store keyed by `urlHash`, read by `/api/salience-status`. | — |
| [backend/index.js](../backend/index.js) | Express app: helmet, CORS, `/shared` static, `/api` mount, starts the reader server (`liveProxyReader.startReaderServer()`, [L510](../backend/index.js#L510)). PORT 5005. | — |
| `backend/.env` | `PORT=5005`; `ALLOW_INSECURE_GOV_TLS=true`; `LLM_AUTO_ORDER=openai,grok,kimi`; `OPENAI_MODEL=gpt-4o-mini`, `GROK_MODEL=grok-4.20-non-reasoning`, `KIMI_MODEL=kimi-k3` (main analysis pipeline); `SALIENCE_OPENAI_MODEL=gpt-6-astra`, `SALIENCE_GROK_MODEL=grok-4.7`, `SALIENCE_KIMI_MODEL=kimi-k3` (salience ensemble only — chosen from a `/v1/models` audit of each key, 2026-09-26); `READER_ALLOWLIST=www.prothomalo.com,www.thedailystar.net,bdnews24.com,www.dhakapost.com`; keys never echoed. | — |
| Playwright browser | Manually installed under `~/Library/Caches/ms-playwright` in an earlier session; no setup script exists (§7 P6). | — |

---

## 4. The three pipelines behind Read The News

### 4.1 Extraction and parallel AI (Phases 1–2)

`POST /api/analyze` → `extractNewsController` (`api.js:3736`):
```
validateExternalHttpUrl(url)            (SSRF guard)
  → extractWithCheerio(url)             (axios + iconv charset decode + Readability + heuristics)
  → [if low quality] extractWithPlaywright(url)   (headless Chromium, scroll, lazy images)
  → [if still bad] extractWithAxiosOnly(url)
  → [if still bad] resolveWaybackSnapshotUrl(url) → extractWithCheerio(waybackUrl)   (source:'wayback')
  → 400 if nothing
sanitizeArticleHtml(html, url)          (DOM-order walk → flat <h1>/<p>/<figure>/ad-marker HTML)
normalizeExtractedText (NFC + 2500-word cap), buildMediaPayload
fire-and-forget forensicEvidence.captureForensicEvidence(...)
res.json({ text, media, articleHtml, title, subtitle, author, publicationDate, source,
           proxyModeAvailable })   ← true when the URL's hostname is on READER_ALLOWLIST
```
`sanitizeArticleHtml` (`api.js:2430`) is the core of the "exact replica" for the extracted-text view: picks a container, removes scripts and ad selectors, walks the DOM in order emitting cleaned text tags, `<figure>` blocks with captions, kept YouTube/Vimeo embeds, and one `jaani-ad-block` marker per run of ads.

`Home.js` sets `analysisData` **the instant this returns** — the article is visible with zero AI data at this point (measured: 7–12s from submit). It then fires `POST /api/analyze-text` (→ `geminiAnalysis.analyzeQuick`, `api.js:3941`) and `POST /api/extract-entities` (`api.js:4027`) together with `Promise.allSettled`; whichever succeeds is merged into the same article state, guarded so a slower/older request can never clobber a newer one. `analyze-text`'s response also carries `reader_token` (sha256 of the normalized URL, used by the Live Page reader) and `salience_pending`/`url_hash` (Phase 3).

Measured on the reference article: word-level highlights (entities + AI keywords) land ~5s after the article appears.

### 4.2 Live Page reader (`backend/services/liveProxyReader.js`)

The default article view for allowlisted outlets is not the extracted/rebuilt HTML — it is the **real rendered page**, annotated, served from a separate origin so it can never touch the app:

```
capture (Playwright, cached 10 min per URL):
  one long-lived browser, a fresh incognito context per request (closed after capture)
  → every request of that page (nav, sub-resources, XHR) is SSRF-checked (DNS resolved and
    judged per host, not just the top-level URL) AND matched against Ghostery's ad/tracker
    lists (§6) — matches are aborted before they load
  → navigate, wait for settle (networkidle or 5s), bounded scroll (max 30 steps) for lazy images
  → ad slots measured and replaced with sized placeholders BEFORE the cosmetic CSS runs
    (the CSS would collapse them to 0×0 first)
  → cosmetic hiding CSS injected, cookie bars/overlays removed, paywall detected
  → page.content() captured (scripts have already run, so JS-injected images are present)

serve (jsdom, per request):
  strip <script>, event-handler attributes, javascript: URLs, ad-CDN stylesheets
  → lazy-image attributes (data-src, data-lazy-src, srcset) rewritten to real attributes
  → video/embed iframes replaced with a "▶ ভিডিও দেখুন" link (no scripts run, so the player
    itself cannot work)
  → highlights injected using highlightDomTree() loaded DIRECTLY from
    frontend/src/utils/highlightHTMLEntities.js (one implementation, not a port)
  → <base href> + referrer meta + the same colour CSS as the frontend
```
Response headers: `Content-Security-Policy: sandbox allow-popups allow-popups-to-escape-sandbox; script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'` (plus `frame-ancestors` only if `READER_FRAME_ANCESTORS` is explicitly set — see §8's blank-iframe fix). The frontend iframe itself uses `sandbox="allow-popups allow-popups-to-escape-sandbox"` — **never** `allow-scripts` with `allow-same-origin` together, which would let a framed page lift its own sandbox.

Highlight inputs (`entities`, `keywords`, `sentenceHighlights`) are handed to the reader by `POST /api/reader-payload`, keyed by the same `urlHash`/`reader_token`; they live in memory for 10 minutes. On a browser-cache hit (§4.4) the frontend re-sends them, since the reader may have forgotten them.

`READER_ALLOWLIST` gates which hostnames the reader will serve (`isAllowlisted`, `liveProxyReader.js:180`); anything else, or any reader failure, makes the frontend fall back to Extracted Text silently (`GET /prepare` warms the snapshot and returns `{ok}` — a `false`/error response never surfaces as a UI error).

### 4.3 Sentence salience ensemble (Phase 3)

`backend/services/salienceEnsemble.js` runs **after** `/api/analyze-text` has already answered the client — it never delays the article or the word-level highlights:

1. `splitBengaliSentences(text)` — splits on ।/!/? (with or without a following space) and on "." only before whitespace, with guards for known abbreviations, single-letter initials ("A. K."), and decimals (৩.৫ / 3.5); fragments under 20 characters are dropped.
2. Each sentence is sent to **OpenAI, Grok and Kimi in parallel**, each asked for strict JSON `{"ranked":[{"id","score"}]}` via a JSON-schema response format (falls back to `json_object` on an HTTP 400 from that provider). A per-provider timeout applies (`SALIENCE_PROVIDER_TIMEOUT_MS`, with an optional `SALIENCE_TIMEOUT_MS_<PROVIDER>` override — Kimi needed 45s on a 31-sentence article; Grok has since hit the same wall on the same article, so it may need the same override).
3. Scores are min-max normalized per provider, a sentence containing an entity/keyword already highlighted gets +0.15 (capped at 1.0), and scores are averaged across whichever providers answered. **If zero providers answer, the result is an empty list — never a local/algorithmic fallback** (matches the project's ground-truth rule of hosted-LLM-only intelligence).
4. `selectTopSentences` greedily picks by merged score while the running character total stays within `SALIENCE_MAX_BUDGET_RATIO` (0.40) of the article's total characters, enforced in code (a violation throws — this should be structurally impossible).

The result is stored in `salienceStore` keyed by `urlHash` and served by `GET /api/salience-status` (200 ready / 202 running / 404 unknown). `Home.js` polls every 2s for up to 90s; on arrival the sentences are merged into `analysisData.sentenceHighlights`, the Extracted view re-highlights, and the Live Page iframe reloads with `&v=s<N>` (the reader's stored payload is updated first so the reload actually carries them).

### 4.4 Browser cache (`frontend/src/db/jaaniDB.js`)

Dexie (`jaani_v3`) + lz-string, 24-hour TTL. The cache key is the **same SHA-256 normalization** the backend uses for the reader token and the salience `urlHash`, computed via `window.crypto.subtle` (skipped, not an error, when Web Crypto is unavailable — e.g. a plain-http LAN address).

A cache hit (Phase 0) renders the whole merged analysis immediately — no `/api/analyze`, no AI calls — re-hands the highlight inputs to the reader (`POST /api/reader-payload`, since the reader's own 10-minute memory has likely expired), starts the officer lookup, and only polls salience if the cached row has no sentences yet. A cache miss writes the row fire-and-forget **after** the article has rendered, and only when `/api/analyze-text` succeeded (a failed analysis is never cached, so it can't pin a highlight-less article for 24 hours). The salience poller updates the cached row when it finishes, so the next visit gets sentences too.

Measured: miss → article in ~7–12s; hit → article in ~300–500ms with only `/api/reader-payload` called. `articleHtml` compresses roughly 60–70% (3,232 → 1,211 chars on the reference article). Two cached articles use ≈150KB against a typical multi-GB browser quota.

---

## 5. Rendering and highlighting (frontend detail)

### 5.1 Read The News view modes

The accordion offers, in order: **Live Page (Highlighted)** (default when `proxyModeAvailable`) → **Extracted Text** → **Wayback Archive** → open in a new tab. Selecting a mode is sticky for that session (`userPickedModeRef`) so a background snapshot failure doesn't silently switch the user back.

- **Extracted Text** renders `articleHtml` (from `sanitizeArticleHtml`) in one `dangerouslySetInnerHTML` box styled with `HIGHLIGHT_SX`. Order: title → subtitle → author/date → video banner (if any) → article body → mode switch buttons.
- **Live Page** loads the reader's iframe (§4.2); `readerSrc` includes `&v=s<N>` once sentence highlights exist, forcing a reload with them applied.
- **Wayback Archive** fetches `/api/wayback-url` and shows the archived snapshot in an iframe (`sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"` — archived pages need their own scripts to render, and this is never combined with `allow-same-origin`).

A plain-text fallback (no HTML formatting) exists for the rare extraction that returns text but no article HTML.

### 5.2 Highlighting: two passes, one shared matcher

All highlighting — in both the Extracted view and inside the Live Page reader — goes through the **same function**, `highlightDomTree` in `frontend/src/utils/highlightHTMLEntities.js`, which the reader loads directly from that file (not a reimplementation). Passes run in this order:

1. **Sentences** (`sentenceHighlights` from the salience ensemble, §4.3) — matched first, while the text is still whole, then entity/keyword spans nest inside them without double-wrapping.
2. **Entities and AI keywords** — `entities` (labels `PER`/`ORG`) and `geminiKeywords`, both from `/api/analyze-text`. **No other keyword source exists** (the CSV dataset pass was removed 2026-09-27 — §8).

| Class | Meaning | Colour |
|---|---|---|
| `.important-sentence-highlight` | AI-selected important sentence | yellow `#fff176` background, `#212121` text |
| `.keyword-highlight` | AI keyword (`geminiKeywords`) | blue `#bbdefb` background, `#0d47a1` text |
| `.gov-org-highlight` | Government organisation (`ORG`) | light-blue `#e3f2fd` background, `#1565c0` text, bold |
| `.officer-highlight` | Government official (`PER`) | `#1565c0` underline, 3px, 4px offset, bold |

The same four colour values are defined in exactly four places, kept in sync by hand: `highlightHTMLEntities.js` (inline span styles used by both the frontend DOM path and the reader), `frontend/src/index.css` (`.keyword-highlight` for the regex-fallback path), `AnalysisAccordion.js`'s `HIGHLIGHT_SX` (the Extracted view's `sx` overrides — these used to disagree with the inline styles until 2026-09-27), and `liveProxyReader.js`'s `READER_STYLE`.

The matching algorithm: for each text node, takes the **earliest** match across all candidates (longest wins a tie), splits the text node and wraps the match in a `<span>`, and recurses on the remainder. It normalizes to NFC and keeps Bengali vowel signs attached to the preceding letter. It skips `script`/`style`/`a`/`textarea` parents. Officer names get a designation prefix (অতিরিক্ত/যুগ্ম/… + কমিশনার/সচিব/মন্ত্রী/…) folded into the match so the title and name highlight together.

---

## 6. Ad, tracker, cookie-bar and paywall handling (`backend/services/adBlockEngine.js`)

Applies only to the **Live Page reader**; the extracted-text path's own ad-marker logic (`sanitizeArticleHtml`) is separate and untouched.

- **Engine**: Ghostery `FiltersEngine.fromPrebuiltFull` — EasyList + EasyPrivacy + uBlock annoyance/cookie-notice lists (122,738 network + 67,947 cosmetic rules), cached to disk, built once per process.
- **Network layer**: every request the snapshot's headless page makes is checked in one handler — SSRF guard first, then the Ghostery match, then a fixed list of known ad/tracker hostnames the lists sometimes let through (e.g. the Facebook SDK). Matches are aborted before they load.
- **Sized placeholders**: ad slots are measured (`getBoundingClientRect`) and replaced with a same-size grey box reading "ব্লক করা হয়েছে" **before** the cosmetic CSS runs (the CSS would otherwise collapse them to 0×0 first, leaving nothing to measure). Out-of-page slots (interstitials, 1×1 pixels, parallax/anchor units) are removed outright rather than boxed. Anything containing a headline, an `<article>`, or more than 300 characters of text is never touched, so an ad-network false-positive can't eat real content.
- **Selectors**: whole-word/path-segment matches only (`\bad\b`, `/ads?/` etc.) — a plain substring test on `ad` would also hit "upload", "Bangladesh", "head", "read" (this was exactly the image-filter bug fixed in Stage 3, §8, and the same care was taken here). Hand-written additions come from inspecting the live DOM of the allowlisted outlets (Prothom Alo's `.adsBox`/`.print-adslot`/cookie `.gdpr-wrapper`; Dhaka Post's `.common-header-ad`/`.footer-ad`/`#ad-inner-N`).
- **Paywalls are detected, never bypassed**: Piano/Tinypass DOM markers, `window.tp`, known paywall-vendor request hosts, and JSON-LD `isAccessibleForFree:false`. When detected, the served page gets a notice — "সাবস্ক্রাইবার কনটেন্ট — মূল সাইটে পড়ুন ↗" — linking to the original, and the gate elements are left exactly as they were. None of the four allowlisted outlets is paywalled; the detector was verified against a Piano-paywalled article on a non-allowlisted site.

Measured on the reference article: 6 placeholders + 4 slots/1 cookie bar removed, 0 ad/tracker requests reach the network (an unblocked baseline load makes ~110 such requests to 18 hosts on the same page).

---

## 7. Open problems

"Confirmed" means the code clearly does this; "Likely" means the logic points that way but it hasn't been run to failure.

| # | Problem | Where | Confidence | Impact |
|---|---|---|---|---|
| P1 | **Extraction itself can still take 7–12s+, and the worst case (every fallback tried) is much longer** — Cheerio → Playwright → axios → Wayback CDX → Cheerio-on-Wayback, each with its own timeout. This is the remaining gap against the 5–6s target (R11); the AI/highlight phases no longer block the article render (fixed — §4.1). | `extractNewsController` | Confirmed | Slow or blocked-site submissions can still feel sluggish |
| P2 | Sidebar headlines on the Live Page get highlighted along with the article body — the reader highlights the whole served page, not just the article container. | `liveProxyReader.js` `buildServedDocument` | Confirmed | Cosmetic over-highlighting in the Live Page view |
| P3 | The salience-selected **headline** is usually ranked #1 by all three providers and consumes part of the 40% character budget, but the headline is not inside the highlighted article body, so that budget is spent without ever being visible. | `salienceEnsemble.js` + Home.js Phase 2/3 | Confirmed | Slightly wastes the sentence-highlight budget |
| P4 | Kimi (and now sometimes Grok) can exceed even a 30–45s per-provider timeout on long articles (~30 sentences), reducing the ensemble to 2 of 3 providers for that run. | `salienceEnsemble.js` | Confirmed (measured) | Occasional loss of one provider's input to the merge; result is still valid (ratio stays ≤0.40) |
| P5 | Only four outlets have been verified end to end through the Live Page reader (Prothom Alo, Daily Star, bdnews24, Dhaka Post). Kaler Kantho is excluded (Cloudflare 403 to headless browsers on article pages, not worked around). Other Bangladeshi outlets (Jugantor, BBC Bangla, etc.) are untested. | `READER_ALLOWLIST` | Confirmed | Everything not allowlisted silently uses Extracted Text only |
| P6 | The Playwright browser was installed by hand on this machine; there is no setup script, so a fresh machine or CI would silently lose Playwright-based extraction and the Live Page reader's snapshot capture. | environment | Confirmed | Fragile setup, not caught by any healthcheck |
| P7 | The iframe `onError` handler for the Wayback view never actually fires for X-Frame-Options/CSP refusals or 4xx/5xx pages (a documented browser limitation, not fixable in this code) — a page that can't be framed shows blank rather than auto-switching. | AnalysisAccordion (Wayback mode) | Confirmed (browser behaviour) | No auto-recovery notice for a blocked archive page |
| P8 | No text-paste input exists in the UI, though `/api/analyze` accepts `{text}` directly. | HeroSection / Home | Confirmed | Missing feature from the original brief ("multi-modal ingestion") |
| P9 | `/api/jaani-stream` calls `playwrightExtractor.extractArticle`, which does not exist on that module — it always falls through to the axios extractor. Noted in passing; not part of Read The News's main path. | api.js (jaani-stream route) | Confirmed | Dead branch inside a side endpoint |

---

## 8. Rebuild history (2026-09-26 / 2026-09-27)

The section was rebuilt from the ground up across seven stages plus two follow-up passes, in response to a security review of the old same-origin proxy iframe and a set of speed/fidelity/highlighting complaints. Summarized here for context; the current design is what §§2–6 describe.

1. **Stage 1 — separate-origin reader.** The old `/api/proxy-iframe` served third-party pages from the app's own origin with `allow-scripts allow-same-origin` on the iframe together — a combination that lets a framed page lift its own sandbox and read the app's storage/DOM. Replaced with `liveProxyReader.js` on its own origin (port 5002), with a proper per-connection SSRF guard. *Finding carried into Stage 4:* Prothom Alo's server HTML has no `<img>` tags at all — the page's own JavaScript builds them — so a same-origin-but-no-scripts proxy would always show a blank hero image.
2. **Stage 2 — parallel AI, non-blocking render.** The article used to stay hidden until extraction *and* both AI calls had all finished, one after another. Now the article renders the instant extraction returns (§4.1); a race-condition test (submit A, then B before A's AI calls resolve) confirmed A's requests are aborted mid-flight and never reach either the UI state or the browser cache.
3. **Stage 3 — image filter and Wayback freshness fixes.** The Playwright image filter used a plain substring test for `"ad"`, which discarded any real photo whose URL or alt text contained "upload", "Bangladesh", "head", "read", etc. — this had been silently dropping every Dhaka Post photo (`/uploads/...`). Fixed to whole-word/path-segment matching. Separately, the Wayback CDX query took `limit=5` and the *last* row, which is the 5th-oldest snapshot, not the newest, on any URL with more than 5 captures; changed to `limit=-1`.
4. **Stage 4 — the Live Page reader becomes the default view**, built on the Stage 1 finding: capture the page with Playwright (scripts run, so JS-injected images exist), strip scripts only *after* capture, then rewrite lazy-image attributes and inject highlights server-side using the exact same matcher the frontend uses. Outlets are allowlisted one at a time after manual verification (§4.2, §7 P5).
5. **Stage 5 — sentence-salience ensemble** (§4.3): three hosted LLMs rank sentence importance in parallel, merged and capped in code, delivered by polling so it never blocks the article render.
6. **Stage 6 — ad/tracker/cookie-bar/paywall handling** in the reader (§6), including the specific gaps the Stage 4 reader had left uncaught on Prothom Alo and Dhaka Post.
7. **Stage 7 — browser cache** (§4.4) so a repeat visit to the same article skips the network entirely.
8. **Close-out pass** (still 2026-09-27): the Kimi per-provider timeout override was added; a real network-level cancellation race was verified with timestamps; the Read The News Debug box was removed; and a large amount of dead code was deleted — the unused `analyzeController` (~770 lines) and everything only it used, several Puppeteer-based and legacy-highlighter extractor functions, and the frontend's dead `contentBlocks`/`replicaSrcDoc`/`quotes`/`ad*`/`videoMessage`/`extractedImages`/`articleCss` props and their unreachable render branches. This was committed as `10cd927` on branch `section-1-read-the-news-v3` (the committed tree was independently verified to boot and to build on its own).
9. **Follow-up pass A — keyword dataset removed** (uncommitted at the time of writing): the CSV-keyword `/api/keywords` endpoint, its loader, and the frontend's DOM-mutation keyword pass (`highlightKeywordsInElement`) are gone entirely. Keyword highlights now come only from `geminiKeywords`. The four highlight colours were also unified (§5.2) — they had drifted out of sync between the inline span styles and the Extracted view's `sx` overrides.
10. **Follow-up pass B — blank Live Page fixed.** The reader was returning a valid 200 response (479,999 bytes, correct headline) but rendered blank inside VS Code's built-in browser, which shows the app inside its own webview frame; CSP `frame-ancestors` is checked against *every* ancestor frame, so an origin allowlist there blanks the Live Page whenever the app itself is embedded by something else. `frame-ancestors` is now off by default (only sent if `READER_FRAME_ANCESTORS` is explicitly set); the frontend-origins-allowed-to-call-`/prepare` check was split out as `READER_APP_ORIGINS`. Verified by embedding the app inside another origin's frame and confirming the reader still renders.

---

## 9. Configuration knobs

| Env var | Default | Effect |
|---|---|---|
| `PORT` | 5005 | backend port (5000 is held by macOS AirPlay on this machine; 5001 was an interim choice) |
| `NEWS_EXTRACT_MAX_WORDS` | 2500 | word cap on extracted text sent to the AI |
| `ANALYZE_MAX_WORDS` | 2000 | words sent to `analyzeQuick` |
| `ENTITY_EXTRACT_TIMEOUT_MS` | 8000 (Kimi ≥30000) | consensus entity timeout |
| `ANALYZE_QUICK_MAX_TOKENS` | 900 | LLM output budget for keywords/summary/etc. |
| `LLM_AUTO_ORDER` | `openai,grok,kimi` | main-pipeline provider order for "Auto" |
| `ALLOW_INSECURE_GOV_TLS` | true | TLS bypass for .gov.bd and broken certificate chains |
| `ALLOW_PRIVATE_NETWORK_URLS` | false | SSRF guard |
| `READER_PORT` / `READER_PUBLIC_ORIGIN` | 5002 / `http://localhost:5002` | Live Page reader's own origin (production: a separate registrable domain, not a subdomain) |
| `READER_ALLOWLIST` | `www.prothomalo.com,www.thedailystar.net,bdnews24.com,www.dhakapost.com` | hostnames the reader will serve; others get 400 and the frontend falls back to Extracted Text |
| `READER_APP_ORIGINS` | localhost:3000, 127.0.0.1:3000, localhost:5005 | frontend origins allowed to call the reader's `/prepare` |
| `READER_FRAME_ANCESTORS` | unset (off) | optional CSP `frame-ancestors`; setting it can blank the Live Page if the app itself is ever embedded (§8) |
| `READER_NAV_TIMEOUT_MS` / `READER_SETTLE_MS` | 20s / 5s | reader snapshot navigation / settle time |
| `SALIENCE_OPENAI_MODEL` / `SALIENCE_GROK_MODEL` / `SALIENCE_KIMI_MODEL` | `gpt-6-astra` / `grok-4.7` / `kimi-k3` | salience-ensemble models only (chosen from a `/v1/models` audit of each key, 2026-09-26; the main analysis pipeline keeps `OPENAI_MODEL`/`GROK_MODEL`/`KIMI_MODEL` above) |
| `SALIENCE_PROVIDER_TIMEOUT_MS` / `SALIENCE_TIMEOUT_MS_<PROVIDER>` | 30000 / unset | per-provider ranking timeout, with an optional per-provider override (Kimi is set to 45000) |
| `SALIENCE_MAX_BUDGET_RATIO` | 0.40 | max share of article characters selected as important sentences |
| `REACT_APP_READER_ORIGIN` (frontend) | `http://localhost:5002` | where the frontend points the Live Page iframe |

---

## 10. Test URLs used in this work

- `https://www.prothomalo.com/bangladesh/crime/diag0jvbhb` — main reference article (title, subtitle, hero with caption, ads, officer "অতিরিক্ত উপকমিশনার নিয়াজ মেহেদী", org "ডিএমপি / ঢাকা মহানগর পুলিশ")
- `https://www.prothomalo.com/business/economics/dsqg6uqgyj` — longer article (~31 sentences), used to stress the salience ensemble's timeouts
- `https://www.prothomalo.com/sports/cricket/avoxoekvrt` — multi-image gallery case
- `https://www.thedailystar.net/...`, `https://bdnews24.com/...`, `https://www.dhakapost.com/...` — one article each, used to verify the Live Page reader and ad-blocking across outlets
- `https://www.kalerkantho.com/...` — Cloudflare-blocks headless browsers on article pages; used to verify the silent-fallback-to-Extracted-Text path
- A non-allowlisted Piano-paywalled article — used only to verify paywall detection

## 11. How to run and check it

```bash
# backend (5005) — also starts the Live Page reader on 5002
cd backend && node index.js            # health: curl localhost:5005/health ; curl localhost:5002/health
# frontend (3000, proxies /api → 5005)
cd frontend && BROWSER=none npm start
# extraction only
curl -s -X POST localhost:5005/api/analyze -H 'Content-Type: application/json' \
  -d '{"url":"https://www.prothomalo.com/bangladesh/crime/diag0jvbhb"}' | head -c 1500
```
After frontend changes, hard-refresh the browser (Cmd+Shift+R).

---

## 12. Security fix: redirect hops (2026-09-28)

§4.2's description ("every request of that page … is SSRF-checked") was **not true for redirect hops**. Playwright's `page.route()` only sees the first URL of a redirect chain, so a public URL redirecting to `127.0.0.1` was loaded, and its content ended up in the served snapshot (demonstrated with a local canary). The reader's browser is now launched through `backend/utils/egressGuardProxy.js`, which applies this module's own `isLocalHostname`/`isPrivateOrReservedIp` to every connection, including redirect hops, and connects to the exact address it checked. The proxy is created and destroyed together with the browser. `page.route()` still does the first-request SSRF check and ad/tracker filtering. Details and measurements are in `s2_na.md` §15.5: 0 canary hits after the fix; Prothom Alo crime still 14 images in 3.2–3.6 s; the Dhaka Post and Live view highlights work.
