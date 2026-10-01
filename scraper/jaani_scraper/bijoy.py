"""Bijoy / SutonnyMJ (ANSI) -> Unicode Bengali (section 6A.3). Offline, deterministic, no LLM.

Mapping table: config/bijoy_map.json, extracted mechanically from npm bijoy2unicode@1.0.2
(github.com/JehadurRE/Bijoy2Unicode, MIT, see config/bijoy_map.LICENSE). The reordering follows that package's
rearrange() and is ported line by line; deviations are marked DEVIATION with the reason. Correctness is decided by
shared/text_integrity_vectors.json, not by this code looking right.
"""
import json
import unicodedata
from functools import lru_cache
from pathlib import Path

MAP_PATH = Path(__file__).resolve().parents[1] / 'config' / 'bijoy_map.json'
HALANT = '্'
MOVED = ''   # a reph already placed before its cluster; never moved twice
PRE_KARS = {'ি', 'ৈ', 'ে'}
POST_KARS = {'া', 'ো', 'ৌ', 'ৗ', 'ু', 'ূ', 'ী', 'ৃ'}
CONSONANTS = set('কখগঘঙচছজঝঞটঠডঢণতথদধনপফবভমযরলশষসহ') | {'ৎ', 'ং', 'ঃ', 'ঁ'}
# DEVIATION 1: the precomposed nukta letters (ড় ঢ় য়) are consonants for reordering; upstream compares them to
# two-character strings, which never match a single character, so "ি" before "য়" was never moved.
CONSONANTS |= {'ড়', 'ঢ়', 'য়'}
# DEVIATION 2: upstream post-processing rewrites "ঃ" after a space/digit/bracket to ":". The brief says not to
# "improve" punctuation, and the gazette vector "g~j¨ t UvKv" must stay "মূল্য ঃ টাকা", so those rules are dropped.
DROPPED_POST_KEYS = {k for k in ['০ঃ', '১ঃ', '২ঃ', '৩ঃ', '৪ঃ', '৫ঃ', '৬ঃ', '৭ঃ', '৮ঃ', '৯ঃ', ' ঃ', '\nঃ', ']ঃ', '[ঃ']}
DIGITS = {str(d) for d in range(10)}


@lru_cache(maxsize=1)
def tables():
    data = json.loads(MAP_PATH.read_text(encoding='utf-8'))
    conv = dict(data['conversion'])
    return (data['pre'], conv, max(len(k) for k in conv), data['pro'],
            [(k, v) for k, v in data['post'] if k not in DROPPED_POST_KEYS], data['source'])


def _apply_seq(text, pairs):
    for k, v in pairs:
        text = text.replace(k, v)
    return text


def _tokenize(text, conv, maxlen, digits_bengali):
    """Longest-match tokenisation over the table (multi-character keys first)."""
    out, i = [], 0
    while i < len(text):
        for n in range(min(maxlen, len(text) - i), 0, -1):
            piece = text[i:i + n]
            if piece in conv and (digits_bengali or piece not in DIGITS):
                out.append(conv[piece])
                i += n
                break
        else:
            out.append(text[i])
            i += 1
    return ''.join(out)


def _c(s, i):
    return s[i] if 0 <= i < len(s) else ''


def _is_kar(c):
    return c in PRE_KARS or c in POST_KARS


