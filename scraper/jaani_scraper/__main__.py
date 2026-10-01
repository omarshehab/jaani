"""python -m jaani_scraper <command>   (section 13; run from scraper/)"""
import argparse
import json
import os
import sys
from pathlib import Path

from . import csvio
from .llm import LLMAssist, load_env

SCRAPER = Path(__file__).resolve().parents[1]
REPO = SCRAPER.parent
DEFAULT_CSV = REPO / 's3' / 'JAANI_RTI_OFFICERS_COMPLETE.csv'
DEFAULT_OUT = SCRAPER / 'out'


def build_parser():
    ap = argparse.ArgumentParser(prog='python -m jaani_scraper', description=__doc__)
    ap.add_argument('command', choices=['check', 'run', 'import-html', 'import-infocom', 'finalize', 'recover-file',
                                        'apply-overrides', 'compat-check', 'report', 'audit-models'])
    ap.add_argument('target', nargs='?', help='DIR / FILE / PATH for import-*, recover-file, apply-overrides')
    ap.add_argument('--csv', default=str(DEFAULT_CSV))
    ap.add_argument('--out', default=str(DEFAULT_OUT))
    ap.add_argument('--filled', default=None, help='output CSV (default s3/out/JAANI_RTI_OFFICERS_COMPLETE.filled.csv)')
    ap.add_argument('--tier', type=int, action='append', choices=[1, 2, 3, 4])
    ap.add_argument('--only-host')
    ap.add_argument('--only-row')
    ap.add_argument('--limit', type=int, default=None)
    ap.add_argument('--retry-failed', action='store_true')
    g = ap.add_mutually_exclusive_group()
    g.add_argument('--no-llm', action='store_true')
    g.add_argument('--llm-all', action='store_true')
    ap.add_argument('--llm-max-pages', type=int, default=300)
    ap.add_argument('--llm-max-usd', type=float, default=5.0)
    ap.add_argument('--vision-check', action='store_true')
    ap.add_argument('--render', action='store_true')
    ap.add_argument('--allow-archive', action='store_true')
    ap.add_argument('--archive-max-age-months', type=int, default=18)
    ap.add_argument('--allow-ocr', action='store_true')
    ap.add_argument('--ocr-engine', choices=['tesseract', 'vision', 'both'], default=None,
                    help='naming an engine turns OCR on (same as --allow-ocr); default engine: both')
    ap.add_argument('--no-recovery', action='store_true', help='do not convert legacy-font text (everything garbled goes to review)')
    ap.add_argument('--download-photos')
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--delay', type=float, default=3.0)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--insecure-host', action='append', default=[])
    return ap


def contact():
    load_env()
    c = os.environ.get('JAANI_CONTACT_EMAIL', '')
    if '@' not in c:
        sys.exit('Set JAANI_CONTACT_EMAIL (your contact address; it is sent in the User-Agent to every site).')
    return c


def make_pipeline(a, needs_network=True):
    from .pipeline import Pipeline
    from .state import State
    from .net import GuardedFetcher, user_agent
    from .netguard import Policy
    if a.delay < 3.0:
        sys.exit('--delay below 3 s is not allowed (rule R4).')
    if a.no_recovery:
        from . import parse
        parse._recover_text = lambda text, font, where, log: (parse.decode_entities(text), '')
    policy = Policy()
    fetcher = None
    if needs_network:
        fetcher = GuardedFetcher(user_agent(contact()), delay=a.delay, policy=policy, insecure_hosts=a.insecure_host)
    out = Path(a.out)
    state = State(out / 'state.sqlite')
    llm = None
    if not a.no_llm:
        from .state import JsonlLog
        llm = LLMAssist(state, JsonlLog(out / 'scrape_log.jsonl'), max_pages=a.llm_max_pages, max_usd=a.llm_max_usd,
                        llm_all=a.llm_all)
        if not llm.providers:
            llm = None
    reader_factory = scanned_reader = None
    if a.allow_ocr or a.ocr_engine:
        from .secondread import SecondReader
        engine = a.ocr_engine or 'both'
        engines = ('tesseract', 'vision') if engine == 'both' else (engine,)
        reader_factory = lambda files: SecondReader(files, out / 'crops', engines=engines,
                                                    vision=(llm.transcribe if llm else None))
        from .secondread import read_scanned_page
        scanned_reader = lambda data, pno: read_scanned_page(
            data, pno, out / 'crops', tesseract=None if 'tesseract' in engines else False,
            vision_lines=(llm.transcribe_lines if llm and 'vision' in engines else None))
    p = Pipeline(a.csv, out, fetcher=fetcher or _NoNet(), policy=policy, llm=llm, second_reader_factory=reader_factory,
                 allow_archive=a.allow_archive, archive_max_age_months=a.archive_max_age_months, render=a.render,
                 dry_run=a.dry_run, delay=a.delay, filled_path=a.filled, download_photos=a.download_photos,
                 vision_check=a.vision_check, scanned_reader=scanned_reader)
    if fetcher:
        fetcher.log = lambda **kw: p.log(**kw)
    return p


class _NoNet:
    """Stand-in fetcher for offline commands: any attempt to fetch is an error, never a silent request."""
    ua = 'offline'

    def __getattr__(self, name):
        def refuse(*a, **k):
            raise RuntimeError(f'offline command tried network call {name}')
        return refuse


