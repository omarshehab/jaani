"""Routes S0 (overrides), S4 (saved pages / snippet JSON), S5 (Information Commission export) and finalize."""
import json
from pathlib import Path

import pytest

from jaani_scraper import csvio, importers
from jaani_scraper.__main__ import _NoNet
from jaani_scraper.pipeline import Pipeline

FX = Path(__file__).parent / 'fixtures'
MOHA = (FX / 'live' / 'moha_info_officers.html').read_text(encoding='utf-8')


def make(tmp_path, n=4, fill=None):
    base = {c: '' for c in csvio.HEADER}
    rows = []
    for i, (office, link) in enumerate([('স্বরাষ্ট্র মন্ত্রণালয়', 'https://moha.gov.bd/views/info-officers'),
                                        ('ক অধিদপ্তর', 'https://ka.gov.bd/views/info-officers'),
                                        ('খ অধিদপ্তর', 'https://kha.gov.bd/views/info-officers'),
                                        ('গ অধিদপ্তর', 'https://ga.gov.bd/views/info-officers')][:n]):
        rows.append(dict(base, Ministry='স্বরাষ্ট্র মন্ত্রণালয়', Division='জননিরাপত্তা বিভাগ', Office=office,
                         Website_Link=link, Last_Updated='2026-09-28', **(fill or {}).get(office, {})))
    p = tmp_path / 'in.csv'
    p.write_bytes(csvio.serialize(rows))
    pl = Pipeline(p, tmp_path / 'out', fetcher=_NoNet(), today='2026-09-29', filled_path=tmp_path / 'filled.csv',
                  verify_photos=False)
    return pl


def row(p, office):
    return next(r for r in p.rows if r['Office'] == office)


def test_saved_html_with_sidecar_url(tmp_path):
    p = make(tmp_path)
    d = tmp_path / 'saved'
    d.mkdir()
    (d / 'moha.html').write_text(MOHA, encoding='utf-8')
    (d / 'moha.url.txt').write_text('https://moha.gov.bd/views/info-officers\n', encoding='utf-8')
    srcs, problems = importers.import_saved(d, p.rows, p.log)
    for k, s in srcs.items():
        p.apply_sources(p.by_key[k], s)
    r = row(p, 'স্বরাষ্ট্র মন্ত্রণালয়')
    assert r['Primary_Officer_Name'] == 'মো: তোফায়েল হোসেন (১৬২৯৪)'
    assert r['Primary_Image_URL'].startswith('https://objectstorage.')
    assert problems == []


def test_saved_html_with_browser_rewritten_images_keeps_photo_blank(tmp_path):
    p = make(tmp_path)
    d = tmp_path / 'saved'
    d.mkdir()
    html = MOHA.replace('https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/axvjbnqprylg/b/V2Ministry/o/office-moha/',
                        './info-officers_files/')
    (d / 'x.html').write_text('<!-- saved from url=(0039)https://moha.gov.bd/views/info-officers -->' + html,
                              encoding='utf-8')
    srcs, _ = importers.import_saved(d, p.rows, p.log)
    for k, s in srcs.items():
        p.apply_sources(p.by_key[k], s)
    r = row(p, 'স্বরাষ্ট্র মন্ত্রণালয়')
    assert r['Primary_Officer_Name'] and r['Primary_Image_URL'] == ''


def test_saved_html_without_url_is_skipped(tmp_path):
    p = make(tmp_path)
    d = tmp_path / 'saved'
    d.mkdir()
    (d / 'x.html').write_text('<html><body>দায়িত্বপ্রাপ্ত কর্মকর্তা</body></html>', encoding='utf-8')
    srcs, problems = importers.import_saved(d, p.rows, p.log)
    assert srcs == {} and problems == [('x.html', 'no_original_url')]


def test_snippet_json_route(tmp_path):
    p = make(tmp_path)
    d = tmp_path / 'saved'
    d.mkdir()
    (d / 'ka.gov.bd.json').write_text(json.dumps({
        'url': 'https://ka.gov.bd/views/info-officers', 'captured_at': '2026-09-29T10:00:00Z',
        'roles': {'primary': {'name': 'জনাব রফিকুল ইসলাম', 'designation': 'উপপরিচালক', 'email': 'rafiq@ka.gov.bd',
                              'image': 'https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/a/b/V2Ministry/o/office-ka/1.jpg'},
                  'alternate': {'name': 'mnKvix mwPe', 'designation': 'x'}}}), encoding='utf-8')
    srcs, _ = importers.import_saved(d, p.rows, p.log)
    for k, s in srcs.items():
        p.apply_sources(p.by_key[k], s)
    r = row(p, 'ক অধিদপ্তর')
    assert r['Primary_Officer_Name'] == 'জনাব রফিকুল ইসলাম' and r['Primary_Email'] == 'rafiq@ka.gov.bd'
    assert r['Primary_Image_URL'].endswith('office-ka/1.jpg')
    assert r['Alternate_Officer_Name'] == ''          # Bijoy text from a human import is refused too (R11)


