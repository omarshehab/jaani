"""LLM assist (section 9): the model is a parser, never a source (rule R2).

Every value a model returns must be a verbatim substring of the text it was given (grounding check, 9.4) and pass
the validators; high-risk fields also need a second provider or the deterministic parser to agree (9.6). Model IDs
come only from backend/.env (TASK_CHEAP_<P>_MODEL / TASK_FLAGSHIP_<P>_MODEL, the names the Node backend uses);
nothing here names a model. Keys are read from the environment and never logged.
"""
import hashlib
import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

from .assemble import Source
from .parse import ROLES
from .textnorm import digits_only, norm

REPO = Path(__file__).resolve().parents[2]
PROMPT_PATH = Path(__file__).resolve().parents[1] / 'config' / 'prompts' / 'extract_officers.txt'
PROMPT_VERSION = 'extract_officers/v1'
PROVIDERS = {
    'openai': (('OPENAI_API_KEY',), 'OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    'grok': (('GROK_API_KEY', 'XAI_API_KEY'), 'GROK_BASE_URL', 'https://api.x.ai/v1'),
    'kimi': (('KIMI_API_KEY', 'MOONSHOT_API_KEY'), 'KIMI_BASE_URL', 'https://api.moonshot.ai/v1'),
}
FIELDS = ('name', 'designation', 'phone', 'mobile', 'email', 'address')
FIELD_MAP = dict(zip(FIELDS, ('Officer_Name', 'Designation', 'Phone', 'Mobile', 'Email', 'Address')))
HIGH_RISK = {'Officer_Name', 'Phone', 'Mobile', 'Email'}
TRIGGERS = ('unextracted_signal', 'static_page_unparsed', 'unknown_role_heading', 'focal_point_only')
MAX_CHARS = 20000          # ~6k tokens of Bengali/English text
INJECTION_RE = re.compile(r'ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?)|'
                          r'disregard\s+(the\s+)?(previous|above|system)|system\s+prompt|you\s+are\s+(now\s+)?(an?\s+)?'
                          r'(ai|assistant|model)|\boutput\b.{0,40}\bas\s+the\b|return\s+the\s+following|'
                          r'পূর্ববর্তী\s+নির্দেশ(না)?\s+(উপেক্ষা|বাদ)', re.I)
SCHEMA = {
    'type': 'object', 'additionalProperties': False, 'required': list(ROLES),
    'properties': {r: {'anyOf': [{'type': 'null'}, {
        'type': 'object', 'additionalProperties': False, 'required': list(FIELDS),
        'properties': {f: {'type': ['string', 'null']} for f in FIELDS}}]} for r in ROLES}}


def load_env():
    """backend/.env values fill in anything not already set in the environment (never printed)."""
    try:
        from dotenv import dotenv_values
    except ImportError:
        return
    for k, v in dotenv_values(REPO / 'backend' / '.env').items():
        if v is not None and k not in os.environ:
            os.environ[k] = v


@dataclass
class Provider:
    name: str
    key: str
    base: str
    cheap: str
    flagship: str

    def model(self, tier):
        return self.cheap if tier == 'cheap' else self.flagship


def providers_from_env():
    load_env()
    order = [p.strip() for p in os.environ.get('LLM_AUTO_ORDER', 'openai,grok,kimi').split(',') if p.strip()]
    out = []
    for name in order:
        if name not in PROVIDERS:
            continue
        keys, base_var, base_default = PROVIDERS[name]
        key = next((os.environ[k] for k in keys if os.environ.get(k)), '')
        up = name.upper()
        cheap = os.environ.get(f'TASK_CHEAP_{up}_MODEL', '')
        flagship = os.environ.get(f'TASK_FLAGSHIP_{up}_MODEL', '')
        if key and (cheap or flagship):
            out.append(Provider(name, key, os.environ.get(base_var, base_default), cheap, flagship))
    return out


def grounded(field, value, text):
    """9.4: the value must literally appear in the text given to the model."""
    v = norm(value)
    if not v:
        return False
    t = norm(text)
    if field in ('Phone', 'Mobile'):
        d = digits_only(v)
        return len(d) >= 5 and any(d in digits_only(line) for line in t.split('\n') + [t])
    if field == 'Email':
        return v.lower() in t.lower()
    return v in t


class LLMAssist:
    def __init__(self, state, log, providers=None, max_pages=300, max_usd=5.0, llm_all=False, client=None,
                 price_per_mtok=(5.0, 15.0)):
        self.state, self.log = state, log
        self.providers = providers if providers is not None else providers_from_env()
        self.max_pages, self.max_usd, self.llm_all = max_pages, max_usd, llm_all
        self.client = client or httpx.Client(timeout=httpx.Timeout(60, connect=10))
        self.pages_used = 0
        self.start_usd = state.usage_totals()['usd']         # --llm-max-usd caps THIS run's spend
        self.price_in, self.price_out = price_per_mtok       # upper-bound estimate, USD per 1M tokens
        self.no_temperature = set()
        self.system = PROMPT_PATH.read_text(encoding='utf-8').strip()

    def run_usd(self):
        return self.state.usage_totals()['usd'] - self.start_usd

    def over_budget(self):
        if self.run_usd() >= self.max_usd:
            if not getattr(self, '_budget_logged', False):
                self.log(event='llm_budget_exhausted', usd=self.max_usd, run_usd=round(self.run_usd(), 4))
                self._budget_logged = True
            return True
        return False

    # ------------------------------------------------------------------ audit
    def audit(self):
        report = {}
        for p in self.providers:
            try:
                r = self.client.get(f'{p.base}/models', headers={'Authorization': f'Bearer {p.key}'}, timeout=20)
                ids = sorted(m.get('id', '') for m in r.json().get('data', [])) if r.status_code == 200 else []
                report[p.name] = dict(status=r.status_code, available=len(ids),
                                      cheap_listed=p.cheap in ids if p.cheap else None,
                                      flagship_listed=p.flagship in ids if p.flagship else None,
                                      cheap=p.cheap, flagship=p.flagship)
            except Exception as e:
                report[p.name] = dict(error=type(e).__name__)
        self.log(event='llm_model_audit', report=report)
        return report

    # ------------------------------------------------------------------ calls
    def _call(self, p, tier, text, row_key):
        model = p.model(tier)
        if not model:
            return None
        key = hashlib.sha256('|'.join([PROMPT_VERSION, p.name, model, text]).encode()).hexdigest()
        cached = self.state.cache_get(key)
        if cached is not None:
            return cached
        if self.over_budget():
            return None
        body = {'model': model, 'messages': [{'role': 'system', 'content': self.system},
                                             {'role': 'user', 'content': f'<<<PAGE TEXT\n{text}\nPAGE TEXT>>>'}],
                'response_format': {'type': 'json_schema', 'json_schema': {'name': 'officers', 'strict': True,
                                                                            'schema': SCHEMA}}}
        if (p.name, model) not in self.no_temperature:
            body['temperature'] = 0
        limit = 2400 if p.name == 'kimi' else 1200
        body['max_completion_tokens' if p.name == 'openai' else 'max_tokens'] = limit
        t0 = time.time()
        for attempt in range(3):
            try:
                r = self.client.post(f'{p.base}/chat/completions', json=body,
                                     headers={'Authorization': f'Bearer {p.key}'})
            except httpx.HTTPError as e:
                self.log(event='llm_error', provider=p.name, model=model, error=type(e).__name__)
                return None
            if r.status_code == 400 and 'temperature' in r.text and 'temperature' in body:
                self.no_temperature.add((p.name, model))
                body.pop('temperature')
                continue
            if r.status_code == 400 and body['response_format']['type'] == 'json_schema':
                body['response_format'] = {'type': 'json_object'}
                continue
            break
        latency = time.time() - t0
        if r.status_code != 200:
            self.log(event='llm_error', provider=p.name, model=model, status=r.status_code)
            return None
        data = r.json()
        usage = data.get('usage') or {}
        pin, pout = usage.get('prompt_tokens', 0), usage.get('completion_tokens', 0)
        usd = (pin * self.price_in + pout * self.price_out) / 1e6
        try:
            parsed = json.loads(data['choices'][0]['message']['content'] or '')
        except (KeyError, IndexError, TypeError, json.JSONDecodeError):
            parsed = None
        empty = not isinstance(parsed, dict) or not any(
            isinstance(parsed.get(r), dict) and any(parsed[r].get(f) for f in FIELDS) for r in ROLES)
        self.state.usage(provider=p.name, model=model, prompt_tokens=pin, completion_tokens=pout, usd=usd,
                         latency_s=round(latency, 2), row_key=row_key, outcome='empty' if empty else 'ok')
        self.log(event='llm_call', provider=p.name, model=model, tokens_in=pin, tokens_out=pout,
                 latency_s=round(latency, 2), outcome='empty' if empty else 'ok')
        if empty:
            return None                  # parseable-but-empty counts as a failure: next provider
        self.state.cache_put(key, parsed)
        return parsed

    def ask(self, text, row_key, want=2):
        """Up to `want` successful answers: cheap tier across providers first, flagship only if cheap gave none."""
        answers = []
        for tier in ('cheap', 'flagship'):
            for p in self.providers:
                if len(answers) >= want:
                    break
                out = self._call(p, tier, text, row_key)
                if out is not None:
                    answers.append((p.name, p.model(tier), out))
            if answers:
                break
        return answers

    # ------------------------------------------------------------------ assist
    def needs_llm(self, src):
        """P4 gate. Owner rule (2026-09-29): when the deterministic parser filled all three roles with a confirmed
        name, the page never goes to the LLM; nor does an empty officer widget (verify_links BLANK). Otherwise only a role with an unextracted signal, a PARSE_MISS field or
        no field at all, or a page-level trigger (static/focal-point page, file table, no template) calls it."""
        from .validate import validate
        page = src.page
        if page is None:
            return False
        if self.llm_all:
            return True
        roles = page.roles
        if 'widget_blank' in page.flags and not roles:
            return False           # an empty officer widget has nothing to parse (Tier 2+3: ~$3 of empty answers)
        if len(roles) == 3 and all(b.name and validate('Officer_Name', b.name)[0] for b in roles.values()):
            return False
        if any(f.startswith(TRIGGERS) for f in page.flags):
            return True
        for b in roles.values():
            if any(f.startswith('unextracted_signal') for f in b.flags):
                return True
            if any(fr.state == 'PARSE_MISS' for fr in b.fields.values()):
                return True
            if not any(fr.state == 'FILLED' for fr in b.fields.values()):
                return True
        if src.kind == 'file' and len(roles) < 3 and page.text.strip():
            return True
        return page.template in ('none', 'C') and bool(page.text.strip())

    def region_text(self, page):
        """Visible text + image markers. Lines that address a model (prompt injection) are removed here, so they are
        neither sent nor usable for grounding: an injected value can never be 'found' in the text."""
        lines = page.text.split('\n')
        kept = [ln for ln in lines if not INJECTION_RE.search(ln)]
        if len(kept) != len(lines):
            page.flags.append('prompt_injection_suspected')
        parts = ['\n'.join(kept)]
        for i, img in enumerate(page.images):
            if not img.reject:
                parts.append(f'[IMG#{i} alt="{img.alt}" file="{img.filename}"]')
        return '\n'.join(parts)[:MAX_CHARS]

    def assist(self, row, sources, res):
        from .csvio import row_key
        key = row_key(row)
        extra, review = [], []
        for src in list(sources):
            if not self.needs_llm(src) or self.pages_used >= self.max_pages or not self.providers:
                continue
            self.pages_used += 1
            text = self.region_text(src.page)
            answers = self.ask(text, key)
            if not answers:
                continue
            values = {}
            first_name, first_model, first = answers[0]
            for role in ROLES:
                block = src.page.roles.get(role)
                for f_llm, f in FIELD_MAP.items():
                    val = (first.get(role) or {}).get(f_llm) if isinstance(first.get(role), dict) else None
                    if not val:
                        continue
                    val = norm(val)
                    if not grounded(f, val, text):
                        self.log(event='llm_ungrounded', row=key, role=role, field=f, value=val[:120], provider=first_name)
                        review.append(dict(role=role, field=f, value=val, flag='llm_ungrounded', url=src.url,
                                           source=src.kind, method='llm', where={}))
                        continue
                    det = block.fields[f].value if block and f in block.fields else ''
                    if f in HIGH_RISK:
                        agree = [n for n, m, o in answers[1:]
                                 if isinstance(o.get(role), dict) and norm(o[role].get(f_llm) or '') == val]
                        if not (agree or (det and norm(det) == val)):
                            review.append(dict(role=role, field=f, value=val, flag='llm_unconfirmed', url=src.url,
                                               source=src.kind, method='llm', where={}))
                            continue
                    values[(role, f)] = val
            if values:
                extra.append(Source(src.kind, src.url, values=values, method='llm',
                                    meta=dict(provider=first_name, model=first_model)))
        res.flags.extend(['llm_used'] if extra or review else [])
        self._pending_review = review
        return extra

    def take_review(self):
        r, self._pending_review = getattr(self, '_pending_review', []), []
        return r

    # ------------------------------------------------------------------ vision (6A.2-C, 8.7)
    def _vision_provider(self):
        for p in self.providers:
            m = os.environ.get(f'TASK_VISION_{p.name.upper()}_MODEL') or p.flagship
            if m:
                return p, m
        return None, None

    def _vision_call(self, png, prompt, max_tokens=1200):
        import base64
        p, model = self._vision_provider()
        if not p or self.over_budget():
            return None
        body = {'model': model, 'messages': [{'role': 'user', 'content': [
            {'type': 'text', 'text': prompt},
            {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + base64.b64encode(png).decode()}}]}],
            'response_format': {'type': 'json_object'}}
        if (p.name, model) not in self.no_temperature:
            body['temperature'] = 0
        body['max_completion_tokens' if p.name == 'openai' else 'max_tokens'] = max_tokens
        r = self.client.post(f'{p.base}/chat/completions', json=body, headers={'Authorization': f'Bearer {p.key}'})
        if r.status_code == 400 and 'temperature' in r.text and 'temperature' in body:
            self.no_temperature.add((p.name, model))
            body.pop('temperature')
            r = self.client.post(f'{p.base}/chat/completions', json=body, headers={'Authorization': f'Bearer {p.key}'})
        if r.status_code != 200:
            self.log(event='vision_error', provider=p.name, status=r.status_code)
            return None
        data = r.json()
        u = data.get('usage') or {}
        self.state.usage(provider=p.name, model=model, prompt_tokens=u.get('prompt_tokens', 0),
                         completion_tokens=u.get('completion_tokens', 0),
                         usd=(u.get('prompt_tokens', 0) * self.price_in + u.get('completion_tokens', 0) * self.price_out) / 1e6,
                         outcome='vision')
        try:
            return json.loads(data['choices'][0]['message']['content'])
        except Exception:
            return None

    def transcribe(self, png, cand=None):
        out = self._vision_call(png, 'Transcribe exactly the Bengali and English text in this image. Do not translate, '
                                     'correct, complete or add anything. Return JSON {"lines":[...]}')
        if not isinstance(out, dict):
            return None
        return norm(' '.join(str(x) for x in out.get('lines') or []))

    def transcribe_lines(self, png):
        """Whole scanned page (6A.2-C): -> list of lines, or None."""
        out = self._vision_call(png, 'Transcribe exactly the Bengali and English text in this image, line by line, '
                                     'keeping table rows on one line with cells separated by " | ". Do not translate, '
                                     'correct, complete or add anything. Return JSON {"lines":[...]}', max_tokens=6000)
        if not isinstance(out, dict):
            return None
        return [norm(str(x)) for x in out.get('lines') or [] if norm(str(x))]

    def photo_veto(self, png):
        out = self._vision_call(png, 'Is this a portrait photograph of one person? Is it a logo, emblem, banner or '
                                     'placeholder? Answer only JSON {"portrait": true|false, "placeholder": true|false}. '
                                     'Do not identify the person.')
        if not isinstance(out, dict):
            return None
        return bool(out.get('portrait')) and not bool(out.get('placeholder'))
