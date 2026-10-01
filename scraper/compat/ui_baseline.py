"""Start a sandboxed backend (5105/5102) and a second frontend (3010) pointed at it, run ui_flows.js, stop both.
  scraper/.venv/bin/python -m compat.ui_baseline --csv <csv> --out <dir>"""
import argparse
import os
import signal
import subprocess
import time
import urllib.request
from pathlib import Path

from . import sandbox

REPO = Path(__file__).resolve().parents[2]


def wait_http(url, seconds):
    t = time.time()
    while time.time() - t < seconds:
        try:
            with urllib.request.urlopen(url, timeout=3) as r:
                if r.status < 500:
                    return True
        except Exception:
            time.sleep(2)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--root', default='/private/tmp/jaani_sandbox_ui')
    ap.add_argument('--article', default='https://www.prothomalo.com/bangladesh/crime/diag0jvbhb')
    ap.add_argument('--mock-office', action='store_true',
                    help='after-fix run: 245-row CSV, MoHA filled, DMP row pointed at the local mock portal')
    a = ap.parse_args()
    portal = None
    csv_path = a.csv
    extra = {}
    if a.mock_office:
        from .check import _partly_filled_csv, read_rows, write_rows, by_office
        from .mock_portal import Portal
        portal = Portal({'dmp': 'fixture:moha_info_officers'}).start()
        csv_path = _partly_filled_csv(Path('/private/tmp/jaani_ui_after.csv'))
        rows = read_rows(csv_path)
        by_office(rows, 'ঢাকা মেট্রোপলিটন পুলিশ')['Website_Link'] = portal.url('dmp')
        write_rows(csv_path, rows)
        extra = {'ALLOW_PRIVATE_NETWORK_URLS': 'true'}
    root = sandbox.build(a.root, csv_path, seed_photos=not a.mock_office)
    be = sandbox.start(root, port=5105, reader_port=5102, extra_env=extra)
    env = dict(os.environ, PORT='3010', BROWSER='none', REACT_APP_BACKEND_URL='http://localhost:5105',
               REACT_APP_READER_ORIGIN='http://localhost:5102')
    fe_log = open(Path(a.root) / 'frontend.log', 'ab')
    fe = subprocess.Popen(['npm', 'start'], cwd=REPO / 'frontend', env=env, stdout=fe_log, stderr=fe_log,
                          start_new_session=True)
    try:
        if not wait_http('http://localhost:3010', 240):
            raise SystemExit('frontend on 3010 did not start; see ' + str(Path(a.root) / 'frontend.log'))
        subprocess.run(['node', str(Path(__file__).with_name('ui_flows.js')), 'http://localhost:3010', a.out, a.article],
                       check=False, timeout=900)
    finally:
        os.killpg(fe.pid, signal.SIGTERM)
        sandbox.stop(be)
        if portal:
            portal.stop()
        (Path(a.out) / 'sandbox_csv_after.csv').write_bytes((root / 'JAANI_RTI_OFFICERS_COMPLETE.csv').read_bytes())


if __name__ == '__main__':
    main()