def test_infocom_export_fills_blank_cells_only(tmp_path):
    p = make(tmp_path, fill={'খ অধিদপ্তর': {'Primary_Officer_Name': 'জনাব করিম', 'Primary_Email': 'karim@kha.gov.bd'}})
    f = tmp_path / 'infocom.csv'
    f.write_text('কর্তৃপক্ষ,নাম,পদবি,মোবাইল,ইমেইল\n'
                 'খ অধিদপ্তর,জনাব করিম,সহকারী পরিচালক,01711000000,other@kha.gov.bd\n'
                 'গ অধিদপ্তর,জনাব রহিম,উপপরিচালক,01811000000,rahim@ga.gov.bd\n'
                 'অজানা দপ্তর,জনাব x,y,01911000000,x@y.gov.bd\n', encoding='utf-8')
    srcs = importers.import_infocom(f, p.rows, p.log)
    for k, s in srcs.items():
        p.apply_sources(p.by_key[k], s)
    kha = row(p, 'খ অধিদপ্তর')
    assert kha['Primary_Email'] == 'karim@kha.gov.bd'          # existing value kept
    assert kha['Primary_Designation'] == 'সহকারী পরিচালক'       # blank filled
    ga = row(p, 'গ অধিদপ্তর')
    assert ga['Primary_Officer_Name'] == 'জনাব রহিম' and ga['Alternate_Officer_Name'] == ''
    assert p.results[csvio.row_key(ga)].decision.provenance['Primary_Officer_Name']['source'] == 'infocom'


def test_override_designation_only_uses_existing_name(tmp_path):
    p = make(tmp_path, fill={'খ অধিদপ্তর': {'Primary_Officer_Name': 'জনাব করিম', 'Primary_Designation': 'উপসচিব'}})
    k = csvio.row_key(row(p, 'খ অধিদপ্তর'))
    f = tmp_path / 'ov.csv'
    f.write_text('row_key,role,field,value,note\n'
                 f'"{k}",primary,Designation,যুগ্মসচিব,checked on the page by the owner\n'
                 f'"{k}",alternate,Officer_Name,†gvt Av‡bvqvi †nv‡mb,garbled paste\n'
                 'nope|x|y,primary,Designation,x,\n', encoding='utf-8')
    srcs, bad = importers.read_overrides(f, p.rows)
    assert len(bad) == 1
    for key, s in srcs.items():
        p.apply_sources(p.by_key[key], s)
    r = row(p, 'খ অধিদপ্তর')
    assert r['Primary_Designation'] == 'যুগ্মসচিব' and r['Primary_Officer_Name'] == 'জনাব করিম'
    assert r['Alternate_Officer_Name'] == ''
    assert p.results[k].decision.provenance['Primary_Designation']['source'] == 'human_confirmed'


def test_finalize_blanks_image_used_by_three_bodies(tmp_path):
    same = 'https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/a/b/V2Ministry/o/office-x/default.jpg'
    fill = {o: {'Primary_Officer_Name': f'জনাব {i}', 'Primary_Image_URL': same}
            for i, o in enumerate(['ক অধিদপ্তর', 'খ অধিদপ্তর', 'গ অধিদপ্তর'])}
    p = make(tmp_path, fill=fill)
    blanked, _ = p.finalize()
    assert len(blanked) == 3
    assert all(r['Primary_Image_URL'] == '' for r in p.rows)
    assert 'default.jpg' in (tmp_path / 'out' / 'placeholder_photos.csv').read_text(encoding='utf-8')


