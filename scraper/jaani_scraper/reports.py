"""Sidecar outputs (sections 6A.9, 11): never new CSV columns, always separate files in scraper/out/."""
import csv
import html
import json
from collections import Counter, defaultdict
from pathlib import Path

from . import csvio
from .parse import ROLES

ROLE_COL = {'primary': 'Primary', 'alternate': 'Alternate', 'appellate': 'Appellate'}
ROLE_BN = {'primary': 'দায়িত্বপ্রাপ্ত কর্মকর্তা', 'alternate': 'বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা', 'appellate': 'আপীল কর্তৃপক্ষ'}


def _csv(path, header, rows, replace_keys=None):
    """Write a sidecar. With replace_keys, rows of earlier runs whose row_key was NOT processed now are kept, so a
    partial re-run (--retry-failed, one tier) never erases the other rows' review items."""
    if replace_keys is not None and Path(path).exists():
        with open(path, encoding='utf-8', newline='') as fh:
            old = list(csv.reader(fh))[1:]
        rows = [r for r in old if r and r[0] not in replace_keys] + list(rows)
    with open(path, 'w', encoding='utf-8', newline='') as fh:
        w = csv.writer(fh, lineterminator='\n')
        w.writerow(header)
        w.writerows(rows)


def write_all(p):
    out = p.out
    results = p.results
    if not results:                      # finalize/report without a run: row-based reports only
        coverage(p)
        photo_review(p)
        return
    review, manual, disc, signals = [], [], [], []
    for key, res in sorted(results.items()):
        d = res.decision
        if res.manual_reason or res.status in ('blocked_robots', 'manual_needed', 'no_rti_page', 'file_only', 'exempt'):
            manual.append([key, res.rti_url, res.manual_reason or res.status])
        if d:
            for r in d.review:
                review.append([key, r['role'], r['field'], r['value'], r['flag'], r['url'], r['source'], r['method'],
                               json.dumps(r.get('where') or {}, ensure_ascii=False, default=str)])
            for x in d.discrepancies:
                disc.append([key, x['role'], x['field'], x['kept'], x['kept_source'], x['other'], x['other_source'],
                             x['other_url']])
        for s in res.sources:
            if s.page is None:
                continue
            for role, b in s.page.roles.items():
                for fl in b.flags:
                    if fl.startswith('unextracted_signal:'):
                        _, kind, tok = fl.split(':', 2)
                        signals.append([key, role, kind, tok, s.url])
    _csv(out / 'review_queue.csv', ['row_key', 'role', 'field', 'value', 'flag', 'url', 'source', 'method', 'where'],
         review, replace_keys=set(results))
    _csv(out / 'manual_queue.csv', ['row_key', 'url', 'reason'], manual, replace_keys=set(results))
    _csv(out / 'discrepancies.csv', ['row_key', 'role', 'field', 'kept_value', 'kept_source', 'other_value',
                                     'other_source', 'other_url'], disc, replace_keys=set(results))
    _csv(out / 'unextracted_signals.csv', ['row_key', 'role', 'kind', 'token', 'url'], signals, replace_keys=set(results))
    ov = out / 'confirmed_overrides.csv'
    if not ov.exists():
        _csv(ov, ['row_key', 'role', 'field', 'value', 'note'], [])
    link_rows = [[k, r.link_status, r.rti_url, r.requests] for k, r in sorted(results.items())]
    _csv(out / 'link_check_report.csv', ['row_key', 'status', 'rti_url', 'requests'], link_rows, replace_keys=set(results))
    status_path = out / 'row_status.json'
    status = json.loads(status_path.read_text(encoding='utf-8')) if status_path.exists() else {}
    status.update({k: dict(status=r.status, rti_url=r.rti_url, flags=r.flags[:20]) for k, r in results.items()})
    (out / 'row_status.json').write_text(json.dumps(status, ensure_ascii=False, indent=1), encoding='utf-8')
    coverage(p)
    photo_review(p)
    bijoy_review(p, review)


