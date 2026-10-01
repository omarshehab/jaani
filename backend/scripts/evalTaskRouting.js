#!/usr/bin/env node
/**
 * Task-routing pilot evaluation (not a runtime feature).
 *
 * Runs real articles through every configured provider (OpenAI, Grok, Kimi) at two model tiers —
 * the cheap-tier model (TASK_CHEAP_<P>_MODEL, else <P>_MODEL) and the flagship candidate
 * (TASK_FLAGSHIP_<P>_MODEL, else SALIENCE_<P>_MODEL) — for two tasks:
 *   person_designation_extraction  (the /api/extract-entities prompt)
 *   summary_and_highlights         (a summary + highlights prompt)
 *
 * Measures JSON validity, latency, token counts as reported by each API (no price tables), and two
 * automatic grounding checks: extracted person names not found in the article (likely invented) and
 * numbers in a summary that do not appear in the article. Summary faithfulness still needs a
 * Bengali-reading reviewer: a review sheet is written next to the report.
 *
 * Usage: node scripts/evalTaskRouting.js [urlsFile] [--limit 10]
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const ga = require('../services/geminiAnalysis');
const routing = require('../config/llmTaskRouting');
const { normalizeText } = require('../services/rtiGazetteer');

const OUT_DIR = path.join(__dirname, '..', 'data', 'eval');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const args = process.argv.slice(2);
const limit = Number((args[args.indexOf('--limit') + 1]) || 10) || 10;
const urlsFile = args.find((a, i) => !a.startsWith('--') && a !== String(limit) && args[i - 1] !== '--only');

async function fetchArticle(url) {
  const r = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 30000, responseType: 'text' });
  const dom = new JSDOM(String(r.data), { url, virtualConsole: new VirtualConsole() });
  const art = new Readability(dom.window.document).parse();
  const text = (art?.textContent || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 1500).join(' ');
  return { url, title: (art?.title || '').trim(), text };
}

async function discoverUrls(n) {
  // Reuse the previous pilot's articles so reruns compare like with like.
  const prev = fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR).filter((f) => f.startsWith('task_routing_pilot_')).sort().pop() : null;
  if (prev && args.includes('--same-articles')) return JSON.parse(fs.readFileSync(path.join(OUT_DIR, prev), 'utf8')).articles.map((a) => a.url).slice(0, n);
  const r = await axios.get('https://www.prothomalo.com/', { headers: { 'User-Agent': UA }, timeout: 30000, responseType: 'text' });
  const found = Array.from(new Set(String(r.data).match(/https:\/\/www\.prothomalo\.com\/[a-z-]+(?:\/[a-z-]+)?\/[a-z0-9]{10}/g) || []));
  // spread across sections
  const bySection = new Map();
  found.forEach((u) => {
    const sec = u.split('/')[3];
    if (!bySection.has(sec)) bySection.set(sec, []);
    bySection.get(sec).push(u);
  });
  const out = [];
  while (out.length < n && [...bySection.values()].some((l) => l.length)) {
    for (const list of bySection.values()) if (list.length && out.length < n) out.push(list.shift());
  }
  return out;
}

function parseJson(text) {
  const raw = String(text || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(raw); } catch { /* next */ }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
  return null;
}

const digitsOf = (t) => new Set((normalizeText(t).match(/\d+/g) || []).filter((d) => d.length >= 2));

function personsCheck(parsed, article) {
  const entities = Array.isArray(parsed?.entities) ? parsed.entities : [];
  const persons = entities.filter((e) => (e.type || '').toLowerCase() === 'officer' && e.name);
  const text = normalizeText(article.text);
  const notInText = persons.filter((p) => {
    const tokens = normalizeText(p.name).split(' ').filter((t) => t.length > 1);
    return tokens.length && !tokens.every((t) => text.includes(t));
  });
  return {
    persons: persons.length,
    withDesignation: persons.filter((p) => (p.title || '').trim()).length,
    namesNotInArticle: notInText.map((p) => p.name),
  };
}

function summaryCheck(parsed, article) {
  const summary = String(parsed?.summary || '');
  const artDigits = digitsOf(article.text);
  const ungrounded = [...digitsOf(summary)].filter((d) => !artDigits.has(d));
  return { summaryChars: summary.length, highlights: Array.isArray(parsed?.highlights) ? parsed.highlights.length : 0, ungroundedNumbers: ungrounded };
}

const summaryPrompt = (a) => `Summarise this Bangladeshi news article for a citizen who may file a Right to Information request.
Return ONLY JSON: {"summary":"2–3 sentences in the article's language","highlights":["up to 5 short factual bullets"]}
Use only facts stated in the article.

TITLE: ${a.title}
ARTICLE:
${a.text}`;

