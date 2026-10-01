"""Deterministic parsing of an RTI officer page (sections 6 and 6A.6) into role blocks, fields and photo candidates.

The document is linearised once into a token stream (open / text / close) so a role block is simply a slice of it:
from a role heading to the next role or container heading, bounded by the heading's container. Role attribution is
structural only (rule R3); nothing is inferred from position on the page.
"""
import re
from dataclasses import dataclass, field
from datetime import date
from functools import lru_cache
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import lxml.html
import yaml

from . import integrity as ti
from .bijoy import bijoy_to_unicode
from .textnorm import decode_entities, digits_only, norm, squash

CONFIG = Path(__file__).resolve().parents[1] / 'config'
ROLES = ('primary', 'alternate', 'appellate')
FIELDS = ('Officer_Name', 'Designation', 'Phone', 'Mobile', 'Email', 'Address')
BLOCK_TAGS = {'p', 'div', 'tr', 'li', 'table', 'dt', 'dd', 'dl', 'section', 'article', 'ul', 'ol', 'h1', 'h2', 'h3',
              'h4', 'h5', 'h6', 'form', 'tbody', 'thead', 'blockquote', 'fieldset', 'legend', 'figure', 'figcaption',
              'caption', 'center', 'main', 'aside', 'pre', 'address'}
CELL_TAGS = {'td', 'th'}
HEADING_TAGS = {'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}
DROP_TAGS = {'script', 'style', 'noscript', 'template', 'svg', 'nav', 'header', 'footer', 'select', 'option',
             'title', 'head', 'iframe', 'button', 'input', 'textarea'}
EMAIL_RE = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}')
PHONE_TOKEN_RE = re.compile(r'(?:\+|০|0|৮|8)[০-৯0-9][০-৯0-9\s\-()./]{5,}[০-৯0-9]')
MOBILE_RE = re.compile(r'^(?:\+?88)?01[3-9]\d{8}$')
IMG_EXT_RE = re.compile(r'\.(?:jpe?g|png|webp|bmp|gif|svg)(?:\?|$)', re.I)
BG_URL_RE = re.compile(r'background(?:-image)?\s*:[^;]*url\(\s*[\'"]?([^\'")]+)', re.I)
CLOAK_RE = re.compile(r'protected from spam|email address is being protected|javascript to view', re.I)
LAST_UPDATED_RE = re.compile(r'(?:শেষ\s*হাল[-\s]?নাগাদ|সর্বশেষ\s*হাল[-\s]?নাগাদ|last\s*updated)\s*[:ঃ]?\s*'
                             r'([০-৯0-9]{1,4}[-/.][০-৯0-9]{1,2}[-/.][০-৯0-9]{1,4})', re.I)
PLACEHOLDERS = {'নাম', 'n/a', 'na', '-', '--', '—', '০০০', '000', 'null', 'none', 'nil', 'প্রযোজ্য নয়', 'নেই', '.', '...',
                # template junk left on live pages (railway.gov.bd publishes 'নাম: test  পদবি: test  ফোন: test'):
                # an officer called 'test' is worse than a blank in a dataset used to address legal notices.
                'test', 'testing', 'demo', 'sample', 'xxx', 'abc', 'asdf', 'ttt', 'পরীক্ষা'}
REJECT_IMG_RE = re.compile(r'logo|banner|placeholder|default|avatar|no[-_]?image|noimage|blank|spinner|icon|favicon|'
                           r'site-assets|technical-support|carousel|slider|flag|emblem|coat[-_]?of[-_]?arms', re.I)
REJECT_IMG_PATH_RE = re.compile(r'/assets/|/theme/|/images/logo', re.I)


@lru_cache(maxsize=1)
def aliases():
    return yaml.safe_load((CONFIG / 'role_aliases.yaml').read_text(encoding='utf-8'))


def classify_heading(text):
    """-> 'primary' | 'alternate' | 'appellate' | 'container' | 'unknown' | None"""
    a = aliases()
    t = norm(text)
    if not t or len(t) > a['max_heading_chars']:
        return None
    sq = squash(t).lower().rstrip('ঃ:')
    if any(k in sq for k in a['ignore_contains']):
        return 'container'
    if label_field(t.rstrip('ঃ:： ')) or BARE_LABEL_RE.match(t):
        return None                                   # "কর्मकर्তার নাম" is a field label, not a role heading
    seps = a.get('multi_role_separators', [])
    if any(sep in t for sep in seps):
        parts = re.split('|'.join(re.escape(x) for x in seps), t)
        kinds = {classify_heading(x) for x in parts if x.strip()} & {'primary', 'alternate', 'appellate'}
        if len(kinds) >= 2:
            return 'container'
    if all(any(k in sq for k in grp) for grp in a['appellate']['all_of_groups']):
        return 'appellate'
    if all(any(k in sq for k in grp) for grp in a['alternate']['all_of_groups']):
        return 'alternate'
    if any(k in sq for k in a['primary']['any_of']) and not any(k in sq for k in a['primary']['none_of']):
        return 'primary'
    if any(k in sq for k in a['unknown_contains']) and len(sq) <= 40:
        return 'unknown'
    return None


