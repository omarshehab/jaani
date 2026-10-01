/**
 * Deterministic government-body matcher for Section 2 (News Analysis).
 *
 * Finds which ministries / divisions / offices of JAANI_RTI_OFFICERS_COMPLETE.csv an article is
 * about WITHOUT an AI call:
 *   1. a gazetteer built from the CSV's Ministry/Division/Office columns plus curated aliases
 *      (short forms, English names, former names) and a curated agency → parent table
 *      (e.g. ডিএমপি → স্বরাষ্ট্র মন্ত্রণালয়) for bodies that have no row of their own;
 *   2. an Aho-Corasick scan over normalized text (UTF-16 code units, so Bengali case suffixes
 *      attached to a noun — মন্ত্রণালয়ের, ডিএমপির — still match), leftmost-longest;
 *   3. a grapheme-level edit-distance fallback near anchor words (মন্ত্রণালয়, বিভাগ, …) for
 *      spelling variants the exact scan misses.
 * AI-extracted organisation names can be run through the same matcher as a secondary cross-check.
 */

const rtiLookup = require('./rtiDatabaseLookup');

// ── Curated aliases, keyed by the CSV's canonical Ministry/Division/Office name ────────────────
const ALIASES = {
  'স্বরাষ্ট্র মন্ত্রণালয়': ['Ministry of Home Affairs', 'MoHA', 'জননিরাপত্তা বিভাগ', 'সুরক্ষা সেবা বিভাগ'],
  'অর্থ বিভাগ': ['Finance Division'],
  'অর্থ মন্ত্রণালয়': ['Ministry of Finance'],
  'অভ্যন্তরীণ সম্পদ বিভাগ': ['Internal Resources Division'],
  'অর্থনৈতিক সম্পর্ক বিভাগ': ['Economic Relations Division', 'ইআরডি'],
  'আর্থিক প্রতিষ্ঠান বিভাগ': ['Financial Institutions Division'],
  'আইন, বিচার ও সংসদ বিষয়ক মন্ত্রণালয়': ['আইন মন্ত্রণালয়', 'Ministry of Law, Justice and Parliamentary Affairs', 'Law Ministry'],
  'আইন ও বিচার বিভাগ': ['Law and Justice Division'],
  'লেজিসলেটিভ ও সংসদ বিষয়ক বিভাগ': ['Legislative and Parliamentary Affairs Division'],
  'বাংলাদেশ জাতীয় সংসদ সচিবালয়': ['সংসদ সচিবালয়', 'Parliament Secretariat'],
  'কৃষি মন্ত্রণালয়': ['Ministry of Agriculture'],
  'খাদ্য মন্ত্রণালয়': ['Ministry of Food'],
  'গৃহায়ন ও গণপূর্ত মন্ত্রণালয়': ['গণপূর্ত মন্ত্রণালয়', 'Ministry of Housing and Public Works'],
  'জনপ্রশাসন মন্ত্রণালয়': ['Ministry of Public Administration'],
  'বাংলাদেশ সরকারী কর্মকমিশন সচিবালয়': ['সরকারি কর্ম কমিশন', 'সরকারি কর্মকমিশন', 'পিএসসি', 'Public Service Commission'],
  'ডাক ও টেলিযোগাযোগ বিভাগ': ['ডাক ও টেলিযোগাযোগ মন্ত্রণালয়', 'Posts and Telecommunications Division'],
  'তথ্য ও যোগাযোগ প্রযুক্তি বিভাগ': ['আইসিটি বিভাগ', 'ICT Division'],
  'তথ্য ও সম্প্রচার মন্ত্রণালয়': ['তথ্য মন্ত্রণালয়', 'Ministry of Information and Broadcasting'],
  'দুর্যোগ ব্যবস্থাপনা ও ত্রাণ মন্ত্রণালয়': ['ত্রাণ মন্ত্রণালয়', 'Ministry of Disaster Management and Relief'],
  'ধর্ম বিষয়ক মন্ত্রণালয়': ['ধর্ম মন্ত্রণালয়', 'ধর্মবিষয়ক মন্ত্রণালয়', 'Ministry of Religious Affairs'],
  'নৌ-পরিবহন মন্ত্রণালয়': ['নৌপরিবহন মন্ত্রণালয়', 'Ministry of Shipping'],
  'পররাষ্ট্র মন্ত্রণালয়': ['Ministry of Foreign Affairs'],
  'পরিকল্পনা বিভাগ': ['Planning Division'],
  'পরিকল্পনা মন্ত্রণালয়': ['Ministry of Planning'],
  'পরিসংখ্যান ও তথ্য ব্যবস্থাপনা বিভাগ': ['Statistics and Informatics Division'],
  'বাস্তবায়ন পরিবীক্ষণ ও মূল্যায়ন বিভাগ': ['আইএমইডি', 'IMED'],
  'পরিবেশ, বন ও জলবায়ু পরিবর্তন মন্ত্রণালয়': ['বন, পরিবেশ ও জলবায়ু পরিবর্তন মন্ত্রণালয়', 'পরিবেশ মন্ত্রণালয়', 'Ministry of Environment, Forest and Climate Change'],
  'পানি সম্পদ মন্ত্রণালয়': ['পানিসম্পদ মন্ত্রণালয়', 'Ministry of Water Resources'],
  'পার্বত্য চট্টগ্রাম বিষয়ক মন্ত্রণালয়': ['Ministry of Chittagong Hill Tracts Affairs'],
  'প্রতিরক্ষা মন্ত্রণালয়': ['Ministry of Defence'],
  'প্রধানমন্ত্রীর কার্যালয়': ['প্রধান উপদেষ্টার কার্যালয়', "Prime Minister's Office", "Chief Adviser's Office"],
  'প্রবাসী কল্যাণ ও বৈদেশিক কর্মসংস্থান মন্ত্রণালয়': ['প্রবাসীকল্যাণ মন্ত্রণালয়', 'প্রবাসী কল্যাণ মন্ত্রণালয়', "Ministry of Expatriates' Welfare and Overseas Employment"],
  'প্রাথমিক ও গণশিক্ষা মন্ত্রণালয়': ['Ministry of Primary and Mass Education'],
  'বস্ত্র ও পাট মন্ত্রণালয়': ['Ministry of Textiles and Jute'],
  'বাণিজ্য মন্ত্রণালয়': ['Ministry of Commerce'],
  'বিজ্ঞান ও প্রযুক্তি মন্ত্রণালয়': ['Ministry of Science and Technology'],
  'বিদ্যুৎ, জ্বালানি ও খনিজ সম্পদ মন্ত্রণালয়': ['Ministry of Power, Energy and Mineral Resources'],
  'জ্বালানি ও খনিজ সম্পদ বিভাগ': ['জ্বালানি বিভাগ', 'Energy and Mineral Resources Division'],
  'বিদ্যুৎ বিভাগ': ['Power Division'],
  'বেসামরিক বিমান পরিবহন ও পর্যটন মন্ত্রণালয়': ['Ministry of Civil Aviation and Tourism'],
  'ভূমি মন্ত্রণালয়': ['Ministry of Land'],
  'মন্ত্রিপরিষদ বিভাগ': ['Cabinet Division'],
  'মহিলা ও শিশু বিষয়ক মন্ত্রণালয়': ['মহিলা ও শিশুবিষয়ক মন্ত্রণালয়', "Ministry of Women and Children Affairs"],
  'মুক্তিযুদ্ধ বিষয়ক মন্ত্রণালয়': ['মুক্তিযুদ্ধবিষয়ক মন্ত্রণালয়', 'Ministry of Liberation War Affairs'],
  'মৎস্য ও প্রাণিসম্পদ মন্ত্রণালয়': ['Ministry of Fisheries and Livestock'],
  'যুব ও ক্রীড়া মন্ত্রণালয়': ['Ministry of Youth and Sports'],
  'রাষ্ট্রপতির কার্যালয়': ['বঙ্গভবন', "President's Office"],
  'রেলপথ মন্ত্রণালয়': ['রেল মন্ত্রণালয়', 'Ministry of Railways'],
  'শিক্ষা মন্ত্রণালয়': ['Ministry of Education'],
  'কারিগরি ও মাদ্রাসা শিক্ষা বিভাগ': ['Technical and Madrasah Education Division'],
  'মাধ্যমিক ও উচ্চ শিক্ষা বিভাগ': ['Secondary and Higher Education Division'],
  'শিল্প মন্ত্রণালয়': ['Ministry of Industries'],
  'শ্রম ও কর্মসংস্থান মন্ত্রণালয়': ['শ্রম মন্ত্রণালয়', 'Ministry of Labour and Employment'],
  'সংস্কৃতি বিষয়ক মন্ত্রণালয়': ['সংস্কৃতি মন্ত্রণালয়', 'Ministry of Cultural Affairs'],
  'সড়ক পরিবহন ও সেতু মন্ত্রণালয়': ['সড়ক পরিবহন মন্ত্রণালয়', 'Ministry of Road Transport and Bridges'],
  'সড়ক পরিবহন ও মহাসড়ক বিভাগ': ['Road Transport and Highways Division'],
  'সেতু বিভাগ': ['Bridges Division'],
  'সমাজকল্যাণ মন্ত্রণালয়': ['Ministry of Social Welfare'],
  'সশস্ত্র বাহিনী বিভাগ': ['Armed Forces Division'],
  'স্থানীয় সরকার, পল্লী উন্নয়ন ও সমবায় মন্ত্রণালয়': ['স্থানীয় সরকার মন্ত্রণালয়', 'এলজিআরডি মন্ত্রণালয়', 'Ministry of Local Government, Rural Development and Co-operatives'],
  'স্থানীয় সরকার বিভাগ': ['Local Government Division'],
  'পল্লী উন্নয়ন ও সমবায় বিভাগ': ['Rural Development and Co-operatives Division'],
  'স্বাস্থ্য ও পরিবার কল্যাণ মন্ত্রণালয়': ['স্বাস্থ্য মন্ত্রণালয়', 'Ministry of Health and Family Welfare'],
  'স্বাস্থ্য সেবা বিভাগ': ['Health Services Division'],
  'স্বাস্থ্য শিক্ষা ও পরিবার কল্যাণ বিভাগ': ['Medical Education and Family Welfare Division'],
};

