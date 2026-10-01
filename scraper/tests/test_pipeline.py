"""End-to-end P1-P8 against an in-process fake portal (httpx.MockTransport): robots, alternate paths, shared pages,
photo verification, CSV write, reports. Tests 8, 19, 20, 21 at pipeline level."""
from pathlib import Path

import httpx
import pytest

from jaani_scraper import csvio, net
from jaani_scraper.netguard import Policy
from jaani_scraper.pipeline import Pipeline

FX = Path(__file__).parent / 'fixtures'
MOHA = (FX / 'live' / 'moha_info_officers.html').read_text(encoding='utf-8')
LEGACY = (FX / 'html' / 'legacy_template.html').read_text(encoding='utf-8')
BLANK = (FX / 'html' / 'page_blank.html').read_text(encoding='utf-8')
PHOTO_OK = {'content-type': 'image/jpeg', 'content-length': '48213'}


def portal(requests):
    def handler(req):
        requests.append((req.method, str(req.url)))
        h, path = req.url.host, req.url.path
        if path == '/robots.txt':
            if h == 'blocked.gov.bd':
                return httpx.Response(200, text='User-agent: *\nDisallow: /\n')
            return httpx.Response(404)
        if h.startswith('objectstorage.'):
            if 'missing' in path:
                return httpx.Response(404)
            return httpx.Response(200, headers=PHOTO_OK, content=b'' if req.method == 'HEAD' else b'x' * 48213)
        if h == 'moha.gov.bd' and path == '/views/info-officers':
            return httpx.Response(200, text=MOHA, headers={'content-type': 'text/html; charset=utf-8'})
        if h == 'alt.gov.bd' and path == '/site/view/information_officers':
            return httpx.Response(200, text=LEGACY, headers={'content-type': 'text/html; charset=utf-8'})
        if h == 'blank.gov.bd' and path == '/views/info-officers':
            return httpx.Response(200, text=BLANK, headers={'content-type': 'text/html; charset=utf-8'})
        if h == 'shared.gov.bd':
            return httpx.Response(301, headers={'location': 'https://moha.gov.bd/views/info-officers'})
        return httpx.Response(404, text='not found')
    return handler


def make_csv(tmp_path):
    base = {c: '' for c in csvio.HEADER}
    rows = []
    for i, (office, link) in enumerate([
            ('স্বরাষ্ট্র মন্ত্রণালয়', 'https://moha.gov.bd/views/info-officers'),
            ('ক অধিদপ্তর', 'https://blocked.gov.bd/views/info-officers'),
            ('খ অধিদপ্তর', 'https://alt.gov.bd/views/info-officers'),
            ('গ অধিদপ্তর', 'https://blank.gov.bd/views/info-officers'),
            ('ঘ অধিদপ্তর', 'https://shared.gov.bd/views/info-officers')]):
        r = dict(base, Ministry='স্বরাষ্ট্র মন্ত্রণালয়', Division='জননিরাপত্তা বিভাগ', Office=office, Website_Link=link,
                 Last_Updated='2026-09-28')
        rows.append(r)
    p = tmp_path / 'in.csv'
    p.write_bytes(csvio.serialize(rows))
    return p


@pytest.fixture
def run(tmp_path):
    requests = []
    client = httpx.Client(transport=httpx.MockTransport(portal(requests)), follow_redirects=False)
    f = net.GuardedFetcher('JAANI-RTI-DirectoryBot/2.0 (+mailto:test@example.org)', delay=0, policy=Policy(),
                           client=client, sleep=lambda s: None)
    p = Pipeline(make_csv(tmp_path), tmp_path / 'out', fetcher=f, today='2026-09-29',
                 filled_path=tmp_path / 's3out' / 'filled.csv')
    p.run(p.select())
    return p, requests, tmp_path


def by_office(p, office):
    return next(r for r in p.rows if r['Office'] == office)


def test_full_page_filled_with_photos(run):
    p, _, _ = run
    r = by_office(p, 'স্বরাষ্ট্র মন্ত্রণালয়')
    assert r['Primary_Officer_Name'] == 'মো: তোফায়েল হোসেন (১৬২৯৪)'
    assert r['Alternate_Image_URL'].endswith('3c3b4e2eff5347fc821a164dbee05e6e.jpg')
    assert r['Appellate_Mobile'] == ''
    assert r['Last_Updated'] == '2026-09-29'


def test_robots_blocked_host_gets_zero_page_requests_and_manual_queue(run):
    p, requests, tmp = run
    assert [u for m, u in requests if 'blocked.gov.bd' in u and not u.endswith('/robots.txt')] == []
    assert p.results['স্বরাষ্ট্র মন্ত্রণালয়|জননিরাপত্তা বিভাগ|ক অধিদপ্তর'].status == 'blocked_robots'
    assert 'robots' in (tmp / 'out' / 'manual_queue.csv').read_text(encoding='utf-8')


