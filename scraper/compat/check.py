"""python -m jaani_scraper compat-check  (section 15.11): runs 15.1-15.9 against a mock portal and a sandboxed copy of
the backend + CSV, prints PASS/FAIL per item and writes scraper/out/compat_report.md. The live app is never touched."""
import csv
import io
import json
import os
import shutil
import subprocess
import sys
import time
import unicodedata
from datetime import date
from pathlib import Path

import httpx

from . import sandbox
from .mock_portal import Portal

SCRAPER = Path(__file__).resolve().parents[1]
REPO = SCRAPER.parent
sys.path.insert(0, str(SCRAPER))
from jaani_scraper import csvio, integrity as ti  # noqa: E402
from jaani_scraper.assemble import Source, decide  # noqa: E402
from jaani_scraper.parse import parse_page  # noqa: E402

S3_CSV = REPO / 's3' / 'JAANI_RTI_OFFICERS_COMPLETE.csv'
BACKUP = REPO / 'JAANI_RTI_OFFICERS_COMPLETE.backup.csv'
TODAY_UTC = time.strftime('%Y-%m-%d', time.gmtime())
TESTS = {   # slug -> (Office in the 245-row CSV, fixture, pre-existing values)
    'moha': ('স্বরাষ্ট্র মন্ত্রণালয়', 'fixture:moha_info_officers', 'backup'),
    'papo': ('বাংলাদেশ বিদ্যুৎ উন্নয়ন বোর্ড', 'fixture:photos_primary_appellate_only', None),
    'blank': ('ঢাকা ওয়াসা', 'fixture:page_blank', 'synthetic'),
    'legacy': ('জেলা প্রশাসকের কার্যালয় কক্সবাজার', 'fixture:legacy_template', None),
    'static': ('ইসলামী বিশ্ববিদ্যালয়', 'fixture:static_page_focal_point', None),
    'bijoy': ('রাজধানী উন্নয়ন কর্তৃপক্ষ (রাজউক)', 'fixture:legacy_font_html', 'synthetic'),
    'slow': ('স্বাস্থ্য অধিদপ্তর', '<html></html>', 'synthetic'),
    'missing': ('নির্বাচন কমিশন সচিবালয়', None, 'synthetic'),
    'redirect': ('সেতু বিভাগ', None, 'synthetic'),
}
SYNTHETIC = dict(Primary_Officer_Name='জনাব আগের কর্মকর্তা', Primary_Designation='উপপরিচালক',
                 Primary_Email='old@example.gov.bd', Primary_Mobile='০১৭১১০০০০০০')
RANKING = [('স্বরাষ্ট্র মন্ত্রণালয়', 'স্বরাষ্ট্র মন্ত্রণালয়'), ('ঢাকা মহানগর পুলিশ', 'ঢাকা মেট্রোপলিটন পুলিশ'),
           ('পুলিশ হেডকোয়ার্টার্স', 'পুলিশ হেডকোয়ার্টার্স বাংলাদেশ পুলিশ'),
           ('চট্টগ্রাম বন্দর কর্তৃপক্ষ', 'চট্টগ্রাম বন্দর কর্তৃপক্ষ'),
           ('জেলা প্রশাসক কক্সবাজার', 'জেলা প্রশাসকের কার্যালয় কক্সবাজার'),
           ('রাজউক', 'রাজধানী উন্নয়ন কর্তৃপক্ষ (রাজউক)'), ('স্বাস্থ্য অধিদপ্তর', 'স্বাস্থ্য অধিদপ্তর'),
           ('জাতীয় রাজস্ব বোর্ড', 'জাতীয় রাজস্ব বোর্ড'), ('শিক্ষা মন্ত্রণালয়', 'শিক্ষা মন্ত্রণালয়'),
           ('বাংলাদেশ বিদ্যুৎ উন্নয়ন বোর্ড', 'বাংলাদেশ বিদ্যুৎ উন্নয়ন বোর্ড'), ('ঢাকা ওয়াসা', 'ঢাকা ওয়াসা'),
           ('নির্বাচন কমিশন', 'নির্বাচন কমিশন সচিবালয়'), ('সেতু বিভাগ', 'সেতু বিভাগ')]


