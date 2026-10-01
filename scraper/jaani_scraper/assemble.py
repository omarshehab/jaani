"""From sources to CSV values (sections 5, 6A.4, 7, 8, 10): validation, the integrity gate, precedence,
person matching and photo gating. Pure logic, no network: fetching and photo verification are injected."""
import re
from dataclasses import dataclass, field

from . import integrity as ti
from . import photos
from .parse import ROLES
from .textnorm import digits_only, norm, squash
from .validate import validate

PRECEDENCE = {'human_confirmed': 0, 'live': 1, 'subpage': 2, 'file': 3, 'human_saved': 4, 'infocom': 5,
              'archive': 6, 'crosscheck': 7}
BLANK_ONLY = {'infocom', 'archive'}
CROSSCHECK_ONLY = {'crosscheck'}
TEXT_FIELDS = ('Officer_Name', 'Designation', 'Phone', 'Mobile', 'Email', 'Address')
COL_ROLE = {'primary': 'Primary', 'alternate': 'Alternate', 'appellate': 'Appellate'}


def col(role, f):
    return f'{COL_ROLE[role]}_{f}'


@dataclass
class Source:
    kind: str                      # key of PRECEDENCE
    url: str
    page: object = None            # parse.ParsedPage (HTML/imported pages)
    values: dict = None            # {(role, field): value} for sources that are not pages (overrides, exports)
    method: str = 'deterministic'  # deterministic | llm | ocr | human
    meta: dict = field(default_factory=dict)   # snapshot_date, page_no, bbox per field, ...
    blanks: set = field(default_factory=set)   # {(role, field)} the owner explicitly confirmed to CLEAR (S0
                                                # <BLANK> override only). Never populated any other way; applied
                                                # directly in pipeline.apply_sources, never through decide()'s
                                                # candidate pipeline, which assumes every value is non-empty.


@dataclass
class Cand:
    role: str
    field: str
    value: str
    source: Source
    recovered: str = ''
    flags: list = field(default_factory=list)
    where: dict = field(default_factory=dict)


@dataclass
class Decision:
    values: dict = field(default_factory=dict)         # column -> value (to merge; empty never overwrites)
    provenance: dict = field(default_factory=dict)     # column -> {source, url, method, recovered, flags}
    review: list = field(default_factory=list)         # dicts: role, field, value, flag, url
    discrepancies: list = field(default_factory=list)
    flags: list = field(default_factory=list)
    metrics: dict = field(default_factory=dict)
    status: str = ''
    rti_url: str = ''


def person_key(name):
    emp = re.search(r'\(([০-৯0-9]{3,})\)', name or '')
    base = squash(re.sub(r'\([^)]*\)', '', name or '')).replace('মোঃ', 'মো').replace('মো:', 'মো').lower()
    return base, digits_only(emp.group(1)) if emp else ''


def same_person(a, b):
    (na, ea), (nb, eb) = person_key(a), person_key(b)
    return bool((ea and ea == eb) or (na and na == nb))


def candidates_from_page(src):
    out = []
    for role, block in (src.page.roles or {}).items():
        for f in TEXT_FIELDS:
            fr = block.fields.get(f)
            if fr and fr.state == 'FILLED' and fr.value:
                out.append(Cand(role, f, fr.value, src, recovered=fr.recovered, flags=list(fr.flags),
                                where=dict(src.meta.get('where', {}).get((role, f), {}))))
    return out


def candidates_from_values(src):
    return [Cand(role, f, v, src, recovered=src.meta.get('recovered', {}).get((role, f), ''),
                 where=dict(src.meta.get('where', {}).get((role, f), {})))
            for (role, f), v in (src.values or {}).items() if norm(v) and f != 'Image_URL']