def test_alternate_path_found_and_website_link_updated(run):
    p, _, _ = run
    r = by_office(p, 'খ অধিদপ্তর')
    assert r['Primary_Officer_Name'] == 'মো: তোফায়েল হোসেন (১৬২৯৪)'
    assert r['Website_Link'] == 'https://alt.gov.bd/site/view/information_officers'


def test_blank_page_writes_nothing_and_keeps_last_updated(run):
    p, _, _ = run
    r = by_office(p, 'গ অধিদপ্তর')
    assert not any(r[c] for c in csvio.OFFICER_COLUMNS)
    assert r['Last_Updated'] == '2026-09-28'
    assert p.results['স্বরাষ্ট্র মন্ত্রণালয়|জননিরাপত্তা বিভাগ|গ অধিদপ্তর'].status == 'page_blank'


def test_shared_page_not_filled_and_link_kept(run):
    p, _, _ = run
    r = by_office(p, 'ঘ অধিদপ্তর')
    assert not any(r[c] for c in csvio.OFFICER_COLUMNS)
    assert r['Website_Link'] == 'https://shared.gov.bd/views/info-officers'
    assert any(f.startswith('shared_page') for f in p.results['স্বরাষ্ট্র মন্ত্রণালয়|জননিরাপত্তা বিভাগ|ঘ অধিদপ্তর'].flags)


def test_written_csv_is_valid_sorted_and_unique(run):
    p, _, tmp = run
    out = tmp / 's3out' / 'filled.csv'
    rows = csvio.read_csv(out)
    assert len(rows) == 5
    assert out.read_bytes() == csvio.serialize(rows)
    csvio.check_unique_links(rows)


def test_reports_exist(run):
    p, _, tmp = run
    for name in ('review_queue.csv', 'manual_queue.csv', 'discrepancies.csv', 'unextracted_signals.csv',
                 'coverage_report.md', 'photo_review.html', 'bijoy_review.html', 'confirmed_overrides.csv',
                 'row_status.json', 'link_check_report.csv', 'scrape_log.jsonl', 'state.sqlite'):
        assert (tmp / 'out' / name).exists(), name
    assert 'নাসরীন সুলতানা' in (tmp / 'out' / 'photo_review.html').read_text(encoding='utf-8')


def test_photo_404_is_not_stored(tmp_path):
    html = MOHA.replace('971da9f9-1b78-41ce-ba8a-24aec411846a', 'missing-photo')
    requests = []
    handler = portal(requests)

    def h2(req):
        if req.url.host == 'moha.gov.bd' and req.url.path == '/views/info-officers':
            return httpx.Response(200, text=html, headers={'content-type': 'text/html'})
        return handler(req)
    client = httpx.Client(transport=httpx.MockTransport(h2), follow_redirects=False)
    f = net.GuardedFetcher('UA (+mailto:t@e.org)', delay=0, client=client, sleep=lambda s: None)
    p = Pipeline(make_csv(tmp_path), tmp_path / 'out', fetcher=f, today='2026-09-29',
                 filled_path=tmp_path / 'f.csv')
    p.run(p.select(only_host='moha.gov.bd'))
    r = by_office(p, 'স্বরাষ্ট্র মন্ত্রণালয়')
    assert r['Primary_Officer_Name'] and r['Primary_Image_URL'] == ''
    assert 'primary:photo_http_404' in p.results[csvio.row_key(r)].flags


def test_subpage_links_follow_rti_officer_pages_not_grs():
    from pathlib import Path
    from jaani_scraper.pipeline import Pipeline, _rti_officer_link
    assert _rti_officer_link('তথ্য অধিকারের দায়িত্বপ্রাপ্ত কর্মকর্তা ও আপিল কর্তৃপক্ষ')
    assert _rti_officer_link('তথ্য প্রদানকারী কর্মকর্তা')
    assert not _rti_officer_link('আপিল কর্মকর্তা')                 # GRS appeal officer on these portals
    assert not _rti_officer_link('অভিযোগ নিষ্পত্তি কর্মকর্তা')
    assert not _rti_officer_link('তথ্য অধিকার বাস্তবায়ন কমিটি')
    html = (Path(__file__).parent / 'fixtures' / 'live' / 'reb_info_officers.html').read_text(encoding='utf-8')
    assert Pipeline._subpages(None, None, html, 'https://reb.gov.bd/site/view/info_officers') == \
        ['https://reb.gov.bd/pages/static-pages/6922e0c8933eb65569e28901']