def label_field(label):
    """Map a label to a field (section 6.5). Order matters: 'অফিস ফোন' is a phone, not an address."""
    sq = squash(label).lower().rstrip('ঃ:')
    if not sq or len(sq) > 25:
        return None
    if 'মোবাইল' in sq or 'mobile' in sq or sq.startswith('cell'):
        return 'Mobile'
    if any(k in sq for k in ('ফোন', 'টেলিফোন', 'phone', 'telephone')) or sq in ('tel', 'tel.'):
        return 'Phone'
    if any(k in sq for k in ('ইমেইল', 'ইমেল', 'ইমেইল', 'email', 'mail')):
        return 'Email'
    if sq.startswith(('পদবি', 'designation')):
        return 'Designation'
    if sq.startswith(('নাম', 'কর্মকর্তারনাম', 'name')):
        return 'Officer_Name'
    if sq.startswith(('ঠিকানা', 'অফিস', 'কার্যালয়', 'address', 'office')):
        return 'Address'
    return None


@dataclass
class FieldResult:
    value: str = ''
    state: str = 'NOT_ON_PAGE'       # FILLED | PAGE_EMPTY | NOT_ON_PAGE | PARSE_MISS
    raw: str = ''
    recovered: str = ''              # '' | 'bijoy'
    flags: list = field(default_factory=list)
    pos: int = -1                    # token position of the value (photo proximity, review crops)


@dataclass
class ImageCandidate:
    url: str
    pos: int
    alt: str = ''
    title: str = ''
    width: int = 0
    height: int = 0
    heading: str = ''
    before: str = ''
    after: str = ''
    reject: str = ''

    @property
    def filename(self):
        return urlsplit(self.url).path.rsplit('/', 1)[-1]


@dataclass
class RoleBlock:
    role: str
    heading: str
    start: int
    end: int
    fields: dict = field(default_factory=dict)
    images: list = field(default_factory=list)
    text: str = ''
    extra_officers: int = 0
    flags: list = field(default_factory=list)
    card: bool = False

    @property
    def name(self):
        return self.fields['Officer_Name'].value if 'Officer_Name' in self.fields else ''


@dataclass
class ParsedPage:
    url: str
    template: str = ''
    roles: dict = field(default_factory=dict)
    flags: list = field(default_factory=list)
    images: list = field(default_factory=list)
    text: str = ''
    last_updated: str = ''
    signals: list = field(default_factory=list)
    recovery: list = field(default_factory=list)     # 6A log entries
    title: str = ''


# ----------------------------------------------------------------------------------------------- document prep
def _font_of(el):
    while el is not None:
        if not isinstance(el.tag, str):
            el = el.getparent()
            continue
        face = el.get('face')
        if el.tag == 'font' and face:
            return face
        m = re.search(r'font-family\s*:\s*([^;]+)', el.get('style') or '', re.I)
        if m:
            return m.group(1)
        el = el.getparent()
    return None


def _recover_text(text, font, where, log):
    """6A.2 step A/B on one text run. Returns (text, recovered_flag). Failing runs are kept but logged; any value
    taken from them later fails classify_text and is never stored."""
    t = decode_entities(text)
    if not t.strip():
        return t, ''
    cls = ti.classify_text(t, font)
    if cls in (ti.ENGLISH_OK, ti.UNICODE_OK, ti.EMPTY):
        return t, ''
    if cls == ti.BIJOY_ANSI:
        conv = bijoy_to_unicode(t, digits_bengali=True)
        ok = ti.classify_text(conv) in ti.STORABLE
        log.append(dict(where=where, cls=cls, font=font or '', method='bijoy_to_unicode', input=t[:200],
                        candidate=conv[:200], decision='converted' if ok else 'failed_after_conversion'))
        return (conv, 'bijoy') if ok else (t, '')
    log.append(dict(where=where, cls=cls, font=font or '', method='none', input=t[:200], decision='unresolved'))
    return t, ''


