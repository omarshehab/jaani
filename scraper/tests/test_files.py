"""Section 14 cases 14, 15, 24, 25 (files). PDFs are generated here with reportlab; the legacy font is a Latin TTF
whose name is set to 'Sutonny' in the PDF, which is exactly how a SutonnyMJ file looks to a text extractor."""
import io

import pytest
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from jaani_scraper import csvio
from jaani_scraper.assemble import Source, decide
from jaani_scraper.files import parse_pdf
from jaani_scraper.secondread import SecondReader

ARIAL = '/System/Library/Fonts/Supplemental/Arial.ttf'
BANGLA = '/System/Library/Fonts/Supplemental/Bangla MN.ttc'
URL = 'https://file-test.portal.gov.bd/files/officers.pdf'


def make_pdf(rows, font_file, rename=None, subfont=0):
    name = 'F' + str(abs(hash((font_file, subfont))))[:6]
    if name not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(name, font_file, subfontIndex=subfont))
    b = io.BytesIO()
    c = canvas.Canvas(b, pageCompression=0)
    y, x0, x1, x2 = 760, 60, 220, 540
    for label, value, value_font in rows:
        c.rect(x0, y - 22, x1 - x0, 22)
        c.rect(x1, y - 22, x2 - x1, 22)
        c.setFont(name, 11)
        c.drawString(x0 + 4, y - 16, label)
        c.setFont(value_font or name, 11)
        c.drawString(x1 + 4, y - 16, value)
        y -= 22
    c.save()
    data = b.getvalue()
    if rename:
        old, new = rename
        assert len(old) == len(new)
        data = data.replace(old, new)
    return data


def unicode_pdf():
    rows = [('দায়িত্বপ্রাপ্ত কর্মকর্তা', '', None), ('নাম:', 'মো: তোফায়েল হোসেন', None), ('পদবি:', 'উপসচিব', None),
            ('ইমেইল:', 'admin1@test.gov.bd', 'Helvetica')]
    return make_pdf(rows, BANGLA)


def bijoy_pdf():
    rows = [('`vwqZ¡cÖvß Kg©KZ©v', '', None), ('bvg:', '†gvt Av‡bvqvi †nv‡mb', None), ('c`we:', 'mnKvix mwPe', None),
            ('B-‡gBj:', 'anwar@test.gov.bd', 'Helvetica')]
    return make_pdf(rows, ARIAL, rename=(b'ArialMT', b'Sutonny'))


def decide_pdf(data, second_reader=None):
    page, meta, info = parse_pdf(data, URL)
    src = Source('file', URL, page=page, meta=meta)
    return page, info, decide({c: '' for c in csvio.HEADER}, [src], host='file-test.portal.gov.bd',
                              second_reader=second_reader)


def test_14_pdf_unicode_table():
    page, info, d = decide_pdf(unicode_pdf())
    assert info['legacy_runs'] == 0
    assert d.values['Primary_Officer_Name'] == 'মো: তোফায়েল হোসেন'
    assert d.values['Primary_Designation'] == 'উপসচিব'
    assert d.values['Primary_Email'] == 'admin1@test.gov.bd'


def test_15_pdf_bijoy_without_second_reading_stores_nothing():
    page, info, d = decide_pdf(bijoy_pdf())
    assert 'legacy_font_file' in page.flags
    assert page.roles['primary'].fields['Officer_Name'].value == 'মোঃ আনোয়ার হোসেন'
    assert d.values == {}
    rev = [r for r in d.review if r['field'] == 'Officer_Name']
    assert rev and 'no_second_reading' in rev[0]['flag']
    assert rev[0]['where']['page'] == 1 and len(rev[0]['where']['bbox']) == 4


def test_24_bijoy_pdf_per_run_fonts_and_matching_second_reading(tmp_path):
    data = bijoy_pdf()
    page, meta, info = parse_pdf(data, URL)
    fonts = {e['font'] for e in info['recovery']}
    assert any('Sutonny' in f for f in fonts) and 'Helvetica' in fonts
    assert page.roles['primary'].fields['Email'].value == 'anwar@test.gov.bd'   # English run untouched
    readings = {'Officer_Name': 'মোঃ আনোয়ার হোসেন', 'Designation': 'সহকারী সচিব'}
    reader = SecondReader({URL: data}, tmp_path, engines=('vision',),
                          vision=lambda png, cand=None: readings.get(cand.field))
    _, _, d = decide_pdf(data, second_reader=reader)
    assert d.values['Primary_Officer_Name'] == 'মোঃ আনোয়ার হোসেন'
    assert d.values['Primary_Designation'] == 'সহকারী সচিব'
    assert d.values['Primary_Email'] == 'anwar@test.gov.bd'
    assert list(tmp_path.glob('*.png')), 'a crop is rendered for the review page'


@pytest.mark.parametrize('reading,written', [('মোঃ আনিসুর রহমান', False), ('মোঃ আনোয়ার হোসেন', True), (None, False)])
def test_25_ocr_disagreement_on_name(reading, written):
    _, _, d = decide_pdf(bijoy_pdf(), second_reader=lambda c: reading if c.field == 'Officer_Name' else c.value)
    assert ('Primary_Officer_Name' in d.values) is written


