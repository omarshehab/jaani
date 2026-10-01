/**
 * LLM Analysis Service
 * Replaces the local Python ML service with provider-routed cloud LLMs.
 *
 * Used by:
 *  1. POST /api/analyze       → analyzeQuick()   (entity extraction, categorization, keywords)
 *  2. POST /api/news-summary  → generateFullSummary()  (20-feature deep analysis)
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const Cerebras = require('@cerebras/cerebras_cloud_sdk');
const rtiLookup = require('./rtiDatabaseLookup');
const rtiGazetteer = require('./rtiGazetteer');
const locationGazetteer = require('./locationGazetteer');
const llmTaskRouting = require('../config/llmTaskRouting');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.warn('⚠️  GEMINI_API_KEY not set in .env — LLM analysis will be unavailable');
}
const GEMINI_MODEL = llmTaskRouting.providerDefaultModel('gemini');
const CEREBRAS_DEFAULT_BASE_URL = 'https://api.cerebras.ai/v1';

let genAI = null;
let model = null;
const openAiClientCache = new Map();
const cerebrasClientCache = new Map();

function getModel() {
  if (!GEMINI_API_KEY) return null;
  if (!genAI) genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  if (!model) model = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  return model;
}

const SUPPORTED_LLM_PROVIDERS = ['auto', 'gemini', 'openai', 'grok', 'kimi', 'cerebras', 'openrouter', 'featherless'];

const JAANI_LLM_CONTEXT = [
  'You are the intelligence engine for JAANI (RTI news assistant focused on Bangladesh government transparency).',
  '',
  'CRITICAL KNOWLEDGE BASE: Bangladesh Government Structure',
  '- Ministry: The top-level executive body (e.g., Ministry of Home Affairs, Ministry of Finance, Ministry of Health)',
  '- Division: Subdivisions within ministries (e.g., Department of Health Services)',
  '- Office: Specific government offices (e.g., Bangladesh Bureau of Statistics, National Board of Revenue)',
  '- Officers: Named government officials with designations (Minister, Secretary, Director General, Deputy Commissioner)',
  '',
  'Key BD Government Entities to Recognize:',
  '- Ministries: Interior, Defense, Finance, Health, Education, Agriculture, Commerce, Industry, Law, Environment, Energy, Power',
  '- Constitutional Bodies: Parliament (জাতীয় সংসদ), Supreme Court, Election Commission',
  '- Autonomous Bodies: Bangladesh Bank, Telecom Regulatory Authority, Anti-Corruption Commission (ACC), National Human Rights Commission',
  '- Field Officers: District Commissioner (DC), Deputy Commissioner (DC), Upazila Nirbahi Officer (UNO), Officer-in-Charge (OC)',
  '',
  'EXTRACTION PRIORITIES:',
  '(1) Identify all government entities (ministries, divisions, offices, agencies)',
  '(2) Extract named government officials with their exact designations',
  '(3) Find administrative hierarchies and reporting relationships',
  '(4) Detect corruption allegations, irregularities, or RTI-relevant information',
  '(5) Extract contact information for government offices',
  '(6) Always use EXACT spelling of Bengali and English names—never transliterate or guess',
  '',
  'RULES:',
  '- Only extract entities explicitly mentioned or strongly implied in the text',
  '- When unsure about entity type, default to "ORG" for organizations or "PER" for individuals',
  '- Use empty arrays/strings for missing data—never hallucinate',
  '- Preserve original text casing and script (Bengali characters must be preserved exactly)',
  '- Return JSON with exact schema; malformed JSON will cause downstream failures',
].join('\n');

function normalizeLlmProvider(provider) {
  const normalized = (provider || 'auto').toString().trim().toLowerCase();
  return SUPPORTED_LLM_PROVIDERS.includes(normalized) ? normalized : 'auto';
}

function getProviderRuntimeConfig(provider) {
  const normalized = normalizeLlmProvider(provider);
  const table = {
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: llmTaskRouting.providerDefaultModel('openai'),
    },
    grok: {
      apiKey: process.env.GROK_API_KEY || process.env.XAI_API_KEY || '',
      baseUrl: process.env.GROK_BASE_URL || 'https://api.x.ai/v1',
      model: llmTaskRouting.providerDefaultModel('grok'),
    },
    kimi: {
      apiKey: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || '',
      baseUrl: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1',
      model: llmTaskRouting.providerDefaultModel('kimi'),
    },
    cerebras: {
      apiKey: process.env.CEREBRAS_API_KEY || '',
      baseUrl: process.env.CEREBRAS_BASE_URL || CEREBRAS_DEFAULT_BASE_URL,
      model: llmTaskRouting.providerDefaultModel('cerebras'),
    },
  };
  return table[normalized] || null;
}

function getProviderModelName(provider) {
  const normalized = normalizeLlmProvider(provider);
  if (normalized === 'gemini') return GEMINI_MODEL;
  const cfg = getProviderRuntimeConfig(normalized);
  return cfg?.model || '';
}

function getOpenAiClient(provider, cfg) {
  const normalized = normalizeLlmProvider(provider);
  const baseUrl = (cfg?.baseUrl || '').trim();
  const key = `${normalized}:${baseUrl}:${cfg?.apiKey || ''}`;

  if (!openAiClientCache.has(key)) {
    openAiClientCache.set(key, new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: baseUrl || undefined,
    }));
  }

  return openAiClientCache.get(key);
}

function getCerebrasClient(cfg) {
  const baseUrl = (cfg?.baseUrl || '').trim();
  const key = `${baseUrl}:${cfg?.apiKey || ''}`;

  if (!cerebrasClientCache.has(key)) {
    const constructorOptions = {
      apiKey: cfg.apiKey,
    };

    if (baseUrl && baseUrl !== CEREBRAS_DEFAULT_BASE_URL) {
      constructorOptions.baseURL = baseUrl;
    }

    cerebrasClientCache.set(key, new Cerebras(constructorOptions));
  }

  return cerebrasClientCache.get(key);
}

function maskSecret(secret) {
  const value = (secret || '').toString().trim();
  if (!value) return '';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function resolveEnvKeyStatus(keys = []) {
  const detectedKey = keys.find((key) => Boolean((process.env[key] || '').toString().trim()));
  if (!detectedKey) {
    return {
      configured: false,
      envKey: keys[0] || '',
      keyPreview: '',
    };
  }

  const rawValue = (process.env[detectedKey] || '').toString().trim();
  return {
    configured: true,
    envKey: detectedKey,
    keyPreview: maskSecret(rawValue),
  };
}

function getProviderStatusReport() {
  const report = {};

  const geminiState = resolveEnvKeyStatus(['GEMINI_API_KEY']);
  report.gemini = {
    provider: 'gemini',
    configured: geminiState.configured,
    envKey: geminiState.envKey,
    keyPreview: geminiState.keyPreview,
    model: GEMINI_MODEL,
    baseUrl: 'https://generativelanguage.googleapis.com',
  };

  const openAiCompatibleProviders = ['openai', 'grok', 'kimi', 'cerebras'];
  const envMap = {
    openai: ['OPENAI_API_KEY'],
    grok: ['GROK_API_KEY', 'XAI_API_KEY'],
    kimi: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
    cerebras: ['CEREBRAS_API_KEY'],
  };

  for (const provider of openAiCompatibleProviders) {
    const cfg = getProviderRuntimeConfig(provider) || {};
    const state = resolveEnvKeyStatus(envMap[provider] || []);
    report[provider] = {
      provider,
      configured: state.configured,
      envKey: state.envKey,
      keyPreview: state.keyPreview,
      model: cfg.model || '',
      baseUrl: cfg.baseUrl || '',
    };
  }

  const providers = Object.values(report);
  return {
    providers,
    configuredCount: providers.filter((item) => item.configured).length,
    totalCount: providers.length,
    autoOrder: getAutoProviderOrder(),
  };
}

async function probeProvider(provider) {
  const normalized = normalizeLlmProvider(provider);
  const startedAt = Date.now();

  if (!isProviderConfigured(normalized)) {
    return {
      provider: normalized,
      ok: false,
      configured: false,
      model: getProviderModelName(normalized),
      latency_ms: 0,
      error: 'not configured',
    };
  }

  try {
    if (normalized === 'gemini') {
      await callGeminiPrompt('Return JSON only: {"ok":true}');
    } else {
      await callOpenAiCompatiblePrompt(normalized, 'Return JSON only: {"ok":true}', { maxTokens: 20 });
    }

    return {
      provider: normalized,
      ok: true,
      configured: true,
      model: getProviderModelName(normalized),
      latency_ms: Date.now() - startedAt,
      error: '',
    };
  } catch (err) {
    return {
      provider: normalized,
      ok: false,
      configured: true,
      model: getProviderModelName(normalized),
      latency_ms: Date.now() - startedAt,
      error: stringifyProviderError(normalized, err),
    };
  }
}

async function getLiveProviderStatusReport() {
  const base = getProviderStatusReport();
  const providersToProbe = base.autoOrder || [];
  const probeResults = await Promise.all(providersToProbe.map((provider) => probeProvider(provider)));
  return {
    ...base,
    live: probeResults,
  };
}

function isProviderConfigured(provider) {
  const normalized = normalizeLlmProvider(provider);
  if (normalized === 'gemini') return Boolean(GEMINI_API_KEY);
  if (normalized === 'auto') return true;
  const cfg = getProviderRuntimeConfig(normalized);
  return Boolean(cfg?.apiKey);
}

function getOperationPreferredOrder(operation = 'generic') {
  const op = (operation || 'generic').toString().trim().toLowerCase();

  // For officer extraction/search/image mapping, prioritize multilingual + structured extraction quality.
  if (['extractcontactfromtext', 'searchwebforoffice', 'mapofficerimagesfromcandidates', 'matchofficestonews', 'extractearlyrtioffice'].includes(op)) {
    return ['gemini', 'kimi', 'openai', 'grok', 'cerebras'];
  }

  // For quick extraction, favor Gemini's multilingual entity quality first.
  if (['analyzequick'].includes(op)) {
    return ['gemini', 'kimi', 'openai', 'grok', 'cerebras'];
  }

  // For long-form summary/deep analysis, keep Gemini primary and OpenAI as fallback.
  if (['generatefullsummary', 'analyzedeep_a', 'analyzedeep_b'].includes(op)) {
    return ['gemini', 'kimi', 'openai', 'grok', 'cerebras'];
  }

  return ['gemini', 'kimi', 'openai', 'grok', 'cerebras'];
}

function getAutoProviderOrder(operation = 'generic') {
  const preferredRaw = (process.env.LLM_AUTO_ORDER || '').toString().trim();
  const envPreferred = preferredRaw
    ? preferredRaw.split(',').map((item) => normalizeLlmProvider(item)).filter((item) => item !== 'auto')
    : [];

  // When LLM_AUTO_ORDER is explicitly set, treat it as the complete allowed
  // list — e.g. restricting to just the providers with working accounts —
  // rather than merging it with the hardcoded per-operation preferences.
  if (envPreferred.length > 0) {
    return Array.from(new Set(envPreferred)).filter((provider) => isProviderConfigured(provider));
  }

  const operationPreferred = getOperationPreferredOrder(operation);
  const baseline = ['gemini', 'kimi', 'openai', 'grok', 'cerebras'];
  const merged = [...operationPreferred, ...baseline];
  return Array.from(new Set(merged)).filter((provider) => isProviderConfigured(provider));
}

function extractAssistantMessage(choice = {}) {
  const message = choice?.message || {};
  const content = message?.content;

  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        if (part && typeof part.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

function resolveReasoningDetails(responseData = {}, choice = {}) {
  return (
    choice?.reasoning_details
    || choice?.message?.reasoning_details
    || choice?.reasoning
    || choice?.message?.reasoning
    || responseData?.reasoning_details
    || responseData?.reasoning
    || null
  );
}

function stringifyProviderError(provider, err) {
  const status = err?.status || err?.response?.status;
  const bodyError = err?.error;
  const dataMessage = err?.response?.data?.error?.message
    || err?.response?.data?.message
    || err?.response?.data?.error
    || bodyError?.message
    || bodyError?.error
    || '';
  const msg = dataMessage || err?.message || 'Unknown provider error';
  return `[${provider}] ${status ? `HTTP ${status}: ` : ''}${msg}`;
}

async function callGeminiPrompt(prompt, runtimeOptions = {}) {
  const m = getModel();
  if (!m) throw new Error('[gemini] GEMINI_API_KEY missing');

  const maxRetries = Number.isFinite(Number(runtimeOptions?.maxRetries))
    ? Number(runtimeOptions.maxRetries)
    : 3;
  const baseDelayMs = Number.isFinite(Number(runtimeOptions?.baseDelayMs))
    ? Number(runtimeOptions.baseDelayMs)
    : 2000;

  const result = await retryWithBackoff(async () => m.generateContent(prompt), maxRetries, baseDelayMs);
  const response = await result.response;
  return {
    text: response.text(),
    providerUsed: 'gemini',
    reasoningDetails: null,
  };
}

const DEFAULT_TEMPERATURE_ONLY = new Set();

async function callOpenAiCompatiblePrompt(provider, prompt, runtimeOptions = {}) {
  const cfg = getProviderRuntimeConfig(provider);
  if (!cfg?.apiKey) {
    throw new Error(`[${provider}] API key not configured`);
  }

  const defaultSystemPrompt = 'Return clean valid JSON when prompted for JSON output. Do not wrap JSON in markdown code fences.';
  const systemPrompt = (runtimeOptions?.systemPrompt || defaultSystemPrompt).toString().trim() || defaultSystemPrompt;

  const modelOverride = (runtimeOptions?.model || runtimeOptions?.modelOverride || '').toString().trim();
  const payload = {
    model: modelOverride || cfg.model,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    // Kimi's current models only accept the default temperature (1) and reject
    // any other value outright, unlike the other OpenAI-compatible providers.
    temperature: provider === 'kimi' ? 1 : 0.15,
  };

  const explicitMaxTokens = Number(runtimeOptions?.maxTokens || 0);
  if (Number.isFinite(explicitMaxTokens) && explicitMaxTokens > 0) {
    // Kimi's current models reason internally before answering (visible in a
    // separate reasoning_content field) and count that reasoning against
    // max_tokens — a budget tuned for a plain non-reasoning model leaves no
    // room for the actual answer and finish_reason comes back "length" with
    // empty content. Give it enough headroom regardless of what was requested.
    // Kimi counts its hidden reasoning against the budget (the task-routing pilot saw up to ~900
    // reasoning tokens and empty answers at 1,200), so it gets the answer budget plus headroom.
    const budget = provider === 'kimi' ? Math.max(explicitMaxTokens + 1500, 2000) : explicitMaxTokens;
    // Newer OpenAI models reject max_tokens; max_completion_tokens is accepted by all current ones.
    if (provider === 'openai') payload.max_completion_tokens = budget;
    else payload.max_tokens = budget;
  }

  const maxRetries = Number.isFinite(Number(runtimeOptions?.maxRetries))
    ? Number(runtimeOptions.maxRetries)
    : (provider === 'cerebras' ? 4 : 3);
  const baseDelayMs = Number.isFinite(Number(runtimeOptions?.baseDelayMs))
    ? Number(runtimeOptions.baseDelayMs)
    : (provider === 'cerebras' ? 1500 : 2000);

  // Some models (e.g. reasoning models) accept only the default temperature; learn that per model
  // from the provider's 400 instead of keeping a list of model names here.
  if (DEFAULT_TEMPERATURE_ONLY.has(`${provider}:${payload.model}`)) delete payload.temperature;
  const create = () => (provider === 'cerebras'
    ? getCerebrasClient(cfg).chat.completions.create(payload)
    : getOpenAiClient(provider, cfg).chat.completions.create(payload));
  const data = await retryWithBackoff(async () => {
    try {
      return await create();
    } catch (err) {
      if ('temperature' in payload && /temperature/i.test(err?.message || '') && /(default|unsupported)/i.test(err?.message || '')) {
        DEFAULT_TEMPERATURE_ONLY.add(`${provider}:${payload.model}`);
        delete payload.temperature;
        return create();
      }
      throw err;
    }
  }, maxRetries, baseDelayMs);

  const choice = data?.choices?.[0] || {};
  const text = extractAssistantMessage(choice);
  const reasoningDetails = resolveReasoningDetails(data, choice);

  if (!text) {
    throw new Error(`[${provider}] Empty response content`);
  }

  return {
    text,
    providerUsed: provider,
    modelUsed: data?.model || payload.model,
    // Token counts exactly as the provider reported them (used by the task-routing evaluation).
    usage: data?.usage || null,
    reasoningDetails,
  };
}

// `task` (see config/llmTaskRouting.js) picks the model per provider; without it the provider
// default model is used.
// `validate(text)` (optional): return true for a usable answer. A parseable-but-empty answer (e.g.
// "{}" or an empty summary) is then treated like a provider failure and the next provider is tried,
// instead of being passed downstream as if it were valid.
async function runPromptWithProvider(prompt, { llmProvider = 'auto', operation = 'generic', maxTokens, timeoutMs, task = '', systemPrompt, validate } = {}) {
  const perProviderTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : parseInt(process.env.LLM_PROVIDER_TIMEOUT_MS || '15000', 10);
  const requestedProvider = normalizeLlmProvider(llmProvider);
  const pinned = task ? llmTaskRouting.pinnedProviderOrder(task) : null;
  const providerOrder = pinned
    ? [...pinned, ...getAutoProviderOrder(operation)]
    : requestedProvider === 'auto'
    ? getAutoProviderOrder(operation)
    : requestedProvider === 'gemini'
      ? ['gemini', 'kimi', 'openai', 'grok', 'cerebras']
      : requestedProvider === 'openai'
        ? ['openai', 'gemini', 'kimi', 'grok', 'cerebras']
        : [requestedProvider, 'gemini', 'kimi', 'openai', 'grok', 'cerebras'];

  const uniqueOrder = Array.from(new Set(providerOrder.filter(Boolean)));
  if (uniqueOrder.length === 0) {
    throw new Error(`No LLM provider configured for operation: ${operation}`);
  }

  const errors = [];
  for (const provider of uniqueOrder) {
    if (!isProviderConfigured(provider)) {
      errors.push(`[${provider}] not configured`);
      continue;
    }

    try {
      if (provider === 'gemini') {
        const out = await withTimeout(callGeminiPrompt(prompt), perProviderTimeoutMs, `[gemini] timed out after ${perProviderTimeoutMs}ms`);
        return { ...out, requestedProvider };
      }

      // Kimi's current models reason internally before answering, which
      // consistently makes it slower than the other providers for the same
      // task — the shared timeout budget isn't long enough for it, and since
      // that's a stable characteristic (not a transient failure), it gets
      // real extra headroom rather than being timed out and skipped.
      const effectiveTimeoutMs = provider === 'kimi'
        ? Math.max(perProviderTimeoutMs, 30000)
        : perProviderTimeoutMs;
      const model = task ? llmTaskRouting.resolveTaskModel(task, provider).model : '';
      const out = await withTimeout(
        callOpenAiCompatiblePrompt(provider, prompt, { maxTokens, model, systemPrompt }),
        effectiveTimeoutMs,
        `[${provider}] timed out after ${effectiveTimeoutMs}ms`
      );
      if (typeof validate === 'function' && !validate(out.text)) {
        throw new Error(`[${provider}] answer rejected: parseable but empty or missing required fields`);
      }
      return { ...out, requestedProvider };
    } catch (err) {
      const message = stringifyProviderError(provider, err);
      console.warn(`⚠️ LLM provider failure (${operation}): ${message}`);
      errors.push(message);
    }
  }

  throw new Error(`All configured LLM providers failed for ${operation}. ${errors.join(' | ')}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeJsonParse(text) {
  // Handle already-parsed objects passed in by mistake
  if (text !== null && typeof text === 'object') return text;

  let cleaned = (text == null ? '' : String(text));

  // Normalize common artifacts
  cleaned = cleaned.replace(/^\uFEFF/, '');
  cleaned = cleaned.replace(/[\u200b\u200c\u200d]/g, '');
  cleaned = cleaned.trim();

  // Prefer content inside markdown code fences (```json ... ``` or ``` ... ```), even if fenced block is not at the beginning.
  const fenced = cleaned.match(/```+(?:json|javascript|js)?\s*([\s\S]*?)```+/i);
  if (fenced && fenced[1]) {
    cleaned = fenced[1].trim();
  } else {
    // Also handle cases like: "```json" then later "```" without regex backtracking issues.
    const fenceIdx = cleaned.indexOf('```');
    if (fenceIdx !== -1) {
      const afterFence = cleaned.slice(fenceIdx + 3);
      const nextFence = afterFence.indexOf('```');
      if (nextFence !== -1) {
        cleaned = afterFence.slice(0, nextFence).replace(/^\s*(json|javascript|js)\s*/i, '').trim();
      }
    }
  }

  // Strip obvious preambles ("Here's the JSON:") by jumping to first JSON opening token.
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  let startIdx = -1;
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) startIdx = firstBrace;
  else if (firstBracket !== -1) startIdx = firstBracket;
  if (startIdx > 0) cleaned = cleaned.slice(startIdx);

  // Trim to last likely JSON closing token.
  const openChar = cleaned[0];
  const closeChar = openChar === '[' ? ']' : '}';
  const endIdx = cleaned.lastIndexOf(closeChar);
  if (endIdx > 0) cleaned = cleaned.slice(0, endIdx + 1);

  // Fix common LLM JSON issues
  cleaned = cleaned
    .replace(/[“”]/g, '"')
    .replace(/,\s*(\}|\])/g, '$1');

  cleaned = cleaned.trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try extracting first complete { ... } block
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objMatch) {
      try { return JSON.parse(objMatch[0].replace(/,\s*(\}|\])/g, '$1')); } catch { /* fall through */ }
    }
    // Try extracting first complete [ ... ] block
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { return JSON.parse(arrMatch[0].replace(/,\s*(\}|\])/g, '$1')); } catch { /* fall through */ }
    }
    return null;
  }
}

