/**
 * Related fact-checks for an article, from the local fact-checker index (factCheckIndex.js).
 *
 * The index is authoritative; an LLM does exactly two narrow jobs:
 *   1. fact_check_query_formulation (cheap tier): turn the article into a few short search phrases;
 *   2. fact_check_match_judgment (flagship tier): decide which RETRIEVED items genuinely concern the
 *      same claim or event. It can only pick ids from the candidate list it is shown; anything else
 *      it returns is discarded.
 * The model never writes, recalls or summarises a fact-check. Everything displayed (title, link,
 * publisher, date) is copied from the index. If the judgment step fails, nothing is shown.
 */

const factCheckIndex = require('./factCheckIndex');

function parseJson(text) {
  const raw = String(text || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
  return null;
}

async function formulateQueries(run, { title, summary, keywords, llmProvider }) {
  const prompt = `From this Bangladeshi news item, write 2–4 short search phrases (2–6 words each, same language as the news) naming its concrete subject: the people, places, events or claims a fact-checker would write about. Nouns only, no sentences, no opinions.

Return ONLY JSON: {"queries":["...","..."]}

TITLE: ${title}
SUMMARY: ${summary}
KEYWORDS: ${(keywords || []).join(', ')}`;
  try {
    const out = await run(prompt, {
      llmProvider, operation: 'fact_check_query_formulation', task: 'fact_check_query_formulation', maxTokens: 200, timeoutMs: 15000,
      validate: (text) => { const j = parseJson(text); return Array.isArray(j?.queries) && j.queries.some((x) => String(x).trim()); },
    });
    const q = parseJson(out.text)?.queries;
    if (Array.isArray(q) && q.length) return { queries: q.map((x) => String(x).slice(0, 120)).filter(Boolean).slice(0, 4), method: 'llm' };
  } catch { /* fall back below */ }
  // Deterministic fallback: the article's own title and keywords.
  return { queries: [title, (keywords || []).join(' ')].filter(Boolean), method: 'title_keywords' };
}

async function judgeMatches(run, { title, summary, candidates, llmProvider }) {
  const list = candidates.map((c, i) => `[${i + 1}] ${c.item.title}\n    ${c.item.description.slice(0, 280)}`).join('\n');
  const prompt = `A reader is looking at this news item from Bangladesh:
TITLE: ${title}
SUMMARY: ${summary}

Below are fact-check articles RETRIEVED from a local index. Decide which of them concern the same event, person-and-incident, or claim as the news item. Topic overlap alone (e.g. both mention the police) is NOT enough.
Use only the numbers shown. Do not describe, invent or recall any fact-check that is not in the list.

${list}

Return ONLY JSON: {"matches":[{"n":<number>,"relation":"same_claim"|"same_event"}]} — empty array if none.`;
  try {
    const out = await run(prompt, {
      llmProvider, operation: 'fact_check_match_judgment', task: 'fact_check_match_judgment', maxTokens: 250, timeoutMs: 20000,
      // an empty "matches" array is a valid answer ("none match"); a missing one is not
      validate: (text) => Array.isArray(parseJson(text)?.matches),
    });
    const parsed = parseJson(out.text);
    if (!parsed || !Array.isArray(parsed.matches)) return { matches: null, error: 'unreadable judgment' };
    const picked = [];
    parsed.matches.forEach((m) => {
      const n = Number(m?.n);
      const relation = m?.relation === 'same_claim' ? 'same_claim' : (m?.relation === 'same_event' ? 'same_event' : null);
      if (!Number.isInteger(n) || n < 1 || n > candidates.length || !relation) return; // only retrieved ids survive
      if (!picked.some((p) => p.n === n)) picked.push({ n, relation });
    });
    return { matches: picked, provider: out.providerUsed, model: out.modelUsed };
  } catch (e) {
    return { matches: null, error: e.message };
  }
}

/**
 * @returns {Promise<{ items: object[], method: object }>}
 */
async function findRelatedFactChecks({ title = '', summary = '', keywords = [], entities = [], llmProvider = 'auto', run } = {}) {
  const stats = await factCheckIndex.stats();
  if (!stats.total || !run) return { items: [], method: { reason: stats.total ? 'no LLM runner' : 'index empty' } };

  const q = await formulateQueries(run, { title, summary, keywords, llmProvider });
  const queries = [...q.queries, ...entities.slice(0, 3)];
  const candidates = await factCheckIndex.search(queries, { limit: 6 });
  if (!candidates.length) return { items: [], method: { queries, queryMethod: q.method, candidates: 0 } };

  const judged = await judgeMatches(run, { title, summary, candidates, llmProvider });
  if (!judged.matches) {
    // Fail closed: no judgment → show nothing rather than unvetted retrieval hits.
    return { items: [], method: { queries, queryMethod: q.method, candidates: candidates.length, judgment: 'failed', error: judged.error } };
  }
  const items = judged.matches.map(({ n, relation }) => {
    const { item, score } = candidates[n - 1];
    return {
      title: item.title,
      url: item.url,
      source: item.source,
      publishedAt: item.published,
      relation,
      retrievalScore: Number(score.toFixed(2)),
    };
  });
  return {
    items,
    method: { queries, queryMethod: q.method, candidates: candidates.length, judgment: 'llm', provider: judged.provider, model: judged.model },
  };
}

module.exports = { findRelatedFactChecks };
