"""Independent second reading (6A.2-C): render the value's region and read it with Tesseract and a vision model.
The reading is only ever used to CONFIRM a recovered value (integrity.validate_recovered); it is never a source.

Owner rule (2026-09-29, `--ocr-engine both`): a high-risk field (name, phone, mobile, e-mail) is confirmed only when
BOTH engines read it and agree with each other; a single engine never confirms a high-risk field. If Tesseract errors
or its confidence is low, the row is flagged `ocr_tesseract_failed` and the vision reading alone may confirm only a
low-risk field (designation, address).
"""
import hashlib
import io
import re
import shutil
from pathlib import Path

import pypdfium2 as pdfium

from .textnorm import digits_only, norm

DPI = 300
MIN_TESSERACT_CONFIDENCE = 60
HIGH_RISK = {'Officer_Name', 'Phone', 'Mobile', 'Email'}


def tesseract_available():
    return shutil.which('tesseract') is not None


def tesseract_read(img):
    """-> (text, mean word confidence 0-100). Raises on engine errors."""
    import pytesseract
    data = pytesseract.image_to_data(img, lang='ben+eng', output_type=pytesseract.Output.DICT)
    words = [(w, float(c)) for w, c in zip(data['text'], data['conf']) if str(w).strip() and float(c) >= 0]
    text = norm(' '.join(w for w, _ in words))
    conf = sum(c for _, c in words) / len(words) if words else 0.0
    return text, conf


def render_crop(pdf_bytes, page_no, bbox, pad=4, dpi=DPI):
    pdf = pdfium.PdfDocument(pdf_bytes)
    page = pdf[page_no - 1]
    scale = dpi / 72
    img = page.render(scale=scale).to_pil()
    x0, top, x1, bottom = bbox
    box = (max(0, int((x0 - pad) * scale)), max(0, int((top - pad) * scale)),
           min(img.width, int((x1 + pad) * scale)), min(img.height, int((bottom + pad) * scale)))
    return img.crop(box)


def readings_agree(field, a, b):
    from .integrity import grapheme_similarity
    if not a or not b:
        return False
    if field in ('Phone', 'Mobile'):
        return bool(digits_only(a)) and digits_only(a) == digits_only(b)
    if field == 'Email':
        return norm(a).lower().replace(' ', '') == norm(b).lower().replace(' ', '')
    return grapheme_similarity(a, b) >= 0.92


class SecondReader:
    """Callable used by assemble.decide(): cand -> text or None."""

    def __init__(self, files, crops_dir, engines=('tesseract', 'vision'), vision=None, log=None, tesseract=None):
        self.files = files                  # url -> bytes (PDFs already downloaded for this row)
        self.crops_dir = Path(crops_dir)
        self.engines = engines
        self.vision = vision                # callable(png_bytes, cand=None) -> text or None
        self.tesseract = tesseract or (tesseract_read if tesseract_available() else None)
        self.log = log or (lambda **kw: None)

    def crop_for(self, cand):
        w = cand.where or {}
        data = self.files.get(w.get('file'))
        if not data or not w.get('bbox'):
            return None, None
        img = render_crop(data, w['page'], w['bbox'])
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        png = buf.getvalue()
        self.crops_dir.mkdir(parents=True, exist_ok=True)
        path = self.crops_dir / (hashlib.sha256(png).hexdigest()[:16] + '.png')
        path.write_bytes(png)
        w['crop'] = str(path)
        return img, png

    def __call__(self, cand):
        img, png = self.crop_for(cand)
        if img is None:
            return None
        field = cand.field
        readings, flags = {}, []
        if 'tesseract' in self.engines:
            if not self.tesseract:
                flags.append('ocr_tesseract_failed')
            else:
                try:
                    text, conf = self.tesseract(img)
                    readings['tesseract_confidence'] = round(conf, 1)
                    if text and conf >= MIN_TESSERACT_CONFIDENCE:
                        readings['tesseract'] = text
                    else:
                        flags.append('ocr_tesseract_failed')
                except Exception as e:
                    flags.append('ocr_tesseract_failed')
                    self.log(event='ocr_error', engine='tesseract', error=str(e)[:200])
        if 'vision' in self.engines and self.vision:
            try:
                readings['vision'] = norm(self.vision(png, cand=cand) or '')
            except Exception as e:
                self.log(event='ocr_error', engine='vision', error=str(e)[:200])
        t, v = readings.get('tesseract'), readings.get('vision')
        both = 'tesseract' in self.engines and 'vision' in self.engines
        if not both:
            result = t or v or None                       # single-engine mode chosen explicitly (--ocr-engine)
            if result and field in HIGH_RISK:
                flags.append('single_engine_reading')
        elif t and v:
            result = t if readings_agree(field, t, v) else None
            if result is None:
                flags.append('ocr_engines_disagree')
        elif field in HIGH_RISK:
            result = None                                 # never one engine alone for a high-risk field
        else:
            result = v or None                            # low-risk: vision alone after a Tesseract failure
        cand.where['second_readings'] = readings
        cand.where['ocr_flags'] = flags
        cand.flags.extend(flags)
        self.log(event='second_reading', field=field, value=cand.value[:120], readings=readings, flags=flags,
                 decision='confirmed_candidate' if result else 'no_confirmation')
        return result


