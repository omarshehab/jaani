/**
 * JAANI History Manager - Caches and stores all search/analysis activities
 * Saves to shared folder for persistence and browser localStorage for quick access
 */

const fs = require('fs').promises;
const path = require('path');

class HistoryManager {
  constructor() {
    this.historyFile = path.join(__dirname, 'search_history.json');
    this.cacheFile = path.join(__dirname, 'search_cache.json');
    this.activityEventsFile = path.join(__dirname, 'activity_events.json');
    this.maxHistoryItems = 20000; // 20x = Keep last 20000 searches (was 1000)
    this.maxCacheItems = 10000;   // 20x = Cache last 10000 results (was 500)
    this.cacheExpiryHours = 24; // Cache expires after 24 hours
    this.maxActivityEvents = 50000;

    // In-memory cache for faster access
    this.memoryCache = new Map();
    this.memoryHistory = [];
    this.memoryActivityEvents = [];

    this.initialize();
  }

  async initialize() {
    try {
      // Load existing history
      const historyData = await this.loadFromFile(this.historyFile);
      this.memoryHistory = historyData || [];

      // Load existing cache
      const cacheData = await this.loadFromFile(this.cacheFile);
      if (cacheData) {
        // Clean expired cache entries
        const now = Date.now();
        const validCache = {};
        Object.entries(cacheData).forEach(([key, entry]) => {
          if (now - entry.timestamp < this.cacheExpiryHours * 60 * 60 * 1000) {
            validCache[key] = entry;
            this.memoryCache.set(key, entry);
          }
        });
        await this.saveToFile(this.cacheFile, validCache);
      }

      const activityData = await this.loadFromFile(this.activityEventsFile);
      this.memoryActivityEvents = Array.isArray(activityData) ? activityData : [];

      console.log(`📚 History Manager initialized - ${this.memoryHistory.length} history items, ${this.memoryCache.size} cached results, ${this.memoryActivityEvents.length} activity events`);
    } catch (error) {
      console.error('❌ Error initializing History Manager:', error);
      this.memoryHistory = [];
      this.memoryCache.clear();
      this.memoryActivityEvents = [];
    }
  }

