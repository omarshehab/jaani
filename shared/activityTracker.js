/**
 * JAANI Activity Tracker - Clean & Simple
 * 
 * Features:
 * - Session tracking with unique IDs
 * - Accurate IP geolocation (multiple services)
 * - Device detection
 * - Daily CSV reports
 * - File locking for concurrent writes
 */

const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const lockfile = require('proper-lockfile');

// Optional dependencies
let geoip, UAParser;
try { geoip = require('geoip-lite'); } catch (e) { console.log('geoip-lite not available'); }
try { UAParser = require('ua-parser-js'); } catch (e) { console.log('ua-parser-js not available'); }

// Paths
const DATA_DIR = path.join(__dirname, 'activity_tracking');
const USERS_DIR = path.join(DATA_DIR, 'users'); // New: User-specific folders by IP hash
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions'); // Legacy: kept for backward compatibility
const LOGS_DIR = path.join(DATA_DIR, 'daily_logs'); // Legacy: kept for backward compatibility
const CSV_DIR = path.join(DATA_DIR, 'daily_logs_csv');
const TEXT_REPORTS_DIR = path.join(DATA_DIR, 'daily_text_reports');

const SESSION_PERSIST_MIN_INTERVAL_MS = parseInt(process.env.SESSION_PERSIST_MIN_INTERVAL_MS || '2000', 10);
const CSV_GENERATION_MIN_INTERVAL_MS = parseInt(process.env.CSV_GENERATION_MIN_INTERVAL_MS || '120000', 10);
const DESCRIPTION_WRITE_DEBOUNCE_MS = parseInt(process.env.DESCRIPTION_WRITE_DEBOUNCE_MS || '12000', 10);
const DESCRIPTION_WRITE_MIN_INTERVAL_MS = parseInt(process.env.DESCRIPTION_WRITE_MIN_INTERVAL_MS || '30000', 10);