def load_document(html_text, base_url, log):
    root = lxml.html.document_fromstring(html_text or '<html></html>')
    root.set('data-jaani-fulltext', norm(decode_entities(root.text_content()))[:200000])
    base = root.find('.//base')
    if base is not None and base.get('href'):
        base_url = urljoin(base_url, base.get('href'))
    title_el = root.find('.//title')
    title = norm(title_el.text_content()) if title_el is not None else ''
    for el in list(root.iter()):
        if isinstance(el.tag, str) and el.tag in DROP_TAGS and el.getparent() is not None:
            el.drop_tree()
    for el in list(root.iter()):
        if not isinstance(el.tag, str):
            continue
        if el.tag == 'wbr':
            el.drop_tag()
    recovered_nodes = set()      # kept for the call signature; markers live on the elements (lxml proxies are not stable)
    for el in root.iter():
        if not isinstance(el.tag, str):
            continue
        if el.text:
            new, rec = _recover_text(el.text, _font_of(el), f'{el.tag}.text', log)
            el.text = new
            if rec:
                el.set('data-jaani-rec-text', rec)
        if el.tail:
            new, rec = _recover_text(el.tail, _font_of(el.getparent()), f'{el.tag}.tail', log)
            el.tail = new
            if rec:
                el.set('data-jaani-rec-tail', rec)
    return root, base_url, title, recovered_nodes


def tokenize(root):
    """[('open', el) | ('text', str, el, recovered) | ('close', el)] in document order."""
    toks = []

    def walk(el):
        toks.append(('open', el))
        if el.text:
            toks.append(('text', el.text, el, 'text'))
        for ch in el:
            if isinstance(ch.tag, str):
                walk(ch)
            if ch.tail:
                toks.append(('text', ch.tail, ch, 'tail'))
        toks.append(('close', el))
    body = root.find('body')
    walk(body if body is not None else root)
    return toks


def render_lines(toks, start, end, skip=()):
    """Tokens -> lines; table cells separated by TAB; each line keeps the token position of its first text."""
    lines, cur, cur_pos = [], [], None

    def flush():
        nonlocal cur, cur_pos
        t = norm(''.join(cur).replace('\t', ' \t '))
        cells = [norm(c) for c in ''.join(cur).split('\t')]
        cells = [c for c in cells if c or len(cells) > 1]
        if t:
            lines.append((cur_pos, cells))
        cur, cur_pos = [], None
    skip_ranges = list(skip)
    for i in range(start, min(end, len(toks))):
        if any(a <= i <= b for a, b in skip_ranges):
            continue
        tk = toks[i]
        if tk[0] == 'text':
            if cur_pos is None and tk[1].strip():
                cur_pos = i
            cur.append(tk[1])
        else:
            tag = tk[1].tag
            if tag == 'br':
                if tk[0] == 'open':
                    flush()
            elif tag in CELL_TAGS and tk[0] == 'close':
                cur.append('\t')
            elif tag in BLOCK_TAGS:
                flush()
    flush()
    return lines


# ----------------------------------------------------------------------------------------------- structure
def _full_text(el):
    return norm(decode_entities(el.text_content()))


def _in_link(el):
    while el is not None:
        if el.tag == 'a' and (el.get('href') or '').strip() not in ('', '#'):
            return True
        el = el.getparent()
    return False


def find_headings(root):
    """Smallest element whose own full text is a role heading (6.3)."""
    found = []
    for el in root.iter():
        if not isinstance(el.tag, str) or el.tag in ('body', 'html', 'table', 'tbody', 'thead', 'tr', 'ul', 'ol'):
            continue
        txt = _full_text(el)
        kind = classify_heading(txt)
        if kind is None:
            continue
        if any(isinstance(ch.tag, str) and classify_heading(_full_text(ch)) == kind
               for ch in el.iter() if ch is not el):
            continue                           # a smaller element is the heading (an empty card's wrapper is not)
        if _in_link(el):
            continue
        if kind == 'unknown' and el.tag not in HEADING_TAGS | {'strong', 'b', 'legend'}:
            continue
        found.append((el, kind, txt))
    return found


def _has_extra_content(el, heading_text):
    return _full_text(el) != heading_text or el.find('.//img') is not None


def _container(el, heading_text):
    c = el.getparent()
    while c is not None and c.tag not in ('body', 'html') and not _has_extra_content(c, heading_text):
        c = c.getparent()
    return c if c is not None else el.getparent()


