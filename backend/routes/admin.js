const express = require('express');
const fs = require('fs').promises;
const path = require('path');

const historyManager = require('../../shared/historyManager');
const activityTracker = require('../../shared/activityTracker');
const geminiAnalysis = require('../services/geminiAnalysis');

const router = express.Router();

function clampInt(value, fallback, min = 1, max = 200) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clampNonNegativeInt(value, fallback = 0, max = 100000) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(0, parsed));
}

function toTimestamp(value) {
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  const safeIdx = Math.min(sorted.length - 1, Math.max(0, idx));
  return sorted[safeIdx];
}

function topObjectEntries(mapObject, limit = 10) {
  if (!mapObject || typeof mapObject !== 'object') return [];
  return Object.entries(mapObject)
    .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count: Number(count) || 0 }));
}

function safeProviderStatusReport() {
  if (typeof geminiAnalysis.getProviderStatusReport === 'function') {
    return geminiAnalysis.getProviderStatusReport();
  }

  return {
    providers: [],
    configuredCount: 0,
    totalCount: 0,
    autoOrder: [],
  };
}

async function buildLLMUsageData() {
  const [status, historyStats, recentEvents] = await Promise.all([
    Promise.resolve(safeProviderStatusReport()),
    historyManager.getStats(),
    historyManager.getActivityEvents(500, 0),
  ]);

  const missingProviders = (status.providers || [])
    .filter((provider) => !provider.configured)
    .map((provider) => ({
      provider: provider.provider,
      envKey: provider.envKey,
    }));

  const llmPathCounts = {};
  for (const event of recentEvents.items || []) {
    const pathName = String(event?.path || '').toLowerCase();
    if (!pathName.includes('/api/')) continue;
    llmPathCounts[pathName] = (llmPathCounts[pathName] || 0) + 1;
  }

  return {
    timestamp: new Date().toISOString(),
    ...status,
    missingProviders,
    requestBreakdown: topObjectEntries(llmPathCounts, 15),
    totalSearches: Number(historyStats?.totalSearches) || 0,
    successfulSearches: Number(historyStats?.successfulSearches) || 0,
    averageProcessingTimeMs: Number(historyStats?.averageProcessingTime) || 0,
  };
}

router.get('/overview', async (req, res) => {
  try {
    const [historyStats, historySnapshot, activitySummary, visitors, sessions, llmStatus] = await Promise.all([
      historyManager.getStats(),
      historyManager.getHistory(10, 0),
      activityTracker.getSummary(),
      activityTracker.getAllVisitors(),
      activityTracker.getAllSessions(),
      Promise.resolve(safeProviderStatusReport()),
    ]);

    const totalSearches = Number(historyStats?.totalSearches) || 0;
    const successfulSearches = Number(historyStats?.successfulSearches) || 0;
    const successRate = totalSearches > 0
      ? Number(((successfulSearches / totalSearches) * 100).toFixed(2))
      : 0;

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        searches: {
          total: totalSearches,
          successful: successfulSearches,
          successRate,
          averageProcessingTimeMs: Number(historyStats?.averageProcessingTime) || 0,
          recent: historySnapshot?.items || [],
        },
        activity: {
          totalSessions: Number(activitySummary?.totalSessions) || sessions.length,
          activeSessions: Number(activitySummary?.activeSessions) || 0,
          todayActivities: Number(activitySummary?.todayActivities) || 0,
          totalVisitors: visitors.length,
        },
        cache: {
          cachedResults: Number(historyStats?.cachedResults) || 0,
        },
        llm: {
          providersConfigured: llmStatus.configuredCount,
          providersTotal: llmStatus.totalCount,
          autoOrder: llmStatus.autoOrder,
        },
      },
    });
  } catch (error) {
    console.error('❌ Error in /api/admin/overview:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to build admin overview',
      message: error.message,
    });
  }
});

