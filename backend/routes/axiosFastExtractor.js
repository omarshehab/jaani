const axios = require('axios');
const https = require('https');
const iconv = require('iconv-lite');
const cheerio = require('cheerio');

const INSECURE_TLS_AGENT = new https.Agent({ rejectUnauthorized: false });
const DEFAULT_MAX_WORDS = parseInt(process.env.NEWS_EXTRACT_MAX_WORDS || '2500', 10);
const MIN_PARAGRAPH_LENGTH = 40;

function decodeHtmlFromResponse(response) {
  const raw = Buffer.from(response?.data || []);
  const contentType = (response?.headers?.['content-type'] || '').toLowerCase();
  const charsetMatch = contentType.match(/charset=([\w-]+)/i);
  const charset = (charsetMatch?.[1] || 'utf-8').toLowerCase();

  try {
    return iconv.decode(raw, charset);
  } catch {
    return iconv.decode(raw, 'utf-8');
  }
}

function normalizeWhitespace(text) {
  return (text || '').toString().replace(/\s+/g, ' ').trim();
}

function truncateToWords(text, maxWords = DEFAULT_MAX_WORDS) {
  const clean = normalizeWhitespace(text);
  if (!clean) return '';
  const words = clean.split(' ');
  if (words.length <= maxWords) return clean;
  return words.slice(0, maxWords).join(' ');
}

function toAbsoluteUrl(value, baseUrl) {
  const candidate = (value || '').toString().trim();
  if (!candidate || candidate.startsWith('data:')) return '';
  try {
    return candidate.startsWith('http') ? candidate : new URL(candidate, baseUrl).href;
  } catch {
    return '';
  }
}