def _collect_images(toks, base_url, headings_pos):
    imgs = []
    heading_at = sorted(headings_pos)
    text_positions = [(i, t[1]) for i, t in enumerate(toks) if t[0] == 'text' and t[1].strip()]

    def context(pos, before=True):
        if before:
            parts = [t for i, t in text_positions if i < pos][-6:]
            return norm(' '.join(parts))[-80:]
        parts = [t for i, t in text_positions if i > pos][:6]
        return norm(' '.join(parts))[:80]

    for i, tk in enumerate(toks):
        if tk[0] != 'open':
            continue
        el = tk[1]
        urls = []
        if el.tag in ('img', 'source'):
            for attr in ('data-src', 'data-lazy-src', 'data-original', 'src'):
                v = (el.get(attr) or '').strip()
                if v and not v.startswith('data:'):
                    urls.append(v)
                    break
            srcset = el.get('srcset') or el.get('data-srcset')
            if srcset:
                best = max(((p.strip().split()[0], float((p.strip().split() + ['1w'])[1][:-1] or 1))
                            for p in srcset.split(',') if p.strip()), key=lambda x: x[1], default=None)
                if best and not urls:
                    urls.append(best[0])
        m = BG_URL_RE.search(el.get('style') or '')
        if m:
            urls.append(m.group(1))
        if el.tag == 'a' and IMG_EXT_RE.search(el.get('href') or ''):
            urls.append(el.get('href'))
        for u in urls:
            absu = urljoin(base_url, u.strip())
            h = [txt for p, txt in heading_at if p < i]
            try:
                w, hgt = int(el.get('width') or 0), int(el.get('height') or 0)
            except ValueError:
                w = hgt = 0
            cand = ImageCandidate(url=absu, pos=i, alt=norm(el.get('alt') or ''), title=norm(el.get('title') or ''),
                                  width=w, height=hgt, heading=h[-1] if h else '', before=context(i, True),
                                  after=context(i, False))
            cand.reject = reject_reason(cand)
            imgs.append(cand)
    return imgs


def reject_reason(c):
    hay = ' '.join([c.url, c.alt, c.title])
    path = urlsplit(c.url).path.lower()
    if REJECT_IMG_PATH_RE.search(path):
        return 'rejected_path'
    if REJECT_IMG_RE.search(hay):
        return 'rejected_type'
    if path.endswith(('.svg', '.gif')):
        return 'rejected_format'
    if c.width and c.height and (c.width < 80 or c.height < 80):
        return 'rejected_small'
    if not urlsplit(c.url).scheme.startswith('http'):
        return 'not_absolute'
    return ''


# ----------------------------------------------------------------------------------------------- fields
def _clean_value(v):
    v = norm(v).lstrip(':ঃ：').strip()
    return norm(v)


def _extract_email(value, cell_el_hrefs=()):
    v = re.sub(r'\s*[\[(]\s*(?:at|@)\s*[\])]\s*', '@', value, flags=re.I)
    v = re.sub(r'\s*[\[(]\s*dot\s*[\])]\s*', '.', v, flags=re.I)
    found = EMAIL_RE.findall(v)
    return found


BARE_LABEL_RE = re.compile(r'^(কর্মকর্তার নাম|পদবি|পদবী|টেলিফোন|ফোন|মোবাইল|ই-মেইল|ইমেইল|ঠিকানা)\s+(\S.*)$')
INLINE_LABEL_RE = re.compile(r'(?:(?<=\s)|^)(কর্মকর্তার নাম|নাম|পদবি|পদবী|টেলিফোন|ফোন|মোবাইল|ই-মেইল|ইমেইল|ইমেল|ঠিকানা|'
                             r'Name|Designation|Phone|Mobile|E-?mail|Address)\s*(?:\([^)]{1,12}\))?\s*[:ঃ：]', re.I)


def split_inline_labels(lines):
    """'ফোনঃ (অফিস) ০২-… মোবাইলঃ ০১৭… ই-মেইলঃ …' on one line -> one line per label (seen on live pages)."""
    out = []
    for pos, cells in lines:
        if len(cells) == 1:
            text = cells[0]
            starts = [m.start() for m in INLINE_LABEL_RE.finditer(text)]
            if len(starts) >= 2:
                if starts[0] > 0:
                    out.append((pos, [text[:starts[0]].strip()]))
                for a, b in zip(starts, starts[1:] + [len(text)]):
                    out.append((pos, [text[a:b].strip()]))
                continue
        out.append((pos, cells))
    return out


