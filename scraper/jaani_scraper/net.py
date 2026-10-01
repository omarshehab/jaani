"""Network layer (section 3), built on s3/verify_links.py's Fetcher: its robots.txt rules, per-host delay and
row checker are reused unchanged; this subclass swaps urllib for a guarded httpx client, follows redirects
by hand (each hop validated), honours Crawl-delay, backs off on 429/503 and trips a per-host breaker."""
import email.message
import io
import ssl
import sys
import threading
import time
import urllib.error
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import certifi
import httpcore
import httpx

from .netguard import Blocked, GuardedBackend, Policy, is_public_ip

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 's3'))
import verify_links  # noqa: E402  (the owner's tested checker; reused, not copied)

MAX_REDIRECTS = 5
HTML_CAP = 3_000_000
FILE_CAP = 15 * 1024 * 1024
BACKOFF = (30, 120, 600)


def user_agent(contact):
    if not contact or '@' not in contact:
        raise SystemExit('JAANI_CONTACT_EMAIL must be set to a real address (it goes in the User-Agent).')
    return f'JAANI-RTI-DirectoryBot/2.0 (+mailto:{contact})'


def build_client(policy, insecure=False, resolver=None, transport=None, connect=10, read=30):
    if transport is None:
        ctx = ssl.create_default_context(cafile=certifi.where())
        if insecure:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        transport = httpx.HTTPTransport(verify=ctx, retries=0)
        backend = GuardedBackend(policy, **({'resolver': resolver} if resolver else {}))
        transport._pool = httpcore.ConnectionPool(ssl_context=ctx, network_backend=backend, http1=True, http2=False)
    else:
        ctx = None
    client = httpx.Client(transport=transport, follow_redirects=False, timeout=httpx.Timeout(read, connect=connect))
    client.jaani_ssl_context = ctx
    return client


# ---------------------------------------------------------------------------------------------- incomplete TLS chains
# Several gov.bd servers send only their own certificate, without the CA intermediate. Browsers fetch the missing
# intermediate from the certificate's "CA Issuers" (AIA) URL; this does the same, and verification stays ON: the
# intermediate is only accepted if it is a CA certificate that actually issued the server certificate, and the
# chain is then verified to a trusted root as usual.
MISSING_ISSUER = 'unable to get local issuer certificate'


def aia_issuer_urls(der):
    from cryptography import x509
    from cryptography.x509.oid import AuthorityInformationAccessOID, ExtensionOID
    cert = x509.load_der_x509_certificate(der)
    try:
        aia = cert.extensions.get_extension_for_oid(ExtensionOID.AUTHORITY_INFORMATION_ACCESS).value
    except x509.ExtensionNotFound:
        return cert, []
    return cert, [d.access_location.value for d in aia
                  if d.access_method == AuthorityInformationAccessOID.CA_ISSUERS]


def server_leaf_der(host, policy, port=443):
    """The server's own certificate (no verification: it is only read to find its issuer), via a checked address."""
    from .netguard import resolve
    import socket
    addrs = resolve(host, port)
    if not policy.allow_private and any(not is_public_ip(a) for a in addrs):
        raise Blocked(f'private_address: {host}')
    raw = ssl.create_default_context()
    raw.check_hostname = False
    raw.verify_mode = ssl.CERT_NONE
    with socket.create_connection((addrs[0], port), timeout=10) as sock:
        with raw.wrap_socket(sock, server_hostname=host) as tls:
            return tls.getpeercert(binary_form=True)


def fetch_issuer(url, leaf, policy):
    """Download the AIA intermediate (a public URL named in the certificate) and check it really issued `leaf`."""
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    from .netguard import resolve
    u = urlsplit(url)
    if u.scheme not in ('http', 'https') or not u.hostname:
        return None
    addrs = resolve(u.hostname, u.port or (443 if u.scheme == 'https' else 80))
    if any(not is_public_ip(a) for a in addrs):
        raise Blocked(f'private_address: {u.hostname}')
    r = httpx.get(url, timeout=15, follow_redirects=False)
    if r.status_code != 200 or len(r.content) > 20000:
        return None
    try:
        issuer = x509.load_der_x509_certificate(r.content)
    except ValueError:
        issuer = x509.load_pem_x509_certificate(r.content)
    bc = issuer.extensions.get_extension_for_class(x509.BasicConstraints).value
    if not bc.ca or issuer.subject != leaf.issuer:
        return None
    leaf.verify_directly_issued_by(issuer)          # raises if the signature does not match
    return issuer.public_bytes(serialization.Encoding.PEM).decode()


