<p align="center">
  <img src=".github/assets/banner.jpeg" alt="জানি — JAANI" width="640">
</p>

<h3 align="center">সূর্যালোকই সর্বোত্তম জীবাণুনাশক।</h3>
<p align="center"><em>"Sunlight is the best disinfectant."</em></p>

<p align="center">
  A civic-tech platform that turns a Bangladeshi news article into a verified Right to Information (RTI) request —
  automatically, in minutes, grounded in the RTI Act 2009.
</p>

<p align="center">
  <a href="#the-four-sections">Architecture</a> ·
  <a href="#getting-started">Getting Started</a> ·
  <a href="#testing">Testing</a> ·
  <a href="#security-model">Security</a> ·
  <a href="#deployment">Deployment</a> ·
  <a href="#license">License</a>
</p>

---

## What is JAANI?

**জানি** (JAANI, "I know") reads a news article, works out what the story means for government accountability, finds the exact official responsible for the information in it, and gets a citizen most of the way to a filed RTI request — without ever fabricating a fact, an office, or an officer's name along the way.

It was built for Bangladesh's Right to Information Act 2009, but the pipeline — extract → analyze → verify → act — generalizes to any jurisdiction with a public-records law and a government directory to match against.

**Design principles that shape every decision in this codebase:**

- **Hosted LLMs only, nothing invented.** No local ML model, no heuristic stand-in for AI output. When every provider fails, the UI says so — it never shows a plausible-looking guess.
- **Never fabricate, never borrow.** An officer's name, phone, or photo is only ever attributed to the role it actually belongs to. A blank field stays blank rather than being padded or guessed.
- **Verify before you trust.** Every new data source — a `.gov.bd` domain, a scraped officer record — is checked before it's written back, and the dataset is self-healing: visiting an article about an office can quietly correct and backfill that office's own record for the next person.
- **SSRF-safe by construction.** Anything that fetches a URL on the server's behalf (the Live Page reader, the evidence capturer, the officer-page scraper) resolves and checks the destination host — including every redirect hop — before connecting, not just the URL the user typed.

---

## The Four Sections

JAANI is one continuous flow across four sections, each documented in exhaustive detail in [`section files/`](section%20files/) — the single source of truth for how each piece actually works, including every open problem and every decision's rationale.

```
 1. Read The News  ──▶  2. News Analysis  ──▶  3. Officers Directory  ──▶  4. Send Message
    (RTN)                 (What's in the news?)   (verification)            (RTI mail)
```

| # | Section | What it does | Deep-dive doc |
|---|---|---|---|
| **1** | **Read The News** | Paste a URL. The real article renders — exact layout, images in place, ads blocked, officials underlined, organizations highlighted — via a sandboxed "Live Page" reader on its own origin, with an extracted-text and Wayback-archive fallback for anything not allowlisted. | [`section files/s1_rtn.md`](section%20files/s1_rtn.md) |
| **2** | **News Analysis** | AI summary, key highlights, detected people/organizations/locations, the RTI target office, related news in other outlets with resolved publisher URLs, matched fact-checks, and a court-ready forensic evidence PDF (screenshots, hashes, RFC 3161 timestamp, Internet Archive proof) — all server-derived, never from client-supplied text. | [`section files/s2_na.md`](section%20files/s2_na.md) |
| **3** | **Officers Directory** | Every government body the article actually mentions gets resolved to a real officer record — deterministic matching first, then a validated AI fallback for anything not in the curated gazetteer, climbing office → division → ministry until it finds a real, populated authority. A live DB-vs-government-website diff highlights any field that's gone stale. | [`section files/s3_RTIod.md`](section%20files/s3_RTIod.md) |
| **4** | **Send Message** | Compose and send the RTI request to the verified officer, with Gmail OAuth and (planned) Postmark transport. | — |

### End-to-end flow