def extract_fields(lines, header_map=None):
    """Label/value extraction from rendered lines. Returns (fields, name_count)."""
    out = {f: FieldResult() for f in FIELDS}
    if not header_map:
        lines = split_inline_labels(lines)
    seen_labels = set()
    name_count = 0
    i = 0
    while i < len(lines):
        pos, cells = lines[i]
        label = value = None
        if header_map:
            for idx, cell in enumerate(cells):
                f = header_map.get(idx)
                if f and f not in seen_labels:
                    seen_labels.add(f)
                    _set(out[f], f, cell)
                    out[f].pos = pos
            i += 1
            continue
        bare = BARE_LABEL_RE.match(' '.join(cells)) if len(cells) == 1 else None
        if len(cells) >= 2 and label_field(cells[0]):
            label, value = cells[0], ' '.join(c for c in cells[1:] if c)
            if not value and i + 1 < len(lines):          # label cell, value on the next row (reb.gov.bd)
                nxt = ' '.join(c for c in lines[i + 1][1] if c)
                if nxt and not label_field(lines[i + 1][1][0]) and not classify_heading(nxt) and \
                        not re.match(r'^([^:ঃ：]{1,30}?)\s*[:ঃ：]', nxt):
                    value = nxt
                    i += 1
        elif bare and not re.match(r'^[^:ঃ：]{1,30}?\s*[:ঃ：]', cells[0]):
            label, value = bare.group(1), bare.group(2)      # "পদবি উপ-পরিচালক" (no colon; live static pages)
        else:
            text = ' '.join(cells)
            m = re.match(r'^([^:ঃ：]{1,30}?)\s*[:ঃ：]\s*(.*)$', text)
            if m and label_field(m.group(1)):
                label, value = m.group(1), m.group(2)
                if not value and i + 1 < len(lines):
                    nxt = ' '.join(lines[i + 1][1])
                    nm = re.match(r'^([^:ঃ：]{1,30}?)\s*[:ঃ：]', nxt)
                    if not (nm and label_field(nm.group(1))) and not label_field(nxt) and not classify_heading(nxt):
                        value = nxt
                        i += 1
            elif label_field(text) and i + 1 < len(lines):
                nxt = ' '.join(lines[i + 1][1])
                if not label_field(nxt) and not classify_heading(nxt) and \
                        not re.match(r'^([^:ঃ：]{1,30}?)\s*[:ঃ：]', nxt):
                    label, value = text, nxt
                    i += 1
                else:
                    label, value = text, ''
        if label:
            f = label_field(label)
            if f == 'Officer_Name':
                name_count += 1
                if name_count > 1:
                    i += 1
                    continue
            if f in seen_labels:
                i += 1
                continue
            seen_labels.add(f)
            _set(out[f], f, value or '')
            out[f].pos = pos
            if 'পদবি' in squash(label) and f == 'Officer_Name':
                out[f].flags.append('combined_name_designation_label')
        i += 1
    return out, name_count


def _set(fr, f, value):
    v = _clean_value(value)
    fr.raw = value
    if not v or v.lower() in PLACEHOLDERS:
        fr.state = 'PAGE_EMPTY'
        if v:
            fr.flags.append('placeholder_value')
        return
    if f == 'Email':
        if CLOAK_RE.search(v):
            fr.state = 'PAGE_EMPTY'
            fr.flags.append('email_cloaked')
            return
        emails = _extract_email(v)
        if not emails:
            fr.state = 'PARSE_MISS'
            fr.flags.append('unparsed_email')
            return
        if len(emails) > 1:
            fr.flags.append('email_multiple')
        fr.value = emails[0]
    else:
        fr.value = v
    fr.state = 'FILLED'


def _header_map_for_row(tr):
    table = tr
    while table is not None and table.tag != 'table':
        table = table.getparent()
    if table is None:
        return None
    rows = table.findall('.//tr')
    if not rows:
        return None
    head = rows[0]
    if head is tr:
        return None
    cells = [c for c in head if isinstance(c.tag, str) and c.tag in CELL_TAGS]
    mapping = {}
    for idx, c in enumerate(cells):
        f = label_field(_full_text(c))
        if f:
            mapping[idx] = f
    return mapping if len(mapping) >= 2 else None


def _col_kind(text):
    """Header cell of a role-per-row table (template D2) -> 'name_desig' | 'contacts' | field | None."""
    t = norm(text)
    if re.search(r'নাম', t) and re.search(r'পদব[িী]|designation', t, re.I):
        return 'name_desig'
    kinds = sum(bool(re.search(p, t, re.I)) for p in (r'ফোন|phone|টেলিফোন', r'মোবাইল|mobile', r'ই-?\s?মেইল|e-?mail',
                                                         r'ফ্যাক্স|fax'))
    if kinds >= 2:
        return 'contacts'
    if re.search(r'ঠিকানা|address', t, re.I) and not re.search(r'ই-?\s?মেইল|e-?mail', t, re.I):
        return 'Address'
    return label_field(t)


MOBILE_DIGITS_RE = re.compile(r'^(?:88)?01[3-9]\d{8}$')
SYNTH_LABEL = {'Officer_Name': 'নাম', 'Designation': 'পদবি', 'Phone': 'ফোন', 'Mobile': 'মোবাইল', 'Email': 'ই-মেইল',
               'Address': 'ঠিকানা'}


