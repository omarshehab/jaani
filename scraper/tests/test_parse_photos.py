"""Section 14 cases 1-13, 17, 21, 22, 27, 28, 29 (HTML side)."""
from pathlib import Path

import re

import pytest

from jaani_scraper import csvio
from jaani_scraper.assemble import Source, decide
from jaani_scraper.parse import parse_page

FX = Path(__file__).parent / 'fixtures'
IMG = 'https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/axvjbnqprylg/b/V2Ministry/o/office-test/2026/5/{}.jpg'
URL = 'https://test.gov.bd/views/info-officers'


def page(name, url=URL):
    p = FX / 'html' / f'{name}.html'
    return parse_page(p.read_text(encoding='utf-8'), url)


def run(pg, host='test.gov.bd', row=None, extra_sources=(), **kw):
    row = row or {c: '' for c in csvio.HEADER}
    return decide(row, [Source('live', pg.url, page=pg)] + list(extra_sources), host=host, **kw)


def test_01_moha_full_exact_cells():
    pg = parse_page((FX / 'live' / 'moha_info_officers.html').read_text(encoding='utf-8'),
                    'https://moha.gov.bd/views/info-officers')
    d = run(pg, host='moha.gov.bd')
    base = 'https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/axvjbnqprylg/b/V2Ministry/o/office-moha/'
    assert d.values == {
        'Primary_Officer_Name': 'মো: তোফায়েল হোসেন (১৬২৯৪)', 'Primary_Designation': 'উপসচিব ( প্রশাসন-১ শাখা)',
        'Primary_Phone': '+৮৮-০২-২২৩৩৫৪৫২১', 'Primary_Mobile': '০১৭১২০৬৩০৮৯', 'Primary_Email': 'admin1@moha.gov.bd',
        'Primary_Address': 'স্বরাষ্ট্র মন্ত্রণালয়', 'Primary_Image_URL': base + '2026/5/971da9f9-1b78-41ce-ba8a-24aec411846a.jpg',
        'Alternate_Officer_Name': 'নাসরীন সুলতানা (১৬২১৮)', 'Alternate_Designation': 'উপসচিব (পুলিশ-৪ শাখা)',
        'Alternate_Phone': '+৮৮-০২-৪৭১২৪৩৫৭', 'Alternate_Mobile': '০১৮১৬৫৯৭৩৮১', 'Alternate_Email': 'police4@moha.gov.bd',
        'Alternate_Address': 'স্বরাষ্ট্র মন্ত্রণালয়', 'Alternate_Image_URL': base + '2024/12/3c3b4e2eff5347fc821a164dbee05e6e.jpg',
        'Appellate_Officer_Name': 'মনজুর মোর্শেদ চৌধুরী', 'Appellate_Designation': 'সিনিয়র সচিব',
        'Appellate_Phone': '+৮৮-০২-২২৩৩৫৩৭১০', 'Appellate_Email': 'secretary@moha.gov.bd',
        'Appellate_Address': 'স্বরাষ্ট্র মন্ত্রণালয়', 'Appellate_Image_URL': base + '2026/1/4975f13e-1857-41de-9c26-58e2665d4d17.jpg',
    }
    assert pg.roles['appellate'].fields['Mobile'].state == 'PAGE_EMPTY'
    assert d.status == 'complete'
    assert pg.template == 'A'


def test_02_alternate_without_photo_stays_blank():
    d = run(page('photos_primary_appellate_only'))
    assert d.values['Alternate_Officer_Name'] == 'নাসরীন সুলতানা (১৬২১৮)'
    assert 'Alternate_Image_URL' not in d.values
    assert d.values['Primary_Image_URL'] == IMG.format('p1')
    assert d.values['Appellate_Image_URL'] == IMG.format('ap1')


def test_03_alternate_photo_only():
    d = run(page('photos_alternate_only'))
    assert d.values['Alternate_Image_URL'] == IMG.format('a1')
    assert 'Primary_Image_URL' not in d.values and 'Appellate_Image_URL' not in d.values