// ── Curated agencies with no CSV row of their own → the CSV row that is their parent ──────────
// Deterministic escalation (RTI Act s.9(2)); `strict` = short/ambiguous form that must be
// followed by a word boundary or a common case suffix.
const AGENCY_PARENTS = [
  { names: ['ঢাকা মহানগর পুলিশ', 'ডিএমপি', 'DMP'], parent: 'স্বরাষ্ট্র মন্ত্রণালয়' },
  { names: ['চট্টগ্রাম মহানগর পুলিশ', 'সিএমপি', 'বাংলাদেশ পুলিশ', 'পুলিশ সদর দপ্তর', 'মহানগর পুলিশ'], parent: 'স্বরাষ্ট্র মন্ত্রণালয়' },
  { names: ['র‍্যাব', 'র্যাব', 'র‌্যাব', 'RAB', 'র‍্যাপিড অ্যাকশন ব্যাটালিয়ন'], parent: 'স্বরাষ্ট্র মন্ত্রণালয়' },
  { names: ['বর্ডার গার্ড বাংলাদেশ', 'বিজিবি', 'BGB', 'কোস্ট গার্ড', 'আনসার', 'ভিডিপি'], parent: 'স্বরাষ্ট্র মন্ত্রণালয়' },
  { names: ['ফায়ার সার্ভিস', 'ফায়ার সার্ভিস ও সিভিল ডিফেন্স', 'কারা অধিদপ্তর', 'কারাগার', 'ইমিগ্রেশন ও পাসপোর্ট অধিদপ্তর', 'পাসপোর্ট অফিস', 'মাদকদ্রব্য নিয়ন্ত্রণ অধিদপ্তর'], parent: 'স্বরাষ্ট্র মন্ত্রণালয়' },
  { names: ['পুলিশ', 'থানা পুলিশ'], parent: 'স্বরাষ্ট্র মন্ত্রণালয়', strict: true, generic: true },
  { names: ['জাতীয় রাজস্ব বোর্ড', 'এনবিআর', 'NBR', 'কাস্টমস'], parent: 'অভ্যন্তরীণ সম্পদ বিভাগ' },
  { names: ['বাংলাদেশ ব্যাংক', 'রাষ্ট্রায়ত্ত ব্যাংক', 'বিএসইসি', 'বাংলাদেশ সিকিউরিটিজ অ্যান্ড এক্সচেঞ্জ কমিশন'], parent: 'আর্থিক প্রতিষ্ঠান বিভাগ' },
  { names: ['স্বাস্থ্য অধিদপ্তর', 'স্বাস্থ্য অধিদপ্তরের', 'সরকারি হাসপাতাল', 'মেডিকেল কলেজ হাসপাতাল', 'উপজেলা স্বাস্থ্য কমপ্লেক্স', 'ঔষধ প্রশাসন অধিদপ্তর'], parent: 'স্বাস্থ্য সেবা বিভাগ' },
  { names: ['পরিবার পরিকল্পনা অধিদপ্তর'], parent: 'স্বাস্থ্য শিক্ষা ও পরিবার কল্যাণ বিভাগ' },
  { names: ['ঢাকা উত্তর সিটি করপোরেশন', 'ঢাকা দক্ষিণ সিটি করপোরেশন', 'সিটি করপোরেশন', 'সিটি কর্পোরেশন', 'ওয়াসা', 'এলজিইডি', 'স্থানীয় সরকার প্রকৌশল অধিদপ্তর', 'জনস্বাস্থ্য প্রকৌশল অধিদপ্তর', 'পৌরসভা', 'উপজেলা পরিষদ', 'ইউনিয়ন পরিষদ', 'জেলা পরিষদ'], parent: 'স্থানীয় সরকার বিভাগ' },
  { names: ['রাজউক', 'রাজধানী উন্নয়ন কর্তৃপক্ষ', 'গণপূর্ত অধিদপ্তর', 'জাতীয় গৃহায়ন কর্তৃপক্ষ'], parent: 'গৃহায়ন ও গণপূর্ত মন্ত্রণালয়' },
  { names: ['বিআরটিএ', 'বাংলাদেশ সড়ক পরিবহন কর্তৃপক্ষ', 'বিআরটিসি', 'সড়ক ও জনপথ অধিদপ্তর', 'সওজ', 'ঢাকা পরিবহন সমন্বয় কর্তৃপক্ষ', 'ডিটিসিএ', 'মেট্রোরেল', 'ডিএমটিসিএল'], parent: 'সড়ক পরিবহন ও মহাসড়ক বিভাগ' },
  { names: ['বাংলাদেশ সেতু কর্তৃপক্ষ', 'পদ্মা সেতু', 'যমুনা সেতু', 'এক্সপ্রেসওয়ে'], parent: 'সেতু বিভাগ' },
  { names: ['বাংলাদেশ রেলওয়ে'], parent: 'রেলপথ মন্ত্রণালয়' },
  { names: ['বিমান বাংলাদেশ এয়ারলাইনস', 'বেসামরিক বিমান চলাচল কর্তৃপক্ষ', 'বেবিচক', 'শাহজালাল আন্তর্জাতিক বিমানবন্দর', 'পর্যটন করপোরেশন'], parent: 'বেসামরিক বিমান পরিবহন ও পর্যটন মন্ত্রণালয়' },
  { names: ['বিআইডব্লিউটিএ', 'বিআইডব্লিউটিসি', 'চট্টগ্রাম বন্দর', 'চট্টগ্রাম বন্দর কর্তৃপক্ষ', 'মোংলা বন্দর', 'নৌপরিবহন অধিদপ্তর'], parent: 'নৌ-পরিবহন মন্ত্রণালয়' },
  { names: ['পানি উন্নয়ন বোর্ড', 'পাউবো'], parent: 'পানি সম্পদ মন্ত্রণালয়' },
  { names: ['পরিবেশ অধিদপ্তর', 'বন অধিদপ্তর', 'বন বিভাগ'], parent: 'পরিবেশ, বন ও জলবায়ু পরিবর্তন মন্ত্রণালয়' },
  { names: ['বিটিআরসি', 'বাংলাদেশ টেলিযোগাযোগ নিয়ন্ত্রণ কমিশন', 'ডাক বিভাগ', 'টেলিটক', 'বিটিসিএল'], parent: 'ডাক ও টেলিযোগাযোগ বিভাগ' },
  { names: ['বিদ্যুৎ উন্নয়ন বোর্ড', 'পিডিবি', 'ডেসকো', 'ডিপিডিসি', 'পল্লী বিদ্যুতায়ন বোর্ড', 'পল্লী বিদ্যুৎ'], parent: 'বিদ্যুৎ বিভাগ' },
  { names: ['পেট্রোবাংলা', 'বিপিসি', 'বাংলাদেশ পেট্রোলিয়াম করপোরেশন', 'তিতাস গ্যাস', 'বিস্ফোরক পরিদপ্তর'], parent: 'জ্বালানি ও খনিজ সম্পদ বিভাগ' },
  { names: ['মাধ্যমিক ও উচ্চশিক্ষা অধিদপ্তর', 'মাউশি', 'শিক্ষা বোর্ড', 'বিশ্ববিদ্যালয় মঞ্জুরি কমিশন', 'ইউজিসি', 'এনসিটিবি', 'জাতীয় শিক্ষাক্রম ও পাঠ্যপুস্তক বোর্ড'], parent: 'মাধ্যমিক ও উচ্চ শিক্ষা বিভাগ' },
  { names: ['কারিগরি শিক্ষা অধিদপ্তর', 'মাদ্রাসা শিক্ষা অধিদপ্তর', 'কারিগরি শিক্ষা বোর্ড', 'মাদ্রাসা শিক্ষা বোর্ড'], parent: 'কারিগরি ও মাদ্রাসা শিক্ষা বিভাগ' },
  { names: ['প্রাথমিক শিক্ষা অধিদপ্তর', 'সরকারি প্রাথমিক বিদ্যালয়'], parent: 'প্রাথমিক ও গণশিক্ষা মন্ত্রণালয়' },
  { names: ['কৃষি সম্প্রসারণ অধিদপ্তর', 'বিএডিসি', 'বাংলাদেশ কৃষি উন্নয়ন করপোরেশন'], parent: 'কৃষি মন্ত্রণালয়' },
  { names: ['খাদ্য অধিদপ্তর', 'ওএমএস'], parent: 'খাদ্য মন্ত্রণালয়' },
  { names: ['টিসিবি', 'ট্রেডিং করপোরেশন অব বাংলাদেশ', 'ভোক্তা অধিকার সংরক্ষণ অধিদপ্তর', 'প্রতিযোগিতা কমিশন'], parent: 'বাণিজ্য মন্ত্রণালয়' },
  { names: ['ভূমি অফিস', 'সহকারী কমিশনার (ভূমি)', 'এসি ল্যান্ড', 'ভূমি রেকর্ড ও জরিপ অধিদপ্তর'], parent: 'ভূমি মন্ত্রণালয়' },
  { names: ['জেলা প্রশাসন', 'জেলা প্রশাসক', 'জেলা প্রশাসকের কার্যালয়', 'উপজেলা নির্বাহী অফিসার', 'ইউএনও'], parent: 'মন্ত্রিপরিষদ বিভাগ' },
  { names: ['বাংলাদেশ সেনাবাহিনী', 'সেনাবাহিনী', 'নৌবাহিনী', 'বিমানবাহিনী'], parent: 'সশস্ত্র বাহিনী বিভাগ' },
  { names: ['ইসলামিক ফাউন্ডেশন'], parent: 'ধর্ম বিষয়ক মন্ত্রণালয়' },
  { names: ['সমাজসেবা অধিদপ্তর'], parent: 'সমাজকল্যাণ মন্ত্রণালয়' },
  { names: ['মহিলাবিষয়ক অধিদপ্তর', 'মহিলা বিষয়ক অধিদপ্তর'], parent: 'মহিলা ও শিশু বিষয়ক মন্ত্রণালয়' },
  { names: ['বিসিক', 'বাংলাদেশ ক্ষুদ্র ও কুটির শিল্প করপোরেশন', 'বিএসটিআই'], parent: 'শিল্প মন্ত্রণালয়' },
  { names: ['বিএমইটি', 'জনশক্তি, কর্মসংস্থান ও প্রশিক্ষণ ব্যুরো'], parent: 'প্রবাসী কল্যাণ ও বৈদেশিক কর্মসংস্থান মন্ত্রণালয়' },
  { names: ['কলকারখানা ও প্রতিষ্ঠান পরিদর্শন অধিদপ্তর'], parent: 'শ্রম ও কর্মসংস্থান মন্ত্রণালয়' },
  { names: ['বিটিভি', 'বাংলাদেশ টেলিভিশন', 'বাংলাদেশ বেতার', 'বাসস', 'চলচ্চিত্র ও প্রকাশনা অধিদপ্তর'], parent: 'তথ্য ও সম্প্রচার মন্ত্রণালয়' },
  { names: ['দুর্যোগ ব্যবস্থাপনা অধিদপ্তর'], parent: 'দুর্যোগ ব্যবস্থাপনা ও ত্রাণ মন্ত্রণালয়' },
  { names: ['মৎস্য অধিদপ্তর', 'প্রাণিসম্পদ অধিদপ্তর'], parent: 'মৎস্য ও প্রাণিসম্পদ মন্ত্রণালয়' },
  { names: ['যুব উন্নয়ন অধিদপ্তর', 'জাতীয় ক্রীড়া পরিষদ'], parent: 'যুব ও ক্রীড়া মন্ত্রণালয়' },
  { names: ['পরিসংখ্যান ব্যুরো', 'বিবিএস'], parent: 'পরিসংখ্যান ও তথ্য ব্যবস্থাপনা বিভাগ' },
];

