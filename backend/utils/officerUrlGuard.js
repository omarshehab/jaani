/**
 * SSRF guard for the on-demand officer scrape (Section 3, brief 15.9): scheme, port, allowed host suffix, and the
 * DNS answer checked for every URL and every redirect hop; the connection is pinned to the checked address through
 * axios' `lookup`. The address classification is liveProxyReader's (isLocalHostname / isPrivateOrReservedIp, the
 * same helpers egressGuardProxy.resolvePublic uses); api.js additionally runs validateExternalHttpUrl on the first URL.
 */
const dns = require('dns').promises;
const net = require('net');
const { isLocalHostname, isPrivateOrReservedIp } = require('../services/liveProxyReader');

const DEFAULT_SUFFIXES = ['.gov.bd', '.org.bd', '.ac.bd', '.edu.bd'];
const IMAGE_HOST_RE = /^objectstorage\.[a-z0-9-]+\.oraclecloud\d*\.com$/i;
const IMAGE_PATH_RE = /^\/n\/[^/]+\/b\/V2Ministry\/o\/office-[^/]+\//;
const MAX_REDIRECTS = 5;

function createOfficerUrlGuard({
  allowPrivateNetwork = false,
  suffixes = (process.env.OFFICER_HOST_SUFFIXES || '').split(',').map((s) => s.trim()).filter(Boolean),
  resolve = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address),
  log = (msg) => console.warn(msg),
} = {}) {
  const allowedSuffixes = suffixes.length ? suffixes : DEFAULT_SUFFIXES;

  const refuse = (url, reason) => {
    let host = '';
    try { host = new URL(url).host; } catch { host = String(url).slice(0, 80); }
    log(`🛑 [Section3] officer URL refused: ${host} (${reason})`);
    return { ok: false, reason };
  };

  /** Static + DNS check. kind 'image' also allows the national portal's object storage. */
  async function check(rawUrl, { kind = 'page' } = {}) {
    let u;
    try { u = new URL(String(rawUrl || '').trim()); } catch { return refuse(rawUrl, 'invalid URL'); }
    if (!['http:', 'https:'].includes(u.protocol)) return refuse(rawUrl, `scheme ${u.protocol}`);
    if (u.username || u.password) return refuse(rawUrl, 'credentials in URL');
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    // Tests only: ALLOW_PRIVATE_NETWORK_URLS=true lets the local mock portal (loopback, any port) through.
    const testLoopback = allowPrivateNetwork && (host === '127.0.0.1' || host === 'localhost');
    if (!testLoopback) {
      const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      if (port !== 80 && port !== 443) return refuse(rawUrl, `port ${port}`);
      const imageHost = kind === 'image' && IMAGE_HOST_RE.test(host) && IMAGE_PATH_RE.test(u.pathname);
      if (!imageHost && !allowedSuffixes.some((s) => host.endsWith(s) || host === s.replace(/^\./, ''))) {
        return refuse(rawUrl, 'host suffix not allowed');
      }
      if (!allowPrivateNetwork && isLocalHostname(host)) return refuse(rawUrl, 'local hostname');
    }
    let addrs;
    try {
      addrs = net.isIP(host) ? [host] : await resolve(host);
    } catch (err) {
      return refuse(rawUrl, `dns ${err?.code || err?.message || err}`);
    }
    if (!addrs || !addrs.length) return refuse(rawUrl, 'no address');
    if (!allowPrivateNetwork && addrs.some((a) => isPrivateOrReservedIp(a))) {
      return refuse(rawUrl, 'private/reserved address');
    }
    return { ok: true, url: u.toString(), host, addrs };
  }

  /** axios `lookup`: resolve again at connect time and refuse private answers (DNS rebinding). */
  async function lookup(hostname) {
    const addrs = net.isIP(hostname) ? [hostname] : await resolve(hostname);
    if (!allowPrivateNetwork && (!addrs.length || addrs.some((a) => isPrivateOrReservedIp(a)))) {
      const err = new Error(`officer URL refused: ${hostname} resolves to a private/reserved address`);
      err.code = 'EOFFICERGUARD';
      throw err;
    }
    const address = addrs[0];
    return { address, family: net.isIPv6(address) ? 6 : 4 };
  }

  /**
   * GET with redirects followed by hand: every hop is checked before it is requested.
   * doGet(url, config) is the caller's request function (axiosGetWithGovTlsFallback).
   */
  async function getWithRedirects(url, doGet, config = {}, { kind = 'page' } = {}) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const verdict = await check(current, { kind });
      if (!verdict.ok) {
        const err = new Error(`officer URL refused: ${verdict.reason}`);
        err.code = 'EOFFICERGUARD';
        throw err;
      }
      const resp = await doGet(current, {
        ...config,
        maxRedirects: 0,
        lookup,
        validateStatus: (s) => (s >= 200 && s < 300) || (s >= 300 && s < 400),
      });
      if (resp.status >= 300 && resp.status < 400 && resp.headers?.location) {
        current = new URL(resp.headers.location, current).toString();
        continue;
      }
      if (resp.request && !resp.request.res) resp.request.res = {};
      if (resp.request?.res) resp.request.res.responseUrl = current;
      return resp;
    }
    const err = new Error('officer URL refused: too many redirects');
    err.code = 'EOFFICERGUARD';
    throw err;
  }

  return { check, lookup, getWithRedirects };
}

module.exports = { createOfficerUrlGuard, DEFAULT_SUFFIXES };
