/**
 * ✅ Axios Configuration
 * 
 * Centralized axios instance for all API calls to JAANI Backend
 * Base URL: proxied via CRA `proxy` (frontend/package.json) → http://localhost:5005
 * 
 * Usage:
 * import apiClient from './axiosConfig';
 * const response = await apiClient.post('/api/analyze', {url: 'https://...'});
 */

import axios from 'axios';

/**
 * Simple API base URL - uses CRA proxy for local development
 * Proxy configured in frontend/package.json forwards /api/* to http://localhost:5005
 */
const normalizeBaseUrl = (value) => {
  const raw = (value || '').toString().trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
};

const resolveApiBaseUrl = () => {
  // 1) Explicit env var (best for production deployments)
  const envUrl = normalizeBaseUrl(process.env.REACT_APP_BACKEND_URL);
  if (envUrl) return envUrl;

  // 2) Default: empty baseURL so CRA proxy handles /api/* locally.
  //    (The old localStorage BACKEND_URL override is gone — its UI was removed and index.html
  //    now clears the key; localStorage holds scalar settings only.)
  return '';
};

const API_BASE_URL = resolveApiBaseUrl();

// Backend-served asset paths (e.g. locally-cached officer photos) come back with raw,
// unencoded segments — some contain literal spaces (e.g. "/shared/image data from link/…").
// Encode each path segment so the resulting URL is always valid, without touching the
// slashes that separate them or double-encoding an already-encoded value.
const encodePathSegments = (input) => {
  const cut = input.search(/[?#]/);
  const pathPart = cut === -1 ? input : input.slice(0, cut);
  const tail = cut === -1 ? '' : input.slice(cut);
  const encoded = pathPart
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      try { return encodeURIComponent(decodeURIComponent(segment)); } catch { return encodeURIComponent(segment); }
    })
    .join('/');
  return encoded + tail;
};

const absolutizeUrl = (value, baseUrl = API_BASE_URL) => {
  const raw = (value || '').toString().trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw) || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
  const encodedPath = encodePathSegments(raw);
  if (!baseUrl) return encodedPath;
  if (encodedPath.startsWith('/')) return `${baseUrl}${encodedPath}`;
  return `${baseUrl}/${encodedPath.replace(/^\/+/, '')}`;
};

export const buildApiUrl = (path = '') => absolutizeUrl(path, API_BASE_URL);
export const buildAssetUrl = (path = '') => absolutizeUrl(path, API_BASE_URL);

// Untrusted news pages ("Live Site" view) are served by the backend's reader on a
// separate origin (default port 5002), never through the app's own origin.
const resolveReaderOrigin = () => {
  const envOrigin = normalizeBaseUrl(process.env.REACT_APP_READER_ORIGIN);
  if (envOrigin) return envOrigin;
  if (typeof window !== 'undefined' && window.location) {
    return `${window.location.protocol}//${window.location.hostname}:5002`;
  }
  return 'http://localhost:5002';
};

// `token` (from /api/analyze-text → reader_token) makes the reader inject the same highlights.
// `version` changes when new highlight data (e.g. sentence highlights) is available, so the
// iframe URL changes and the frame reloads with it.
export const buildReaderUrl = (targetUrl = '', token = '', version = '') => (
  `${resolveReaderOrigin()}/read?url=${encodeURIComponent(targetUrl || '')}${token ? `&token=${encodeURIComponent(token)}` : ''}${version ? `&v=${encodeURIComponent(version)}` : ''}`
);

// Warms the reader's snapshot and answers {ok} (CORS JSON) so the UI can fall back silently.
export const buildReaderPrepareUrl = (targetUrl = '') => (
  `${resolveReaderOrigin()}/prepare?url=${encodeURIComponent(targetUrl || '')}`
);

/**
 * Create axios instance with default configuration
 */
const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000, // Default timeout (override per endpoint when needed)
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
});

/**
 * Request interceptor
 * Logs outgoing requests for debugging
 */
apiClient.interceptors.request.use(
  (config) => {
    const base = (config.baseURL || '').toString();
    const prefix = base ? `${base}` : '(proxy)';
    console.log(`📤 [API] ${config.method.toUpperCase()} ${prefix}${config.url}`);
    return config;
  },
  (error) => {
    console.error('❌ [API Request Error]', error);
    return Promise.reject(error);
  }
);

/**
 * Response interceptor
 * Logs responses and handles common errors
 */
