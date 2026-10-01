// TypeScript interfaces for X_Files platform
// Shared types across frontend, backend, and ML service

// Base entity interface
export interface Entity {
  type: string;
  text: string;
  confidence: number;
  start?: number;
  end?: number;
}

// Analysis result interface
export interface AnalysisResult {
  url: string;
  title: string;
  content: string;
  keywords: string[];
  entities: Entity[];
  language: string;
  region: string;
  timestamp: string;
  confidence: number;
}

// Contact interface
export interface Contact {
  id?: string;
  entityType: 'govt' | 'corporate' | 'admin' | 'media' | 'ngo';
  name: string;
  email: string;
  phone: string;
  address?: string;
  region: string;
  source: 'DB' | 'scrape';
  consent: boolean;
  lastUpdated: string;
  verified?: boolean;
  notes?: string;
}

// Template interface
export interface Template {
  id?: string;
  name: string;
  content: string;
  language: string;
  tone: 'formal' | 'neutral' | 'urgent';
  region: string;
  category?: string;
  createdAt: string;
  updatedAt: string;
  usageCount?: number;
}

// Message interface
export interface Message {
  id?: string;
  recipient: Contact;
  content: string;
  channels: ('email' | 'sms' | 'whatsapp' | 'twitter' | 'facebook')[];
  language: string;
  region: string;
  status: 'pending' | 'sent' | 'delivered' | 'failed';
  sentAt?: string;
  deliveredAt?: string;
  errorMessage?: string;
  trackingId?: string;
}

// API Response interfaces
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  timestamp: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// Request interfaces
export interface FetchAndAnalyzeRequest {
  url: string;
  language: string;
  region: string;
}

export interface GetContactsRequest {
  region?: string;
  entityType?: string;
  limit?: number;
  offset?: number;
}

export interface ScrapeRequest {
  entityName: string;
  url: string;
  region: string;
}

export interface GenerateTemplateRequest {
  text: string;
  tone: string;
  language: string;
  region: string;
}

export interface SendMessageRequest {
  recipient: Contact;
  message: string;
  channels: string[];
  language: string;
  region: string;
}

// User interface (for future authentication)
export interface User {
  id: string;
  email: string;
  name: string;
  region: string;
  language: string;
  role: 'user' | 'premium' | 'admin';
  createdAt: string;
  lastLogin?: string;
  preferences: UserPreferences;
}

export interface UserPreferences {
  defaultLanguage: string;
  defaultRegion: string;
  defaultTone: string;
  notifications: {
    email: boolean;
    sms: boolean;
    whatsapp: boolean;
  };
  privacy: {
    shareAnalytics: boolean;
    allowTracking: boolean;
  };
}

// ML Service interfaces
export interface MLAnalysisRequest {
  text: string;
  language: string;
  region: string;
}

export interface MLAnalysisResponse {
  keywords: string[];
  entities: Entity[];
  language: string;
  confidence: number;
  processingTime: number;
}

export interface MLTemplateRequest {
  text: string;
  tone: string;
  language: string;
  region: string;
}

export interface MLTemplateResponse {
  template: string;
  tone: string;
  language: string;
  region: string;
  confidence: number;
  processingTime: number;
}

// Configuration interfaces
export interface AppConfig {
  apiUrl: string;
  mlServiceUrl: string;
  defaultLanguage: string;
  defaultRegion: string;
  supportedLanguages: string[];
  supportedRegions: string[];
  features: Record<string, boolean>;
}

export interface ThemeConfig {
  primaryColor: string;
  secondaryColor: string;
  successColor: string;
  warningColor: string;
  errorColor: string;
  infoColor: string;
  breakpoints: Record<string, string>;
}

// Error interfaces
export interface AppError {
  code: string;
  message: string;
  details?: any;
  timestamp: string;
  stack?: string;
}

// Validation interfaces
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

// Analytics interfaces (for future premium features)
export interface AnalyticsData {
  totalAnalyses: number;
  totalMessages: number;
  topEntities: Array<{ name: string; count: number }>;
  topRegions: Array<{ region: string; count: number }>;
  topLanguages: Array<{ language: string; count: number }>;
  successRate: number;
  averageResponseTime: number;
}

// Export all interfaces as default
export default {
  Entity,
  AnalysisResult,
  Contact,
  Template,
  Message,
  ApiResponse,
  PaginatedResponse,
  FetchAndAnalyzeRequest,
  GetContactsRequest,
  ScrapeRequest,
  GenerateTemplateRequest,
  SendMessageRequest,
  User,
  UserPreferences,
  MLAnalysisRequest,
  MLAnalysisResponse,
  MLTemplateRequest,
  MLTemplateResponse,
  AppConfig,
  ThemeConfig,
  AppError,
  ValidationResult,
  AnalyticsData
};