  async loadFromFile(filePath) {
    try {
      const data = await fs.readFile(filePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  async saveToFile(filePath, data) {
    try {
      await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error(`❌ Error saving to ${filePath}:`, error);
    }
  }

  generateCacheKey(url, options = {}) {
    const progressiveRaw = options.progressive_mode ?? options.progressive ?? false;
    const progressiveMode = typeof progressiveRaw === 'string'
      ? ['1', 'true', 'yes', 'on'].includes(progressiveRaw.trim().toLowerCase())
      : Boolean(progressiveRaw);

    const keyData = {
      url: url.trim().toLowerCase().normalize('NFC'),
      language: options.language || 'en',
      region: options.region || 'global',
      llmProvider: options.llm_provider || options.provider || 'auto',
      progressiveMode,
    };
    return Buffer.from(JSON.stringify(keyData)).toString('base64');
  }

  async addToHistory(searchData) {
    try {
      const historyEntry = {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        url: searchData.url,
        language: searchData.language || 'en',
        region: searchData.region || 'global',
        userAgent: searchData.userAgent || 'unknown',
        ip: searchData.ip || 'unknown',
        success: searchData.success !== false,
        processingTime: searchData.processingTime || 0,
        imagesFound: searchData.imagesFound || 0,
        textLength: searchData.textLength || 0,
        keywords: searchData.keywords || [],
        relatedOffice: searchData.relatedOffice || '',
        sentiment: searchData.sentiment || 'neutral',
        confidence: searchData.confidence || 0
      };

      // Add to memory
      this.memoryHistory.unshift(historyEntry);

      // Keep only recent items
      if (this.memoryHistory.length > this.maxHistoryItems) {
        this.memoryHistory = this.memoryHistory.slice(0, this.maxHistoryItems);
      }

      // Save to file
      await this.saveToFile(this.historyFile, this.memoryHistory);

      console.log(`📝 Added to history: ${searchData.url}`);
      return historyEntry.id;
    } catch (error) {
      console.error('❌ Error adding to history:', error);
      return null;
    }
  }

  async addActivityEvent(activityData = {}) {
    try {
      const entry = {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        type: activityData.type || 'activity',
        path: activityData.path || '',
        method: activityData.method || '',
        sessionId: activityData.sessionId || '',
        ip: activityData.ip || 'unknown',
        location: activityData.location || null,
        engagement: activityData.engagement || null,
        userAgent: activityData.userAgent || '',
      };

      this.memoryActivityEvents.unshift(entry);
      if (this.memoryActivityEvents.length > this.maxActivityEvents) {
        this.memoryActivityEvents = this.memoryActivityEvents.slice(0, this.maxActivityEvents);
      }

      await this.saveToFile(this.activityEventsFile, this.memoryActivityEvents);
      return entry.id;
    } catch (error) {
      console.error('❌ Error adding activity event:', error);
      return null;
    }
  }

  async getActivityEvents(limit = 100, offset = 0) {
    try {
      const items = this.memoryActivityEvents.slice(offset, offset + limit);
      return {
        total: this.memoryActivityEvents.length,
        items,
        hasMore: offset + limit < this.memoryActivityEvents.length,
      };
    } catch (error) {
      console.error('❌ Error getting activity events:', error);
      return { total: 0, items: [], hasMore: false };
    }
  }

  async cacheResult(url, options, result) {
    try {
      const cacheKey = this.generateCacheKey(url, options);
      const cacheEntry = {
        timestamp: Date.now(),
        url: url,
        options: options,
        result: result,
        expiresAt: Date.now() + (this.cacheExpiryHours * 60 * 60 * 1000)
      };

      // Add to memory cache
      this.memoryCache.set(cacheKey, cacheEntry);

      // Clean old entries from memory
      if (this.memoryCache.size > this.maxCacheItems) {
        const entries = Array.from(this.memoryCache.entries());
        entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
        this.memoryCache.clear();
        entries.slice(0, this.maxCacheItems).forEach(([key, value]) => {
          this.memoryCache.set(key, value);
        });
      }

      // Save to file
      const cacheData = {};
      this.memoryCache.forEach((value, key) => {
        cacheData[key] = value;
      });
      await this.saveToFile(this.cacheFile, cacheData);

      console.log(`💾 Cached result for: ${url}`);
      return cacheKey;
    } catch (error) {
      console.error('❌ Error caching result:', error);
      return null;
    }
  }

  async getCachedResult(url, options) {
    try {
      const cacheKey = this.generateCacheKey(url, options);
      const cached = this.memoryCache.get(cacheKey);

      if (cached && Date.now() < cached.expiresAt) {
        console.log(`⚡ Cache hit for: ${url}`);
        return cached.result;
      }

      if (cached) {
        // Remove expired entry
        this.memoryCache.delete(cacheKey);
        console.log(`⏰ Cache expired for: ${url}`);
      }

      return null;
    } catch (error) {
      console.error('❌ Error getting cached result:', error);
      return null;
    }
  }

  /**
   * Get the most recent non-expired cached result for a URL, ignoring language/region options.
   * Useful for download endpoints where the UI might not pass options.
   */
  async getLatestCachedResultByUrl(url) {
    try {
      const normalizedUrl = (url || '').trim();
      if (!normalizedUrl) return null;

      const now = Date.now();
      let latestEntry = null;

      for (const entry of this.memoryCache.values()) {
        if (!entry || !entry.url) continue;
        if (entry.url.trim() !== normalizedUrl) continue;
        if (now >= entry.expiresAt) continue;

        if (!latestEntry || entry.timestamp > latestEntry.timestamp) {
          latestEntry = entry;
        }
      }

      return latestEntry ? latestEntry.result : null;
    } catch (error) {
      console.error('❌ Error getting latest cached result by url:', error);
      return null;
    }
  }

  async getHistory(limit = 50, offset = 0) {
    try {
      const history = this.memoryHistory.slice(offset, offset + limit);
      return {
        total: this.memoryHistory.length,
        items: history,
        hasMore: offset + limit < this.memoryHistory.length
      };
    } catch (error) {
      console.error('❌ Error getting history:', error);
      return { total: 0, items: [], hasMore: false };
    }
  }

  async searchHistory(query, limit = 20) {
    try {
      const results = this.memoryHistory.filter(entry => {
        const searchText = `${entry.url} ${entry.keywords.join(' ')} ${entry.relatedOffice}`.toLowerCase();
        return searchText.includes(query.toLowerCase());
      });

      return results.slice(0, limit);
    } catch (error) {
      console.error('❌ Error searching history:', error);
      return [];
    }
  }

  async getStats() {
    try {
      const stats = {
        totalSearches: this.memoryHistory.length,
        cachedResults: this.memoryCache.size,
        successfulSearches: this.memoryHistory.filter(h => h.success).length,
        averageProcessingTime: 0,
        popularKeywords: {},
        popularOffices: {},
        recentActivity: []
      };

      // Calculate averages and popular items
      if (this.memoryHistory.length > 0) {
        const totalTime = this.memoryHistory.reduce((sum, h) => sum + (h.processingTime || 0), 0);
        stats.averageProcessingTime = Math.round(totalTime / this.memoryHistory.length);

        // Popular keywords
        this.memoryHistory.forEach(h => {
          (h.keywords || []).forEach(keyword => {
            stats.popularKeywords[keyword] = (stats.popularKeywords[keyword] || 0) + 1;
          });
        });

        // Popular offices
        this.memoryHistory.forEach(h => {
          if (h.relatedOffice) {
            stats.popularOffices[h.relatedOffice] = (stats.popularOffices[h.relatedOffice] || 0) + 1;
          }
        });

        // Recent activity (last 10)
        stats.recentActivity = this.memoryHistory.slice(0, 10);
      }

      return stats;
    } catch (error) {
      console.error('❌ Error getting stats:', error);
      return {};
    }
  }

  async clearHistory() {
    try {
      this.memoryHistory = [];
      await this.saveToFile(this.historyFile, []);
      console.log('🗑️ History cleared');
      return true;
    } catch (error) {
      console.error('❌ Error clearing history:', error);
      return false;
    }
  }

  async clearCache() {
    try {
      this.memoryCache.clear();
      await this.saveToFile(this.cacheFile, {});
      console.log('🗑️ Cache cleared');
      return true;
    } catch (error) {
      console.error('❌ Error clearing cache:', error);
      return false;
    }
  }

  async exportHistory(format = 'json') {
    try {
      if (format === 'csv') {
        const csvHeader = 'ID,Timestamp,URL,Language,Region,Success,ProcessingTime,ImagesFound,TextLength,Keywords,RelatedOffice,Sentiment,Confidence\n';
        const csvRows = this.memoryHistory.map(entry =>
          `"${entry.id}","${entry.timestamp}","${entry.url}","${entry.language}","${entry.region}","${entry.success}","${entry.processingTime}","${entry.imagesFound}","${entry.textLength}","${entry.keywords.join(';')}","${entry.relatedOffice}","${entry.sentiment}","${entry.confidence}"`
        ).join('\n');
        return csvHeader + csvRows;
      }

      return JSON.stringify(this.memoryHistory, null, 2);
    } catch (error) {
      console.error('❌ Error exporting history:', error);
      return null;
    }
  }
}

// Export singleton instance
const historyManager = new HistoryManager();
module.exports = historyManager;