// Words that end most ministry/office names — the fuzzy fallback only looks near these.
const ANCHOR_WORDS = ['মন্ত্রণালয়', 'বিভাগ', 'অধিদপ্তর', 'দপ্তর', 'কমিশন', 'কর্তৃপক্ষ', 'সচিবালয়', 'কার্যালয়'];

// Case suffixes that may follow a `strict` (short/ambiguous) alias.
const STRICT_SUFFIX_RE = /^(?:$|[^ঀ-৿]|র|এর|ের|কে|তে|য়|এ|ে|ও|ই|দের|সহ)/u;

const BN_DIGITS = /[০-৯]/g;
const BN_LETTER_RE = /[ঀ-৿A-Za-z0-9]/u;

function normalizeText(value) {
  return (value == null ? '' : String(value))
    .normalize('NFC')
    .replace(/ত্‍/g, 'ৎ') // ত্‍ (ZWJ form) → ৎ
    .replace(/[​-‍﻿]/g, '')
    .replace(BN_DIGITS, (d) => String(d.charCodeAt(0) - 0x09E6))
    .replace(/[-‐‑–—]/g, '')
    .replace(/[,;:!?'"‘’“”()[\]{}।॥|/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

// ── Aho-Corasick over UTF-16 code units ────────────────────────────────────────────────────────
function buildAutomaton(patterns) {
  const goto = [new Map()];
  const fail = [0];
  const out = [[]];
  patterns.forEach((p, idx) => {
    let s = 0;
    for (const ch of p) {
      let next = goto[s].get(ch);
      if (next === undefined) {
        next = goto.length;
        goto.push(new Map());
        fail.push(0);
        out.push([]);
        goto[s].set(ch, next);
      }
      s = next;
    }
    out[s].push(idx);
  });
  const queue = [];
  for (const s of goto[0].values()) queue.push(s);
  while (queue.length) {
    const r = queue.shift();
    for (const [ch, s] of goto[r]) {
      queue.push(s);
      let f = fail[r];
      while (f && !goto[f].has(ch)) f = fail[f];
      fail[s] = goto[f].has(ch) && goto[f].get(ch) !== s ? goto[f].get(ch) : 0;
      out[s] = out[s].concat(out[fail[s]]);
    }
  }
  return { goto, fail, out };
}

function searchAutomaton(auto, patterns, text) {
  const hits = [];
  let s = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    while (s && !auto.goto[s].has(ch)) s = auto.fail[s];
    s = auto.goto[s].get(ch) || 0;
    for (const idx of auto.out[s]) {
      hits.push({ idx, start: i - patterns[idx].length + 1, end: i + 1 });
    }
  }
  return hits;
}

// Leftmost-longest, non-overlapping.
function selectLeftmostLongest(hits) {
  const sorted = [...hits].sort((a, b) => (a.start - b.start) || ((b.end - b.start) - (a.end - a.start)));
  const chosen = [];
  let lastEnd = -1;
  for (const h of sorted) {
    if (h.start >= lastEnd) {
      chosen.push(h);
      lastEnd = h.end;
    }
  }
  return chosen;
}

// ── Grapheme-level edit distance for the fuzzy fallback ────────────────────────────────────────
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('bn', { granularity: 'grapheme' }) : null;
function graphemes(value) {
  if (!segmenter) return Array.from(value);
  return Array.from(segmenter.segment(value), (s) => s.segment);
}

function editDistance(a, b, limit) {
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    let rowMin = prev[0];
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
      if (prev[j] < rowMin) rowMin = prev[j];
    }
    if (rowMin > limit) return limit + 1;
  }
  return prev[b.length];
}

