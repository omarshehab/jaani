"""SSRF policy (rule R5): scheme, port, host suffix, deny lists, and DNS results checked at connect time.

The check runs inside the connection layer (GuardedBackend), so every redirect hop and every retry is
resolved, judged and connected to the exact address that passed; a name that re-resolves to a private
address between check and connect (DNS rebinding) is still refused.
"""
import ipaddress
import re
import socket
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import httpcore
from httpcore._backends.sync import SyncStream

CONFIG = Path(__file__).resolve().parents[1] / 'config'
IMAGE_HOST_RE = re.compile(r'^objectstorage\.[a-z0-9-]+\.oraclecloud\d*\.com$')
IMAGE_PATH_RE = re.compile(r'^/n/[^/]+/b/V2Ministry/o/office-[^/]+/')


class Blocked(Exception):
    """A URL or connection refused by policy. Never retried."""


def _lines(name):
    p = CONFIG / name
    if not p.exists():
        return []
    return [ln.strip() for ln in p.read_text(encoding='utf-8').splitlines()
            if ln.strip() and not ln.lstrip().startswith('#')]


@dataclass
class Policy:
    allowed_suffixes: list = field(default_factory=lambda: _lines('allowed_host_suffixes.txt'))
    deny_hosts: set = field(default_factory=lambda: set(_lines('deny_hosts.txt')))
    manual_hosts: set = field(default_factory=lambda: set(_lines('manual_review_hosts.txt')))
    allowed_ports: frozenset = frozenset({80, 443})
    allow_private: bool = False          # tests only (mirrors ALLOW_PRIVATE_NETWORK_URLS)

    def host_listed(self, host, names):
        host = host.lower().rstrip('.')
        return any(host == h or host.endswith('.' + h) for h in names)

    def check_url(self, url, kind='page'):
        """Static checks (no DNS). Raises Blocked with a reason."""
        try:
            u = urlsplit(url)
            port = u.port
        except ValueError as e:
            raise Blocked(f'bad_url: {e}')
        if u.scheme not in ('http', 'https'):
            raise Blocked(f'scheme_not_allowed: {u.scheme}')
        host = (u.hostname or '').lower().rstrip('.')
        if not host:
            raise Blocked('no_host')
        if u.username or u.password:
            raise Blocked('credentials_in_url')
        port = port or (443 if u.scheme == 'https' else 80)
        if port not in self.allowed_ports:
            raise Blocked(f'port_not_allowed: {port}')
        if self.host_listed(host, self.deny_hosts):
            raise Blocked(f'deny_host: {host}')
        if self.host_listed(host, self.manual_hosts):
            raise Blocked(f'manual_review_host: {host}')
        if kind == 'image' and IMAGE_HOST_RE.match(host) and IMAGE_PATH_RE.match(u.path):
            return host
        if kind == 'archive' and host == 'web.archive.org':
            return host
        if not any(host.endswith(s) or host == s.lstrip('.') for s in self.allowed_suffixes):
            raise Blocked(f'host_suffix_not_allowed: {host}')
        return host


def is_public_ip(ip):
    ip = ipaddress.ip_address(ip)
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def resolve(host, port):
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [i[4][0] for i in infos]


class GuardedBackend(httpcore.SyncBackend):
    """httpcore network backend: resolve, refuse private/reserved addresses, connect to the checked address."""

    def __init__(self, policy, resolver=resolve):
        self.policy, self.resolver = policy, resolver

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        try:
            addrs = self.resolver(host, port)
        except OSError as e:
            raise httpcore.ConnectError(f'dns_failed: {host}: {e}')
        if not addrs:
            raise httpcore.ConnectError(f'dns_empty: {host}')
        if not self.policy.allow_private:
            bad = [a for a in addrs if not is_public_ip(a)]
            if bad:
                raise Blocked(f'private_address: {host} -> {bad[0]}')
        last = None
        for addr in addrs:
            try:
                sock = socket.create_connection((addr, port), timeout=timeout)
                for opt in socket_options or []:
                    sock.setsockopt(*opt)
                return SyncStream(sock)
            except OSError as e:
                last = e
        raise httpcore.ConnectError(f'connect_failed: {host}: {last}')