def scope_problem(a):
    """Every scope/limit argument must be explicit; nothing empty, zero or negative silently widens a run
    (2026-09-29: an empty --only-row selected Tier 4; the LLM budget counted all-time spend). -> message or None."""
    for opt in ('only_row', 'only_host'):
        v = getattr(a, opt)
        if v is not None and not v.strip():
            return f'--{opt.replace("_", "-")} is empty: refusing to run without a filter (it would select every row).'
    if a.command in ('run', 'check') and not (a.tier or a.only_row or a.only_host):
        return (f'{a.command}: no --tier / --only-row / --only-host given; refusing to select all 245 rows. '
                'Name the tiers explicitly (e.g. --tier 1 --tier 2 --tier 3 --tier 4).')
    if a.limit is not None and a.limit < 1:
        return '--limit must be >= 1 (omit it for no limit within the selected tiers).'
    if a.workers < 1:
        return '--workers must be >= 1.'
    if a.llm_max_pages < 0 or a.llm_max_usd < 0:
        return '--llm-max-pages / --llm-max-usd must be >= 0.'
    if a.archive_max_age_months < 1:
        return '--archive-max-age-months must be >= 1.'
    if any(not h.strip() for h in a.insecure_host):
        return '--insecure-host is empty.'
    if a.command in ('import-html', 'import-infocom', 'recover-file') and not a.target:
        return f'{a.command} needs a target path.'
    return None


def main(argv=None):
    a = build_parser().parse_args(argv)
    problem = scope_problem(a)
    if problem:
        sys.exit(problem)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if a.command == 'check':
        from .pipeline import RowResult
        p = make_pipeline(a)
        rows = p.select(set(a.tier) if a.tier else None, a.only_host, a.only_row, a.limit, retry_failed=True)
        with open(out / 'link_check_report.csv', 'w', encoding='utf-8') as fh:
            fh.write('row_key,status,rti_url,requests\n')
            for r in rows:
                res = RowResult(csvio.row_key(r), '')
                try:
                    st, url, _ = p.find_rti_page(r, res)
                except Exception as e:
                    st, url = 'DEAD', f'{type(e).__name__}: {e}'
                fh.write(f'"{res.row_key}",{st},{url},{res.requests}\n')
                print(f'{st:<18} {r["Website_Link"]}', file=sys.stderr)
    elif a.command == 'run':
        p = make_pipeline(a)
        if p.llm:
            p.llm.audit()
        rows = p.select(set(a.tier) if a.tier else None, a.only_host, a.only_row, a.limit, a.retry_failed)
        print(f'{len(rows)} rows selected', file=sys.stderr)
        p.run(rows, workers=a.workers)
        _summary(p)
    elif a.command in ('import-html', 'import-infocom', 'apply-overrides'):
        from . import importers
        p = make_pipeline(a, needs_network=a.command != 'apply-overrides' and not a.dry_run)
        if a.command == 'import-html':
            srcs, problems = importers.import_saved(a.target, p.rows, p.log)
            for k, why in problems:
                print(f'skipped {k}: {why}', file=sys.stderr)
        elif a.command == 'import-infocom':
            srcs = importers.import_infocom(a.target, p.rows, p.log)
        else:
            srcs, bad = importers.read_overrides(a.target or out / 'confirmed_overrides.csv', p.rows)
            for line, why in bad:
                print(f'override line {line}: {why}', file=sys.stderr)
        for key, sources in srcs.items():
            p.apply_sources(p.by_key[key], sources)
        p.save()
        _summary(p)
    elif a.command == 'finalize':
        p = make_pipeline(a, needs_network=False)
        blanked, shared = p.finalize()
        print(f'{len(blanked)} placeholder photo cells blanked; {len(shared)} groups of rows list the same officers',
              file=sys.stderr)
    elif a.command == 'report':
        p = make_pipeline(a, needs_network=False)
        from . import reports
        reports.write_all(p)
        print((out / 'coverage_report.md').read_text(encoding='utf-8'))
    elif a.command == 'recover-file':
        _recover_file(a)
    elif a.command == 'compat-check':
        from compat import check
        sys.exit(check.main(a))
    elif a.command == 'audit-models':
        from .state import State, JsonlLog
        llm = LLMAssist(State(out / 'state.sqlite'), JsonlLog(out / 'scrape_log.jsonl'))
        print(json.dumps(llm.audit(), indent=1))


def _summary(p):
    from collections import Counter
    st = Counter(r.status for r in p.results.values())
    print('status:', dict(st), file=sys.stderr)
    print(f'CSV: {p.filled_path}\nreports: {p.out}', file=sys.stderr)


def _recover_file(a):
    from . import files, integrity as ti
    from .parse import parse_page
    path = Path(a.target)
    data = path.read_bytes()
    if path.suffix.lower() == '.pdf':
        items, info = files.pdf_regions(data)
        print(json.dumps({k: v for k, v in info.items() if k != 'recovery'}, ensure_ascii=False))
        for e in info['recovery']:
            if e['decision'] != 'as_is':
                print(json.dumps(e, ensure_ascii=False))
        page, meta, _ = files.parse_pdf(data, path.as_uri())
    else:
        page = parse_page(data.decode('utf-8', 'replace'), path.as_uri())
        for e in page.recovery:
            print(json.dumps(e, ensure_ascii=False))
        meta = {}
    for role, b in page.roles.items():
        for f, fr in b.fields.items():
            if fr.value:
                print(f'{role:<10} {f:<13} {fr.state:<11} rec={fr.recovered or "-":<6} '
                      f'class={ti.classify_text(fr.value):<12} {fr.value}  {meta.get("where", {}).get((role, f), "")}')


if __name__ == '__main__':
    main()
