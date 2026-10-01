# JAANI Section 3 officer filler (`scraper/`)

Fills the 21 officer columns of `s3/JAANI_RTI_OFFICERS_COMPLETE.csv` (245 rows) from each body's own RTI officer
page, including role-correct photo URLs. The data is used for legal RTI requests, so a wrong value is worse than a
blank: every value is printed on an official page for that exact row, passes the text-integrity gate, and (for
photos) sits inside that role's own block on the page.

## Setup

```bash
cd scraper
python3 -m venv .venv && .venv/bin/pip install httpx pdfplumber pypdf pypdfium2 python-docx openpyxl beautifulsoup4 \
    lxml phonenumbers python-dotenv pyyaml pytest bnunicodenormalizer Levenshtein regex tldextract reportlab filelock pytesseract
export JAANI_CONTACT_EMAIL=you@example.org      # required: sent in the User-Agent to every site
# optional OCR for legacy-font PDFs: brew install tesseract tesseract-lang
```

LLM keys and model IDs are read from `backend/.env` (`OPENAI_API_KEY`, `XAI_API_KEY`/`GROK_API_KEY`,
`KIMI_API_KEY`/`MOONSHOT_API_KEY`, `TASK_CHEAP_<P>_MODEL`, `TASK_FLAGSHIP_<P>_MODEL`, `LLM_AUTO_ORDER`). No model
name is written in this code. Keys are never printed or logged.

## Commands (`python -m jaani_scraper <cmd>`, run from `scraper/`)

