"""Incomplete server chains: an AIA intermediate is accepted only if it is a CA that really issued the leaf."""
import datetime

import httpx
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from jaani_scraper import net
from jaani_scraper.netguard import Policy


def _cert(subject, issuer, key, sign_key, ca):
    now = datetime.datetime(2026, 1, 1)
    b = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, subject)]))
         .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, issuer)])).public_key(key.public_key())
         .serial_number(x509.random_serial_number()).not_valid_before(now).not_valid_after(now + datetime.timedelta(days=90))
         .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True))
    return b.sign(sign_key, hashes.SHA256())


@pytest.fixture
def chain():
    ik, lk, ok = (ec.generate_private_key(ec.SECP256R1()) for _ in range(3))
    inter = _cert('Test CA DV', 'Test Root', ik, ik, ca=True)
    leaf = _cert('mof.gov.bd', 'Test CA DV', lk, ik, ca=False)
    impostor = _cert('Test CA DV', 'Test Root', ok, ok, ca=True)
    not_ca = _cert('Test CA DV', 'Test Root', ik, ik, ca=False)
    return leaf, inter, impostor, not_ca


def _serve(monkeypatch, cert):
    der = cert.public_bytes(serialization.Encoding.DER)
    monkeypatch.setattr(net.httpx, 'get', lambda url, **k: httpx.Response(200, content=der))
    monkeypatch.setattr('jaani_scraper.netguard.resolve', lambda h, p: ['93.184.216.34'])


def test_real_issuer_is_accepted(monkeypatch, chain):
    leaf, inter, _, _ = chain
    _serve(monkeypatch, inter)
    assert 'BEGIN CERTIFICATE' in net.fetch_issuer('http://crt.example.com/ca.crt', leaf, Policy())


def test_impostor_with_same_name_is_refused(monkeypatch, chain):
    leaf, _, impostor, _ = chain
    _serve(monkeypatch, impostor)
    with pytest.raises(Exception):
        net.fetch_issuer('http://crt.example.com/ca.crt', leaf, Policy())


def test_non_ca_certificate_is_refused(monkeypatch, chain):
    leaf, _, _, not_ca = chain
    _serve(monkeypatch, not_ca)
    assert net.fetch_issuer('http://crt.example.com/ca.crt', leaf, Policy()) is None


def test_aia_host_resolving_private_is_refused(monkeypatch, chain):
    leaf, inter, _, _ = chain
    _serve(monkeypatch, inter)
    monkeypatch.setattr('jaani_scraper.netguard.resolve', lambda h, p: ['10.0.0.5'])
    with pytest.raises(net.Blocked):
        net.fetch_issuer('http://crt.example.com/ca.crt', leaf, Policy())
