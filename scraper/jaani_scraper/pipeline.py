"""P0-P8 (section 2): link check -> acquire -> parse -> assess -> (LLM) -> reconcile -> photos -> write."""
import hashlib
import json
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

import lxml.html

from . import assemble, csvio, files, reports
from .assemble import Source
from .net import GuardedFetcher, HostStopped, user_agent
from .netguard import Blocked, Policy
from .parse import ROLES, classify_heading, parse_page
from .state import JsonlLog, State
from .textnorm import ascii_digits, norm, squash

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 's3'))
import verify_links  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
CONFIG = Path(__file__).resolve().parents[1] / 'config'
ALT_PATHS = ['/views/info-officers', '/site/view/information_officers', '/site/view/info_officers',
             '/bn/site/view/info_officer', '/bn/site/view/information_officers']
MENU_WORDS = ('দায়িত্বপ্রাপ্তকর্মকর্তা', 'তথ্যপ্রদানকারীকর্মকর্তা', 'আপীলকর্তৃপক্ষ', 'তথ্যঅধিকার',
              'informationofficer', 'designatedofficer', 'righttoinformation')
MAX_REQUESTS = 8
GRS_RE = re.compile(r'অভিযোগ|grievance|\bgrs\b', re.I)


FILE_LIST_RE = re.compile(r'(তথ্য\s*প্রদানকারী|দায়িত্বপ্রাপ্ত|দ্বায়িত্বপ্রাপ্ত)\s*কর্মকর্তা|information\s*officer|designated\s*officer'
                          r'|আপিল\s*কর্তৃপক্ষ|appellate\s*authority', re.I)
DATE_RE = re.compile(r'\b([0-3]?[0-9০-৯]{1,2})[-./]([01]?[0-9০-৯]{1,2})[-./]((?:19|20|১৯|২০)[0-9০-৯]{2})\b')


def _doc(html):
    try:
        return lxml.html.document_fromstring(html or '<html/>')
    except Exception:
        return None


RTI_FILE_HINT_RE = re.compile(r'rti|oicaa|info[-_ ]?officer|designated|তথ্য|কর্মকর্তা|কর্তৃপক্ষ', re.I)


def _all_file_links(html, base):
    """Fallback: file links whose URL or link text points at RTI/officer content. Any other PDF on the page
    (project lists, notices) is never fetched or OCR'd (PWD, Tier 2)."""
    doc = _doc(html)
    if doc is None:
        return []
    out = []
    for a in doc.iter('a'):
        href = urljoin(base, a.get('href') or '')
        if files.FILE_LINK_RE.search(href) and (RTI_FILE_HINT_RE.search(unquote(href))
                                                or RTI_FILE_HINT_RE.search(a.text_content() or '')):
            out.append(href)
    return list(dict.fromkeys(out))


def rti_file_links(html, base):
    doc = _doc(html)
    if doc is None:
        return []
    found = []
    for a in doc.iter('a'):
        href = urljoin(base, a.get('href') or '')
        if not files.FILE_LINK_RE.search(href):
            continue
        ctx = a
        for anc in a.iterancestors():
            if anc.tag in ('tr', 'li'):
                ctx = anc
                break
        text = norm(ctx.text_content())
        if len(text) > 300 or not FILE_LIST_RE.search(text) or GRS_RE.search(text):
            continue
        m = DATE_RE.search(ascii_digits(text))
        date = (int(m.group(3)), int(m.group(2)), int(m.group(1))) if m else (0, 0, 0)
        found.append((date, href))
    found.sort(key=lambda x: x[0], reverse=True)
    return list(dict.fromkeys(h for _, h in found))


def _rti_officer_link(text):
    """A menu link to an RTI officer page. A bare 'আপিল কর্মকর্তা' link on these portals is the grievance (GRS)
    appeal officer, so an appellate-only link needs 'কর্তৃপক্ষ'/'authority' (the RTI Act's term)."""
    if GRS_RE.search(text):
        return False
    kind = classify_heading(text)
    if kind in ('primary', 'alternate'):
        return True
    sq = squash(text).lower()
    if kind == 'appellate':
        return 'কর্তৃপক্ষ' in sq or 'authority' in sq
    return kind == 'container' and ('দায়িত্বপ্রাপ্ত' in sq or 'তথ্যপ্রদান' in sq)