def N(s):
    return unicodedata.normalize('NFC', s or '')


class Report:
    def __init__(self):
        self.items = []

    def add(self, item, name, ok, detail=''):
        status = 'PASS' if ok is True else ('INFO' if ok is None else 'FAIL')
        self.items.append((item, name, status, detail))
        print(f'{status:<5} {item:<7} {name}  {detail[:160]}', flush=True)

    @property
    def failed(self):
        return [i for i in self.items if i[2] == 'FAIL']


def read_rows(path):
    return list(csv.DictReader(io.StringIO(Path(path).read_text(encoding='utf-8-sig'))))


def write_rows(path, rows):
    header = list(rows[0].keys())
    buf = io.StringIO(newline='')
    w = csv.DictWriter(buf, fieldnames=header, lineterminator='\r\n')
    w.writeheader()
    w.writerows(rows)
    Path(path).write_text(buf.getvalue(), encoding='utf-8')


def by_office(rows, office):
    return next(r for r in rows if r['Office'] == office)


def build_compat_csv(portal, path):
    rows = read_rows(S3_CSV)
    backup = {r['Office']: r for r in read_rows(BACKUP)}
    for slug, (office, _, pre) in TESTS.items():
        r = by_office(rows, office)
        r['Website_Link'] = portal.url(slug)
        if pre == 'backup':
            for c in csvio.OFFICER_COLUMNS:
                r[c] = backup[office][c]
            r['Last_Updated'] = '2026-09-25'
        elif pre == 'synthetic':
            r.update(SYNTHETIC)
    write_rows(path, rows)
    return rows


def verify(base, office, enrich, timeout=160, **extra):
    t = time.time()
    r = httpx.post(f'{base}/api/verify-contact', json={'office_name': office, 'enrich_web': enrich, **extra},
                   timeout=timeout)
    return r.json(), time.time() - t


