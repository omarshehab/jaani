"""Tests 18 (SSRF) and 19 (robots)."""
import httpcore
import httpx
import pytest

from jaani_scraper import net
from jaani_scraper.netguard import Blocked, GuardedBackend, Policy, is_public_ip


def fetcher_with(handler, policy=None):
    policy = policy or Policy()
    client = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)
    return net.GuardedFetcher('JAANI-RTI-DirectoryBot/2.0 (+mailto:test@example.org)', delay=0, policy=policy,
                              client=client, sleep=lambda s: None)


@pytest.mark.parametrize('url,reason', [
    ('http://127.0.0.1/x', 'host_suffix_not_allowed'),
    ('http://169.254.169.254/latest/meta-data', 'host_suffix_not_allowed'),
    ('https://example.com/views/info-officers', 'host_suffix_not_allowed'),
    ('https://moha.gov.bd:8080/views/info-officers', 'port_not_allowed'),
    ('ftp://moha.gov.bd/', 'scheme_not_allowed'),
    ('https://user:pw@moha.gov.bd/', 'credentials_in_url'),
    ('https://dgfi.gov.bd/', 'deny_host'),
    ('https://www.mha.gov.bd/x', 'deny_host'),
    ('https://itiiu.portal.gov.bd/', 'manual_review_host'),
    ('https://evilgov.bd/', 'host_suffix_not_allowed'),
])
def test_static_policy_refusals(url, reason):
    with pytest.raises(Blocked, match=reason):
        Policy().check_url(url)


def test_allowed_page_and_image_hosts():
    p = Policy()
    assert p.check_url('https://moha.gov.bd/views/info-officers') == 'moha.gov.bd'
    img = ('https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/axvjbnqprylg/b/V2Ministry/o/'
           'office-moha/2026/5/971da9f9.jpg')
    assert p.check_url(img, kind='image')
    with pytest.raises(Blocked):
        p.check_url(img, kind='page')
    with pytest.raises(Blocked):
        p.check_url('https://objectstorage.x.oraclecloud15.com/n/a/b/Other/o/office-x/1.jpg', kind='image')


@pytest.mark.parametrize('target', ['http://127.0.0.1/admin', 'http://169.254.169.254/latest/meta-data',
                                    'https://example.com/', 'https://moha.gov.bd:8080/'])
def test_redirect_to_forbidden_target_is_refused_before_any_request(target):
    seen = []

    def handler(req):
        seen.append(str(req.url))
        return httpx.Response(302, headers={'location': target})
    f = fetcher_with(handler)
    with pytest.raises(Blocked):
        f.fetch('https://moha.gov.bd/views/info-officers')
    assert seen == ['https://moha.gov.bd/views/info-officers']


def test_redirect_cap():
    def handler(req):
        n = int(req.url.params.get('n', '0'))
        return httpx.Response(302, headers={'location': f'https://moha.gov.bd/r?n={n + 1}'})
    with pytest.raises(Blocked, match='too_many_redirects'):
        fetcher_with(handler).fetch('https://moha.gov.bd/r?n=0')


@pytest.mark.parametrize('addr', ['127.0.0.1', '10.1.2.3', '192.168.0.5', '169.254.169.254', '100.64.0.1',
                                  '::1', '::ffff:127.0.0.1', 'fc00::1', '0.0.0.0'])
def test_dns_answer_with_private_address_is_refused_at_connect(addr):
    backend = GuardedBackend(Policy(), resolver=lambda host, port: [addr])
    with pytest.raises(Blocked, match='private_address'):
        backend.connect_tcp('rebind.gov.bd', 443)


def test_public_address_classification():
    assert is_public_ip('103.48.16.10')
    assert not is_public_ip('172.16.0.1')


def test_guarded_client_refuses_private_dns_end_to_end():
    client = net.build_client(Policy(), resolver=lambda host, port: ['127.0.0.1'])
    with pytest.raises(Blocked):
        client.get('https://rebind.gov.bd/views/info-officers')


def test_robots_disallow_means_zero_page_requests():
    def handler(req):
        if req.url.path == '/robots.txt':
            return httpx.Response(200, text='User-agent: *\nDisallow: /\n')
        return httpx.Response(200, text='<h3>দায়িত্বপ্রাপ্ত কর্মকর্তা</h3>')
    f = fetcher_with(handler)
    res = net.check_row(f, {'Website_Link': 'https://blocked.gov.bd/views/info-officers'})
    assert res['status'] == 'BLOCKED_BY_ROBOTS'
    assert [u for m, u in f.requests if not u.endswith('/robots.txt')] == []


@pytest.mark.parametrize('code,expected', [(404, True), (410, True), (401, False), (403, False)])
def test_robots_status_codes(code, expected):
    f = fetcher_with(lambda req: httpx.Response(code))
    assert f.allowed('https://x.gov.bd/views/info-officers') is expected


def test_robots_5xx_skips_host():
    f = fetcher_with(lambda req: httpx.Response(500))
    assert f.allowed('https://x.gov.bd/views/info-officers') is None


def test_crawl_delay_is_honoured():
    f = fetcher_with(lambda req: httpx.Response(200, text='User-agent: *\nCrawl-delay: 60\nAllow: /\n'))
    f.delay = 3
    assert f.allowed('https://slow.gov.bd/views/info-officers') is True
    assert f.host_delay['slow.gov.bd'] == 60


def test_429_backs_off_then_stops_host():
    waits = []
    f = fetcher_with(lambda req: httpx.Response(429))
    f.sleep = waits.append
    with pytest.raises(net.HostStopped):
        f.fetch('https://busy.gov.bd/views/info-officers')
    assert [w for w in waits if w >= 30] == [30, 120, 600]


def test_user_agent_requires_contact():
    with pytest.raises(SystemExit):
        net.user_agent('')
    assert net.user_agent('a@b.org') == 'JAANI-RTI-DirectoryBot/2.0 (+mailto:a@b.org)'


def test_redirect_does_not_leak_response_headers_into_next_request():
    sent = []

    def handler(req):
        sent.append(dict(req.headers))
        if req.url.path == '/a':
            return httpx.Response(302, headers={'location': '/b', 'content-length': '86', 'x-cache': 'HIT'}, content=b'x' * 86)
        return httpx.Response(200, text='ok')
    f = fetcher_with(handler)
    st, url, h, body = f.fetch('https://moha.gov.bd/a')
    assert st == 200 and url == 'https://moha.gov.bd/b'
    assert 'x-cache' not in sent[1] and sent[1].get('content-length') in (None, '0')