function withTimeout(promise, timeoutMs, label = 'timeout') {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;

  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(label)), ms);
  });

  return Promise.race([
    promise.finally(() => clearTimeout(timeoutHandle)),
    timeoutPromise,
  ]);
}

function normalizeEntityKey(entity) {
  const label = (entity?.label || entity?.type || 'ORG').toString().trim().toUpperCase();
  const text = (entity?.text || entity?.name || '').toString().trim().toLowerCase();
  const compact = text.replace(/[\s\u00A0]+/g, ' ').replace(/[\u200b\u200c\u200d]/g, '').trim();
  return `${label}:${compact}`;
}

function mergeConsensusEntities(listA = [], listB = []) {
  const a = Array.isArray(listA) ? listA : [];
  const b = Array.isArray(listB) ? listB : [];
  const map = new Map();

  const add = (src, ent) => {
    const key = normalizeEntityKey(ent);
    if (!key || key.endsWith(':')) return;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        text: ent.text,
        label: ent.label,
        confidence: ent.confidence,
        sources: [src],
      });
      return;
    }

    if (!existing.sources.includes(src)) existing.sources.push(src);
    const c1 = Number(existing.confidence);
    const c2 = Number(ent.confidence);
    const avg = (Number.isFinite(c1) ? c1 : 0.75) * 0.5 + (Number.isFinite(c2) ? c2 : 0.75) * 0.5;
    existing.confidence = Math.max(existing.confidence || 0, Math.min(0.98, avg + (existing.sources.length >= 2 ? 0.08 : 0)));
  };

  a.forEach((ent) => add('gemini', ent));
  b.forEach((ent) => add('openai', ent));

  return Array.from(map.values())
    .sort((x, y) => (y.confidence || 0) - (x.confidence || 0))
    .slice(0, 25);
}