class HostStopped(Exception):
    pass


class _Resp:
    """The small slice of urllib's response API that verify_links.Fetcher uses."""

    def __init__(self, status, url, headers, body):
        self.status, self._url, self._body = status, url, body
        self.headers = email.message.Message()
        for k, v in headers.items():
            self.headers[k] = v

    def read(self, n=-1):
        return self._body if n < 0 else self._body[:n]

    def geturl(self):
        return self._url

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class GuardedFetcher(verify_links.Fetcher):
    def __init__(self, ua, delay=3.0, timeout=30, policy=None, client=None, insecure_hosts=(), log=None,
                 sleep=time.sleep):
        super().__init__(ua, delay, timeout)
        self.policy = policy or Policy()
        self.client = client or build_client(self.policy, read=timeout)
        self.insecure_hosts = set(insecure_hosts)
        self._insecure_client = None
        self.log = log or (lambda **kw: None)
        self.sleep = sleep
        self.host_delay, self.fail_count, self.stopped = {}, {}, {}
        self.lock = threading.Lock()
        self.requests = []          # (method, url) of every request actually sent (tests use this)

    # --- rate limit: Crawl-delay aware, otherwise the parent's fixed delay
    def _wait(self, host):
        delay = max(self.delay, self.host_delay.get(host, 0))
        gap = delay - (time.time() - self.last.get(host, 0))
        if gap > 0:
            self.sleep(gap)
        self.last[host] = time.time()

    def _client_for(self, host):
        if host in self.insecure_hosts:
            if self._insecure_client is None:
                self._insecure_client = build_client(self.policy, insecure=True, read=self.timeout)
            self.log(event='insecure_tls', host=host)
            return self._insecure_client
        return self.client

    def fetch(self, url, method='GET', kind='page', cap=HTML_CAP, headers=None):
        """One logical request: redirects followed by hand, each hop policy-checked. Returns (status, final_url,
        headers, body bytes). Raises Blocked / HostStopped / httpx errors."""
        hops = 0
        while True:
            self.policy.check_url(url, kind=kind)
            host = urlsplit(url).netloc
            if self.stopped.get(host, 0) > time.time():
                raise HostStopped(host)
            self._wait(host)
            h = {'User-Agent': self.ua, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.5',
                 'Accept-Language': 'bn,en;q=0.7'}
            h.update(headers or {})
            self.requests.append((method, url))
            resp_cm, r = self._open_stream(method, url, h)
            try:
                body = b''
                # A redirect only needs its headers; some gov.bd servers send 3xx bodies shorter than their declared
                # Content-Length, which the HTTP parser rejects. Page bodies are still read strictly.
                if method != 'HEAD' and r.status_code not in (301, 302, 303, 307, 308):
                    for chunk in r.iter_bytes():
                        body += chunk
                        if len(body) > cap:
                            body = body[:cap]
                            break
                self.log(event='fetch', url=url, status=r.status_code, bytes=len(body))
                status, resp_headers = r.status_code, dict(r.headers)
            finally:
                resp_cm.__exit__(None, None, None)
            if status in (301, 302, 303, 307, 308) and resp_headers.get('location'):
                hops += 1
                if hops > MAX_REDIRECTS:
                    raise Blocked('too_many_redirects')
                url = urljoin(url, resp_headers['location'])
                if status == 303 and method != 'HEAD':
                    method = 'GET'
                continue
            if status in (429, 503):
                self._backoff(host, resp_headers.get('retry-after'))
                continue
            self.fail_count[host] = 0
            return status, url, resp_headers, body

    def _open_stream(self, method, url, headers):
        """Open a streamed response; if the server's TLS chain lacks its intermediate, complete it (AIA) and retry."""
        host = urlsplit(url).hostname
        for attempt in (1, 2):
            cm = self._client_for(host).stream(method, url, headers=headers)
            try:
                return cm, cm.__enter__()
            except httpx.ConnectError as e:
                if attempt == 1 and MISSING_ISSUER in str(e) and self._complete_chain(host):
                    continue
                raise

    def _complete_chain(self, host):
        """Add the missing intermediate named in the server's certificate (once per issuer); True if added."""
        ctx = getattr(self.client, 'jaani_ssl_context', None)
        if ctx is None:
            return False
        done = getattr(self, '_aia_done', None)
        if done is None:
            done = self._aia_done = {}
        if host in done:
            return done[host]
        ok = False
        try:
            leaf, urls = aia_issuer_urls(server_leaf_der(host, self.policy))
            for u in urls:
                pem = fetch_issuer(u, leaf, self.policy)
                if pem:
                    ctx.load_verify_locations(cadata=pem)
                    self.log(event='tls_chain_completed', host=host, issuer=str(leaf.issuer)[:120], aia=u)
                    ok = True
                    break
        except Exception as e:
            self.log(event='tls_chain_completion_failed', host=host, error=f'{type(e).__name__}: {str(e)[:160]}')
        done[host] = ok
        return ok

    def _backoff(self, host, retry_after):
        n = self.fail_count.get(host, 0)
        if n >= len(BACKOFF):
            self.stopped[host] = time.time() + 6 * 3600
            self.log(event='host_stopped', host=host, reason='429/503')
            raise HostStopped(host)
        self.fail_count[host] = n + 1
        try:
            wait = min(float(retry_after), 600) if retry_after else BACKOFF[n]
        except ValueError:
            wait = BACKOFF[n]
        self.log(event='backoff', host=host, seconds=wait)
        self.sleep(wait)

    def note_failure(self, host):
        """Circuit breaker: 3 consecutive network failures stop the host for this run (+6 h retry)."""
        n = self.fail_count.get(host, 0) + 1
        self.fail_count[host] = n
        if n >= 3:
            self.stopped[host] = time.time() + 6 * 3600
            self.log(event='host_stopped', host=host, reason='3 consecutive failures')

    # --- verify_links.Fetcher compatibility: robots.txt + check_row keep working unchanged
    def _kind(self, kind):
        fetcher = self

        class _K:
            def __enter__(self):
                fetcher._open_kind = kind

            def __exit__(self, *a):
                fetcher._open_kind = 'page'
        return _K()

    def _open(self, url):
        status, final, headers, body = self.fetch(url, kind=getattr(self, '_open_kind', 'page'))
        if status >= 400:
            raise urllib.error.HTTPError(final, status, 'error', email.message.Message(), io.BytesIO(b''))
        return _Resp(status, final, headers, body)

    def allowed(self, url, kind='page'):
        self.policy.check_url(url, kind=kind)   # a policy refusal is reported as such, never as a robots refusal
        with self._kind(kind):
            ok = super().allowed(url)
        u = urlsplit(url)
        rp, status = self.robots[f'{u.scheme}://{u.netloc}']
        if status == 'ok':
            cd = rp.crawl_delay(self.ua) or rp.crawl_delay('*')
            if cd:
                self.host_delay[u.netloc] = max(self.delay, float(cd))
        return ok

    def get(self, url, kind='page', cap=HTML_CAP):
        status, final, headers, body = self.fetch(url, kind=kind, cap=cap)
        ctype = headers.get('content-type', '')
        charset = 'utf-8'
        if 'charset=' in ctype.lower():
            charset = ctype.lower().split('charset=')[-1].split(';')[0].strip() or 'utf-8'
        try:
            text = body.decode(charset, 'replace')
        except LookupError:
            text = body.decode('utf-8', 'replace')
        return status, final, ctype, text


def check_row(fetcher, row):
    """P1: the owner's verify_links.check_row with the guarded fetcher."""
    try:
        return verify_links.check_row(fetcher, row)
    except Blocked as e:
        return dict(status='DEAD', final_url=row['Website_Link'], roles=0, names=0, note=f'blocked: {e}',
                    tried=[], used=row['Website_Link'])
    except HostStopped as e:
        return dict(status='DEAD', final_url=row['Website_Link'], roles=0, names=0, note=f'host stopped: {e}',
                    tried=[], used=row['Website_Link'])