router.get('/recent-activity', async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 40, 1, 250);

    const [historySnapshot, activities] = await Promise.all([
      historyManager.getHistory(limit, 0),
      activityTracker.getTodayActivities(),
    ]);

    const searchEvents = (historySnapshot?.items || []).map((item) => ({
      source: 'search',
      type: 'analysis',
      timestamp: item.timestamp,
      details: {
        url: item.url,
        success: Boolean(item.success),
        processingTime: Number(item.processingTime) || 0,
      },
    }));

    const trackerEvents = (activities || []).map((item) => ({
      source: 'tracker',
      type: item.type || 'activity',
      timestamp: item.timestamp,
      details: item.details || {},
    }));

    const merged = [...searchEvents, ...trackerEvents]
      .sort((a, b) => toTimestamp(b.timestamp) - toTimestamp(a.timestamp))
      .slice(0, limit);

    res.json({
      success: true,
      limit,
      count: merged.length,
      activities: merged,
    });
  } catch (error) {
    console.error('❌ Error in /api/admin/recent-activity:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch recent activity',
      message: error.message,
    });
  }
});

router.get('/performance', async (req, res) => {
  try {
    const [historyStats, historySnapshot, sessions] = await Promise.all([
      historyManager.getStats(),
      historyManager.getHistory(250, 0),
      activityTracker.getAllSessions(),
    ]);

    const processingTimes = (historySnapshot?.items || [])
      .map((item) => Number(item.processingTime) || 0)
      .filter((ms) => ms > 0);

    const sessionDurationsMinutes = (sessions || [])
      .map((session) => {
        const start = toTimestamp(session.startTime);
        const end = toTimestamp(session.lastActivity);
        if (!start || !end || end < start) return 0;
        return (end - start) / 60000;
      })
      .filter((mins) => mins > 0);

    const averageSessionDurationMinutes = sessionDurationsMinutes.length
      ? Number((sessionDurationsMinutes.reduce((sum, mins) => sum + mins, 0) / sessionDurationsMinutes.length).toFixed(2))
      : 0;

    const p95ProcessingMs = processingTimes.length ? percentile(processingTimes, 95) : 0;

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        analyses: {
          averageProcessingTimeMs: Number(historyStats?.averageProcessingTime) || 0,
          p95ProcessingTimeMs: Number(p95ProcessingMs) || 0,
          totalSamples: processingTimes.length,
        },
        sessions: {
          totalSamples: sessionDurationsMinutes.length,
          averageDurationMinutes: averageSessionDurationMinutes,
          activeNow: Number(activityTracker.sessions?.size) || 0,
        },
      },
    });
  } catch (error) {
    console.error('❌ Error in /api/admin/performance:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch performance metrics',
      message: error.message,
    });
  }
});

router.get('/audience', async (req, res) => {
  try {
    const [visitors, sessions] = await Promise.all([
      activityTracker.getAllVisitors(),
      activityTracker.getAllSessions(),
    ]);

    const byCountry = {};
    for (const visitor of visitors) {
      const country = visitor?.location?.country || 'Unknown';
      byCountry[country] = (byCountry[country] || 0) + 1;
    }

    const byDevice = {};
    for (const session of sessions) {
      const rawType = session?.device?.device?.type
        || session?.device?.device
        || 'unknown';
      const type = String(rawType || 'unknown').toLowerCase();
      byDevice[type] = (byDevice[type] || 0) + 1;
    }

    const localUsers = visitors.filter((visitor) => visitor?.accessMethod === 'Local').length;
    const remoteUsers = visitors.length - localUsers;

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        totals: {
          uniqueVisitors: visitors.length,
          sessions: sessions.length,
          localUsers,
          remoteUsers,
        },
        topCountries: topObjectEntries(byCountry, 15),
        deviceBreakdown: topObjectEntries(byDevice, 10),
      },
    });
  } catch (error) {
    console.error('❌ Error in /api/admin/audience:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch audience metrics',
      message: error.message,
    });
  }
});

router.get('/llm', async (req, res) => {
  try {
    const data = await buildLLMUsageData();

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('❌ Error in /api/admin/llm:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch LLM provider status',
      message: error.message,
    });
  }
});

