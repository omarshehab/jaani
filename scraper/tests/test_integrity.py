"""Tests 23 (bijoy vectors), 26 (visual order) and the 6A.4 validation rules."""
import pytest

from jaani_scraper import integrity as ti
from jaani_scraper.bijoy import bijoy_to_unicode

V = ti.vectors()


@pytest.mark.parametrize('v', V['bijoy_to_unicode'], ids=lambda v: v['bijoy'])
def test_vector_converts_exactly(v):
    assert bijoy_to_unicode(v['bijoy']) == v['unicode']


@pytest.mark.parametrize('v', V['bijoy_to_unicode'], ids=lambda v: v['bijoy'])
def test_converted_text_is_valid_unicode(v):
    expected = ti.UNICODE_OK if ti.BENGALI_BLOCK.search(v['unicode']) else ti.ENGLISH_OK
    assert ti.classify_text(v['unicode']) == expected


def test_at_least_30_extra_vectors_from_the_gazette():
    extra = [v for v in V['bijoy_to_unicode'] if v['kind'] == 'word']
    assert len(extra) >= 30


@pytest.mark.parametrize('v', V['classify'], ids=lambda v: repr(v['text'])[:40])
def test_classification(v):
    assert ti.classify_text(v['text'], v['font_hint']) == v['expected']


def test_negatives_are_never_touched_by_recovery():
    for v in V['classify']:
        if v['note'] == 'must stay unchanged':
            assert ti.classify_text(v['text']) in ti.STORABLE


def test_broken_sample_is_never_storable_and_never_converted():
    s = 'দোভিত্বপ্রোপ্ত কর্ মকিমো'
    assert ti.classify_text(s) == ti.VISUAL_ORDER_BROKEN
    assert not ti.storable(s)
    ok, reasons = ti.validate_recovered('Primary_Designation', s, second_reading=s)
    assert not ok


@pytest.mark.parametrize('bijoy,expected', [
    ('I', 'ও'), ('†gvt', 'মোঃ'),                 # ও vs ো ; visarga
    ('C`', 'ঈদ'), ('mnKvix', 'সহকারী'),          # ঈ / ী
    ('Dò', 'উষ্ণ'), ('cÎ', 'পত্র'),              # ষ্ণ, ত্র
    ('gš¿Yvjq', 'মন্ত্রণালয়'),                    # conjunct order
    ('†KŠkj', 'কৌশল'), ('†jvK', 'লোক'),           # two-part vowels
    ('Kg©KZ©v', 'কর্মকর্তা'), ('Kvh©vjq', 'কার্যালয়'), ('c~e©eZx©', 'পূর্ববর্তী'),   # reph
])
def test_known_traps(bijoy, expected):
    assert bijoy_to_unicode(bijoy) == expected


def test_digits_follow_the_font_run_not_the_page():
    assert bijoy_to_unicode('G-1') == 'এ-১'
    assert bijoy_to_unicode('G-1', digits_bengali=False) == 'এ-1'


def test_unicode_colon_in_mo_is_not_converted_to_visarga():
    assert ti.classify_text('মো: তোফায়েল হোসেন') == ti.UNICODE_OK


@pytest.mark.parametrize('font,legacy', [('HKMNBG+SutonnyMJ', True), ('SutonnyOMJ', True), ('"SutonnyMJ", serif', True),
                                         ('AdarshaLipi-ANSI', True), ('Bijoy Bayanno', True), ('Kalpurush', False),
                                         ('Nikosh', False), ('SolaimanLipi', False), ('Noto Sans Bengali', False),
                                         ('TimesNewRomanPSMT', False)])
def test_legacy_font_names(font, legacy):
    assert bool(ti.is_legacy_font(font)) is legacy


def test_high_risk_recovered_value_needs_second_reading():
    ok, reasons = ti.validate_recovered('Primary_Officer_Name', 'মোঃ আনোয়ার হোসেন')
    assert not ok and 'no_second_reading' in reasons
    ok, _ = ti.validate_recovered('Primary_Officer_Name', 'মোঃ আনোয়ার হোসেন', second_reading='মোঃ আনোয়ার হোসেন')
    assert ok


def test_name_disagreement_blocks():
    ok, reasons = ti.validate_recovered('Primary_Officer_Name', 'মোঃ আনোয়ার হোসেন', second_reading='মোঃ আনিসুর রহমান')
    assert not ok and any(r.startswith('second_reading_similarity') for r in reasons)


def test_digit_disagreement_blocks():
    ok, reasons = ti.validate_recovered('Primary_Mobile', '০১৭১২০৬৩০৮৯', second_reading='01712063088')
    assert not ok and 'digits_disagree' in reasons
    ok, _ = ti.validate_recovered('Primary_Mobile', '০১৭১২০৬৩০৮৯', second_reading='01712063089')
    assert ok


def test_designation_needs_domain_lexicon():
    ok, _ = ti.validate_recovered('Primary_Designation', 'সহকারী সচিব', second_reading='সহকারী সচিব')
    assert ok
    ok, reasons = ti.validate_recovered('Primary_Designation', 'মকিমো পোদাত', second_reading='মকিমো পোদাত')
    assert not ok and any(r.startswith('lexicon_ratio') for r in reasons)
