/**
 * ✅ JAANI Backend - Main Server Entry Point
 * 
 * The "Brain" of the JAANI RTI Platform
 * Handles:
 * - Express server setup with security & performance middleware
 * - Local in-memory contact store (no database required)
 * - CORS, helmet, compression, rate limiting
 * - API routing to /api/analyze, /api/verify-contact, /api/send-mail
 * - Graceful shutdown on SIGTERM/SIGINT
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { spawn } = require('child_process');
const path = require('path');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const gpsV2Routes = require('./routes/gps-v2');
const { connectDB } = require('./config/db');
const activityTracker = require('../shared/activityTracker');
const historyManager = require('../shared/historyManager');
const { initializeContactsSingleton } = require('./data/contactLoader');

const app = express();
const PORT = process.env.PORT || 5005;
let mlServiceProcess = null;

// Strong ETag improves conditional GET handling without sending misleading static headers.
app.set('etag', 'strong');

// Trust proxy for rate limiting to work correctly
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'", "http://localhost:5005", "http://127.0.0.1:5005", process.env.ML_SERVICE_URL || "http://localhost:8000"],
    },
  },
}));

// Compression middleware with aggressive settings
app.use(compression({
  level: 6, // Balance between speed and compression
  threshold: 1024, // Only compress responses larger than 1KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// Logging middleware
app.use(morgan('combined'));

// Rate limiting (disabled by default for unlimited local usage)
const enableRateLimit = String(process.env.ENABLE_RATE_LIMIT || '').toLowerCase() === 'true';
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW, 10) || 18000000, // 20x = 300 minutes (was 15 minutes)
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 4000, // 20x (was 200)
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  skipFailedRequests: false
});

if (enableRateLimit) {
  app.use('/api/', limiter);
}

// CORS configuration
const allowAllCors = String(process.env.ALLOW_ALL_CORS || '').toLowerCase() === 'true';
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    const normalizedOrigin = String(origin).replace(/\/+$/, '');
    
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3010',
      'http://localhost:3011',
      'http://localhost:6001',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:6001',
      'https://x-files.vercel.app',
      process.env.FRONTEND_URL
    ].filter(Boolean).map((value) => String(value).replace(/\/+$/, ''));
    
    // Allow all ngrok domains for development
    if (normalizedOrigin.includes('ngrok')) {
      return callback(null, true);
    }

    if (allowAllCors) {
      return callback(null, true);
    }
    
    if (allowedOrigins.includes(normalizedOrigin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  // Let the browser read the evidence download's filename and provenance headers cross-origin.
  exposedHeaders: ['Content-Disposition', 'X-Evidence-Capture-Id', 'X-Evidence-Text-Source', 'X-Evidence-Client-Text-Match', 'X-PDF-SHA256'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Accept-Language',
    'X-Region',
    'X-Session-Id',
    'X-Request-Id'
  ]
};

app.use(cors(corsOptions));

// ─── Bypass Helmet for webview proxy routes (must be BEFORE route mounting) ───
app.use('/api/webview', (req, res, next) => {
  // Override the writeHead to strip security headers right before sending
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = function (statusCode, ...rest) {
    res.removeHeader('Cross-Origin-Embedder-Policy');
    res.removeHeader('Cross-Origin-Opener-Policy');
    res.removeHeader('Cross-Origin-Resource-Policy');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Content-Type-Options');
    res.removeHeader('Origin-Agent-Cluster');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return originalWriteHead(statusCode, ...rest);
  };
  next();
});

// Body parsing middleware (optimized)
app.use(express.json({ 
  limit: '10mb',
  strict: true
}));
app.use(express.urlencoded({ 
  extended: true, 
  limit: '10mb',
  parameterLimit: 10000
}));
app.use(cookieParser());

// Response optimization middleware
app.use((req, res, next) => {
  // Add cache control for static responses
  if (req.method === 'GET' && !req.path.includes('/api/')) {
    res.set('Cache-Control', 'public, max-age=72000'); // 20x = 20 hours (was 1 hour)
  }

  next();
});

// Load request-ip for accurate IP detection
let requestIp;
try {
  requestIp = require('request-ip');
  app.use(requestIp.mw());
  console.log('✅ request-ip middleware enabled for accurate IP detection');
} catch (e) {
  console.warn('⚠️ request-ip not available, using basic IP detection');
}

// Load express-useragent for device detection
let useragent;
try {
  useragent = require('express-useragent');
  app.use(useragent.express());
  console.log('✅ express-useragent middleware enabled for device detection');
} catch (e) {
  console.warn('⚠️ express-useragent not available');
}

app.use(async (req, res, next) => {
  const shouldTrack = req.path.startsWith('/api')
    && !req.path.startsWith('/api/activity/track-events')
    && !req.path.startsWith('/api/activity/update-viewport')
    && !req.path.startsWith('/api/activity/update-location')
    && !req.path.startsWith('/api/health');

  if (!shouldTrack) {
    return next();
  }

  req.sessionId = req.cookies?.sessionId || req.headers['x-session-id'];

  if (!req.sessionId) {
    req.sessionId = activityTracker.generateSessionId();
    res.cookie('sessionId', req.sessionId, {
      httpOnly: false,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }

  setImmediate(async () => {
    try {
      req.cookies = req.cookies || {};
      req.cookies.sessionId = req.sessionId;

      await activityTracker.trackSession(req);
      await historyManager.addActivityEvent({
        type: 'request',
        path: req.originalUrl,
        method: req.method,
        sessionId: req.sessionId,
        ip: req.clientIp || req.ip || 'unknown',
        userAgent: req.headers['user-agent'] || '',
      });
    } catch (error) {
      console.warn('⚠️ Async activity tracking skipped:', error.message);
    }
  });

  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: '✅ JAANI Backend - Brain is active',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    endpoints: {
      analyze: 'POST /api/analyze',
      analyzeText: 'POST /api/analyze-text',
      verify: 'POST /api/verify-contact',
      sendMail: 'POST /api/send-mail',
      activityStats: 'GET /api/activity-stats',
      adminOverview: 'GET /api/admin/overview'
    }
  });
});

// Serve shared assets (e.g., downloaded officer photos) for frontend access
// Frontend (port 3000) loads these from the backend origin; helmet's default CORP same-origin blocks that.
app.use('/shared', (req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, '..', 'shared'), {
  maxAge: '7d',
  etag: true,
}));

// API routes
app.use('/api', apiRoutes);
app.use('/api/admin', adminRoutes);

// GPS v2 routes can be disabled if needed for focused local profiling.
const enableGpsRoutes = String(process.env.ENABLE_GPS_ROUTES || 'true').toLowerCase() !== 'false';
if (enableGpsRoutes) {
  app.use('/api', gpsV2Routes);
}

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  
  // CORS error
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      success: false,
      error: 'CORS policy violation',
      code: 'CORS_ERROR'
    });
  }
  
  // Default error response
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error',
    code: err.code || 'INTERNAL_ERROR',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    code: 'NOT_FOUND',
    path: req.originalUrl
  });
});

// Start server with local in-memory data
const startMLService = () => {
  return new Promise((resolve, reject) => {
    console.log('\n🤖 Starting ML Service...');
    
    const mlServicePath = path.join(__dirname, '..', 'ml-service');
    const venvPath = path.join(__dirname, '..', '.venv');
    const pythonPath = path.join(venvPath, 'Scripts', 'python.exe');
    
    // Check if virtual environment exists
    const fs = require('fs');
    if (!fs.existsSync(pythonPath)) {
      console.log('⚠️  Virtual environment not found at:', venvPath);
      console.log('⚠️  Trying system Python...');
      mlServiceProcess = spawn('python', ['main.py'], {
        cwd: mlServicePath,
        shell: true
      });
    } else {
      console.log('✅ Using virtual environment Python:', pythonPath);
      mlServiceProcess = spawn(pythonPath, ['main.py'], {
        cwd: mlServicePath
      });
    }
    
    let mlStarted = false;
    let hasModuleError = false;
    
    mlServiceProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`[ML Service] ${output.trim()}`);
      
      // Detect when ML service is ready
      if (output.includes('Uvicorn running') || output.includes('Application startup complete')) {
        mlStarted = true;
        resolve();
      }
    });
    
    mlServiceProcess.stderr.on('data', (data) => {
      const output = data.toString();

      // Uvicorn commonly logs readiness to stderr; treat it as ready there too.
      if (!mlStarted && (output.includes('Uvicorn running') || output.includes('Application startup complete'))) {
        mlStarted = true;
        resolve();
      }
      
      // Check for module import errors
      if (output.includes('ModuleNotFoundError') || output.includes('No module named')) {
        hasModuleError = true;
        console.error('❌ [ML Service] PACKAGE NOT INSTALLED:');
        console.error(output.trim());
        console.error('\n💡 SOLUTION: Run this command to install packages:');
        console.error('   install-ml-packages.bat');
        console.error('   (or manually: cd ml-service && pip install -r requirements.txt)\n');
      }
      // Don't log deprecation warnings
      else if (!output.includes('DeprecationWarning') && !output.includes('FutureWarning')) {
        console.log(`[ML Service] ${output.trim()}`);
      }
    });
    
    mlServiceProcess.on('error', (error) => {
      console.error('❌ Failed to start ML Service:', error.message);
      reject(error);
    });
    
    mlServiceProcess.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.log(`\n⚠️  ML Service exited with code ${code}`);
        if (hasModuleError) {
          console.log('\n📦 MISSING PACKAGES DETECTED!');
          console.log('   Quick fix: Run install-ml-packages.bat');
          console.log('   This will install all required Python packages\n');
        }
      }
    });
    
    // Timeout after 120 seconds (models need time to load, especially on first run)
    setTimeout(() => {
      if (!mlStarted) {
        if (hasModuleError) {
          console.log('\n⚠️  ML Service failed - missing packages');
          console.log('   Backend will continue without ML features');
          console.log('   Run install-ml-packages.bat to enable ML\n');
        } else {
          console.log('⚠️  ML Service taking longer than expected, continuing anyway...');
          console.log('   Large models (Qwen, BanglaBERT) may take 2-3 minutes on first load');
          console.log('   Subsequent loads will be instant (using cached models)');
        }
        resolve();
      }
    }, 120000);
  });
};

const startServer = async () => {
  try {
    console.log('\n' + '═'.repeat(60));
    console.log('🧠 JAANI Backend - Brain Activation Sequence');
    console.log('═'.repeat(60));
    
    // ── ML Service DISABLED: Now using Gemini AI API instead ──
    // The local Python ML service (ml-service/main.py) is no longer started.
    // All NLP analysis is handled by Google Gemini via backend/services/geminiAnalysis.js
    console.log('🤖 Using Gemini AI for NLP analysis (local ML service disabled)');
    console.log(`   Gemini API Key: ${process.env.GEMINI_API_KEY ? '✅ Set' : '❌ NOT SET'}`);
    /* ── OLD ML SERVICE STARTUP (COMMENTED OUT) ──
    if (process.env.SKIP_ML_STARTUP === 'true') {
      console.log('Skipping ML Service startup');
    } else {
      try {
        await startMLService();
        console.log('ML Service started on port 8000');
      } catch (error) {
        console.log('ML Service failed to start');
      }
    }
    ── END OLD ML STARTUP ── */
    
    try {
      const contactLoadStart = Date.now();
      const preloadTimeoutMs = parseInt(process.env.CONTACT_PRELOAD_TIMEOUT_MS || '5000', 10);
      await Promise.race([
        initializeContactsSingleton({ forceReload: true }),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`contact preload timeout after ${preloadTimeoutMs}ms`)),
          preloadTimeoutMs,
        )),
      ]);
      console.log(`📇 Contact singleton preloaded in ${Date.now() - contactLoadStart}ms`);
    } catch (contactError) {
      console.warn('⚠️ Contact singleton preload failed, continuing startup:', contactError.message);
    }

    if (process.env.MONGO_URI) {
      try {
        await connectDB();
      } catch (dbError) {
        console.warn('⚠️ MongoDB connection failed, continuing with fallback data stores:', dbError.message);
      }
    } else {
      console.log('ℹ️ MONGO_URI not set, skipping MongoDB connection');
    }

    // Evidence retention: a background sweep on startup removes captures older than
    // EVIDENCE_RETENTION_DAYS (default 90; 0 disables). Each deletion is logged.
    setTimeout(() => {
      const days = process.env.EVIDENCE_RETENTION_DAYS === undefined ? 90 : Number(process.env.EVIDENCE_RETENTION_DAYS);
      require('./services/forensicEvidence').sweepExpiredCaptures({ maxAgeDays: days })
        .then((r) => {
          if (r.skipped) console.log(`🗄️ [evidence-retention] ${r.reason}`);
          else console.log(`🗄️ [evidence-retention] sweep done: ${r.removed.length} removed, ${r.kept} kept (older than ${r.maxAgeDays} days)`);
        })
        .catch((e) => console.warn('[evidence-retention] sweep failed:', e.message));
    }, 30 * 1000).unref();

    // Fact-check index: poll the fact-checkers' public feeds every 6 hours (never per request).
    // First start backfills a few pages; later starts only pick up what's new.
    // FACTCHECK_POLL=off disables polling (e.g. for a second instance on another port).
    if (String(process.env.FACTCHECK_POLL || '').toLowerCase() !== 'off') try {
      const cron = require('node-cron');
      const factCheckIndex = require('./services/factCheckIndex');
      cron.schedule('0 */6 * * *', () => {
        factCheckIndex.pollAll({ pages: 2 }).catch((e) => console.warn('[factcheck] scheduled poll failed:', e.message));
      });
      setTimeout(async () => {
        const { total } = await factCheckIndex.stats();
        factCheckIndex.pollAll({ pages: total ? 1 : 10 }).catch((e) => console.warn('[factcheck] startup poll failed:', e.message));
      }, 60 * 1000).unref();
    } catch (e) {
      console.warn('[factcheck] scheduler not started:', e.message);
    }

    console.log('✅ Local In-Memory Data Store initialized');
    
    const configureServer = (server) => {
      // Server timeouts
      // Some endpoints (e.g., /api/analyze) may legitimately take >30s on JS-heavy sites.
      // Keep a higher ceiling to avoid cutting off responses mid-processing.
      server.timeout = 120000; // 120s total timeout
      server.keepAliveTimeout = 65000; // Keep connections alive longer (65s)
      server.headersTimeout = 66000; // Headers timeout slightly higher
      server.maxHeadersCount = 100; // Limit header count for security

      // Enable TCP keep-alive for better connection management
      server.on('connection', (socket) => {
        socket.setKeepAlive(true, 60000); // Keep alive for 60s
        socket.setNoDelay(true); // Disable Nagle's algorithm for faster response
      });
    };

    // IMPORTANT: CRA's proxy on Windows can resolve "localhost" to IPv4.
    // Node sometimes binds only to IPv6 (::) by default, causing ECONNREFUSED.
    // We bind explicitly to IPv4 to make proxying reliable.
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log('\n🚀 Server running with Local In-Memory Data');
      console.log(`   Port: ${PORT}`);
      console.log(`   Listen: http://0.0.0.0:${PORT} (all interfaces)`);
      console.log(`   Local: http://localhost:${PORT}`);
      console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`   Frontend: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
      console.log(`   ML Service: ${process.env.ML_SERVICE_URL || 'http://localhost:8000'}`);
      
      console.log('\n📡 Active Endpoints:');
      console.log('   POST   /api/analyze             - Extract news text + media');
      console.log('   POST   /api/analyze-text        - Analyze extracted text');
      console.log('   POST   /api/verify-contact      - Compare DB vs Live contact info');
      console.log('   POST   /api/send-mail           - Queue email for sending');
      console.log('   GET    /health                  - Health check');
      
      console.log('\n✨ Brain Status: READY');
      console.log('═'.repeat(60) + '\n');
    });

    configureServer(server);
    console.log('⏱️  Server configured: 120s timeout, 65s keep-alive, TCP no-delay enabled');

    // Untrusted news pages ("Live Site" view) are served from a separate origin, never this one.
    require('./services/liveProxyReader').startReaderServer();
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nSIGTERM received, shutting down gracefully');
  if (mlServiceProcess) {
    console.log('🛑 Stopping ML Service...');
    mlServiceProcess.kill();
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received, shutting down gracefully');
  if (mlServiceProcess) {
    console.log('🛑 Stopping ML Service...');
    mlServiceProcess.kill();
  }
  process.exit(0);
});

startServer();

module.exports = app;
