/**
 * RTI Act 2009 guidance for Section 2's RTI officer card ("RTI Actionability").
 *
 * Deterministic wherever the Act or the dataset answers the question: routing (gazetteer + CSV),
 * deadlines (s.9), the Schedule bodies (s.32), the fee note (s.9(6)–(7)), the multi-unit note
 * (s.9(2)), the proactive-disclosure gap (s.6(3)(d)), the urgency pre-screen (s.9(4)) and money
 * mentions (analyticsEngine). An LLM is used only for judgment/wording: whether a request would
 * plausibly touch a s.7 exemption, confirming an ambiguous urgency case, and drafting questions.
 * Every note carries the section it rests on.
 */

const rtiGazetteer = require('./rtiGazetteer');
const analyticsEngine = require('./analyticsEngine');
const llmTaskRouting = require('../config/llmTaskRouting');

// ── s.9(4): life/death, arrest, release from jail → 24-hour preliminary response ───────────────
const URGENCY_STRONG = ['মৃত্যু', 'নিহত', 'খুন', 'হত্যা', 'মৃতদেহ', 'লাশ', 'গ্রেপ্তার', 'গ্রেফতার', 'আটক', 'কারামুক্তি',
  'জামিন', 'ফাঁসি', 'মৃত্যুদণ্ড', 'গুম', 'অপহরণ', 'নিখোঁজ', 'হেফাজতে', 'রিমান্ড', 'কারাগার', 'কারাবন্দী', 'বন্দী'];
const URGENCY_WEAK = ['আহত', 'মুক্তি', 'হামলা', 'সংঘর্ষ', 'গুলি', 'অসুস্থ', 'হাসপাতালে'];
const URGENCY_EN = /\b(killed|dead|death|murder|arrest(?:ed)?|detain(?:ed)?|bail|custody|remand|abduct(?:ed)?|missing|execution)\b/gi;

function countTerms(text, terms) {
  const t = rtiGazetteer.normalizeText(text);
  const hits = {};
  terms.forEach((term) => {
    const needle = rtiGazetteer.normalizeText(term);
    let i = t.indexOf(needle);
    while (i !== -1) {
      const before = i > 0 ? t[i - 1] : ' ';
      if (!/[ঀ-৿]/.test(before)) hits[term] = (hits[term] || 0) + 1; // word start; suffixes allowed
      i = t.indexOf(needle, i + needle.length);
    }
  });
  return hits;
}

/**
 * Deterministic pre-screen. 'clear_yes' / 'clear_no' need no AI; 'ambiguous' goes to the
 * flagship-tier urgency_confirmation task.
 */
function prescreenUrgency(text = '', title = '') {
  const strongBody = countTerms(text, URGENCY_STRONG);
  const strongTitle = countTerms(title, URGENCY_STRONG);
  const weak = countTerms(text, URGENCY_WEAK);
  const en = (String(text).match(URGENCY_EN) || []).length;
  const strongTotal = Object.values(strongBody).reduce((a, b) => a + b, 0) + en;
  const terms = Array.from(new Set([...Object.keys(strongTitle), ...Object.keys(strongBody)]));
  if (Object.keys(strongTitle).length > 0 || strongTotal >= 3) return { verdict: 'clear_yes', terms };
  if (strongTotal === 0 && Object.keys(weak).length === 0) return { verdict: 'clear_no', terms: [] };
  return { verdict: 'ambiguous', terms: [...terms, ...Object.keys(weak)] };
}