def test_04_dom_order_swapped_segments_by_heading():
    d = run(page('dom_order_swapped'))
    assert d.values['Appellate_Officer_Name'] == 'মনজুর মোর্শেদ চৌধুরী'
    assert d.values['Appellate_Image_URL'] == IMG.format('ap1')
    assert d.values['Alternate_Officer_Name'] == 'নাসরীন সুলতানা (১৬২১৮)'
    assert d.values['Alternate_Image_URL'] == IMG.format('a1')


def test_05_banner_between_blocks_not_assigned():
    d = run(page('banner_between_blocks'))
    assert 'Alternate_Image_URL' not in d.values
    assert all('banner' not in v and 'photo_2026' not in v for k, v in d.values.items() if k.endswith('Image_URL'))


def test_06_placeholder_in_one_block():
    d = run(page('placeholder_in_one_block'))
    assert 'Alternate_Image_URL' not in d.values
    assert d.values['Primary_Image_URL'] == IMG.format('p1')
    assert any('photo_candidates_rejected' in f for f in d.flags)


def test_06b_photo_whose_role_has_no_name_is_not_written():
    d = run(page('photo_role_without_name'))
    assert 'Alternate_Officer_Name' not in d.values and 'Alternate_Image_URL' not in d.values
    assert 'alternate:photo_role_without_name' in d.flags


def test_07_partial_60pct_field_states():
    pg = page('partial_60pct')
    p = pg.roles['primary'].fields
    assert p['Designation'].state == 'PAGE_EMPTY' and p['Mobile'].state == 'PAGE_EMPTY'
    a = pg.roles['alternate'].fields
    assert a['Designation'].state == 'NOT_ON_PAGE' and a['Address'].state == 'NOT_ON_PAGE'
    d = run(pg)
    assert d.values['Primary_Officer_Name'] and 'Primary_Designation' not in d.values
    assert 'Appellate_Designation' not in d.values
    assert d.status in ('partial', 'sparse')


def test_08_page_blank_writes_nothing():
    row = {c: '' for c in csvio.HEADER}
    row['Last_Updated'] = '2026-09-28'
    d = run(page('page_blank'), row=row)
    assert d.values == {} and d.status == 'page_blank'
    changes = csvio.merge_row(row, d.values, '2026-09-29')
    assert changes == [] and row['Last_Updated'] == '2026-09-28'


def test_09_label_empty_vs_missing_vs_parse_miss():
    f = page('label_empty_vs_missing').roles['primary'].fields
    assert f['Designation'].state == 'PAGE_EMPTY'
    assert f['Phone'].state == 'NOT_ON_PAGE'
    assert f['Email'].state in ('FILLED', 'PARSE_MISS')
    assert f['Email'].value in ('', 'admin1@test.gov.bd')


def test_10_card_layout():
    pg = page('card_layout')
    d = run(pg)
    assert d.values['Primary_Image_URL'] == IMG.format('p1')
    assert d.values['Alternate_Image_URL'] == IMG.format('a1')
    assert 'Appellate_Image_URL' not in d.values
    assert d.values['Alternate_Mobile'] == '০১৮১৬৫৯৭৩৮১'
    assert pg.template == 'E'


def test_11_table_rows():
    d = run(page('table_rows'))
    assert d.values['Primary_Officer_Name'] == 'মো: তোফায়েল হোসেন (১৬২৯৪)'
    assert d.values['Primary_Image_URL'] == IMG.format('p1')
    assert 'Alternate_Image_URL' not in d.values
    assert d.values['Alternate_Email'] == 'police4@test.gov.bd'
    assert d.values['Appellate_Image_URL'] == IMG.format('ap1')


def test_12_legacy_template_cloaked_email_and_stale():
    pg = page('legacy_template')
    d = run(pg)
    assert d.values['Primary_Officer_Name'] == 'মো: তোফায়েল হোসেন (১৬২৯৪)'
    assert d.values['Primary_Designation'] == 'সহকারী পরিচালক'
    assert 'Primary_Email' not in d.values
    assert 'email_cloaked' in pg.roles['primary'].fields['Email'].flags
    assert d.values['Appellate_Officer_Name'] == 'মোহাম্মদ শাহীন ইমরান'
    assert 'stale_12m' in pg.flags
    assert 'Alternate_Officer_Name' not in d.values