async function runOne(provider, model, task, article) {
  const prompt = task === 'person_designation_extraction'
    ? ga.buildBengaliGovernmentEntityPrompt(article.text, '')
    : summaryPrompt(article);
  const started = Date.now();
  try {
    const out = await Promise.race([
      ga.callOpenAiCompatiblePrompt(provider, prompt, { model, maxTokens: 1200, maxRetries: 1, baseDelayMs: 1500 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout 90s')), 90000)),
    ]);
    const parsed = parseJson(out.text);
    const checks = task === 'person_designation_extraction' ? personsCheck(parsed, article) : summaryCheck(parsed, article);
    return {
      ok: true, jsonValid: Boolean(parsed), latencyMs: Date.now() - started, modelReported: out.modelUsed,
      promptTokens: out.usage?.prompt_tokens ?? null, completionTokens: out.usage?.completion_tokens ?? null,
      reasoningTokens: out.usage?.completion_tokens_details?.reasoning_tokens ?? null,
      checks, output: parsed,
    };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 200), latencyMs: Date.now() - started };
  }
}

(async () => {
  const urls = urlsFile ? fs.readFileSync(urlsFile, 'utf8').split(/\s+/).filter(Boolean).slice(0, limit) : await discoverUrls(limit);
  const articles = [];
  for (const u of urls) {
    try {
      const a = await fetchArticle(u);
      if (a.text.length > 300) articles.push(a);
    } catch (e) { console.warn('skip', u, e.message); }
  }
  console.log(`articles: ${articles.length}`);

  const configs = [];
  for (const provider of ['openai', 'grok', 'kimi']) {
    if (!ga.isProviderConfigured(provider)) continue;
    const cheap = routing.resolveTaskModel('summary_and_highlights', provider).model;
    const flagship = (process.env[`TASK_FLAGSHIP_${provider.toUpperCase()}_MODEL`] || process.env[`SALIENCE_${provider.toUpperCase()}_MODEL`] || '').trim();
    configs.push({ provider, tier: 'cheap', model: cheap });
    if (flagship && flagship !== cheap) configs.push({ provider, tier: 'flagship', model: flagship });
  }
  // --only openai/flagship,kimi/cheap  → rerun a subset
  const only = args.includes('--only') ? String(args[args.indexOf('--only') + 1]).split(',') : null;
  if (only) configs.splice(0, configs.length, ...configs.filter((c) => only.includes(`${c.provider}/${c.tier}`)));
  console.log('configs:', configs.map((c) => `${c.provider}/${c.tier}=${c.model}`).join(', '));

  const tasks = ['person_designation_extraction', 'summary_and_highlights'];
  const results = [];
  // providers in parallel, calls within a provider sequential (gentle on rate limits)
  await Promise.all(configs.map(async (cfg) => {
    for (const article of articles) {
      for (const task of tasks) {
        const r = await runOne(cfg.provider, cfg.model, task, article);
        results.push({ ...cfg, task, url: article.url, title: article.title, ...r });
        process.stdout.write('.');
      }
    }
  }));
  console.log('');

  // Aggregate
  const rows = [];
  configs.forEach((cfg) => tasks.forEach((task) => {
    const rs = results.filter((r) => r.provider === cfg.provider && r.tier === cfg.tier && r.task === task);
    const ok = rs.filter((r) => r.ok);
    const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const row = {
      provider: cfg.provider, tier: cfg.tier, model: cfg.model, task,
      calls: rs.length, errors: rs.length - ok.length,
      jsonValidPct: ok.length ? Math.round((ok.filter((r) => r.jsonValid).length / rs.length) * 100) : 0,
      avgLatencyMs: avg(ok.map((r) => r.latencyMs)),
      avgPromptTokens: avg(ok.map((r) => r.promptTokens).filter((x) => x != null)),
      avgCompletionTokens: avg(ok.map((r) => r.completionTokens).filter((x) => x != null)),
      avgReasoningTokens: avg(ok.map((r) => r.reasoningTokens).filter((x) => x != null)),
    };
    if (task === 'person_designation_extraction') {
      row.personsFound = ok.reduce((a, r) => a + (r.checks?.persons || 0), 0);
      row.withDesignation = ok.reduce((a, r) => a + (r.checks?.withDesignation || 0), 0);
      row.namesNotInArticle = ok.reduce((a, r) => a + (r.checks?.namesNotInArticle?.length || 0), 0);
    } else {
      row.summariesWithUngroundedNumbers = ok.filter((r) => (r.checks?.ungroundedNumbers || []).length).length;
    }
    rows.push(row);
  }));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  fs.writeFileSync(path.join(OUT_DIR, `task_routing_pilot_${stamp}.json`), JSON.stringify({ articles: articles.map((a) => ({ url: a.url, title: a.title })), configs, rows, results }, null, 2));
  const review = [`# Summary review sheet (${stamp})`, '', 'For a Bengali-reading reviewer: mark each summary Faithful / Minor error / Wrong.', ''];
  articles.forEach((a) => {
    review.push(`## ${a.title}`, a.url, '');
    results.filter((r) => r.url === a.url && r.task === 'summary_and_highlights' && r.ok).forEach((r) => {
      review.push(`- **${r.provider}/${r.tier} (${r.model})**: ${r.output?.summary || '(no summary)'}  — verdict: ____`);
    });
    review.push('');
  });
  fs.writeFileSync(path.join(OUT_DIR, `summary_review_${stamp}.md`), review.join('\n'));
  console.table(rows);
  console.log(`written: data/eval/task_routing_pilot_${stamp}.json and summary_review_${stamp}.md`);
})().catch((e) => { console.error(e); process.exit(1); });