apiClient.interceptors.response.use(
  (response) => {
    console.log(`✅ [API] ${response.status} - ${response.config.url}`);
    return response;
  },
  (error) => {
    // Request was intentionally canceled by AbortController
    if (axios.isCancel(error) || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError') {
      return Promise.reject(error);
    }

    // Axios timeout (client-side)
    if (error?.code === 'ECONNABORTED' || /timeout of \d+ms exceeded/i.test(error?.message || '')) {
      console.error('⏱️ [API] Request timed out:', error.config?.url);
      return Promise.reject(
        new Error(
          'Request timed out. The backend may be busy extracting the article. Please try again, or use a faster URL/source.'
        )
      );
    }

    if (error.response) {
      // Server responded with error status
      console.error(`❌ [API] Error ${error.response.status}:`, error.response.data);
      
      if (error.response.status === 404) {
        console.error('Resource not found. Check endpoint URL.');
      } else if (error.response.status === 500) {
        console.error('Server error. Check backend logs.');
      }
    } else if (error.request) {
      // Request made but no response
      console.error('❌ [API] No response from server:', error.message);
      console.error('Check if backend is running (frontend proxy → http://localhost:5005)');
    } else {
      // Error in request setup
      console.error('❌ [API] Request setup error:', error.message);
    }
    
    return Promise.reject(error);
  }
);

/**
 * API Methods - Typed wrappers for common endpoints
 */
export const analyzeUrl = async (payloadInput, options = {}) => {
  const requestOptions = options && typeof options === 'object' ? options : {};
  const { signal, ...payloadOptions } = requestOptions;

  const payload = typeof payloadInput === 'string'
    ? { url: payloadInput }
    : (payloadInput && typeof payloadInput === 'object' ? payloadInput : {});

  const response = await apiClient.post('/api/analyze', {
    ...payload,
    ...payloadOptions,
  }, {
    timeout: 120000,
    ...(signal ? { signal } : {}),
  });
  return response.data;
};

export const analyzeText = async (text, options = {}) => {
  const requestOptions = options && typeof options === 'object' ? options : {};
  const { signal, ...payloadOptions } = requestOptions;

  const payload = {
    text,
    ...payloadOptions,
  };

  const response = await apiClient.post('/api/analyze-text', payload, {
    timeout: 120000,
    ...(signal ? { signal } : {}),
  });
  return response.data;
};

export const extractEntitiesFromNews = async (text, options = {}) => {
  const requestOptions = options && typeof options === 'object' ? options : {};
  const { signal, ...payloadOptions } = requestOptions;

  const response = await apiClient.post('/api/extract-entities', {
    text,
    ...payloadOptions,
  }, {
    timeout: 30000,
    ...(signal ? { signal } : {}),
  });
  return response.data;
};

export const getOfficesList = async () => {
  const response = await apiClient.get('/api/offices-list', { timeout: 15000 });
  return response.data;
};

export const verifyContact = async (officeName, enrichWeb = false, options = {}) => {
  const requestOptions = options && typeof options === 'object' ? options : {};
  const { signal, ...payloadOptions } = requestOptions;

  const payload = {
    office_name: officeName,
    enrich_web: enrichWeb,
    ...payloadOptions,
  };
  const response = await apiClient.post(
    '/api/verify-contact',
    payload,
    {
      timeout: enrichWeb ? 120000 : 20000,
      ...(signal ? { signal } : {}),
    }
  );
  return response.data;
};

export const sendMail = async (subject, body, recipientEmail, officeName, attachments = [], cc = '', bcc = '', linkAttachments = []) => {
  const response = await apiClient.post(
    '/api/send-mail',
    {
    subject,
    body,
    recipient_email: recipientEmail,
    office_name: officeName,
    attachments,
    cc,
    bcc,
    link_attachments: linkAttachments,
    },
    { timeout: 60000 }
  );
  return response.data;
};

// Section 4 (Postmark-based, separate from the Gmail OAuth send/draft path above): the "From"
// address is part of the FormData built by the caller for every send -- never a fixed env value.
export const sendMailPostmark = async (formData) => {
  const response = await apiClient.post('/api/send-mail-postmark', formData, {
    timeout: 60000,
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
};

export const generateRtiApplicationDraft = async ({ text, office, applicant, llm_provider = 'auto' }) => {
  const response = await apiClient.post('/api/rti-application-draft', { text, office, applicant, llm_provider }, {
    timeout: 30000,
  });
  return response.data;
};

export const listContacts = async () => {
  const response = await apiClient.get('/api/contacts');
  return response.data;
};

export const healthCheck = async () => {
  const response = await apiClient.get('/health');
  return response.data;
};

export const getLlmStatus = async () => {
  const response = await apiClient.get('/api/llm-status', { timeout: 30000 });
  return response.data;
};

// ===== Gmail OAuth + Draft/Send (Google API via backend) =====

export const getGmailStatus = async (email) => {
  const response = await apiClient.get('/api/gmail/status', {
    params: { email },
    timeout: 30000,
  });
  return response.data;
};

export const getGmailAuthUrl = async (email, force = false) => {
  const response = await apiClient.get('/api/gmail/auth-url', {
    params: { email, force: force ? 1 : 0 },
    timeout: 30000,
  });
  return response.data;
};

export const exchangeGmailAuthCode = async (authCode) => {
  const response = await apiClient.post(
    '/api/gmail/exchange-code',
    { authCode },
    { timeout: 60000 }
  );
  return response.data;
};

export const createGmailDraft = async (formData) => {
  const response = await apiClient.post('/api/gmail/create-draft', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000,
  });
  return response.data;
};

export const sendViaGmail = async (formData) => {
  const response = await apiClient.post('/api/gmail/send', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000,
  });
  return response.data;
};