// ── Gazetteer build (cached; rebuilt when the CSV changes) ─────────────────────────────────────
let cache = null;

function buildGazetteer() {
  const { data, signature } = rtiLookup.getDatabase();
  if (cache && cache.signature === signature) return cache;

  // canonical name → { level, rows[] }
  const bodies = new Map();
  const addBody = (name, level, row) => {
    const key = (name || '').trim();
    if (!key) return;
    const existing = bodies.get(key);
    const rank = { office: 3, division: 2, ministry: 1 }[level];
    if (!existing) {
      bodies.set(key, { canonical: key, level, rank, rows: [row] });
      return;
    }
    if (!existing.rows.includes(row)) existing.rows.push(row);
    if (rank > existing.rank) Object.assign(existing, { level, rank });
  };
  data.forEach((row) => {
    addBody(row.ministry, 'ministry', row);
    addBody(row.division, 'division', row);
    addBody(row.office, 'office', row);
  });

  // pattern list: each normalized surface form → { canonical, kind, strict, agency }
  const entries = [];
  const seen = new Set();
  const addPattern = (surface, meta) => {
    const norm = normalizeText(surface);
    if (!norm || norm.length < 2 || seen.has(norm)) return;
    seen.add(norm);
    entries.push({ pattern: norm, ...meta });
  };
  for (const body of bodies.values()) {
    addPattern(body.canonical, { canonical: body.canonical, kind: 'exact' });
    (ALIASES[body.canonical] || []).forEach((alias) => addPattern(alias, { canonical: body.canonical, kind: 'alias' }));
  }
  AGENCY_PARENTS.forEach((group) => {
    if (!bodies.has(group.parent)) return; // parent must exist in the CSV
    group.names.forEach((name) => addPattern(name, {
      canonical: group.parent, kind: 'agency_parent', agency: group.names[0], strict: Boolean(group.strict), generic: Boolean(group.generic),
    }));
  });

  const patterns = entries.map((e) => e.pattern);
  cache = {
    signature,
    bodies,
    entries,
    patterns,
    automaton: buildAutomaton(patterns),
    fuzzyNames: Array.from(bodies.values()).map((b) => ({ canonical: b.canonical, g: graphemes(normalizeText(b.canonical)) })),
  };
  return cache;
}

