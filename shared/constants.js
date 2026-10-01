// Global constants for X_Files platform
// Used across frontend, backend, and ML service for consistency

// Supported languages for internationalization
export const LANGUAGES = [
  { code: 'en', name: 'English', flag: '🇺🇸' },
  { code: 'bn', name: 'বাংলা', flag: '🇧🇩' },
  { code: 'hi', name: 'हिन्दी', flag: '🇮🇳' },
  { code: 'ur', name: 'اردو', flag: '🇵🇰' },
  { code: 'ar', name: 'العربية', flag: '🇸🇦' },
  { code: 'es', name: 'Español', flag: '🇪🇸' }
];

// Supported regions for global scaling
export const REGIONS = [
  { code: 'BD', name: 'Bangladesh', timezone: 'Asia/Dhaka' },
  { code: 'US', name: 'United States', timezone: 'America/New_York' },
  { code: 'EU', name: 'European Union', timezone: 'Europe/Brussels' },
  { code: 'Global', name: 'Global', timezone: 'UTC' }
];

// Message tones for template generation
export const TONES = [
  { code: 'formal', name: 'Formal', description: 'Professional and respectful tone' },
  { code: 'neutral', name: 'Neutral', description: 'Balanced and objective tone' },
  { code: 'urgent', name: 'Urgent', description: 'Immediate action required tone' }
];

// Entity types for contact categorization
export const ENTITY_TYPES = [
  { code: 'govt', name: 'Government', icon: '🏛️' },
  { code: 'corporate', name: 'Corporate', icon: '🏢' },
  { code: 'admin', name: 'Administrative', icon: '📋' },
  { code: 'media', name: 'Media', icon: '📺' },
  { code: 'ngo', name: 'NGO', icon: '🤝' }
];

// Message channels for sending demands
export const MESSAGE_CHANNELS = [
  { code: 'email', name: 'Email', icon: '📧', enabled: true },
  { code: 'sms', name: 'SMS', icon: '📱', enabled: true },
  { code: 'whatsapp', name: 'WhatsApp', icon: '💬', enabled: true },
  { code: 'twitter', name: 'Twitter', icon: '🐦', enabled: false },
  { code: 'facebook', name: 'Facebook', icon: '📘', enabled: false }
];

// Phone number formats by region
export const PHONE_FORMATS = {
  BD: { prefix: '+880', format: '+880-XX-XXXX-XXXX', example: '+880-2-911-1234' },
  US: { prefix: '+1', format: '+1-XXX-XXX-XXXX', example: '+1-555-123-4567' },
  EU: { prefix: '+XX', format: '+XX-XXX-XXXXXXX', example: '+49-30-12345678' },
  Global: { prefix: '+', format: '+XXX-XXXXXXXXX', example: '+1-555-123-4567' }
};

// ML model configurations
export const ML_MODELS = {
  NER: {
    'en': 'dbmdz/bert-large-cased-finetuned-conll03-english',
    'bn': 'csebuetnlp/banglabert',
    'hi': 'ai4bharat/ner-multilingual',
    'ur': 'ai4bharat/ner-multilingual',
    'ar': 'ai4bharat/ner-multilingual',
    'es': 'dbmdz/bert-large-cased-finetuned-conll03-english'
  },
  TEXT_GENERATION: {
    'en': 'gpt2',
    'bn': 'flax-community/gpt2-bengali',
    'hi': 'ai4bharat/gpt2-hindi',
    'ur': 'ai4bharat/gpt2-urdu',
    'ar': 'aubmindlab/bert-base-arabertv2',
    'es': 'datasets/spanish-gpt2'
  }
};

// API endpoints configuration
export const API_ENDPOINTS = {
  FETCH_AND_ANALYZE: '/api/fetch-and-analyze',
  GET_CONTACTS: '/api/get-contacts',
  SCRAPE: '/api/scrape',
  GENERATE_TEMPLATE: '/api/generate-template',
  SEND_MESSAGE: '/api/send-message',
  HEALTH: '/api/health'
};

// Rate limiting configuration
export const RATE_LIMITS = {
  DEFAULT: { max: 100, windowMs: 3600000 }, // 100 requests per hour
  PREMIUM: { max: 1000, windowMs: 3600000 }, // 1000 requests per hour
  SCRAPING: { max: 10, windowMs: 60000 }, // 10 requests per minute
  ML_SERVICE: { max: 50, windowMs: 60000 } // 50 requests per minute
};