export const getEmailTemplates = async () => {
  const response = await apiClient.get('/api/templates', { timeout: 30000 });
  return response.data;
};

export const getEmailTemplateContent = async (filename) => {
  const response = await apiClient.get(`/api/templates/${encodeURIComponent(filename)}`, { timeout: 30000 });
  return response.data;
};

/**
 * News Summary Box API Methods
 * For the 20-feature news analysis component
 */

/**
 * Get complete news summary with all 20 features
 * @param {string} url - News article URL
 * @param {string} text - Optional pre-fetched article text
 * @returns {Promise<Object>} Complete news summary data
 */
export const getNewsSummary = async (url, text = '', options = {}) => {
  const payload = {
    url,
    text,
    ...(options && typeof options === 'object' ? options : {}),
  };
  const response = await apiClient.post('/api/news-summary', payload, { timeout: 120000 });
  return response.data;
};

/**
 * Analyze sentiment of text
 * Note: ML service is disabled; these route through the backend which uses Gemini AI.
 * @param {string} text - Text to analyze
 * @returns {Promise<Object>} Sentiment score and label
 */
export const analyzeSentiment = async (text) => {
  const response = await apiClient.post('/api/news-summary', { text, feature: 'sentiment' });
  return response.data;
};

/**
 * Detect political bias in text
 * Note: ML service is disabled; these route through the backend which uses Gemini AI.
 * @param {string} text - Text to analyze
 * @returns {Promise<Object>} Bias label and confidence
 */
export const detectBias = async (text) => {
  const response = await apiClient.post('/api/news-summary', { text, feature: 'bias' });
  return response.data;
};

/**
 * Analyze legal implications
 * Note: ML service is disabled; these route through the backend which uses Gemini AI.
 * @param {string} text - Text to analyze
 * @param {string} country - Country code (default: BD)
 * @returns {Promise<Object>} Legal implications array
 */
export const analyzeLegalImplications = async (text, country = 'BD') => {
  const response = await apiClient.post('/api/news-summary', { 
    text, 
    country,
    feature: 'legal'
  });
  return response.data;
};

/**
 * Search for related news articles
 * @param {string} query - Search query
 * @param {string} excludeUrl - URL to exclude from results
 * @returns {Promise<Object>} Related news results
 */
export const searchRelatedNews = async (query, excludeUrl = '') => {
  const response = await apiClient.get('/api/related-news', { 
    params: { q: query, exclude: excludeUrl } 
  });
  return response.data;
};

// ═══════════════════════════════════════════════════════════════════════════════════════
// 🎯 3-STAGE INTELLIGENT PIPELINE API WRAPPERS
// ═══════════════════════════════════════════════════════════════════════════════════════

/**
 * Stage 1: AI-Powered News Ingestion & Extraction
 * Extracts 3-bullet summary + structured entities from news text
 * 
 * @param {string} newsText - Full article text
 * @param {string} title - Article title (optional)
 * @param {string} llmProvider - 'openai' | 'gemini' | 'cerebras'
 * @returns {Promise<Object>} { summary_bullets: [...], entities: {...} }
 */
export const stage1SummarizeNews = async (newsText, title = '', llmProvider = 'openai') => {
  const response = await apiClient.post('/api/stage1-summarize', {
    text: newsText,
    title,
    llm_provider: llmProvider
  });
  return response.data;
};

/**
 * Stage 2: Schema-Enforced Webpage Scraping (PRIORITY)
 * Scrapes .gov.bd links and maps to exact 26-column database schema
 * 
 * @param {string} govUrl - Government website URL (.gov.bd)
 * @param {string} llmProvider - 'gemini' (recommended for context window)
 * @returns {Promise<Object>} { data: {...26-column schema...}, confidence: {...} }
 */
export const stage2ScrapeSchema = async (govUrl, llmProvider = 'gemini') => {
  const response = await apiClient.post('/api/stage2-scrape', {
    url: govUrl,
    llm_provider: llmProvider
  });
  return response.data;
};

/**
 * Stage 3: Real-Time Dynamic Verification Fallback
 * Uses Cerebras for ultra-fast synthesis when local DB has no match
 * 
 * @param {string} officerName - Officer to search for
 * @param {string} ministry - Ministry/Department (optional)
 * @param {string} context - Additional context (optional)
 * @returns {Promise<Object>} { officer_data: {...}, confidence: 0.65, source: 'cerebras_synthesis' }
 */
export const stage3FallbackLookup = async (officerName, ministry = '', context = '') => {
  const response = await apiClient.post('/api/stage3-fallback', {
    officer_name: officerName,
    ministry,
    context
  });
  return response.data;
};

export default apiClient;
