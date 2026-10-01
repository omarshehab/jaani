const { chromium } = require('playwright');
const cheerio = require('cheerio');

// Ad / non-article image filters. Whole-word and path-segment tests only — a plain
// substring test on 'ad' rejected real photos ("upload", "Bangladesh", "head", "read"…).
const AD_TOKEN_RE = /\b(ad|ads|advert|advertisement|sponsor(?:ed)?|promo(?:tion)?)\b/i;
const AD_PATH_RE = /\/(ads?|banner|doubleclick|googlesyndication|adservice|taboola|outbrain)\//i;
const NON_ARTICLE_IMAGE_RE = /\b(logo|icon|avatar|social|share|sprite|pixel|tracking)\b/i;

function isNonArticleImage(src = '', alt = '', className = '') {
  return AD_TOKEN_RE.test(alt) || AD_TOKEN_RE.test(className) || AD_PATH_RE.test(src)
    || NON_ARTICLE_IMAGE_RE.test(alt) || NON_ARTICLE_IMAGE_RE.test(className);
}


/**
 * Extract news content with Playwright (handles JavaScript-rendered sites)
 * This provides superior extraction compared to Cheerio for dynamic content
 */
async function extractWithPlaywright(url, options = {}) {
  let browser;
  const MAX_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  try {
    console.log(`🚀 [Playwright] Launching browser for: ${url}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
    browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-http2', '--disable-blink-features=AutomationControlled']
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US,en;q=0.9,bn;q=0.8',
      viewport: { width: 1920, height: 1080 },
      javaScriptEnabled: true,
      bypassCSP: true,
    });
    
    const page = await context.newPage();
    
    // Block only truly non-essential heavy assets.
    // Some publishers hydrate article figures from the final rendered DOM, so keep
    // stylesheets and images available for faithful replica extraction.
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['font', 'media'].includes(type)) {
        route.abort();
        return;
      }
      route.continue();
    });
    
    // Navigate with timeout (try domcontentloaded first, fallback networkidle)
    let navOk = false;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      navOk = true;
    } catch (navErr) {
      console.warn(`⚠️ [Playwright] domcontentloaded failed: ${navErr.message}`);
      try {
        await page.goto(url, { waitUntil: 'commit', timeout: 15000 });
        navOk = true;
      } catch (navErr2) {
        console.error(`❌ [Playwright] Navigation failed completely: ${navErr2.message}`);
      }
    }
    if (!navOk) throw new Error('Navigation failed');
    
    // Base wait for dynamic content
    await page.waitForTimeout(2000);

    // For SPA / JS-heavy sites, wait for body to have meaningful text
    try {
      await page.waitForFunction(
        () => (document.body?.innerText || '').length > 200,
        { timeout: 8000 }
      );
    } catch {
      // Proceed anyway — some sites render slowly
    }
    
    // Detect site type for specialized handling
    const detectedSiteType = await page.evaluate(() => {
      const hostname = window.location.hostname;
      if (hostname.includes('prothomalo') || hostname.includes('prothom-alo')) return 'prothomalo';
      if (hostname.includes('bbc')) return 'bbc';
      if (hostname.includes('bdnews24')) return 'bdnews24';
      if (hostname.includes('dailystar')) return 'dailystar';
      if (hostname.includes('kalerkantho')) return 'kalerkantho';
      if (hostname.includes('jugantor')) return 'jugantor';
      return 'generic';
    });

    const siteType = (options && options.siteType) ? options.siteType : detectedSiteType;
    
    console.log(`📰 [Playwright] Detected site type: ${siteType}`);
    
    // Scroll to trigger lazy-loading images (Prothom Alo uses lazy loading)
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 500;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    });
    
    // Wait for lazy images to load after scroll
    await page.waitForTimeout(1500);
    
    // For Prothom Alo: Force load all lazy images
    if (siteType === 'prothomalo') {
      await page.evaluate(() => {
        // Prothom Alo specific: Convert data-src to src for lazy images
        document.querySelectorAll('img[data-src], img[data-lazy-src], .story-element-image img').forEach(img => {
          const dataSrc = img.getAttribute('data-src') || 
                          img.getAttribute('data-lazy-src') ||
                          img.getAttribute('data-original');
          if (dataSrc && (!img.src || img.src.includes('data:') || img.src.includes('placeholder'))) {
            img.src = dataSrc;
          }
        });
        
        // Also check picture elements
        document.querySelectorAll('picture source[data-srcset]').forEach(source => {
          const dataSrcset = source.getAttribute('data-srcset');
          if (dataSrcset) {
            source.setAttribute('srcset', dataSrcset);
          }
        });
      });
      await page.waitForTimeout(500);
    }
    
    // Capture CSS resources + root attributes for "replica" rendering (before we remove clutter)
    const styleBundle = await page.evaluate(() => {
      const hrefs = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'))
        .map((l) => l.href)
        .filter(Boolean);
      const inline = Array.from(document.querySelectorAll('style'))
        .map((s) => (s.textContent || '').toString())
        .filter((t) => t.trim().length > 0);

      const pickAttrs = (el) => {
        if (!el || !el.attributes) return {};
        const out = {};
        for (const attr of Array.from(el.attributes)) {
          const name = (attr?.name || '').toLowerCase();
          if (!name) continue;
          if (name === 'class' || name === 'lang' || name === 'dir') {
            out[name] = attr.value;
            continue;
          }
          if (name.startsWith('data-')) {
            out[name] = attr.value;
          }
        }
        return out;
      };

      const htmlEl = document.documentElement;
      const bodyEl = document.body;

      // De-dupe and cap to keep payload reasonable
      const uniqHrefs = Array.from(new Set(hrefs)).slice(0, 12);
      const inlineJoined = inline.join('\n\n');
      const inlineCapped = inlineJoined.length > 120000 ? inlineJoined.slice(0, 120000) : inlineJoined;
      return {
        stylesheets: uniqHrefs,
        inlineCss: inlineCapped,
        htmlAttrs: pickAttrs(htmlEl),
        bodyAttrs: pickAttrs(bodyEl),
      };
    });

    // Remove clutter BEFORE extraction
    await page.evaluate(() => {
      const removeSelectors = [
        'nav', 'footer', 'aside', '.sidebar', '.header-top',
        '.ad', '.advertisement', '.ads', '[class*="ad-"]', '[id*="ad-"]',
        '.social-share', '.share-buttons', '.share-this',
        '.related-articles', '.related-posts', '.recommended', '.trending',
        '.comments', '.comment-section', '.comment-list',
        '.newsletter', '.subscription', '.signup-box',
        '.breaking-news:not([class*="article"])', '.live-updates:not([class*="article"])',
        'script', 'noscript',
        /* OLD: Removing style tags breaks replica rendering (commented out)
        'style:not([data-styled])',
        */
        'iframe:not([src*="youtube"]):not([src*="vimeo"]):not([src*="dailymotion"])'
      ];
      
      removeSelectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => el.remove());
      });
    });
    
    // Extract all data in browser context
    const articleData = await page.evaluate((siteType) => {
      // Find main article container (try multiple strategies)
      const containerSelectors = [
        // Site-specific first
        ...(siteType === 'kalerkantho'
          ? [
              '.details',
              '.details-content',
              '.news-details',
              '.newsDetails',
              '.post-details',
              '.single-post',
              '.main-content .details',
              '.main-content',
              '#content',
            ]
          : []),
        ...(siteType === 'prothomalo'
          ? [
              '.story-content',
              '[data-testid="story"]',
              '[data-testid="story-body"]',
              '.story-element',
            ]
          : []),

        'article[role="article"]',
        'article.article',
        'article.post',
        '.article-content',
        '.story-content',
        '.post-content',
        '[itemprop="articleBody"]',
        '.entry-content',
        '.article-body',
        '.story-body',
        'main article',
        '#article-content',
        '#main-content article',
        'article',
        'main',
        '[role="main"]'
      ];
      
      let container = null;
      for (const selector of containerSelectors) {
        const el = document.querySelector(selector);
        if (el && el.innerText.trim().length > 50) {
          container = el;
          console.log(`Found container: ${selector}`);
          break;
        }
      }
      
      if (!container) {
        console.warn('No article container found, using body');
        container = document.body;
      } else {
        // Some CMSes (kalerkantho.com among them) wrap EACH PARAGRAPH of the article body in
        // its own same-class element instead of one shared container -- querySelector() above
        // only ever found the first paragraph. If the matched container has sibling elements of
        // the same tag under the SAME parent, they are this article's own remaining paragraphs
        // (a different, unrelated "other articles" block on the page lives under a different
        // parent node, even when Next.js/CSS-module class names happen to collide) -- merge them.
        const sameTagSiblings = Array.from(container.parentElement?.children || [])
          .filter((el) => el.tagName === container.tagName);
        if (sameTagSiblings.length > 1) {
          const merged = document.createElement('div');
          sameTagSiblings.forEach((el) => merged.appendChild(el.cloneNode(true)));
          if (merged.innerText.trim().length > container.innerText.trim().length) {
            container = merged;
            console.log(`Merged ${sameTagSiblings.length} same-parent ${container.tagName.toLowerCase()} siblings into container`);
          }
        }
      }

      // Extract title (multiple strategies)
      const titleSelectors = [
        'h1[class*="title"]',
        'h1[class*="headline"]',
        '.article-title',
        '.article-header h1',
        '.post-title',
        '[itemprop="headline"]',
        'article h1',
        'main h1',
        'h1'
      ];
      
      let title = '';
      for (const sel of titleSelectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim().length > 5) {
          title = el.innerText.trim();
          break;
        }
      }
      
      if (!title) {
        title = document.querySelector('meta[property="og:title"]')?.content || 
                document.title || 
                '';
      }

      // Extract author
      let author = '';
      const authorSelectors = [
        '[itemprop="author"] [itemprop="name"]',
        '[itemprop="author"]',
        '[class*="author"] [class*="name"]',
        '[class*="byline"] [class*="name"]',
        '[class*="author-name"]',
        '[class*="byline-name"]',
        '[data-testid*="author"]',
        '[class*="reporter"]',
        '[class*="writer"]',
        '.author a', '.byline a',
        '.author', '.byline',
      ];
      for (const sel of authorSelectors) {
        const el = document.querySelector(sel);
        const t = el ? (el.innerText || el.textContent || '').trim() : '';
        if (t && t.length > 1 && t.length < 120) { author = t; break; }
      }
      if (!author) {
        author = document.querySelector('meta[name="author"]')?.content ||
                 document.querySelector('meta[property="article:author"]')?.content || '';
      }

      // Extract publication date
      let publicationDate = '';
      const dateEl = document.querySelector(
        'time[datetime], [itemprop="datePublished"], [class*="publish"][class*="date"], ' +
        '[class*="pub-date"], [data-testid*="date"], [class*="article-date"], ' +
        '[class*="story-date"], [class*="post-date"]'
      );
      if (dateEl) {
        publicationDate = dateEl.getAttribute('datetime') ||
                          dateEl.getAttribute('content') ||
                          (dateEl.innerText || '').trim();
      }
      if (!publicationDate) {
        publicationDate = document.querySelector('meta[property="article:published_time"]')?.content ||
                          document.querySelector('meta[name="pubdate"]')?.content || '';
      }

      const readText = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
      const getImageCaption = (img) => {
        const candidates = [];
        const addCandidate = (el) => {
          const text = readText(el);
          if (text && text.length <= 300) candidates.push(text);
        };

        const nearbyCaptionSelector = 'figcaption, [class*="caption"], [data-testid*="caption"]';
        const figure = img.closest('figure');
        addCandidate(figure?.querySelector('figcaption'));

        const nearbyRoots = [
          figure,
          img.closest('picture'),
          img.closest('.story-card-image'),
          img.closest('.story-element-image'),
          img.parentElement,
        ].filter(Boolean);

        nearbyRoots.forEach((root) => {
          addCandidate(root?.querySelector?.(nearbyCaptionSelector));
          addCandidate(root?.nextElementSibling?.matches?.(nearbyCaptionSelector)
            ? root.nextElementSibling
            : root?.nextElementSibling?.querySelector?.(nearbyCaptionSelector));
          addCandidate(root?.parentElement?.querySelector?.(nearbyCaptionSelector));
          addCandidate(root?.parentElement?.nextElementSibling?.matches?.(nearbyCaptionSelector)
            ? root.parentElement.nextElementSibling
            : root?.parentElement?.nextElementSibling?.querySelector?.(nearbyCaptionSelector));
        });

        return candidates
          .map((text) => text.trim())
          .filter(Boolean)
          .sort((a, b) => b.length - a.length)[0] || '';
      };
      
      // Extract ALL images (article only, no logos/ads)
      const images = [];
      
      // PROTHOM ALO SPECIFIC: First, extract main story image
      const mainImageSelectors = [
        '.story-element-image img',           // Prothom Alo main story image
        '.story-element-image-wrapper img',   // Alternative wrapper
        'div.story-element img',              // Generic story element
        '.featured-image img',                // Featured image class
        '[data-testid="story-element-image"] img',
        '.article-hero-image img',
        '.hero-image img',
        'figure.main-image img',
        '.lead-media img',
        '.article-featured-image img',
        'picture.main-image img'
      ];
      
      let mainImage = null;
      for (const selector of mainImageSelectors) {
        const img = document.querySelector(selector);
        if (img) {
          // Get src from various attributes (handle lazy loading)
          let src = img.src || 
                    img.getAttribute('data-src') || 
                    img.getAttribute('data-lazy-src') ||
                    img.getAttribute('data-original');
          
          // Check srcset for high-res version
          if (!src || src.includes('data:') || src.includes('placeholder')) {
            const srcset = img.srcset || img.getAttribute('data-srcset');
            if (srcset) {
              const sources = srcset.split(',').map(s => s.trim().split(' ')[0]);
              src = sources[sources.length - 1]; // Get largest
            }
          }
          
          // Check parent picture element
          if (!src || src.includes('data:')) {
            const picture = img.closest('picture');
            if (picture) {
              const source = picture.querySelector('source[srcset], source[data-srcset]');
              if (source) {
                const srcset = source.srcset || source.getAttribute('data-srcset');
                const sources = srcset?.split(',').map(s => s.trim().split(' ')[0]);
                src = sources?.[sources.length - 1] || source.src;
              }
            }
          }
          
          if (src && !src.includes('data:') && !src.includes('placeholder')) {
            const caption = getImageCaption(img);
            try {
              mainImage = {
                src: new URL(src, window.location.href).href,
                alt: img.alt || img.title || 'Main Story Image',
                caption,
                width: img.naturalWidth || img.width,
                height: img.naturalHeight || img.height,
                isMainImage: true
              };
              break;
            } catch (e) {}
          }
        }
      }
      
      // Add main image first if found
      if (mainImage) {
        images.push(mainImage);
      }
      
      // Now extract other images
      const imgElements = container.querySelectorAll('img');
      
      imgElements.forEach(img => {
        // Check multiple sources (Prothom Alo uses srcset and data-srcset)
        let src = img.src || img.dataset.src || img.dataset.lazySrc || img.dataset.original || img.dataset.lazy;
        
        // Check srcset attribute (common in modern sites like Prothom Alo)
        if (!src || src.startsWith('data:')) {
          const srcset = img.srcset || img.dataset.srcset;
          if (srcset) {
            // Extract the largest image from srcset
            const srcsetUrls = srcset.split(',').map(s => s.trim().split(' ')[0]);
            src = srcsetUrls[srcsetUrls.length - 1]; // Get last (usually largest) image
          }
        }
        
        // Check picture parent element
        if (!src || src.startsWith('data:')) {
          const picture = img.closest('picture');
          if (picture) {
            const source = picture.querySelector('source');
            if (source) {
              src = source.srcset?.split(',')[0]?.trim()?.split(' ')[0] || source.src;
            }
          }
        }
        
        // Ensure absolute URL
        if (src && !src.startsWith('data:')) {
          try {
            src = new URL(src, window.location.href).href;
          } catch (e) {
            // Invalid URL, skip this image
            return;
          }
        }
        
        if (!src || src.startsWith('data:')) return;
        
        const alt = img.alt || img.title || '';
        const caption = getImageCaption(img);
        const className = img.className || '';
        
        // Skip ads and site chrome. Whole-word / path-segment tests only: a plain substring
        // test on 'ad' dropped real photos whose URL or alt contained "upload", "Bangladesh",
        // "head", "read"… (Runs inside page.evaluate, so the regexes are defined here, not
        // at module scope — keep in sync with AD_TOKEN_RE / AD_PATH_RE / NON_ARTICLE_IMAGE_RE.)
        const AD_TOKEN_RE = /\b(ad|ads|advert|advertisement|sponsor(?:ed)?|promo(?:tion)?)\b/i;
        const AD_PATH_RE = /\/(ads?|banner|doubleclick|googlesyndication|adservice|taboola|outbrain)\//i;
        const NON_ARTICLE_IMAGE_RE = /\b(logo|icon|avatar|social|share|sprite|pixel|tracking)\b/i;
        const shouldSkip = AD_TOKEN_RE.test(alt) || AD_TOKEN_RE.test(className) || AD_PATH_RE.test(src)
          || NON_ARTICLE_IMAGE_RE.test(alt) || NON_ARTICLE_IMAGE_RE.test(className);
        
        // Skip tiny images
        const isTiny = img.naturalWidth > 0 && img.naturalWidth < 150;
        
        if (!shouldSkip && !isTiny) {
          // Ensure the URL is absolute and properly formatted
          let finalSrc = src;
          try {
            if (!src.startsWith('http')) {
              finalSrc = new URL(src, window.location.href).href;
            }
          } catch (e) {
            // Skip invalid URLs
            return;
          }
          
          // Skip if we already have this as main image
          if (mainImage && finalSrc === mainImage.src) {
            return;
          }
          
          images.push({
            src: finalSrc,
            alt: alt || 'News Image',
            caption,
            width: img.naturalWidth || img.width,
            height: img.naturalHeight || img.height,
            isMainImage: false
          });
        }
      });
      
      // Extract paragraphs (only article content, NOT related links)
      const paragraphs = [];
      const pElements = container.querySelectorAll('p');
      
      pElements.forEach(p => {
        // Skip if inside a link to another article or related content
        const isInsideLink = p.closest('a[href*="/news/"], a[href*="/article/"], a[href*="/story/"], .related, .recommended, .other-news, .more-stories');
        if (isInsideLink) return;
        
        const text = p.innerText.trim();
        if (text.length > 30) { // Only meaningful paragraphs
          paragraphs.push(text);
        }
      });

      // Fallback: if no <p>-based text found (SPA sites, non-standard markup)
      if (paragraphs.length === 0) {
        // Try extracting from divs that look like text blocks
        container.querySelectorAll('div, span, section').forEach(el => {
          if (el.children.length === 0 || (el.children.length <= 2 && el.innerText.length > 80)) {
            const t = el.innerText.trim();
            if (t.length > 60 && !paragraphs.some(p => p.includes(t))) {
              paragraphs.push(t);
            }
          }
        });
      }
      // Ultimate fallback: container full text
      if (paragraphs.length === 0 && container.innerText.trim().length > 50) {
        paragraphs.push(container.innerText.trim());
      }
      
      // Extract videos and embeds (including Facebook videos for Prothom Alo)
      const videos = [];
      const videoSelectors = [
        'iframe[src*="youtube"]',
        'iframe[src*="youtu.be"]',
        'iframe[src*="vimeo"]',
        'iframe[src*="dailymotion"]',
        'iframe[src*="facebook.com/plugins/video"]',
        'iframe[src*="fb.watch"]',
        'video',
        '[data-video-url]',
        '.video-player',
        '.fb-video'
      ];
      
      container.querySelectorAll(videoSelectors.join(', ')).forEach(v => {
        let src = v.src || v.dataset.src || v.dataset.videoUrl;
        
        // For video tags, check source elements
        if (!src && v.tagName === 'VIDEO') {
          const source = v.querySelector('source');
          src = source ? (source.src || source.dataset.src) : null;
        }
        
        // Check for data attributes
        if (!src) {
          src = v.getAttribute('data-video-src') || v.getAttribute('data-embed-url');
        }
        
        if (src) {
          const fullUrl = src.startsWith('http') ? src : new URL(src, window.location.href).href;
          if (!videos.includes(fullUrl)) {
            videos.push(fullUrl);
          }
        }
      });
      
      // Get clean HTML (remove any remaining unwanted elements)
      const cleanContainer = container.cloneNode(true);
      cleanContainer.querySelectorAll('a[href*="/news/"]:not(:has(img)), a[href*="/article/"]:not(:has(img)), .related, .recommended').forEach(el => el.remove());
      
      return {
        title,
        author,
        publicationDate,
        text: paragraphs.join('\n\n'),
        html: cleanContainer.innerHTML,
        images: images.slice(0, 20), // Max 20 images
        videos: videos.slice(0, 5), // Max 5 videos
        paragraphCount: paragraphs.length
      };
    }, siteType);
    
    // Fallback: if no images extracted from page.evaluate (common when image resources
    // are blocked and Next.js lazy-loads src via JS), parse the rendered HTML with Cheerio.
    if (articleData.images.length === 0) {
      try {
        const renderedHtml = await page.content();
        const $c = cheerio.load(renderedHtml);
        const IMG_SCOPE = [
          '.story-element-image img', '.story-element img', '.story-content img',
          'article img', 'figure img', 'picture img',
          '[class*="story"] img', '[class*="article"] img', '[class*="image"] img',
          '[itemprop="articleBody"] img', 'main img', '.post-content img',
          '.entry-content img', '.news-content img', '.article-body img',
        ];
        const seenSrcs = new Set();
        for (const sel of IMG_SCOPE) {
          $c(sel).each((_, el) => {
            const $el = $c(el);
            const raw = $el.attr('src') || $el.attr('data-src') || $el.attr('data-lazy-src') || $el.attr('data-original');
            const rawSrcset = $el.attr('srcset') || $el.attr('data-srcset');
            let src = raw;
            if (!src || src.startsWith('data:')) {
              if (rawSrcset) {
                src = rawSrcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(s => s && !s.startsWith('data:')).pop();
              }
            }
            if (!src || src.startsWith('data:') || seenSrcs.has(src)) return;
            try {
              const abs = new URL(src, url).href;
              const alt = $el.attr('alt') || '';
              const cls = ($el.attr('class') || '').toLowerCase();
              if (isNonArticleImage(abs, alt, cls)) return;
              seenSrcs.add(src);
              articleData.images.push({ src: abs, alt: alt || 'News Image', isMainImage: articleData.images.length === 0 });
            } catch {}
          });
          if (articleData.images.length >= 15) break;
        }
        if (articleData.images.length > 0) {
          console.log(`   🔄 Cheerio fallback found ${articleData.images.length} images`);
        }
      } catch (fallbackErr) {
        console.warn(`   ⚠️ Cheerio image fallback failed: ${fallbackErr.message}`);
      }
    }

    await browser.close();
    
    console.log(`✅ [Playwright] Extracted successfully:`);
    console.log(`   📝 Title: ${articleData.title?.substring(0, 60)}...`);
    console.log(`   📄 Paragraphs: ${articleData.paragraphCount}`);
    console.log(`   🖼️  Images: ${articleData.images.length}`);
    console.log(`   🎥 Videos: ${articleData.videos.length}`);
    
    return {
      ...articleData,
      stylesheets: styleBundle?.stylesheets || [],
      inlineCss: styleBundle?.inlineCss || '',
      replicaMeta: {
        htmlAttrs: styleBundle?.htmlAttrs || {},
        bodyAttrs: styleBundle?.bodyAttrs || {},
      },
    };
    
  } catch (error) {
    console.error(`❌ [Playwright] Extraction attempt ${attempt} failed:`, error.message);
    if (browser) { try { await browser.close(); } catch {} browser = null; }
    if (attempt < MAX_RETRIES) {
      console.log(`🔄 [Playwright] Retrying in 1s...`);
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    
    return {
      title: '',
      text: '',
      html: '',
      images: [],
      videos: [],
      paragraphCount: 0,
      stylesheets: [],
      inlineCss: '',
      replicaMeta: { htmlAttrs: {}, bodyAttrs: {} },
    };
  }
  } // end for-loop
}


module.exports = {
  isNonArticleImage,
  extractWithPlaywright,
};