def test_13_static_page_focal_point_writes_nothing():
    pg = page('static_page_focal_point')
    d = run(pg)
    assert d.values == {}
    assert 'focal_point_only' in pg.flags


def test_17_prompt_injection_text_is_just_a_bad_address():
    d = run(page('prompt_injection'))
    assert all('evil' not in v for v in d.values.values())


def test_21_email_offdomain_is_kept_and_flagged():
    from jaani_scraper.validate import validate
    ok, flags = validate('Email', 'tahaminabcs30@gmail.com', host='mof.gov.bd')
    assert ok and 'email_offdomain' in flags


def test_22_conflict_s1_vs_crosscheck_keeps_s1_and_records_discrepancy():
    live = page('photos_primary_appellate_only')
    staff = Source('crosscheck', 'https://test.gov.bd/pages/officers',
                   values={('primary', 'Officer_Name'): 'মো: তোফায়েল হোসেন (১৬২৯৪)',
                           ('primary', 'Designation'): 'যুগ্মসচিব'})
    d = run(live, extra_sources=[staff])
    assert d.values['Primary_Designation'] == 'উপসচিব ( প্রশাসন-১ শাখা)'
    assert any(x['field'] == 'Designation' and x['other'] == 'যুগ্মসচিব' for x in d.discrepancies)


def test_22b_two_different_people_are_never_merged():
    live = page('partial_60pct')
    other = Source('archive', 'https://web.archive.org/x', values={
        ('primary', 'Officer_Name'): 'মোঃ শিমুল আকতার', ('primary', 'Designation'): 'উপসচিব',
        ('primary', 'Mobile'): '০১৭১১১১১১১১'})
    d = run(live, extra_sources=[other])
    assert d.values['Primary_Officer_Name'] == 'মো: তোফায়েল হোসেন (১৬২৯৪)'
    assert 'Primary_Designation' not in d.values and 'Primary_Mobile' not in d.values
    assert any(x['field'] == 'Officer_Name' for x in d.discrepancies)


def test_27_legacy_font_html_converted_labels_matched_after_recovery():
    pg = page('legacy_font_html')
    assert 'legacy_font_page' in pg.flags
    f = pg.roles['primary'].fields
    assert f['Officer_Name'].value == 'মোঃ আনোয়ার হোসেন' and f['Officer_Name'].recovered == 'bijoy'
    assert f['Designation'].value == 'সহকারী সচিব'
    d = run(pg)
    assert 'Primary_Officer_Name' not in d.values          # high-risk, recovered, no second reading
    assert 'Primary_Email' not in d.values                  # no confirmed name -> the role is not written
    assert any(r['field'] == 'Officer_Name' and 'no_second_reading' in r['flag'] for r in d.review)
    d2 = run(pg, second_reader=lambda c: {'Officer_Name': 'মোঃ আনোয়ার হোসেন'}.get(c.field))
    assert d2.values['Primary_Officer_Name'] == 'মোঃ আনোয়ার হোসেন'
    assert d2.values['Primary_Designation'] == 'সহকারী সচিব'
    assert d2.values['Primary_Email'] == 'anwar@test.gov.bd'
    assert 'recovered_bijoy' in d2.provenance['Primary_Officer_Name']['flags']


@pytest.mark.parametrize('kind,method', [('human_saved', 'human'), ('live', 'llm'), ('file', 'ocr')])
def test_28_integrity_gate_applies_to_every_source(kind, method):
    src = Source(kind, 'https://test.gov.bd/x', method=method,
                 values={('primary', 'Officer_Name'): '†gvt Av‡bvqvi †nv‡mb', ('primary', 'Designation'): 'mnKvix mwPe|'})
    d = decide({c: '' for c in csvio.HEADER}, [src], host='test.gov.bd',
               second_reader=lambda c: c.value)
    assert d.values == {}
    assert all('integrity_failed' in r['flag'] for r in d.review)


def test_29_human_confirmed_override_beats_live():
    live = page('photos_primary_appellate_only')
    ov = Source('human_confirmed', 'confirmed_overrides.csv', method='human',
                values={('primary', 'Officer_Name'): 'মো: তোফায়েল হোসেন (১৬২৯৪)',
                        ('primary', 'Designation'): 'উপসচিব (প্রশাসন-১ শাখা)'})
    d = run(live, extra_sources=[ov])
    assert d.values['Primary_Designation'] == 'উপসচিব (প্রশাসন-১ শাখা)'
    assert d.provenance['Primary_Designation']['source'] == 'human_confirmed'