# ---------------------------------------------------------------------- scanned pages (6A.2-C, whole page)
OCR_LABELS = r'(কর্মকর্তার নাম|নাম|পদবি|পদবী|ফোন|টেলিফোন|মোবাইল|ই[- ]?মেইল|ইমেইল|ঠিকানা|Name|Designation|Phone|Mobile|E-?mail|Address)'
OCR_LABEL_ONLY_RE = re.compile('^' + OCR_LABELS + r'\s*[.:ঃ]?$', re.I)
OCR_LABEL_RE = re.compile('^' + OCR_LABELS + r'\s*[.|_:ঃ]*\s+(?=\S)', re.I)
MIDLINE_LABEL_RE = re.compile(r'\s+(?=(?:ঠিকানা|পদবি|পদবী|ফোন|মোবাইল|ই[- ]?মেইল)(?:\s|[.|_:ঃ]|$))')


def ocr_lines_to_html(lines):
    """OCR/vision lines -> simple HTML for parse_page. Only separators are normalised (table rules read as '|',
    '_' or '.' after a label); no character of a value is changed."""
    import html as htmlmod
    out = []
    split_lines = []
    for ln in lines:                                  # two-column forms: "নাম জনাব ক ঠিকানা ..." -> two lines
        split_lines.extend(MIDLINE_LABEL_RE.split(norm(ln)))
    for ln in split_lines:
        ln = re.sub(r'^[\s|_(\[\]]+', '', norm(ln))
        ln = re.sub(r'[\s|_\]]+$', '', ln)
        cells = [c.strip(' _') for c in re.split(r'\s*\|\s*', ln) if c.strip(' _')]
        if len(cells) >= 2:
            # Two-column officer forms: "label | value | <address column>". The third cell belongs to the
            # address column, never to this value.
            ln = f'{cells[0]}: {cells[1]}' if OCR_LABEL_ONLY_RE.match(cells[0]) else ' '.join(cells)
        ln = OCR_LABEL_RE.sub(lambda m: m.group(1) + ': ', ln)
        out.append(f'<p>{htmlmod.escape(ln)}</p>')
    return '<html><body><div class="static-page">' + '\n'.join(out) + '</div></body></html>'


def read_scanned_page(pdf_bytes, page_no, crops_dir, tesseract=None, vision_lines=None, log=None):
    """Render one scanned page at 300 dpi and read it with both engines. -> dict(png, tesseract, vision, flags)."""
    import pytesseract
    log = log or (lambda **kw: None)
    pdf = pdfium.PdfDocument(pdf_bytes)
    img = pdf[page_no - 1].render(scale=DPI / 72).to_pil()
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    png = buf.getvalue()
    crops_dir = Path(crops_dir)
    crops_dir.mkdir(parents=True, exist_ok=True)
    path = crops_dir / (hashlib.sha256(png).hexdigest()[:16] + '_page.png')
    path.write_bytes(png)
    out = dict(png=str(path), tesseract=None, vision=None, flags=[])
    if tesseract is not False and tesseract_available():
        try:
            data = pytesseract.image_to_data(img, lang='ben+eng', output_type=pytesseract.Output.DICT)
            confs = [float(c) for w, c in zip(data['text'], data['conf']) if str(w).strip() and float(c) >= 0]
            out['tesseract_confidence'] = round(sum(confs) / len(confs), 1) if confs else 0.0
            text = pytesseract.image_to_string(img, lang='ben+eng')
            if out['tesseract_confidence'] >= MIN_TESSERACT_CONFIDENCE:
                out['tesseract'] = [norm(x) for x in text.splitlines() if norm(x)]
            else:
                out['flags'].append('ocr_tesseract_failed')
        except Exception as e:
            out['flags'].append('ocr_tesseract_failed')
            log(event='ocr_error', engine='tesseract', error=str(e)[:200])
    else:
        out['flags'].append('ocr_tesseract_failed')
    if vision_lines:
        try:
            out['vision'] = vision_lines(png)
        except Exception as e:
            log(event='ocr_error', engine='vision', error=str(e)[:200])
    if not out['vision']:
        out['flags'].append('ocr_vision_failed')
    return out


def scanned_candidates(reading, url, page_no):
    """Parse each engine's reading separately and compare field by field. -> list of review dicts.
    These are CANDIDATES only (6A.2-C: OCR/vision is never a source by itself); none is written to the CSV."""
    from .parse import parse_page
    parsed = {}
    for eng in ('tesseract', 'vision'):
        if reading.get(eng):
            parsed[eng] = parse_page(ocr_lines_to_html(reading[eng]), url)
    items = []
    roles = sorted({r for pg in parsed.values() for r in pg.roles})
    for role in roles:
        fields = sorted({f for pg in parsed.values() if role in pg.roles
                         for f, fr in pg.roles[role].fields.items() if fr.value})
        for f in fields:
            vals = {eng: pg.roles[role].fields[f].value for eng, pg in parsed.items()
                    if role in pg.roles and pg.roles[role].fields[f].value}
            t, v = vals.get('tesseract'), vals.get('vision')
            if t and v:
                verdict = 'agree' if readings_agree(f, t, v) else 'disagree'
            else:
                verdict = 'single_engine'
            items.append(dict(role=role, field=f, value=v or t, flag=f'scanned_ocr_candidate:{verdict}', url=url,
                              source='file', method='ocr', where=dict(file=url, page=page_no, crop=reading['png'],
                                                                      second_readings=vals,
                                                                      ocr_flags=reading['flags'])))
    return items
