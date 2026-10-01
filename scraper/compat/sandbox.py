"""Throwaway copy of the Node backend that reads/writes its own CSV and photo folder.

The live backend resolves its dataset as <repo>/JAANI_RTI_OFFICERS_COMPLETE.csv and photos as
<repo>/shared/officer_photos, and rewrites the CSV on every /verify-contact call. Compatibility
tests must never touch those, so they run against a copy laid out the same way:

  <root>/backend   code copied from the repo (node_modules symlinked, evidence vault skipped)
  <root>/frontend  symlink (the reader loads highlightHTMLEntities.js from it)
  <root>/shared    fresh folder; officer_photos optionally seeded
  <root>/JAANI_RTI_OFFICERS_COMPLETE.csv   the CSV under test
"""
import os
import shutil
import signal
import subprocess
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SKIP_DATA = {'evidence_vault', 'image_cache', 'factcheck_index', 'eval'}


def build(root, csv_path, seed_photos=False):
    root = Path(root)
    if root.exists():
        shutil.rmtree(root)
    (root / 'shared' / 'officer_photos').mkdir(parents=True)
    (root / 'shared' / 'image data from link').mkdir()

    def ignore(d, names):
        d = Path(d)
        out = {'node_modules'} if d == REPO / 'backend' else set()
        if d == REPO / 'backend' / 'data':
            out |= SKIP_DATA & set(names)
        return out

    shutil.copytree(REPO / 'backend', root / 'backend', ignore=ignore, symlinks=True)
    os.symlink(REPO / 'backend' / 'node_modules', root / 'backend' / 'node_modules')
    os.symlink(REPO / 'frontend', root / 'frontend')
    os.symlink(REPO / 'node_modules', root / 'node_modules')
    for f in (REPO / 'shared').iterdir():
        if f.is_file():
            shutil.copy2(f, root / 'shared' / f.name)
    (root / 'shared' / 'activity_tracking').mkdir()
    if seed_photos:
        shutil.copytree(REPO / 'shared' / 'officer_photos', root / 'shared' / 'officer_photos', dirs_exist_ok=True)
    shutil.copy2(csv_path, root / 'JAANI_RTI_OFFICERS_COMPLETE.csv')
    return root


def start(root, port=5105, reader_port=5102, extra_env=None, log_name='sandbox_backend.log'):
    root = Path(root)
    env = dict(os.environ, PORT=str(port), READER_PORT=str(reader_port),
               READER_PUBLIC_ORIGIN=f'http://localhost:{reader_port}', FACTCHECK_POLL='off',
               EVIDENCE_RETENTION_DAYS='0')
    env.update(extra_env or {})
    log = open(root / log_name, 'ab')
    proc = subprocess.Popen(['node', 'index.js'], cwd=root / 'backend', env=env, stdout=log, stderr=log,
                            start_new_session=True)
    deadline = time.time() + 90
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f'sandbox backend exited early, see {root / log_name}')
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=2) as r:
                if r.status == 200:
                    return proc
        except Exception:
            time.sleep(1)
    stop(proc)
    raise RuntimeError('sandbox backend did not become healthy in 90 s')


def stop(proc):
    if proc and proc.poll() is None:
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
