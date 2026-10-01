/**
 * highlightHTMLEntities.js
 * ─────────────────────────────────────────────────────────────────────────
 * DOM-aware entity highlighting for article HTML.
 *
 * Uses DOMParser + TreeWalker to visit ONLY text nodes, so HTML attributes
 * (e.g. src="...", href="...") are never touched by the regex.
 * Matching is whitespace-agnostic, so entities still match when the source
 * article contains doubled spaces or non-breaking spaces.
 *
 * Usage:
 *   import { highlightHTMLEntities } from '../utils/highlightHTMLEntities';
 *   const highlighted = highlightHTMLEntities(articleHtml, entities, keywords);
 *
 * @param {string}   htmlString  Raw article HTML string
 * @param {Array}    entities    Array of { text, label } objects from AI analysis.
 *                               label values recognised:
 *                               - GOV_ORG / ORG / MINISTRY / GOVERNMENT_ORGANIZATION → gov-org-highlight
 *                               - PERSON / OFFICER / GOV_PERSON / GOVERNMENT_PERSON  → officer-highlight
 *                               - anything else                                        → keyword-highlight
 * @param {string[]} keywords    Plain keyword strings (always → keyword-highlight)
 * @returns {string}             HTML string with <span> highlights injected in text nodes only
 */
// Colour scheme (keep in sync with frontend/src/index.css, AnalysisAccordion.js HIGHLIGHT_SX and
// backend/services/liveProxyReader.js READER_STYLE):
//   sentences → yellow · AI keywords → blue · gov orgs → light-blue background · officials → blue underline
const GOV_ORG_STYLES = 'background-color: #e3f2fd; color: #1565c0; font-weight: 600; border-radius: 3px; padding: 0 2px;';
const OFFICER_STYLES = 'text-decoration-line: underline; text-decoration-color: #1565c0; text-decoration-thickness: 3px; text-underline-offset: 4px; font-weight: 600;';
const KEYWORD_STYLES = 'background-color: #bbdefb; color: #0d47a1; border-radius: 2px; padding: 0 2px;';
// Whole important sentences (salience ensemble); keyword/entity spans nest inside them.
const SENTENCE_STYLES = 'background-color: #fff176; color: #212121; border-radius: 2px; padding: 0 1px;';

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DESIGNATION_QUALIFIERS = '(?:অতিরিক্ত|যুগ্ম|জ্যেষ্ঠ|সিনিয়র|সহকারী|ভারপ্রাপ্ত|বিশেষ|প্রধান|মহা)';
const DESIGNATION_WORD = '[\\u0980-\\u09FF]*(?:কমিশনার|সচিব|মন্ত্রী|উপদেষ্টা|মহাপরিচালক|পরিচালক|পরিদর্শক|কর্মকর্তা|আইজিপি|ডিআইজি|এসপি|ওসি|চেয়ারম্যান|মেয়র|রাষ্ট্রপতি|বিচারপতি|ম্যাজিস্ট্রেট|সুপার|প্রশাসক|মহাসচিব|অধ্যাপক|ডক্টর|ড\\.)';
const DESIGNATION_PREFIX = `(?:${DESIGNATION_QUALIFIERS}[\\s\\u00A0]+){0,2}${DESIGNATION_WORD}[\\s\\u00A0]+`;

function buildWhitespaceAgnosticRegex(value, withDesignation = false) {
  const normalized = (value || '').normalize('NFC').replace(/[\s\u00A0]+/g, ' ').trim();
  if (!normalized) return null;
  const pattern = normalized
    .split(' ')
    .map((part) => escapeRegex(part))
    .join('[\\s\\u00A0]+');
  // Trailing vowel signs/virama belong to the last letter, so never split them off ("অভিযান|ে").
  const full = `${pattern}[\\u09BC\\u09BE-\\u09CD\\u09D7]*`;
  return new RegExp(withDesignation ? `(?:${DESIGNATION_PREFIX})?${full}` : full, 'gi');
}

function getHighlightStyle(type) {
  if (type === 'important-sentence-highlight') return SENTENCE_STYLES;
  if (type === 'gov-org-highlight') return GOV_ORG_STYLES;
  if (type === 'officer-highlight') return OFFICER_STYLES;
  return KEYWORD_STYLES;
}

