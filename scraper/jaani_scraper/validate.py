"""Field validation (section 10): flags problems, refuses a few kinds of value, never rewrites a value."""
import re
from functools import lru_cache
from pathlib import Path

import phonenumbers
import tldextract

from . import integrity as ti
from .parse import PLACEHOLDERS, classify_heading, label_field
from .textnorm import ascii_digits, digits_only, norm, squash

CONFIG = Path(__file__).resolve().parents[1] / 'config'
EMAIL_FULL = re.compile(r'^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$')
MOBILE_RE = re.compile(r'^(?:\+?88)?01[3-9]\d{8}$')
PHONE_ALLOWED = re.compile(r'^[\d\s+\-()/.,;:]*(?:(?:ext|extn|pabx|x)\.?\s*[\d\s,]+)?[\d\s+\-()/.,;:]*$', re.I)
BLEED_RE = re.compile(r'(ইমেইল|ই-মেইল|মোবাইল|ফোন\s*[:ঃ]|টেলিফোন\s*[:ঃ]|নাম\s*[:ঃ]|পদবি\s*[:ঃ]|পদবী\s*[:ঃ]|'
                      r'e-?mail\s*:|mobile\s*:|phone\s*:)', re.I)
# "৯৫৭৬৬৭৯ (অফিস)": a note on which line it is; the value is stored verbatim, the note is ignored for checking.
PHONE_NOTE_RE = re.compile(r'\(?\s*(অফিস|বাসা|বাসভবন|দপ্তর|ফ্যাক্স|ফ্যাক্স|office|off\.?|res\.?|residence|home|fax|pabx)\s*\)?', re.I)
# Owner rule 2026-09-29 (Tier 4 DC pages): a leading "Tel:" / "Telephone:" / "Mobile:" label and a bracketed note of
# up to 25 characters with no digit in it ("(Bungalow)", "(সিএ)", "(NDC-Official)") are ignored for CHECKING only; the
# stored value stays verbatim. Each note becomes a separator, so every number in a multi-number cell is checked.
PHONE_PREFIX_RE = re.compile(r'^\s*(?:tel(?:ephone)?|phone|mobile|mob|cell|ফোন|মোবাইল|টেলিফোন)\s*(?:\([^()\d]{1,25}\))?\s*[:ঃ.]?\s*(?=[+\d০-৯])',
                             re.I)
PHONE_BRACKET_NOTE_RE = re.compile(r'\(\s*[^()\d০-৯]{1,25}\s*\)')
_extract = tldextract.TLDExtract(suffix_list_urls=(), cache_dir=None)


@lru_cache(maxsize=1)
def designations():
    return {squash(ln) for ln in (CONFIG / 'designations.txt').read_text(encoding='utf-8').splitlines() if ln.strip()}


def registrable(host):
    e = _extract(host or '')
    return f'{e.domain}.{e.suffix}'.lower() if e.suffix else (host or '').lower()


def split_numbers(value):
    return [p for p in re.split(r'[,;/]|\s{2,}', ascii_digits(value)) if digits_only(p)]


def validate(field_base, value, host='', recovered=False):
    """-> (store: bool, flags: list). field_base is one of Officer_Name, Designation, Phone, Mobile, Email, Address,
    Image_URL. `recovered` values also need integrity.validate_recovered (called by the caller with a second reading)."""
    flags = []
    v = norm(value)
    if not v:
        return False, ['empty']
    cls = ti.classify_text(v)
    if cls not in ti.STORABLE:
        return False, ['integrity_failed', f'class_{cls}']
    if v.lower() in PLACEHOLDERS:
        return False, ['placeholder_value']
    if field_base == 'Officer_Name':
        if '@' in v:
            return False, ['name_suspect', 'name_has_at']
        if digits_only(v) and len(digits_only(v)) >= 7 and not re.search(r'[A-Za-zঅ-হ]', v):
            return False, ['name_suspect', 'name_is_phone']
        if label_field(v) or classify_heading(v) in ('primary', 'alternate', 'appellate', 'container'):
            return False, ['name_suspect', 'name_is_label']
        if squash(v) in designations():
            return False, ['name_suspect', 'name_is_designation']
        if re.match(r'^(ও|এবং|and)\s', v) or re.search(r'(^|\s)(পদবি|পদবী|নাম)(\s|$)', v):
            return False, ['name_suspect', 'name_is_label_fragment']      # "ও পদবি" (live, sbc.gov.bd)
        if len(v) > 120:
            return False, ['name_suspect', 'name_too_long']
    elif field_base == 'Email':
        if not EMAIL_FULL.match(v):
            return False, ['email_invalid']
        dom = v.split('@', 1)[1].lower()
        if host and registrable(dom) != registrable(host) and not dom.endswith('.gov.bd'):
            flags.append('email_offdomain')
    elif field_base in ('Phone', 'Mobile'):
        bare = PHONE_PREFIX_RE.sub('', v)
        bare = PHONE_BRACKET_NOTE_RE.sub(' ; ', bare)
        bare = PHONE_NOTE_RE.sub(' ; ', bare)
        if bare != v:
            flags.append('phone_annotation')
        if not PHONE_ALLOWED.match(ascii_digits(bare)):
            return False, ['unparsed_phone']
        parts = split_numbers(bare)
        if field_base == 'Mobile' and re.match(r'^\s*tel(?:ephone)?\b', v, re.I) and \
                not any(MOBILE_RE.match(digits_only(p)) for p in parts):
            return False, ['landline_in_mobile_field']      # "Tel: ০২-৪৮৩১৫০৮৫ (Office), ..." under a Mobile label
        for p in parts:
            d = digits_only(p)
            if field_base == 'Mobile':
                if not MOBILE_RE.match(d):
                    flags.append('mobile_suspect')
            else:
                if MOBILE_RE.match(d):
                    flags.append('phone_looks_mobile')
                else:
                    try:
                        num = phonenumbers.parse(p if p.strip().startswith('+') else p, 'BD')
                        if not phonenumbers.is_possible_number(num):
                            flags.append('phone_suspect')
                    except phonenumbers.NumberParseException:
                        flags.append('phone_suspect')
    elif field_base in ('Designation', 'Address'):
        if len(v) > 300:
            return False, ['too_long']
        if re.search(r'<[a-zA-Z/][^>]*>|&[a-z]+;', v):
            return False, ['html_remnant']
        if BLEED_RE.search(v):
            return False, ['field_bleed']
        if re.search(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}|https?://', v):
            return False, ['field_bleed', 'contact_in_text_field']
    return True, sorted(set(flags))
