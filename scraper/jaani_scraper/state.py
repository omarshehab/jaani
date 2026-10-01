"""Resumable run state (scraper/out/state.sqlite) and append-only JSONL logs."""
import json
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = '''
CREATE TABLE IF NOT EXISTS rows (
  row_key TEXT PRIMARY KEY, status TEXT, attempts INTEGER DEFAULT 0, last_checked TEXT,
  next_retry REAL DEFAULT 0, rti_url TEXT, source_hash TEXT, metrics TEXT, flags TEXT);
CREATE TABLE IF NOT EXISTS llm_cache (
  cache_key TEXT PRIMARY KEY, response TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS llm_usage (
  ts TEXT, provider TEXT, model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, usd REAL,
  latency_s REAL, row_key TEXT, outcome TEXT);
CREATE TABLE IF NOT EXISTS photos (
  url TEXT, sha256 TEXT, row_key TEXT, role TEXT, bytes INTEGER, ctype TEXT);
'''


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


class State:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.executescript(SCHEMA)
        self.lock = threading.Lock()

    def get(self, row_key):
        cur = self.db.execute('SELECT status, attempts, last_checked, next_retry, rti_url, source_hash, metrics, flags '
                              'FROM rows WHERE row_key=?', (row_key,))
        r = cur.fetchone()
        if not r:
            return None
        return dict(status=r[0], attempts=r[1], last_checked=r[2], next_retry=r[3], rti_url=r[4],
                    source_hash=r[5], metrics=json.loads(r[6] or '{}'), flags=json.loads(r[7] or '[]'))

    def put(self, row_key, status, rti_url='', source_hash='', metrics=None, flags=None, retry_in=0):
        with self.lock:
            prev = self.get(row_key)
            attempts = (prev['attempts'] if prev else 0) + 1
            self.db.execute(
                'INSERT OR REPLACE INTO rows VALUES (?,?,?,?,?,?,?,?,?)',
                (row_key, status, attempts, now_iso(), time.time() + retry_in if retry_in else 0, rti_url,
                 source_hash, json.dumps(metrics or {}, ensure_ascii=False),
                 json.dumps(sorted(set(flags or [])), ensure_ascii=False)))

    def due(self, row_key, retry_failed=False):
        s = self.get(row_key)
        if not s:
            return True
        if s['next_retry'] and s['next_retry'] > time.time() and not retry_failed:
            return False
        if s['status'] in ('complete', 'partial', 'sparse', 'page_blank', 'exempt'):
            return retry_failed and s['status'] in ('sparse', 'page_blank')
        return True

    def all(self):
        return {k: self.get(k) for (k,) in self.db.execute('SELECT row_key FROM rows')}

    def cache_get(self, key):
        r = self.db.execute('SELECT response FROM llm_cache WHERE cache_key=?', (key,)).fetchone()
        return json.loads(r[0]) if r else None

    def cache_put(self, key, value):
        with self.lock:
            self.db.execute('INSERT OR REPLACE INTO llm_cache VALUES (?,?,?)',
                            (key, json.dumps(value, ensure_ascii=False), now_iso()))

    def usage(self, **kw):
        with self.lock:
            self.db.execute('INSERT INTO llm_usage VALUES (?,?,?,?,?,?,?,?,?)',
                            (now_iso(), kw.get('provider'), kw.get('model'), kw.get('prompt_tokens', 0),
                             kw.get('completion_tokens', 0), kw.get('usd', 0.0), kw.get('latency_s', 0.0),
                             kw.get('row_key', ''), kw.get('outcome', '')))

    def usage_totals(self):
        r = self.db.execute('SELECT COUNT(*), COALESCE(SUM(usd),0), COUNT(DISTINCT row_key) FROM llm_usage').fetchone()
        return dict(calls=r[0], usd=r[1], rows=r[2])


class JsonlLog:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()

    def __call__(self, **rec):
        rec.setdefault('ts', now_iso())
        line = json.dumps(rec, ensure_ascii=False, default=str)
        with self.lock, open(self.path, 'a', encoding='utf-8') as fh:
            fh.write(line + '\n')