def test_bidi_control_characters_are_removed():
    from jaani_scraper.textnorm import norm
    from jaani_scraper.validate import validate
    v = norm('০২২২২২১৬৮৪৫‬')
    assert v == '০২২২২২১৬৮৪৫' and validate('Phone', v)[0]


def test_phone_with_office_note_is_kept_verbatim():
    from jaani_scraper.validate import validate
    ok, flags = validate('Phone', '৯৫৭৬৬৭৯ (অফিস)')
    assert ok and 'phone_annotation' in flags
    assert not validate('Phone', 'কল করুন অফিসে')[0]


def test_several_labels_on_one_line_are_split():
    html = ('<html><body><h3>দায়িত্বপ্রাপ্ত কর্মকর্তা</h3><p>নাম: জনাব করিম</p>'
            '<p>ফোনঃ (অফিস) ০২-২২৬৬৪১০৫২ মোবাইলঃ ০১৭১৭২০৪২৭৯ ই-মেইলঃ adm@cabinet.gov.bd</p></body></html>')
    f = parse_page(html, URL).roles['primary'].fields
    assert f['Phone'].value.endswith('০২-২২৬৬৪১০৫২') and f['Mobile'].value == '০১৭১৭২০৪২৭৯'
    assert f['Email'].value == 'adm@cabinet.gov.bd'


def test_live_reb_static_subpage_alternate_and_appellate_officer_headings():
    """'বিকল্প কর্মকর্তাঃ' / 'আপীল কর্মকর্তাঃ' headings and a label cell whose value is on the next row."""
    html = (FX / 'live' / 'reb_static_rti.html').read_text(encoding='utf-8')
    p = parse_page(html, 'https://reb.gov.bd/pages/static-pages/6922e0c8933eb65569e28901')
    assert p.roles['primary'].name == 'জনাব সাকিলা খন্দকার'
    assert p.roles['alternate'].name == 'জনাব মোঃ শাহ আলম'
    assert p.roles['appellate'].name == 'জনাব মিরানা মাহরুখ'
    assert not [f for f in p.flags if f.startswith('unknown_role_heading')]


def test_multi_role_title_is_container_but_bilingual_single_role_is_not():
    from jaani_scraper.parse import classify_heading
    assert classify_heading('দায়িত্বপ্রাপ্ত কর্মকর্তা, বিকল্প কর্মকর্তা ও আপিল কর্তৃপক্ষ') == 'container'
    assert classify_heading('বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা / Alternate Designated Officer') == 'alternate'
    assert classify_heading('আপিল কর্মকর্তাঃ') == 'appellate'
    assert classify_heading('কর্মকর্তার নাম') is None


def test_live_d2_role_row_table_sbc():
    """Template D2: one row per role; 'কর্মকর্তার নাম ও পদবি' is one column, never a name 'ও পদবি'."""
    p = parse_page((FX / 'live' / 'sbc_static_rti.html').read_text(encoding='utf-8'),
                   'https://sbc.gov.bd/pages/static-pages/6922dc30933eb65569e0ee1e')
    assert p.roles['primary'].name == 'জনাব শাহ্ মুহাম্মাদ সানওয়ার আলম'
    assert p.roles['primary'].fields['Designation'].value == 'ডেপুটি জেনারেল ম্যানেজার'
    assert p.roles['primary'].fields['Email'].value == 'shah.sanwar@sbc.gov.bd'
    assert p.roles['alternate'].name == 'জনাব এমদাদুল হক'
    assert p.roles['appellate'].name == ''                                   # the page names only the post
    assert p.roles['appellate'].fields['Designation'].value == 'ব্যবস্থাপনা পরিচালক'