function extractMediaFromHtml(html, baseUrl) {
  const $ = cheerio.load(html || '', { decodeEntities: false });
  const images = [];
  const imageDetails = [];
  const imageSeen = new Set();

  // Broad selector covers Prothom Alo (.story-element-image, figure), Daily Star, bdnews24, generic sites
  const IMG_SCOPE = [
    'article img', '.news-body img',
    '.story-element img', '.story-element-image img', '.story-content img',
    '.article-body img', '.article-content img', '.article img',
    'figure img', 'picture img',
    '[class*="story"] img', '[class*="article"] img',
    '[class*="image"] img', '[class*="photo"] img',
    '[itemprop="articleBody"] img',
    '[data-testid*="image"] img', '[data-testid*="story"] img',
    '.news-content img', '.post-content img', '.entry-content img',
    'main img',
  ].join(', ');

  $(IMG_SCOPE).each((_, el) => {
    let src = $(el).attr('src') || $(el).attr('data-src')
      || $(el).attr('data-lazy-src') || $(el).attr('data-original') || '';
    if (!src || src.startsWith('data:')) {
      const srcset = $(el).attr('srcset') || $(el).attr('data-srcset');
      if (srcset) {
        const parts = srcset.split(',').map((item) => item.trim().split(' ')[0]).filter(Boolean);
        src = parts[parts.length - 1] || '';
      }
    }
    if (!src || src.startsWith('data:')) {
      const $source = $(el).closest('picture').find('source').first();
      const srcset = $source.attr('srcset') || $source.attr('data-srcset');
      if (srcset) {
        const parts = srcset.split(',').map((item) => item.trim().split(' ')[0]).filter(Boolean);
        src = parts[parts.length - 1] || '';
      }
    }

    const resolvedSrc = toAbsoluteUrl(src, baseUrl);
    if (!resolvedSrc || imageSeen.has(resolvedSrc)) return;
    imageSeen.add(resolvedSrc);
    images.push(resolvedSrc);
    imageDetails.push({
      src: resolvedSrc,
      alt: normalizeWhitespace($(el).attr('alt') || $(el).attr('title') || 'Article image'),
    });
  });

  const externalVideos = [];
  const externalSeen = new Set();
  $('iframe').each((_, el) => {
    const src = toAbsoluteUrl($(el).attr('src'), baseUrl);
    if (!src) return;
    if (!/(youtube\.com|youtu\.be|vimeo\.com|facebook\.com\/plugins\/video)/i.test(src)) return;
    if (externalSeen.has(src)) return;
    externalSeen.add(src);
    externalVideos.push(src);
  });

  const selfHostedVideos = [];
  const selfHostedSeen = new Set();
  $('video, video source').each((_, el) => {
    const src = toAbsoluteUrl($(el).attr('src'), baseUrl);
    if (!src) return;
    if (!/\.(mp4|webm|m3u8)(\?|#|$)/i.test(src)) return;
    if (selfHostedSeen.has(src)) return;
    selfHostedSeen.add(src);
    selfHostedVideos.push(src);
  });

  return {
    media: {
      images,
      external_videos: externalVideos,
      self_hosted_videos: selfHostedVideos,
    },
    imageDetails,
  };
}

function stripUiElements($scope) {
  const removeSelectors = [
    'script',
    'style',
    'noscript',
    'svg',
    'form',
    'nav',
    'header',
    'footer',
    'aside',
    'iframe',
    'canvas',
  ];
  $scope.find(removeSelectors.join(',')).remove();

  const noisySelectors = [
    '.advert',
    '.advertisement',
    '.ad',
    '.promo',
    '.share',
    '.social',
    '.comment',
    '.newsletter',
    '.breadcrumb',
    '.related',
    '.recommended',
    '.nav',
    '.menu',
    '.sidebar',
    '[class*="share"]',
    '[class*="comment"]',
    '[class*="advert"]',
    '[class*="promo"]',
  ];
  $scope.find(noisySelectors.join(',')).remove();
}

function extractCleanArticleFromHtml(html) {
  const $ = cheerio.load(html || '', { decodeEntities: false });
  const scopes = ['article', '.news-body', '.article-body', '.story-content', 'main'];
  let $scope = null;

  for (const selector of scopes) {
    const candidate = $(selector).first();
    if (candidate.length && normalizeWhitespace(candidate.text()).length > 200) {
      $scope = candidate;
      break;
    }
  }

  if (!$scope) {
    $scope = $('body');
  }

  stripUiElements($scope);

  const paragraphs = [];
  $scope.find('p').each((_, el) => {
    const text = normalizeWhitespace($(el).text());
    if (text.length >= MIN_PARAGRAPH_LENGTH) {
      paragraphs.push(text);
    }
  });

  let text = paragraphs.length >= 2
    ? paragraphs.join('\n\n')
    : normalizeWhitespace($scope.text());

  text = truncateToWords(text.normalize('NFC'));

  return {
    text,
    html: ($scope.html() || '').trim(),
  };
}

/**
 * ULTRA-FAST extractor using HTTP request + Cheerio parsing.
 * Used as emergency fallback when everything else fails.
 */
async function extractWithAxiosOnly(url) {
  try {
    console.log('[Axios] fallback extraction');

    const parsedUrl = new URL(url);
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8',
        'Referer': `${parsedUrl.protocol}//${parsedUrl.hostname}/`,
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      httpsAgent: INSECURE_TLS_AGENT,
      responseType: 'arraybuffer',
      timeout: 45000,
      maxRedirects: 5,
      decompress: true,
    });

    const html = decodeHtmlFromResponse(response);

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
      || html.match(/property="og:title"\s+content="([^"]+)"/i)
      || html.match(/name="title"\s+content="([^"]+)"/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    const { media, imageDetails } = extractMediaFromHtml(html, url);
    const { text, html: cleanedHtml } = extractCleanArticleFromHtml(html);

    return {
      title,
      text,
      html: cleanedHtml,
      images: imageDetails,
      videos: [...media.external_videos, ...media.self_hosted_videos],
      media,
    };
  } catch (error) {
    console.error('[Axios] fallback extraction failed:', error.message);
    return null;
  }
}

// Used by /api/verify-contact (lazy require inside api.js) to read an office website's text.
async function extractTextFromUrl(url) {
  const result = await extractWithAxiosOnly(url);
  return result || { text: '' };
}

module.exports = {
  extractTextFromUrl,
  extractWithAxiosOnly,
  extractMediaFromHtml,
  truncateToWords,
  normalizeWhitespace,
};
