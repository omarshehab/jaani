# Section 15.1 baseline (recorded 2026-09-29, before any Node/React change)

Recorded by `python -m compat.baseline` against a sandboxed copy of the backend (`compat/sandbox.py`,
ports 5105/5102) that reads `JAANI_RTI_OFFICERS_COMPLETE.backup.csv` (59 filled rows, 2026-09-25).
The repo-root CSV and `shared/officer_photos` were not touched.

| Call | Status | Time | Result |
|---|---|---|---|
| POST /api/verify-contact স্বরাষ্ট্র মন্ত্রণালয়, enrich_web=false | 200 | 10.8 s | 3 matches (MoHA, IRD, Finance Division); all 3 slots found |
| same, enrich_web=true | 200 | 0.6 s | identical officer data to the DB pass |
| GET /api/extract-image MoHA page, count=3 | 200 | 0.1 s (memory cache) | primary/alternate/appellate images, 3 distinct files |
| POST /api/contacts/update (copy of CSV) | 200 | 0.02 s | edited row found, 59 -> 59 rows (no twin inserted) |

## Findings

1. **The "fast DB-only" pass is not DB-only (audit P2 confirmed):** with enrich_web=false it still ran Playwright
   against moha.gov.bd, ird.gov.bd and mof.gov.bd for photos (10.8 s).
2. ~~Live retry does not refresh officer text~~ **Corrected after a controlled re-run against the mock portal:**
   the live pass does scrape the new names, but writes them to `Primary_Officer` (the key the UI reads) while the
   raw CSV key `Primary_Officer_Name` in the same response keeps the old value; the CSV itself IS updated. The
   baseline run above hit the real moha.gov.bd within the 7 s website budget and got nothing usable in time.
3. **R3 violations that remain:** (a) the fast (DB) pass fetches live photos and pairs them with the CSV names, so a
   stale row shows the new officers' photos under the old names; (b) photos from `fetchAllOfficerImages` are handed
   out by position (1st image -> primary, 2nd -> alternate, 3rd -> appellate), so when the alternate has no photo it
   receives the appellate officer's photo; (c) VerificationGrid falls back to the same positional images.
4. Page facts for parsers: server-rendered Template A; headings `h3.info-officer-view-widget-heading`; e-mails
   are split by `<wbr>` (`admin1<wbr>@moha.gov.bd`); the heading text uses য় as য + nukta after NFC, so matching
   must normalise both sides.

UI screenshots of the four flows are taken at the start of stage 6, before any existing Node/React file is edited.

## UI flows (recorded 2026-09-29 with compat/ui_baseline.py, reference article prothomalo diag0jvbhb)

Screenshots and responses: `baseline/ui/`. All four flows ran: fast verify (2 verify-contact calls, both 200), live
scrape (automatic slow pass; the retry button only appears in degraded mode and was not shown), Edit dialog (iframe
`/api/webview?url=https://minlaw.gov.bd/views/info-officers`) + Save (200, 59 -> 59 rows, the edited Office text did
not rename the row), cached-data button (not shown: only rendered in degraded mode).

5. **Wrong offices for the reference article:** both verify passes returned the first four CSV rows in order
   (আইন..., কৃষি..., খাদ্য..., গৃহায়ন ও গণপূর্ত মন্ত্রণালয়) instead of MoHA/DMP. The ranking fell through to its
   "first rows" fallback. Section 15.7(b) expects MoHA; this is an existing defect, not caused by this work.
6. The first card showed no photos at screenshot time although the row has image URLs (placeholder person icon).