def _row_table_lines(tr, heading_el, toks, pos_open, pos_close):
    """Template D2 (live: sbc.gov.bd, bcic.gov.bd): one table row per role, the role name in a cell and the
    officer in the cells after it. Data cells after the role cell are aligned to the LAST header cells (a rowspan
    container cell may precede the role cell). -> synthetic label lines for extract_fields, or None."""
    table = tr.getparent()
    while table is not None and table.tag != 'table':
        table = table.getparent()
    if table is None:
        return None
    rows = table.findall('.//tr')
    if not rows or rows[0] is tr:
        return None
    hcells = [c for c in rows[0] if isinstance(c.tag, str) and c.tag in CELL_TAGS]
    dcells = [c for c in tr if isinstance(c.tag, str) and c.tag in CELL_TAGS]
    ri = next((i for i, c in enumerate(dcells) if c is heading_el or heading_el in c.iterancestors()
               or c in heading_el.iterancestors() or any(x is heading_el for x in c.iter())), None)
    if ri is None:
        return None
    after = dcells[ri + 1:]
    if not after or len(after) > len(hcells):
        return None
    kinds = [_col_kind(_full_text(h)) for h in hcells[-len(after):]]
    if not ({'name_desig', 'Officer_Name'} & set(kinds)):
        return None
    out = []
    for cell, kind in zip(after, kinds):
        pos = pos_open[id(cell)]
        cl = [' '.join(x for x in c if x) for _, c in render_lines(toks, pos + 1, pos_close[id(cell)])]
        cl = [x for x in cl if x]
        if not cl or not kind:
            continue
        if kind == 'name_desig':
            from .validate import validate
            if len(cl) == 1 and not validate('Officer_Name', cl[0])[0]:
                out.append((pos, [SYNTH_LABEL['Designation'], cl[0]]))      # "ব্যবস্থাপনা পরিচালক" only
                continue
            out.append((pos, [SYNTH_LABEL['Officer_Name'], cl[0]]))
            if len(cl) > 1:
                out.append((pos, [SYNTH_LABEL['Designation'], cl[1]]))
        elif kind in ('contacts', 'Phone', 'Mobile', 'Email'):
            for ln in split_inline_labels([(pos, [x]) for x in cl]):
                text = ln[1][0]
                if re.match(r'^[^:ঃ：]{1,30}?\s*[:ঃ：]', text):
                    out.append(ln)                                          # labelled ("ফোন: ...")
                elif '@' in text:
                    out.append((pos, [SYNTH_LABEL['Email'], text]))
                elif len(digits_only(text)) >= 6:
                    f = 'Mobile' if MOBILE_DIGITS_RE.match(digits_only(text)) else 'Phone'
                    out.append((pos, [SYNTH_LABEL[f], text]))
        elif kind == 'Address':
            out.append((pos, [SYNTH_LABEL['Address'], re.sub(r',\s*,', ',', ', '.join(x.rstrip() for x in cl))]))
        elif kind in SYNTH_LABEL:
            out.append((pos, [SYNTH_LABEL[kind], ' '.join(cl)]))
    return out or None