// ── s.32 Schedule bodies (deterministic list) ─────────────────────────────────────────────────
const SECTION32_BODIES = [
  { name: 'জাতীয় নিরাপত্তা গোয়েন্দা সংস্থা (এনএসআই)', aliases: ['জাতীয় নিরাপত্তা গোয়েন্দা সংস্থা', 'এনএসআই', 'National Security Intelligence', 'NSI'] },
  { name: 'প্রতিরক্ষা গোয়েন্দা মহাপরিদপ্তর (ডিজিএফআই)', aliases: ['প্রতিরক্ষা গোয়েন্দা মহাপরিদপ্তর', 'ডিজিএফআই', 'DGFI'] },
  { name: 'প্রতিরক্ষা বাহিনীর গোয়েন্দা ইউনিট', aliases: ['প্রতিরক্ষা বাহিনীর গোয়েন্দা', 'সামরিক গোয়েন্দা', 'Defence Intelligence Unit'] },
  { name: 'অপরাধ তদন্ত বিভাগ (সিআইডি)', aliases: ['অপরাধ তদন্ত বিভাগ', 'সিআইডি', 'CID'] },
  { name: 'স্পেশাল সিকিউরিটি ফোর্স (এসএসএফ)', aliases: ['স্পেশাল সিকিউরিটি ফোর্স', 'এসএসএফ', 'SSF'] },
  { name: 'জাতীয় রাজস্ব বোর্ডের গোয়েন্দা সেল', aliases: ['রাজস্ব বোর্ডের গোয়েন্দা', 'কর গোয়েন্দা', 'শুল্ক গোয়েন্দা', 'NBR Intelligence'] },
  { name: 'স্পেশাল ব্রাঞ্চ (এসবি)', aliases: ['স্পেশাল ব্রাঞ্চ', 'পুলিশের বিশেষ শাখা', 'Special Branch'] },
  { name: 'র‍্যাবের গোয়েন্দা শাখা', aliases: ['র‍্যাবের গোয়েন্দা', 'র্যাবের গোয়েন্দা', 'RAB Intelligence'] },
];

function checkSection32Schedule(text = '') {
  const t = rtiGazetteer.normalizeText(text);
  const matched = SECTION32_BODIES.filter((b) => b.aliases.some((a) => {
    const n = rtiGazetteer.normalizeText(a);
    const i = t.indexOf(n);
    if (i === -1) return false;
    const before = i > 0 ? t[i - 1] : ' ';
    const after = t[i + n.length] || ' ';
    // short Latin acronyms must stand alone
    if (/^[a-z]{2,4}$/.test(n)) return !/[a-z]/.test(before) && !/[a-z]/.test(after);
    return !/[ঀ-৿a-z]/.test(before);
  })).map((b) => b.name);
  if (!matched.length) return null;
  return {
    bodies: matched,
    note: `সংবাদে ${matched.join(', ')}-এর উল্লেখ আছে। এসব সংস্থা আইনের তফসিলভুক্ত, তাই তথ্য অধিকার আইন এদের ক্ষেত্রে প্রযোজ্য নয়; `
      + 'তবে দুর্নীতি ও মানবাধিকার লঙ্ঘন সংক্রান্ত তথ্য তথ্য কমিশনের অনুমোদন সাপেক্ষে ৩০ দিনের মধ্যে দিতে হয় (ধারা ৩২)।',
    section: '32',
  };
}

// ── s.9 deadlines (working days = Sunday–Thursday; no public-holiday calendar yet) ─────────────
// All arithmetic is on the Asia/Dhaka calendar date, held as a UTC-midnight Date.
function dhakaDate(value) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(value)).split('-').map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
}

function addWorkingDays(start, days) {
  const d = new Date(start);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay(); // 5 = Friday, 6 = Saturday
    if (wd !== 5 && wd !== 6) added += 1;
  }
  return d;
}

