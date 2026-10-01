export const normalizeKeyword = (value) => {
  if (typeof value !== 'string') return '';
  return value
    .replace(/^\uFEFF/, '')
    .replace(/^"+|"+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

export const shouldUseWordBoundary = (keyword) => {
  const kw = normalizeKeyword(keyword);
  // Only apply \b when keyword is mostly plain English/ASCII with spaces/hyphens.
  // This avoids breaking phrases like: Coup d'état
  return /^[A-Za-z0-9][A-Za-z0-9\s-]*[A-Za-z0-9]$/.test(kw);
};

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const buildKeywordRegex = (keywords) => {
  const list = (keywords || [])
    .map(normalizeKeyword)
    .filter((kw) => kw.length > 2)
    .sort((a, b) => b.length - a.length);

  if (list.length === 0) return null;

  const parts = list.map((kw) => {
    const escaped = escapeRegex(kw);
    // Bengali keywords must start at a word boundary and may carry a short suffix (-কে, -ের ...),
    // so "কর" never lights up inside an unrelated word.
    return shouldUseWordBoundary(kw) ? `\\b${escaped}\\b` : `(?<![\\u0980-\\u09FF\\w])${escaped}[\\u0980-\\u09FF]{0,8}`;
  });

  return new RegExp(`(?:${parts.join('|')})`, 'gi');
};

export const findKeywordsInText = (text, keywords, maxFound = 200) => {
  const haystack = (text || '').toString();
  if (!haystack) return [];

  const normalized = (keywords || [])
    .map(normalizeKeyword)
    .filter((kw) => kw.length > 2)
    .sort((a, b) => b.length - a.length);

  if (normalized.length === 0) return [];

  const lower = haystack.toLowerCase();
  const found = [];

  for (const kw of normalized) {
    if (found.length >= maxFound) break;

    const kwLower = kw.toLowerCase();
    if (!lower.includes(kwLower)) continue;

    if (shouldUseWordBoundary(kw)) {
      // Confirm whole-word-ish match for English keywords.
      const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i');
      if (!re.test(haystack)) continue;
    }

    found.push(kw);
  }

  return found;
};
