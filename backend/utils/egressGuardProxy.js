/**
 * Local egress proxy that enforces Section 1's SSRF guard on EVERY connection a headless browser
 * makes — including redirect hops, which Playwright's page.route() never sees (verified: a public
 * redirector pointing at 127.0.0.1 reached the local server through a route-only guard).
 *
 * The browser is launched with `proxy: { server, bypass: '<-loopback>' }` ("<-loopback>" removes
 * Chromium's implicit proxy bypass for localhost). For each CONNECT (https) or absolute-form
 * request (http) the proxy resolves the host, rejects it if ANY address is private/reserved —
 * using liveProxyReader's own isLocalHostname / isPrivateOrReservedIp, not a new list — and then
 * connects to the exact address it checked, so DNS re-binding between check and connect is closed.
 *
 * Only the IP classification is shared with Section 1; this file is the enforcement plumbing.
 */

const http = require('http');
const net = require('net');
const dns = require('dns').promises;
const { isLocalHostname, isPrivateOrReservedIp } = require('../services/liveProxyReader');

async function resolvePublic(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h || isLocalHostname(h)) return null;
  if (net.isIP(h)) return isPrivateOrReservedIp(h) ? null : h;
  try {
    const addrs = await dns.lookup(h, { all: true, verbatim: true });
    if (!addrs.length || addrs.some((a) => isPrivateOrReservedIp(a.address))) return null;
    return addrs[0].address;
  } catch {
    return null;
  }
}

function splitHostPort(value, defaultPort) {
  const m = String(value || '').match(/^\[?([^\]]+?)\]?(?::(\d+))?$/);
  return m ? { host: m[1], port: Number(m[2] || defaultPort) } : { host: '', port: defaultPort };
}

/**
 * Start a proxy on a random loopback port.
 * @returns {Promise<{ server: string, blocked: string[], close: () => Promise<void> }>}
 */
async function startEgressGuardProxy({ onBlock } = {}) {
  // Long-lived proxies (the reader's) must not grow without bound: keep the last 200 blocks.
  const blocked = [];
  const recordBlock = (entry) => {
    blocked.push(entry);
    if (blocked.length > 200) blocked.shift();
    if (typeof onBlock === 'function') { try { onBlock(entry); } catch { /* ignore */ } }
  };
  const srv = http.createServer(async (req, res) => {
    // Plain http, absolute-form request line: GET http://host/path
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
    const ip = target.protocol === 'http:' ? await resolvePublic(target.hostname) : null;
    if (!ip) {
      recordBlock(`${req.method} ${target.href.slice(0, 200)}`);
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Blocked by JAANI egress guard (private or reserved address)');
      return;
    }
    const upstream = http.request({
      host: ip, port: Number(target.port || 80), method: req.method, path: `${target.pathname}${target.search}`,
      headers: { ...req.headers, host: target.host }, setHost: false,
    }, (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });

  // https (and ws/wss): CONNECT host:port — check, then tunnel to the checked address.
  srv.on('connect', async (req, clientSocket, head) => {
    const { host, port } = splitHostPort(req.url, 443);
    const ip = await resolvePublic(host);
    if (!ip) {
      recordBlock(`CONNECT ${String(req.url).slice(0, 200)}`);
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(port, ip, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const done = () => { upstream.destroy(); clientSocket.destroy(); };
    upstream.on('error', done);
    clientSocket.on('error', done);
  });

  // Tunnels are detached from the HTTP server, so track every socket and destroy them on close.
  const sockets = new Set();
  srv.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });

  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  return {
    server: `http://127.0.0.1:${port}`,
    blocked,
    close: () => new Promise((resolve) => {
      sockets.forEach((sock) => sock.destroy());
      srv.close(() => resolve());
    }),
  };
}

module.exports = { startEgressGuardProxy, resolvePublic };