// ── Matching ───────────────────────────────────────────────────────────────────────────────────
function scanNormalized(text, g, method) {
  const hits = searchAutomaton(g.automaton, g.patterns, text).filter((h) => {
    const before = h.start > 0 ? text[h.start - 1] : '';
    if (before && BN_LETTER_RE.test(before)) return false; // must start at a word start
    const entry = g.entries[h.idx];
    if (entry.strict && !STRICT_SUFFIX_RE.test(text.slice(h.end, h.end + 3))) return false;
    return true;
  });
  return selectLeftmostLongest(hits).map((h) => {
    const entry = g.entries[h.idx];
    return {
      canonical: entry.canonical,
      method: method || (entry.kind === 'agency_parent' ? 'agency_parent' : 'exact'),
      agency: entry.agency || '',
      genericAgency: Boolean(entry.generic),
      matched: text.slice(h.start, h.end),
      start: h.start,
      end: h.end,
    };
  });
}

function fuzzyScan(text, g, taken) {
  const found = [];
  const tg = graphemes(text);
  // grapheme index → code-unit offset, for overlap checks against exact hits
  const offsets = [];
  let pos = 0;
  tg.forEach((cluster) => { offsets.push(pos); pos += cluster.length; });
  offsets.push(pos);
  const covered = (a, b) => taken.some((t) => a < t.end && b > t.start);

  for (const anchor of ANCHOR_WORDS) {
    const ag = graphemes(normalizeText(anchor));
    for (let i = 0; i + ag.length <= tg.length; i += 1) {
      // The anchor's last grapheme may carry a fused case-suffix vowel sign in the text
      // (মন্ত্রণালয় + ের → the text cluster is "য়ে"), so it only has to start with it.
      let isAnchor = true;
      const last = ag.length - 1;
      for (let k = 0; k < last; k += 1) if (tg[i + k] !== ag[k]) { isAnchor = false; break; }
      if (!isAnchor || !tg[i + last].startsWith(ag[last])) continue;
      const anchorEnd = i + ag.length;
      for (const name of g.fuzzyNames) {
        const L = name.g.length;
        if (L < 6 || name.g.slice(-ag.length).join('') !== ag.join('')) continue;
        const limit = Math.max(1, Math.floor(L * 0.15));
        for (let len = L - limit; len <= L + limit; len += 1) {
          const startG = anchorEnd - len;
          if (startG < 0) continue;
          const a = offsets[startG];
          const b = offsets[anchorEnd];
          if (covered(a, b)) continue;
          const windowG = tg.slice(startG, anchorEnd - 1).concat(ag[last]);
          const d = editDistance(windowG, name.g, limit);
          if (d > 0 && d <= limit) {
            found.push({ canonical: name.canonical, method: 'fuzzy', agency: '', matched: text.slice(a, b), start: a, end: b, distance: d });
            break;
          }
        }
      }
    }
  }
  return found;
}