class ActivityTracker {
  constructor() {
    this.sessions = new Map();
    this.locationCache = new Map();
    this.descriptionDebounceTimers = new Map();
    this.lastDescriptionWrittenAt = new Map();
    this.lastCsvGeneratedAt = 0;
    this.csvGenerationInFlight = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    
    // Create directories (includes new USERS_DIR for per-user folders)
    for (const dir of [DATA_DIR, USERS_DIR, SESSIONS_DIR, LOGS_DIR, CSV_DIR, TEXT_REPORTS_DIR]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    
    this.initialized = true;
    console.log('✅ Activity Tracker initialized with user-based folder structure');
  }

  // Get session data (in-memory first, then disk)
  async getSessionById(sessionId) {
    if (!sessionId) return null;

    const inMemory = this.sessions.get(sessionId);
    if (inMemory) return inMemory;

    try {
      const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
      if (!fs.existsSync(file)) return null;
      const raw = await fsPromises.readFile(file, 'utf-8');
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  // Generate session ID
  generateSessionId() {
    return 'sess_' + crypto.randomBytes(8).toString('hex');
  }

  // Get or create user directory based on IP hash
  getUserDirectory(ipHash) {
    const userDir = path.join(USERS_DIR, ipHash);
    const userSessionsDir = path.join(userDir, 'sessions');
    const userLogsDir = path.join(userDir, 'activity_logs');
    const userDescriptionsDir = path.join(userDir, 'descriptions');
    
    // Create user directories if they don't exist
    for (const dir of [userDir, userSessionsDir, userLogsDir, userDescriptionsDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    
    return {
      userDir,
      sessionsDir: userSessionsDir,
      logsDir: userLogsDir,
      descriptionsDir: userDescriptionsDir
    };
  }

  // Get client IP
  getClientIP(req) {
    return req.clientIp || 
           req.ip || 
           req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           'unknown';
  }

  // Check if local IP
  isLocalIP(ip) {
    if (!ip || ip === 'unknown') return true;
    return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' ||
           ip.startsWith('192.168.') || ip.startsWith('10.') ||
           ip.startsWith('172.16.') || ip.startsWith('172.17.') ||
           ip.startsWith('172.18.') || ip.startsWith('172.19.') ||
           ip.startsWith('172.2') || ip.startsWith('172.30.') ||
           ip.startsWith('172.31.') || ip === '::ffff:127.0.0.1';
  }

  // Get accurate location from IP
  async getLocation(ip) {
    // Check cache first
    const cached = this.locationCache.get(ip);
    if (cached && Date.now() - cached.timestamp < 3600000) {
      return cached.location;
    }

    // Local IP
    if (this.isLocalIP(ip)) {
      return {
        country: 'Local Network',
        countryCode: 'LOCAL',
        region: 'Local',
        city: 'Localhost',
        latitude: null,
        longitude: null,
        source: 'local',
        isLocal: true
      };
    }

    console.log(`🌍 Getting location for IP: ${ip}`);

    // Try online services FIRST (more accurate)
    const services = [
      // ip-api.com - most reliable, free
      async () => {
        const r = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city,lat,lon,isp,org,timezone`, { timeout: 5000 });
        if (r.data.status === 'success') {
          return {
            country: r.data.country,
            countryCode: r.data.countryCode,
            region: r.data.regionName,
            city: r.data.city,
            latitude: r.data.lat,
            longitude: r.data.lon,
            isp: r.data.isp,
            org: r.data.org,
            timezone: r.data.timezone,
            source: 'ip-api.com'
          };
        }
        return null;
      },
      // ipwho.is - good accuracy
      async () => {
        const r = await axios.get(`https://ipwho.is/${ip}`, { timeout: 5000 });
        if (r.data && r.data.success) {
          return {
            country: r.data.country,
            countryCode: r.data.country_code,
            region: r.data.region,
            city: r.data.city,
            latitude: r.data.latitude,
            longitude: r.data.longitude,
            isp: r.data.connection?.isp,
            org: r.data.connection?.org,
            timezone: r.data.timezone?.id,
            source: 'ipwho.is'
          };
        }
        return null;
      },
      // ipapi.co - backup
      async () => {
        const r = await axios.get(`https://ipapi.co/${ip}/json/`, { timeout: 5000 });
        if (r.data && !r.data.error) {
          return {
            country: r.data.country_name,
            countryCode: r.data.country_code,
            region: r.data.region,
            city: r.data.city,
            latitude: r.data.latitude,
            longitude: r.data.longitude,
            isp: r.data.org,
            org: r.data.org,
            timezone: r.data.timezone,
            source: 'ipapi.co'
          };
        }
        return null;
      }
    ];

    // Try each service
    for (const service of services) {
      try {
        const result = await service();
        if (result && result.latitude && result.longitude) {
          console.log(`📍 Location: ${result.city}, ${result.country} (${result.source})`);
          console.log(`   Coordinates: ${result.latitude}, ${result.longitude}`);
          
          // Cache it
          this.locationCache.set(ip, { location: result, timestamp: Date.now() });
          return result;
        }
      } catch (e) {
        continue; // Try next service
      }
    }

    // Fallback to geoip-lite (offline)
    if (geoip) {
      try {
        const geo = geoip.lookup(ip);
        if (geo) {
          const result = {
            country: geo.country,
            countryCode: geo.country,
            region: geo.region,
            city: geo.city,
            latitude: geo.ll?.[0],
            longitude: geo.ll?.[1],
            timezone: geo.timezone,
            source: 'geoip-lite'
          };
          console.log(`📍 Location (fallback): ${result.city}, ${result.country}`);
          this.locationCache.set(ip, { location: result, timestamp: Date.now() });
          return result;
        }
      } catch (e) {}
    }

    // Nothing worked
    return {
      country: 'Unknown',
      countryCode: 'XX',
      region: 'Unknown',
      city: 'Unknown',
      latitude: null,
      longitude: null,
      source: 'none'
    };
  }

  // Parse device info
  getDeviceInfo(req) {
    const ua = req.headers['user-agent'] || '';
    
    if (UAParser) {
      const parser = new UAParser(ua);
      const result = parser.getResult();
      return {
        browser: result.browser.name || 'Unknown',
        browserVersion: result.browser.version || '',
        os: result.os.name || 'Unknown',
        osVersion: result.os.version || '',
        device: result.device.type || 'desktop',
        deviceVendor: result.device.vendor || '',
        deviceModel: result.device.model || '',
        isMobile: result.device.type === 'mobile',
        isTablet: result.device.type === 'tablet',
        isDesktop: !result.device.type || result.device.type === 'desktop',
        userAgent: ua.substring(0, 200)
      };
    }

    // Basic detection without ua-parser-js
    return {
      browser: 'Unknown',
      os: 'Unknown',
      device: ua.includes('Mobile') ? 'mobile' : 'desktop',
      isMobile: ua.includes('Mobile'),
      isDesktop: !ua.includes('Mobile'),
      userAgent: ua.substring(0, 200)
    };
  }

  // Track session
  async trackSession(req) {
    await this.initialize();
    
    let sessionId = req.cookies?.sessionId || req.headers?.['x-session-id'];
    let session = sessionId ? await this.getSessionById(sessionId) : null;

    if (session && !this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, session);
    }

    if (!session) {
      if (!sessionId) {
        sessionId = this.generateSessionId();
      }
      const ip = this.getClientIP(req);
      const location = await this.getLocation(ip);
      const device = this.getDeviceInfo(req);

      session = {
        sessionId,
        ip,
        ipHash: crypto.createHash('md5').update(ip).digest('hex'),
        location,
        device,
        startTime: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        activities: [],
        pageViews: 0
      };

      this.sessions.set(sessionId, session);
      await this.saveSession(sessionId, session);
      
      console.log(`🆕 New session: ${sessionId} from ${location.city}, ${location.country}`);
    } else {
      session.lastActivity = new Date().toISOString();
    }

    return { sessionId, session };
  }

  // Log activity
  async logActivity(sessionId, type, details = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const activity = {
      id: crypto.randomBytes(4).toString('hex'),
      type,
      timestamp: new Date().toISOString(),
      details,
      ip: session.ip,
      location: session.location
    };

    session.activities.push(activity);
    session.lastActivity = activity.timestamp;
    if (type === 'page_view') session.pageViews++;

    // Save to daily log
    await this.saveDailyLog(activity, sessionId);
    
    // Update session file
    await this.saveSession(sessionId, session);

    // Generate CSV periodically, but throttle to reduce heavy file I/O churn.
    if (session.activities.length % 10 === 0) {
      this.requestCsvGeneration().catch(() => {});
    }
  }

  // Save session to file (both legacy and user-specific locations)
  async saveSession(sessionId, session, options = {}) {
    try {
      const force = Boolean(options.force);
      const now = Date.now();
      const lastPersistAt = Number(session?._lastPersistAt || 0);
      if (!force && lastPersistAt && now - lastPersistAt < SESSION_PERSIST_MIN_INTERVAL_MS) {
        this.scheduleUserActivityDescription(session);
        return;
      }

      session._lastPersistAt = now;

      // Save to legacy location for backward compatibility
      const legacyFile = path.join(SESSIONS_DIR, `${sessionId}.json`);
      await fsPromises.writeFile(legacyFile, JSON.stringify(session, null, 2));
      
      // Save to user-specific location (new structure)
      if (session.ipHash) {
        const userDirs = this.getUserDirectory(session.ipHash);
        const userFile = path.join(userDirs.sessionsDir, `${sessionId}.json`);
        await fsPromises.writeFile(userFile, JSON.stringify(session, null, 2));

        // Generate comprehensive text descriptions asynchronously and at a safe cadence.
        this.scheduleUserActivityDescription(session);
      }
    } catch (e) {
      console.error('Save session error:', e.message);
    }
  }

  scheduleUserActivityDescription(session) {
    if (!session || !session.ipHash || !session.sessionId) return;

    const sid = session.sessionId;
    const now = Date.now();
    const lastWrittenAt = this.lastDescriptionWrittenAt.get(sid) || 0;
    if (now - lastWrittenAt < DESCRIPTION_WRITE_MIN_INTERVAL_MS) {
      return;
    }

    const existingTimer = this.descriptionDebounceTimers.get(sid);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      try {
        await this.generateUserActivityDescription(session);
        this.lastDescriptionWrittenAt.set(sid, Date.now());
      } catch {
        // Best-effort only
      } finally {
        this.descriptionDebounceTimers.delete(sid);
      }
    }, DESCRIPTION_WRITE_DEBOUNCE_MS);

    this.descriptionDebounceTimers.set(sid, timer);
  }

  async requestCsvGeneration(date = null, options = {}) {
    const force = Boolean(options.force);
    const now = Date.now();

    if (!force && this.lastCsvGeneratedAt && (now - this.lastCsvGeneratedAt) < CSV_GENERATION_MIN_INTERVAL_MS) {
      return null;
    }

    if (this.csvGenerationInFlight) {
      return this.csvGenerationInFlight;
    }

    this.csvGenerationInFlight = this.generateDailyCSV(date)
      .catch(() => null)
      .finally(() => {
        this.lastCsvGeneratedAt = Date.now();
        this.csvGenerationInFlight = null;
      });

    return this.csvGenerationInFlight;
  }

  // Save to daily log (both legacy and user-specific locations)
  async saveDailyLog(activity, sessionId) {
    try {
      const date = new Date().toISOString().split('T')[0];
      
      // Save to legacy location for backward compatibility
      const legacyFile = path.join(LOGS_DIR, `${date}.json`);
      let logs = [];
      if (fs.existsSync(legacyFile)) {
        const raw = fs.readFileSync(legacyFile, 'utf-8');
        try {
          logs = JSON.parse(raw);
        } catch (parseError) {
          logs = [];
        }
      }
      logs.push({ ...activity, sessionId });
      await fsPromises.writeFile(legacyFile, JSON.stringify(logs, null, 2));
      
      // Save to user-specific location (new structure)
      const session = this.sessions.get(sessionId);
      if (session && session.ipHash) {
        const userDirs = this.getUserDirectory(session.ipHash);
        const userLogFile = path.join(userDirs.logsDir, `${date}.json`);
        
        let userLogs = [];
        if (fs.existsSync(userLogFile)) {
          const raw = fs.readFileSync(userLogFile, 'utf-8');
          try {
            userLogs = JSON.parse(raw);
          } catch (parseError) {
            userLogs = [];
          }
        }
        userLogs.push({ ...activity, sessionId });
        await fsPromises.writeFile(userLogFile, JSON.stringify(userLogs, null, 2));
      }
    } catch (e) {
      console.error('Save daily log error:', e.message);
    }
  }

  // Generate daily CSV report
  async generateDailyCSV(date = null) {
    await this.initialize();
    
    date = date || new Date().toISOString().split('T')[0];
    const logFile = path.join(LOGS_DIR, `${date}.json`);
    const csvFile = path.join(CSV_DIR, `${date}_detailed_report.csv`);

    if (!fs.existsSync(logFile)) return null;

    try {
      const activities = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
      if (!activities.length) return null;

      // Group by session
      const sessionMap = new Map();
      for (const act of activities) {
        const sid = act.sessionId || 'unknown';
        if (!sessionMap.has(sid)) sessionMap.set(sid, []);
        sessionMap.get(sid).push(act);
      }

      // CSV headers
      const headers = [
        'Session ID', 'Start', 'End', 'Duration (min)', 'Page Views',
        'IP Address', 'IP Hash', 'Country', 'Region', 'City',
        'Latitude', 'Longitude', 'Maps Link', 'Source',
        'Device', 'Browser', 'OS', 'User Agent', 'Activity Summary'
      ];

      // Generate rows
      const rows = [];
      for (const [sid, acts] of sessionMap) {
        acts.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        
        const first = acts[0];
        const last = acts[acts.length - 1];
        const loc = first.location || {};
        
        const duration = ((new Date(last.timestamp) - new Date(first.timestamp)) / 60000).toFixed(2);
        const pageViews = acts.filter(a => a.type === 'page_view').length;
        
        // Format coordinates with 6 decimals
        const lat = Number.isFinite(Number(loc.latitude)) ? Number(loc.latitude).toFixed(6) : 'N/A';
        const lon = Number.isFinite(Number(loc.longitude)) ? Number(loc.longitude).toFixed(6) : 'N/A';
        const mapsLink = lat !== 'N/A' && lon !== 'N/A' 
          ? `https://www.google.com/maps/@${lat},${lon},17z` 
          : 'N/A';

        // Activity summary
        const summary = Object.entries(
          acts.reduce((acc, a) => { acc[a.type] = (acc[a.type] || 0) + 1; return acc; }, {})
        ).map(([k, v]) => `${k}: ${v}`).join(', ');

        rows.push([
          sid,
          first.timestamp,
          last.timestamp,
          duration,
          pageViews,
          first.ip || 'N/A',
          crypto.createHash('md5').update(first.ip || '').digest('hex').substring(0, 16),
          loc.country || 'N/A',
          loc.region || 'N/A',
          loc.city || 'N/A',
          lat,
          lon,
          mapsLink,
          loc.source || 'N/A',
          first.device?.device || 'N/A',
          first.device?.browser || 'N/A',
          first.device?.os || 'N/A',
          (first.device?.userAgent || '').substring(0, 100),
          summary
        ].map(v => this.escapeCSV(v)));
      }

      // Write CSV with locking
      const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
      
      if (!fs.existsSync(csvFile)) {
        fs.writeFileSync(csvFile, '', 'utf-8');
      }

      let release;
      try {
        release = await lockfile.lock(csvFile, { retries: 3 });
        fs.writeFileSync(csvFile, csv, 'utf-8');
        console.log(`📊 CSV generated: ${csvFile}`);
      } finally {
        if (release) await release();
      }

      return csvFile;
    } catch (e) {
      console.error('CSV generation error:', e.message);
      return null;
    }
  }

  // Escape CSV value
  escapeCSV(val) {
    if (val === null || val === undefined) return 'N/A';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  // Get stats
  async getStats() {
    return {
      activeSessions: this.sessions.size,
      cachedLocations: this.locationCache.size,
      timestamp: new Date().toISOString()
    };
  }

  // Alias for backward compatibility
  async getStatistics() {
    return this.getStats();
  }

  // Get today's activities
  async getTodayActivities() {
    const date = new Date().toISOString().split('T')[0];
    const file = path.join(LOGS_DIR, `${date}.json`);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
    return [];
  }

  // Get all activities (optionally filtered by date)
  async getAllActivities(dateFilter = null) {
    if (dateFilter) {
      const file = path.join(LOGS_DIR, `${dateFilter}.json`);
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
      }
      return [];
    }
    // Return all activities from all log files
    const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.json'));
    let all = [];
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(LOGS_DIR, f), 'utf-8'));
      all = all.concat(data);
    }
    return all;
  }

  // Get all sessions
  async getAllSessions() {
    const sessions = [];
    if (fs.existsSync(SESSIONS_DIR)) {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
          sessions.push(data);
        } catch (e) {}
      }
    }
    return sessions;
  }

  // Get all unique visitors (by IP hash)
  async getAllVisitors() {
    const sessions = await this.getAllSessions();
    const visitors = new Map();
    
    for (const s of sessions) {
      const key = s.ipHash || s.ip;
      if (!visitors.has(key)) {
        visitors.set(key, {
          ipHash: s.ipHash,
          location: s.location,
          firstVisit: s.startTime,
          lastVisit: s.lastActivity,
          totalVisits: 1,
          accessMethod: s.location?.isLocal ? 'Local' : 'Remote'
        });
      } else {
        const v = visitors.get(key);
        v.totalVisits++;
        if (new Date(s.lastActivity) > new Date(v.lastVisit)) {
          v.lastVisit = s.lastActivity;
        }
      }
    }
    
    return Array.from(visitors.values());
  }

  // Get summary
  async getSummary() {
    const sessions = await this.getAllSessions();
    const activities = await this.getTodayActivities();
    
    return {
      totalSessions: sessions.length,
      todayActivities: activities.length,
      activeSessions: this.sessions.size,
      timestamp: new Date().toISOString()
    };
  }

  // Generate daily CSV (alias for backward compatibility)
  async generateDailyCSVReport(date = null) {
    return this.generateDailyCSV(date);
  }

  // Update viewport (called from frontend)
  async updateViewport(sessionId, data) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.viewport = data;
      await this.saveSession(sessionId, session);
    }
  }

  // Update GPS location (called from frontend - now unused)
  async updateGPSLocation(sessionId, gpsData) {
    const session = (await this.getSessionById(sessionId)) || this.sessions.get(sessionId);
    const lat = Number(gpsData?.lat ?? gpsData?.latitude);
    const lng = Number(gpsData?.lng ?? gpsData?.longitude);
    const accuracy = gpsData?.accuracy == null ? null : Number(gpsData.accuracy);
    const source = gpsData?.source || 'browser';
    const timestamp = Number(gpsData?.timestamp);

    const isValidSafetyGPS = (candidateLat, candidateLng, candidateAccuracy) => {
      if (!Number.isFinite(candidateLat) || !Number.isFinite(candidateLng)) return false;
      if (Math.abs(candidateLat) > 90 || Math.abs(candidateLng) > 180) return false;
      if (!Number.isFinite(candidateAccuracy)) return false;
      return candidateAccuracy <= 30;
    };

    const classifyAccuracy = (meters) => {
      if (meters == null) return 'unknown';
      if (meters <= 10) return 'gps_high';
      if (meters <= 30) return 'gps_medium';
      if (meters <= 100) return 'gps_low';
      if (meters <= 500) return 'network_approx';
      return 'region_only';
    };

    const haversineMeters = (lat1, lon1, lat2, lon2) => {
      const toRad = (d) => (d * Math.PI) / 180;
      const R = 6371000;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    };

    if (!session || !Number.isFinite(lat) || !Number.isFinite(lng)) return { updated: false };
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return { updated: false, flagged: true, reason: 'out_of_bounds' };

    const ts = Number.isFinite(timestamp) ? timestamp : Date.now();
    const confidence = classifyAccuracy(Number.isFinite(accuracy) ? accuracy : null);

    // HARD SAFETY RULE: only accept GPS if accuracy is safety-grade (<= 30m). Everything else is treated as NO LOCATION.
    if (!isValidSafetyGPS(lat, lng, accuracy)) {
      session.gpsStatus = 'gps_required';
      session.gpsLocationRejected = {
        lat,
        lng,
        accuracy: Number.isFinite(accuracy) ? accuracy : null,
        confidence,
        source,
        timestamp: ts,
        rejected: true,
        rejectReason: 'accuracy_not_safety_grade'
      };
      await this.saveSession(sessionId, session);
      return { updated: false, flagged: true, reason: 'accuracy_not_safety_grade' };
    }

    // Jump detection (flag/reject): >1km within <60s
    const prev = session.gpsLocation;
    if (prev && Number.isFinite(Number(prev.lat)) && Number.isFinite(Number(prev.lng)) && Number.isFinite(Number(prev.timestamp))) {
      const deltaMs = ts - Number(prev.timestamp);
      if (deltaMs > 0 && deltaMs < 60000) {
        const dist = haversineMeters(Number(prev.lat), Number(prev.lng), lat, lng);
        if (dist > 1000) {
          session.gpsLocationFlagged = {
            lat,
            lng,
            accuracy: Number.isFinite(accuracy) ? accuracy : null,
            confidence,
            source,
            timestamp: ts,
            flagged: true,
            flagReason: 'jump_detected',
            jumpDistanceMeters: dist,
            jumpDeltaMs: deltaMs
          };
          await this.saveSession(sessionId, session);
          return { updated: false, flagged: true, reason: 'jump_detected' };
        }
      }
    }

    // Safety-grade record (do not overwrite IP-derived location coords)
    session.gpsLocation = {
      lat,
      lng,
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
      confidence,
      source,
      timestamp: ts
    };

    session.gpsStatus = 'ok';

    await this.saveSession(sessionId, session);
    console.log(`📍 GPS updated for ${sessionId}: ${lat}, ${lng} (±${session.gpsLocation.accuracy ?? 'unknown'}m, ${confidence})`);
    return { updated: true };
  }

  // Update engagement metrics
  async updateEngagement(sessionId, engagement) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.engagement = engagement;
      await this.saveSession(sessionId, session);
    }
  }

  // Update performance metrics
  async updatePerformance(sessionId, performance) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.performance = performance;
      await this.saveSession(sessionId, session);
    }
  }

  // Short JSON helper for timeline descriptions
  compactDetails(details, maxLength = 180) {
    try {
      const str = JSON.stringify(details);
      if (str.length <= maxLength) return str;
      return str.substring(0, maxLength - 3) + '...';
    } catch (e) {
      return '[unavailable details]';
    }
  }

  // Convert activities into human-readable sentences
  describeActivity(activity) {
    const details = activity.details || {};
    switch (activity.type) {
      case 'page_view':
        return `Page view → ${details.path || details.url || details.href || 'unknown route'}`;
      case 'click':
        return `Click on ${details.selector || details.text || 'an element'} at (${details.x || '?'}, ${details.y || '?'})`; 
      case 'mouse_movement':
        return `Mouse movement (${details.positions?.length || 0} samples, avg x=${details.averageX || '?'} y=${details.averageY || '?'})`;
      case 'scroll_start':
      case 'scroll_end':
        return `${activity.type.replace('_', ' ')} at ${details.scrollY ?? 'unknown'}px (depth ${details.scrollDepth ?? 'N/A'}%)`;
      case 'idle_start':
      case 'idle_end':
        return activity.type === 'idle_start' ? 'User became idle' : 'User resumed activity';
      case 'window_focus':
        return `Window focus changed → ${details.state || 'unknown'}`;
      case 'visibility_change':
        return `Visibility changed → ${details.visibility}`;
      case 'gps_update':
        return `GPS update (${details.latitude}, ${details.longitude}, accuracy ${details.accuracy || 'N/A'}m)`;
      default:
        return `${activity.type} → ${this.compactDetails(details)}`;
    }
  }

  // Generate plain-text per-session reports
  async generateDailyTextReports(date = null, { timelineLimit = 50 } = {}) {
    await this.initialize();

    const targetDate = date || new Date().toISOString().split('T')[0];
    const logFile = path.join(LOGS_DIR, `${targetDate}.json`);
    if (!fs.existsSync(logFile)) {
      return [];
    }

    const activities = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
    if (!activities.length) return [];

    const sessionMap = new Map();
    for (const act of activities) {
      const sid = act.sessionId || 'unknown';
      if (!sessionMap.has(sid)) sessionMap.set(sid, []);
      sessionMap.get(sid).push(act);
    }

    const dailyDir = path.join(TEXT_REPORTS_DIR, targetDate);
    if (!fs.existsSync(dailyDir)) {
      fs.mkdirSync(dailyDir, { recursive: true });
    }

    const reportPaths = [];

    for (const [sid, acts] of sessionMap.entries()) {
      acts.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      const first = acts[0];
      const last = acts[acts.length - 1];
      const durationMin = ((new Date(last.timestamp) - new Date(first.timestamp)) / 60000).toFixed(2);
      const activitySummary = Object.entries(
        acts.reduce((acc, act) => {
          acc[act.type] = (acc[act.type] || 0) + 1;
          return acc;
        }, {})
      ).sort((a, b) => b[1] - a[1]);

      const location = first.location || {};
      const device = first.device || {};
      const headers = first.headers || {};
      const lat = Number.isFinite(Number(location.latitude)) ? String(location.latitude) : 'N/A';
      const lon = Number.isFinite(Number(location.longitude)) ? String(location.longitude) : 'N/A';
      const mapsLink = lat !== 'N/A' && lon !== 'N/A'
        ? `https://www.google.com/maps/@${lat},${lon},17z`
        : 'N/A';

      const lines = [];
      lines.push('JAANI Activity Report');
      lines.push(`Date            : ${targetDate}`);
      lines.push(`Session ID      : ${sid}`);
      lines.push(`Total Activities: ${acts.length}`);
      lines.push(`Duration (min)  : ${durationMin}`);
      lines.push(`Page Views      : ${activitySummary.find(([type]) => type === 'page_view')?.[1] || 0}`);
      lines.push('');
      lines.push(`IP Address      : ${first.ip || 'N/A'}`);
      lines.push(`Location        : ${location.city || 'Unknown'}, ${location.region || 'Unknown'}, ${location.country || 'Unknown'}`);
      lines.push(`Coordinates     : ${lat}, ${lon}`);
      lines.push(`Location Source : ${location.source || 'N/A'}`);
      lines.push(`Maps Link       : ${mapsLink}`);
      lines.push('');
      lines.push(`Device          : ${device.device?.type || 'Unknown'} (${device.device?.vendor || 'Unknown'} ${device.device?.model || ''})`.trim());
      lines.push(`Browser         : ${device.browser?.name || 'Unknown'} ${device.browser?.version || ''}`.trim());
      lines.push(`Operating System: ${device.os?.name || 'Unknown'} ${device.os?.version || ''}`.trim());
      lines.push(`User Agent      : ${(device.userAgent || '').substring(0, 200) || 'N/A'}`);
      lines.push(`Language        : ${headers.acceptLanguage || 'N/A'}`);
      lines.push(`First Referrer  : ${headers.referer || 'Direct/None'}`);
      lines.push('');
      lines.push('Activity Summary:');
      if (activitySummary.length === 0) {
        lines.push('  (no events recorded)');
      } else {
        for (const [type, count] of activitySummary) {
          lines.push(`  - ${type}: ${count}`);
        }
      }
      lines.push('');
      lines.push('Activity Timeline:');

      acts.forEach((act, index) => {
        if (index >= timelineLimit) return;
        lines.push(`  • ${act.timestamp} → ${this.describeActivity(act)}`);
      });

      if (acts.length > timelineLimit) {
        lines.push(`  • ... ${acts.length - timelineLimit} additional events not shown`);
      }

      const reportPath = path.join(dailyDir, `${sid}.txt`);
      await fsPromises.writeFile(reportPath, lines.join('\n'), 'utf-8');
      reportPaths.push(reportPath);
    }

    console.log(`📝 Generated ${reportPaths.length} text report(s) for ${targetDate}`);
    return reportPaths;
  }

  /**
   * Generate comprehensive text description of user activities
   * Creates a detailed report of a specific session in user's descriptions folder
   * This is called every time a session is saved
   */
  async generateUserActivityDescription(session) {
    if (!session || !session.ipHash) return;
    
    try {
      const userDirs = this.getUserDirectory(session.ipHash);
      const descFile = path.join(userDirs.descriptionsDir, `${session.sessionId}.txt`);
      
      // Build comprehensive description
      const lines = [];
      lines.push('═'.repeat(80));
      lines.push('JAANI USER ACTIVITY REPORT - COMPREHENSIVE SESSION DESCRIPTION');
      lines.push('═'.repeat(80));
      lines.push('');
      
      // Session Overview
      lines.push('SESSION OVERVIEW');
      lines.push('-'.repeat(80));
      lines.push(`Session ID       : ${session.sessionId}`);
      lines.push(`User Identifier  : ${session.ipHash} (IP-based UUID)`);
      lines.push(`Session Start    : ${session.startTime}`);
      lines.push(`Last Activity    : ${session.lastActivity}`);
      
      const startTime = new Date(session.startTime);
      const lastTime = new Date(session.lastActivity);
      const durationMs = lastTime - startTime;
      const durationMin = (durationMs / 60000).toFixed(2);
      const durationSec = (durationMs / 1000).toFixed(1);
      lines.push(`Session Duration : ${durationMin} minutes (${durationSec} seconds)`);
      lines.push(`Total Page Views : ${session.pageViews || 0}`);
      lines.push(`Total Activities : ${session.activities?.length || 0}`);
      lines.push('');
      
      // User Identity & Location
      lines.push('USER IDENTITY & LOCATION');
      lines.push('-'.repeat(80));
      lines.push(`IP Address       : ${session.ip || 'Unknown'}`);
      lines.push(`IP Hash (UUID)   : ${session.ipHash}`);
      
      const loc = session.location || {};
      lines.push(`Country          : ${loc.country || 'Unknown'}`);
      lines.push(`Region/State     : ${loc.region || 'Unknown'}`);
      lines.push(`City             : ${loc.city || 'Unknown'}`);
      
      if (loc.latitude && loc.longitude) {
        lines.push(`GPS Coordinates  : ${loc.latitude}, ${loc.longitude}`);
        lines.push(`Google Maps      : https://www.google.com/maps/@${loc.latitude},${loc.longitude},17z`);
      } else {
        lines.push(`GPS Coordinates  : Not available (using IP-based location)`);
      }
      
      lines.push(`Location Source  : ${loc.source || 'Unknown'}`);
      lines.push(`Timezone         : ${loc.timezone || 'Unknown'}`);
      lines.push('');
      
      // GPS Tracking (if available)
      if (session.gpsLatitude && session.gpsLongitude) {
        lines.push('PRECISE GPS TRACKING');
        lines.push('-'.repeat(80));
        lines.push(`GPS Latitude     : ${session.gpsLatitude}`);
        lines.push(`GPS Longitude    : ${session.gpsLongitude}`);
        lines.push(`GPS Accuracy     : ${session.gpsAccuracy ? session.gpsAccuracy + ' meters' : 'Unknown'}`);
        lines.push(`GPS Timestamp    : ${session.gpsTimestamp || 'Unknown'}`);
        lines.push(`GPS Google Maps  : https://www.google.com/maps/@${session.gpsLatitude},${session.gpsLongitude},17z`);
        lines.push('');
      }
      
      // Device Information
      lines.push('DEVICE INFORMATION');
      lines.push('-'.repeat(80));
      const dev = session.device || {};
      lines.push(`Device Type      : ${dev.device || 'Unknown'}`);
      lines.push(`Device Vendor    : ${dev.deviceVendor || 'Unknown'}`);
      lines.push(`Device Model     : ${dev.deviceModel || 'Unknown'}`);
      lines.push(`Browser          : ${dev.browser || 'Unknown'} ${dev.browserVersion || ''}`);
      lines.push(`Operating System : ${dev.os || 'Unknown'} ${dev.osVersion || ''}`);
      lines.push(`Is Mobile        : ${dev.isMobile ? 'Yes' : 'No'}`);
      lines.push(`Is Tablet        : ${dev.isTablet ? 'Yes' : 'No'}`);
      lines.push(`Is Desktop       : ${dev.isDesktop ? 'Yes' : 'No'}`);
      lines.push(`User Agent       : ${(dev.userAgent || '').substring(0, 200) || 'Unknown'}`);
      lines.push('');
      
      // Activity Summary
      lines.push('ACTIVITY SUMMARY');
      lines.push('-'.repeat(80));
      
      if (!session.activities || session.activities.length === 0) {
        lines.push('No activities recorded yet.');
      } else {
        // Group activities by type
        const activityCounts = {};
        session.activities.forEach(act => {
          activityCounts[act.type] = (activityCounts[act.type] || 0) + 1;
        });
        
        // Sort by count (descending)
        const sorted = Object.entries(activityCounts).sort((a, b) => b[1] - a[1]);
        
        lines.push('Activity Type Breakdown:');
        sorted.forEach(([type, count]) => {
          const percentage = ((count / session.activities.length) * 100).toFixed(1);
          lines.push(`  • ${type.padEnd(25)} : ${count.toString().padStart(5)} occurrences (${percentage}%)`);
        });
        lines.push('');
        
        // Detailed Activity Timeline
        lines.push('DETAILED ACTIVITY TIMELINE');
        lines.push('-'.repeat(80));
        
        session.activities.forEach((act, index) => {
          const num = (index + 1).toString().padStart(4, ' ');
          const time = act.timestamp || 'Unknown time';
          const type = (act.type || 'unknown').toUpperCase();
          
          lines.push(`[${num}] ${time} - ${type}`);
          
          // Add details based on activity type
          if (act.details) {
            const details = act.details;
            
            if (details.path) {
              lines.push(`      Path: ${details.path}`);
            }
            if (details.method) {
              lines.push(`      Method: ${details.method}`);
            }
            if (details.query && Object.keys(details.query).length > 0) {
              lines.push(`      Query: ${JSON.stringify(details.query)}`);
            }
            if (details.url) {
              lines.push(`      URL: ${details.url}`);
            }
            if (details.elementType) {
              lines.push(`      Element: ${details.elementType}`);
            }
            if (details.text) {
              lines.push(`      Text: ${details.text.substring(0, 100)}`);
            }
            if (details.x !== undefined && details.y !== undefined) {
              lines.push(`      Coordinates: (${details.x}, ${details.y})`);
            }
            if (details.scrollDepth !== undefined) {
              lines.push(`      Scroll Depth: ${details.scrollDepth}%`);
            }
            if (details.eventType) {
              lines.push(`      Event Type: ${details.eventType}`);
            }
            if (details.customData) {
              lines.push(`      Custom Data: ${JSON.stringify(details.customData).substring(0, 200)}`);
            }
          }
          
          lines.push(''); // Empty line between activities
        });
      }
      
      lines.push('');
      lines.push('═'.repeat(80));
      lines.push('END OF REPORT');
      lines.push('═'.repeat(80));
      
      // Write to file
      await fsPromises.writeFile(descFile, lines.join('\n'), 'utf-8');
      
      // Also create/update a master summary file for this user
      await this.updateUserMasterSummary(session);
      
    } catch (e) {
      console.error('Error generating user activity description:', e.message);
    }
  }

  /**
   * Update master summary file for user (all sessions)
   * This file contains a cumulative overview of all user activity
   */
  async updateUserMasterSummary(session) {
    if (!session || !session.ipHash) return;
    
    try {
      const userDirs = this.getUserDirectory(session.ipHash);
      const masterFile = path.join(userDirs.userDir, 'USER_MASTER_SUMMARY.txt');
      
      // Get all sessions for this user
      const userSessions = [];
      const sessionFiles = fs.readdirSync(userDirs.sessionsDir);
      
      for (const file of sessionFiles) {
        if (!file.endsWith('.json')) continue;
        try {
          const sessionData = JSON.parse(fs.readFileSync(path.join(userDirs.sessionsDir, file), 'utf-8'));
          userSessions.push(sessionData);
        } catch (e) {
          // Skip corrupted session files
        }
      }
      
      // Sort by start time
      userSessions.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
      
      const lines = [];
      lines.push('═'.repeat(80));
      lines.push('JAANI USER MASTER SUMMARY - ALL TIME ACTIVITY');
      lines.push('═'.repeat(80));
      lines.push('');
      lines.push(`User Identifier : ${session.ipHash} (IP-based UUID)`);
      lines.push(`Total Sessions  : ${userSessions.length}`);
      lines.push(`Last Updated    : ${new Date().toISOString()}`);
      lines.push('');
      
      // Calculate cumulative statistics
      let totalPageViews = 0;
      let totalActivities = 0;
      let totalDurationMs = 0;
      const allActivityTypes = {};
      
      userSessions.forEach(sess => {
        totalPageViews += sess.pageViews || 0;
        totalActivities += sess.activities?.length || 0;
        
        const start = new Date(sess.startTime);
        const end = new Date(sess.lastActivity);
        totalDurationMs += (end - start);
        
        (sess.activities || []).forEach(act => {
          allActivityTypes[act.type] = (allActivityTypes[act.type] || 0) + 1;
        });
      });
      
      const totalDurationMin = (totalDurationMs / 60000).toFixed(2);
      const totalDurationHours = (totalDurationMs / 3600000).toFixed(2);
      
      lines.push('CUMULATIVE STATISTICS');
      lines.push('-'.repeat(80));
      lines.push(`Total Page Views    : ${totalPageViews}`);
      lines.push(`Total Activities    : ${totalActivities}`);
      lines.push(`Total Time Tracked  : ${totalDurationHours} hours (${totalDurationMin} minutes)`);
      lines.push(`Average Per Session : ${(totalActivities / userSessions.length).toFixed(1)} activities`);
      lines.push('');
      
      // Activity type breakdown
      lines.push('ALL-TIME ACTIVITY BREAKDOWN');
      lines.push('-'.repeat(80));
      const sortedTypes = Object.entries(allActivityTypes).sort((a, b) => b[1] - a[1]);
      sortedTypes.forEach(([type, count]) => {
        const percentage = ((count / totalActivities) * 100).toFixed(1);
        lines.push(`  • ${type.padEnd(25)} : ${count.toString().padStart(6)} (${percentage}%)`);
      });
      lines.push('');
      
      // User location/device info (from latest session)
      const latest = session;
      const loc = latest.location || {};
      const dev = latest.device || {};
      
      lines.push('USER PROFILE (LATEST SESSION)');
      lines.push('-'.repeat(80));
      lines.push(`Location         : ${loc.city || 'Unknown'}, ${loc.region || 'Unknown'}, ${loc.country || 'Unknown'}`);
      lines.push(`Device Type      : ${dev.device || 'Unknown'}`);
      lines.push(`Browser          : ${dev.browser || 'Unknown'}`);
      lines.push(`Operating System : ${dev.os || 'Unknown'}`);
      lines.push('');
      
      // Session history
      lines.push('SESSION HISTORY');
      lines.push('-'.repeat(80));
      userSessions.forEach((sess, index) => {
        const num = (index + 1).toString().padStart(3, ' ');
        const start = sess.startTime;
        const duration = ((new Date(sess.lastActivity) - new Date(sess.startTime)) / 60000).toFixed(1);
        lines.push(`[${num}] ${sess.sessionId} - ${start} (${duration} min, ${sess.pageViews || 0} views, ${sess.activities?.length || 0} activities)`);
      });
      lines.push('');
      
      lines.push('═'.repeat(80));
      lines.push('END OF MASTER SUMMARY');
      lines.push('═'.repeat(80));
      lines.push('');
      lines.push('Note: Individual session reports available in descriptions/ folder');
      
      // Write master summary
      await fsPromises.writeFile(masterFile, lines.join('\n'), 'utf-8');
      
    } catch (e) {
      console.error('Error updating user master summary:', e.message);
    }
  }
}

// Export singleton
module.exports = new ActivityTracker();
