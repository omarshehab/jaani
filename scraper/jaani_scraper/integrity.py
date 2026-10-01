"""Text integrity gate (section 6A, rule R11): classify, validate structure, validate recovered text.

Nothing reaches the CSV unless classify_text() says ENGLISH_OK or UNICODE_OK. Recovered (converted/OCR) text must
additionally pass validate_recovered(). Thresholds are tuned on shared/text_integrity_vectors.json (README).
backend/utils/textIntegrity.js implements the same rules for the Node app; both read the same vectors.
"""
import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

import Levenshtein
import regex

from .textnorm import digits_only, norm

REPO = Path(__file__).resolve().parents[2]
VECTORS_PATH = REPO / 'shared' / 'text_integrity_vectors.json'
CONFIG = Path(__file__).resolve().parents[1] / 'config'

EMPTY, ENGLISH_OK, UNICODE_OK = 'EMPTY', 'ENGLISH_OK', 'UNICODE_OK'
BIJOY_ANSI, VISUAL_ORDER_BROKEN, MIXED, UNKNOWN = 'BIJOY_ANSI', 'VISUAL_ORDER_BROKEN', 'MIXED', 'UNKNOWN'
STORABLE = {ENGLISH_OK, UNICODE_OK}

BENGALI_LETTER = re.compile(r'[অ-হৎড়-ৡৰৱ]')
BENGALI_BLOCK = re.compile(r'[ঀ-৿]')
DEP_VOWEL = set(chr(c) for c in range(0x09BE, 0x09CD)) | {'ৗ', 'ৢ', 'ৣ'}
HASANTA = '্'
SIGNS = {'ঁ', 'ং', 'ঃ', '়'}   # candrabindu, anusvara, visarga, nukta
ZWNJ, ZWJ = '‌', '‍'
# Characters a legacy (Bijoy/SutonnyMJ) run is made of, excluding ordinary typography (“ ” ‘ ’ – —) that also
# appears in real Unicode text.
STRONG_SIGNATURE = set(chr(c) for c in range(0x00A1, 0x0100)) | set('†‡ˆ‰ŠšŒœŸƒ„…‹›˜™¯')
EMAIL_RE = re.compile(r'^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
URL_RE = re.compile(r'^(https?://|www\.)\S+$', re.I)
PHONE_RE = re.compile(r'^[+()\d\s./-]{5,}$')
VOWELLESS_OK = {'mr', 'mrs', 'ms', 'dr', 'st', 'md', 'mst', 'ltd', 'phd', 'bcs', 'ndc', 'psc', 'hq', 'dc', 'pwd',
                'bd', 'rd', 'nd', 'th', 'sq', 'jr', 'sr', 'engr', 'cc', 'bcc', 'pbx', 'tnt', 'fax', 'tel',
                'cell', 'mob', 'by', 'my', 'dy', 'secy', 'gm', 'dgm', 'agm', 'dg', 'ddg', 'addl', 'jt', 'pps', 'ps',
                'apps', 'aps', 'spl', 'vc', 'pvc', 'rtd', 'mph', 'mbbs', 'llb', 'llm', 'bsc', 'msc', 'mss', 'mba',
                'nbr', 'nsi', 'dmp', 'cmp', 'rmp', 'rab', 'bgb', 'bpdb', 'lgd', 'lged', 'dncc', 'dscc', 'ctg', 'jpg', 'png', 'pdf', 'xls', 'xlsx', 'doc',
                'docx', 'ppt', 'pptx', 'txt', 'csv', 'svg', 'gif', 'bmp', 'html', 'php', 'www', 'http', 'https', 'pbx',
                'kb', 'mb', 'gb', 'km', 'mm', 'cm', 'kg', 'no', 'nos'}


@lru_cache(maxsize=1)
def legacy_font_prefixes():
    lines = (CONFIG / 'legacy_fonts.txt').read_text(encoding='utf-8').splitlines()
    return tuple(ln.strip().lower() for ln in lines if ln.strip() and not ln.startswith('#'))


def is_legacy_font(font_name):
    """PDF font names carry a subset prefix (HKMNBG+SutonnyMJ); CSS lists families (\"SutonnyMJ\", serif)."""
    if not font_name:
        return None
    names = [n.strip().strip('\'"').lower() for n in re.split(r'[,]', font_name)]
    names = [n.split('+', 1)[1] if re.match(r'^[a-z]{6}\+', n) else n for n in names]
    return any(n.replace(' ', '').startswith(p) for n in names for p in legacy_font_prefixes())


def _english_token(t):
    if EMAIL_RE.match(t) or URL_RE.match(t) or PHONE_RE.match(t):
        return True
    core = re.sub(r'^[^\w]+|[^\w]+$', '', t)
    return not core or core.isdigit()


def bijoy_evidence(t):
    """Evidence that a pure-ASCII/Latin-1 token is Bijoy text (rule 6A.1 b/c): 'strong', 'weak' or ''.
    strong: a legacy symbol (¨ © Ö š ...), an internal capital (msL¨v, mnKvix, gš¿Yvjq), a backtick or a word-final '|'.
    weak: a vowel-less letter run (bs, wW) that is not an all-caps acronym or a known abbreviation.
    Weak evidence alone never makes text BIJOY_ANSI (tuned on English UI text of live portals, README)."""
    if any(c in STRONG_SIGNATURE for c in t):
        return 'strong'
    if _english_token(t):
        return ''
    core = re.sub(r'^[(\["\']+|[)\]"\'.,;:!?]+$', '', t)
    letters = re.sub(r'[^A-Za-z]', '', core)
    if not letters:
        return 'strong' if ('`' in core or core.endswith('|')) else ''
    if re.search(r'[a-z][A-Z]', core) and not re.match(r'^(Mc|Mac|De|Di|La|Le|O\')[A-Z][a-z]+$', core):
        return 'strong'
    if '`' in core or re.search(r'\w\|', core):
        return 'strong'
    if letters.isupper():
        return ''
    if len(letters) >= 2 and not re.search(r'[aeiouyAEIOUY]', letters) and letters.lower() not in VOWELLESS_OK:
        return 'weak'
    return ''


def bijoy_like_token(t):
    return bijoy_evidence(t) != ''


def structure_problems(word):
    """Bengali-block structure checks shared with the Node twin (no library needed)."""
    probs = []
    if '�' in word:
        probs.append('replacement_char')
    chars = [c for c in word if c not in (ZWNJ, ZWJ)]
    if not chars:
        return probs
    if chars[0] in DEP_VOWEL or chars[0] == HASANTA or chars[0] in ('ঁ', 'ং', '়'):
        probs.append('leading_mark')
    # A word-final hasanta is legitimate spelling in names (শাহ্, মিজ্); a word-final র্ is a detached reph, the
    # signature of text stored in visual order ("কর্ মকিমো"). Tuned on the 59-row dataset (README).
    if word.endswith('\u09B0' + HASANTA):
        probs.append('detached_reph')
    for a, b in zip(chars, chars[1:]):
        if a in DEP_VOWEL and b in DEP_VOWEL:
            probs.append('double_matra')
        if a == HASANTA and (b in DEP_VOWEL or b == HASANTA or b in SIGNS):
            probs.append('hasanta_before_mark')
        if a in DEP_VOWEL and b == HASANTA:
            probs.append('matra_before_hasanta')
    return probs


@lru_cache(maxsize=1)
def _normalizer():
    try:
        import io
        import contextlib
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            from bnunicodenormalizer import Normalizer
            return Normalizer()
    except Exception:
        return None


def bn_words(s):
    return [w for w in regex.split(r'[^\p{Bengali}‌‍]+', s) if BENGALI_BLOCK.search(w)]


def word_invalid(word):
    if word == 'ঃ':          # a free-standing visarga ("মূল্য ঃ টাকা") is accepted legacy typography
        return False
    if structure_problems(word):
        return True
    n = _normalizer()
    if n is None:
        return False
    try:
        r = n(word)
    except Exception:
        return True
    if r['normalized'] is None:
        return True
    if not any(op['operation'] == 'InvalidUnicode' for op in r['ops']):
        return False
    # The normalizer also rejects an explicit final hasanta (শাহ্) and a nukta on letters without a precomposed
    # form (জ় in ফিজ়নূর). Those are real spellings, so they are not treated as invalid.
    tolerated = {word.rstrip(HASANTA), word.replace('\u09BC', ''), word.rstrip(HASANTA).replace('\u09BC', '')}
    return unicodedata.normalize('NFC', r['normalized']) not in {unicodedata.normalize('NFC', t) for t in tolerated}


def classify_text(s, font_hint=None):
    """-> EMPTY | ENGLISH_OK | UNICODE_OK | BIJOY_ANSI | VISUAL_ORDER_BROKEN | MIXED | UNKNOWN"""
    s = norm(s)
    if not s:
        return EMPTY
    has_bn = bool(BENGALI_LETTER.search(s))
    strong = sum(c in STRONG_SIGNATURE for c in s)
    legacy = is_legacy_font(font_hint)
    if legacy:
        return MIXED if has_bn else BIJOY_ANSI
    if '�' in s:
        return VISUAL_ORDER_BROKEN if has_bn or BENGALI_BLOCK.search(s) else UNKNOWN
    if has_bn:
        if strong:
            return MIXED
        words = bn_words(s)
        bad = [w for w in words if word_invalid(w)]
        if bad and (len(bad) / max(1, len(words)) >= 0.10 or any(structure_problems(w) for w in bad)):
            return VISUAL_ORDER_BROKEN
        return UNICODE_OK
    if BENGALI_BLOCK.search(s):                       # Bengali marks/digits without letters
        if strong:
            return MIXED
        return UNICODE_OK if not any(structure_problems(w) for w in bn_words(s) if w != 'ঃ') else VISUAL_ORDER_BROKEN
    tokens = s.split()
    ev = [bijoy_evidence(t) for t in tokens]
    strong_tokens, weak_tokens = ev.count('strong'), ev.count('weak')
    score = (strong_tokens + 0.5 * weak_tokens) / len(tokens)
    if strong >= 2 or (strong_tokens and score >= 0.5):
        # One ASCII token with only an internal capital ("myGov", "iBAS++" in live menus) is not enough evidence.
        if len(tokens) == 1 and not strong:
            return UNKNOWN
        return BIJOY_ANSI
    if not strong_tokens and not weak_tokens:
        return ENGLISH_OK
    return UNKNOWN


def storable(s, font_hint=None):
    return classify_text(s, font_hint) in STORABLE or classify_text(s, font_hint) == EMPTY


@lru_cache(maxsize=1)
def domain_lexicon():
    words = set()
    for ln in (CONFIG / 'designations.txt').read_text(encoding='utf-8').splitlines():
        words.update(norm(ln).split())
    try:
        import csv
        with open(REPO / 's3' / 'JAANI_RTI_OFFICERS_COMPLETE.csv', encoding='utf-8', newline='') as fh:
            for r in csv.DictReader(fh):
                for c in ('Ministry', 'Division', 'Office'):
                    words.update(norm(r[c]).split())
    except FileNotFoundError:
        pass
    return frozenset(words)


def lexicon_ratio(s):
    toks = [t for t in regex.findall(r'[\p{Bengali}‌‍]+', norm(s)) if BENGALI_LETTER.search(t)]
    if not toks:
        return 1.0
    lex = domain_lexicon()
    return sum(t in lex for t in toks) / len(toks)


def grapheme_similarity(a, b):
    ga, gb = regex.findall(r'\X', norm(a)), regex.findall(r'\X', norm(b))
    if not ga and not gb:
        return 1.0
    # Levenshtein over grapheme clusters: map each distinct cluster to one private-use code point
    table = {}
    enc = lambda gs: ''.join(chr(0xF0000 + table.setdefault(g, len(table))) for g in gs)
    return Levenshtein.ratio(enc(ga), enc(gb))


HIGH_RISK = {'Officer_Name', 'Phone', 'Mobile', 'Email'}
LEXICON_FIELDS = {'Designation', 'Address'}


def validate_recovered(field, value, second_reading=None):
    """Rule 6A.4 for text that did NOT arrive as clean Unicode (converted Bijoy, OCR, vision).
    Returns (ok, reasons). A missing second reading for a high-risk field is a failure, never a pass."""
    reasons = []
    value = norm(value)
    if not value:
        return False, ['empty']
    cls = classify_text(value)
    if cls not in STORABLE:
        reasons.append(f'class_{cls}')
    bad = [w for w in bn_words(value) if word_invalid(w)]
    if bad:
        reasons.append('invalid_words:' + ' '.join(bad[:3]))
    base = field.split('_', 1)[-1] if field.startswith(('Primary_', 'Alternate_', 'Appellate_')) else field
    if base in LEXICON_FIELDS and lexicon_ratio(value) < 0.70:
        reasons.append(f'lexicon_ratio_{lexicon_ratio(value):.2f}')
    if base in HIGH_RISK or base in ('Designation',):
        if second_reading is None:
            if base in HIGH_RISK:
                reasons.append('no_second_reading')
        else:
            if base in ('Phone', 'Mobile'):
                if digits_only(value) != digits_only(second_reading):
                    reasons.append('digits_disagree')
            elif base == 'Email':
                if value.lower() != norm(second_reading).lower():
                    reasons.append('email_disagree')
            else:
                sim = grapheme_similarity(value, second_reading)
                if sim < 0.92:
                    reasons.append(f'second_reading_similarity_{sim:.2f}')
    return (not reasons), reasons


@lru_cache(maxsize=1)
def vectors():
    return json.loads(VECTORS_PATH.read_text(encoding='utf-8'))