JS_BUNDLE_RE = re.compile(r'<script[^>]+src=[^>]+(?:app|main|bundle|chunk)[^>]*\.js', re.I)


def tier(row):
    o, m, dv = row['Office'], row['Ministry'], row['Division']
    if 'জেলা প্রশাসক' in o or 'বিভাগীয় কমিশনার' in o:
        return 4
    if o in (m, dv) or o.endswith('মন্ত্রণালয়') or (o.endswith('বিভাগ') and o == dv):
        return 1
    if re.search(r'অধিদপ্তর|অধিদফতর|পরিদপ্তর|দপ্তর|ব্যুরো|পুলিশ|কার্যালয়|সদর দপ্তর|হেডকোয়ার্টার্স|ইনস্টিটিউট', o):
        return 2
    return 3


def body_denied(row):
    """[deny] / [manual] body names from config/deny_bodies.txt, matched on the squashed Office/Division."""
    section, deny, manual = None, [], []
    for ln in (CONFIG / 'deny_bodies.txt').read_text(encoding='utf-8').splitlines():
        ln = ln.strip()
        if not ln or ln.startswith('#'):
            continue
        if ln in ('[deny]', '[manual]'):
            section = ln
            continue
        (deny if section == '[deny]' else manual).append(ln)
    hay = squash(row['Office'] + ' ' + row['Division'])
    if any(k in hay for k in deny):
        return 'exempt'
    if any(k in hay for k in manual):
        return 'manual_review'
    return ''


@dataclass
class RowResult:
    row_key: str
    status: str
    link_status: str = ''
    rti_url: str = ''
    decision: object = None
    changes: list = field(default_factory=list)
    flags: list = field(default_factory=list)
    manual_reason: str = ''
    sources: list = field(default_factory=list)
    requests: int = 0
    scan_review: list = field(default_factory=list)