const ENTITY_SYSTEM_PROMPT_BN = 'আপনি বাংলা সংবাদ বিশ্লেষক। শুধুমাত্র JSON অবজেক্ট ফেরত দিন (markdown নয়, কোনো ব্যাখ্যা নয়)।';
const ENTITY_SYSTEM_PROMPT_EN_STRICT = 'Extract government entities from Bengali news. Return ONLY a pure JSON object (no markdown, no preamble). Output must start with { and end with }.';

function buildEntityExtractionUserPrompt(articleText) {
  return `এই সংবাদ থেকে সরকারি ব্যক্তি (PER) এবং সরকারি সংস্থা/দপ্তর/মন্ত্রণালয় (ORG) শনাক্ত করুন।

শুধুমাত্র JSON ফেরত দিন (অন্য কথা নয়)।

স্কিমা:
{
  "entities": [
    {"text": "নাম বা সংস্থার নাম", "label": "PER|ORG|LOC", "confidence": 0.0}
  ]
}

উদাহরণ:
ইনপুট: "মন্ত্রী রহিম আজ বলেন"
আউটপুট: {"entities":[{"text":"রহিম","label":"PER","confidence":0.9}]}

সংবাদ:
${articleText}
`;
}

function sleep(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, value));
}

function toBengaliDigits(value) {
  const str = (value == null ? '' : String(value));
  const map = {
    0: '০',
    1: '১',
    2: '২',
    3: '৩',
    4: '৪',
    5: '৫',
    6: '৬',
    7: '৭',
    8: '৮',
    9: '৯',
  };
  return str.replace(/[0-9]/g, (d) => map[d] || d);
}

