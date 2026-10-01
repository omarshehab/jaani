"""Routes that need no automated fetching of the body's site (sections 5 S0/S4/S5, 6A.2-D, 12)."""
import csv
import io
import json
import re
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import lxml.html

from . import csvio
from .assemble import Source
from .parse import ROLES, parse_page
from .textnorm import norm, squash

SNIPPET_FIELDS = {'name': 'Officer_Name', 'designation': 'Designation', 'phone': 'Phone', 'mobile': 'Mobile',
                  'email': 'Email', 'address': 'Address', 'image': 'Image_URL'}


def _host(url):
    return (urlsplit(url).hostname or '').lower().removeprefix('www.')


def match_row(rows, url=None, authority=None):
    """By host (row Website_Link host) or by exact authority name (Office). Unique match only."""
    if url:
        h = _host(url)
        hits = [r for r in rows if _host(r['Website_Link']) == h]
        if len(hits) == 1:
            return hits[0]
    if authority:
        a = squash(authority)
        hits = [r for r in rows if squash(r['Office']) == a]
        if len(hits) == 1:
            return hits[0]
    return None


def saved_page_url(path, html):
    side = path.with_name(path.stem + '.url.txt')
    if side.exists():
        return side.read_text(encoding='utf-8').strip()
    doc = lxml.html.document_fromstring(html)
    for sel in ('.//link[@rel="canonical"]', './/base'):
        el = doc.find(sel)
        if el is not None and el.get('href', '').startswith('http'):
            return el.get('href')
    m = re.search(r'<!-- saved from url=\(\d+\)(https?://\S+?) -->', html)
    return m.group(1) if m else None


def import_saved(directory, rows, log):
    """S4: 'Save as HTML only', DevTools outerHTML, or the snippet's JSON. -> {row_key: [Source]}"""
    out, problems = {}, []
    for path in sorted(Path(directory).iterdir()):
        if path.suffix.lower() in ('.html', '.htm'):
            html = path.read_text(encoding='utf-8', errors='replace')
            url = saved_page_url(path, html)
            if not url:
                problems.append((path.name, 'no_original_url'))
                continue
            row = match_row(rows, url=url)
            if not row:
                problems.append((path.name, f'no_row_for_host:{_host(url)}'))
                continue
            page = parse_page(html, url)
            for img in page.images:
                if '_files/' in img.url or img.url.startswith('file:'):
                    img.reject = 'saved_local_path'       # the browser rewrote it; use the snippet route instead
            out.setdefault(csvio.row_key(row), []).append(Source('human_saved', url, page=page,
                                                                 meta=dict(file=path.name)))
        elif path.suffix.lower() == '.json':
            try:
                data = json.loads(path.read_text(encoding='utf-8'))
            except json.JSONDecodeError:
                problems.append((path.name, 'bad_json'))
                continue
            url = data.get('url', '')
            row = match_row(rows, url=url)
            if not row or not url.startswith('http'):
                problems.append((path.name, f'no_row_for_url:{url[:80]}'))
                continue
            values = {}
            for role in ROLES:
                for k, f in SNIPPET_FIELDS.items():
                    v = norm(((data.get('roles') or {}).get(role) or {}).get(k) or '')
                    if not v:
                        continue
                    if f == 'Image_URL':
                        v = urljoin(url, v)
                        if not v.startswith('http'):
                            continue
                    values[(role, f)] = v
            out.setdefault(csvio.row_key(row), []).append(Source('human_saved', url, values=values, method='human',
                                                                 meta=dict(file=path.name,
                                                                           captured_at=data.get('captured_at', ''))))
    for name, why in problems:
        log(event='import_skipped', file=name, reason=why)
    return out, problems


