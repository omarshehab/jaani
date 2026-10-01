/**
 * salienceEnsemble.js — sentence-salience ranking for Read The News.
 *
 * The article is split into numbered sentences here (plain tokenization, not a model); the
 * same list is sent to OpenAI, Grok and Kimi in parallel, each asked for strict JSON
 * {"ranked":[{"id","score"}]}. Every provider that answers validly is min-max normalized,
 * sentences containing an analysis entity/keyword get +0.15, and the scores are averaged
 * per sentence. The ≤ SALIENCE_MAX_BUDGET_RATIO character cap is enforced here in code —
 * never delegated to a model. If no provider answers, the result is empty (no local fallback).
 */
const axios = require('axios');

// Model IDs come only from backend/.env (chosen after the 2026-09-26 /v1/models audit:
// gpt-6-astra, grok-4.7, kimi-k3). Never hardcode model IDs here.
const SALIENCE_MODELS = {
  openai: process.env.SALIENCE_OPENAI_MODEL || '',
  grok: process.env.SALIENCE_GROK_MODEL || '',
  kimi: process.env.SALIENCE_KIMI_MODEL || '',
};

const SALIENCE_PROVIDER_TIMEOUT_MS = parseInt(process.env.SALIENCE_PROVIDER_TIMEOUT_MS || '30000', 10);
const SALIENCE_MAX_BUDGET_RATIO = parseFloat(process.env.SALIENCE_MAX_BUDGET_RATIO || '0.40');
const HINT_BONUS = 0.15;
const MIN_SENTENCE_CHARS = 20;

const PROVIDERS = ['openai', 'grok', 'kimi'];

function providerConfig(provider) {
  // Optional per-provider timeout override (e.g. SALIENCE_TIMEOUT_MS_KIMI) for slow reasoners or tests.
  const override = parseInt(process.env[`SALIENCE_TIMEOUT_MS_${provider.toUpperCase()}`] || '', 10);
  const timeoutMs = Number.isFinite(override) && override > 0 ? override : SALIENCE_PROVIDER_TIMEOUT_MS;
  if (provider === 'openai') {
    return { model: SALIENCE_MODELS.openai, apiKey: process.env.OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', timeoutMs };
  }
  if (provider === 'grok') {
    return { model: SALIENCE_MODELS.grok, apiKey: process.env.XAI_API_KEY || process.env.GROK_API_KEY, baseUrl: process.env.GROK_BASE_URL || 'https://api.x.ai/v1', timeoutMs };
  }
  return { model: SALIENCE_MODELS.kimi, apiKey: process.env.KIMI_API_KEY, baseUrl: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1', timeoutMs };
}

// ─── Sentence splitting ─────────────────────────────────────────────────────

// Words that end in "." without ending a sentence (compared without the dot, case-insensitive).
const ABBREVIATIONS = new Set([
  'dr', 'mr', 'mrs', 'ms', 'vs', 'st', 'no', 'prof', 'gen', 'lt', 'col', 'capt', 'sr', 'jr', 'etc', 'e.g', 'i.e', 'govt', 'dept', 'inc', 'ltd', 'co',
  'ড', 'মি', 'নং', 'মো', 'মোঃ', 'মু', 'ডা', 'অধ্যা', 'সা', 'রা',
]);

/**
 * Split article text into sentences. Boundaries: newlines, a run of [।!?] plus closing quotes
 * (with or without a following space), and "." followed by whitespace —
 * except after a known abbreviation or a single-letter initial ("A. K. Azad"). Decimals like
 * ৩.৫ / 3.5 never split because no whitespace follows the dot.
 * Returns [{ id, text, charCount }] with fragments under 20 characters dropped.
 */
function splitBengaliSentences(text = '') {
  const out = [];
  const paragraphs = String(text || '').normalize('NFC').split(/\n+/);
  for (const paragraph of paragraphs) {
    const para = paragraph.replace(/\s+/g, ' ').trim();
    if (!para) continue;
    let start = 0;
    // ।/!/? (plus any closing quotes/brackets) end a sentence even when the next one follows with
    // no space (blocks glued together in extracted text); "." only before whitespace, so decimals
    // (৩.৫ / 3.5) and URLs never split.
    const boundary = /[।!?]+["'”’)\]]*|\.["'”’)\]]*(?=\s)/g;
    let m;
    while ((m = boundary.exec(para)) !== null) {
      const end = m.index + m[0].length;
      if (m[0].startsWith('.')) {
        const before = para.slice(start, m.index);
        const lastWord = (before.match(/(\S+)$/) || [])[1] || '';
        const bare = lastWord.replace(/^[("'“‘]+/, '').toLowerCase();
        if (ABBREVIATIONS.has(bare) || /^\p{L}$/u.test(bare)) continue;
      }
      out.push(para.slice(start, end).trim());
      start = end;
    }
    const tail = para.slice(start).trim();
    if (tail) out.push(tail);
  }
  const sentences = out
    .filter((s) => s.length >= MIN_SENTENCE_CHARS)
    .map((s, idx) => ({ id: idx + 1, text: s, charCount: s.length }));
  console.log(`📝 [salience] Split into ${sentences.length} sentences`);
  return sentences;
}

// ─── One provider ───────────────────────────────────────────────────────────

const RANKING_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'sentence_ranking',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        ranked: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'integer' }, score: { type: 'number' } },
            required: ['id', 'score'],
            additionalProperties: false,
          },
        },
      },
      required: ['ranked'],
      additionalProperties: false,
    },
  },
};