/**
 * Match the government bodies an article is about.
 * @param {string} articleText
 * @param {string[]} aiNames organisation/ministry names proposed by an LLM (secondary cross-check)
 * @returns {{ matches: object[], mentionedGovOrgs: string[] }}
 */
function matchGovernmentBodies(articleText = '', aiNames = []) {
  const g = buildGazetteer();
  if (!g.entries.length) return { matches: [], mentionedGovOrgs: [] };

  const text = normalizeText(articleText);
  const exact = scanNormalized(text, g);
  const fuzzy = fuzzyScan(text, g, exact);
  const crossCheck = [];
  (Array.isArray(aiNames) ? aiNames : []).filter(Boolean).forEach((name) => {
    scanNormalized(normalizeText(name), g, 'ai_crosscheck').forEach((m) => crossCheck.push({ ...m, aiName: name }));
  });

  // One record per canonical body; the strongest method wins, mentions are counted.
  const priority = { exact: 4, agency_parent: 3, fuzzy: 2, ai_crosscheck: 1 };
  const byBody = new Map();
  const addAgency = (rec, m) => {
    if (!m.agency) return;
    const list = m.genericAgency ? rec.genericAgencies : rec.agencies;
    if (!list.includes(m.agency)) list.push(m.agency);
  };
  [...exact, ...fuzzy, ...crossCheck].forEach((m) => {
    const cur = byBody.get(m.canonical);
    const inText = m.method !== 'ai_crosscheck';
    if (!cur) {
      byBody.set(m.canonical, {
        ...m, mentions: inText ? 1 : 0, firstAt: inText ? m.start : Infinity, agencies: [], genericAgencies: [], surfaces: [m.matched],
      });
      addAgency(byBody.get(m.canonical), m);
      return;
    }
    if (inText) {
      cur.mentions += 1;
      cur.firstAt = Math.min(cur.firstAt, m.start);
    }
    addAgency(cur, m);
    if (!cur.surfaces.includes(m.matched)) cur.surfaces.push(m.matched);
    if ((priority[m.method] || 0) > (priority[cur.method] || 0)) {
      cur.method = m.method;
      cur.matched = m.matched;
    }
  });

  const matches = Array.from(byBody.values())
    .sort((a, b) => (b.mentions - a.mentions) || (a.firstAt - b.firstAt))
    .map((m) => {
      const body = g.bodies.get(m.canonical);
      return {
        canonical: m.canonical,
        level: body.rows.some((r) => r.ministry === m.canonical) ? 'ministry'
          : (body.rows.some((r) => r.division === m.canonical) ? 'division' : 'office'),
        method: m.method,
        // A generic mention (plain "পুলিশ") is only listed when no specific agency was named.
        agencies: m.agencies.length ? m.agencies : m.genericAgencies,
        surfaces: m.surfaces,
        mentions: m.mentions,
        distance: m.distance,
        aiName: m.aiName || '',
        rows: body.rows,
      };
    });

  const mentionedGovOrgs = [];
  matches.forEach((m) => {
    m.agencies.forEach((a) => { if (!mentionedGovOrgs.includes(a)) mentionedGovOrgs.push(a); });
    if (!mentionedGovOrgs.includes(m.canonical)) mentionedGovOrgs.push(m.canonical);
  });

  return { matches, mentionedGovOrgs };
}