def _rearrange(s):
    """Port of upstream rearrange(): reph before its cluster, pre-base kars after the cluster, ে+া->ো, ে+ৗ->ৌ."""
    i = 0
    while i < len(s):                                        # pass 1: reph after a halanted cluster
        if i < len(s) - 1 and _c(s, i) == 'র' and _c(s, i + 1) == HALANT and _c(s, i - 1) == HALANT:
            j = 1
            while i - j >= 0:
                if _c(s, i - j) in CONSONANTS and _c(s, i - j - 1) == HALANT:
                    j += 2
                elif j == 1 and _is_kar(_c(s, i - j)):
                    j += 1
                else:
                    break
            s = s[:i - j] + MOVED + s[i + 1] + s[i - j:i] + s[i + 2:]
            i += 1
            continue
        i += 1
    i = 0
    while i < len(s) - 1:                                    # pass 2: reph after a single consonant
        if (_c(s, i) == 'র' and _c(s, i + 1) == HALANT and i > 0 and _c(s, i - 1) in CONSONANTS
                and _c(s, i - 2) != HALANT
                and not (_c(s, i + 2) in CONSONANTS and _c(s, i + 3) == HALANT)):
            j = 1
            while i - j - 1 >= 0:
                if _c(s, i - j - 1) in CONSONANTS and _c(s, i - j) == HALANT:
                    j += 2
                else:
                    break
            s = s[:i - j] + MOVED + s[i + 1] + s[i - j:i] + s[i + 2:]
            i += 2
            continue
        i += 1
    # DEVIATION 3: reph stored after consonant + post-base kar (Bijoy "KZ…©" = ত ৃ র্) must go before the consonant
    # cluster (র্তৃ). Upstream only handles a kar between reph and cluster when the cluster is halanted.
    i = 0
    while i < len(s) - 1:
        if (_c(s, i) == 'র' and _c(s, i + 1) == HALANT and _c(s, i - 1) in POST_KARS
                and _c(s, i - 2) in CONSONANTS and _c(s, i - 3) != HALANT
                and not (_c(s, i + 2) in CONSONANTS and _c(s, i + 3) == HALANT)):
            start = i - 2
            s = s[:start] + MOVED + HALANT + s[start:i] + s[i + 2:]
            i += 2
            continue
        i += 1
    s = s.replace(MOVED, 'র').replace(HALANT + HALANT, HALANT)
    i = 0
    while i < len(s):                                        # pass 3
        if (i < len(s) - 1 and _c(s, i) == 'র' and _c(s, i + 1) == HALANT and _c(s, i - 1) != HALANT
                and _c(s, i + 2) == HALANT):
            j = 1
            while i - j >= 0:
                if _c(s, i - j) in CONSONANTS and _c(s, i - j - 1) == HALANT:
                    j += 2
                elif j == 1 and _is_kar(_c(s, i - j)):
                    j += 1
                else:
                    break
            s = s[:i - j] + s[i] + s[i + 1] + s[i - j:i] + s[i + 2:]
            i += 1
            continue
        if i > 0 and _c(s, i) == HALANT and (_is_kar(_c(s, i - 1)) or _c(s, i - 1) == 'ঁ') and i < len(s) - 1:
            s = s[:i - 1] + s[i] + s[i + 1] + s[i - 1] + s[i + 2:]
        if (0 < i < len(s) - 1 and _c(s, i) == HALANT and _c(s, i - 1) == 'র' and _c(s, i - 2) != HALANT
                and _is_kar(_c(s, i + 1))):
            s = s[:i - 1] + s[i + 1] + s[i - 1] + s[i] + s[i + 2:]
        if i < len(s) - 1 and _c(s, i) in PRE_KARS and _c(s, i + 1) not in (' ', '\t', '\n', '\r'):
            temp = s[:i]
            j = 1
            while i + j < len(s) - 1 and _c(s, i + j) in CONSONANTS:
                if _c(s, i + j + 1) == HALANT:
                    j += 2
                else:
                    break
            temp += s[i + 1:i + j + 1]
            l = 0
            if _c(s, i) == 'ে' and _c(s, i + j + 1) == 'া':
                temp += 'ো'
                l = 1
            elif _c(s, i) == 'ে' and _c(s, i + j + 1) == 'ৗ':
                temp += 'ৌ'
                l = 1
            else:
                temp += s[i]
            temp += s[i + j + l + 1:]
            s = temp
            i += j
        if i < len(s) - 1 and _c(s, i) == 'ঁ' and _c(s, i + 1) in POST_KARS:
            s = s[:i] + s[i + 1] + s[i] + s[i + 2:]
        i += 1
    return s


def bijoy_to_unicode(text, digits_bengali=True):
    """Convert one legacy-font run. digits_bengali=False for runs whose digits are in an English font."""
    if not text:
        return text
    pre, conv, maxlen, pro, post, _ = tables()
    out = _apply_seq(text, pre)
    out = _tokenize(out, conv, maxlen, digits_bengali)
    out = _rearrange(out)
    out = _apply_seq(out, post)
    return unicodedata.normalize('NFC', out)


def mapping_source():
    return tables()[5]