def test_live_d2_role_row_table_bcic_rowspan_container():
    p = parse_page((FX / 'live' / 'bcic_static_rti.html').read_text(encoding='utf-8'),
                   'https://bcic.gov.bd/pages/static-pages/6922e07a933eb65569e27416')
    assert p.roles['primary'].name == 'জনাব করিমুন্নিসা'
    assert p.roles['primary'].fields['Mobile'].value == '০১৭২০৯২০৭৬৬'
    assert p.roles['alternate'].name == 'জনাব মোহাম্মদ সাইফুল ইসলাম'
    assert p.roles['alternate'].fields['Designation'].value == 'সহকারী প্রোগ্রামার, এমআইএস বিভাগ'


def test_name_label_fragment_rejected():
    from jaani_scraper.validate import validate
    assert validate('Officer_Name', 'ও পদবি') == (False, ['name_suspect', 'name_is_label_fragment'])
    assert validate('Officer_Name', 'জনাব মোঃ আবদুল নামদার')[0]


# Real refused values from the Tier 4 check-in (tests/fixtures/live/tier4_refused_phones.json).
@pytest.mark.parametrize('field, value', [
    ('Phone', '০২৪৭৮৮২৫০৩৫ (অফিস) ০২৪৭৭৭২৬০৫৯ (Bungalow)'),
    ('Phone', 'অফিস: ০২৪১৩৬০৮০১ (সিএ), বাসা: ০২৩৩৩৩৬৫৭৬৬ (সিএ)'),
    ('Phone', '০২৩৩৩৩০২৭০৬ (NDC)'),
    ('Phone', 'Telephone: 02-48315085'),
    ('Mobile', 'mobile: 01713062404'),
    ('Mobile', '০১৮৮০৯১৪৪৯২ (AC Confidential), ০১৫৫০-০২৯৪৭১ (NDC-Official)'),
    ('Phone', 'ফোন (অফিস) : ০২-৯৯৬৬৬১৪৪৪ (সিএ), ০২৯৯৭৭১০২৪৭ (সরাসরি)'),
])
def test_tier4_annotated_phones_pass_and_are_stored_verbatim(field, value):
    from jaani_scraper.validate import validate
    ok, flags = validate(field, value)
    assert ok and 'phone_annotation' in flags
    if re.match(r'^\s*(mobile|ফোন)', value, re.I):
        return          # an inner label would be split off by the page parser before validation; validator-only here
    c = {c: '' for c in csvio.HEADER}
    from jaani_scraper.parse import FieldResult, parse_page
    page = parse_page(f'<div class="static-page"><h3>দায়িত্বপ্রাপ্ত কর্মকর্তা</h3><p>নাম: জনাব আলম</p>'
                      f'<p>{"মোবাইল" if field == "Mobile" else "ফোন"}: {value}</p></div>', 'https://x.gov.bd/p')
    d = decide(c, [Source('live', page.url, page=page)], host='x.gov.bd')
    assert d.values[f'Primary_{field}'] == value                 # verbatim: notes and every number kept


def test_tier4_multi_number_cell_checks_every_number():
    from jaani_scraper.validate import validate
    ok, flags = validate('Phone', '০২৪৭৮৮২৫০৩৫ (অফিস) ০২৪৭৭৭২৬০৫৯ (Bungalow)')
    assert ok and 'phone_suspect' not in flags
    ok, flags = validate('Phone', '০২৪৭৮৮২৫০৩৫ (অফিস) ১২ (Bungalow)')       # second "number" is not a number
    assert 'phone_suspect' in flags


@pytest.mark.parametrize('field, value, flag', [
    ('Mobile', 'Tel: ০২-৪৮৩১৫০৮৫ (Office), ০২-৪৮৩১৫০৮৪ (Bungalow)', 'landline_in_mobile_field'),
    ('Mobile', 'পদবী মন্ত্রিপরিষদ সচিব ফোন (অফিস) ০২-২২৬৬৪১৪৪৪', 'unparsed_phone'),
    ('Mobile', 'নং', 'unparsed_phone'),
    ('Mobile', '০১৮৬৯১৪৪৯৭৫(শিক্ষা শাখা, স্থানীয় সরকার শাখা ও তথ্য ও অভিযোগ শাখা)', 'unparsed_phone'),   # note > 25
])
def test_tier4_values_that_stay_refused(field, value, flag):
    from jaani_scraper.validate import validate
    assert validate(field, value) == (False, [flag])