router.get('/llm-usage', async (req, res) => {
  try {
    const data = await buildLLMUsageData();

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('❌ Error in /api/admin/llm-usage:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch LLM usage data',
      message: error.message,
    });
  }
});

router.get('/cache', async (req, res) => {
  try {
    const historyStats = await historyManager.getStats();

    const cacheFilePath = historyManager.cacheFile || path.join(__dirname, '../../shared/search_cache.json');
    let fileStats = null;
    let cacheEntries = [];

    try {
      const raw = await fs.readFile(cacheFilePath, 'utf8');
      const parsed = JSON.parse(raw || '{}');
      cacheEntries = Object.values(parsed || {});

      const stat = await fs.stat(cacheFilePath);
      fileStats = {
        path: cacheFilePath,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
      };
    } catch {
      cacheEntries = [];
      fileStats = {
        path: cacheFilePath,
        sizeBytes: 0,
        updatedAt: null,
      };
    }

    const timestamps = cacheEntries
      .map((entry) => Number(entry.timestamp) || 0)
      .filter((ts) => ts > 0)
      .sort((a, b) => a - b);

    const oldest = timestamps.length ? new Date(timestamps[0]).toISOString() : null;
    const newest = timestamps.length ? new Date(timestamps[timestamps.length - 1]).toISOString() : null;

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        cachedResultsInMemory: Number(historyStats?.cachedResults) || 0,
        cachedResultsOnDisk: cacheEntries.length,
        oldestEntry: oldest,
        newestEntry: newest,
        file: fileStats,
      },
    });
  } catch (error) {
    console.error('❌ Error in /api/admin/cache:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch cache metrics',
      message: error.message,
    });
  }
});

router.get('/sessions', async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const offset = clampNonNegativeInt(req.query.offset, 0, 100000);

    const sessions = await activityTracker.getAllSessions();
    const sorted = (sessions || []).sort((a, b) => toTimestamp(b.lastActivity) - toTimestamp(a.lastActivity));
    const page = sorted.slice(offset, offset + limit);

    const items = page.map((session) => ({
      sessionId: session.sessionId,
      startTime: session.startTime,
      lastActivity: session.lastActivity,
      pageViews: Number(session.pageViews) || 0,
      totalActivities: Array.isArray(session.activities) ? session.activities.length : 0,
      location: session.location || null,
      gpsLocation: session.gpsLocation || null,
      device: session.device || null,
      engagement: session.engagement || null,
      performance: session.performance || null,
    }));

    res.json({
      success: true,
      total: sorted.length,
      limit,
      offset,
      hasMore: offset + limit < sorted.length,
      sessions: items,
    });
  } catch (error) {
    console.error('❌ Error in /api/admin/sessions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch sessions',
      message: error.message,
    });
  }
});

router.get('/geo-density', async (req, res) => {
  try {
    const sessions = await activityTracker.getAllSessions();
    const buckets = new Map();
    const byCountry = {};

    for (const session of sessions || []) {
      const loc = session.location || {};
      const country = loc.country || 'Unknown';
      byCountry[country] = (byCountry[country] || 0) + 1;

      const lat = Number(session.gpsLocation?.lat ?? loc.latitude);
      const lng = Number(session.gpsLocation?.lng ?? loc.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
      const current = buckets.get(key) || {
        key,
        lat: Number(lat.toFixed(2)),
        lng: Number(lng.toFixed(2)),
        city: loc.city || 'Unknown',
        region: loc.region || 'Unknown',
        country,
        source: session.gpsLocation ? 'gps' : (loc.source || 'ip'),
        count: 0,
      };
      current.count += 1;
      buckets.set(key, current);
    }

    const density = Array.from(buckets.values()).sort((a, b) => b.count - a.count);

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        totalSessions: (sessions || []).length,
        bucketCount: density.length,
        topCountries: topObjectEntries(byCountry, 20),
        buckets: density.slice(0, 500),
      },
    });
  } catch (error) {
    console.error('❌ Error in /api/admin/geo-density:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch geo density',
      message: error.message,
    });
  }
});

module.exports = router;