/** Pick the CSV row whose Designated Officer an RTI request for this body goes to. */
function pickRowForBody(match) {
  const rows = match.rows || [];
  if (!rows.length) return null;
  const own = rows.find((r) => r.office === match.canonical)
    || rows.find((r) => r.division === match.canonical)
    || rows.find((r) => r.division === r.ministry && r.ministry === match.canonical);
  return own || rows[0];
}

const MATCH_CONFIDENCE = { exact: 0.95, agency_parent: 0.8, fuzzy: 0.7, ai_crosscheck: 0.6 };

function officerFromRow(row, role) {
  const p = { primary: 'primary', alternate: 'alternate', appellate: 'appellate' }[role];
  return {
    name: row[`${p}Officer`] || '',
    designation: row[`${p}Designation`] || '',
    phone: row[`${p}Phone`] || '',
    mobile: row[`${p}Mobile`] || '',
    email: row[`${p}Email`] || '',
    address: row[`${p}Address`] || '',
    image: row[`${p}ImageUrl`] || '',
  };
}

/**
 * RTI officer-card records (the `enriched_entities` shape the frontend renders) for the top
 * matched bodies. A ministry with no row of its own lists each of its division rows instead of
 * picking one arbitrarily.
 */
function buildEnrichedEntities(matches = [], { maxBodies = 3 } = {}) {
  const out = [];
  matches.slice(0, maxBodies).forEach((m) => {
    const own = pickRowForBody(m);
    const hasOwnRow = own && (own.office === m.canonical || own.division === m.canonical);
    const rows = hasOwnRow ? [own] : (m.rows || []).slice(0, 4);
    rows.forEach((row) => {
      out.push({
        originalEntity: m.agencies[0] || m.canonical,
        extractedType: 'ORG',
        databaseMatch: {
          ministry: row.ministry,
          division: row.division,
          office: row.office,
          matchedField: m.level,
          matchType: m.method,
          confidence: MATCH_CONFIDENCE[m.method] || 0.5,
          matchedBody: m.canonical,
          // Agency with no CSV row of its own → routed to its parent (RTI Act s.9(2) note).
          escalatedFrom: m.method === 'agency_parent' ? m.agencies : [],
          viaMinistry: hasOwnRow ? '' : m.canonical,
          officers: {
            primary: officerFromRow(row, 'primary'),
            alternate: officerFromRow(row, 'alternate'),
            appellate: officerFromRow(row, 'appellate'),
          },
          websiteLink: row.websiteLink || '',
          lastUpdated: row.lastUpdated || '',
          isFallback: false,
        },
        candidates: [],
      });
    });
  });
  return out;
}

module.exports = {
  matchGovernmentBodies,
  pickRowForBody,
  buildEnrichedEntities,
  MATCH_CONFIDENCE,
  normalizeText,
  // exported for tests
  _internal: { buildAutomaton, searchAutomaton, selectLeftmostLongest, editDistance, graphemes, ALIASES, AGENCY_PARENTS },
};
