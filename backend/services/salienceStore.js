/**
 * salienceStore.js — short-lived results of the sentence-salience ensemble, keyed by urlHash
 * (sha256 of the normalized article URL, same as the Live Page reader token).
 * An entry is either { pending: true } while the ensemble runs, or the finished payload.
 */
const MAX_ENTRIES = 50;
const TTL_MS = 15 * 60 * 1000;

const store = new Map(); // urlHash -> { payload, ts }

function set(urlHash, payload) {
  if (!urlHash) return;
  store.delete(urlHash);
  store.set(urlHash, { payload, ts: Date.now() });
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
}

function get(urlHash) {
  const entry = store.get(urlHash);
  if (!entry) return null;
  if (Date.now() - entry.ts > TTL_MS) {
    store.delete(urlHash);
    return null;
  }
  return entry.payload;
}

module.exports = { set, get };