function buildMessages(sentences) {
  const list = sentences.map((s) => `${s.id}. ${s.text}`).join('\n');
  return [
    { role: 'system', content: 'You are a news relevance scorer. Return ONLY valid JSON, nothing else.' },
    {
      role: 'user',
      content: `Score these Bengali/English news sentences for civic importance (corruption, government accountability, public interest). Return {"ranked":[{"id":<int>,"score":<float 0-1>}]} for ALL ${sentences.length} sentences. No explanation, no markdown, only the JSON object.\n\nSentences:\n${list}`,
    },
  ];
}

function parseRanking(content, sentences) {
  const raw = String(content || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.ranked)) throw new Error('response has no "ranked" array');
  const validIds = new Set(sentences.map((s) => s.id));
  const seen = new Set();
  for (const item of parsed.ranked) {
    const id = Number(item?.id);
    const score = item?.score;
    if (!Number.isInteger(id) || !validIds.has(id)) throw new Error(`unknown sentence id ${item?.id}`);
    if (seen.has(id)) throw new Error(`duplicate sentence id ${id}`);
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) throw new Error(`score out of range for id ${id}: ${score}`);
    seen.add(id);
  }
  if (!parsed.ranked.length) throw new Error('empty ranking');
  return parsed.ranked.map((r) => ({ id: Number(r.id), score: r.score }));
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];

/**
 * Rank sentences with one provider through its OpenAI-compatible chat API.
 * Tries a strict json_schema response format first and falls back to json_object on HTTP 400.
 * Throws on any failure or invalid output (so Promise.allSettled records it as rejected).
 */
async function rankWithProvider(sentences, provider, { model, apiKey, baseUrl, timeoutMs } = providerConfig(provider)) {
  if (!model) throw new Error(`${provider}: no model configured (SALIENCE_${provider.toUpperCase()}_MODEL)`);
  if (!apiKey) throw new Error(`${provider}: no API key`);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const post = (responseFormat) => axios.post(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    model,
    messages: buildMessages(sentences),
    response_format: responseFormat,
  }, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeout: Math.max(1, deadline - Date.now()),
  });

  let resp;
  let mode = 'json_schema';
  try {
    resp = await post(RANKING_SCHEMA);
  } catch (err) {
    if (err.response?.status !== 400 || Date.now() >= deadline) throw new Error(`${provider}: ${err.response?.status || ''} ${err.message}`.trim());
    mode = 'json_object';
    resp = await post({ type: 'json_object' }).catch((e) => { throw new Error(`${provider}: ${e.response?.status || ''} ${e.message}`.trim()); });
  }

  const content = resp.data?.choices?.[0]?.message?.content;
  let ranked;
  try {
    ranked = parseRanking(content, sentences);
  } catch (err) {
    throw new Error(`${provider}: invalid ranking — ${err.message}`);
  }
  const scores = ranked.map((r) => r.score).sort((a, b) => a - b);
  console.log(`🤖 [salience] ${provider} (${model}, ${mode}) answered in ${Date.now() - startedAt}ms — ${ranked.length}/${sentences.length} scored; min ${scores[0]} median ${quantile(scores, 0.5)} p95 ${quantile(scores, 0.95)} max ${scores[scores.length - 1]}`);
  return { provider, model, mode, ranked, ms: Date.now() - startedAt };
}

// ─── Ensemble ───────────────────────────────────────────────────────────────

const normalizeForMatch = (value) => String(value || '').normalize('NFC').replace(/\s+/g, ' ').toLowerCase();

/**
 * Query all providers in parallel and merge.
 * Returns { ranked: [{id, score}] sorted by merged score desc, providers: [...answered], perProvider }.
 * `ranked` is empty when no provider answered.
 */