def test_25b_digits_must_agree_exactly():
    from jaani_scraper.integrity import validate_recovered
    assert not validate_recovered('Primary_Mobile', '০১৭১২০৬৩০৮৯', second_reading='০১৭১২০৬৩০৮০')[0]
    assert validate_recovered('Primary_Mobile', '০১৭১২০৬৩০৮৯', second_reading='01712063089')[0]


# --- owner rule for --ocr-engine both: high-risk fields need BOTH engines to agree ---------------------------------
from jaani_scraper.secondread import SecondReader as _SR


def _reader(tmp_path, tess, vis):
    return _SR({URL: bijoy_pdf()}, tmp_path, engines=('tesseract', 'vision'),
               vision=lambda png, cand=None: vis.get(cand.field), tesseract=tess)


def test_both_engines_agree_confirms_high_risk(tmp_path):
    names = {'Officer_Name': 'মোঃ আনোয়ার হোসেন', 'Designation': 'সহকারী সচিব'}
    state = {'i': 0}

    def tess(img):
        state['i'] += 1
        return (['মোঃ আনোয়ার হোসেন', 'সহকারী সচিব'][state['i'] - 1], 91.0)
    _, _, d = decide_pdf(bijoy_pdf(), second_reader=_reader(tmp_path, tess, names))
    assert d.values['Primary_Officer_Name'] == 'মোঃ আনোয়ার হোসেন'


def test_tesseract_failure_never_confirms_high_risk_alone(tmp_path):
    def tess(img):
        raise RuntimeError('rotated scan')
    vis = {'Officer_Name': 'মোঃ আনোয়ার হোসেন', 'Designation': 'সহকারী সচিব'}
    _, _, d = decide_pdf(bijoy_pdf(), second_reader=_reader(tmp_path, tess, vis))
    assert 'Primary_Officer_Name' not in d.values
    rev = [r for r in d.review if r['field'] == 'Officer_Name']
    assert rev and 'ocr_tesseract_failed' in (rev[0]['where'].get('ocr_flags') or [])


def test_low_tesseract_confidence_counts_as_failure(tmp_path):
    vis = {'Officer_Name': 'মোঃ আনোয়ার হোসেন'}
    _, _, d = decide_pdf(bijoy_pdf(), second_reader=_reader(tmp_path, lambda img: ('মোঃ আনোয়ার হোসেন', 35.0), vis))
    assert 'Primary_Officer_Name' not in d.values


def test_engines_disagree_blocks(tmp_path):
    vis = {'Officer_Name': 'মোঃ আনোয়ার হোসেন'}
    _, _, d = decide_pdf(bijoy_pdf(), second_reader=_reader(tmp_path, lambda img: ('মোঃ আনিসুর রহমান', 95.0), vis))
    assert 'Primary_Officer_Name' not in d.values


LIVE = __import__('pathlib').Path(__file__).parent / 'fixtures' / 'live'


def test_nbr_scan_text_layer_is_ignored_not_recovered():
    """NBR's officer list is a scanned page with a scanner's Latin OCR layer (Helvetica): it is not Bijoy and must
    never be 'recovered'; the page goes to 6A.2-C only."""
    from jaani_scraper import files
    data = (LIVE / 'nbr_oicaa_2025_scan.pdf').read_bytes()
    page, meta, info = files.parse_pdf(data, 'https://nbr.gov.bd/uploads/oicaa/x.pdf')
    assert info['scanned_pages'] == [1] and 'scanned_file' in page.flags
    assert not page.roles and 'bijoy_garbled' not in page.flags and 'legacy_font_file' not in page.flags


def test_nbr_scan_candidates_from_recorded_readings():
    import json
    from jaani_scraper.secondread import scanned_candidates
    r = json.loads((LIVE / 'nbr_oicaa_2025_reading.json').read_text(encoding='utf-8'))
    got = {(i['role'], i['field']): i['flag'].split(':')[1] for i in scanned_candidates(r, 'u', 1)}
    assert got[('alternate', 'Officer_Name')] == 'agree'
    assert got[('appellate', 'Officer_Name')] == 'agree'
    assert got[('primary', 'Officer_Name')] == 'single_engine'        # Tesseract lost the line: never accepted
    assert got[('appellate', 'Phone')] == 'disagree'                  # '0 ০২২…' vs '০২-২২…'
    assert got[('primary', 'Email')] == 'agree'
    items = scanned_candidates(r, 'u', 1)
    assert all(i['method'] == 'ocr' and i['flag'].startswith('scanned_ocr_candidate') for i in items)


def test_scanned_candidates_are_never_written(tmp_path):
    """Pipeline level: review items only; the decision has no value from a scan."""
    import json
    from jaani_scraper.assemble import decide
    from jaani_scraper.secondread import scanned_candidates
    r = json.loads((LIVE / 'nbr_oicaa_2025_reading.json').read_text(encoding='utf-8'))
    d = decide({c: '' for c in csvio.HEADER}, [], host='nbr.gov.bd')
    d.review.extend(scanned_candidates(r, 'u', 1))
    assert d.values == {} and len(d.review) >= 10
