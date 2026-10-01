/**
 * rtiApplicationDraft.js
 *
 * Formats an RTI request as the official Form "ক" (RTI Rules 2009, rule 3) — the exact
 * structure JAANI's own submitted sample follows (see
 * "frontend/pre_saved folder for email body/sample_RTIapplication to CPA- DP WORLD ,CTG -
 * submitted.txt"): প্রাপক / অনুলিপি → আবেদনকারীর তথ্য → কি ধরণের তথ্য (numbered) → প্রাপ্তির
 * পদ্ধতি → তথ্যগ্রহণকারী → সহায়তাকারী → তারিখ/স্বাক্ষর.
 *
 * Pure formatting only — the AI-generated question list is produced elsewhere
 * (rtiActGuidance.generateSuggestedQuestions) and passed in here already customized for the
 * specific news article; this module never calls an LLM itself.
 */

'use strict';

function esc(value) {
  return (value || '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function officeAddressLine(office = {}) {
  const parts = [office.Office, office.Division, office.Ministry]
    .map((v) => (v || '').toString().trim())
    .filter(Boolean);
  // Office/Division/Ministry are frequently the same string at higher rungs of the ladder
  // (see officeResolution.js) -- de-dupe consecutive repeats so the address line doesn't read
  // "কৃষি মন্ত্রণালয়, কৃষি মন্ত্রণালয়, কৃষি মন্ত্রণালয়".
  const deduped = parts.filter((p, i) => p !== parts[i - 1]);
  return deduped.join(', ');
}

function formatBengaliDate(date) {
  try {
    return new Intl.DateTimeFormat('bn-BD', { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * @param {object} office     resolved CSV row (Office, Division, Ministry, Website_Link,
 *                             Primary_Officer_Name/_Designation/_Email, Alternate_* for অনুলিপি)
 * @param {object} applicant  { name, fatherName, motherName, address, email, phone, citizenship }
 * @param {string[]} questions  already AI-generated, customized per article (item ২)
 * @param {Date} [sendDate]
 * @returns {{ bodyText: string, bodyHtml: string }}
 */
function buildFormKaDraft({ office = {}, applicant = {}, questions = [], sendDate = new Date() } = {}) {
  const dateStr = formatBengaliDate(sendDate);
  const citizenship = (applicant.citizenship || '').trim() || 'বাংলাদেশী';
  const numberedQuestions = (Array.isArray(questions) ? questions : [])
    .map((q) => (q || '').toString().trim())
    .filter(Boolean);
  const bnDigits = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
  const bnNum = (n) => String(n).split('').map((d) => bnDigits[Number(d)] ?? d).join('');

  const hasAlternate = Boolean((office.Alternate_Officer_Name || '').trim());
  const addressLine = officeAddressLine(office);

  const lines = [];
  lines.push("ফরম 'ক'");
  lines.push('');
  lines.push('তথ্য প্রাপ্তির আবেদনপত্র');
  lines.push('');
  lines.push('[তথ্য অধিকার (তথ্য প্রাপ্তি সংক্রান্ত) বিধিমালার বিধি ৩ দ্রষ্টব্য]');
  lines.push('');
  lines.push('বরাবর');
  if ((office.Primary_Officer_Name || '').trim()) lines.push(`জনাব ${office.Primary_Officer_Name.trim()}`);
  if ((office.Primary_Designation || '').trim()) lines.push(office.Primary_Designation.trim());
  if ((office.Primary_Email || '').trim()) lines.push(office.Primary_Email.trim());
  if (addressLine) lines.push(addressLine);
  lines.push('');
  if (hasAlternate) {
    lines.push('অনুলিপি:');
    lines.push(`জনাব ${office.Alternate_Officer_Name.trim()}`);
    if ((office.Alternate_Designation || '').trim()) lines.push(office.Alternate_Designation.trim());
    if ((office.Alternate_Email || '').trim()) lines.push(office.Alternate_Email.trim());
    if (addressLine) lines.push(addressLine);
    lines.push('');
  }
  if ((office.Website_Link || '').trim()) {
    lines.push(office.Website_Link.trim());
    lines.push('');
  }
  lines.push('');
  lines.push(`১. আবেদনকারীর নাম: ${applicant.name || '[আপনার নাম]'}`);
  lines.push(`        পিতার নাম: ${applicant.fatherName || '[পিতার নাম]'}`);
  lines.push(`        মাতার নাম: ${applicant.motherName || '[মাতার নাম]'}`);
  lines.push(`        বর্তমান ঠিকানা: ${applicant.address || '[আপনার ঠিকানা]'}`);
  lines.push(`        ইমেইল: ${applicant.email || '[আপনার ইমেইল]'}`);
  lines.push(`        ফোন: ${applicant.phone || '[আপনার ফোন নম্বর]'}`);
  lines.push(`        নাগরিকত্ব: ${citizenship}`);
  lines.push('');
  lines.push('২. কি ধরণের তথ্য');
  lines.push('');
  lines.push('');
  if (numberedQuestions.length) {
    numberedQuestions.forEach((q, i) => lines.push(`${bnNum(i + 1)}। ${q}`));
  } else {
    lines.push('[এখানে আপনি কোন নির্দিষ্ট তথ্য/নথির অনুলিপি চান তা লিখুন]');
  }
  lines.push('');
  lines.push('৩. কোন পদ্ধতিতে তথ্য পাইতে আগ্রহী:');
  lines.push('');
  lines.push('');
  lines.push(`আমি আমার ইমেইল এড্রেসে এই তথ্যগুলো পেতে আগ্রহী। ঠিকানাটি হল: ${applicant.email || '[আপনার ইমেইল]'}`);
  lines.push('');
  lines.push('৪. তথ্যগ্রহণকারীর নাম ও ঠিকানা:');
  lines.push(applicant.name || '[আপনার নাম]');
  lines.push(applicant.address || '[আপনার ঠিকানা]');
  lines.push('');
  lines.push('৫. প্রযোজ্য ক্ষেত্রে সহায়তাকারীর নাম ও ঠিকানা:');
  lines.push('প্রযোজ্য নয়।');
  lines.push('');
  lines.push('');
  lines.push(`আবেদনের তারিখ: ${dateStr}                                              আবেদনকারীর স্বাক্ষর`);

  const bodyText = lines.join('\n');
  const bodyHtml = `<div style="white-space:pre-wrap;font-family:'Noto Serif Bengali','Kalpurush',serif;">${esc(bodyText).replace(/\n/g, '<br/>')}</div>`;

  return { bodyText, bodyHtml };
}

module.exports = { buildFormKaDraft };