INFOCOM_COLUMNS = {
    'authority': ('কর্তৃপক্ষ', 'authority', 'office', 'দপ্তর', 'অফিস', 'প্রতিষ্ঠান'),
    'url': ('website', 'url', 'ওয়েবসাইট'),
    'Officer_Name': ('নাম', 'name', 'officer'),
    'Designation': ('পদবি', 'পদবী', 'designation'),
    'Phone': ('ফোন', 'phone', 'telephone'),
    'Mobile': ('মোবাইল', 'mobile'),
    'Email': ('ইমেইল', 'email', 'e-mail'),
    'Address': ('ঠিকানা', 'address'),
}


def _map_header(header):
    out = {}
    for i, h in enumerate(header):
        hs = squash(h).lower()
        for key, words in INFOCOM_COLUMNS.items():
            if key not in out and any(squash(w).lower() in hs for w in words):
                out[key] = i
                break
    return out


def import_infocom(path, rows, log):
    """S5: an official export obtained with permission. Fills BLANK cells only; every value tagged source=infocom.
    The export lists designated (primary) officers, so only the primary role is used."""
    path = Path(path)
    if path.suffix.lower() == '.xlsx':
        import openpyxl
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        table = [[('' if c is None else str(c)) for c in r] for r in wb.worksheets[0].iter_rows(values_only=True)]
    else:
        table = list(csv.reader(io.StringIO(path.read_text(encoding='utf-8-sig'))))
    cols = _map_header(table[0])
    if 'Officer_Name' not in cols or not ({'authority', 'url'} & cols.keys()):
        raise SystemExit(f'{path}: cannot find authority/url and name columns in {table[0]}')
    out, unmatched = {}, 0
    for r in table[1:]:
        get = lambda k: norm(r[cols[k]]) if k in cols and cols[k] < len(r) else ''
        row = match_row(rows, url=get('url') or None, authority=get('authority') or None)
        if not row:
            unmatched += 1
            continue
        values = {('primary', f): get(f) for f in ('Officer_Name', 'Designation', 'Phone', 'Mobile', 'Email', 'Address')
                  if get(f)}
        out.setdefault(csvio.row_key(row), []).append(Source('infocom', f'infocom:{path.name}', values=values))
    log(event='infocom_import', matched=len(out), unmatched=unmatched)
    return out


# The literal, exact value that means "the owner confirmed this cell should be CLEARED", not merely an
# unfilled/blank cell in the override file. A bare empty string is never enough -- a trailing comma, a value
# stripped to nothing by a spreadsheet export, or a malformed row must stay a rejected row (R1's protection
# against accidentally blanking real data would otherwise apply to everyone, not just a deliberate case), and
# only fail loudly enough to show up in `bad`, never silently blank a cell.
BLANK_SENTINEL = '<BLANK>'


def read_overrides(path, rows):
    """S0: confirmed_overrides.csv (row_key, role, field, value, note) -> {row_key: [Source]}.
    value == BLANK_SENTINEL ("<BLANK>", exact match) means: clear this cell, on purpose. Anything else that is
    empty after stripping is a malformed row, rejected the same as before."""
    keys = {csvio.row_key(r) for r in rows}
    out, bad = {}, []
    with open(path, encoding='utf-8-sig', newline='') as fh:
        for i, r in enumerate(csv.DictReader(fh), 2):
            k, role, f, v = r.get('row_key', ''), r.get('role', '').lower(), r.get('field', ''), r.get('value', '')
            f = {'Name': 'Officer_Name', 'Officer_Name': 'Officer_Name'}.get(f, f)
            valid_row = k in keys and role in ROLES and f in ('Officer_Name', 'Designation', 'Phone', 'Mobile',
                                                              'Email', 'Address', 'Image_URL')
            is_blank = v.strip() == BLANK_SENTINEL
            if not valid_row or (not is_blank and not norm(v)):
                bad.append((i, 'unknown row/role/field or empty value'))
                continue
            src = out.setdefault(k, Source('human_confirmed', f'{Path(path).name}', values={}, method='human'))
            if is_blank:
                src.blanks.add((role, f))
            else:
                src.values[(role, f)] = norm(v)
    return {k: [s] for k, s in out.items()}, bad
