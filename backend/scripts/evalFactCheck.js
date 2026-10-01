#!/usr/bin/env node
/**
 * Hit-rate test for the fact-check lookup (not a runtime feature).
 *
 * Positive set: N real fact-checks taken from the local index. Each is fed to the lookup the way a
 * news item would be (its first sentences as the summary, a trimmed title as the headline, with the
 * fact-checker's verdict words removed). A hit = the same fact-check is retrieved AND kept by the
 * AI judgment step.
 * Negative control: ordinary news articles (from the task-routing pilot). Anything shown for them is
 * listed for manual review as a potential false positive.
 *
 * Usage: node scripts/evalFactCheck.js [--n 20]
 */

const fs = require('fs');
const path = require('path');
const ga = require('../services/geminiAnalysis');
const factCheckIndex = require('../services/factCheckIndex');
const { findRelatedFactChecks } = require('../services/factCheckLookup');

const args = process.argv.slice(2);
const N = Number(args[args.indexOf('--n') + 1]) || 20;
const OUT_DIR = path.join(__dirname, '..', 'data', 'eval');
const VERDICT_WORDS = /(ভুয়া|গুজব|মিথ্যা|বিভ্রান্তিকর|দাবিটি|দাবিতে|দাবি|সত্য নয়|এডিটেড|এআই দিয়ে তৈরি|false|fake|misleading|claim(?:ing)?)/gi;

(async () => {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'factcheck_index', 'index.json'), 'utf8'));
  const all = Object.values(state.items).filter((i) => i.description && i.description.length > 120);
  // spread the sample across sources
  const bySource = {};
  all.forEach((i) => { (bySource[i.sourceId] = bySource[i.sourceId] || []).push(i); });
  const sample = [];
  while (sample.length < N && Object.values(bySource).some((l) => l.length)) {
    Object.values(bySource).forEach((l) => { if (l.length && sample.length < N) sample.push(l.splice(Math.floor(l.length / 3), 1)[0]); });
  }

  const positives = [];
  for (const item of sample) {
    const title = item.title.replace(VERDICT_WORDS, ' ').replace(/\s+/g, ' ').trim();
    const summary = item.description.split(/[।.!?]/).slice(0, 2).join('। ').replace(VERDICT_WORDS, ' ').slice(0, 400);
    const r = await findRelatedFactChecks({ title, summary, keywords: [], entities: [], run: ga.runPromptWithProvider });
    const retrieved = (r.method?.candidates || 0) > 0;
    const hit = r.items.some((x) => x.url === item.url);
    positives.push({ source: item.source, target: item.title, url: item.url, queryMethod: r.method?.queryMethod, candidates: r.method?.candidates || 0, judgment: r.method?.judgment, hit, shown: r.items.map((x) => x.title), retrieved });
    process.stdout.write(hit ? '+' : '-');
  }
  console.log('');

  // Negative control from the latest task-routing pilot, if present.
  const negatives = [];
  const pilot = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith('task_routing_pilot_')).sort().pop();
  if (pilot) {
    const data = JSON.parse(fs.readFileSync(path.join(OUT_DIR, pilot), 'utf8'));
    const bySummary = new Map();
    data.results.filter((x) => x.task === 'summary_and_highlights' && x.ok && x.output?.summary).forEach((x) => {
      if (!bySummary.has(x.url)) bySummary.set(x.url, { title: x.title, summary: x.output.summary });
    });
    for (const [url, a] of bySummary) {
      const r = await findRelatedFactChecks({ title: a.title, summary: a.summary, run: ga.runPromptWithProvider });
      negatives.push({ url, title: a.title, candidates: r.method?.candidates || 0, shown: r.items.map((x) => `${x.source}: ${x.title} (${x.relation})`) });
      process.stdout.write('.');
    }
    console.log('');
  }

  const hits = positives.filter((p) => p.hit).length;
  const retrievedTarget = positives.filter((p) => p.shown.length || p.retrieved).length;
  const summary = {
    indexSize: (await factCheckIndex.stats()).total,
    positives: positives.length,
    hits,
    hitRatePct: positives.length ? Math.round((hits / positives.length) * 100) : 0,
    withAnyCandidates: retrievedTarget,
    negativesChecked: negatives.length,
    negativesWithAnythingShown: negatives.filter((n) => n.shown.length).length,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  fs.writeFileSync(path.join(OUT_DIR, `factcheck_hitrate_${stamp}.json`), JSON.stringify({ summary, positives, negatives }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  negatives.filter((n) => n.shown.length).forEach((n) => console.log('REVIEW (negative control):', n.title, '→', n.shown.join(' | ')));
  positives.filter((p) => !p.hit).forEach((p) => console.log('MISS:', p.source, '|', p.target.slice(0, 80), '| candidates', p.candidates, '| judgment', p.judgment));
})().catch((e) => { console.error(e); process.exit(1); });