```
┌─────────────┐     ┌──────────────────┐     ┌────────────────────┐     ┌─────────────┐
│  Paste URL  │────▶│  Extract article  │────▶│  AI analysis +      │────▶│  Compose &  │
│             │     │  (Cheerio→        │     │  entity detection   │     │  send RTI   │
│             │     │  Playwright→      │     │  (parallel LLM      │     │  request    │
│             │     │  Wayback fallback)│     │  calls, consensus)  │     │             │
└─────────────┘     └──────────────────┘     └──────────┬──────────┘     └──────▲──────┘
                            │                            │                       │
                            ▼                            ▼                       │
                    ┌──────────────────┐     ┌────────────────────┐             │
                    │  Live Page reader │     │  Officer directory  │─────────────┘
                    │  (own origin,     │     │  resolution: CSV   │
                    │  SSRF-guarded,    │     │  exact match →      │
                    │  ad-blocked,      │     │  ladder climb →     │
                    │  highlighted)     │     │  AI fallback →      │
                    └──────────────────┘     │  live gov.bd scrape │
                                              └────────────────────┘
```

Every stage renders as soon as its own data is ready — the article appears in ~7–8s, long before AI analysis or officer resolution finish, and a slower/older request can never silently overwrite what a newer one already rendered.

---

## Architecture

### System overview

```
┌────────────────────────────────────┐
│            React Frontend             │
│             (port 3000)               │
│  Home → AnalysisAccordion →           │
│  VerificationGrid → MailCard          │
└───────────────────┬────────────────────┘
                    │ /api/*
┌───────────────────▼────────────────────┐
│             Express Backend             │
│              (port 5005)                │
│  routes/api.js (orchestration)          │
│   ├─ extraction                         │
│   │   (Cheerio → Playwright → axios     │
│   │    → Wayback fallback)              │
│   ├─ geminiAnalysis.js                  │
│   │   (LLM task routing: OpenAI /       │
│   │    Grok / Kimi, cheap vs flagship)  │
│   ├─ rtiGazetteer.js +                  │
│   │   officeResolution.js               │
│   │   (deterministic CSV matching)      │
│   ├─ aiOfficeFallback.js                │
│   │   (validated LLM fallback)          │
│   ├─ scrapeInfoOfficersPage +           │
│   │   imageFetcher.js                   │
│   │   (live gov.bd officer + photo      │
│   │    pipeline)                        │
│   ├─ officerDiff.js                     │
│   │   (DB-vs-live discrepancy diff)     │
│   └─ forensicEvidence.js                │
│       (court-ready capture + PDF)       │
└─────────┬──────────────────────┬────────┘
          │                      │
┌─────────▼─────────┐  ┌─────────▼──────────────┐
│   Live Page         │  │   JAANI_RTI_              │
│   Reader             │  │   OFFICERS_                │
│   (port 5002, own    │  │   COMPLETE.csv              │
│   origin, egress-     │  │   (the one dataset,          │
│   guarded)             │  │   self-healing)               │
└──────────────────────┘  └────────────────────────────────┘
```

### Repository layout

```
jaani/
├── backend/                   Express API server (port 5005) + Live Page reader (5002)
│   ├── routes/                api.js (orchestration), axiosFastExtractor.js, playwrightExtractor.js
│   ├── services/              geminiAnalysis, rtiGazetteer, aiOfficeFallback, rtiActGuidance,
│   │                          forensicEvidence, liveProxyReader, adBlockEngine, salienceEnsemble,
│   │                          factCheckIndex/Lookup, googleNewsDecoder, imageFetcher
│   ├── utils/                 officeResolution.js, officerDiff.js, officerUrlGuard.js,
│   │                          egressGuardProxy.js — the deterministic/security core, unit-tested
│   ├── config/                llmTaskRouting.js (task → tier → model resolution)
│   ├── data/                  contactLoader.js (the one dataset's loader)
│   └── tests/                 node --test suite (306 tests)
├── frontend/                  React (CRA) app (port 3000)
│   └── src/
│       ├── pages/Home.js              orchestration: cache, extraction, AI calls, verification hand-off
│       ├── components/
│       │   ├── AnalysisAccordion.js   Sections 1 & 2 UI
│       │   ├── VerificationGrid.js    Section 3 UI (officer cards, edit/compare dialog)
│       │   └── MailCard.js            Section 4 UI
│       ├── utils/highlightHTMLEntities.js   the one highlight matcher (shared with the reader)
│       └── db/jaaniDB.js              Dexie browser cache (24h TTL)
├── scraper/                    Standalone Python pipeline that fills the officer directory CSV
│   ├── jaani_scraper/          pipeline.py, parse.py, validate.py, importers.py, files.py, llm.py
│   └── tests/                  pytest suite (419 tests) + HTML fixtures from real gov.bd pages
├── JAANI_RTI_OFFICERS_COMPLETE.csv   The one officer dataset — 280 rows, 26 columns, self-updating
├── section files/               s1_rtn.md / s2_na.md / s3_RTIod.md — the real architecture reference
├── scripts/                     One-off data-collection tools (legacy, not in the live request path)
└── ml-service/                  Deprecated local-ML service, superseded by the hosted-LLM pipeline
```

### Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18 (Create React App), Material UI, Dexie (IndexedDB), i18next (bn/en) |
| Backend | Node.js, Express, Playwright (headless Chromium), Cheerio, jsdom |
| AI / LLM | OpenAI, xAI (Grok), Kimi (Moonshot) — routed per task by cost/latency tier, never hard-coded |
| Data | A single CSV as the officer-directory source of truth; Dexie for client-side article caching |
| Security | Ghostery filter lists (ad/tracker blocking), a hand-rolled per-connection SSRF guard (resolves and checks every redirect hop, not just the entry URL), RFC 3161 timestamping + SHA-256/512 hashing for evidence integrity |
| Scraper | Python 3, httpx/requests, BeautifulSoup, pytest — a separate, independently-testable pipeline that fills and verifies the officer directory |

---

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Python 3.11+ (only if you'll run the officer-directory scraper)
- At least one LLM provider API key (OpenAI, xAI/Grok, or Kimi/Moonshot) — the app degrades gracefully with fewer, but needs at least one to produce AI analysis

### 1. Clone and install

```bash
git clone https://github.com/omarshehab/jaani.git
cd jaani

cd backend && npm install
cd ../frontend && npm install
cd ..
```

### 2. Configure environment variables

```bash
cp env.example backend/.env
cp env.example frontend/.env     # only REACT_APP_* vars are read here
```

Fill in at minimum one LLM provider key in `backend/.env`. See [`env.example`](env.example) for every variable this project reads, grouped by what feature it powers, with the relevant section doc referenced inline.

### 3. Install the Live Page reader's browser (Section 1)

The reader (and the officer-page/evidence scrapers) need a headless Chromium:

```bash
cd backend && npx playwright install chromium
```

### 4. Run it

```bash
# Terminal 1 — backend (also starts the Live Page reader on :5002)
cd backend && node index.js

# Terminal 2 — frontend
cd frontend && BROWSER=none npm start
```

Open **http://localhost:3000**. Health checks: `curl localhost:5005/health` and `curl localhost:5002/health`.

### 5. (Optional) Re-run or extend the officer-directory scraper

```bash
cd scraper
python3 -m venv .venv && .venv/bin/pip install httpx pdfplumber pypdf pypdfium2 python-docx openpyxl \
    beautifulsoup4 lxml phonenumbers python-dotenv pyyaml pytest bnunicodenormalizer Levenshtein \
    regex tldextract reportlab filelock pytesseract
export JAANI_CONTACT_EMAIL=you@example.org   # required: sent in the User-Agent to every site
```

See [`scraper/README.md`](scraper/README.md) for the full command reference (`run`, `check`, `finalize`,
`compat-check`, and more) — it's a standalone, independently-testable pipeline, not something the live
app calls at runtime.

---

## Testing

```bash
# Backend — 306 tests covering office resolution, the DB-vs-live diff, SSRF guards,
# role-heading classification, text-integrity screening, and provider fallthrough
cd backend && node --test 'tests/**/*.test.js'

# Scraper — 419 tests, including real-page HTML fixtures from dozens of gov.bd portal templates
cd scraper && python3 -m pytest tests/ -q
```

Both suites are designed to run with zero network access and zero shared mutable state — fixtures are real captured HTML, not live fetches, so a CI run is deterministic.

---

## Security Model

| Surface | Protection |
|---|---|
| Live Page reader, evidence capture browser | Every connection (including redirect hops, which a simple request-interception layer never sees) is resolved and checked against private/reserved IP ranges before connecting — `backend/utils/egressGuardProxy.js` |
| Officer-page scraper | Same discipline via `backend/utils/officerUrlGuard.js`, independent of the reader's guard |
| Evidence PDF rendering | HTML sanitized against an allowlist, every field escaped, JavaScript disabled in the rendering browser |
| Evidence integrity | Text/metadata are derived from the server's own capture, never trusted from the client; SHA-256/512 + RFC 3161 timestamp + Internet Archive snapshot, independently verifiable after the fact |
| CSV write path | Every write goes through one function (`contactLoader.upsertContactInCsv`) with score-gated matching, so a save can update an existing row but can't silently create duplicate or wrong-office records |
| AI office-fallback classification | Only ever picks among names that already exist in the dataset's own ministry/office lists — a misclassification can at worst point to the wrong *real* office, never invent one |
| Secrets | API keys are read from environment variables only, never logged; see `.gitignore` for the (long, hard-won) list of what never leaves a local machine |

---

## Deployment

The codebase is currently a two-process local setup (Express API + reader on one host, CRA dev server on another). It wasn't yet containerized or deployed to a cloud provider as of this snapshot — here's the shape that work should take.

### Target architecture

| Component | Where it runs | Notes |
|---|---|---|
| **Frontend** (React, static build) | **Vercel** or an S3+CloudFront static site | `npm run build` in `frontend/` produces a static bundle; point `REACT_APP_BACKEND_URL`/`REACT_APP_READER_ORIGIN` at the deployed backend/reader |
| **Backend API** (Express, port 5005) | **AWS (ECS/Fargate or EC2)** or **Google Cloud Run** | Needs persistent disk for the CSV dataset and `shared/officer_photos/` (or move both to S3/GCS — see below); not stateless as written today |
| **Live Page reader** (port 5002) | Same host as the backend, or a separate container | Must run headless Chromium — use a container image with Playwright's dependencies preinstalled (`mcr.microsoft.com/playwright` base image, or `npx playwright install --with-deps` in the Dockerfile) |
| **Officer directory CSV** | Start on the backend's own disk; move to **S3/GCS + a small read-through cache**, or a managed Postgres table, once multiple backend instances need to share writes | `contactLoader.js`'s mtime/size cache-invalidation logic assumes a local file today — this is the main change needed for horizontal scaling |
| **Officer photos** (`shared/officer_photos/`) | Same consideration — move to S3/GCS and serve via CDN instead of the backend's own filesystem | |
| **Evidence vault** (`backend/data/evidence_vault/`) | S3/GCS with a lifecycle rule matching `EVIDENCE_RETENTION_DAYS` | Already designed around atomic writes + an index file, which maps cleanly onto object storage |

### Before deploying

1. **Containerize the backend + reader together** (they share one process today via `liveProxyReader.startReaderServer()`); a Dockerfile needs the Playwright browser baked in — budget real build time and image size for this.
2. **Externalize the dataset and photo storage** as above, or accept a single-instance deployment to start (entirely workable for an initial launch — the whole pipeline was built and tested against local disk).
3. **Set every variable in `env.example`** in your platform's secret manager (AWS Secrets Manager / GCP Secret Manager / Vercel environment variables) — never bake API keys into an image.
4. **Point `READER_PUBLIC_ORIGIN`, `READER_ALLOWLIST`, and `FRONTEND_URL`** at their real deployed values; the reader's CSP and CORS logic (`s1_rtn.md` §4.2, §8 item 10) is strict by design and will quietly fall back to extracted-text-only if these don't match reality.
5. **Decide a retention/backup policy** for the CSV before go-live — it's the one dataset everything else reads from, and it writes to itself on every verification.

---

## Documentation

- [`section files/s1_rtn.md`](section%20files/s1_rtn.md) — Section 1 (Read The News): extraction, the Live Page reader, highlighting, ad/paywall handling
- [`section files/s2_na.md`](section%20files/s2_na.md) — Section 2 (News Analysis): AI pipeline, gazetteers, RTI Act guidance, fact-checking, forensic evidence
- [`section files/s3_RTIod.md`](section%20files/s3_RTIod.md) — Section 3 (Officers Directory): resolution pipeline, the DB-vs-live diff, the scraper's data model

Each document is written as a living reference: requirements traced to their source, every file's role, exact pipeline behavior, known open problems, and the history of how the section got there — not a snapshot that goes stale, but the thing to read before changing that section.

## License

MIT — see [LICENSE](LICENSE).

<p align="center"><sub>জানি — তথ্য অধিকার আইন ২০০৯ · গণপ্রজাতন্ত্রী বাংলাদেশ সরকার</sub></p>
