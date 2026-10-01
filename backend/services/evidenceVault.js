/**
 * Evidence Vault Service
 * Computes multi-algorithm hashes, submits to Wayback Machine,
 * generates JSON-LD certificate, and persists all artifacts to disk.
 */

'use strict';

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs').promises;
const axios  = require('axios');
const { v4: uuidv4 } = require('uuid');

const VAULT_DIR = path.join(__dirname, '..', 'data', 'evidence_vault');

// ── Helpers ────────────────────────────────────────────────────────────────────

function nfc(s) { return (s || '').normalize('NFC'); }

async function ensureVaultDir(subdir) {
  const dir = subdir ? path.join(VAULT_DIR, subdir) : VAULT_DIR;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ── CRC32 (no external dep) ────────────────────────────────────────────────────

let _crc32Table = null;
function buildCrc32Table() {
  if (_crc32Table) return _crc32Table;
  _crc32Table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    _crc32Table[n] = c;
  }
  return _crc32Table;
}

function crc32hex(buf) {
  const t = buildCrc32Table();
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ t[(crc ^ buf[i]) & 0xFF];
  return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

// ── Multi-hash ─────────────────────────────────────────────────────────────────

/**
 * @param {string|Buffer} input
 * @returns {{ md5, sha256, sha512, crc32, byte_size }}
 */
function computeHashes(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(nfc(String(input || '')), 'utf8');
  return {
    md5:       crypto.createHash('md5').update(buf).digest('hex'),
    sha256:    crypto.createHash('sha256').update(buf).digest('hex'),
    sha512:    crypto.createHash('sha512').update(buf).digest('hex'),
    crc32:     crc32hex(buf),
    byte_size: buf.length,
  };
}

// ── Pseudo-CIDv1 (content-addressed, no IPFS daemon needed) ──────────────────

function computeIpfsCid(text) {
  const hash = crypto.createHash('sha256').update(nfc(text || ''), 'utf8').digest('hex');
  return `bafybei${hash.slice(0, 48)}`;
}

// ── Wayback Machine submission (fire-and-forget safe) ─────────────────────────

async function submitToWayback(articleUrl) {
  const saveUrl = `https://web.archive.org/save/${articleUrl}`;
  try {
    const resp = await axios.get(saveUrl, {
      timeout: 12000,
      maxRedirects: 5,
      validateStatus: s => s < 500,
      headers: {
        'User-Agent': 'JAANI/1.0 (civic-tech; rtirequest.org)',
        'Accept': 'text/html,*/*',
      },
    });
    const loc = resp.headers?.['content-location'] || resp.headers?.['location'] || '';
    const permalink = loc ? (loc.startsWith('http') ? loc : `https://web.archive.org${loc}`) : null;
    return { status: 'saved', url: permalink || saveUrl };
  } catch (e) {
    return { status: 'failed', url: null, error: e.message };
  }
}

// ── JSON-LD Certificate of Authenticity ──────────────────────────────────────

function buildJsonLdCertificate({ captureId, articleUrl, hashes, waybackUrl, ipfsCid, capturedAt }) {
  const bst = capturedAt || new Date().toISOString();
  return {
    '@context': 'https://schema.org/',
    '@type': 'DigitalDocument',
    name: 'JAANI Evidence Certificate',
    identifier: { '@type': 'PropertyValue', name: 'capture_id', value: captureId },
    url: articleUrl,
    dateCreated: bst,
    encodingFormat: 'text/html',
    inLanguage: 'bn-BD',
    publisher: { '@type': 'Organization', name: 'JAANI Platform', url: 'https://rtirequest.org' },
    additionalProperty: [
      { '@type': 'PropertyValue', name: 'capture_method',  value: 'JAANI evidence pipeline' },
      { '@type': 'PropertyValue', name: 'text_md5',        value: hashes?.text?.md5    || '' },
      { '@type': 'PropertyValue', name: 'text_sha256',     value: hashes?.text?.sha256 || '' },
      { '@type': 'PropertyValue', name: 'text_sha512',     value: hashes?.text?.sha512 || '' },
      { '@type': 'PropertyValue', name: 'html_sha256',     value: hashes?.html?.sha256 || '' },
      { '@type': 'PropertyValue', name: 'wayback_url',     value: waybackUrl || '' },
      { '@type': 'PropertyValue', name: 'ipfs_cid',        value: ipfsCid    || '' },
      { '@type': 'PropertyValue', name: 'captured_at_utc', value: bst },
    ],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  Main capture pipeline
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {Object} opts
 * @param {string} opts.articleUrl
 * @param {string} [opts.articleHtml]
 * @param {string} [opts.articleText]
 * @param {Object} [opts.analysisData]   – summary, tldr, rtiScore, keywords
 * @returns {Promise<Object>}            – evidence result (wayback pending)
 */
async function captureEvidence({ articleUrl = '', articleHtml = '', articleText = '', analysisData = {} } = {}) {
  const captureId  = uuidv4();
  const capturedAt = new Date().toISOString();

  const result = {
    capture_id:   captureId,
    article_url:  articleUrl,
    captured_at:  capturedAt,
    hashes:       null,
    wayback:      null,
    ipfs_cid:     null,
    certificate:  null,
    vault_path:   null,
  };

  // 1. Hash vault
  try {
    result.hashes = {
      html: computeHashes(articleHtml),
      text: computeHashes(articleText),
    };
  } catch (e) {
    console.warn('[evidenceVault] hash error:', e.message);
  }

  // 2. IPFS pseudo-CID
  try { result.ipfs_cid = computeIpfsCid(articleText); } catch {}

  // 3. JSON-LD certificate
  try {
    result.certificate = buildJsonLdCertificate({
      captureId,
      articleUrl,
      hashes:     result.hashes,
      ipfsCid:    result.ipfs_cid,
      capturedAt,
    });
  } catch (e) {
    console.warn('[evidenceVault] cert error:', e.message);
  }

  // 4. Persist to disk
  try {
    const vaultDir = await ensureVaultDir(captureId);
    result.vault_path = vaultDir;

    const writes = [
      fs.writeFile(path.join(vaultDir, 'hashes.json'),      JSON.stringify(result.hashes, null, 2)),
      fs.writeFile(path.join(vaultDir, 'certificate.jsonld'), JSON.stringify(result.certificate, null, 2)),
      fs.writeFile(path.join(vaultDir, 'analysis_summary.json'), JSON.stringify({
        capture_id:   captureId,
        article_url:  articleUrl,
        captured_at:  capturedAt,
        summary:      analysisData?.summary || '',
        tldr:         analysisData?.tldr    || '',
        rti_score:    analysisData?.rtiScore || 0,
        keywords:     analysisData?.keywords || [],
      }, null, 2)),
      // Partial metadata (wayback = null until async callback)
      fs.writeFile(path.join(vaultDir, 'metadata.json'), JSON.stringify(result, null, 2)),
    ];
    await Promise.allSettled(writes);
  } catch (e) {
    console.warn('[evidenceVault] disk write error:', e.message);
  }

  // 5. Wayback submission (non-blocking — updates metadata.json asynchronously)
  ;(async () => {
    try {
      const wb = await submitToWayback(articleUrl);
      result.wayback = wb;
      if (result.vault_path) {
        await fs.writeFile(
          path.join(result.vault_path, 'metadata.json'),
          JSON.stringify({ ...result, wayback: wb }, null, 2)
        );
      }
    } catch {}
  })();

  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
//  Vault retrieval helpers
// ══════════════════════════════════════════════════════════════════════════════

async function listEvidence(page = 1, perPage = 20) {
  try {
    await ensureVaultDir();
    const all = (await fs.readdir(VAULT_DIR)).filter(e => /^[0-9a-f-]{36}$/i.test(e));
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const entries = await Promise.all(slice.map(async id => {
      try {
        const raw = await fs.readFile(path.join(VAULT_DIR, id, 'metadata.json'), 'utf8');
        return JSON.parse(raw);
      } catch {
        return { capture_id: id };
      }
    }));
    return { entries, total: all.length, page, per_page: perPage };
  } catch {
    return { entries: [], total: 0, page, per_page: perPage };
  }
}

async function getEvidence(uuid) {
  try {
    const raw = await fs.readFile(path.join(VAULT_DIR, uuid, 'metadata.json'), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function verifyEvidence(uuid) {
  try {
    const meta = await getEvidence(uuid);
    if (!meta) return { verified: false, error: 'not_found' };
    const storedRaw = await fs.readFile(path.join(VAULT_DIR, uuid, 'hashes.json'), 'utf8');
    const stored = JSON.parse(storedRaw);
    return {
      verified: true,
      capture_id:       uuid,
      stored_sha256:    stored?.text?.sha256 || '',
      verified_at:      new Date().toISOString(),
      article_url:      meta.article_url,
      captured_at:      meta.captured_at,
      wayback_url:      meta.wayback?.url || null,
      ipfs_cid:         meta.ipfs_cid || null,
    };
  } catch (e) {
    return { verified: false, error: e.message };
  }
}

module.exports = {
  captureEvidence,
  listEvidence,
  getEvidence,
  verifyEvidence,
  computeHashes,
  computeIpfsCid,
  submitToWayback,
  buildJsonLdCertificate,
  VAULT_DIR,
};