function addDays(start, days) {
  const d = new Date(start);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

const isoDate = (d) => d.toISOString().slice(0, 10);

function computeDeadline({ sendDate = new Date(), multiUnit = false, urgent = false } = {}) {
  const start = dhakaDate(sendDate);
  const days = multiUnit ? 30 : 20;
  const replyBy = addWorkingDays(start, days);
  const refusalBy = addWorkingDays(start, 10);
  // If silent by the reply date, the request is deemed refused (s.9); appeal within 30 days (s.24).
  const appealBy = addDays(replyBy, 30);
  return {
    sendDate: isoDate(start),
    workingDays: days,
    workingDaysSection: multiUnit ? '9(2)' : '9(1)',
    replyBy: isoDate(replyBy),
    refusalReasonsBy: isoDate(refusalBy),
    urgent24h: Boolean(urgent),
    appealBy: isoDate(appealBy),
    appealDecisionDays: 15,
    complaintDays: 30,
    holidayCaveat: 'শুধু শুক্র ও শনিবার বাদ দিয়ে গণনা করা হয়েছে; সরকারি ছুটির দিন হিসাবে ধরা হয়নি, তাই প্রকৃত সময়সীমা কিছুটা পরে হতে পারে।',
  };
}

// ── Money mentions (revived analyticsEngine; phrases only — no computed totals) ────────────────
// A match counts as money only if it carries a currency word, or one follows the number phrase
// (analyticsEngine also matches counts like "৭ হাজার ৭০১টি ইয়াবা").
const CURRENCY_RE = /(টাকা|৳|ডলার|ইউরো|পাউন্ড|রুপি|\btk\b|taka|usd|\$|€|£)/i;
const CURRENCY_AFTER_RE = /^[\s০-৯0-9,.]*(?:(?:হাজার|লাখ|লক্ষ|কোটি|million|billion|crore|lakh)[\s০-৯0-9,.]*)*(টাকা|৳|ডলার|ইউরো|পাউন্ড|রুপি|tk|taka|usd)/i;

function moneyMentions(text = '') {
  const found = (analyticsEngine.extractMoneyMentions(text) || []).map((m) => {
    if (CURRENCY_RE.test(m.amount)) return m;
    const ctx = String(m.label || '');
    const at = ctx.indexOf(m.amount);
    const tail = at === -1 ? null : ctx.slice(at + m.amount.length).match(CURRENCY_AFTER_RE);
    // Show the whole phrase ("৬ হাজার" + " ৬১০ টাকা").
    return tail ? { ...m, amount: `${m.amount}${tail[0]}`.replace(/\s+/g, ' ').trim() } : null;
  }).filter(Boolean);
  const amounts = found.map((m) => m.amount);
  return found
    .filter((m) => !amounts.some((other) => other !== m.amount && other.includes(m.amount)))
    .slice(0, 6)
    .map((m) => ({ amount: m.amount, context: m.label }));
}

// ── LLM-backed pieces (task-routed; never block the deterministic result) ──────────────────────
const SECTION7_CATEGORIES = [
  'বাংলাদেশের নিরাপত্তা, অখণ্ডতা ও সার্বভৌমত্বের প্রতি হুমকি',
  'বিদেশি রাষ্ট্র বা আন্তর্জাতিক সংস্থার সঙ্গে সম্পর্ক বা গোপনে প্রাপ্ত তথ্য',
  'তৃতীয় পক্ষের বাণিজ্যিক গোপনীয়তা বা বুদ্ধিবৃত্তিক সম্পদ',
  'আয়কর, শুল্ক, ভ্যাট, বাজেট বা মুদ্রা বিনিময় হার বিষয়ক আগাম তথ্য যা অর্থনীতির ক্ষতি করতে পারে',
  'আইন প্রয়োগে বাধা বা অপরাধ বৃদ্ধি',
  'জননিরাপত্তা বা ন্যায়বিচারে বিঘ্ন',
  'ব্যক্তির ব্যক্তিগত জীবনের গোপনীয়তা',
  'কারো জীবন বা শারীরিক নিরাপত্তার ঝুঁকি',
  'আইন প্রয়োগকারী সংস্থাকে গোপনে দেওয়া তথ্য',
  'আদালতে বিচারাধীন বিষয় যা প্রকাশে আদালতের নিষেধ আছে',
  'তদন্তাধীন বিষয় যা প্রকাশে তদন্তে বিঘ্ন ঘটতে পারে',
  'অপরাধের তদন্ত, গ্রেপ্তার বা বিচার প্রক্রিয়ায় প্রভাব',
  'পরীক্ষার প্রশ্ন বা ফলাফল প্রকাশের আগে',
  'মন্ত্রিসভা বা উপদেষ্টা পরিষদের সিদ্ধান্তের আগে তার নথি ও আলোচনা',
  'চলমান আলোচনা বা চুক্তির তথ্য যা প্রকাশে ক্ষতি হতে পারে',
  'সংসদের বিশেষ অধিকার ক্ষুণ্ণ করতে পারে এমন তথ্য',
  'ক্রয় প্রক্রিয়া চূড়ান্ত হওয়ার আগের তথ্য',
];

function parseJson(text) {
  const raw = String(text || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
  return null;
}

async function llmJson(run, prompt, task, llmProvider, maxTokens, validate) {
  try {
    const out = await run(prompt, {
      llmProvider, operation: task, task, maxTokens, timeoutMs: 20000,
      validate: validate ? (text) => { const j = parseJson(text); return Boolean(j && validate(j)); } : undefined,
    });
    return { parsed: parseJson(out.text), provider: out.providerUsed, model: out.modelUsed };
  } catch (e) {
    return { parsed: null, error: e.message };
  }
}

async function confirmUrgency(run, { text, terms, llmProvider }) {
  const prompt = `Bangladesh Right to Information Act 2009, section 9(4): if requested information concerns the life and death, arrest, or release from jail of a person, a preliminary response is due within 24 hours.

Decide whether an RTI request about the news below would plausibly concern a specific person's life/death, arrest or release from jail. Terms that triggered this check: ${terms.join(', ')}.
Ignore mentions that are not about the news subject (e.g. a quote about an unrelated past event).

Return ONLY JSON: {"applies": true|false, "reason_bn": "এক বাক্যে কারণ"}

NEWS:
${String(text).slice(0, 3000)}`;
  const r = await llmJson(run, prompt, 'urgency_confirmation', llmProvider, 200, (j) => typeof j.applies === 'boolean');
  if (!r.parsed || typeof r.parsed.applies !== 'boolean') return { applies: null, method: 'llm_failed', error: r.error };
  return { applies: r.parsed.applies, reason: String(r.parsed.reason_bn || '').slice(0, 300), method: 'llm', provider: r.provider, model: r.model };
}

async function checkSection7Exemption(run, { text, authority, llmProvider }) {
  const prompt = `You advise a citizen filing an RTI request in Bangladesh (Right to Information Act 2009) about the news below, to ${authority || 'the relevant authority'}.
Section 7 lists information an authority is not obliged to disclose. Categories:
${SECTION7_CATEGORIES.map((c, i) => `${i + 1}. ${c}`).join('\n')}
Also: an authority must still give the non-exempt part of a request (partial disclosure).

Judge only from the news text. Would a straightforward records request about this story plausibly touch any of these categories? Most civic requests (spending, procurement outcomes, statistics, decisions already taken) do not.

Return ONLY JSON: {"flags":[{"category":<number from the list>,"why_bn":"এক বাক্য"}]} — at most 2 flags, empty array if none is plausible.
"why_bn" must name the specific kind of information a requester would likely ask for in this story (e.g. "গ্রেপ্তার ব্যক্তিদের নাম-ঠিকানা") and why that part may be withheld — never just restate the category.

NEWS:
${String(text).slice(0, 3000)}`;
  const r = await llmJson(run, prompt, 'section7_exemption_judgment', llmProvider, 350, (j) => Array.isArray(j.flags));
  if (!r.parsed || !Array.isArray(r.parsed.flags)) return { flags: [], method: 'llm_failed', error: r.error };
  const flags = r.parsed.flags
    .map((f) => ({ category: SECTION7_CATEGORIES[Number(f.category) - 1], why: String(f.why_bn || '').slice(0, 300) }))
    .filter((f) => f.category)
    .slice(0, 2);
  // The judgment is pinned to OpenAI's flagship; if a fallback provider answered, say so.
  const preferred = llmTaskRouting.resolveTaskModel('section7_exemption_judgment', 'openai').model;
  const degraded = r.provider !== 'openai' || !String(r.model || '').startsWith(preferred);
  return { flags, method: 'llm', provider: r.provider, model: r.model, degraded };
}

async function generateSuggestedQuestions(run, { text, authority, llmProvider }) {
  const prompt = `Draft 2 questions for item ২ ("কী ধরনের তথ্য চাওয়া হচ্ছে") of Bangladesh's RTI request Form "ক", addressed to ${authority || 'the relevant authority'}, about the news below.

Rules:
- Each asks for existing records: copies of documents, lists, dates, amounts, names/designations of responsible officials, decisions taken.
- Specific to facts in the news (dates, places, numbers, programmes); no opinions, no "why" questions.
- Bengali, formal, one sentence each, ending like "…এর অনুলিপি/তালিকা/তথ্য চাই।"
- Do not invent facts not in the news.

Return ONLY JSON: {"questions":["...","..."]}

NEWS:
${String(text).slice(0, 3000)}`;
  const r = await llmJson(run, prompt, 'suggested_rti_questions', llmProvider, 400,
    (j) => Array.isArray(j.questions) && j.questions.some((q) => String(q).trim().length > 15));
  const qs = Array.isArray(r.parsed?.questions) ? r.parsed.questions.map((q) => String(q).trim()).filter((q) => q.length > 15).slice(0, 2) : [];
  return { questions: qs, method: qs.length ? 'llm' : 'llm_failed', provider: r.provider, model: r.model, error: r.error };
}

/**
 * Full guidance for one article. `run` is geminiAnalysis.runPromptWithProvider (injected to keep
 * this module free of provider plumbing).
 */
async function buildRtiGuidance({ text = '', title = '', llmProvider = 'auto', run, sendDate = new Date() } = {}) {
  const { matches } = rtiGazetteer.matchGovernmentBodies(text);
  const top = matches[0] || null;
  const row = top ? rtiGazetteer.pickRowForBody(top) : null;
  const authority = row ? (row.office || row.division || row.ministry) : '';
  const distinctRows = new Set(matches.slice(0, 5).map((m) => {
    const r = rtiGazetteer.pickRowForBody(m);
    return r ? `${r.ministry}|${r.division}|${r.office}` : m.canonical;
  }));
  const multiUnit = distinctRows.size > 1;

  // Routing (deterministic)
  let routing = null;
  if (top && row) {
    const escalated = top.method === 'agency_parent';
    routing = {
      authority,
      ministry: row.ministry,
      designatedOfficer: row.primaryOfficer ? { name: row.primaryOfficer, designation: row.primaryDesignation } : null,
      appellateAuthority: row.appellateOfficer ? { name: row.appellateOfficer, designation: row.appellateDesignation } : null,
      escalated,
      note: escalated
        ? `সংবাদে উল্লেখিত ${top.agencies.join(', ')}-এর নিজস্ব তথ্য প্রদানকারী কর্মকর্তা ডেটাসেটে নেই, তাই আবেদন যেতে পারে এর ঊর্ধ্বতন কর্তৃপক্ষ ${authority}-এর তথ্য প্রদানকারী কর্মকর্তার কাছে (ধারা ১০)।`
        : `আবেদন যাবে ${authority}-এর তথ্য প্রদানকারী কর্মকর্তার কাছে (ধারা ১০)।`,
      section: '10',
    };
  }

  // Deterministic notes
  const notes = [];
  if (routing && !routing.designatedOfficer) {
    notes.push({
      section: '6(3)(d)',
      text: 'এই কর্তৃপক্ষের কোনো নির্ধারিত তথ্য কর্মকর্তা খুঁজে পাওয়া যায়নি — এটি ধারা ৬(৩)(ঘ) অনুযায়ী তাদের নিজস্ব প্রকাশনা-বাধ্যবাধকতার লঙ্ঘন হতে পারে।',
    });
  }
  if (routing) {
    notes.push({
      section: '9(6)-(7)',
      text: 'তথ্য সরবরাহের জন্য প্রকৃত ফটোকপি/প্রিন্ট খরচের সমপরিমাণ একটি যুক্তিসঙ্গত ফি চাওয়া হতে পারে, যা কর্মকর্তা জানানোর ৫ কার্যদিবসের মধ্যে পরিশোধযোগ্য (ধারা ৯(৬)-(৭))।',
    });
  }
  if (multiUnit) {
    const names = matches.slice(0, 4).map((m) => m.canonical);
    notes.push({
      section: '9(2)',
      text: `সংবাদে একাধিক কর্তৃপক্ষ আছে (${names.join(', ')})। দুটি পথ: ঊর্ধ্বতন সাধারণ কর্তৃপক্ষের কাছে একটি সম্মিলিত আবেদন — একাধিক ইউনিট জড়িত থাকলে উত্তর ৩০ কার্যদিবসের মধ্যে (ধারা ৯(২)); অথবা প্রতিটি দপ্তরে আলাদা আবেদন — প্রতিটির উত্তর ২০ কার্যদিবসে, তবে বেশি আবেদন অনুসরণ করতে হবে।`,
    });
  }

  const section32 = checkSection32Schedule(text);

  // Urgency: deterministic first, flagship LLM only when ambiguous
  const pre = prescreenUrgency(text, title);
  let urgency;
  if (pre.verdict === 'clear_yes') urgency = { applies: true, method: 'deterministic', terms: pre.terms };
  else if (pre.verdict === 'clear_no') urgency = { applies: false, method: 'deterministic', terms: [] };

  // LLM calls in parallel (each fails soft)
  const [urgencyLlm, section7, questions] = await Promise.all([
    urgency || !run ? Promise.resolve(null) : confirmUrgency(run, { text, terms: pre.terms, llmProvider }),
    run && routing ? checkSection7Exemption(run, { text, authority, llmProvider }) : Promise.resolve({ flags: [], method: 'skipped' }),
    run && routing ? generateSuggestedQuestions(run, { text, authority, llmProvider }) : Promise.resolve({ questions: [], method: 'skipped' }),
  ]);
  if (!urgency) urgency = urgencyLlm ? { ...urgencyLlm, terms: pre.terms } : { applies: null, method: 'unavailable', terms: pre.terms };
  if (urgency.applies) {
    urgency.note = 'অনুরোধটি যদি কোনো ব্যক্তির জীবন-মৃত্যু, গ্রেপ্তার বা কারাগার থেকে মুক্তি সম্পর্কিত হয়, তবে প্রাথমিক তথ্য ২৪ ঘণ্টার মধ্যে দিতে হবে (ধারা ৯(৪))।';
    urgency.section = '9(4)';
  }

  const deadlines = routing ? computeDeadline({ sendDate, multiUnit, urgent: Boolean(urgency.applies) }) : null;

  return {
    authority,
    routing,
    deadlines,
    urgency,
    section32,
    section7: section7 && section7.flags && section7.flags.length ? {
      ...section7,
      note: 'কিছু অংশ ধারা ৭-এর অব্যাহতির আওতায় পড়তে পারে; তবে পুরো আবেদন প্রত্যাখ্যান করা যায় না — অব্যাহতিবহির্ভূত অংশ দিতে হবে।',
      section: '7',
    } : { flags: [], method: section7?.method || 'skipped' },
    notes,
    suggestedQuestions: questions.questions || [],
    questionsMeta: { method: questions.method, provider: questions.provider, model: questions.model },
    money: moneyMentions(text),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  buildRtiGuidance,
  prescreenUrgency,
  checkSection32Schedule,
  computeDeadline,
  moneyMentions,
  SECTION7_CATEGORIES,
  _checkSection7ForTest: checkSection7Exemption,
};
