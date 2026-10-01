#!/usr/bin/env node
/**
 * Evidence retention sweep, runnable by hand.
 *   node scripts/sweepEvidence.js --dry-run            list what would be deleted (default 90 days)
 *   node scripts/sweepEvidence.js --days 90            actually delete (same code the server runs at startup)
 */
const { sweepExpiredCaptures } = require('../services/forensicEvidence');

const args = process.argv.slice(2);
const days = Number(args[args.indexOf('--days') + 1]) || 90;
const dryRun = args.includes('--dry-run');
sweepExpiredCaptures({ maxAgeDays: days, dryRun, log: () => {} }).then((r) => {
  const byKind = {};
  r.removed.forEach((x) => { byKind[x.kind] = (byKind[x.kind] || 0) + 1; });
  console.log(JSON.stringify({ dryRun, maxAgeDays: days, [dryRun ? 'wouldDelete' : 'deleted']: r.removed.length, byKind, kept: r.kept,
    oldest: r.removed.map((x) => x.capturedAt).sort()[0] || null, newestDeleted: r.removed.map((x) => x.capturedAt).sort().pop() || null }, null, 2));
});
