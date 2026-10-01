"""Whitespace/Unicode normalisation (section 6.1). Never changes spelling, digits or punctuation."""
import html
import re
import unicodedata

# zero-width and bidi control characters (seen live: a phone number ending in U+202C)
ZERO_WIDTH = dict.fromkeys(map(ord, '\u200b\u2060\ufeff\u00ad\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069'), None)
BN_DIGITS = str.maketrans('০১২৩৪৫৬৭৮৯', '0123456789')


def norm(s):
    """NFC, zero-width removed (ZWJ/ZWNJ kept: they are meaningful in Bengali), NBSP -> space, runs collapsed."""
    if s is None:
        return ''
    s = unicodedata.normalize('NFC', str(s)).translate(ZERO_WIDTH).replace(' ', ' ')
    return re.sub(r'\s+', ' ', s).strip()


def decode_entities(s):
    """Decode HTML entities twice: pages carry double-escaped digits such as &amp;#x09E7;."""
    return html.unescape(html.unescape(s or ''))


def squash(s):
    """Comparison key: no spaces, ':', '-', '–'; spelling variants folded (never used for stored values)."""
    s = re.sub(r'[\s:：\-–—]+', '', norm(s).replace('‌', '').replace('‍', ''))
    return s.replace('আপিল', 'আপীল').replace('দ্বায়িত্ব', 'দায়িত্ব').replace('পদবী', 'পদবি')


def ascii_digits(s):
    return (s or '').translate(BN_DIGITS)


def digits_only(s):
    return re.sub(r'\D', '', ascii_digits(s))