# ----------------------------------------------------------------------------------------------- page
def parse_page(html_text, url, today=None):
    today = today or date.today()
    page = ParsedPage(url=url)
    root, base_url, page.title, recovered_nodes = load_document(html_text, url, page.recovery)
    if any(r['decision'] == 'converted' for r in page.recovery):
        page.flags.append('legacy_font_page')
    if any(r['decision'] != 'converted' for r in page.recovery):
        page.flags.append('integrity_unresolved_text')
    toks = tokenize(root)
    pos_open = {}
    pos_close = {}
    for i, tk in enumerate(toks):
        if tk[0] == 'open':
            pos_open[id(tk[1])] = i
        elif tk[0] == 'close':
            pos_close[id(tk[1])] = i
    all_lines = render_lines(toks, 0, len(toks))
    page.text = '\n'.join(' '.join(c) for _, c in all_lines)
    page.last_updated, d = find_last_updated(root.get('data-jaani-fulltext') or page.text)
    if d and (today - d).days > 365:
        page.flags.append('stale_12m')

    heads = find_headings(root)
    boundaries = sorted(pos_open[id(el)] for el, kind, _ in heads if kind in ROLES + ('container',))
    for el, kind, txt in heads:
        if kind == 'unknown':
            page.flags.append(f'unknown_role_heading:{txt[:40]}')
    headings_pos = [(pos_open[id(el)], txt) for el, kind, txt in heads if kind in ROLES]
    page.images = _collect_images(toks, base_url, headings_pos)

    candidates = {r: [] for r in ROLES}
    for el, kind, txt in heads:
        if kind not in ROLES:
            continue
        h_open, h_close = pos_open[id(el)], pos_close[id(el)]
        c = _container(el, txt)
        c_open, c_close = pos_open.get(id(c), 0), pos_close.get(id(c), len(toks) - 1)
        role_heads_in_c = [b for b, _ in headings_pos if c_open < b < c_close]   # containers don't split a card
        before = render_lines(toks, c_open + 1, h_open)
        before_text = ' '.join(' '.join(cl) for _, cl in before)
        heading_before = any(toks[i][0] == 'open' and toks[i][1].tag in HEADING_TAGS for i in range(c_open + 1, h_open))
        card = len(role_heads_in_c) == 1 and len(before_text) < 200 and not heading_before
        start = c_open + 1 if card else h_close + 1
        nxt = [b for b in boundaries if b > h_open]
        end = min([c_close] + [b for b in nxt if b < c_close])
        block = RoleBlock(role=kind, heading=txt, start=start, end=end, card=card)
        lines = render_lines(toks, start, end, skip=[(h_open, h_close)])
        row_lines = _row_table_lines(c, el, toks, pos_open, pos_close) if c is not None and c.tag == 'tr' and card \
            else None
        header_map = _header_map_for_row(c) if c is not None and c.tag == 'tr' and card and not row_lines else None
        if row_lines:
            lines = row_lines
            block.flags.append('template_d2_row_table')
        elif header_map:
            lines = [(p, cl) for p, cl in lines]
            row_cells = [norm(_full_text(x)) for x in c if isinstance(x.tag, str) and x.tag in CELL_TAGS]
            lines = [(h_open, row_cells)]
        block.fields, names = extract_fields(lines, header_map)
        if names > 1:
            block.extra_officers = names - 1
            block.flags.append('multi_officer_role')
        block.text = '\n'.join(' '.join(cl) for _, cl in lines)
        block.images = [im for im in page.images if start <= im.pos < end and not (h_open <= im.pos <= h_close)]
        _mark_recovered(block, toks, start, end, recovered_nodes)
        _anti_loss(block)
        candidates[kind].append(block)

    for role, blocks in candidates.items():
        if not blocks:
            continue
        from .validate import validate
        with_name = [b for b in blocks if b.name and validate('Officer_Name', b.name)[0]] or \
            [b for b in blocks if b.name]
        with_name.sort(key=lambda b: not b.card)       # a table-row / card block beats a page-title heading
        chosen = (with_name or sorted(blocks, key=lambda b: not b.card))[0]
        if len(with_name) > 1:
            chosen.flags.append('duplicate_role_heading')
        page.roles[role] = chosen

    if not page.roles:
        _text_mode(page, all_lines)
    page.template = _template(page, root)
    for b in page.roles.values():
        page.signals.extend((b.role, s) for s in b.flags if s.startswith('unextracted_signal'))
    return page


def _mark_recovered(block, toks, start, end, recovered_nodes):
    """A field whose text came from a converted (Bijoy) node carries recovered='bijoy' (6A.4 applies)."""
    rec_texts = []
    for i in range(start, min(end, len(toks))):
        tk = toks[i]
        if tk[0] == 'text' and tk[2].get(f'data-jaani-rec-{tk[3]}'):
            rec_texts.append(norm(tk[1]))
    if not rec_texts:
        return
    for fr in block.fields.values():
        if fr.value and any(fr.value in t or t in fr.value for t in rec_texts if t):
            fr.recovered = 'bijoy'


def _anti_loss(block):
    """6.8: signals on the page that we did not capture."""
    text = block.text
    emails = set(EMAIL_RE.findall(text))
    got = block.fields['Email'].value
    for e in emails:
        if e != got:
            block.flags.append(f'unextracted_signal:email:{e}')
    phones = {digits_only(p) for p in PHONE_TOKEN_RE.findall(text)}
    have = {digits_only(block.fields['Phone'].value), digits_only(block.fields['Mobile'].value)}
    for p in phones:
        if len(p) >= 7 and not any(p in h or h in p for h in have if h):
            block.flags.append(f'unextracted_signal:phone:{p}')
    for f, fr in block.fields.items():
        if fr.state == 'NOT_ON_PAGE':
            if f == 'Email' and emails and not got:
                fr.state = 'PARSE_MISS'
            if f in ('Phone', 'Mobile') and phones and not any(have):
                fr.state = 'PARSE_MISS'


