"""Role-gated photo assignment (section 8, rule R3).

A photo is assigned to a role only when the role has a stored officer name AND the image lies inside that role's
block. There is no fallback to "the next image", "the first image" or another role's image, ever.
"""
import hashlib
import re
from dataclasses import dataclass, field

from .textnorm import digits_only, norm, squash

ROLE_WORDS = {'primary': ('primary', 'designated', 'দায়িত্বপ্রাপ্ত'),
              'alternate': ('alternate', 'alternative', 'বিকল্প'),
              'appellate': ('appellate', 'আপীল', 'আপিল')}


@dataclass
class PhotoDecision:
    url: str = ''
    flags: list = field(default_factory=list)
    candidates: list = field(default_factory=list)


def _usable(c):
    return not c.reject


def assign(page, named_roles):
    """named_roles: roles whose Officer_Name will be stored. Returns {role: PhotoDecision}."""
    out = {r: PhotoDecision() for r in page.roles}
    in_blocks = set()
    for role, block in page.roles.items():
        imgs = [c for c in block.images if _usable(c)]
        in_blocks.update(id(c) for c in block.images)
        rejected = [c for c in block.images if not _usable(c)]
        d = out[role]
        d.candidates = [c.url for c in block.images]
        if rejected:
            d.flags.append('photo_candidates_rejected:' + ','.join(sorted({c.reject for c in rejected})))
        if role not in named_roles:
            if imgs:
                d.flags.append('photo_role_without_name')
            continue
        if not imgs:
            continue
        anchor = _field_anchor(block)
        imgs.sort(key=lambda c: (abs(c.pos - anchor), c.pos))
        d.url = imgs[0].url
        if len(imgs) > 1:
            d.flags.append('photo_multiple_in_block')

    any_block_image = any(o.url for o in out.values())
    missing = [r for r in named_roles if r in out and not out[r].url]
    gallery = [c for c in page.images if id(c) not in in_blocks and _usable(c)]
    # Gallery rule (8.4) only for pages without per-role cards; a card page with no photo simply published none.
    if missing and gallery and not any_block_image and not all(b.card for b in page.roles.values()):
        for role in missing:
            _gallery_assign(page, role, gallery, out[role])

    by_url = {}
    for role, d in out.items():
        if d.url:
            by_url.setdefault(d.url, []).append(role)
    for url, roles in by_url.items():
        if len(roles) > 1:
            names = {squash(page.roles[r].name) for r in roles}
            if len(names) > 1:
                for r in roles:
                    out[r].url = ''
                    out[r].flags.append('photo_duplicate')
    return out


def _field_anchor(block):
    positions = [fr.pos for fr in block.fields.values() if fr.pos >= 0]
    return min(positions) if positions else block.start


def _gallery_assign(page, role, gallery, decision):
    """8.4: a gallery photo is assigned only by the officer's own name, employee ID or role word in its
    filename/alt/title. Never by order."""
    block = page.roles[role]
    name = block.name
    keys = set()
    emp = re.search(r'\(([০-৯0-9]{3,})\)', name)
    if emp:
        keys.add(digits_only(emp.group(1)))
    name_sq = squash(re.sub(r'\([^)]*\)', '', name)).lower()
    hits = []
    for c in gallery:
        hay = ' '.join([c.filename, c.alt, c.title]).lower()
        hay_sq = squash(hay)
        hay_digits = digits_only(hay)
        if (name_sq and len(name_sq) >= 4 and name_sq in hay_sq) or any(k and k in hay_digits for k in keys) \
                or any(w in hay for w in ROLE_WORDS[role]):
            hits.append(c)
    if len(hits) == 1:
        decision.url = hits[0].url
        decision.flags.append('photo_from_gallery_by_label')
    else:
        decision.flags.append('photo_unassignable')
        decision.candidates = [c.url for c in gallery]


def content_hash(data):
    return hashlib.sha256(data).hexdigest()