class Pipeline:
    def __init__(self, csv_path, out_dir, contact=None, fetcher=None, policy=None, llm=None, second_reader_factory=None,
                 allow_archive=False, archive_max_age_months=18, render=False, dry_run=False, delay=3.0,
                 today=None, verify_photos=True, filled_path=None, download_photos=None, vision_check=False,
                 scanned_reader=None):
        self.csv_path = Path(csv_path)
        self.out = Path(out_dir)
        self.out.mkdir(parents=True, exist_ok=True)
        self.rows = csvio.read_csv(self.csv_path)
        self.today = today or date.today().isoformat()
        self.policy = policy or Policy()
        self.log = JsonlLog(self.out / 'scrape_log.jsonl')
        self.recovery_log = JsonlLog(self.out / 'text_recovery.jsonl')
        self.state = State(self.out / 'state.sqlite')
        self.fetcher = fetcher or GuardedFetcher(user_agent(contact), delay=delay, policy=self.policy,
                                                 log=lambda **kw: self.log(**kw))
        self.llm = llm
        self.second_reader_factory = second_reader_factory
        self.scanned_reader = scanned_reader      # (pdf_bytes, page_no) -> reading; --ocr-engine only
        self.allow_archive, self.archive_max_age = allow_archive, archive_max_age_months
        self.render, self.dry_run, self.verify_photos = render, dry_run, verify_photos
        self.download_dir = Path(download_photos) if download_photos else None
        self.vision_check = vision_check
        self.results = {}
        self.final_urls = {}
        self.filled_path = Path(filled_path or REPO / 's3' / 'out' / 'JAANI_RTI_OFFICERS_COMPLETE.filled.csv')
        if self.filled_path.exists():
            self.rows = csvio.read_csv(self.filled_path)
        self.by_key = {csvio.row_key(r): r for r in self.rows}
        self.own_hosts = {urlsplit(r['Website_Link']).hostname: csvio.row_key(r) for r in self.rows}

    # ------------------------------------------------------------------ selection
    def select(self, tiers=None, only_host=None, only_row=None, limit=0, retry_failed=False):
        out = []
        for r in self.rows:
            k = csvio.row_key(r)
            if tiers and tier(r) not in tiers:
                continue
            if only_host and urlsplit(r['Website_Link']).hostname != only_host:
                continue
            if only_row is not None and k != only_row:     # '' matches nothing, never everything
                continue
            if not only_row and not self.state.due(k, retry_failed):
                continue
            out.append(r)
        return out[:limit] if limit else out

    # ------------------------------------------------------------------ P1
    def _get(self, url, res, kind='page', cap=None):
        """One budgeted request: robots.txt checked for every host (R4), policy checked on every hop (R5).
        Returns (status, final_url, content_type, text) or, with cap (files), bytes instead of text."""
        if res.requests >= MAX_REQUESTS:
            raise HostStopped('request budget for this row used up')
        ok = self.fetcher.allowed(url, kind=kind)
        if ok is not True:
            self.log(event='robots_refused' if ok is False else 'robots_unreadable', url=url)
            return (403 if ok is False else None), url, '', b'' if cap else ''
        res.requests += 1
        try:
            if cap:
                status, final, headers, body = self.fetcher.fetch(url, kind=kind, cap=cap)
                return status, final, headers.get('content-type', ''), body
            return self.fetcher.get(url, kind=kind)
        except (Blocked, HostStopped):
            raise
        except Exception as e:
            self.fetcher.note_failure(urlsplit(url).netloc)
            self.log(event='fetch_error', url=url, error=f'{type(e).__name__}: {str(e)[:200]}')
            return None, url, '', b'' if cap else ''

    def find_rti_page(self, row, res):
        """-> (status, url, html). Uses the owner's verify_links.classify on every candidate page."""
        url = row['Website_Link']
        u = urlsplit(url)
        origin = f'{u.scheme}://{u.netloc}'
        allowed = self.fetcher.allowed(url)
        if allowed is None:
            # Same site, other spelling: the bare host may not resolve while www. does, or HTTPS may be refused on a
            # host that serves plain HTTP. Each alternative gets its own robots.txt check.
            path = u.path + (('?' + u.query) if u.query else '')
            alts = []
            if not u.netloc.startswith('www.'):
                alts.append(f'{u.scheme}://www.{u.netloc}{path}')
            if u.scheme == 'https':
                alts.append(f'http://{u.netloc}{path}')
            for alt in alts:
                try:
                    a = self.fetcher.allowed(alt)
                except Blocked:
                    continue
                if a is not None:
                    self.log(event='link_alternative', row=csvio.row_key(row), original=url, used=alt)
                    url, u, allowed = alt, urlsplit(alt), a
                    origin = f'{u.scheme}://{u.netloc}'
                    break
        if allowed is False:
            return 'BLOCKED_BY_ROBOTS', url, ''
        if allowed is None:
            return 'DEAD', url, ''
        tried, best = [], ('NOT_FOUND', url, '')
        candidates = [url] + [origin + p for p in ALT_PATHS if origin + p != url]
        for cand in candidates:
            if self.fetcher.allowed(cand) is False:
                continue
            status, final, ctype, body = self._get(cand, res)
            tried.append(cand)
            if status is None or status >= 500:
                best = ('DEAD', cand, '') if best[0] == 'NOT_FOUND' and status is None and cand == url else best
                if cand == url and status is None:
                    return 'DEAD', url, ''
                continue
            if status in (404, 410) or status >= 400:
                continue
            if ctype and 'html' not in ctype.lower():
                if files.FILE_LINK_RE.search(final):
                    return 'FILE', final, ''
                continue
            st, roles, names, title = verify_links.classify(body, final)
            if st in ('POPULATED', 'BLANK', 'REVIEW'):
                if urlsplit(final).path in ('', '/') and not roles:
                    continue
                return st, final, body
            if rti_file_links(body, final):
                return 'FILE_LIST', final, body             # officer list published only as files (NBR)
        found = self.discover(origin, res)
        if found:
            return found
        return best

    def discover(self, origin, res):
        """Homepage menu (max 2 levels, same registrable domain), then sitemap.xml."""
        from .validate import registrable
        home_dom = registrable(urlsplit(origin).hostname)
        queue, seen = [(origin + '/', 0)], set()
        while queue and res.requests < MAX_REQUESTS - 1:
            url, depth = queue.pop(0)
            if url in seen or self.fetcher.allowed(url) is not True:
                continue
            seen.add(url)
            status, final, ctype, body = self._get(url, res)
            if not status or status >= 400 or 'html' not in (ctype or 'html'):
                continue
            if depth > 0:
                st, roles, names, _ = verify_links.classify(body, final)
                if st in ('POPULATED', 'BLANK') and roles:
                    return st, final, body
            try:
                doc = lxml.html.document_fromstring(body)
            except Exception:
                continue
            for a in doc.iter('a'):
                href = (a.get('href') or '').strip()
                text = squash(a.text_content()).lower()
                if not href or href.startswith(('#', 'javascript:', 'mailto:')):
                    continue
                target = urljoin(final, href)
                h = urlsplit(target).hostname or ''
                if registrable(h) != home_dom:
                    continue
                if any(w in text for w in MENU_WORDS) or re.search(r'info[-_]?officer|information_officer', target, re.I):
                    if depth < 2 and target not in seen:
                        queue.insert(0, (target, depth + 1))
        sm = origin + '/sitemap.xml'
        if res.requests < MAX_REQUESTS and self.fetcher.allowed(sm) is True:
            status, final, ctype, body = self._get(sm, res)
            if status == 200:
                for loc in re.findall(r'<loc>\s*([^<]+?)\s*</loc>', body or ''):
                    if re.search(r'info[-_]?officer|information_officers', loc, re.I) and res.requests < MAX_REQUESTS:
                        st2, final2, ctype2, body2 = self._get(loc, res)
                        if st2 == 200:
                            st, roles, names, _ = verify_links.classify(body2, final2)
                            if st in ('POPULATED', 'BLANK'):
                                return st, final2, body2
        return None

    # ------------------------------------------------------------------ P2 acquire
    def acquire(self, row, res, rti_url, html):
        sources, file_bytes = [], {}
        page = parse_page(html, rti_url)
        self._log_recovery(row, rti_url, page)
        if not page.roles and self.render and JS_BUNDLE_RE.search(html or ''):
            rendered = self.render_page(rti_url, res)
            if rendered:
                page = parse_page(rendered, rti_url)
                page.flags.append('rendered_js')
        sources.append(Source('live', rti_url, page=page))
        for sub in self._subpages(page, html, rti_url)[:3]:
            status, final, ctype, body = self._get(sub, res)
            if status == 200 and 'html' in (ctype or 'html'):
                sp = parse_page(body, final)
                if sp.roles:
                    self._log_recovery(row, final, sp)
                    sources.append(Source('subpage', final, page=sp))
        for link in self._file_links(html, rti_url)[:2]:
            try:
                status, final, ctype, data = self._get(link, res, kind='page', cap=files.FILE_CAP)
            except (Blocked, HostStopped):
                continue
            if status == 200 and data:
                parsed = self._parse_file(row, res, data, final, ctype)
                if parsed:
                    fp, meta, info = parsed
                    file_bytes[final] = data
                    self._log_recovery(row, final, fp)
                    sources.append(Source('file', final, page=fp, meta=meta))
        return sources, file_bytes

    def _parse_file(self, row, res, data, url, ctype):
        """One bad file (truncated at the cap, corrupt PDF) is logged and skipped; it never fails the row."""
        if len(data) >= files.FILE_CAP:
            res.flags.append('file_truncated_at_cap')
            self.log(event='file_parse_failed', row=csvio.row_key(row), url=url, error='truncated at FILE_CAP')
            return None
        try:
            parsed = files.parse_file(data, url, ctype)
            if parsed and 'scanned_file' in parsed[0].flags:
                self._read_scanned(row, res, data, url, parsed[2])
            return parsed
        except Exception as e:
            res.flags.append('file_parse_failed')
            self.log(event='file_parse_failed', row=csvio.row_key(row), url=url, error=f'{type(e).__name__}: {e}'[:200])
            return None

    def _read_scanned(self, row, res, data, url, info):
        """6A.2-C for scanned pages: both engines read the rendered page; every field becomes a review CANDIDATE
        (agree / disagree / single_engine). Nothing read from a scan is written to the CSV."""
        from .secondread import scanned_candidates
        if not self.scanned_reader:
            res.flags.append('scanned_file_no_ocr')
            return
        for pno in info.get('scanned_pages', [])[:2]:
            reading = self.scanned_reader(data, pno)
            items = scanned_candidates(reading, url, pno)
            res.scan_review.extend(items)
            res.flags.extend(reading['flags'])
            self.log(event='scanned_page_read', row=csvio.row_key(row), url=url, page=pno,
                     tesseract_lines=len(reading.get('tesseract') or []), vision_lines=len(reading.get('vision') or []),
                     candidates={v: sum(1 for i in items if i['flag'].split(':')[1] == v)
                                 for v in ('agree', 'disagree', 'single_engine')})

    def _subpages(self, page, html, base):
        out = []
        try:
            doc = lxml.html.document_fromstring(html or '<html/>')
        except Exception:
            return out
        base_host = urlsplit(base).hostname
        for fr in doc.iter('iframe'):
            src = urljoin(base, fr.get('src') or '')
            if urlsplit(src).hostname == base_host and src != base:
                out.append(src)
        for a in doc.iter('a'):
            t = norm(a.text_content())
            href = urljoin(base, a.get('href') or '')
            if urlsplit(href).hostname == base_host and href != base and (
                    re.search(r'আরও\s*দেখুন|বিস্তারিত', t) or _rti_officer_link(t)):
                if not re.search(r'info[-_]?officers?$', href):
                    out.append(href)
        return list(dict.fromkeys(out))

    def _file_links(self, html, base):
        """File links on the page. Links whose own text or table row / list item names the RTI officer list come
        (NBR-style file lists, Template D); if there are any, only the newest one is used, so an older list can
        never fill a gap with a superseded officer."""
        return rti_file_links(html, base)[:1] or _all_file_links(html, base)

    def render_page(self, url, res):
        """--render: Playwright, only for robots-allowed URLs, honest UA, same per-host delay. Never a bypass."""
        if self.fetcher.allowed(url) is not True:
            return None
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            self.log(event='render_unavailable', url=url)
            return None
        self.fetcher._wait(urlsplit(url).netloc)
        res.requests += 1
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context(user_agent=self.fetcher.ua)

            def guard(route):
                try:
                    self.policy.check_url(route.request.url, kind='image' if route.request.resource_type == 'image'
                                          else 'page')
                    route.continue_()
                except Blocked:
                    route.abort()
            ctx.route('**/*', guard)
            pg = ctx.new_page()
            pg.goto(url, wait_until='networkidle', timeout=30000)
            html = pg.content()
            browser.close()
        return html

    def archive_source(self, row, url, res):
        """S6: newest Wayback snapshot via the CDX API; only when the live page is unreachable/blocked."""
        cdx = ('https://web.archive.org/cdx/search/cdx?url=' + url + '&output=json&filter=statuscode:200&limit=-1')
        status, final, ctype, body = self._get(cdx, res, kind='archive')
        if status != 200:
            return None
        rows = json.loads(body or '[]')
        if len(rows) < 2:
            return None
        ts = rows[-1][1]
        snap = date(int(ts[:4]), int(ts[4:6]), int(ts[6:8]))
        if (date.fromisoformat(self.today) - snap).days > self.archive_max_age * 30.5:
            self.log(event='archive_too_old', row=csvio.row_key(row), snapshot=snap.isoformat())
            return None
        status, final, ctype, html = self._get(f'https://web.archive.org/web/{ts}id_/{url}', res, kind='archive')
        if status != 200:
            return None
        page = parse_page(html, url)
        for img in page.images:
            m = re.match(r'https?://web\.archive\.org/web/\d+(?:im_|id_)?/(https?://.+)$', img.url)
            if m:
                img.url = m.group(1)
        return Source('archive', f'https://web.archive.org/web/{ts}/{url}', page=page,
                      meta=dict(snapshot_date=snap.isoformat()))

    # ------------------------------------------------------------------ photos
    def photo_verifier(self, res):
        def verify(url):
            if not self.verify_photos:
                return True, []
            try:
                robots = self.fetcher.allowed(url, kind='image')
            except Blocked as e:
                return False, [f'photo_blocked:{e}']
            if robots is False:
                return True, ['photo_unverified_robots']
            try:
                status, final, headers, body = self.fetcher.fetch(url, method='HEAD', kind='image')
                if status in (403, 405, 501) or not headers.get('content-length'):
                    status, final, headers, body = self.fetcher.fetch(url, kind='image', cap=65536,
                                                                      headers={'Range': 'bytes=0-65535'})
            except (Blocked, HostStopped) as e:
                return False, [f'photo_blocked:{e}']
            except Exception:
                return True, ['photo_unverified']
            ctype = headers.get('content-type', '')
            size = int(headers.get('content-length') or 0) or len(body)
            m = re.search(r'/(\d+)$', headers.get('content-range', ''))
            if m:
                size = int(m.group(1))
            if status not in (200, 206):
                return False, [f'photo_http_{status}']
            if not ctype.startswith('image/'):
                return False, ['photo_not_image']
            if size < 2048:
                return False, ['photo_tiny']
            if self.download_dir or (self.vision_check and self.llm):
                try:
                    st2, _, h2, data = self.fetcher.fetch(url, kind='image', cap=5 * 1024 * 1024)
                except Exception:
                    return True, ['photo_unverified']
                if st2 == 200 and data:
                    sha = hashlib.sha256(data).hexdigest()
                    self.state.db.execute('INSERT INTO photos VALUES (?,?,?,?,?,?)',
                                          (url, sha, res.row_key, '', len(data), ctype))
                    if self.download_dir:
                        self.download_dir.mkdir(parents=True, exist_ok=True)
                        ext = {'image/png': '.png', 'image/webp': '.webp'}.get(ctype.split(';')[0], '.jpg')
                        (self.download_dir / (sha + ext)).write_bytes(data)
                    if self.vision_check and self.llm:
                        verdict = self.llm.photo_veto(data)
                        if verdict is False:
                            return False, ['photo_vision_rejected']
            return True, []
        return verify

    # ------------------------------------------------------------------ row
    def process_row(self, row):
        key = csvio.row_key(row)
        res = RowResult(key, status='')
        denied = body_denied(row)
        host = urlsplit(row['Website_Link']).hostname or ''
        try:
            self.policy.check_url(row['Website_Link'])
        except Blocked as e:
            denied = denied or ('exempt' if 'deny_host' in str(e) else 'manual_review' if 'manual' in str(e) else '')
            if not denied:
                res.status, res.manual_reason = 'manual_needed', f'policy:{e}'
                return self._finish(row, res)
        if denied:
            res.status = 'exempt' if denied == 'exempt' else 'manual_needed'
            res.manual_reason = denied
            return self._finish(row, res)
        try:
            link_status, rti_url, html = self.find_rti_page(row, res)
        except Blocked as e:
            link_status, rti_url, html = 'DEAD', row['Website_Link'], ''
            res.flags.append(f'blocked:{e}')
        except HostStopped as e:
            link_status, rti_url, html = 'DEAD', row['Website_Link'], ''
            res.flags.append(f'host_stopped:{e}')
        res.link_status, res.rti_url = link_status, rti_url
        sources, file_bytes = [], {}
        if link_status in ('POPULATED', 'BLANK', 'REVIEW', 'FILE_LIST') and html:
            owner = self.own_hosts.get(urlsplit(rti_url).hostname)
            if owner and owner != key:
                res.status, res.manual_reason = 'manual_needed', 'shared_page'
                res.flags.append(f'shared_page:{owner}')
                return self._finish(row, res)
            sources, file_bytes = self.acquire(row, res, rti_url, html)
        elif link_status == 'FILE':
            status, final, ctype, data = self._get(rti_url, res, cap=files.FILE_CAP)
            parsed = self._parse_file(row, res, data, final, ctype) if status == 200 and data else None
            if parsed:
                fp, meta, info = parsed
                file_bytes[final] = data
                self._log_recovery(row, final, fp)
                sources.append(Source('file', final, page=fp, meta=meta))
        if not sources and self.allow_archive and link_status in ('BLOCKED_BY_ROBOTS', 'DEAD'):
            arch = self.archive_source(row, row['Website_Link'], res)
            if arch:
                sources.append(arch)
        for src in sources:
            if src.kind == 'live' and link_status == 'BLANK' and src.page is not None and not src.page.roles:
                src.page.flags.append('widget_blank')      # the owner's classifier: officer widget present, empty
        if self.llm and sources:
            sources = sources + self.llm.assist(row, sources, res)
        if not sources:
            res.status = {'BLOCKED_BY_ROBOTS': 'blocked_robots', 'DEAD': 'manual_needed'}.get(link_status, 'no_rti_page')
            res.manual_reason = {'BLOCKED_BY_ROBOTS': 'robots', 'DEAD': 'dead'}.get(link_status, 'no_rti_page')
            return self._finish(row, res)
        reader = self.second_reader_factory(file_bytes) if self.second_reader_factory else None
        d = assemble.decide(row, sources, host=host, second_reader=reader,
                            verify_photo=self.photo_verifier(res), log=lambda **kw: self.log(row=key, **kw))
        if self.llm:
            d.review.extend(self.llm.take_review())
        d.review.extend(res.scan_review)
        res.decision, res.sources = d, sources
        if d.status in ('complete', 'partial', 'sparse') and rti_url and rti_url != row['Website_Link'] \
                and link_status in ('POPULATED', 'REVIEW'):
            if not any(r['Website_Link'].rstrip('/').lower() == rti_url.rstrip('/').lower() for r in self.rows):
                d.values['Website_Link'] = rti_url
        res.status = d.status
        if res.status == 'no_rti_page' and link_status == 'BLANK':
            res.status = 'page_blank'            # the official page exists and lists no officer (widget empty)
        if any(s.kind == 'file' for s in sources) and not any(s.kind == 'live' and s.page.roles for s in sources):
            res.status = res.status if d.metrics.get('roles_found') else 'file_only'
        if res.scan_review and not d.metrics.get('roles_found'):
            res.status, res.manual_reason = 'file_only', 'scanned_file_ocr_candidates'
        if any('bijoy_garbled' in s.page.flags for s in sources if s.page is not None) and not d.metrics['roles_found']:
            res.manual_reason = 'bijoy_garbled'
        if not self.dry_run:
            res.changes = csvio.merge_row(row, d.values, self.today)
            for colname, old, new in res.changes:
                self.log(event='cell_written', row=key, column=colname, previous=old, written=new,
                         **{k: v for k, v in d.provenance.get(colname, {}).items() if k in ('source', 'url', 'method')})
        return self._finish(row, res)

    def apply_sources(self, row, sources, status_hint='imported'):
        """Decide + merge for sources that were not fetched by this tool (S0 overrides, S4 saved pages, S5 export)."""
        key = csvio.row_key(row)
        res = RowResult(key, status='')
        res.requests = 0
        blank_changes = []
        for src in sources:
            if src.kind == 'human_confirmed':
                for role in ROLES:
                    has_role = any(k[0] == role for k in src.values)
                    cur = row[f'{assemble.COL_ROLE[role]}_Officer_Name']
                    if has_role and (role, 'Officer_Name') not in src.values and cur:
                        src.values[(role, 'Officer_Name')] = cur
                # Deliberate blanking (S0 <BLANK> override, importers.BLANK_SENTINEL): applied directly here, not
                # through assemble.decide()'s candidate pipeline, which structurally assumes every value is
                # non-empty (validate() refuses an empty string; the whole gating/person-matching pass is built
                # around comparing and choosing between real values). This is the one deliberate, audited,
                # human-confirmed exception to csvio.merge_row's "empty never overwrites" rule (R1) -- every other
                # source, always, is still bound by it.
                for role, field in sorted(src.blanks):
                    colname = assemble.col(role, field)
                    if row.get(colname):
                        blank_changes.append((colname, row[colname], ''))
                        row[colname] = ''
            if src.page is not None:
                self._log_recovery(row, src.url, src.page)
        host = urlsplit(row['Website_Link']).hostname or ''
        d = assemble.decide(row, sources, host=host, verify_photo=self.photo_verifier(res),
                            log=lambda **kw: self.log(row=key, **kw))
        res.decision, res.sources, res.status = d, sources, d.status or status_hint
        res.rti_url = sources[0].url if sources else ''
        if not self.dry_run:
            res.changes = csvio.merge_row(row, d.values, self.today) + blank_changes
            if blank_changes and self.today:
                row['Last_Updated'] = self.today
            for colname, old, new in res.changes:
                self.log(event='cell_written', row=key, column=colname, previous=old, written=new,
                         **{k: v for k, v in d.provenance.get(colname, {}).items() if k in ('source', 'url', 'method')}
                         or ({'source': 'human_confirmed', 'url': sources[0].url, 'method': 'human'}
                             if (colname, old, new) in blank_changes else {}))
        return self._finish(row, res)

    def finalize(self):
        """8.6 placeholders across bodies, 7.5 same officers on several rows, then reports.

        8.6's own first sentence is the real test: the same URL under two roles with DIFFERENT names is a
        placeholder/logo and is blanked (photos.py already does this per-row). The ">= 3 bodies" heuristic is a
        proxy for that -- but a real person's own photo legitimately recurs >= 3 times whenever they hold an
        ex-officio role for several offices (a divisional commissioner is the RTI appellate authority for every
        district in their division: same person, same real photo, by design -- verified against live pages in
        Tier 4). So a URL is only a placeholder here when the occurrences do NOT all share one officer name;
        same-name occurrences are never blanked, however many bodies they span.
        """
        from collections import defaultdict
        by_url, by_sha = defaultdict(list), defaultdict(list)
        for r in self.rows:
            for R in assemble.COL_ROLE.values():
                u = r[f'{R}_Image_URL']
                if u:
                    by_url[u].append((csvio.row_key(r), R, squash(r[f'{R}_Officer_Name'])))
        sha_of = dict(self.state.db.execute('SELECT url, sha256 FROM photos'))
        for u, entries in by_url.items():
            sha = sha_of.get(u)
            if sha:
                by_sha[sha].extend(entries)

        def placeholder_group(entries):
            """>= 3 occurrences AND not all the same officer name -> placeholder."""
            names = {n for _, _, n in entries if n}
            return len(entries) >= 3 and len(names) > 1

        placeholder_urls = {u for u, entries in by_url.items() if placeholder_group(entries)}
        for sha, entries in by_sha.items():
            if placeholder_group(entries):
                placeholder_urls |= {u for u, s in sha_of.items() if s == sha}

        blanked = []
        for r in self.rows:
            for R in assemble.COL_ROLE.values():
                if r[f'{R}_Image_URL'] in placeholder_urls:
                    blanked.append((csvio.row_key(r), R, r[f'{R}_Image_URL']))
                    self.log(event='placeholder_blanked', row=csvio.row_key(r), role=R, url=r[f'{R}_Image_URL'])
                    r[f'{R}_Image_URL'] = ''
        people = defaultdict(list)
        for r in self.rows:
            sig = tuple(squash(r[f'{R}_Officer_Name']) for R in assemble.COL_ROLE.values())
            if any(sig):
                people[sig].append(csvio.row_key(r))
        shared = [ks for ks in people.values() if len(ks) > 1]
        with open(self.out / 'placeholder_photos.csv', 'w', encoding='utf-8') as fh:
            fh.write('row_key,role,url\n' + ''.join(f'"{k}",{R},{u}\n' for k, R, u in blanked))
        with open(self.out / 'same_officers_rows.csv', 'w', encoding='utf-8') as fh:
            fh.write('rows\n' + ''.join('"' + ' || '.join(ks) + '"\n' for ks in shared))
        self.save()
        return blanked, shared

    def _log_recovery(self, row, url, page):
        for e in page.recovery:
            self.recovery_log(row=csvio.row_key(row), url=url, **e)

    def _finish(self, row, res):
        d = res.decision
        flags = list(res.flags) + (d.flags if d else [])
        for s in res.sources:
            if s.page is not None:
                flags += s.page.flags
        res.flags = sorted(set(flags))
        self.state.put(res.row_key, res.status, rti_url=res.rti_url,
                       metrics=(d.metrics if d else {}), flags=res.flags,
                       retry_in=6 * 3600 if res.status in ('manual_needed',) and res.manual_reason == 'dead' else 0)
        self.results[res.row_key] = res
        self.log(event='row_done', row=res.row_key, status=res.status, link_status=res.link_status,
                 requests=res.requests, changes=len(res.changes), flags=res.flags[:30])
        return res

    # ------------------------------------------------------------------ run
    def run(self, rows, workers=1, save_every=10):
        by_host = {}
        for r in rows:
            by_host.setdefault(urlsplit(r['Website_Link']).hostname, []).append(r)
        done = 0
        if workers <= 1:
            for r in rows:
                self._safe_row(r)
                done += 1
                if done % save_every == 0:
                    self.save()
        else:
            from concurrent.futures import ThreadPoolExecutor

            def host_job(rs):
                for r in rs:
                    self._safe_row(r)
            with ThreadPoolExecutor(max_workers=workers) as ex:
                futs = [ex.submit(host_job, rs) for rs in by_host.values()]
                for i, f in enumerate(futs, 1):
                    f.result()
                    if i % save_every == 0:
                        self.save()
        self.save()
        return self.results

    def _safe_row(self, r):
        try:
            return self.process_row(r)
        except Exception as e:
            key = csvio.row_key(r)
            self.log(event='row_error', row=key, error=f'{type(e).__name__}: {str(e)[:300]}')
            self.state.put(key, 'error', flags=[f'error:{type(e).__name__}'], retry_in=3600)

    def save(self):
        if not self.dry_run:
            csvio.write_csv_atomic(self.filled_path, self.rows, backup_dir=self.filled_path.parent / 'backups')
        reports.write_all(self)
