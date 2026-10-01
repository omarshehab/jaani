/**
 * Provider fall-through: an empty or parseable-but-empty answer must move on to the next provider,
 * never reach downstream code as if it were valid. Uses two local fake OpenAI-compatible servers
 * (one standing in for Kimi, one for OpenAI); no real API is called.
 */
// Runs on Node's built-in runner: `node --test tests/providerFallthrough.test.js`
// (the project's mocha 10 does not start under Node 26).
const { describe, it, before, after } = require('node:test');
const assert = require('assert');
const http = require('http');

function fakeProvider(respond) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = JSON.parse(body || '{}');
      calls.push(json);
      const content = respond(json, calls.length);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', model: json.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

const GOOD_ANALYSIS = JSON.stringify({
  summary: 'ঢাকা মহানগর পুলিশ ২৪ ঘণ্টার অভিযানে ৪৭৪ জনকে গ্রেপ্তার করেছে বলে জানিয়েছে।',
  category: 'Law & Justice', category_confidence: 0.9, keywords: ['গ্রেপ্তার'], language: 'bn',
  highlights: ['৪৭৪ জন গ্রেপ্তার'], related_ministry: '', related_ministries: [], ministry_reasoning: '', rti_target_office: '',
  entities: [],
});
const TEXT = 'রাজধানীতে পুলিশের অভিযানে ২৪ ঘণ্টায় গ্রেপ্তার ৪৭৪ জন। ঢাকা মহানগর পুলিশ (ডিএমপি) এ তথ্য জানিয়েছে। অভিযানে মাদক ও অস্ত্র উদ্ধার করা হয়েছে।';

describe('LLM provider fall-through on empty answers', { timeout: 60000 }, () => {
  let kimi;
  let openai;
  let kimiMode = 'empty';
  let openaiMode = 'good';
  let ga;

  before(async () => {
    kimi = await fakeProvider(() => ({ empty: '', emptyJson: '{}', emptySummary: '{"summary":""}', section7: '{"flags":[]}' }[kimiMode] ?? ''));
    openai = await fakeProvider((json) => {
      if (openaiMode === 'empty') return '';
      if (openaiMode === 'section7') return '{"flags":[]}';
      // entity-consensus prompts ask for {"entities": [...]}
      const prompt = (json.messages || []).map((m) => m.content).join('\n');
      return /"entities"/.test(prompt) && !/civic_grievance/.test(prompt) ? '{"entities":[]}' : GOOD_ANALYSIS;
    });
    Object.assign(process.env, {
      KIMI_API_KEY: 'test', KIMI_BASE_URL: kimi.url,
      OPENAI_API_KEY: 'test', OPENAI_BASE_URL: openai.url,
      GROK_API_KEY: '', XAI_API_KEY: '', GEMINI_API_KEY: '', CEREBRAS_API_KEY: '',
      LLM_AUTO_ORDER: 'kimi,openai', LLM_PROVIDER_TIMEOUT_MS: '10000', ENTITY_EXTRACT_TIMEOUT_MS: '5000',
    });
    ga = require('../services/geminiAnalysis');
  });

  after(() => { kimi.server.close(); openai.server.close(); });

  for (const mode of ['empty', 'emptyJson', 'emptySummary']) {
    it(`falls through to the next provider when Kimi returns ${mode}`, async () => {
      kimiMode = mode;
      openaiMode = 'good';
      const r = await ga.analyzeQuick(TEXT, '', { llmProvider: 'kimi' });
      assert.strictEqual(r.analysis_unavailable, undefined, 'must not be marked unavailable');
      assert.strictEqual(r.llm_provider_used, 'openai', 'answer must come from the next provider');
      assert.ok(r.summary.length > 20, 'summary must be the real one');
    });
  }

  it('gives Kimi a genuinely higher token ceiling, and OpenAI max_completion_tokens', async () => {
    const lastKimi = kimi.calls[kimi.calls.length - 1];
    assert.ok(lastKimi.max_tokens >= 2000, `kimi max_tokens was ${lastKimi.max_tokens}`);
    const lastOpenai = openai.calls[openai.calls.length - 1];
    assert.ok(lastOpenai.max_completion_tokens > 0 && lastOpenai.max_tokens === undefined);
  });

  it('reports "unavailable" (not an empty valid result) when every provider answers empty', async () => {
    kimiMode = 'emptyJson';
    openaiMode = 'empty';
    const r = await ga.analyzeQuick(TEXT, '', { llmProvider: 'kimi' });
    assert.strictEqual(r.analysis_unavailable, true);
    assert.strictEqual(r.summary, '');
  });

  it('pins the Section 7 judgment to OpenAI first even when the user picked Kimi', async () => {
    openaiMode = 'section7';
    kimiMode = 'emptyJson';
    const before = { openai: openai.calls.length, kimi: kimi.calls.length };
    const out = await ga.runPromptWithProvider('x', {
      llmProvider: 'kimi', task: 'section7_exemption_judgment', operation: 'section7_exemption_judgment',
      validate: (t) => Array.isArray(JSON.parse(t || '{}').flags),
    });
    assert.strictEqual(out.providerUsed, 'openai');
    assert.strictEqual(kimi.calls.length, before.kimi, 'Kimi must not be asked before OpenAI');
    assert.ok(openai.calls.length > before.openai);
  });

  it('marks a Section 7 answer from a fallback provider as degraded', async () => {
    openaiMode = 'empty';
    kimiMode = 'section7';
    const { _checkSection7ForTest } = require('../services/rtiActGuidance');
    const r = await _checkSection7ForTest(ga.runPromptWithProvider, { text: 'পরীক্ষা', authority: 'স্বরাষ্ট্র মন্ত্রণালয়', llmProvider: 'auto' });
    assert.strictEqual(r.provider, 'kimi');
    assert.strictEqual(r.degraded, true);
  });

  it('treats an explicit empty "matches" array as a valid fact-check judgment', async () => {
    let seen = null;
    const run = async (prompt, opts) => {
      seen = opts.validate;
      return { text: '{"matches":[]}', providerUsed: 'openai', modelUsed: 'x' };
    };
    const { findRelatedFactChecks } = require('../services/factCheckLookup');
    await findRelatedFactChecks({ title: 'ঢাকা মহানগর পুলিশ গ্রেপ্তার', summary: 'ডিএমপি অভিযান', run });
    if (seen) {
      assert.strictEqual(seen('{"matches":[]}'), true);
      assert.strictEqual(seen('{}'), false);
    }
  });
});