function buildHighlightItems(entities = [], keywords = []) {
  const highlights = [];

  for (const ent of (entities || [])) {
    const name = (ent.text || ent.name || '').trim();
    if (!name || name.length < 2) continue;
    const label = (ent.label || ent.type || '').toUpperCase();
    let cls;
    if (['GOV_ORG', 'ORG', 'MINISTRY', 'GOVERNMENT_ORGANIZATION'].includes(label)) {
      cls = 'gov-org-highlight';
    } else if (['PERSON', 'PER', 'OFFICER', 'GOV_PERSON', 'GOVERNMENT_PERSON'].includes(label)) {
      cls = 'officer-highlight';
    } else {
      cls = 'keyword-highlight';
    }
    highlights.push({ name, cls });
  }

  for (const kw of (keywords || [])) {
    const t = (kw || '').trim();
    if (t.length > 2) highlights.push({ name: t, cls: 'keyword-highlight' });
  }

  // Longest-first, deduplicate, and precompile whitespace-agnostic regexes.
  highlights.sort((a, b) => b.name.length - a.name.length);
  const seen = new Set();
  return highlights.filter(h => {
    const key = h.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((item) => ({
    ...item,
    regex: buildWhitespaceAgnosticRegex(item.name, item.cls === 'officer-highlight'),
  })).filter((item) => item.regex);
}

function buildSentenceItems(sentenceHighlights = []) {
  const seen = new Set();
  return (sentenceHighlights || [])
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter((t) => t.length >= 10 && !seen.has(t) && seen.add(t))
    .map((name) => ({ name, cls: 'important-sentence-highlight', regex: buildWhitespaceAgnosticRegex(name) }))
    .filter((item) => item.regex);
}

// One matching pass over the text nodes under `root` (earliest match wins, longest on ties).
function runHighlightPass(root, items, win) {
  if (!items.length) return 0;
  const doc = root.ownerDocument;
  const nodeCtor = win.Node;
  const filterCtor = win.NodeFilter;
  let inserted = 0;

  const skipNode = (node) => {
    const tag = (node?.nodeName || '').toLowerCase();
    return tag === 'script' || tag === 'style' || tag === 'a' || tag === 'textarea';
  };

  const tryHighlightTextNode = (textNode) => {
    if (!textNode || textNode.nodeType !== nodeCtor.TEXT_NODE || !textNode.parentNode) return false;
    const originalText = (textNode.textContent || '').normalize('NFC');
    if (originalText !== textNode.textContent) textNode.textContent = originalText;
    if (!originalText.trim()) return false;

    let best = null;
    for (const item of items) {
      item.regex.lastIndex = 0;
      const match = item.regex.exec(originalText);
      if (!match || !match[0]) continue;
      if (!best || match.index < best.match.index
        || (match.index === best.match.index && match[0].length > best.match[0].length)) {
        best = { item, match };
      }
    }
    if (!best) return false;

    const { item, match } = best;
    const matchText = match[0];
    const matchedNode = textNode.splitText(match.index);
    const tailNode = matchedNode.splitText(matchText.length);
    const span = doc.createElement('span');
    span.className = item.cls;
    span.setAttribute('style', getHighlightStyle(item.cls));
    span.textContent = matchedNode.textContent;
    matchedNode.parentNode.insertBefore(span, matchedNode);
    matchedNode.parentNode.removeChild(matchedNode);
    inserted += 1;
    if (tailNode && tailNode.parentNode) tryHighlightTextNode(tailNode);
    return true;
  };

  const walker = doc.createTreeWalker(root, filterCtor.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentNode;
      if (!parent || skipNode(parent)) return filterCtor.FILTER_REJECT;
      return (node.textContent || '').trim() ? filterCtor.FILTER_ACCEPT : filterCtor.FILTER_REJECT;
    },
  });

  const textNodes = [];
  let currentNode;
  while ((currentNode = walker.nextNode())) {
    textNodes.push(currentNode);
  }
  textNodes.forEach((node) => {
    tryHighlightTextNode(node);
  });

  return inserted;
}

/**
 * Highlight entities/keywords (and optionally whole important sentences) inside an existing
 * DOM tree, in place.
 * This is the single implementation of the matching logic: the frontend uses it through
 * highlightHTMLEntities(), and the backend Live Page reader (services/liveProxyReader.js)
 * loads this same file and runs it on a jsdom document. Keep this file free of imports so
 * the backend can load it as plain script.
 *
 * Pass order: sentences first, then entities/keywords. A sentence has to match inside a single
 * text node, which is only true before word-level spans split it; the word-level pass then
 * wraps text INSIDE the sentence span (nested, never the same text twice), so underlines and
 * keyword yellow stay visible within an important sentence.
 *
 * @param {Element} root      Subtree to highlight (only its text nodes are touched)
 * @param {Array}   entities  [{ text, label }]
 * @param {string[]} keywords
 * @param {Window}  win       Window that owns `root` (browser window, or a jsdom window)
 * @param {string[]} sentenceHighlights  Verbatim sentences from the salience ensemble
 * @returns {number}          Number of highlight spans inserted
 */
export function highlightDomTree(root, entities = [], keywords = [], win = (typeof window !== 'undefined' ? window : null), sentenceHighlights = []) {
  if (!root || !win) return 0;
  return runHighlightPass(root, buildSentenceItems(sentenceHighlights), win)
    + runHighlightPass(root, buildHighlightItems(entities, keywords), win);
}

export function highlightHTMLEntities(htmlString, entities = [], keywords = [], sentenceHighlights = []) {
  if (!htmlString) return '';

  const deduped = buildHighlightItems(entities, keywords);
  if (deduped.length === 0 && buildSentenceItems(sentenceHighlights).length === 0) return htmlString;

  // DOMParser path (browser only)
  if (typeof window !== 'undefined' && window.DOMParser) {
    try {
      const parser = new window.DOMParser();
      const doc = parser.parseFromString(`<div id="__hl_root">${htmlString}</div>`, 'text/html');
      const root = doc.getElementById('__hl_root');
      highlightDomTree(root, entities, keywords, window, sentenceHighlights);
      return root.innerHTML;
    } catch (_e) {
      // Fall through to regex fallback
    }
  }

  // Regex fallback (SSR / no DOMParser)
  // Only replaces text that sits between ">" and "<" (i.e. actual text content, not attributes)
  const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return htmlString.replace(/>([^<]*)</g, (full, text) => {
    if (!text.trim()) return full;
    let replaced = text;
    for (const item of deduped) {
      item.regex.lastIndex = 0;
      replaced = replaced.replace(item.regex, (match) => (
        `<span class="${item.cls}" style="${getHighlightStyle(item.cls)}">${escHtml(match)}</span>`
      ));
    }
    return `>${replaced}<`;
  });
}