| command | what it does |
|---|---|
| `check` | link check only (the owner's `s3/verify_links.py` classifier behind the guarded fetcher) -> `out/link_check_report.csv` |
| `run` | the whole pipeline for the selected rows (`--tier`, `--only-host`, `--only-row "M|D|O"`, `--limit`, `--dry-run` ...). `run` and `check` refuse to start without `--tier`/`--only-row`/`--only-host`; empty filters, zero/negative limits and budgets are refused, never read as "everything". `--llm-max-usd` caps this run's spend. |
| `import-html DIR` | saved pages / snippet JSON for robots-blocked hosts (source `human_saved`) |
| `import-infocom FILE` | an official Information Commission export (fills blank cells only, source `infocom`) |
| `apply-overrides [FILE]` | `out/confirmed_overrides.csv` (source `human_confirmed`, beats everything) |
| `finalize` | placeholder photos used by >= 3 bodies are blanked; rows listing the same officers are reported |
| `recover-file PATH` | debug the legacy-font recovery on one PDF/HTML |
| `compat-check` | Section 15: the Node app against a mock portal and a sandboxed CSV copy (never the live app) |
| `report` | rebuild `out/coverage_report.md` and `out/photo_review.html` |
| `audit-models` | list what each provider key can see (`/v1/models`) |

Output: the filled CSV is written to `s3/out/JAANI_RTI_OFFICERS_COMPLETE.filled.csv` (atomic write, timestamped
backup in `s3/out/backups/`, file lock). The repo-root CSV the backend uses is never touched: stop the backend and
copy the file over it yourself. Sidecars in `scraper/out/`: `state.sqlite`, `scrape_log.jsonl`,
`text_recovery.jsonl`, `review_queue.csv`, `manual_queue.csv`, `discrepancies.csv`, `unextracted_signals.csv`,
`coverage_report.md`, `photo_review.html`, `bijoy_review.html`, `confirmed_overrides.csv`, `row_status.json`
(read by the backend to decide the s.6(3)(d) note).

## Rules the code enforces

- robots.txt for every host, honest User-Agent, one request at a time per host, >= 3 s (or Crawl-delay), TLS on;
  429/503 back-off 30 s / 2 min / 10 min then the host stops; 3 failures stop a host for 6 h.
- SSRF: scheme, ports 80/443, host suffix (`config/allowed_host_suffixes.txt`), deny/manual lists; the DNS answer is
  checked inside the connection layer, so redirect hops and DNS rebinding are covered (`jaani_scraper/netguard.py`).
- Exempt bodies (RTI Act s.32 Schedule) are never fetched (`config/deny_hosts.txt`, `config/deny_bodies.txt`).
- Photos: only an image inside the role's own block, for a role with a stored name; gallery photos only by the
  officer's name / employee ID / role word in filename, alt or title; verified (200, image/*, >= 2 KB).
- LLM: only for pages the deterministic parser could not resolve; every value must be a verbatim substring of the
  text sent (lines that address a model are removed first); name/phone/mobile/e-mail also need a second provider or
  the deterministic value to agree; caps `--llm-max-pages`, `--llm-max-usd` (estimated from reported tokens).

## Legacy-font (Bijoy / SutonnyMJ) recovery

**Mapping source and licence.** `config/bijoy_map.json` was extracted mechanically (not typed) from npm
`bijoy2unicode@1.0.2`, `dist/index.js` (github.com/JehadurRE/Bijoy2Unicode), MIT License, Copyright (c) 2026 Md. Jehad
(Jehadur Rahman Emran); the licence text is `config/bijoy_map.LICENSE` (package sha256
`78b7a1ec30a989d303760fdeb35e04c083d9d4291d690a95e5df5b39f97b7f8a`). `jaani_scraper/bijoy.py` ports the package's
reordering with three documented deviations: (1) precomposed ড় ঢ় য় count as consonants for reordering; (2) the
post-processing that turns "ঃ" after a space or digit into ":" is dropped (the brief forbids "improving"
punctuation and the gazette vector needs "মূল্য ঃ টাকা"); (3) a reph stored after consonant + vowel sign (Bijoy
"KZ…©" = ত ৃ র্) is moved before the cluster (র্তৃ); a moved reph is marked so it is never moved twice.

**Vectors.** `shared/text_integrity_vectors.json` holds 90 conversion vectors (the 12 from the brief + 78 words of
page 1 of the RTI Act 2009 gazette, each compared by eye with a 300 dpi render of the same page) and the
classification cases. Two words are recorded separately under `render_mismatch`: the PDF itself draws the — glyph as
a ড়-like shape (font substitution in the file), so its rendering and its text layer disagree. Both the Python tests
and `backend/tests/textIntegrity.test.js` read this file.

**Classifier thresholds (tuned).** Font names outrank statistics: a legacy font name -> BIJOY_ANSI; a named
non-legacy font with no Bengali letters -> ENGLISH_OK. Without a font: >= 2 legacy symbols (Latin-1 block and
† ‡ ˆ ‰ Š š Œ œ Ÿ ƒ „ … ‹ › ˜ ™ ¯), or at least one *strong* token (legacy symbol, internal capital as in "msL¨v",
backtick, word-final "|") with (strong + 0.5 x weak) / tokens >= 0.5 -> BIJOY_ANSI. *Weak* = a vowel-less letter run
("bs") that is not an all-caps acronym or a known abbreviation. No strong and no weak token -> ENGLISH_OK, otherwise
UNKNOWN (never stored). "•" and typographic quotes/dashes are not signatures (they occur in real English UI text).
Visual-order breakage: a leading vowel sign / hasanta / candrabindu / anusvara / nukta, a detached reph (word-final
"র্"), doubled vowel signs, U+FFFD, or >= 10 % of words that `bnunicodenormalizer` reports as InvalidUnicode.
Tuning evidence: 0 false rejections over all 1,809 non-empty values of the 59-row and 245-row CSVs; 0 false
conversions over the English pages of the RTI Act PDF and the live moha.gov.bd page. Deviation from the brief: a
word-final hasanta in general is **not** treated as broken, because real officer names use it (শাহ্, মিজ্); the
normalizer's complaint about a nukta on জ (ফিজ়নূর) is ignored for the same reason.

**Second reading.** Recovered high-risk values (name, phone, mobile, e-mail) are written only when an independent
reading of the rendered crop agrees (Tesseract `ben+eng` if installed, and/or a vision model from `backend/.env`,
`TASK_VISION_<P>_MODEL` or the flagship model). Otherwise they go to `out/bijoy_review.html` with the crop, and the
owner can confirm them in `out/confirmed_overrides.csv`.

## Robots-blocked hosts: the in-browser snippet

1. Open the office's RTI officer page normally in your browser.
2. Open DevTools -> Console, paste the whole of `tools/extract_in_browser.js`, press Enter. It reads only the page
   you are looking at and downloads `<host>.json`; it does not fetch or click anything.
3. Put the JSON files (or pages saved with "Save as -> HTML only" plus a `<name>.url.txt` holding the page URL) in
   one folder and run `python -m jaani_scraper import-html <folder>`.
Values pass the same validators and the same integrity gate as scraped values (source `human_saved`).

## Tests

```bash
.venv/bin/python -m pytest -q tests          # Python (no network)
cd ../backend && npm test                     # Node, incl. textIntegrity, section3Compat, officerUrlGuard
cd ../frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern VerificationGrid
cd ../scraper && .venv/bin/python -m jaani_scraper compat-check   # Section 15 matrix, writes out/compat_report.md
```