def main(args=None):
    out = SCRAPER / 'out'
    out.mkdir(exist_ok=True)
    rep = Report()
    base_dir = SCRAPER / 'tests' / 'fixtures' / 'baseline'
    rep.add('15.1', 'baseline recorded before any Node/React change',
            all((base_dir / f).exists() for f in ('verify_db.json', 'verify_live.json', 'extract_image.json',
                                                  'contacts_update.json', 'ui/ui_result.json', 'section2_before.json')),
            str(base_dir))
    pages = {slug: fx for slug, (_, fx, _) in TESTS.items() if fx}
    portal = Portal(pages).start()
    csv_path = Path('/private/tmp/jaani_compat.csv')
    original = build_compat_csv(portal, csv_path)
    root = sandbox.build('/private/tmp/jaani_sandbox_compat', csv_path)
    proc = sandbox.start(root, port=5110, reader_port=5111, extra_env={'ALLOW_PRIVATE_NETWORK_URLS': 'true'})
    base = 'http://127.0.0.1:5110'
    sandbox_csv = root / 'JAANI_RTI_OFFICERS_COMPLETE.csv'
    try:
        _live_matrix(rep, base, sandbox_csv, original, portal)
        _save_checks(rep, base, sandbox_csv)
        _photo_cache_check(rep, base, root, sandbox_csv)
    finally:
        sandbox.stop(proc)
        portal.stop()
    _ssrf_checks(rep)
    _node_tests(rep)
    _frontend_tests(rep)
    _ranking(rep)
    _gazetteer_timing(rep)
    _section2(rep)
    lines = ['# Section 15 compatibility report', '', f'Run: {time.strftime("%Y-%m-%d %H:%M")}', '',
             '| item | check | result | detail |', '|---|---|---|---|']
    lines += [f'| {i} | {n} | {s} | {d.replace("|", "/")[:400]} |' for i, n, s, d in rep.items]
    (out / 'compat_report.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'\n{len(rep.items)} checks, {len(rep.failed)} failed -> {out / "compat_report.md"}')
    return 1 if rep.failed else 0


def match_for(resp, office):
    """The response entry for the row under test (ranking is checked separately in 15.6)."""
    for m in resp.get('matches') or []:
        if (m.get('Office') or m.get('office_name')) == office:
            return m
    return {}


def _cells(rows, office, cols=None):
    r = by_office(rows, office)
    return {c: r[c] for c in (cols or csvio.OFFICER_COLUMNS)}


def _live_matrix(rep, base, sandbox_csv, original, portal):
    moha = TESTS['moha'][0]
    before = _cells(original, moha)
    # fast (DB) pass on a stale row: photos must be the row's own, never the live page's (R3)
    resp, _ = verify(base, moha, False)
    m = match_for(resp, moha)
    rep.add('15.2', 'fast pass returns the row under test', bool(m), str([x.get('Office') for x in resp.get('matches', [])]))
    live_imgs = [u for u in (m.get('Primary_Image_URL'), m.get('Alternate_Image_URL'), m.get('Appellate_Image_URL'))
                 if u and '/img/moha-' in u]
    rep.add('15.2', 'fast pass on a stale row pairs CSV names with CSV photos only', not live_imgs,
            f'live-page photos in fast pass: {len(live_imgs)}')
    # live scrape
    resp, secs = verify(base, moha, True)
    m = match_for(resp, moha)
    rows = read_rows(sandbox_csv)
    cells = _cells(rows, moha)
    ok = (N(cells['Primary_Officer_Name']) == N('মো: তোফায়েল হোসেন (১৬২৯৪)')
          and N(cells['Alternate_Officer_Name']) == N('নাসরীন সুলতানা (১৬২১৮)')
          and cells['Primary_Image_URL'].endswith('971da9f9-1b78-41ce-ba8a-24aec411846a.jpg')
          and cells['Alternate_Image_URL'].endswith('3c3b4e2eff5347fc821a164dbee05e6e.jpg')
          and cells['Appellate_Image_URL'].endswith('4975f13e-1857-41de-9c26-58e2665d4d17.jpg'))
    rep.add('15.2', 'live scrape (Template A): names and role photos written back', ok,
            f'{secs:.1f}s; primary={cells["Primary_Officer_Name"]}; imgs={[cells[c][-20:] for c in ("Primary_Image_URL", "Alternate_Image_URL", "Appellate_Image_URL")]}')
    rep.add('15.2', 'response carries the live name under the canonical key too',
            N(m.get('Primary_Officer_Name') or m.get('Primary_Officer')) == N('মো: তোফায়েল হোসেন (১৬২৯৪)')
            and N(m.get('Primary_Officer')) == N('মো: তোফায়েল হোসেন (১৬২৯৪)'),
            f"_Name={m.get('Primary_Officer_Name')} / Primary_Officer={m.get('Primary_Officer')}")
    rep.add('15.2', 'no twin row after live scrape', len(rows) == 245, f'{len(rows)} rows')
    blanked = [c for c in csvio.OFFICER_COLUMNS if before[c] and not cells[c]]
    rep.add('15.2', 'live scrape never blanks a value', not blanked, ','.join(blanked))

    office = TESTS['papo'][0]
    resp, _ = verify(base, office, True)
    m = match_for(resp, office)
    cells = _cells(read_rows(sandbox_csv), office)
    rep.add('15.2', 'alternate with a name but no photo stays blank (API + CSV)',
            cells['Alternate_Officer_Name'] and not cells['Alternate_Image_URL'] and not m.get('Alternate_Photo')
            and cells['Appellate_Image_URL'].endswith('ap1.jpg') and cells['Primary_Image_URL'].endswith('p1.jpg'),
            f"alt_name={cells['Alternate_Officer_Name']} alt_img={cells['Alternate_Image_URL']} api_alt={m.get('Alternate_Photo')} "
            f"app_img={cells['Appellate_Image_URL'][-12:]}")

    for slug, label in (('blank', 'blank page keeps previous values'), ('slow', 'slow page: previous values kept'),
                        ('missing', '404: previous values kept'), ('redirect', 'redirect to homepage: previous values kept')):
        office = TESTS[slug][0]
        prev = _cells(read_rows(sandbox_csv), office)
        resp, secs = verify(base, office, True)
        now = _cells(read_rows(sandbox_csv), office)
        changed = {c: (prev[c], now[c]) for c in prev if prev[c] != now[c]}
        rep.add('15.2', label, not changed and secs < 120, f'{secs:.1f}s changed={changed}')

    office = TESTS['static'][0]
    resp, secs = verify(base, office, True)
    cells = _cells(read_rows(sandbox_csv), office)
    rep.add('15.2', 'static focal-point page: no officer invented', not cells['Primary_Officer_Name'],
            f"primary={cells['Primary_Officer_Name']} ({secs:.1f}s)")

    office = TESTS['legacy'][0]
    resp, secs = verify(base, office, True)
    cells = _cells(read_rows(sandbox_csv), office)
    py = _python_cells('legacy_template', portal.url('legacy'))
    diff = {c: (cells[c], py.get(c, '')) for c in csvio.OFFICER_COLUMNS if cells[c] != py.get(c, '')}
    rep.add('15.2', 'legacy template: Node vs Python cells', None, f'differences (node, python): {diff}')

    office = TESTS['bijoy'][0]
    resp, secs = verify(base, office, True)
    cells = _cells(read_rows(sandbox_csv), office)
    bad = {c: v for c, v in cells.items() if v and ti.classify_text(v) not in ti.STORABLE}
    rep.add('15.2', 'Bijoy page: nothing garbled persisted', not bad, json.dumps(bad, ensure_ascii=False))
    rep.add('15.3', 'Bijoy page: response carries integrity_warnings', bool(resp.get('integrity_warnings')),
            json.dumps(resp.get('integrity_warnings'), ensure_ascii=False)[:200])

    moha_py = _python_cells('moha_info_officers', portal.url('moha'))
    node = _cells(read_rows(sandbox_csv), moha)
    diff = {c: (node[c], moha_py.get(c, '')) for c in csvio.OFFICER_COLUMNS
            if node[c] != moha_py.get(c, '') and not c.endswith('Image_URL')}
    photo_diff = {c: (node[c][-20:], moha_py.get(c, '')[-20:]) for c in csvio.OFFICER_COLUMNS
                  if c.endswith('Image_URL') and node[c].rsplit('/', 1)[-1] != moha_py.get(c, '').rsplit('/', 1)[-1]}
    rep.add('15.2', 'same fixture, same photos from Python and Node (role gating aligned)', not photo_diff, str(photo_diff))
    rep.add('15.2', 'same fixture: other cell differences Python vs Node', None, json.dumps(diff, ensure_ascii=False))


def _python_cells(fixture, url):
    p = SCRAPER / 'tests' / 'fixtures' / ('live' if fixture.startswith('moha') else 'html') / f'{fixture}.html'
    html = p.read_text(encoding='utf-8')
    import re
    base = url.rsplit('/views/', 1)[0].rsplit('/', 1)[0]
    slug = url.rsplit('/views/', 1)[0].rsplit('/', 1)[1]
    html = re.sub(r'https://objectstorage\.[^"\']+?/([^/"\']+)\.(?:jpe?g|png)', lambda m: f'{base}/img/{slug}-{m.group(1)}.jpg', html)
    page = parse_page(html, url)
    d = decide({c: '' for c in csvio.HEADER}, [Source('live', url, page=page)], host='127.0.0.1')
    return d.values


def _save_checks(rep, base, sandbox_csv):
    rows = read_rows(sandbox_csv)
    target = next(r for r in rows if '.org.bd/' in r['Website_Link'])
    upd = dict(target, Primary_Officer_Name='জনাব পরীক্ষা', Primary_Designation='পরিচালক')
    r = httpx.post(f'{base}/api/contacts/update', json={'updates': upd, 'original_identifier': target['Office'],
                   'match_hints': {'office_name': target['Office'], 'website_link': target['Website_Link']}}, timeout=30)
    after = read_rows(sandbox_csv)
    row = by_office(after, target['Office'])
    listed = httpx.get(f'{base}/api/contacts', timeout=30).json()
    in_list = 'জনাব পরীক্ষা' in json.dumps(listed, ensure_ascii=False)
    rep.add('15.4', 'Save on a new (.org.bd) row updates exactly that row, no twin, cache refreshed',
            r.status_code == 200 and len(after) == 245 and row['Primary_Officer_Name'] == 'জনাব পরীক্ষা'
            and row['Last_Updated'] == TODAY_UTC and in_list,
            f"status={r.status_code} rows={len(after)} last_updated={row['Last_Updated']} listed={in_list}")
    moha = by_office(after, 'স্বরাষ্ট্র মন্ত্রণালয়')
    upd = dict(moha, Alternate_Designation='mnKvix mwPe|')
    r = httpx.post(f'{base}/api/contacts/update', json={'updates': upd, 'original_identifier': moha['Office'],
                   'match_hints': {'office_name': moha['Office'], 'website_link': moha['Website_Link']}}, timeout=30)
    body = r.json()
    rep.add('15.3', 'manual Save of legacy-font text is allowed but returns a visible warning',
            r.status_code == 200 and bool(body.get('integrity_warnings')),
            json.dumps(body.get('integrity_warnings'), ensure_ascii=False)[:200])


def _photo_cache_check(rep, base, root, sandbox_csv):
    office = TESTS['papo'][0]
    rows = read_rows(sandbox_csv)
    row = by_office(rows, office)
    folder = next((d for d in (root / 'shared' / 'officer_photos').iterdir() if d.is_dir() and 'বিদ্যুৎ' in d.name), None)
    if folder is None:
        rep.add('15.8', 'stale local photo cache', False, 'no local photo folder was created for the office')
        return
    stale = folder / 'appellate.jpg'
    stale.write_bytes(b'\xff\xd8\xff' + b'stale' * 1000)
    new_url = row['Appellate_Image_URL'].replace('ap1.jpg', 'ap-new.jpg')
    row['Appellate_Image_URL'] = new_url
    write_rows(sandbox_csv, rows)
    time.sleep(1.2)
    resp, _ = verify(base, office, False)
    m = match_for(resp, office)
    photo = m.get('Appellate_Photo', '')
    served = b''
    if photo.startswith('/shared/'):
        served = httpx.get(base + photo, timeout=20).content
    rep.add('15.8', 'a changed CSV Image_URL is not shadowed by a stale local file',
            bool(photo) and b'stale' not in served, f'photo={photo[-60:]} stale_bytes_served={b"stale" in served}')
    alt = m.get('Alternate_Photo', '')
    rep.add('15.8', 'a role with a blank Image_URL shows no photo', not alt, f'alternate photo={alt!r}')


def _ssrf_checks(rep):
    portal = Portal({'moha': 'fixture:moha_info_officers'}).start()
    rows = read_rows(S3_CSV)
    cases = {'স্বরাষ্ট্র মন্ত্রণালয়': portal.url('moha'),
             'ঢাকা ওয়াসা': 'http://169.254.169.254/latest/meta-data/',
             'সেতু বিভাগ': 'https://example.com/views/info-officers'}
    for office, url in cases.items():
        by_office(rows, office)['Website_Link'] = url
    csv_path = Path('/private/tmp/jaani_ssrf.csv')
    write_rows(csv_path, rows)
    root = sandbox.build('/private/tmp/jaani_sandbox_ssrf', csv_path)
    proc = sandbox.start(root, port=5112, reader_port=5113)
    try:
        for office, url in cases.items():
            before = len(portal.hits)
            resp, secs = verify('http://127.0.0.1:5112', office, True, timeout=90)
            log = (root / 'sandbox_backend.log').read_text(encoding='utf-8', errors='replace')
            hit = len(portal.hits) > before
            refused = 'officer URL refused' in log and url.split('/')[2] in log
            rep.add('15.9', f'on-demand scrape refuses {url.split("/")[2]}', not hit and refused,
                    f'portal_hits={len(portal.hits) - before} refused_logged={refused} {secs:.1f}s')
    finally:
        sandbox.stop(proc)
        portal.stop()


def _node_tests(rep):
    for test in ('tests/textIntegrity.test.js', 'tests/section3Compat.test.js', 'tests/officerUrlGuard.test.js'):
        if not (REPO / 'backend' / test).exists():
            rep.add('15.3' if 'Integrity' in test else '15.5', f'node --test {test}', False, 'missing')
            continue
        r = subprocess.run(['node', '--test', test], cwd=REPO / 'backend', capture_output=True, text=True, timeout=300)
        tail = [ln for ln in r.stdout.splitlines() if ln.startswith(('ℹ pass', 'ℹ fail'))]
        item = {'textIntegrity': '15.3', 'section3Compat': '15.5', 'officerUrlGuard': '15.9'}[Path(test).stem.split('.')[0]]
        rep.add(item, f'node --test {test}', r.returncode == 0, ' '.join(tail))


def _frontend_tests(rep):
    r = subprocess.run(['npx', 'react-scripts', 'test', '--watchAll=false', '--testPathPattern', 'VerificationGrid'],
                       cwd=REPO / 'frontend', capture_output=True, text=True, timeout=600, env=dict(os.environ, CI='true'))
    summary = [ln for ln in (r.stdout + r.stderr).splitlines() if 'Tests:' in ln]
    rep.add('15.8', 'VerificationGrid: no borrowed photo, Bijoy notice shown (jest)', r.returncode == 0,
            ' '.join(summary) or (r.stderr[-300:]))


def _ranking(rep):
    root = sandbox.build('/private/tmp/jaani_sandbox_rank', S3_CSV)
    proc = sandbox.start(root, port=5114, reader_port=5115, extra_env={'WEBSITE_LINK_MAX_WAIT_MS': '1500'})
    try:
        for query, expected in RANKING:
            resp, secs = verify('http://127.0.0.1:5114', query, False, timeout=120)
            top = [(m.get('Office') or m.get('office_name')) for m in resp.get('matches', [])]
            rep.add('15.6', f'ranking "{query}"', bool(top) and top[0] == expected, f'top={top[:3]} ({secs:.1f}s)')
    finally:
        sandbox.stop(proc)


def _partly_filled_csv(path):
    """245 rows with only MoHA filled (from the 59-row backup): DMP has a row but no officers yet."""
    rows = read_rows(S3_CSV)
    backup = {r['Office']: r for r in read_rows(BACKUP)}
    moha = by_office(rows, 'স্বরাষ্ট্র মন্ত্রণালয়')
    for c in csvio.OFFICER_COLUMNS:
        moha[c] = backup['স্বরাষ্ট্র মন্ত্রণালয়'][c]
    write_rows(path, rows)
    return path


def _section2(rep):
    before = json.loads((SCRAPER / 'tests' / 'fixtures' / 'baseline' / 'section2_before.json').read_text(encoding='utf-8'))
    after_path = SCRAPER / 'out' / 'section2_after.json'
    csv_path = _partly_filled_csv(Path('/private/tmp/jaani_s2_partly.csv'))
    r = subprocess.run([sys.executable, '-m', 'compat.section2_probe', '--csv', str(csv_path), '--out', str(after_path)],
                       cwd=SCRAPER, capture_output=True, text=True, timeout=900)
    if r.returncode != 0:
        rep.add('15.7', 'reference articles re-run', False, r.stderr[-300:])
        return
    after = json.loads(after_path.read_text(encoding='utf-8'))
    for b, a in zip(before, after):
        name = b['url'].rsplit('/', 1)[-1]
        rep.add('15.7', f'{name}: RTI target / cards / routing (before -> after)', None,
                f"target {b['rti_target_office']} -> {a['rti_target_office']}; cards {[c['office'] for c in b['rti_cards']]} -> "
                f"{[c['office'] for c in a['rti_cards']]}; s3 {b.get('verify_matches')} -> {a.get('verify_matches')}; "
                f"persons {b['news_persons']} -> {a['news_persons']}")
        empty_cards = [c for c in a['rti_cards'] if not c['primary']]
        rep.add('15.7', f'{name}: no empty officer card', not empty_cards, str(empty_cards)[:200])
    crime = after[0]
    card = crime.get('extract_entities_card') or {}
    rep.add('15.7', 'crime article still shows MoHA officers with the routing note (DMP row has none yet)',
            bool(card.get('primary')) and card.get('office') == 'স্বরাষ্ট্র মন্ত্রণালয়'
            and (card.get('matched_body') or {}).get('method') == 'agency_parent',
            json.dumps(card, ensure_ascii=False)[:220])
    g = crime.get('guidance_text', '')
    rep.add('15.7', 'guidance routes DMP to MoHA with the s.10 escalation note', 'ঊর্ধ্বতন কর্তৃপক্ষ' in g, g[:200])
    econ = after[1].get('guidance_text', '')
    rep.add('15.7', 'no "possible violation" (লঙ্ঘন) note for rows merely not scraped yet',
            'লঙ্ঘন' not in g and 'লঙ্ঘন' not in econ, (econ[:200]))


def _gazetteer_timing(rep):
    root = sandbox.build('/private/tmp/jaani_sandbox_gz', S3_CSV)
    script = ("const g=require('./services/rtiGazetteer');const t0=process.hrtime.bigint();g.matchGovernmentBodies('x');"
              "const t1=process.hrtime.bigint();const text='স্বরাষ্ট্র মন্ত্রণালয় ঢাকা মহানগর পুলিশ রাজউক ডিএমপি এনবিআর '.repeat(40);"
              "let n=0;const t2=process.hrtime.bigint();for(let i=0;i<50;i++){n=g.matchGovernmentBodies(text).matches.length;}"
              "const t3=process.hrtime.bigint();console.log(JSON.stringify({build_ms:Number(t1-t0)/1e6,per_article_ms:Number(t3-t2)/5e7,"
              "matches:n,dmp:g.matchGovernmentBodies('ঢাকা মহানগর পুলিশ').matches.map(m=>[m.canonical,m.method]).slice(0,2),"
              "rajuk:g.matchGovernmentBodies('রাজউক').matches.map(m=>[m.canonical,m.method]).slice(0,1)}))")
    r = subprocess.run(['node', '-e', script], cwd=root / 'backend', capture_output=True, text=True, timeout=120)
    try:
        d = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        rep.add('15.7', 'gazetteer rebuilt from 245 rows (timing)', False, r.stderr[-300:])
        return
    rep.add('15.7', 'gazetteer rebuilt from 245 rows: aliases resolve to own rows', d['dmp'][0][0] == 'ঢাকা মেট্রোপলিটন পুলিশ'
            and d['rajuk'][0][0] == 'রাজধানী উন্নয়ন কর্তৃপক্ষ (রাজউক)', json.dumps(d, ensure_ascii=False))
    rep.add('15.7', 'gazetteer timing (< 50 ms per article after build)', d['per_article_ms'] < 50,
            f"build {d['build_ms']:.1f} ms, {d['per_article_ms']:.2f} ms per article")


if __name__ == '__main__':
    sys.exit(main())
