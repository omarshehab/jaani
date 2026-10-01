/**
 * Article Processor Service
 * Handles: dual-layer sentence highlighting (Gemini-powered), image extraction,
 * and page structure preservation.
 *
 * Highlighting approach:
 *  Pass 1 — Light blue (#ADD8E6): HTML elements whose text contains a government entity term.
 *  Pass 2 — Yellow (#FFFF00): HTML elements that Gemini identified as key/important sentences.
 *            Never applied to elements already highlighted in light blue.
 */

'use strict';

const cheerio = require('cheerio');
const { callGeminiPrompt, safeJsonParse } = require('./geminiAnalysis');

// ── Ad / tracker domain blocklist for image filtering ────────────────────────
const AD_DOMAINS = [
  'doubleclick', 'googlesyndication', 'adservice', 'facebook.com/tr',
  'analytics', 'tracking', 'pixel', 'beacon', 'adtech', 'taboola',
  'outbrain', 'disqus', 'addthis', 'share-img', 'logo', 'icon',
  'favicon', 'banner', 'advertisement',
];

// ── Extract entity strings from enriched entities object ─────────────────────
function extractEntityStrings(entities) {
  const terms = new Set();

  if (!entities || typeof entities !== 'object') return terms;

  // Officers
  const officers = entities.officers || {};
  ['primary', 'alternate', 'appellate'].forEach((role) => {
    const o = officers[role] || {};
    if (o.name) terms.add(o.name);
    if (o.designation) terms.add(o.designation);
  });

  // Named officers array (some enriched formats)
  if (Array.isArray(entities.named_officers)) {
    entities.named_officers.forEach((o) => {
      if (o.name) terms.add(o.name);
      if (o.designation) terms.add(o.designation);
      if (o.office) terms.add(o.office);
    });
  }

  // Ministry, division, office, district
  if (entities.ministry) terms.add(entities.ministry);
  if (entities.division) terms.add(entities.division);
  if (entities.office) terms.add(entities.office);
  if (entities.district) terms.add(entities.district);

  // Nested entities
  if (Array.isArray(entities.entities)) {
    entities.entities.forEach((e) => {
      if (e.text) terms.add(e.text);
      if (e.name) terms.add(e.name);
    });
  }

  // Ministries list
  if (Array.isArray(entities.ministries)) {
    entities.ministries.forEach((m) => terms.add(m));
  }

  // Filter very short strings (single char etc)
  return new Set([...terms].filter((t) => t && t.trim().length > 2));
}

// ── Check if a sentence contains any entity term ─────────────────────────────
function sentenceContainsEntity(sentence, entityTerms) {
  const lower = sentence.toLowerCase();
  for (const term of entityTerms) {
    if (lower.includes(term.toLowerCase())) return true;
  }
  return false;
}

// ── Ask Gemini which element indices are the most important ───────────────────
/**
 * @param {Array<{index: number, text: string}>} elements - Numbered text snippets
 * @returns {Promise<Set<number>>} Set of element indices Gemini identified as key
 */
async function identifyKeySentences(elements) {
  if (!elements || elements.length === 0) return new Set();

  // Limit to first 80 elements to keep token count low
  const sample = elements.slice(0, 80);
  const listing = sample.map(({ index, text }) => `${index}: ${text.slice(0, 200)}`).join('\n');

  const prompt = `আপনি একজন অভিজ্ঞ বাংলা সংবাদ সম্পাদক এবং বিশ্লেষক। নিচের সংবাদের প্যারাগ্রাফগুলি বিশ্লেষণ করুন এবং সবচেয়ে গুরুত্বপূর্ণ ১০-১৫টি চিহ্নিত করুন।

গুরুত্বপূর্ণ প্যারাগ্রাফ হল যা অন্তর্ভুক্ত করে:
১) খবরের মূল ঘটনা
২) সরকারি সিদ্ধান্ত বা ঘোষণা
৩) আর্থিক বা বাজেট তথ্য
৪) প্রভাবশালী ব্যক্তিত্বের দাবি বা মন্তব্য
৫) আইন বা নিয়ম সম্পর্কিত তথ্য
৬) অভিযোগ বা অনুসন্ধান সম্পর্কিত তথ্য

প্যারাগ্রাফ তালিকা (নম্বর: বিষয়বস্তু):
${listing}

শুধুমাত্র JSON আউটপুট দিন:
{"important_indices": [0, 2, 5, ...]}`;

  try {
    const raw = await callGeminiPrompt(prompt, { maxRetries: 1, baseDelayMs: 500 });
    const parsed = safeJsonParse(raw);
    if (parsed && Array.isArray(parsed.important_indices)) {
      return new Set(parsed.important_indices.map((i) => Number(i)));
    }
    // Fallback: try regex extraction if safeJsonParse wrapped differently
    const match = (raw || '').match(/"important_indices"\s*:\s*\[([^\]]+)\]/);
    if (match) {
      const indices = match[1].split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
      return new Set(indices);
    }
  } catch (err) {
    console.warn('[articleProcessor] identifyKeySentences failed:', err.message);
  }
  return new Set();
}