def coverage(p):
    from .pipeline import tier
    rows_by_key = {csvio.row_key(r): r for r in p.rows}
    lines = ['# Coverage report', '']
    st = Counter(r.status for r in p.results.values())
    lines += ['## Status counts (this run)', '', '| status | rows |', '|---|---|']
    lines += [f'| {k} | {v} |' for k, v in st.most_common()]
    lines += ['', '## By tier (whole dataset, current CSV)', '',
              '| tier | rows | roles found | % roles with e-mail | % with mobile | % with photo |', '|---|---|---|---|---|---|']
    by_tier = defaultdict(list)
    for r in p.rows:
        by_tier[tier(r)].append(r)
    for t in sorted(by_tier):
        rs = by_tier[t]
        roles = [(r, R) for r in rs for R in ROLE_COL.values() if r[f'{R}_Officer_Name']]
        pct = lambda f: f'{100 * sum(1 for r, R in roles if r[f"{R}_{f}"]) / len(roles):.0f}%' if roles else '-'
        lines.append(f'| {t} | {len(rs)} | {len(roles)} / {3 * len(rs)} | {pct("Email")} | {pct("Mobile")} | '
                     f'{pct("Image_URL")} |')
    fl = Counter(f.split(':')[0] if not f.startswith(('primary:', 'alternate:', 'appellate:')) else f.split(':', 1)[1].split(':')[0]
                 for r in p.results.values() for f in r.flags)
    lines += ['', '## Top flags', '', '| flag | count |', '|---|---|'] + [f'| {k} | {v} |' for k, v in fl.most_common(25)]
    blocked = sorted(k for k, r in p.results.items() if r.status == 'blocked_robots')
    lines += ['', f'## Hosts blocked by robots.txt ({len(blocked)})', ''] + [f'- {k}' for k in blocked]
    stale = sorted(k for k, r in p.results.items() if 'stale_12m' in r.flags)
    lines += ['', f'## Stale pages (> 12 months) ({len(stale)})', ''] + [f'- {k}' for k in stale]
    rec = [json.loads(ln) for ln in (p.out / 'text_recovery.jsonl').read_text(encoding='utf-8').splitlines()] \
        if (p.out / 'text_recovery.jsonl').exists() else []
    classes = Counter(e.get('cls') for e in rec)
    decisions = Counter(e.get('decision') for e in rec)
    lines += ['', '## Text integrity (6A)', '', f'- runs logged: {len(rec)}; by class: {dict(classes)}',
              f'- decisions: {dict(decisions)}']
    if p.llm:
        u = p.state.usage_totals()
        lines += ['', '## LLM usage', '', f'- calls: {u["calls"]}, rows: {u["rows"]}, estimated cost: ${u["usd"]:.3f}']
    (p.out / 'coverage_report.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def photo_review(p):
    cards = []
    for r in p.rows:
        key = csvio.row_key(r)
        res = p.results.get(key)
        if not any(r[f'{R}_Officer_Name'] for R in ROLE_COL.values()):
            continue
        cols = []
        for role, R in ROLE_COL.items():
            name, url = r[f'{R}_Officer_Name'], r[f'{R}_Image_URL']
            flags = [f.split(':', 1)[1] for f in (res.flags if res else []) if f.startswith(role + ':')]
            if url:
                img = f'<img src="{html.escape(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">'
            elif name:
                img = '<div class="none">ছবি নেই — ইচ্ছাকৃতভাবে ফাঁকা<br><small>photo missing on purpose</small></div>'
            else:
                img = '<div class="none empty">—</div>'
            cols.append(f'<div class="role"><h4>{ROLE_BN[role]}</h4>{img}<p class="n">{html.escape(name or "—")}</p>'
                        f'<p class="d">{html.escape(r[f"{R}_Designation"])}</p>'
                        f'<p class="f">{html.escape(", ".join(flags))}</p></div>')
        cards.append(f'<section><h3>{html.escape(r["Office"])}</h3><p class="u"><a href="{html.escape(r["Website_Link"])}" '
                     f'target="_blank" rel="noopener">{html.escape(r["Website_Link"])}</a></p><div class="grid">'
                     + ''.join(cols) + '</div></section>')
    page = f'''<!doctype html><html lang="bn"><head><meta charset="utf-8"><title>Photo review</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{{font-family:system-ui,"Noto Sans Bengali",sans-serif;margin:16px;background:#f6f7f9;color:#111}}
section{{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px;margin:0 0 14px}}
h3{{margin:0 0 4px;font-size:16px}} .u{{margin:0 0 8px;font-size:12px;word-break:break-all}}
.grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}} @media(max-width:640px){{.grid{{grid-template-columns:1fr}}}}
.role h4{{margin:0 0 6px;font-size:13px;color:#555}} .role img{{width:120px;height:150px;object-fit:cover;border:1px solid #ccc}}
.none{{width:120px;height:150px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:12px;
background:#fff4e5;border:1px dashed #d9a441}} .none.empty{{background:#f0f0f0;border-color:#ccc}}
.n{{font-weight:600;margin:6px 0 0}} .d,.f{{margin:2px 0;font-size:12px}} .f{{color:#a33}}
</style></head><body><h1>Photo review ({len(cards)} offices)</h1>
<p>Each photo must belong to the officer named under it. A blank photo under a named officer is correct when the page
has no photo for that role.</p>{''.join(cards)}</body></html>'''
    (p.out / 'photo_review.html').write_text(page, encoding='utf-8')


def bijoy_review(p, review):
    merged = p.out / 'review_queue.csv'                   # all runs, not only this one
    if merged.exists():
        with merged.open(encoding='utf-8', newline='') as fh:
            review = [r for r in list(csv.reader(fh))[1:] if len(r) == 9]
    items = [r for r in review if any(k in r[4] for k in ('recovery_unconfirmed', 'integrity_failed',
                                                          'scanned_ocr_candidate'))]
    rows = []
    for key, role, f, value, flag, url, source, method, where in items:
        w = json.loads(where or '{}')
        crop = w.get('crop')
        img = f'<img src="{html.escape(Path(crop).as_uri())}">' if crop else '<em>no crop (page text)</em>'
        reads = w.get('second_readings') or {}
        rows.append(f'<tr><td>{html.escape(key)}</td><td>{role}</td><td>{f}</td><td>{img}</td>'
                    f'<td>{html.escape(value)}</td><td>{html.escape(json.dumps(reads, ensure_ascii=False))}</td>'
                    f'<td>{html.escape(flag)}</td><td><a href="{html.escape(url)}">{html.escape(url[:60])}</a></td></tr>')
    page = f'''<!doctype html><html lang="bn"><head><meta charset="utf-8"><title>Bijoy review</title><style>
body{{font-family:system-ui,"Noto Sans Bengali",sans-serif;margin:16px}} table{{border-collapse:collapse;width:100%}}
td,th{{border:1px solid #ccc;padding:6px;vertical-align:top;font-size:13px}} img{{max-width:320px}}</style></head><body>
<h1>Recovered text waiting for confirmation ({len(rows)})</h1>
<p>Compare the crop with the candidate. If it is right, copy the value into confirmed_overrides.csv
(row_key, role, field, value, note) and run <code>python -m jaani_scraper apply-overrides</code>.</p>
<table><tr><th>row</th><th>role</th><th>field</th><th>crop</th><th>candidate</th><th>second readings</th><th>reason</th>
<th>source</th></tr>{''.join(rows)}</table></body></html>'''
    (p.out / 'bijoy_review.html').write_text(page, encoding='utf-8')