def _text_mode(page, lines):
    """Template C: free text. Role keyword lines start blocks; only labelled lines and unambiguous patterns count."""
    a = aliases()
    txt_sq = squash(page.text).lower()
    blocks, cur = [], None
    for pos, cells in lines:
        text = ' '.join(cells)
        head = text.split(':')[0].split('ঃ')[0]
        kind = classify_heading(head)
        if kind in ROLES:
            cur = RoleBlock(role=kind, heading=head, start=pos, end=pos, card=False)
            blocks.append((cur, []))
            rest = text[len(head):].lstrip(':ঃ ').strip()
            if rest:
                blocks[-1][1].append((pos, [rest]))
            continue
        if kind == 'container':
            cur = None
            continue
        if cur is not None:
            blocks[-1][1].append((pos, cells))
    for block, blines in blocks:
        block.fields, names = extract_fields(blines)
        block.text = '\n'.join(' '.join(c) for _, c in blines)
        emails = EMAIL_RE.findall(block.text)
        if not block.fields['Email'].value and len(set(emails)) == 1:
            block.fields['Email'] = FieldResult(value=emails[0], state='FILLED', raw=emails[0], flags=['from_pattern'])
        if block.role not in page.roles and block.name:
            page.roles[block.role] = block
    has_signals = bool(EMAIL_RE.search(page.text) or PHONE_TOKEN_RE.search(page.text))
    if not page.roles:
        if any(k in txt_sq for k in a['focal_point']):
            page.flags.append('focal_point_only')
        elif has_signals and any(k in txt_sq for k in ('কর্মকর্তা', 'officer')):
            page.flags.append('static_page_unparsed')
    elif any(not b.name for b in page.roles.values()):
        page.flags.append('static_page_unparsed')


def _template(page, root):
    if not page.roles:
        return 'C' if 'static_page_unparsed' in page.flags or 'focal_point_only' in page.flags else 'none'
    blocks = list(page.roles.values())
    if all(b.card for b in blocks):
        if root.find('.//*[@class]') is not None and any('info-officer' in (e.get('class') or '')
                                                        for e in root.iter() if isinstance(e.tag, str)):
            return 'A'
        return 'E'
    if any(b.heading and b.start == b.end for b in blocks):
        return 'C'
    return 'B'


BN_MONTHS = {'জানুয়ারি': 1, 'জানুয়ারী': 1, 'ফেব্রুয়ারি': 2, 'ফেব্রুয়ারী': 2, 'মার্চ': 3, 'এপ্রিল': 4, 'মে': 5,
             'জুন': 6, 'জুলাই': 7, 'আগস্ট': 8, 'অগাস্ট': 8, 'সেপ্টেম্বর': 9, 'অক্টোবর': 10, 'নভেম্বর': 11,
             'ডিসেম্বর': 12, 'january': 1, 'february': 2, 'march': 3, 'april': 4, 'may': 5, 'june': 6, 'july': 7,
             'august': 8, 'september': 9, 'october': 10, 'november': 11, 'december': 12}
LAST_UPDATED_LABEL_RE = re.compile(r'(?:শেষ\s*হাল[-\s]?নাগাদ|সর্বশেষ\s*হাল[-\s]?নাগাদ|last\s*updated)[^:ঃ]{0,20}[:ঃ]?\s*(.{0,60})',
                                   re.I)


def find_last_updated(text):
    """'কনটেন্টটি শেষ হাল-নাগাদ করা হয়েছে: সোমবার, ২৮ সেপ্টেম্বর, ২০২৬ এ ১৫:৩৯:৩৪' (live portal wording) or a
    numeric date. Returns (raw text, date or None)."""
    m = LAST_UPDATED_LABEL_RE.search(text or '')
    if not m:
        return '', None
    raw = norm(m.group(1))
    num = re.search(r'[০-৯0-9]{1,4}[-/.][০-৯0-9]{1,2}[-/.][০-৯0-9]{1,4}', raw)
    if num:
        return raw, _parse_date(num.group(0))
    asc = raw.translate(str.maketrans('০১২৩৪৫৬৭৮৯', '0123456789'))
    for name, month in BN_MONTHS.items():
        mm = re.search(r'(\d{1,2})\s*' + re.escape(name) + r',?\s*(\d{4})', asc, re.I)
        if mm:
            try:
                return raw, date(int(mm.group(2)), month, int(mm.group(1)))
            except ValueError:
                return raw, None
    return raw, None


def _parse_date(s):
    s = s.translate(str.maketrans('০১২৩৪৫৬৭৮৯', '0123456789'))
    parts = re.split(r'[-/.]', s)
    try:
        if len(parts[0]) == 4:
            y, m, d = map(int, parts)
        else:
            d, m, y = map(int, parts)
        if y < 100:
            y += 2000
        return date(y, m, d)
    except (ValueError, IndexError):
        return None