// UI theme configuration
export const THEME_CONFIG = {
  PRIMARY_COLOR: '#1E88E5',
  SECONDARY_COLOR: '#F44336',
  SUCCESS_COLOR: '#4CAF50',
  WARNING_COLOR: '#FF9800',
  ERROR_COLOR: '#F44336',
  INFO_COLOR: '#2196F3',
  BREAKPOINTS: {
    MOBILE: '320px',
    TABLET: '768px',
    DESKTOP: '1024px',
    LARGE: '1440px'
  }
};

// Scraping configuration
export const SCRAPING_CONFIG = {
  TIMEOUT: 30000, // 30 seconds
  USER_AGENT: 'X_Files/1.0 (Global Accountability Platform)',
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000, // 1 second
  SELECTORS: {
    ARTICLE: ['article', '.article', '.post', '.content'],
    TITLE: ['h1', '.title', '.headline'],
    CONTENT: ['p', '.content', '.text', '.body'],
    CONTACT: ['.contact', '.contact-info', '.contact-details']
  }
};

// Database configuration
export const DB_CONFIG = {
  COLLECTIONS: {
    CONTACTS: 'contacts',
    TEMPLATES: 'templates',
    ANALYSES: 'analyses',
    MESSAGES: 'messages',
    USERS: 'users'
  },
  INDEXES: {
    CONTACTS: ['name', 'region', 'entityType', 'email'],
    TEMPLATES: ['language', 'tone', 'region'],
    ANALYSES: ['url', 'language', 'region', 'timestamp']
  }
};

// Error codes for consistent error handling
export const ERROR_CODES = {
  INVALID_URL: 'INVALID_URL',
  SCRAPING_FAILED: 'SCRAPING_FAILED',
  ML_SERVICE_ERROR: 'ML_SERVICE_ERROR',
  CONTACT_NOT_FOUND: 'CONTACT_NOT_FOUND',
  MESSAGE_SEND_FAILED: 'MESSAGE_SEND_FAILED',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  INVALID_LANGUAGE: 'INVALID_LANGUAGE',
  INVALID_REGION: 'INVALID_REGION',
  DATABASE_ERROR: 'DATABASE_ERROR',
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR'
};

// Feature flags for gradual rollout
export const FEATURE_FLAGS = {
  MULTILINGUAL_SUPPORT: true,
  REAL_TIME_SCRAPING: true,
  ML_TEMPLATE_GENERATION: true,
  WHATSAPP_INTEGRATION: true,
  PREMIUM_ANALYTICS: false,
  BLOCKCHAIN_VERIFICATION: false,
  AI_INVESTIGATION: false
};

// Default values
export const DEFAULTS = {
  LANGUAGE: 'en',
  REGION: 'BD',
  TONE: 'neutral',
  ENTITY_TYPE: 'govt',
  MESSAGE_CHANNEL: 'email',
  PAGE_SIZE: 20,
  MAX_CONTACTS: 100,
  TEMPLATE_LENGTH: 500
};

// Validation rules
export const VALIDATION_RULES = {
  URL: {
    PATTERN: /^https?:\/\/.+/,
    MAX_LENGTH: 2048
  },
  EMAIL: {
    PATTERN: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    MAX_LENGTH: 254
  },
  PHONE: {
    PATTERN: /^\+?[1-9]\d{1,14}$/,
    MIN_LENGTH: 10,
    MAX_LENGTH: 15
  },
  TEXT: {
    MIN_LENGTH: 10,
    MAX_LENGTH: 5000
  }
};

// Export all constants as default
export default {
  LANGUAGES,
  REGIONS,
  TONES,
  ENTITY_TYPES,
  MESSAGE_CHANNELS,
  PHONE_FORMATS,
  ML_MODELS,
  API_ENDPOINTS,
  RATE_LIMITS,
  THEME_CONFIG,
  SCRAPING_CONFIG,
  DB_CONFIG,
  ERROR_CODES,
  FEATURE_FLAGS,
  DEFAULTS,
  VALIDATION_RULES
};
