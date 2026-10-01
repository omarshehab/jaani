/**
 * Deterministic Bangladesh place detection for Section 2's "Detected Locations" (P8).
 * Fixed list: the 8 divisions and 64 districts (Bengali, common spelling variants, English), matched
 * with the RTI gazetteer's Aho-Corasick over normalized text — no AI call.
 * A name must start at a word boundary and may carry a Bengali case suffix (ঢাকার, সিলেটে, যশোরের).
 */

const { normalizeText, _internal } = require('./rtiGazetteer');

const { buildAutomaton, searchAutomaton, selectLeftmostLongest } = _internal;

// [canonical Bengali, kind, ...variants/English]
const PLACES = [
  // divisions
  ['ঢাকা বিভাগ', 'division', 'Dhaka Division'], ['চট্টগ্রাম বিভাগ', 'division', 'চট্রগ্রাম বিভাগ', 'Chattogram Division', 'Chittagong Division'],
  ['রাজশাহী বিভাগ', 'division', 'Rajshahi Division'], ['খুলনা বিভাগ', 'division', 'Khulna Division'],
  ['বরিশাল বিভাগ', 'division', 'Barishal Division', 'Barisal Division'], ['সিলেট বিভাগ', 'division', 'Sylhet Division'],
  ['রংপুর বিভাগ', 'division', 'Rangpur Division'], ['ময়মনসিংহ বিভাগ', 'division', 'Mymensingh Division'],
  // Dhaka division
  ['ঢাকা', 'district', 'Dhaka', 'রাজধানী'], ['গাজীপুর', 'district', 'Gazipur'], ['নারায়ণগঞ্জ', 'district', 'নারায়নগঞ্জ', 'Narayanganj'],
  ['নরসিংদী', 'district', 'Narsingdi'], ['মানিকগঞ্জ', 'district', 'Manikganj'], ['মুন্সিগঞ্জ', 'district', 'মুন্সীগঞ্জ', 'Munshiganj'],
  ['টাঙ্গাইল', 'district', 'Tangail'], ['কিশোরগঞ্জ', 'district', 'Kishoreganj'], ['ফরিদপুর', 'district', 'Faridpur'],
  ['গোপালগঞ্জ', 'district', 'Gopalganj'], ['মাদারীপুর', 'district', 'Madaripur'], ['রাজবাড়ী', 'district', 'রাজবাড়ি', 'Rajbari'],
  ['শরীয়তপুর', 'district', 'শরিয়তপুর', 'Shariatpur'],
  // Chattogram division
  ['চট্টগ্রাম', 'district', 'চট্রগ্রাম', 'Chattogram', 'Chittagong'], ['কক্সবাজার', 'district', "Cox's Bazar", 'Coxs Bazar'],
  ['কুমিল্লা', 'district', 'Cumilla', 'Comilla'], ['ব্রাহ্মণবাড়িয়া', 'district', 'ব্রাক্ষণবাড়িয়া', 'Brahmanbaria'],
  ['চাঁদপুর', 'district', 'Chandpur'], ['ফেনী', 'district', 'Feni'], ['নোয়াখালী', 'district', 'Noakhali'],
  ['লক্ষ্মীপুর', 'district', 'লক্ষীপুর', 'Lakshmipur', 'Laxmipur'], ['রাঙামাটি', 'district', 'রাঙ্গামাটি', 'Rangamati'],
  ['খাগড়াছড়ি', 'district', 'Khagrachhari', 'Khagrachari'], ['বান্দরবান', 'district', 'Bandarban'],
  // Rajshahi division
  ['রাজশাহী', 'district', 'Rajshahi'], ['নাটোর', 'district', 'Natore'], ['নওগাঁ', 'district', 'Naogaon'],
  ['চাঁপাইনবাবগঞ্জ', 'district', 'চাঁপাই নবাবগঞ্জ', 'Chapainawabganj'], ['পাবনা', 'district', 'Pabna'],
  ['সিরাজগঞ্জ', 'district', 'Sirajganj'], ['বগুড়া', 'district', 'বগুরা', 'Bogura', 'Bogra'], ['জয়পুরহাট', 'district', 'Joypurhat'],
  // Khulna division
  ['খুলনা', 'district', 'Khulna'], ['যশোর', 'district', 'যশোহর', 'Jashore', 'Jessore'], ['সাতক্ষীরা', 'district', 'Satkhira'],
  ['বাগেরহাট', 'district', 'Bagerhat'], ['নড়াইল', 'district', 'Narail'], ['মাগুরা', 'district', 'Magura'],
  ['ঝিনাইদহ', 'district', 'Jhenaidah'], ['কুষ্টিয়া', 'district', 'Kushtia'], ['চুয়াডাঙ্গা', 'district', 'Chuadanga'],
  ['মেহেরপুর', 'district', 'Meherpur'],
  // Barishal division
  ['বরিশাল', 'district', 'Barishal', 'Barisal'], ['ভোলা', 'district', 'Bhola'], ['পটুয়াখালী', 'district', 'Patuakhali'],
  ['বরগুনা', 'district', 'Barguna'], ['পিরোজপুর', 'district', 'Pirojpur'], ['ঝালকাঠি', 'district', 'ঝালকাঠী', 'Jhalokathi'],
  // Sylhet division
  ['সিলেট', 'district', 'Sylhet'], ['মৌলভীবাজার', 'district', 'Moulvibazar'], ['হবিগঞ্জ', 'district', 'Habiganj'],
  ['সুনামগঞ্জ', 'district', 'Sunamganj'],
  // Rangpur division
  ['রংপুর', 'district', 'Rangpur'], ['দিনাজপুর', 'district', 'Dinajpur'], ['গাইবান্ধা', 'district', 'Gaibandha'],
  ['কুড়িগ্রাম', 'district', 'Kurigram'], ['লালমনিরহাট', 'district', 'Lalmonirhat'], ['নীলফামারী', 'district', 'Nilphamari'],
  ['পঞ্চগড়', 'district', 'Panchagarh'], ['ঠাকুরগাঁও', 'district', 'Thakurgaon'],
  // Mymensingh division
  ['ময়মনসিংহ', 'district', 'Mymensingh'], ['জামালপুর', 'district', 'Jamalpur'], ['নেত্রকোনা', 'district', 'নেত্রকোণা', 'Netrokona'],
  ['শেরপুর', 'district', 'Sherpur'],
];