async function ensembleRank(sentences, text, { entities = [], keywords = [] } = {}) {
  if (!Array.isArray(sentences) || sentences.length === 0) return { ranked: [], providers: [], perProvider: {} };

  const settled = await Promise.allSettled(PROVIDERS.map((p) => rankWithProvider(sentences, p)));
  const answered = [];
  const perProvider = {};
  settled.forEach((result, i) => {
    const provider = PROVIDERS[i];
    if (result.status === 'fulfilled') {
      answered.push(result.value);
      perProvider[provider] = {
        ok: true,
        model: result.value.model,
        ms: result.value.ms,
        top3: [...result.value.ranked].sort((a, b) => b.score - a.score).slice(0, 3).map((r) => r.id),
      };
    } else {
      perProvider[provider] = { ok: false, error: result.reason?.message || String(result.reason) };
      console.warn(`⚠️ [salience] ${provider} failed: ${perProvider[provider].error}`);
    }
  });

  if (answered.length === 0) return { ranked: [], providers: [], perProvider };

  // Sentences mentioning something already highlighted in the article get a bonus, so the
  // sentence layer agrees with the entity/keyword layer the reader already sees.
  const hints = [...(entities || []).map((e) => e?.text || e?.name || ''), ...(keywords || [])]
    .map(normalizeForMatch)
    .filter((h) => h.length >= 2);
  const hinted = new Set(sentences
    .filter((s) => { const t = normalizeForMatch(s.text); return hints.some((h) => t.includes(h)); })
    .map((s) => s.id));

  const sums = new Map();
  const counts = new Map();
  for (const { ranked } of answered) {
    const values = ranked.map((r) => r.score);
    const min = Math.min(...values);
    const max = Math.max(...values);
    for (const r of ranked) {
      let norm = max > min ? (r.score - min) / (max - min) : 0.5;
      if (hinted.has(r.id)) norm = Math.min(1, norm + HINT_BONUS);
      sums.set(r.id, (sums.get(r.id) || 0) + norm);
      counts.set(r.id, (counts.get(r.id) || 0) + 1);
    }
  }
  const ranked = Array.from(sums.entries())
    .map(([id, sum]) => ({ id, score: sum / counts.get(id) }))
    .sort((a, b) => b.score - a.score || a.id - b.id);

  return { ranked, providers: answered.map((a) => a.provider), perProvider };
}

/**
 * Greedy pick by merged score while the running character total stays within
 * budgetRatio × totalChars; returns the picks in document order.
 */
function selectTopSentences(ranked, sentencesById, budgetRatio = SALIENCE_MAX_BUDGET_RATIO, totalChars = 0) {
  const total = totalChars > 0
    ? totalChars
    : Array.from(sentencesById.values()).reduce((sum, s) => sum + s.charCount, 0);
  const budget = budgetRatio * total;
  let used = 0;
  const picked = [];
  for (const { id } of ranked) {
    const sentence = sentencesById.get(id);
    if (!sentence) continue;
    if (used + sentence.charCount > budget) continue; // skip, a shorter one may still fit
    used += sentence.charCount;
    picked.push(sentence);
  }
  picked.sort((a, b) => a.id - b.id);
  const ratio = total > 0 ? used / total : 0;
  if (ratio > budgetRatio) {
    throw new Error(`salience cap violated: ratio ${ratio.toFixed(4)} > ${budgetRatio}`);
  }
  return { sentences: picked.map((s) => s.text), ids: picked.map((s) => s.id), ratio };
}

/** Full run: rank with the ensemble, then apply the cap. Never throws for provider failures. */
async function runSalience(text, sentences, { entities = [], keywords = [] } = {}) {
  const startedAt = Date.now();
  const { ranked, providers, perProvider } = await ensembleRank(sentences, text, { entities, keywords });
  const sentencesById = new Map(sentences.map((s) => [s.id, s]));
  const selection = ranked.length
    ? selectTopSentences(ranked, sentencesById, SALIENCE_MAX_BUDGET_RATIO, String(text || '').length)
    : { sentences: [], ids: [], ratio: 0 };
  const mergedTop3 = ranked.slice(0, 3).map((r) => r.id);
  console.log(`✨ [salience] ${providers.length}/3 providers (${providers.join(', ') || 'none'}); merged top-3 ${JSON.stringify(mergedTop3)}; selected ${selection.ids.length} sentences, ratio ${selection.ratio.toFixed(3)} (cap ${SALIENCE_MAX_BUDGET_RATIO}); ${Date.now() - startedAt}ms`);
  return { ...selection, providerCount: providers.length, providers, perProvider, mergedTop3 };
}

module.exports = {
  SALIENCE_MODELS,
  SALIENCE_PROVIDER_TIMEOUT_MS,
  SALIENCE_MAX_BUDGET_RATIO,
  splitBengaliSentences,
  rankWithProvider,
  ensembleRank,
  selectTopSentences,
  runSalience,
};
