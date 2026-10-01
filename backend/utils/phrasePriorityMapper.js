/**
 * Phrase Priority Mapper (Upgrade v2)
 *
 * Purpose:
 * - Deterministically prioritize explicit ministry/department phrases over generic keywords.
 * - Example: Prefer "স্বরাষ্ট্র মন্ত্রণালয়" → Ministry of Home Affairs, even if text contains "থানা"/"অপরাধ".
 * - Now covers all major Bangladesh ministries, divisions, and contextual org phrases.
 *
 * Notes:
 * - This is intentionally lightweight (regex + substring) for speed.
 * - It is used as a pre-check before Gemini/keyword-based mapping.
 * - Returns ALL matching offices (not just the first) for multi-ministry articles.
 */

function normalizeText(input) {
  return (input || '')
    .toString()
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Canonical office names (as typically stored in the contacts DB) mapped to high-priority phrases.
// Covers all major Bangladesh ministries/divisions + contextual phrases.
const PHRASE_RULES = [
  {
    officeNames: ['Ministry of Home Affairs', 'Home Ministry'],
    phrases: [
      'স্বরাষ্ট্র মন্ত্রণালয়', 'স্বরাষ্ট্র মন্ত্রনালয়',
      'ministry of home affairs', 'home affairs ministry', 'home ministry',
      'পুলিশ সদর দপ্তর', 'র‍্যাব', 'র‌্যাপিড অ্যাকশন', 'বর্ডার গার্ড',
      'বিজিবি', 'আনসার', 'ফায়ার সার্ভিস', 'জেলা প্রশাসক',
      'ডিসি অফিস', 'উপজেলা নির্বাহী অফিসার',
    ],
  },
  {
    officeNames: ['Ministry of Road Transport and Bridges', 'Road Transport and Bridges Division'],
    phrases: [
      'সড়ক পরিবহন ও সেতু মন্ত্রণালয়', 'সড়ক পরিবহন',
      'road transport and bridges', 'brta', 'বিআরটিএ',
      'সড়ক ও জনপথ', 'পদ্মা সেতু', 'বাংলাদেশ সেতু কর্তৃপক্ষ',
    ],
  },
  {
    officeNames: ['Ministry of Health and Family Welfare'],
    phrases: [
      'স্বাস্থ্য ও পরিবার কল্যাণ মন্ত্রণালয়', 'স্বাস্থ্য মন্ত্রণালয়',
      'ministry of health and family welfare', 'health ministry',
      'ডিজিএইচএস', 'স্বাস্থ্য অধিদপ্তর', 'dghs',
    ],
  },
  {
    officeNames: ['Ministry of Education'],
    phrases: [
      'শিক্ষা মন্ত্রণালয়', 'মাধ্যমিক ও উচ্চ শিক্ষা',
      'ministry of education', 'education ministry',
      'শিক্ষা বোর্ড', 'মাউশি',
    ],
  },
  {
    officeNames: ['Ministry of Primary and Mass Education'],
    phrases: [
      'প্রাথমিক ও গণশিক্ষা মন্ত্রণালয়', 'প্রাথমিক শিক্ষা',
      'ministry of primary and mass education', 'primary education',
    ],
  },
  {
    officeNames: ['Ministry of Information and Broadcasting', 'Ministry of Information'],
    phrases: [
      'তথ্য ও সম্প্রচার মন্ত্রণালয়', 'তথ্য মন্ত্রণালয়',
      'ministry of information', 'information and broadcasting',
      'বাংলাদেশ টেলিভিশন', 'বাংলাদেশ বেতার', 'press information department',
    ],
  },
  {
    officeNames: ['Ministry of Posts, Telecommunications and Information Technology', 'Ministry of ICT'],
    phrases: [
      'তথ্য ও যোগাযোগ প্রযুক্তি মন্ত্রণালয়', 'আইসিটি মন্ত্রণালয়',
      'ict ministry', 'ministry of ict',
      'বাংলাদেশ টেলিকমিউনিকেশন', 'বিটিআরসি', 'btrc',
    ],
  },
  {
    officeNames: ['Ministry of Finance', 'Finance Division'],
    phrases: [
      'অর্থ মন্ত্রণালয়', 'অর্থ বিভাগ',
      'ministry of finance', 'finance ministry', 'finance division',
      'জাতীয় রাজস্ব বোর্ড', 'এনবিআর', 'nbr',
      'বাংলাদেশ ব্যাংক', 'bangladesh bank',
    ],
  },
  {
    officeNames: ['Ministry of Commerce'],
    phrases: [
      'বাণিজ্য মন্ত্রণালয়', 'ministry of commerce', 'commerce ministry',
      'টিসিবি', 'tcb',
    ],
  },
  {
    officeNames: ['Ministry of Agriculture'],
    phrases: [
      'কৃষি মন্ত্রণালয়', 'ministry of agriculture', 'agriculture ministry',
      'কৃষি সম্প্রসারণ অধিদপ্তর',
    ],
  },
  {
    officeNames: ['Ministry of Law, Justice and Parliamentary Affairs'],
    phrases: [
      'আইন বিচার ও সংসদ বিষয়ক মন্ত্রণালয়', 'আইন মন্ত্রণালয়',
      'ministry of law', 'law ministry',
      'সুপ্রিম কোর্ট', 'supreme court', 'হাইকোর্ট', 'high court',
    ],
  },
  {
    officeNames: ['Ministry of Foreign Affairs'],
    phrases: [
      'পররাষ্ট্র মন্ত্রণালয়', 'ministry of foreign affairs', 'foreign ministry',
    ],
  },
  {
    officeNames: ['Ministry of Defence'],
    phrases: [
      'প্রতিরক্ষা মন্ত্রণালয়', 'ministry of defence', 'defence ministry',
      'সেনাবাহিনী', 'নৌবাহিনী', 'বিমানবাহিনী',
    ],
  },
  {
    officeNames: ['Ministry of Industries'],
    phrases: [
      'শিল্প মন্ত্রণালয়', 'ministry of industries',
      'বিসিক', 'bscic',
    ],
  },
  {
    officeNames: ['Ministry of Labour and Employment'],
    phrases: [
      'শ্রম ও কর্মসংস্থান মন্ত্রণালয়', 'শ্রম মন্ত্রণালয়',
      'ministry of labour', 'labour ministry',
    ],
  },
  {
    officeNames: ['Ministry of Environment, Forest and Climate Change'],
    phrases: [
      'পরিবেশ, বন ও জলবায়ু পরিবর্তন মন্ত্রণালয়', 'পরিবেশ মন্ত্রণালয়',
      'ministry of environment', 'environment ministry',
    ],
  },
  {
    officeNames: ['Ministry of Water Resources'],
    phrases: [
      'পানি সম্পদ মন্ত্রণালয়', 'ministry of water resources',
      'পানি উন্নয়ন বোর্ড',
    ],
  },
  {
    officeNames: ['Ministry of Power, Energy and Mineral Resources'],
    phrases: [
      'বিদ্যুৎ জ্বালানি ও খনিজ সম্পদ মন্ত্রণালয়', 'বিদ্যুৎ মন্ত্রণালয়',
      'ministry of power', 'power ministry', 'energy ministry',
      'বিদ্যুৎ বিভাগ', 'পেট্রোবাংলা', 'petrobangla',
    ],
  },
  {
    officeNames: ['Ministry of Disaster Management and Relief'],
    phrases: [
      'দুর্যোগ ব্যবস্থাপনা ও ত্রাণ মন্ত্রণালয়', 'দুর্যোগ মন্ত্রণালয়',
      'ministry of disaster management', 'disaster management',
    ],
  },
  {
    officeNames: ['Ministry of Social Welfare'],
    phrases: [
      'সমাজকল্যাণ মন্ত্রণালয়', 'ministry of social welfare',
    ],
  },
  {
    officeNames: ['Ministry of Housing and Public Works'],
    phrases: [
      'গৃহায়ন ও গণপূর্ত মন্ত্রণালয়', 'গৃহায়ন মন্ত্রণালয়',
      'ministry of housing', 'housing ministry',
      'রাজউক', 'rajuk',
    ],
  },
  {
    officeNames: ['Ministry of Railways'],
    phrases: [
      'রেলপথ মন্ত্রণালয়', 'ministry of railways',
      'বাংলাদেশ রেলওয়ে',
    ],
  },
  {
    officeNames: ['Ministry of Shipping'],
    phrases: [
      'নৌপরিবহন মন্ত্রণালয়', 'ministry of shipping',
      'চট্টগ্রাম বন্দর', 'মোংলা বন্দর',
    ],
  },
  {
    officeNames: ['Election Commission'],
    phrases: [
      'নির্বাচন কমিশন', 'election commission',
      'প্রধান নির্বাচন কমিশনার', 'chief election commissioner',
    ],
  },
  {
    officeNames: ["Prime Minister's Office"],
    phrases: [
      'প্রধানমন্ত্রীর কার্যালয়', "prime minister's office",
    ],
  },
  {
    officeNames: ['Cabinet Division'],
    phrases: [
      'মন্ত্রিপরিষদ বিভাগ', 'cabinet division',
    ],
  },
  {
    officeNames: ['Anti-Corruption Commission'],
    phrases: [
      'দুর্নীতি দমন কমিশন', 'দুদক', 'anti-corruption commission',
    ],
  },
  {
    officeNames: ['Local Government Division'],
    phrases: [
      'স্থানীয় সরকার বিভাগ', 'local government division',
      'সিটি কর্পোরেশন', 'পৌরসভা', 'ইউনিয়ন পরিষদ',
    ],
  },
  {
    officeNames: ['Ministry of Textiles and Jute'],
    phrases: [
      'বস্ত্র ও পাট মন্ত্রণালয়', 'ministry of textiles and jute',
      'পাট মন্ত্রণালয়',
    ],
  },
  {
    officeNames: ['Ministry of Liberation War Affairs'],
    phrases: [
      'মুক্তিযুদ্ধ বিষয়ক মন্ত্রণালয়', 'ministry of liberation war affairs',
      'মুক্তিযোদ্ধা',
    ],
  },
  {
    officeNames: ['Ministry of Food'],
    phrases: [
      'খাদ্য মন্ত্রণালয়', 'ministry of food', 'food ministry',
    ],
  },
  {
    officeNames: ['Ministry of Fisheries and Livestock'],
    phrases: [
      'মৎস্য ও প্রাণিসম্পদ মন্ত্রণালয়', 'ministry of fisheries',
    ],
  },
  {
    officeNames: ['Ministry of Youth and Sports'],
    phrases: [
      'যুব ও ক্রীড়া মন্ত্রণালয়', 'ক্রীড়া মন্ত্রণালয়',
      'ministry of youth and sports',
    ],
  },
  {
    officeNames: ['Ministry of Women and Children Affairs'],
    phrases: [
      'মহিলা ও শিশু বিষয়ক মন্ত্রণালয়', 'ministry of women and children affairs',
    ],
  },
  {
    officeNames: ['Ministry of Expatriates Welfare and Overseas Employment'],
    phrases: [
      'প্রবাসী কল্যাণ ও বৈদেশিক কর্মসংস্থান মন্ত্রণালয়',
      'ministry of expatriates welfare', 'প্রবাসী কল্যাণ',
    ],
  },
  {
    officeNames: ['Ministry of Science and Technology'],
    phrases: [
      'বিজ্ঞান ও প্রযুক্তি মন্ত্রণালয়', 'ministry of science and technology',
    ],
  },
  {
    officeNames: ['Ministry of Land'],
    phrases: [
      'ভূমি মন্ত্রণালয়', 'ministry of land', 'land ministry',
    ],
  },
  {
    officeNames: ['Ministry of Planning'],
    phrases: [
      'পরিকল্পনা মন্ত্রণালয়', 'ministry of planning', 'planning commission',
    ],
  },
  {
    officeNames: ['Ministry of Religious Affairs'],
    phrases: [
      'ধর্ম বিষয়ক মন্ত্রণালয়', 'ministry of religious affairs',
    ],
  },
  {
    officeNames: ['Ministry of Civil Aviation and Tourism'],
    phrases: [
      'বেসামরিক বিমান পরিবহন ও পর্যটন মন্ত্রণালয়',
      'ministry of civil aviation',
      'বিমান বাংলাদেশ', 'biman bangladesh',
    ],
  },
  {
    officeNames: ['Ministry of Chittagong Hill Tracts Affairs'],
    phrases: [
      'পার্বত্য চট্টগ্রাম বিষয়ক মন্ত্রণালয়',
      'ministry of chittagong hill tracts',
    ],
  },
  {
    officeNames: ['Ministry of Cultural Affairs'],
    phrases: [
      'সংস্কৃতি বিষয়ক মন্ত্রণালয়', 'ministry of cultural affairs',
      'বাংলা একাডেমি',
    ],
  },
];

function findBestMatchingOfficeFromContacts(contacts, officeNameCandidates) {
  if (!Array.isArray(contacts) || contacts.length === 0) return officeNameCandidates[0] || null;

  const contactOfficeNames = new Set(
    contacts
      .map((c) => (c?.office_name || c?.Office_Name || c?.Ministry || c?.ministry || '').toString().trim())
      .filter(Boolean)
  );

  // Prefer exact match to an existing office_name in contacts.
  for (const name of officeNameCandidates) {
    if (contactOfficeNames.has(name)) return name;
  }

  // Fallback: try case-insensitive contains.
  const normalizedContacts = Array.from(contactOfficeNames).map((n) => ({ raw: n, n: normalizeText(n) }));
  for (const name of officeNameCandidates) {
    const n = normalizeText(name);
    const found = normalizedContacts.find((c) => c.n === n || c.n.includes(n) || n.includes(c.n));
    if (found) return found.raw;
  }

  return officeNameCandidates[0] || null;
}

/**
 * Detects ALL matching high-priority offices from explicit phrases.
 * Returns the best (first) match as primary, and all matches.
 * @param {string} text
 * @param {Array<object>} contacts
 * @returns {{ officeName: string|null, matchedPhrase: string|null, ruleIndex: number|null, allMatches: Array }}
 */
function detectPriorityOffice(text, contacts) {
  const haystack = normalizeText(text);
  if (!haystack) return { officeName: null, matchedPhrase: null, ruleIndex: null, allMatches: [] };

  const allMatches = [];
  const seenRules = new Set();

  for (let i = 0; i < PHRASE_RULES.length; i++) {
    const rule = PHRASE_RULES[i];
    for (const phrase of rule.phrases) {
      const p = normalizeText(phrase);
      if (!p) continue;
      // Word-boundary-ish check for English; Bengali is handled as substring.
      const matched = /[a-z]/.test(p)
        ? new RegExp(`(^|[^a-z])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(haystack)
        : haystack.includes(p);

      if (matched && !seenRules.has(i)) {
        seenRules.add(i);
        const officeName = findBestMatchingOfficeFromContacts(contacts, rule.officeNames);
        allMatches.push({ officeName: officeName || null, matchedPhrase: phrase, ruleIndex: i });
      }
    }
  }

  if (allMatches.length === 0) {
    return { officeName: null, matchedPhrase: null, ruleIndex: null, allMatches: [] };
  }

  return {
    officeName: allMatches[0].officeName,
    matchedPhrase: allMatches[0].matchedPhrase,
    ruleIndex: allMatches[0].ruleIndex,
    allMatches,
  };
}

module.exports = {
  detectPriorityOffice,
};