function cleanBanglaValue(value) {
  return (value == null ? '' : String(value))
    .replace(/^[\s\uFEFF]+|[\s\uFEFF]+$/g, '')
    .replace(/[\u200b\u200c\u200d]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeGovernmentEntities(rawEntities = []) {
  const list = Array.isArray(rawEntities) ? rawEntities : [];
  const out = [];
  const seen = new Set();

  for (const raw of list) {
    const obj = (raw && typeof raw === 'object') ? raw : { name: raw };

    const type     = (obj.type || '').toString().trim().toLowerCase() || 'officer';
    const name     = toBengaliDigits(cleanBanglaValue(obj.name || obj.text || obj.entity || ''));
    const title    = toBengaliDigits(cleanBanglaValue(obj.title || obj.designation || obj.role || ''));
    const ministry = toBengaliDigits(cleanBanglaValue(obj.ministry || ''));
    const office   = toBengaliDigits(cleanBanglaValue(obj.office || obj.department || ''));
    const division = toBengaliDigits(cleanBanglaValue(obj.division || ''));
    const district = toBengaliDigits(cleanBanglaValue(obj.district || obj.location || ''));
    const upazila  = toBengaliDigits(cleanBanglaValue(obj.upazila || obj.thana || ''));
    const underMin = toBengaliDigits(cleanBanglaValue(obj.under_minister || obj.underMinister || ''));

    // Must have at least a name OR a ministry/office to be meaningful
    if (!name && !ministry && !office) continue;

    const key = [name, title, ministry, office, division, district].join('|').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const entity = { type, name, title, ministry, office, division, district };
    if (upazila)  entity.upazila       = upazila;
    if (underMin) entity.under_minister = underMin;

    out.push(entity);
    if (out.length >= 30) break;
  }

  return out;
}

function buildBengaliGovernmentEntityPrompt(newsText, knownBodies = '') {
  return `You are an expert in Bangladesh government structure. Extract ALL Bangladesh government entities from the Bengali news article below — named officers AND unnamed ministries/offices/authorities.

BANGLADESH GOVERNMENT TITLES (পদবী) — recognize these and similar:
প্রধান উপদেষ্টা, উপদেষ্টা, রাষ্ট্রপতি, স্পিকার, প্রধানমন্ত্রী, মন্ত্রী, প্রতিমন্ত্রী, উপমন্ত্রী, সচিব, অতিরিক্ত সচিব, যুগ্মসচিব, উপসচিব, সিনিয়র সহকারী সচিব, সহকারী সচিব, মহাপরিচালক, অতিরিক্ত মহাপরিচালক, পরিচালক, উপপরিচালক, সহকারী পরিচালক, নির্বাহী পরিচালক, নির্বাহী চেয়ারম্যান, চেয়ারম্যান, কমিশনার, বিভাগীয় কমিশনার, জেলা প্রশাসক, ডিসি, পুলিশ সুপার, এসপি, উপজেলা নির্বাহী অফিসার, ইউএনও, মেয়র, প্রধান প্রকৌশলী, নির্বাহী প্রকৌশলী, সহকারী প্রকৌশলী, নির্বাহী ম্যাজিস্ট্রেট, ম্যাজিস্ট্রেট, আইজিপি, ডিআইজি, তথ্য কমিশনার, প্রধান তথ্য কমিশনার, রেজিস্ট্রার, উপাচার্য, অধ্যক্ষ

BANGLADESH MINISTRIES (মন্ত্রণালয়/বিভাগ) — recognize these and similar:
মন্ত্রিপরিষদ বিভাগ | জনপ্রশাসন মন্ত্রণালয় | অর্থ মন্ত্রণালয় | অর্থ বিভাগ | পরিকল্পনা মন্ত্রণালয় | স্বরাষ্ট্র মন্ত্রণালয় | পররাষ্ট্র মন্ত্রণালয় | আইন, বিচার ও সংসদ বিষয়ক মন্ত্রণালয় | তথ্য ও সম্প্রচার মন্ত্রণালয় | শিক্ষা মন্ত্রণালয় | প্রাথমিক ও গণশিক্ষা মন্ত্রণালয় | স্বাস্থ্য ও পরিবার কল্যাণ মন্ত্রণালয় | স্বাস্থ্য সেবা বিভাগ | কৃষি মন্ত্রণালয় | মৎস্য ও প্রাণিসম্পদ মন্ত্রণালয় | বন, পরিবেশ ও জলবায়ু পরিবর্তন মন্ত্রণালয় | শিল্প মন্ত্রণালয় | বাণিজ্য মন্ত্রণালয় | বস্ত্র ও পাট মন্ত্রণালয় | শ্রম ও কর্মসংস্থান মন্ত্রণালয় | সমাজকল্যাণ মন্ত্রণালয় | মহিলা ও শিশু বিষয়ক মন্ত্রণালয় | মুক্তিযুদ্ধ বিষয়ক মন্ত্রণালয় | সড়ক পরিবহন ও সেতু মন্ত্রণালয় | রেলপথ মন্ত্রণালয় | নৌপরিবহন মন্ত্রণালয় | বেসামরিক বিমান পরিবহন ও পর্যটন মন্ত্রণালয় | ডাক ও টেলিযোগাযোগ মন্ত্রণালয় | তথ্য ও যোগাযোগ প্রযুক্তি বিভাগ | বিজ্ঞান ও প্রযুক্তি মন্ত্রণালয় | পানি সম্পদ মন্ত্রণালয় | বিদ্যুৎ, জ্বালানি ও খনিজ সম্পদ মন্ত্রণালয় | বিদ্যুৎ বিভাগ | জ্বালানি ও খনিজ সম্পদ বিভাগ | গৃহায়ন ও গণপূর্ত মন্ত্রণালয় | ভূমি মন্ত্রণালয় | স্থানীয় সরকার বিভাগ | পল্লী উন্নয়ন ও সমবায় বিভাগ | পার্বত্য চট্টগ্রাম বিষয়ক মন্ত্রণালয় | দুর্যোগ ব্যবস্থাপনা ও ত্রাণ মন্ত্রণালয় | সংস্কৃতি বিষয়ক মন্ত্রণালয় | যুব ও ক্রীড়া মন্ত্রণালয় | ধর্ম বিষয়ক মন্ত্রণালয় | প্রবাসী কল্যাণ ও বৈদেশিক কর্মসংস্থান মন্ত্রণালয় | খাদ্য মন্ত্রণালয় | প্রতিরক্ষা মন্ত্রণালয়

OFFICE TYPES (recognize anything with these suffixes):
অধিদপ্তর, দপ্তর, পরিদপ্তর, বোর্ড, করপোরেশন, কর্তৃপক্ষ, কমিশন, ব্যুরো, ইনস্টিটিউট, একাডেমি, ফাউন্ডেশন, সংস্থা, পরিষদ, পর্ষদ, কেন্দ্র

ADMINISTRATIVE DIVISIONS: ঢাকা, চট্টগ্রাম, রাজশাহী, খুলনা, বরিশাল, সিলেট, রংপুর, ময়মনসিংহ

RULES:
- Extract ONLY Bangladesh government entities (সরকারি প্রতিষ্ঠান ও কর্মকর্তা)
- Include entities even if NO officer name is mentioned — ministry/office alone qualifies
- Use EXACT Bangla text from the article; do NOT translate or invent
- "type": use "officer" for named persons, "ministry" for মন্ত্রণালয়/বিভাগ, "office" for অধিদপ্তর/বোর্ড/কর্তৃপক্ষ etc.
- Leave fields as "" if not stated in the article
- Do NOT duplicate: if an office is already captured as "office" field of an officer, still add it as a separate office entity

${knownBodies ? `GOVERNMENT BODIES ALREADY IDENTIFIED IN THIS ARTICLE (exact dictionary match — attach each named officer to the right one of these; use these exact names in "ministry"/"office" when they apply):
${knownBodies}

` : ''}NEWS ARTICLE:
${newsText}

Return ONLY this JSON (no markdown fences, no explanation):
{
  "entities": [
    {
      "type": "officer|ministry|office",
      "name": "ব্যক্তির নাম বা প্রতিষ্ঠানের নাম",
      "title": "পদবী (শুধু অফিসারের জন্য)",
      "ministry": "মন্ত্রণালয়ের পূর্ণ নাম",
      "office": "অধিদপ্তর/বোর্ড/কর্তৃপক্ষের নাম",
      "division": "প্রশাসনিক বিভাগ",
      "district": "জেলা",
      "upazila": "উপজেলা"
    }
  ]
}

EXAMPLES:
Article: "স্বরাষ্ট্র মন্ত্রণালয়ের সচিব আবুল হাসান আজ জানান..."
JSON: {"entities": [{"type":"officer","name":"আবুল হাসান","title":"সচিব","ministry":"স্বরাষ্ট্র মন্ত্রণালয়","office":"","division":"","district":"","upazila":""},{"type":"ministry","name":"স্বরাষ্ট্র মন্ত্রণালয়","title":"","ministry":"স্বরাষ্ট্র মন্ত্রণালয়","office":"","division":"","district":"","upazila":""}]}

Article: "পরিবেশ অধিদপ্তর ও বাংলাদেশ পানি উন্নয়ন বোর্ড যৌথভাবে জানিয়েছে..."
JSON: {"entities": [{"type":"office","name":"পরিবেশ অধিদপ্তর","title":"","ministry":"বন, পরিবেশ ও জলবায়ু পরিবর্তন মন্ত্রণালয়","office":"পরিবেশ অধিদপ্তর","division":"","district":"","upazila":""},{"type":"office","name":"বাংলাদেশ পানি উন্নয়ন বোর্ড","title":"","ministry":"পানি সম্পদ মন্ত্রণালয়","office":"বাংলাদেশ পানি উন্নয়ন বোর্ড","division":"","district":"","upazila":""}]}

Article: "গাজীপুরের জেলা প্রশাসক রহিম উদ্দিন বলেন, সড়ক ও জনপথ অধিদপ্তরের নির্বাহী প্রকৌশলী করিম হোসেন..."
JSON: {"entities": [{"type":"officer","name":"রহিম উদ্দিন","title":"জেলা প্রশাসক","ministry":"জনপ্রশাসন মন্ত্রণালয়","office":"","division":"ঢাকা","district":"গাজীপুর","upazila":""},{"type":"officer","name":"করিম হোসেন","title":"নির্বাহী প্রকৌশলী","ministry":"সড়ক পরিবহন ও সেতু মন্ত্রণালয়","office":"সড়ক ও জনপথ অধিদপ্তর","division":"","district":"","upazila":""},{"type":"office","name":"সড়ক ও জনপথ অধিদপ্তর","title":"","ministry":"সড়ক পরিবহন ও সেতু মন্ত্রণালয়","office":"সড়ক ও জনপথ অধিদপ্তর","division":"","district":"","upazila":""}]}
`;
}

async function extractBengaliGovernmentEntities(newsText, options = {}) {
  const text = cleanBanglaValue(newsText);
  if (!text) {
    return {
      entities: [],
      provider: 'none',
      status: 'failed',
      error: 'empty input',
    };
  }

  const systemPrompt = 'You are an expert in Bangladesh government structure. Extract all Bangladesh government entities (officers, ministries, offices, boards, authorities) from Bengali news. Return ONLY a JSON object with an "entities" array — no markdown, no explanation.';
  const known = rtiGazetteer.matchGovernmentBodies(text).matches.slice(0, 6)
    .map((m) => `${m.canonical}${m.agencies.length ? ` (via ${m.agencies.join(', ')})` : ''}`).join('; ');
  const userPrompt = buildBengaliGovernmentEntityPrompt(text, known);

  const globalDeadline = Date.now() + 24000;

  // The user's chosen provider first (like analyzeQuick), then the configured auto order; the model
  // comes from config/llmTaskRouting.js (task person_designation_extraction), never a literal here.
  const requested = normalizeLlmProvider(options?.llmProvider || 'auto');
  const order = Array.from(new Set([
    ...(requested === 'auto' ? [] : [requested]),
    ...getAutoProviderOrder('extractContactFromText'),
  ])).filter((name) => name !== 'gemini' && name !== 'auto');
  const providers = order.map((name) => ({
    name,
    configured: () => isProviderConfigured(name),
    call: async ({ timeoutMs }) => withTimeout(callOpenAiCompatiblePrompt(name, userPrompt, {
      maxTokens: parseInt(process.env.OPENAI_ENTITY_MAX_TOKENS || '1200', 10),
      model: llmTaskRouting.resolveTaskModel('person_designation_extraction', name).model,
      systemPrompt: `${systemPrompt}`,
      maxRetries: 0,
      baseDelayMs: 0,
    }), timeoutMs, `${name} entity extraction timeout`),
  }));

  const errors = [];

  for (const provider of providers) {
    if (Date.now() >= globalDeadline) break;
    if (!provider.configured()) {
      errors.push(`[${provider.name}] not configured`);
      continue;
    }

    // Kimi reasons before answering and needs more time (same rationale as runPromptWithProvider).
    const providerDeadline = Math.min(globalDeadline, Date.now() + (provider.name === 'kimi' ? 22000 : 8000));
    let lastErr = null;
    let parseFailed = false;

    for (let attempt = 0; attempt <= 2; attempt++) {
      const remaining = providerDeadline - Date.now();
      if (remaining < 500) break;

      try {
        const llmOut = await provider.call({ timeoutMs: remaining });
        const parsed = safeJsonParse(llmOut?.text);
        if (!parsed || !Array.isArray(parsed.entities)) {
          parseFailed = true;
          lastErr = new Error('invalid JSON response');
          break;
        }

        const normalizedEntities = normalizeGovernmentEntities(parsed.entities);
        if (normalizedEntities.length === 0) {
          lastErr = new Error('no entities found');
          break;
        }

        return {
          entities: normalizedEntities,
          provider: provider.name,
          status: 'success',
        };
      } catch (err) {
        lastErr = err;
        if (attempt >= 2) break;

        // Only retry on call errors/timeouts, not on parse errors.
        const waitMs = attempt === 0 ? 2000 : 4000;
        if (Date.now() + waitMs + 500 > providerDeadline) break;
        await sleep(waitMs);
      }
    }

    if (parseFailed) {
      errors.push(`[${provider.name}] parse failed`);
    } else {
      errors.push(`[${provider.name}] ${lastErr?.message || 'failed'}`);
    }
  }

  // No regex/heuristic substitute: if every LLM fails, say so (the caller shows it as unavailable).
  return {
    entities: [],
    provider: 'none',
    status: 'failed',
    error: `All LLM providers failed. ${errors.join(' | ')}`,
  };
}

async function extractGovernmentEntitiesConsensus(articleText, { timeoutMs = 8000, providers } = {}) {
  const text = (articleText || '').toString().trim();
  if (!text) return [];

  const userPrompt = buildEntityExtractionUserPrompt(text);

  // Cross-check between two independently-configured providers for higher
  // reliability. This used to hardcode Gemini + OpenAI specifically, which
  // silently degraded to "OpenAI only" the moment Gemini's key was removed —
  // Grok/Kimi were configured but never actually consulted. Now it picks
  // whichever two providers are actually configured, honoring an explicit
  // request (e.g. the user picked "kimi") as the first voter when given.
  const candidateProviders = (Array.isArray(providers) && providers.length > 0)
    ? providers
    : getAutoProviderOrder('extractContactFromText');
  const [providerA, providerB] = Array.from(new Set(candidateProviders))
    .filter((p) => isProviderConfigured(p))
    .slice(0, 2);

  const callProvider = (provider) => {
    if (!provider) return Promise.reject(new Error('no provider available'));
    if (provider === 'gemini') {
      return withTimeout(callGeminiPrompt(`${ENTITY_SYSTEM_PROMPT_BN}\n\n${userPrompt}`), timeoutMs, 'gemini entity extraction timeout');
    }
    return withTimeout(callOpenAiCompatiblePrompt(provider, userPrompt, {
      maxTokens: parseInt(process.env.ENTITY_EXTRACT_MAX_TOKENS || '420', 10),
      systemPrompt: ENTITY_SYSTEM_PROMPT_EN_STRICT,
      model: llmTaskRouting.resolveTaskModel('entity_consensus', provider).model,
    }), timeoutMs, `${provider} entity extraction timeout`);
  };

  const [resultA, resultB] = await Promise.allSettled([callProvider(providerA), callProvider(providerB)]);

  const parsedA = resultA.status === 'fulfilled' ? safeJsonParse(resultA.value.text) : null;
  const parsedB = resultB.status === 'fulfilled' ? safeJsonParse(resultB.value.text) : null;

  const listA = normalizeEntityArray(parsedA?.entities || [], 25);
  const listB = normalizeEntityArray(parsedB?.entities || [], 25);

  const merged = mergeConsensusEntities(listA, listB);

  if (merged.length > 0) return merged;
  if (listA.length > 0) return listA;
  if (listB.length > 0) return listB;
  return [];
}

function normalizeEntityLabel(label = '') {
  const raw = (label || '').toString().trim().toUpperCase();
  if (!raw) return 'ORG';
  if (['PERSON', 'PER', 'HUMAN'].includes(raw)) return 'PER';
  if (['ORG', 'ORGANIZATION', 'GOV', 'MINISTRY', 'DEPARTMENT'].includes(raw)) return 'ORG';
  if (['LOC', 'LOCATION', 'GPE', 'PLACE'].includes(raw)) return 'LOC';
  return raw;
}

function cleanEntityText(value = '') {
  return (value || '')
    .toString()
    .replace(/[\u200b\u200c\u200d]/g, '')
    .replace(/^[\s"'`“”‘’•:;,.!?()[\]{}<>|\\/-]+/g, '')
    .replace(/[\s"'`“”‘’•:;,.!?()[\]{}<>|\\/-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isInvalidEntityText(value = '', { maxLen = 96 } = {}) {
  const text = cleanEntityText(value);
  if (!text) return true;
  if (text.length < 2 || text.length > maxLen) return true;
  if (/^https?:\/\//i.test(text)) return true;
  if (/^[0-9\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_\`{|}~]+$/.test(text)) return true;

  const normalized = text.toLowerCase();
  if (/^(person|org|organization|loc|location|entity|keyword|stakeholder|name|ministry|office)\s*\d*$/i.test(normalized)) return true;
  if (/^(n\/?a|none|null|unknown|not found|unspecified)$/i.test(normalized)) return true;
  if (/^(news|article|report|summary)$/i.test(normalized)) return true;
  if (/^(সরকার|মন্ত্রণালয়|মন্ত্রণালয়|বিভাগ|দপ্তর)$/i.test(normalized)) return true;

  return false;
}

function normalizeEntityArray(entities = [], maxItems = 25) {
  const list = Array.isArray(entities) ? entities : [];
  const out = [];
  const seen = new Set();

  for (const raw of list) {
    const text = cleanEntityText(raw?.text || raw?.name || raw || '');
    const label = normalizeEntityLabel(raw?.label || raw?.type || 'ORG');
    const confidenceRaw = Number(raw?.confidence);
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0.75;

    if (isInvalidEntityText(text)) continue;

    const key = `${label}:${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ text, label, confidence });
    if (out.length >= maxItems) break;
  }

  return out;
}

// maxLen: entity names are capped at 96 chars; highlights/keywords/ministry lists pass a higher cap.
function normalizeTextList(values = [], { maxItems = 8, minLen = 2, maxLen = 96 } = {}) {
  const list = Array.isArray(values) ? values : [];
  const out = [];
  const seen = new Set();

  for (const raw of list) {
    const text = cleanEntityText(raw);
    if (!text || text.length < minLen || isInvalidEntityText(text, { maxLen })) continue;

    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }

  return out;
}

function normalizeSummaryEntities(entities = {}) {
  const asArray = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    return [value];
  };

  const obj = (entities && typeof entities === 'object' && !Array.isArray(entities)) ? entities : {};

  const people = normalizeTextList(asArray(obj.people || obj.persons || obj.per), { maxItems: 12, minLen: 2 });
  const organizations = normalizeTextList(asArray(obj.organizations || obj.orgs || obj.org), { maxItems: 16, minLen: 3 });
  const locations = normalizeTextList(asArray(obj.locations || obj.loc || obj.gpe), { maxItems: 12, minLen: 2 });

  return {
    people,
    organizations,
    locations,
  };
}

function truncateToWords(text, maxWords = 2000) {
  const clean = (text || '').toString().replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const words = clean.split(' ');
  if (words.length <= maxWords) return clean;
  return words.slice(0, maxWords).join(' ');
}

// Retry with exponential backoff for rate-limited provider calls
// UPGRADED: more retries (3) and shorter base delay (2s) for better throughput
async function retryWithBackoff(fn, maxRetries = 3, baseDelayMs = 2000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // A spending-cap / billing block returns HTTP 429 too, but unlike a rate
      // limit it will not clear up within the next few seconds — retrying just
      // burns the request's time budget for no benefit. Fail fast instead so
      // the caller can move on to the next provider immediately.
      const isPermanentBillingBlock = /spending cap|billing|insufficient.?funds|exceeded its monthly/i.test(err.message || '');
      const is429 = !isPermanentBillingBlock
        && (err.message?.includes('429') || err.message?.includes('quota') || err.message?.includes('Too Many Requests'));
      if (is429 && attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.log(`⏳ LLM provider rate limited, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// ─── 1. Quick Analysis (used by /api/analyze) ────────────────────────────────

async function analyzeQuick(text, url = '', options = {}) {
  const requestedProvider = normalizeLlmProvider(options?.llmProvider || options?.provider || 'auto');
  const truncated = truncateToWords(text, parseInt(process.env.ANALYZE_MAX_WORDS || '2000', 10));

  // Approach 1 + 3:
  //  - Keep analysis prompt short (avoid 10+ conflicting instructions)
  //  - Extract entities via dual-model consensus (Gemini + OpenAI) for higher reliability
  let consensusEntities = [];
  try {
    const entityTimeoutMs = parseInt(process.env.ENTITY_EXTRACT_TIMEOUT_MS || '8000', 10);
    consensusEntities = await extractGovernmentEntitiesConsensus(truncated, {
      // Kimi reasons before answering and is consistently slower than the
      // other providers — same rationale as the main-call timeout above.
      timeoutMs: requestedProvider === 'kimi' ? Math.max(entityTimeoutMs, 30000) : entityTimeoutMs,
      providers: requestedProvider === 'auto' ? undefined : [requestedProvider],
    });
  } catch (e) {
    consensusEntities = [];
  }

  // ── UPGRADED: Semantic Phrase-Based Ministry Mapping ──────────────
  // Phase 1: Entity extraction first, then deep semantic ministry matching
  // Uses contextual understanding instead of keyword frequency
  const entityContext = consensusEntities.length > 0
    ? JSON.stringify(consensusEntities.map((e) => ({ text: e.text, label: e.label })), null, 0)
    : '[]';

  // Deterministic gazetteer match against JAANI_RTI_OFFICERS_COMPLETE.csv — the primary signal
  // for which government bodies the article is about; the LLM gets it as context.
  const gazetteerFirst = rtiGazetteer.matchGovernmentBodies(truncated);
  const knownBodies = gazetteerFirst.matches.length
    ? gazetteerFirst.matches.slice(0, 6).map((m) => `${m.canonical}${m.agencies.length ? ` (via ${m.agencies.join(', ')})` : ''}`).join('; ')
    : 'none found';

  const prompt = `You are a Bangladesh news + RTI analysis assistant.

Input: Bengali or English news text.
Output: Return ONLY a valid JSON object (no markdown, no preamble).

Already-extracted entities (read-only; do not add commentary):
${entityContext}

Government bodies already identified in the text by an exact dictionary match (use these names
for related_ministry / rti_target_office when they fit; do not invent other ministries):
${knownBodies}

NEWS:
${truncated}

Return this exact JSON schema (use empty strings/arrays when unknown):
{
  "civic_grievance": "...",
  "category": "Politics|Economy|Education|Health|Law & Justice|Environment|Agriculture|Technology|Defense|Infrastructure|Social Issues|Religion|Sports|International|General",
  "category_confidence": 0.0,
  "keywords": ["..."],
  "language": "bn|en",
  "summary": "...",
  "related_ministry": "...",
  "related_ministries": ["..."],
  "ministry_reasoning": "...",
  "rti_target_office": "...",
  "highlights": ["..."]
}`;

  try {
    const llmResult = await runPromptWithProvider(prompt, {
      llmProvider: requestedProvider,
      operation: 'analyzeQuick',
      task: 'summary_and_highlights',
      maxTokens: parseInt(process.env.ANALYZE_QUICK_MAX_TOKENS || '900', 10),
      validate: (text) => {
        const j = safeJsonParse(text);
        return Boolean(j && typeof j.summary === 'string' && j.summary.trim().length >= 20);
      },
    });
    const parsed = safeJsonParse(llmResult.text);

    if (!parsed) {
      console.warn('⚠️  LLM returned unparsable response for analyzeQuick');
      return unavailableQuickAnalysis(truncated, {
        requestedProvider,
        providerUsed: llmResult.providerUsed,
        reason: 'The AI provider returned a response that could not be read.',
        consensusEntities,
      });
    }

    const normalizedEntities = consensusEntities.length > 0
      ? normalizeEntityArray(consensusEntities, 25)
      : normalizeEntityArray(parsed.entities || [], 25);

    console.log('DEBUG: Normalized entities:', JSON.stringify(normalizedEntities, null, 2));
    const normalizedKeywords = normalizeTextList(parsed.keywords || [], { maxItems: 10, minLen: 2, maxLen: 220 });
    const normalizedRelatedMinistries = normalizeTextList(parsed.related_ministries || [], { maxItems: 5, minLen: 3, maxLen: 220 });
    const normalizedHighlights = normalizeTextList(parsed.highlights || [], { maxItems: 6, minLen: 8, maxLen: 220 });
    const relatedMinistry = cleanEntityText(parsed.related_ministry || '');
    const rtiTargetOffice = cleanEntityText(parsed.rti_target_office || '');
    const civicGrievance = cleanEntityText(parsed.civic_grievance || parsed.civicGrievance || '');

    // ── Gazetteer match (primary) + the LLM's organisation names as a secondary cross-check ──
    const gov = buildGovernmentContext(truncated, normalizedEntities, [
      relatedMinistry, rtiTargetOffice, ...normalizedRelatedMinistries,
    ]);

    return {
      civic_grievance: civicGrievance,
      entities: gov.entities,
      enriched_entities: gov.enrichedEntities,
      mentioned_gov_orgs: gov.mentionedGovOrgs,
      gov_body_matches: gov.bodyMatches,
      // P9: the LLM's "related ministries", kept only when they resolve to a real ministry/division
      // of the RTI dataset (official spelling), minus those already found in the text.
      related_ministries_verified: verifyRelatedMinistries([relatedMinistry, ...normalizedRelatedMinistries], gov.mentionedGovOrgs),
      category: parsed.category || 'General',
      category_confidence: parsed.category_confidence || 0.5,
      keywords: normalizedKeywords,
      language: parsed.language || 'en',
      summary: parsed.summary || '',
      related_ministry: relatedMinistry,
      related_ministries: normalizedRelatedMinistries,
      ministry_reasoning: parsed.ministry_reasoning || '',
      rti_target_office: rtiTargetOffice,
      highlights: normalizedHighlights,
      processing_time_ms: 0,
      source: llmResult.providerUsed || 'unknown',
      llm_provider_requested: requestedProvider,
      llm_provider_used: llmResult.providerUsed || '',
      llm_model_used: llmResult.modelUsed || getProviderModelName(llmResult.providerUsed || ''),
      reasoning_details: llmResult.reasoningDetails || null,
    };
  } catch (err) {
    console.error('❌ analyzeQuick provider error:', err.message);
    return unavailableQuickAnalysis(truncated, {
      requestedProvider,
      providerUsed: '',
      reason: 'No AI provider answered.',
      consensusEntities,
    });
  }
}

function verifyRelatedMinistries(names = [], alreadyShown = []) {
  const shown = new Set(alreadyShown.map((n) => rtiGazetteer.normalizeText(n)));
  const out = [];
  names.filter(Boolean).forEach((name) => {
    const m = rtiGazetteer.matchGovernmentBodies(name).matches[0];
    if (!m || m.method === 'fuzzy') return;
    const key = rtiGazetteer.normalizeText(m.canonical);
    if (shown.has(key) || out.includes(m.canonical)) return;
    out.push(m.canonical);
  });
  return out.slice(0, 5);
}

/**
 * Government context for Section 2: gazetteer matches over the article (deterministic), then the
 * LLM's organisation names run through the same gazetteer as a cross-check. Matched bodies are
 * added to the entity list as ORG so "Detected Organizations" shows them.
 */
function buildGovernmentContext(articleText, entities = [], aiOrgNames = []) {
  const aiNames = [
    ...(entities || []).filter((e) => e.label === 'ORG').map((e) => e.text),
    ...aiOrgNames,
  ].filter(Boolean);
  const { matches, mentionedGovOrgs } = rtiGazetteer.matchGovernmentBodies(articleText, aiNames);

  const merged = [...(entities || [])];
  const have = new Set(merged.map((e) => rtiGazetteer.normalizeText(e.text)));
  mentionedGovOrgs.forEach((name) => {
    const key = rtiGazetteer.normalizeText(name);
    if (have.has(key)) return;
    have.add(key);
    merged.push({ text: name, label: 'ORG', confidence: 0.9, source: 'gazetteer' });
  });
  // Places from the fixed divisions/districts list (P8) — the LLMs rarely return locations.
  locationGazetteer.detectLocations(articleText).slice(0, 8).forEach((loc) => {
    const key = rtiGazetteer.normalizeText(loc.name);
    if (have.has(key)) return;
    have.add(key);
    merged.push({ text: loc.name, label: 'LOC', confidence: 0.9, source: 'gazetteer' });
  });

  return {
    entities: merged,
    enrichedEntities: rtiGazetteer.buildEnrichedEntities(matches),
    mentionedGovOrgs,
    bodyMatches: matches.map((m) => ({
      name: m.canonical, level: m.level, method: m.method, agencies: m.agencies, mentions: m.mentions,
    })),
  };
}

async function extractEarlyRtiOffice(text, options = {}) {
  const requestedProvider = normalizeLlmProvider(options?.llmProvider || options?.provider || 'auto');
  const truncated = truncateToWords(text, parseInt(process.env.ANALYZE_EARLY_OFFICE_MAX_WORDS || '450', 10));
  if (!truncated) return '';

  const prompt = `Identify the single most relevant Bangladesh government office for RTI filing from this news excerpt.

Return JSON only:
{"rti_target_office":"...","related_ministry":"..."}

NEWS:
${truncated}`;

  try {
    const llmResult = await runPromptWithProvider(prompt, {
      llmProvider: requestedProvider,
      operation: 'extractEarlyRtiOffice',
      maxTokens: parseInt(process.env.ANALYZE_EARLY_OFFICE_MAX_TOKENS || '160', 10),
    });

    const parsed = safeJsonParse(llmResult.text) || {};
    return (parsed.rti_target_office || parsed.related_ministry || '').toString().trim();
  } catch (err) {
    return '';
  }
}

/**
 * Every AI provider failed (or answered unreadably). No heuristic summary, category, keywords or
 * placeholder officer is invented; the deterministic gazetteer result is still returned because
 * it is not AI output.
 */
function unavailableQuickAnalysis(text, options = {}) {
  const gov = buildGovernmentContext(text, normalizeEntityArray(options.consensusEntities || [], 25), []);
  return {
    analysis_unavailable: true,
    unavailable_reason: options.reason || 'AI analysis is unavailable right now.',
    civic_grievance: '',
    entities: gov.entities,
    enriched_entities: gov.enrichedEntities,
    mentioned_gov_orgs: gov.mentionedGovOrgs,
    gov_body_matches: gov.bodyMatches,
    category: '',
    category_confidence: 0,
    keywords: [],
    language: /[\u0980-\u09FF]/.test(text || '') ? 'bn' : 'en',
    summary: '',
    related_ministry: '',
    related_ministries: [],
    ministry_reasoning: '',
    rti_target_office: '',
    highlights: [],
    processing_time_ms: 0,
    source: '',
    llm_provider_requested: normalizeLlmProvider(options?.requestedProvider || 'auto'),
    llm_provider_used: options?.providerUsed || '',
    llm_model_used: getProviderModelName(options?.providerUsed || ''),
    reasoning_details: null,
  };
}

// ─── 2. Full Summary (used by /api/news-summary) ────────────────────────────

async function generateFullSummary(text, url = '', title = '', options = {}) {
  if (url && typeof url === 'object' && !Array.isArray(url)) {
    options = url;
    url = '';
    title = '';
  } else if (title && typeof title === 'object' && !Array.isArray(title)) {
    options = title;
    title = '';
  }

  const requestedProvider = normalizeLlmProvider(options?.llmProvider || options?.provider || 'auto');

  const truncated = text.substring(0, 10000);

  const prompt = `${JAANI_LLM_CONTEXT}

You are an expert journalist and analyst specializing in Bangladesh news, government, and Right-to-Information (RTI).

Analyze the following news article and generate a comprehensive 20-feature analysis.

=== TITLE ===
${title || '(no title)'}
=== NEWS TEXT ===
${truncated}
=== END ===

Return ONLY a valid JSON object (no markdown, no explanation) with ALL these fields:

{
  "tldr": "One-sentence TL;DR summary",
  "keyTakeaways": ["takeaway 1", "takeaway 2", "takeaway 3", "takeaway 4", "takeaway 5"],
  "fullSummary": "A comprehensive 3-5 sentence summary",
  "sentiment": {
    "score": 65,
    "label": "Slightly Negative or Positive or Neutral or Very Positive or Very Negative",
    "confidence": 0.8
  },
  "bias": {
    "label": "Center or Left-leaning or Right-leaning or Pro-government or Anti-government",
    "confidence": 0.7
  },
  "entities": {
    "people": ["person1", "person2"],
    "organizations": ["org1", "org2"],
    "locations": ["loc1", "loc2"]
  },
  "keywords": ["kw1", "kw2", "kw3", "kw4", "kw5"],
  "legalImplications": ["implication 1 if any"],
  "relatedMinistry": "Most relevant Bangladesh government ministry",
  "relatedMinistries": ["ministry1", "ministry2"],
  "language": "bn or en",
  "readability": "Easy or Medium or Hard",
  "topicCategory": "Politics / Economy / Education / Health / etc.",
  "credibilityScore": 75,
  "emotionalTone": "Concerned / Hopeful / Angry / Neutral / etc.",
  "suggested_rti_questions": ["Question 1 to ask via RTI", "Question 2", "Question 3"],
  "timeline": [{"date": "YYYY-MM-DD or timeframe", "event": "Description"}],
  "stakeholders": [{"name": "Stakeholder Name", "role_or_stance": "Description of role"}]
}

IMPORTANT:
- sentiment.score is 0-100 (0=very negative, 50=neutral, 100=very positive)
- credibilityScore is 0-100
- suggested_rti_questions: Provide 3 specific, sharp questions a citizen could ask this office under the RTI Act to get more info about this news event.
- Focus on Bangladesh government context for entity extraction
- Return valid JSON only`;

  try {
    const llmResult = await runPromptWithProvider(prompt, {
      llmProvider: requestedProvider,
      operation: 'generateFullSummary',
      maxTokens: parseInt(options?.maxTokens || process.env.GENERATE_FULL_SUMMARY_MAX_TOKENS || '1800', 10),
    });
    const parsed = safeJsonParse(llmResult.text);

    if (!parsed) {
      console.warn('⚠️  LLM returned unparsable response for generateFullSummary');
      return fallbackFullSummary(text, title, {
        requestedProvider,
        providerUsed: llmResult.providerUsed,
      });
    }

    const normalizedSummaryEntities = normalizeSummaryEntities(parsed.entities || {});
    const normalizedKeywords = normalizeTextList(parsed.keywords || [], { maxItems: 12, minLen: 2 });
    const normalizedRelatedMinistries = normalizeTextList(parsed.relatedMinistries || parsed.related_ministries || [], { maxItems: 5, minLen: 3 });

    const credibilityScoreRaw = Number(parsed.credibilityScore);
    const credibilityScore = Number.isFinite(credibilityScoreRaw)
      ? Math.max(0, Math.min(100, Math.round(credibilityScoreRaw)))
      : 50;

    // ── Enrich summary entities with RTI database lookups ──
    const enrichedOrganizations = rtiLookup.enrichEntities(
      normalizedSummaryEntities.organizations.map((name) => ({ text: name, label: 'ORG', name }))
    );
    const enrichedPeople = rtiLookup.enrichEntities(
      normalizedSummaryEntities.people.map((name) => ({ text: name, label: 'PERSON', name }))
    );

    return {
      tldr: parsed.tldr || '',
      keyTakeaways: normalizeTextList(parsed.keyTakeaways || [], { maxItems: 6, minLen: 8 }),
      fullSummary: parsed.fullSummary || '',
      sentiment: parsed.sentiment || { score: 50, label: 'Neutral', confidence: 0.5 },
      bias: parsed.bias || { label: 'Center', confidence: 0.5 },
      entities: normalizedSummaryEntities,
      enriched_entities: {
        organizations: enrichedOrganizations,
        people: enrichedPeople,
      },
      keywords: normalizedKeywords,
      legalImplications: parsed.legalImplications || [],
      relatedMinistry: cleanEntityText(parsed.relatedMinistry || parsed.related_ministry || ''),
      relatedMinistries: normalizedRelatedMinistries,
      language: parsed.language || 'en',
      readability: parsed.readability || 'Medium',
      topicCategory: parsed.topicCategory || 'General',
      credibilityScore,
      emotionalTone: parsed.emotionalTone || 'Neutral',
      suggested_rti_questions: normalizeTextList(parsed.suggested_rti_questions || [], { maxItems: 5, minLen: 12 }),
      timeline: parsed.timeline || [],
      stakeholders: parsed.stakeholders || [],
      source: llmResult.providerUsed || 'unknown',
      llm_provider_requested: requestedProvider,
      llm_provider_used: llmResult.providerUsed || '',
      reasoning_details: llmResult.reasoningDetails || null,
    };
  } catch (err) {
    console.error('❌ generateFullSummary provider error:', err.message);
    return fallbackFullSummary(text, title, {
      requestedProvider,
      providerUsed: 'fallback',
    });
  }
}

function fallbackFullSummary(text, title, options = {}) {
  const sentences = (text || '').match(/[^.!?।]+[.!?।]+/g) || [];
  return {
    tldr: sentences[0]?.trim() || (text || '').substring(0, 150) + '...',
    keyTakeaways: sentences.slice(0, 5).map(s => s.trim()),
    fullSummary: sentences.slice(0, 3).join(' ').trim(),
    sentiment: { score: 50, label: 'Neutral', confidence: 0.5 },
    bias: { label: 'Center', confidence: 0.5 },
    entities: { people: [], organizations: [], locations: [] },
    enriched_entities: {
      organizations: [],
      people: [],
    },
    keywords: [],
    legalImplications: [],
    suggested_rti_questions: [],
    timeline: [],
    stakeholders: [],
    relatedMinistry: '',
    relatedMinistries: [],
    language: /[\u0980-\u09FF]/.test(text) ? 'bn' : 'en',
    readability: 'Medium',
    topicCategory: 'General',
    credibilityScore: 50,
    emotionalTone: 'Neutral',
    source: 'fallback',
    llm_provider_requested: normalizeLlmProvider(options?.requestedProvider || 'auto'),
    llm_provider_used: options?.providerUsed || 'fallback',
    reasoning_details: null,
  };
}

// ─── 3. Smart Office Matcher (Gemini-enhanced — UPGRADED with semantic matching) ──

/* ── OLD matchOfficesToNews (simple list-based matching) ──
async function matchOfficesToNews(text, officeNames = []) {
  const m = getModel();
  if (!m || officeNames.length === 0) return [];
  const truncatedText = text.substring(0, 4000);
  const officeList = officeNames.slice(0, 100).join('\n');
  const prompt = `...Given a news article and a list of government offices...identify the TOP 4 most relevant offices...`;
  // ... simple matching ...
}
── END OLD matchOfficesToNews ── */

async function matchOfficesToNews(text, officeNames = [], analysisContext = {}, options = {}) {
  if (officeNames.length === 0) return [];
  const requestedProvider = normalizeLlmProvider(options?.llmProvider || options?.provider || 'auto');

  const truncatedText = text.substring(0, 4000);
  const officeList = officeNames.slice(0, 150).join('\n');

  // Use any pre-extracted context from analyzeQuick to improve matching
  const contextHint = analysisContext.related_ministry
    ? `\nHINT: Initial analysis suggests relevance to: ${analysisContext.related_ministry}. ${analysisContext.ministry_reasoning || ''}`
    : '';

  const prompt = `${JAANI_LLM_CONTEXT}

You are an expert in Bangladesh government structure, Right-to-Information (RTI), and public administration.

Given a news article and a list of government offices, perform SEMANTIC MATCHING to identify which offices are most relevant for filing an RTI request about this news.

DO NOT just match keywords. Think about:
1. Which office has JURISDICTION over the news topic?
2. Which office would HOLD the information someone might request via RTI?
3. The ministry/division/directorate HIERARCHY (specific office > parent ministry)
4. Officials mentioned → their parent organizations
5. Subject matter → regulatory/oversight bodies
${contextHint}

=== NEWS TEXT ===
${truncatedText}
=== END ===

=== AVAILABLE OFFICES (choose from these ONLY) ===
${officeList}
=== END ===

Return ONLY a JSON array of the top 4 most relevant office names from the list above, ordered by relevance:
["most relevant office", "second most relevant", "third", "fourth"]

Return valid JSON only. Choose from the provided list only. If no good match exists, return the closest match.`;

  try {
    const llmResult = await runPromptWithProvider(prompt, {
      llmProvider: requestedProvider,
      operation: 'matchOfficesToNews',
    });
    const parsed = safeJsonParse(llmResult.text);

    if (Array.isArray(parsed)) return parsed.slice(0, 4);
    if (parsed && Array.isArray(parsed.offices)) return parsed.offices.slice(0, 4);
    return [];
  } catch (err) {
    console.error('❌ matchOfficesToNews provider error:', err.message);
    return [];
  }
}

// ─── 4. Semantic Ministry Match against contacts DB (NEW) ───────────────────

/**
 * Extract contact details from unstructured text using Gemini
 * Used by /api/verify-contact for web search results
 */
async function extractContactFromText(text, options = {}) {
  const requestedProvider = normalizeLlmProvider(options?.llmProvider || options?.provider || 'auto');

  const truncated = text.substring(0, 12000); // Increased buffer size to capture more context
  const prompt = `${JAANI_LLM_CONTEXT}

You are a data extraction expert handling official Bangladesh Government (RTI) directories.
Extract the details of the 3 key RTI Personnel Officers from the provided unstructured text:
1. Designated Officer / Primary Officer (দায়িত্বপ্রাপ্ত কর্মকর্তা (ক))
2. Alternative Designated Officer (বিকল্প দায়িত্বপ্রাপ্ত কর্মকর্তা (খ))
3. Appellate Authority (আপীল কর্তৃপক্ষ)

Often found in directories, lists, or tables. Look closely for terms like "Name", "Designation", "Mobile", "Phone", "Email".

=== TEXT ===
${truncated}
=== END ===

Return ONLY a valid JSON object with these fields (use empty string if not found):
{
  "primary": {
    "নাম": "Name in Bangla",
    "পদবি": "Designation in Bangla",
    "মোবাইল": "Mobile number",
    "ফোন": "Phone number",
    "ইমেইল": "Email address",
    "ঠিকানা": "Office address"
  },
  "alternate": {
    "নাম": "Name",
    "পদবি": "Designation",
    "মোবাইল": "Mobile",
    "ফোন": "Phone",
    "ইমেইল": "Email",
    "ঠিকানা": "Address"
  },
  "appellate": {
    "নাম": "Name",
    "পদবি": "Designation",
    "মোবাইল": "Mobile",
    "ফোন": "Phone",
    "ইমেইল": "Email",
    "ঠিকানা": "Address"
  }
}
Return JSON only. No explanations.`;

  try {
    const llmResult = await runPromptWithProvider(prompt, {
      llmProvider: requestedProvider,
      operation: 'extractContactFromText',
    });
    const parsed = safeJsonParse(llmResult.text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parsed._llm = {
        requested_provider: requestedProvider,
        provider_used: llmResult.providerUsed || '',
        reasoning_details: llmResult.reasoningDetails || null,
      };
    }
    return parsed;
  } catch (err) {
    console.error('❌ extractContactFromText provider error:', err.message);
    return null;
  }
}

/**
 * semanticMinistryMatch - Two-stage ministry matching:
 *   Stage 1: Use Gemini's analyzeQuick result (related_ministry, related_ministries, rti_target_office)
 *   Stage 2: Fuzzy-match those against actual contact database entries
 *   Stage 3: If no fuzzy match, call matchOfficesToNews for LLM-assisted DB matching
 */
async function semanticMinistryMatch(text, contacts = [], analysisResult = null, options = {}) {
  if (!contacts || contacts.length === 0) return { primary: '', offices: [] };
  const requestedProvider = normalizeLlmProvider(options?.llmProvider || options?.provider || 'auto');

  // Stage 1: Get Gemini's semantic understanding
  let analysis = analysisResult;
  if (!analysis) {
    try {
      analysis = await analyzeQuick(text, '', { llmProvider: requestedProvider });
    } catch {
      analysis = null;
    }
  }

  const geminiMinistry = analysis?.related_ministry || '';
  const geminiMinistries = analysis?.related_ministries || [];
  const rtiTarget = analysis?.rti_target_office || '';

  // Collect all candidate names from Gemini
  const candidates = [rtiTarget, geminiMinistry, ...geminiMinistries].filter(Boolean);

  if (candidates.length === 0) {
    // No Gemini data — fall back to keyword matching
    return { primary: '', offices: [], source: 'none' };
  }

  // Stage 2: Fuzzy match candidates against contacts database
  const contactFields = contacts.map(c => ({
    office_name: c.office_name || '',
    ministry: c.ministry || c.Ministry || '',
    department: c.department || c.Department || '',
  }));

  const fuzzyMatch = (candidate, fieldValue) => {
    if (!candidate || !fieldValue) return 0;
    const a = candidate.toLowerCase().trim();
    const b = fieldValue.toLowerCase().trim();
    if (a === b) return 1.0;
    if (b.includes(a) || a.includes(b)) return 0.85;
    // Token overlap score
    const tokensA = new Set(a.split(/[\s,\-–—()]+/).filter(t => t.length > 2));
    const tokensB = new Set(b.split(/[\s,\-–—()]+/).filter(t => t.length > 2));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;
    let overlap = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) overlap++;
    }
    return overlap / Math.max(tokensA.size, tokensB.size);
  };

  const matchedOffices = new Map(); // office_name → best score

  for (const candidate of candidates) {
    for (const cf of contactFields) {
      const scores = [
        fuzzyMatch(candidate, cf.office_name),
        fuzzyMatch(candidate, cf.ministry),
        fuzzyMatch(candidate, cf.department),
      ];
      const bestScore = Math.max(...scores);
      if (bestScore > 0.3) {
        const key = cf.office_name || cf.ministry || cf.department;
        const prev = matchedOffices.get(key) || 0;
        if (bestScore > prev) matchedOffices.set(key, bestScore);
      }
    }
  }

  const sortedMatches = Array.from(matchedOffices.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name]) => name);

  if (sortedMatches.length > 0) {
    return {
      primary: sortedMatches[0],
      offices: sortedMatches,
      source: 'gemini-fuzzy',
      reasoning: analysis?.ministry_reasoning || '',
      rtiTarget: rtiTarget,
    };
  }

  // Stage 3: Full LLM-assisted matching against DB
  try {
    const officeNames = [...new Set(contacts.map(c => c.office_name).filter(Boolean))];
    const llmMatches = await matchOfficesToNews(text, officeNames, analysis, { llmProvider: requestedProvider });
    if (llmMatches.length > 0) {
      return {
        primary: llmMatches[0],
        offices: llmMatches,
        source: 'gemini-db-match',
        reasoning: analysis?.ministry_reasoning || '',
        rtiTarget: rtiTarget,
      };
    }
  } catch {
    // fallback
  }

  return {
    primary: geminiMinistry,
    offices: geminiMinistries,
    source: 'gemini-direct',
    reasoning: analysis?.ministry_reasoning || '',
    rtiTarget: rtiTarget,
  };
}

/**
 * Web search for RTI office information
 * @param {string} query - Search query (e.g., "Bangladesh Election Commission RTI Information officers Bangladesh")
 * @returns {Promise<Object|null>} - Office record with Website_Link, or null
 */
async function searchWebForOffice(query, options = {}) {
  const requestedProvider = normalizeLlmProvider(options?.llmProvider || options?.provider || 'auto');

  try {
    const prompt = `${JAANI_LLM_CONTEXT}

  You are a web search assistant for Bangladesh government offices.

User query: "${query}"

Task: Provide the most likely official website URL for this Bangladesh government office/ministry/department.

Rules:
1. ONLY return URLs from .gov.bd domains (official Bangladesh government sites)
2. If the organization name is in English, provide the Bangla equivalent
3. Return a JSON object with this structure:
{
  "office_name": "Official Bangla name of the office",
  "office_name_en": "English name (if available)",
  "Website_Link": "https://example.gov.bd",
  "confidence": "high|medium|low"
}

4. If you cannot find a valid .gov.bd URL, return: {"error": "not_found"}

Response (JSON only):`;

    const llmResult = await runPromptWithProvider(prompt, {
      llmProvider: requestedProvider,
      operation: 'searchWebForOffice',
    });

    const parsed = safeJsonParse(llmResult.text);
    
    if (parsed?.error === 'not_found' || !parsed?.Website_Link) {
      console.log(`❌ Web search: No valid result for "${query}"`);
      return null;
    }

    // Validate .gov.bd domain
    if (!parsed.Website_Link.includes('.gov.bd')) {
      console.warn(`⚠️  Non-gov.bd URL suggested: ${parsed.Website_Link}`);
      return null;
    }

    console.log(`✅ Web search found: ${parsed.office_name} @ ${parsed.Website_Link}`);
    return {
      office_name: parsed.office_name || query,
      Office_Name: parsed.office_name_en || parsed.office_name || query,
      Website_Link: parsed.Website_Link,
      Ministry: parsed.office_name || query,
      _source: 'gemini_web_search',
      confidence: parsed.confidence || 'unknown',
      _llm_provider_requested: requestedProvider,
      _llm_provider_used: llmResult.providerUsed || '',
      reasoning_details: llmResult.reasoningDetails || null,
    };

  } catch (err) {
    console.error('❌ searchWebForOffice failed:', err.message);
    return null;
  }
}

/**
 * Map officer names to the most relevant image URLs from candidate list.
 * Uses Gemini as a semantic matcher when deterministic DOM heuristics are uncertain.
 */
async function mapOfficerImagesFromCandidates({
  pageUrl = '',
  primaryName = '',
  alternateName = '',
  appellateName = '',
  candidates = [],
} = {}, options = {}) {
  const requestedProvider = normalizeLlmProvider(options?.llmProvider || options?.provider || 'auto');

  const safeCandidates = Array.isArray(candidates)
    ? candidates
        .map((c, idx) => ({
          index: idx,
          url: (c?.url || '').toString().trim(),
          context: (c?.context || '').toString().replace(/\s+/g, ' ').trim().slice(0, 220),
        }))
        .filter((c) => /^https?:\/\//i.test(c.url))
        .slice(0, 24)
    : [];

  if (safeCandidates.length === 0) return {};

  try {
    const prompt = `${JAANI_LLM_CONTEXT}

  You are matching Bangladesh RTI officer names to the correct profile image URLs.

Page URL: ${pageUrl || 'unknown'}

Officer names:
- Primary: ${primaryName || 'N/A'}
- Alternate: ${alternateName || 'N/A'}
- Appellate: ${appellateName || 'N/A'}

Image candidates (index, url, surrounding text):
${safeCandidates.map((c) => `- [${c.index}] ${c.url} | ${c.context}`).join('\n')}

Rules:
1) Pick ONLY from provided candidate URLs.
2) Prefer exact or strong textual match with officer name/designation context.
3) If uncertain for a role, return empty string for that role.
4) Return ONLY JSON in this exact format:
{
  "primaryPhoto": "",
  "alternatePhoto": "",
  "appellatePhoto": ""
}`;

    const llmResult = await runPromptWithProvider(prompt, {
      llmProvider: requestedProvider,
      operation: 'mapOfficerImagesFromCandidates',
    });

    const parsed = safeJsonParse(llmResult.text) || {};
    const allowed = new Set(safeCandidates.map((c) => c.url));

    const primaryPhoto = allowed.has(parsed.primaryPhoto) ? parsed.primaryPhoto : '';
    const alternatePhoto = allowed.has(parsed.alternatePhoto) ? parsed.alternatePhoto : '';
    const appellatePhoto = allowed.has(parsed.appellatePhoto) ? parsed.appellatePhoto : '';

    return {
      primaryPhoto,
      alternatePhoto,
      appellatePhoto,
      _llm_provider_requested: requestedProvider,
      _llm_provider_used: llmResult.providerUsed || '',
      reasoning_details: llmResult.reasoningDetails || null,
    };
  } catch (err) {
    console.warn('⚠️ mapOfficerImagesFromCandidates failed:', err.message);
    return {};
  }
}

// ─── analyzeDeep – Dual-LLM parallel deep analysis ─────────────────────────────
// Runs two LLM prompts in parallel (Gemini primary + any secondary) and merges
// results.  All new fields for the 6-tab NewsIntelligencePanel are extracted here.

async function analyzeDeep(text, url = '', existingQuick = null, options = {}) {
  const requestedProvider = normalizeLlmProvider(options?.llmProvider || options?.provider || 'auto');
  const truncated         = truncateToWords(text, 3000);
  const legalTruncated    = truncateToWords(text, 4000);

  // ── Prompt A: Core intelligence (quotes, claims, gaps, propaganda, narrative, policy) ──
  const promptA = `${JAANI_LLM_CONTEXT}

You are a senior investigative journalist and RTI expert for Bangladesh.
Perform deep intelligence analysis on this news article.

=== NEWS TEXT ===
${truncated}
=== END ===

Return ONLY a JSON object with these exact fields:

{
  "tldr": "One-sentence TL;DR in same language as article",
  "sentiment": {
    "positive": 0.2, "neutral": 0.5, "negative": 0.3,
    "dominant": "negative", "confidence": 0.82
  },
  "quotes": [
    {"quote": "exact quoted text", "speaker_name": "Name", "speaker_title": "Title", "quote_sentiment": "positive|neutral|negative", "is_on_record": true}
  ],
  "claims": [
    {"claim": "claim text", "speaker": "who made it", "claim_type": "factual|opinion|allegation|denial", "verifiable": true, "confidence": 0.75}
  ],
  "informationGaps": {
    "gaps": ["Missing information 1", "Missing information 2"],
    "overall_completeness_score": 65
  },
  "propagandaAnalysis": {
    "techniques_found": ["technique1", "technique2"],
    "overall_manipulation_risk": "low|medium|high",
    "neutrality_score": 70
  },
  "narrativeArc": {
    "arc_type": "scandal|reform|conflict|investigation|policy|human_interest",
    "protagonist": "Main subject of the article",
    "antagonist": "Opposing force if any",
    "story_stage": "emerging|developing|peak|resolution|follow_up",
    "unresolved_threads": ["thread1"],
    "follow_up_probability": 0.75
  },
  "contradictions": {
    "internal_contradictions": ["contradiction if any"],
    "factual_contradictions": [],
    "contradiction_count": 0
  },
  "keyTakeaways": ["takeaway 1", "takeaway 2", "takeaway 3"]
}

Return valid JSON only. No markdown. Empty arrays/nulls for fields with no data.`;

  // ── Prompt B: Policy & RTI (separate for focus) ──
  const promptB = `${JAANI_LLM_CONTEXT}

You are a Bangladesh RTI legal expert.
Analyze this news for RTI/legal/policy relevance.

=== NEWS TEXT ===
${legalTruncated}
=== END ===

Return ONLY a JSON object:

{
  "policyMap": {
    "relevant_laws": [{"name": "Law name", "section": "section if mentioned", "relevance": "why"}],
    "relevant_policies": [{"name": "Policy name", "relevance": "why"}]
  },
  "suggestedRtiQuestions": [
    "Specific RTI question 1 a citizen can ask",
    "Specific RTI question 2",
    "Specific RTI question 3",
    "Specific RTI question 4"
  ],
  "legalImplications": ["implication 1", "implication 2"],
  "accountabilityNotes": "Brief accountability analysis 1-2 sentences"
}

Return valid JSON only.`;

  // ── Run both prompts concurrently across available providers ──
  const [resultA, resultB] = await Promise.allSettled([
    runPromptWithProvider(promptA, { llmProvider: requestedProvider, operation: 'analyzeDeep_A', maxTokens: 1800 }),
    runPromptWithProvider(promptB, { llmProvider: requestedProvider, operation: 'analyzeDeep_B', maxTokens: 800 }),
  ]);

  const parsedA = resultA.status === 'fulfilled' ? safeJsonParse(resultA.value.text) : null;
  const parsedB = resultB.status === 'fulfilled' ? safeJsonParse(resultB.value.text) : null;

  const providerUsedA = resultA.status === 'fulfilled' ? (resultA.value.providerUsed || 'unknown') : 'failed';
  const providerUsedB = resultB.status === 'fulfilled' ? (resultB.value.providerUsed || 'unknown') : 'failed';

  // ── Merge + normalise ──
  const failed_features = [];
  if (!parsedA) failed_features.push('core_intelligence');
  if (!parsedB) failed_features.push('policy_rti');

  // Sentiment normalisation
  let sentiment = parsedA?.sentiment || { positive: 0.33, neutral: 0.34, negative: 0.33, dominant: 'neutral', confidence: 0.5 };
  const sTotal = (sentiment.positive || 0) + (sentiment.neutral || 0) + (sentiment.negative || 0);
  if (sTotal > 0 && Math.abs(sTotal - 1.0) > 0.05) {
    sentiment = {
      positive:   (sentiment.positive  || 0) / sTotal,
      neutral:    (sentiment.neutral   || 0) / sTotal,
      negative:   (sentiment.negative  || 0) / sTotal,
      dominant:   sentiment.dominant   || 'neutral',
      confidence: sentiment.confidence || 0.5,
    };
  }

  const normaliseArr = (v, max = 8, minL = 4) => normalizeTextList(Array.isArray(v) ? v : [], { maxItems: max, minLen: minL });

  return {
    // From prompt A
    tldr:                parsedA?.tldr                || existingQuick?.summary?.slice(0, 120) || '',
    sentiment,
    quotes:              Array.isArray(parsedA?.quotes)      ? parsedA.quotes.slice(0, 10)      : [],
    claims:              Array.isArray(parsedA?.claims)      ? parsedA.claims.slice(0, 10)      : [],
    informationGaps:     parsedA?.informationGaps            || { gaps: [], overall_completeness_score: 50 },
    propagandaAnalysis:  parsedA?.propagandaAnalysis         || { techniques_found: [], overall_manipulation_risk: 'low', neutrality_score: 70 },
    narrativeArc:        parsedA?.narrativeArc               || null,
    contradictions:      parsedA?.contradictions             || { internal_contradictions: [], factual_contradictions: [], contradiction_count: 0 },
    keyTakeaways:        normaliseArr(parsedA?.keyTakeaways, 6, 8),

    // From prompt B
    policyMap:             parsedB?.policyMap             || { relevant_laws: [], relevant_policies: [] },
    suggestedRtiQuestions: normaliseArr(parsedB?.suggestedRtiQuestions, 6, 12),
    legalImplications:     normaliseArr(parsedB?.legalImplications,     5, 5),
    accountabilityNotes:   parsedB?.accountabilityNotes  || '',

    // Provenance
    failed_features,
    providers_used: { prompt_a: providerUsedA, prompt_b: providerUsedB },
    llm_provider_requested: requestedProvider,
  };
}

module.exports = {
  SUPPORTED_LLM_PROVIDERS,
  normalizeLlmProvider,
  getProviderStatusReport,
  getLiveProviderStatusReport,
  analyzeQuick,
  analyzeDeep,
  extractEarlyRtiOffice,
  generateFullSummary,
  matchOfficesToNews,
  semanticMinistryMatch,
  extractContactFromText,
  searchWebForOffice,
  mapOfficerImagesFromCandidates,
  callGeminiPrompt,
  callOpenAiCompatiblePrompt,
  buildBengaliGovernmentEntityPrompt,
  isProviderConfigured,
  runPromptWithProvider,
  safeJsonParse,
  extractBengaliGovernmentEntities,
};
