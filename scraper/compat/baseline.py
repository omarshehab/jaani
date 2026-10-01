"""Section 15.1 baseline: record the existing app's API responses before any Node/React change.

  scraper/.venv/bin/python -m compat.baseline --csv JAANI_RTI_OFFICERS_COMPLETE.backup.csv --out DIR
"""
import argparse
import csv
import io
import json
import time
import urllib.parse
from pathlib import Path

import httpx

from . import sandbox

MOHA = 'স্বরাষ্ট্র মন্ত্রণালয়'


def post(client, path, body, timeout):
    t = time.time()
    r = client.post(path, json=body, timeout=timeout)
    return {'status': r.status_code, 'elapsed_s': round(time.time() - t, 2), 'body': r.json()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--root', default='/private/tmp/jaani_sandbox_baseline')
    ap.add_argument('--port', type=int, default=5105)
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    root = sandbox.build(a.root, a.csv, seed_photos=True)
    proc = sandbox.start(root, port=a.port, reader_port=a.port - 3)
    try:
        c = httpx.Client(base_url=f'http://127.0.0.1:{a.port}/api')
        rec = {}
        rec['verify_db'] = post(c, '/verify-contact', {'office_name': MOHA, 'enrich_web': False}, 60)
        rec['verify_live'] = post(c, '/verify-contact', {'office_name': MOHA, 'enrich_web': True}, 150)
        q = urllib.parse.urlencode({'url': 'https://moha.gov.bd/views/info-officers', 'count': 3})
        t = time.time(); r = c.get(f'/extract-image?{q}', timeout=120)
        rec['extract_image'] = {'status': r.status_code, 'elapsed_s': round(time.time() - t, 2), 'body': r.json()}
        before = (root / 'JAANI_RTI_OFFICERS_COMPLETE.csv').read_bytes()
        row = next(csv.DictReader(io.StringIO(before.decode('utf-8-sig'))))
        upd = dict(row, Primary_Designation=(row['Primary_Designation'] + ' [baseline-edit]'))
        rec['contacts_update'] = post(c, '/contacts/update', {
            'updates': upd, 'original_identifier': row['Primary_Email'] or row['Office'],
            'match_hints': {'office_name': row['Office'], 'website_link': row['Website_Link'],
                            'primary_email': row['Primary_Email'], 'primary_mobile': row['Primary_Mobile']}}, 30)
        after = (root / 'JAANI_RTI_OFFICERS_COMPLETE.csv').read_bytes()
        rows_after = list(csv.DictReader(io.StringIO(after.decode('utf-8-sig'))))
        rec['contacts_update']['csv_rows_before'] = len(list(csv.reader(io.StringIO(before.decode('utf-8-sig'))))) - 1
        rec['contacts_update']['csv_rows_after'] = len(rows_after)
        rec['contacts_update']['edited_row_found'] = any(
            r['Primary_Designation'].endswith('[baseline-edit]') for r in rows_after)
        for k, v in rec.items():
            (out / f'{k}.json').write_text(json.dumps(v, ensure_ascii=False, indent=1))
            print(k, v['status'], v.get('elapsed_s'))
    finally:
        sandbox.stop(proc)


if __name__ == '__main__':
    main()