/**
 * Apply dual-layer highlighting to article HTML (async — calls Gemini).
 *
 * Pass 1 — Light blue (#ADD8E6): elements whose text contains a government entity.
 * Pass 2 — Yellow (#FFFF00): elements Gemini identified as key (not already blue).
 *           Max 15 yellow elements.
 *
 * @param {string} articleHtml - Raw or cleaned article HTML
 * @param {Object} entities    - Enriched entity object from geminiAnalysis
 * @returns {Promise<string>}  - HTML with highlighted elements
 */
async function applyHighlighting(articleHtml, entities) {
  if (!articleHtml) return '';

  const entityTerms = extractEntityStrings(entities);
  const $ = cheerio.load(articleHtml, { decodeEntities: false });

  // Collect candidate elements with their text
  const candidates = [];
  $('p, h1, h2, h3, h4, li, blockquote, td').each((i, el) => {
    const text = $(el).text().trim();
    if (text.length > 10) {
      candidates.push({ index: i, el, text });
    }
  });

  // Ask Gemini which elements are important (for yellow highlighting)
  const importantIndices = await identifyKeySentences(candidates);

  let yellowCount = 0;
  const MAX_YELLOW = 15;

  for (const { index, el, text } of candidates) {
    const $el = $(el);
    const needsBlue = entityTerms.size > 0 && sentenceContainsEntity(text, entityTerms);

    if (needsBlue) {
      $el.attr('style', 'background-color: #ADD8E6; border-left: 3px solid #4AADE8; padding-left: 6px; border-radius: 2px;');
      $el.attr('data-highlight', 'entity');
    } else if (importantIndices.has(index) && yellowCount < MAX_YELLOW) {
      $el.attr('style', 'background-color: #FFFF00; border-left: 3px solid #FFD700; padding-left: 6px; border-radius: 2px;');
      $el.attr('data-highlight', 'trigger');
      yellowCount++;
    }
  }

  return $.html();
}

/**
 * Extract images from article HTML with captions.
 * Excludes: ads, logos, trackers, images < 200px, videos
 * @param {string} articleHtml
 * @param {string} baseURL
 * @returns {Array<{src, caption, alt, width, height}>}
 */