def test_finalize_keeps_real_photo_shared_by_the_same_officer_across_many_bodies(tmp_path):
    """The RTI appellate authority for a district is its divisional commissioner: the SAME real person, with the
    SAME real photo, legitimately recurs across every district in the division (verified against live pages,
    Tier 4). That must never be treated as a placeholder just because it crosses the >= 3-bodies count."""
    same = 'https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/a/b/V2Ministry/o/office-dhakadiv/dc.jpg'
    fill = {o: {'Appellate_Officer_Name': 'মোঃ মনিরুজ্জামান মিঞা', 'Appellate_Image_URL': same}
            for o in ['জেলা প্রশাসকের কার্যালয় গাজীপুর', 'জেলা প্রশাসকের কার্যালয় মুন্সীগঞ্জ',
                     'জেলা প্রশাসকের কার্যালয় শরীয়তপুর', 'জেলা প্রশাসকের কার্যালয় নারায়ণগঞ্জ']}
    p = make(tmp_path, fill=fill)
    blanked, _ = p.finalize()
    assert blanked == []
    assert all(r['Appellate_Image_URL'] == same for r in p.rows if r['Office'] in fill)


def test_finalize_blanks_only_the_mismatched_names_when_a_url_is_mixed(tmp_path):
    """Three bodies share a URL: two are the same real officer (legit), one is a different name (that one row's
    'photo' is not actually them -- likely a stale/generic image). Only the genuinely mismatched cell is blanked."""
    same = 'https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/a/b/V2Ministry/o/office-x/mixed.jpg'
    fill = {
        'ক অধিদপ্তর': {'Primary_Officer_Name': 'জনাব করিম', 'Primary_Image_URL': same},
        'খ অধিদপ্তর': {'Primary_Officer_Name': 'জনাব করিম', 'Primary_Image_URL': same},
        'গ অধিদপ্তর': {'Primary_Officer_Name': 'জনাব রহিম', 'Primary_Image_URL': same},
    }
    p = make(tmp_path, fill=fill)
    blanked, _ = p.finalize()
    # names are not uniform for this URL -> the spec's own first sentence (different names -> blank) applies
    assert len(blanked) == 3
    assert all(r['Primary_Image_URL'] == '' for r in p.rows if r['Office'] in fill)


def test_override_blank_sentinel_clears_a_cell(tmp_path):
    """R1's protection against accidentally blanking real data must not become bypassable by an empty value in
    the override file: only the exact BLANK_SENTINEL clears a cell. A bare/stripped-empty value stays a rejected
    (bad) row, exactly as before."""
    p = make(tmp_path, fill={'খ অধিদপ্তর': {'Primary_Officer_Name': 'test', 'Primary_Designation': 'test',
                                            'Alternate_Email': 'real@kha.gov.bd'}})
    k = csvio.row_key(row(p, 'খ অধিদপ্তর'))
    f = tmp_path / 'ov.csv'
    f.write_text('row_key,role,field,value,note\n'
                 f'"{k}",primary,Officer_Name,<BLANK>,template junk published by the site\n'
                 f'"{k}",primary,Designation,<BLANK>,same\n'
                 f'"{k}",alternate,Email,,accidental empty -- must be rejected, not treated as blank\n',
                 encoding='utf-8')
    srcs, bad = importers.read_overrides(f, p.rows)
    assert len(bad) == 1 and 'unknown row/role/field or empty value' in bad[0][1]
    for key, s in srcs.items():
        p.apply_sources(p.by_key[key], s)
    r = row(p, 'খ অধিদপ্তর')
    assert r['Primary_Officer_Name'] == '' and r['Primary_Designation'] == ''
    assert r['Alternate_Email'] == 'real@kha.gov.bd'          # untouched: no sentinel was given for it
    assert r['Last_Updated'] == p.today


def test_override_blank_sentinel_is_logged_as_human_confirmed(tmp_path):
    p = make(tmp_path, fill={'খ অধিদপ্তর': {'Primary_Officer_Name': 'test'}})
    k = csvio.row_key(row(p, 'খ অধিদপ্তর'))
    f = tmp_path / 'ov.csv'
    f.write_text(f'row_key,role,field,value,note\n"{k}",primary,Officer_Name,<BLANK>,junk\n', encoding='utf-8')
    logged = []
    p.log = lambda **kw: logged.append(kw)
    srcs, bad = importers.read_overrides(f, p.rows)
    for key, s in srcs.items():
        p.apply_sources(p.by_key[key], s)
    events = [e for e in logged if e.get('event') == 'cell_written' and e.get('column') == 'Primary_Officer_Name']
    assert len(events) == 1
    assert events[0]['previous'] == 'test' and events[0]['written'] == ''
    assert events[0]['source'] == 'human_confirmed'
