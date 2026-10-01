"""CSV I/O with byte fidelity (R6), never-blank merge (R7) and the safe write procedure (R8)."""
import csv
import io
import os
import shutil
import tempfile
from datetime import datetime
from pathlib import Path

from filelock import FileLock

HEADER = ['Ministry', 'Division', 'Office']
ROLES = ('Primary', 'Alternate', 'Appellate')
FIELDS = ('Officer_Name', 'Designation', 'Phone', 'Mobile', 'Email', 'Address', 'Image_URL')
for _r in ROLES:
    HEADER += [f'{_r}_{f}' for f in FIELDS]
HEADER += ['Website_Link', 'Last_Updated']
OFFICER_COLUMNS = [c for c in HEADER if c.split('_', 1)[0] in ROLES]
KEY_COLUMNS = ('Ministry', 'Division', 'Office')
assert len(HEADER) == 26 and len(OFFICER_COLUMNS) == 21


def row_key(row):
    return '|'.join(row[c] for c in KEY_COLUMNS)


def read_csv(path):
    raw = Path(path).read_bytes()
    if raw.startswith(b'\xef\xbb\xbf'):
        raise ValueError(f'{path}: has a BOM; the dataset is UTF-8 without BOM')
    rows = list(csv.reader(io.StringIO(raw.decode('utf-8'), newline='')))
    if rows[0] != HEADER:
        raise ValueError(f'{path}: header differs from the fixed 26-column schema')
    out = []
    for i, r in enumerate(rows[1:], 2):
        if len(r) != 26:
            raise ValueError(f'{path}: line {i} has {len(r)} fields')
        out.append(dict(zip(HEADER, r)))
    keys = [row_key(r) for r in out]
    if len(set(keys)) != len(keys):
        raise ValueError(f'{path}: duplicate (Ministry, Division, Office) keys')
    return out


def serialize(rows):
    rows = sorted(rows, key=lambda r: tuple(r[c] for c in KEY_COLUMNS))
    buf = io.StringIO(newline='')
    w = csv.writer(buf, lineterminator='\r\n', quoting=csv.QUOTE_MINIMAL)
    w.writerow(HEADER)
    for r in rows:
        w.writerow([r[c] for c in HEADER])
    return buf.getvalue().encode('utf-8')


def check_unique_links(rows):
    seen = {}
    for r in rows:
        link = r['Website_Link'].strip().rstrip('/').lower()
        if link and link in seen:
            raise ValueError(f'Website_Link shared by two rows: {seen[link]} and {row_key(r)}')
        seen[link] = row_key(r)


def write_csv_atomic(path, rows, backup_dir=None):
    """temp file + os.replace under a file lock, after a timestamped backup of the previous file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    check_unique_links(rows)
    data = serialize(rows)
    with FileLock(str(path) + '.lock', timeout=60):
        if path.exists():
            bdir = Path(backup_dir or path.parent / 'backups')
            bdir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime('%Y%m%dT%H%M%S%f')
            shutil.copy2(path, bdir / f'{path.stem}.{stamp}{path.suffix}')
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.' + path.name, suffix='.tmp')
        try:
            with os.fdopen(fd, 'wb') as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise


def merge_row(row, new_values, today):
    """Apply {column: value} to a row. Empty values never overwrite (R7). Returns [(col, old, new)] changes.
    Last_Updated is stamped only when something changed."""
    changes = []
    for col, val in new_values.items():
        if col not in OFFICER_COLUMNS and col != 'Website_Link':
            raise KeyError(f'{col} is not writable')
        val = (val or '').strip()
        if not val or val == row[col]:
            continue
        changes.append((col, row[col], val))
        row[col] = val
    if changes:
        row['Last_Updated'] = today
    return changes