function extractImages(articleHtml, baseURL) {
  if (!articleHtml) return [];

  const $ = cheerio.load(articleHtml, { decodeEntities: false });
  const results = [];
  const seen = new Set();

  const IMG_SELECTORS = [
    'article img', 'figure img', '.news-body img', '.article-body img',
    '.story-content img', '[itemprop="articleBody"] img', 'main img',
    '.article img', '.story img', '.content img',
  ].join(', ');

  $(IMG_SELECTORS).each((_, el) => {
    if (results.length >= 5) return false; // max 5

    const $el = $(el);
    // Resolve src (try data-src fallbacks)
    let src = $el.attr('src') || $el.attr('data-src')
      || $el.attr('data-lazy-src') || $el.attr('data-original') || '';

    // Try srcset as fallback
    if (!src || src.startsWith('data:')) {
      const srcset = $el.attr('srcset') || $el.attr('data-srcset') || '';
      if (srcset) {
        const parts = srcset.split(',').map((s) => s.trim().split(' ')[0]).filter(Boolean);
        src = parts[parts.length - 1] || '';
      }
    }

    if (!src || src.startsWith('data:')) return;

    // Resolve to absolute URL
    try {
      if (!src.startsWith('http')) {
        src = new URL(src, baseURL).href;
      }
    } catch { return; }

    if (seen.has(src)) return;
    seen.add(src);

    // Filter ads / trackers / logos
    const srcLower = src.toLowerCase();
    if (AD_DOMAINS.some((d) => srcLower.includes(d))) return;

    // Filter small images
    const width  = parseInt($el.attr('width')  || $el.attr('data-width')  || '0', 10);
    const height = parseInt($el.attr('height') || $el.attr('data-height') || '0', 10);
    if (width > 0 && width < 200) return;
    if (height > 0 && height < 100) return;

    // Filter video thumbnails
    if (/youtube|vimeo|dailymotion|video/i.test(src)) return;

    // Extract caption
    const $figure = $el.closest('figure');
    let caption = '';
    if ($figure.length) {
      caption = $figure.find('figcaption').first().text().trim()
        || $figure.find('[class*="caption"]').first().text().trim();
    }
    if (!caption) {
      caption = $el.attr('alt') || $el.attr('title') || '';
      // Use alt only if descriptive (> 10 chars)
      if (caption.length < 10) {
        // Check adjacent p/span for caption-like text
        const $next = $el.closest('div').next('p, span, div').first();
        if ($next.length && $next.text().trim().length < 200) {
          caption = $next.text().trim();
        }
      }
    }

    results.push({
      src,
      caption: caption || 'ছবির বিবরণ পাওয়া যায়নি',
      alt: $el.attr('alt') || '',
      width: width || null,
      height: height || null,
    });
  });

  return results;
}

/**
 * Preserve hierarchical page structure as JSON.
 * @param {string} articleHtml
 * @returns {{ title, subtitle, content: Array }}
 */
function preservePageStructure(articleHtml) {
  if (!articleHtml) return { title: '', subtitle: '', content: [] };

  const $ = cheerio.load(articleHtml, { decodeEntities: false });

  // Remove noise
  $('script, style, noscript, nav, header, footer, aside, [class*="ad"], [class*="promo"], [class*="share"], [class*="social"], [class*="comment"], [class*="sidebar"]').remove();

  const title    = $('h1').first().text().trim() || $('title').text().trim() || '';
  const subtitle = $('h2').first().text().trim() || $('[class*="subtitle"]').first().text().trim() || '';

  const content = [];

  // Walk article body
  const $body = $('article, main, .article-body, .story-content, .news-body').first();
  const $scope = $body.length ? $body : $('body');

  $scope.children().each((_, el) => {
    const tag = el.tagName?.toLowerCase();
    const $el = $(el);
    const text = $el.text().trim();

    if (!text && !['img', 'figure'].includes(tag)) return;

    if (/^h[1-6]$/.test(tag)) {
      content.push({
        type: 'heading',
        level: parseInt(tag[1], 10),
        text,
      });
    } else if (tag === 'p') {
      if (text.length > 10) {
        content.push({
          type: 'paragraph',
          text,
          // Inline formatting
          bold: $el.find('strong, b').map((_, e) => $(e).text()).get(),
          italic: $el.find('em, i').map((_, e) => $(e).text()).get(),
        });
      }
    } else if (tag === 'ul' || tag === 'ol') {
      const items = $el.find('li').map((_, li) => $(li).text().trim()).get();
      if (items.length) {
        content.push({
          type: 'list',
          ordered: tag === 'ol',
          items,
        });
      }
    } else if (tag === 'blockquote') {
      content.push({
        type: 'quote',
        text,
        cite: $el.attr('cite') || '',
      });
    } else if (tag === 'figure' || tag === 'img') {
      const src = $el.is('img') ? $el.attr('src') : $el.find('img').first().attr('src') || '';
      const caption = $el.find('figcaption').text().trim() || $el.find('img').attr('alt') || '';
      if (src) {
        content.push({
          type: 'image',
          src,
          caption,
        });
      }
    }
  });

  return { title, subtitle, content };
}

module.exports = { applyHighlighting, extractImages, preservePageStructure, extractEntityStrings };