def _values_photo(role, person_sources, policy_check):
    """A photo URL carried by a values-source (browser snippet JSON, human override) for the same person."""
    for src in person_sources:
        url = norm((src.values or {}).get((role, 'Image_URL'), ''))
        if not url:
            continue
        try:
            policy_check(url)
        except Exception as e:
            return None, [f'photo_refused:{e}']
        return (url, src), []
    return None, []


def decide(row, sources, host='', second_reader=None, verify_photo=None, log=None):
    """row: current CSV row dict. second_reader(cand) -> text or None (OCR/vision of the crop).
    verify_photo(url) -> (ok, flags). Returns Decision."""
    log = log or (lambda **kw: None)
    d = Decision()
    accepted = {}          # (role, field) -> list[Cand] that passed every gate
    role_names = {}        # role -> list[(Cand)] accepted names

    for src in sorted(sources, key=lambda s: PRECEDENCE[s.kind]):
        cands = candidates_from_page(src) if src.page is not None else candidates_from_values(src)
        for c in cands:
            ok, flags = _gate(c, host, second_reader, d, log)
            c.flags += flags
            if not ok:
                continue
            accepted.setdefault((c.role, c.field), []).append(c)
            if c.field == 'Officer_Name':
                role_names.setdefault(c.role, []).append(c)

    photo_by_source = {}
    for src in sources:
        if src.page is not None and src.kind not in CROSSCHECK_ONLY:
            named = {r for r, names in role_names.items() if any(n.source is src for n in names)}
            photo_by_source[id(src)] = photos.assign(src.page, named)

    for role in ROLES:
        names = [n for n in role_names.get(role, []) if n.source.kind not in CROSSCHECK_ONLY]
        if not names:
            for decs in photo_by_source.values():
                if role in decs:
                    d.flags.extend(f'{role}:{fl}' for fl in decs[role].flags)
            for f in TEXT_FIELDS[1:]:
                for c in accepted.get((role, f), []):
                    d.review.append(_rev(c, 'role_without_name'))
            continue
        top = names[0]
        person_sources = [top.source]
        for n in names[1:]:
            if same_person(n.value, top.value):
                person_sources.append(n.source)
            else:
                d.discrepancies.append(_disc(role, 'Officer_Name', top, n))
                d.review.append(_rev(n, 'name_conflict'))
        for f in TEXT_FIELDS:
            cs = [c for c in accepted.get((role, f), []) if c.source in person_sources or c.source.kind in CROSSCHECK_ONLY]
            writers = [c for c in cs if c.source.kind not in CROSSCHECK_ONLY]
            if not writers:
                continue
            best = writers[0]
            for other in (c for c in cs if c is not best):
                if _norm_cmp(f, other.value) != _norm_cmp(f, best.value):
                    d.discrepancies.append(_disc(role, f, best, other))
                    d.review.append(_rev(other, 'source_conflict'))
            if best.source.kind in BLANK_ONLY and norm(row.get(col(role, f), '')):
                continue
            d.values[col(role, f)] = best.value
            d.provenance[col(role, f)] = dict(source=best.source.kind, url=best.source.url,
                                              method=best.source.method, recovered=best.recovered,
                                              flags=best.flags, snapshot=best.source.meta.get('snapshot_date', ''))
        pd = None
        for src in person_sources:
            dec = photo_by_source.get(id(src), {}).get(role)
            if dec is None:
                continue
            if dec.flags:
                d.flags.extend(f'{role}:{fl}' for fl in dec.flags)
            if dec.url:
                pd = (dec, src)
                break
        if not pd:
            from .netguard import Policy
            hit, pflags = _values_photo(role, person_sources, lambda u: Policy().check_url(u, kind='image'))
            d.flags.extend(f'{role}:{fl}' for fl in pflags)
            if hit:
                from .photos import PhotoDecision
                pd = (PhotoDecision(url=hit[0], flags=['photo_from_' + hit[1].kind]), hit[1])
        if pd:
            dec, src = pd
            url = dec.url
            ok, vflags = verify_photo(url) if verify_photo else (True, [])
            if not ok and src.kind == 'archive':
                vflags = vflags + ['photo_only_in_archive']
            d.flags.extend(f'{role}:{fl}' for fl in vflags)
            if ok and not (src.kind in BLANK_ONLY and norm(row.get(col(role, 'Image_URL'), ''))):
                d.values[col(role, 'Image_URL')] = url
                d.provenance[col(role, 'Image_URL')] = dict(source=src.kind, url=src.url, method='structural',
                                                            flags=dec.flags + vflags)

    p, ap = d.values.get(col('primary', 'Officer_Name')), d.values.get(col('appellate', 'Officer_Name'))
    if p and ap and same_person(p, ap):
        d.flags.append('same_person_two_roles')
    _metrics(d, sources)
    return d