// After a place name: end of text, a non-letter, or a Bengali case suffix.
const AFTER_OK = /^(?:$|[^ঀ-৿a-z]|র|এর|ের|ে|য়|তে|কে|বাসী|গামী|ও|সহ|দের)/u;
const BN_OR_LATIN = /[ঀ-৿a-z0-9]/u;

let cache = null;
function build() {
  if (cache) return cache;
  const entries = [];
  const seen = new Set();
  PLACES.forEach(([canonical, kind, ...variants]) => {
    [canonical, ...variants].forEach((v) => {
      const p = normalizeText(v);
      if (!p || seen.has(p)) return;
      seen.add(p);
      entries.push({ pattern: p, canonical, kind });
    });
  });
  const patterns = entries.map((e) => e.pattern);
  cache = { entries, patterns, automaton: buildAutomaton(patterns) };
  return cache;
}

/**
 * @returns {Array<{ name: string, kind: 'division'|'district', mentions: number }>} most-mentioned first
 */
function detectLocations(text = '') {
  const g = build();
  const t = normalizeText(text);
  const hits = searchAutomaton(g.automaton, g.patterns, t).filter((h) => {
    const before = h.start > 0 ? t[h.start - 1] : '';
    if (before && BN_OR_LATIN.test(before)) return false;
    return AFTER_OK.test(t.slice(h.end, h.end + 4));
  });
  const counts = new Map();
  selectLeftmostLongest(hits).forEach((h) => {
    const e = g.entries[h.idx];
    const cur = counts.get(e.canonical) || { name: e.canonical, kind: e.kind, mentions: 0, first: h.start };
    cur.mentions += 1;
    counts.set(e.canonical, cur);
  });
  return Array.from(counts.values())
    .sort((a, b) => (b.mentions - a.mentions) || (a.first - b.first))
    .map(({ name, kind, mentions }) => ({ name, kind, mentions }));
}

module.exports = { detectLocations, PLACE_COUNT: PLACES.length };
