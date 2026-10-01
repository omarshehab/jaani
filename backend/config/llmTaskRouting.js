/**
 * Task → model routing for the hosted LLMs (OpenAI, Grok, Kimi).
 *
 * No function picks a model by name. Each task has a tier; each (tier, provider) pair resolves to a
 * model from the environment, so the choice can follow measured quality/cost (see
 * backend/scripts/evalTaskRouting.js) without code changes:
 *
 *   TASK_<TASK_NAME>_<PROVIDER>_MODEL   per-task override (e.g. TASK_SECTION7_EXEMPTION_JUDGMENT_OPENAI_MODEL)
 *   TASK_<TIER>_<PROVIDER>_MODEL        tier default     (e.g. TASK_FLAGSHIP_GROK_MODEL)
 *   <PROVIDER>_MODEL                    provider default (OPENAI_MODEL, GROK_MODEL, KIMI_MODEL, …)
 *
 * The provider order itself stays with LLM_AUTO_ORDER / the user's provider choice.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const TASK_TIERS = {
  // cheap: high-volume, structured-JSON, well-scoped
  entity_consensus: 'cheap',
  person_designation_extraction: 'cheap',
  summary_and_highlights: 'cheap',
  suggested_rti_questions: 'cheap',
  fact_check_query_formulation: 'cheap',
  // flagship: genuine judgment calls, called rarely
  section7_exemption_judgment: 'flagship',
  urgency_confirmation: 'flagship',
  fact_check_match_judgment: 'flagship',
};

// Tasks whose provider order is fixed regardless of the user's provider choice or LLM_AUTO_ORDER,
// because answer quality directly shapes legal guidance. Section 7 exemption judgment goes to
// OpenAI's flagship (gpt-6-astra per the 2026-09-28 pilot) first; Grok's slot is a non-reasoning
// stopgap (grok-4.7 timed out), so it is a fallback only. Override: TASK_<NAME>_PROVIDER_ORDER.
const TASK_PROVIDER_ORDER = {
  section7_exemption_judgment: ['openai', 'grok', 'kimi'],
};

// Provider defaults used only when neither a task nor a tier model is configured. Kept here, in one
// place, rather than inline in the functions that call the providers.
const PROVIDER_DEFAULT_MODELS = {
  openai: { env: 'OPENAI_MODEL', fallback: 'gpt-4o-mini' },
  grok: { env: 'GROK_MODEL', fallback: 'grok-4.20-non-reasoning' },
  kimi: { env: 'KIMI_MODEL', fallback: 'kimi-k3' },
  cerebras: { env: 'CEREBRAS_MODEL', fallback: 'qwen-3.8-27b' },
  gemini: { env: 'GEMINI_MODEL', fallback: 'gemini-2.5-flash' },
};

const envValue = (name) => (process.env[name] || '').toString().trim();

function pinnedProviderOrder(task) {
  const env = envValue(`TASK_${String(task || '').toUpperCase()}_PROVIDER_ORDER`);
  if (env) return env.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  return TASK_PROVIDER_ORDER[task] || null;
}

function providerDefaultModel(provider) {
  const cfg = PROVIDER_DEFAULT_MODELS[(provider || '').toLowerCase()];
  if (!cfg) return '';
  return envValue(cfg.env) || cfg.fallback;
}

function tierForTask(task) {
  return TASK_TIERS[task] || 'cheap';
}

/**
 * Model for a task on a provider, and where the choice came from (for logs and reports).
 * @returns {{ model: string, tier: string, source: string }}
 */
function resolveTaskModel(task, provider) {
  const p = (provider || '').toUpperCase();
  const tier = tierForTask(task);
  const taskVar = `TASK_${String(task || '').toUpperCase()}_${p}_MODEL`;
  const tierVar = `TASK_${tier.toUpperCase()}_${p}_MODEL`;
  if (task && envValue(taskVar)) return { model: envValue(taskVar), tier, source: taskVar };
  if (envValue(tierVar)) return { model: envValue(tierVar), tier, source: tierVar };
  return { model: providerDefaultModel(provider), tier, source: PROVIDER_DEFAULT_MODELS[(provider || '').toLowerCase()]?.env || 'default' };
}

module.exports = {
  TASK_TIERS,
  TASK_PROVIDER_ORDER,
  pinnedProviderOrder,
  PROVIDER_DEFAULT_MODELS,
  providerDefaultModel,
  tierForTask,
  resolveTaskModel,
};