def _gate(c, host, second_reader, d, log):
    """Validation + integrity gate for one candidate. Returns (ok, flags)."""
    ok, flags = validate(c.field, c.value, host=host)
    if not ok:
        d.review.append(_rev(c, ','.join(flags)))
        log(event='field_refused', role=c.role, field=c.field, value=c.value[:120], source=c.source.kind, flags=flags)
        return False, flags
    needs_recovery_check = c.recovered or c.source.method in ('ocr', 'vision')
    if needs_recovery_check:
        second = second_reader(c) if second_reader else None
        rok, reasons = ti.validate_recovered(c.field, c.value, second_reading=second)
        log(event='recovered_value', role=c.role, field=c.field, value=c.value[:120], method=c.recovered or c.source.method,
            second_reading=(second or '')[:120], decision='accepted' if rok else 'refused', reasons=reasons)
        if not rok:
            d.review.append(_rev(c, 'recovery_unconfirmed:' + ';'.join(reasons)))
            return False, flags + ['recovery_unconfirmed']
        flags = flags + [f'recovered_{c.recovered or c.source.method}']
    if c.source.method == 'llm':
        flags = flags + ['llm_extracted']
    return True, flags


def _norm_cmp(f, v):
    if f in ('Phone', 'Mobile'):
        return digits_only(v)
    if f == 'Email':
        return norm(v).lower()
    if f == 'Officer_Name':
        return person_key(v)
    return squash(v)


def _rev(c, flag):
    return dict(role=c.role, field=c.field, value=c.value, flag=flag, url=c.source.url, source=c.source.kind,
                method=c.source.method, where=c.where)


def _disc(role, f, kept, other):
    return dict(role=role, field=f, kept=kept.value, kept_source=kept.source.kind, other=other.value,
                other_source=other.source.kind, other_url=other.source.url)


def _metrics(d, sources):
    roles_found = sum(1 for r in ROLES if d.values.get(col(r, 'Officer_Name')))
    filled = sum(1 for k in d.values if not k.endswith('Website_Link'))
    parse_miss = page_empty = expected = not_on_page = 0
    heads = False
    for s in sources:
        if s.page is None:
            continue
        heads = heads or bool(s.page.roles)
        for b in s.page.roles.values():
            for fr in b.fields.values():
                parse_miss += fr.state == 'PARSE_MISS'
                page_empty += fr.state == 'PAGE_EMPTY'
                expected += fr.state == 'FILLED'
                not_on_page += fr.state == 'NOT_ON_PAGE'
    d.metrics = dict(roles_found=roles_found, fields_filled=filled, fields_expected=expected,
                     parse_miss_count=parse_miss, page_empty_count=page_empty)
    # complete: all three roles named and the page printed every field (one blank allowed: appellate mobile is
    # commonly left empty by the portals themselves)
    if roles_found == 3 and parse_miss == 0 and not_on_page == 0 and page_empty <= 1:
        d.status = 'complete'
    elif roles_found and filled >= 9:
        d.status = 'partial'
    elif roles_found:
        d.status = 'sparse'
    elif heads:
        d.status = 'page_blank'
    else:
        d.status = 'no_rti_page'