def test_corrupt_file_is_skipped_not_a_row_error():
    from jaani_scraper.pipeline import Pipeline
    from jaani_scraper import files
    from jaani_scraper.pipeline import RowResult
    logs = []

    class P(Pipeline):
        def __init__(self):
            self.log = lambda **kw: logs.append(kw)
    p, res = P(), RowResult('k', '')
    row = {'Ministry': 'm', 'Division': 'd', 'Office': 'o'}
    assert p._parse_file(row, res, b'%PDF-1.4\n1 0 obj <<', 'https://t.gov.bd/a.pdf', 'application/pdf') is None
    assert 'file_parse_failed' in res.flags and logs[0]['event'] == 'file_parse_failed'
    assert p._parse_file(row, res, b'x' * files.FILE_CAP, 'https://t.gov.bd/b.pdf', 'application/pdf') is None
    assert 'file_truncated_at_cap' in res.flags


def test_nbr_file_list_picks_newest_officer_list_only():
    from pathlib import Path
    from jaani_scraper.pipeline import Pipeline, rti_file_links
    html = (Path(__file__).parent / 'fixtures' / 'live' / 'nbr_oicaa_filelist.html').read_text(encoding='utf-8')
    base = 'https://nbr.gov.bd/information-library/oicaa/eng'
    links = rti_file_links(html, base)
    assert links == ['https://nbr.gov.bd/uploads/oicaa/তথ্য_অধিকার_আইন.pdf',          # 15-12-2025
                     'https://nbr.gov.bd/uploads/oicaa/NBR_20241226_0001.pdf']        # 24-12-2024
    assert Pipeline._file_links(None, html, base) == links[:1]                         # never the VAT instruction PDF


def test_file_fallback_ignores_unrelated_pdfs():
    from jaani_scraper.pipeline import Pipeline
    base = 'https://pwd.gov.bd/'
    html = ('<a href="/document/project/Running_Projects_all.pdf">Running projects</a>'
            '<a href="/uploads/rti/officers.pdf">list</a>')
    assert Pipeline._file_links(None, html, base) == ['https://pwd.gov.bd/uploads/rti/officers.pdf']
    assert Pipeline._file_links(None, '<a href="/document/project/End_Projects.pdf">x</a>', base) == []
    listed = html + '<a href="/x/notice.pdf">তথ্য প্রদানকারী কর্মকর্তা</a>'
    assert Pipeline._file_links(None, listed, base) == ['https://pwd.gov.bd/x/notice.pdf']   # officer list wins


def test_empty_only_row_is_refused():
    import subprocess, sys
    r = subprocess.run([sys.executable, '-m', 'jaani_scraper', 'run', '--only-row', '', '--dry-run'],
                       capture_output=True, text=True, env={**__import__('os').environ, 'JAANI_CONTACT_EMAIL': 'x@y.z'})
    assert r.returncode != 0 and 'refusing to run without a filter' in r.stderr


@pytest.mark.parametrize('argv, msg', [
    (['run'], 'refusing to select all 245 rows'),
    (['check'], 'refusing to select all 245 rows'),
    (['run', '--retry-failed'], 'refusing to select all 245 rows'),
    (['run', '--only-host', ' '], '--only-host is empty'),
    (['run', '--tier', '4', '--limit', '0'], '--limit must be >= 1'),
    (['run', '--tier', '4', '--limit', '-3'], '--limit must be >= 1'),
    (['run', '--tier', '4', '--workers', '0'], '--workers must be >= 1'),
    (['run', '--tier', '4', '--llm-max-pages', '-1'], '--llm-max-usd must be >= 0'),
    (['run', '--tier', '4', '--llm-max-usd', '-2'], '--llm-max-usd must be >= 0'),
    (['run', '--tier', '4', '--archive-max-age-months', '0'], '--archive-max-age-months must be >= 1'),
    (['run', '--tier', '4', '--insecure-host', ''], '--insecure-host is empty'),
    (['import-html'], 'needs a target path'),
    (['recover-file'], 'needs a target path'),
])
def test_scope_arguments_never_widen_silently(argv, msg):
    from jaani_scraper.__main__ import build_parser, scope_problem
    problem = scope_problem(build_parser().parse_args(argv))
    assert problem and msg in problem


def test_explicit_scope_is_accepted():
    from jaani_scraper.__main__ import build_parser, scope_problem
    for argv in (['run', '--tier', '4', '--ocr-engine', 'both', '--workers', '4', '--delay', '3.0', '--llm-max-usd', '2'],
                 ['run', '--only-row', 'M|D|O'], ['check', '--only-host', 'moha.gov.bd'], ['finalize'],
                 ['compat-check'], ['apply-overrides']):
        assert scope_problem(build_parser().parse_args(argv)) is None
