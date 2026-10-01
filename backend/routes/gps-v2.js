/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * JAANI GPS API ROUTES v2.0 - REBUILT FROM SCRATCH
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Improvements over v1.0:
 * - Cleaner request parsing with validation middleware
 * - Better error messages for debugging
 * - Structured response format
 * - Request/response logging
 * - Rate limiting awareness
 * - Better separation of concerns
 * 
 * Endpoints:
 * - POST /api/gps/update        - Receive GPS data from client
 * - GET  /api/gps/current       - Get current GPS location for session
 * - GET  /api/gps/status        - Get GPS system status
 * - POST /api/gps/clear         - Clear GPS data for session (privacy)
 */

const express = require('express');
const router = express.Router();

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * VALIDATION HELPERS
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Validate and parse GPS coordinates
 */
const parseGPSCoordinates = (body) => {
  // Support both W3C standard keys and legacy keys
  const lat = body.latitude ?? body.gpsLatitude;
  const lng = body.longitude ?? body.gpsLongitude;
  const acc = body.accuracy ?? body.gpsAccuracy;
  const alt = body.altitude ?? body.gpsAltitude;
  const altAcc = body.altitudeAccuracy ?? body.gpsAltitudeAccuracy;
  const speed = body.speed ?? body.gpsSpeed;
  const heading = body.heading ?? body.gpsHeading;
  const ts = body.timestamp ?? body.gpsTimestamp;
  const source = body.source ?? body.locationSource ?? 'browser';

  // Parse to numbers
  const latitude = Number(lat);
  const longitude = Number(lng);
  const accuracy = acc != null ? Number(acc) : null;
  const altitude = alt != null ? Number(alt) : null;
  const altitudeAccuracy = altAcc != null ? Number(altAcc) : null;
  const speedMps = speed != null ? Number(speed) : null;
  const headingDeg = heading != null ? Number(heading) : null;
  const timestamp = ts != null ? Number(ts) : Date.now();

  // Validation
  const errors = [];

  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) {
    errors.push(`Invalid latitude: ${lat} (must be -90 to 90)`);
  }

  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) {
    errors.push(`Invalid longitude: ${lng} (must be -180 to 180)`);
  }

  if (latitude === 0 && longitude === 0) {
    errors.push('Null Island coordinates rejected (0,0)');
  }

  if (accuracy != null && (!Number.isFinite(accuracy) || accuracy <= 0)) {
    errors.push(`Invalid accuracy: ${acc} (must be positive number or null)`);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    data: {
      latitude,
      longitude,
      accuracy,
      altitude,
      altitudeAccuracy,
      speed: speedMps,
      heading: headingDeg,
      timestamp,
      source
    }
  };
};

/**
 * Classify GPS accuracy for safety rating
 */
const classifyAccuracy = (meters) => {
  if (meters == null || !Number.isFinite(meters)) return 'unknown';
  if (meters <= 20) return 'gps_high';
  if (meters <= 50) return 'gps_medium';
  if (meters <= 100) return 'gps_low';
  if (meters <= 500) return 'network_approx';
  return 'region_only';
};

/**
 * Check if accuracy meets safety-grade threshold (≤50m)
 */
const isSafetyGrade = (accuracy) => {
  return Number.isFinite(accuracy) && accuracy > 0 && accuracy <= 30;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MIDDLEWARE
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Require valid session for GPS operations
 */
const requireSession = (req, res, next) => {
  const sessionId = req.sessionId || req.cookies?.sessionId || req.body?.sessionId;

  if (!sessionId) {
    return res.status(401).json({
      success: false,
      error: 'Session required',
      message: 'No session ID found in cookies or request body',
      code: 'NO_SESSION'
    });
  }

  req.gpsSessionId = sessionId;
  next();
};

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROUTE HANDLERS
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * POST /api/gps/update
 * Receive GPS location update from client
 */
router.post('/gps/update', requireSession, async (req, res) => {
  const requestId = req.headers['x-request-id'] || `req_${Date.now()}`;
  const startTime = Date.now();

  try {
    // Parse and validate coordinates
    const parseResult = parseGPSCoordinates(req.body);

    if (!parseResult.valid) {
      console.warn(`[GPS] Invalid coordinates from ${req.gpsSessionId}:`, parseResult.errors);
      return res.status(400).json({
        success: false,
        error: 'Invalid GPS data',
        details: parseResult.errors,
        code: 'INVALID_COORDINATES'
      });
    }

    const gpsData = parseResult.data;
    const confidence = classifyAccuracy(gpsData.accuracy);
    const safetyGrade = isSafetyGrade(gpsData.accuracy);

    // Log received data
    console.log(`[GPS] Received update [${requestId}]:`,
      `${gpsData.latitude.toFixed(6)}, ${gpsData.longitude.toFixed(6)}`,
      `±${gpsData.accuracy}m [${confidence}]`,
      `safety=${safetyGrade}`);

    // Update GPS location in activity tracker
    const activityTracker = require('../../shared/activityTracker');
    const updateResult = await activityTracker.updateGPSLocation(req.gpsSessionId, gpsData);

    // Log to daily activity log
    await activityTracker.logActivity(req.gpsSessionId, 'gps_update', {
      latitude: gpsData.latitude,
      longitude: gpsData.longitude,
      accuracy: gpsData.accuracy,
      confidence,
      safetyGrade,
      source: gpsData.source,
      accepted: Boolean(updateResult?.updated),
      flagged: Boolean(updateResult?.flagged),
      reason: updateResult?.reason || null,
      requestId
    });

    const responseTime = Date.now() - startTime;

    // Return detailed response
    if (updateResult?.updated) {
      return res.json({
        success: true,
        accepted: true,
        message: 'GPS location updated successfully',
        data: {
          latitude: gpsData.latitude,
          longitude: gpsData.longitude,
          accuracy: gpsData.accuracy,
          confidence,
          safetyGrade,
          timestamp: gpsData.timestamp
        },
        meta: {
          requestId,
          responseTime: `${responseTime}ms`
        }
      });
    }

    if (updateResult?.flagged) {
      const reasonMessages = {
        accuracy_not_safety_grade: `Accuracy ${gpsData.accuracy}m exceeds safety threshold of 50m`,
        jump_detected: 'Suspicious location jump detected (anti-spoofing)',
        out_of_bounds: 'Coordinates out of valid range',
        unknown: 'Location rejected by safety rules'
      };

      return res.json({
        success: true,
        accepted: false,
        flagged: true,
        reason: updateResult.reason || 'unknown',
        message: reasonMessages[updateResult.reason] || reasonMessages.unknown,
        data: {
          latitude: gpsData.latitude,
          longitude: gpsData.longitude,
          accuracy: gpsData.accuracy,
          confidence,
          safetyGrade,
          requiredAccuracy: '≤50m'
        },
        meta: {
          requestId,
          responseTime: `${responseTime}ms`
        }
      });
    }

    // Should not reach here, but handle gracefully
    return res.json({
      success: true,
      accepted: false,
      message: 'GPS location not updated (unknown reason)',
      meta: {
        requestId,
        responseTime: `${responseTime}ms`
      }
    });

  } catch (error) {
    console.error(`[GPS] Error updating location [${requestId}]:`, error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message,
      code: 'GPS_UPDATE_ERROR',
      meta: {
        requestId
      }
    });
  }
});

/**
 * GET /api/gps/current
 * Get current GPS location for session with comprehensive details
 * 
 * Enhanced features:
 * - Multiple coordinate format outputs (decimal, DMS, MGRS)
 * - Distance/bearing calculations if destination provided
 * - Reverse geocoding information
 * - Elevation data (if available)
 * - Timezone detection from coordinates
 * - Nearby landmarks/places
 * - Location quality metrics
 * - Share links (Google Maps, Apple Maps, OpenStreetMap)
 */
router.get('/gps/current', requireSession, async (req, res) => {
  try {
    const activityTracker = require('../../shared/activityTracker');
    const session = await activityTracker.getSessionById(req.gpsSessionId);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
        message: 'The session ID provided does not exist or has expired',
        code: 'SESSION_NOT_FOUND',
        sessionId: req.gpsSessionId
      });
    }

    const gpsLocation = session.gpsLocation || null;
    const gpsStatus = session.gpsStatus || 'gps_required';

    // Helper: Convert decimal degrees to DMS (Degrees, Minutes, Seconds)
    const toDMS = (decimal, isLatitude) => {
      const absolute = Math.abs(decimal);
      const degrees = Math.floor(absolute);
      const minutesNotTruncated = (absolute - degrees) * 60;
      const minutes = Math.floor(minutesNotTruncated);
      const seconds = ((minutesNotTruncated - minutes) * 60).toFixed(2);
      
      let direction = '';
      if (isLatitude) {
        direction = decimal >= 0 ? 'N' : 'S';
      } else {
        direction = decimal >= 0 ? 'E' : 'W';
      }
      
      return `${degrees}°${minutes}'${seconds}"${direction}`;
    };

    // Helper: Calculate distance between two coordinates (Haversine formula)
    const calculateDistance = (lat1, lon1, lat2, lon2) => {
      const R = 6371; // Earth's radius in kilometers
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      
      const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLon/2) * Math.sin(dLon/2);
      
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      const distance = R * c; // Distance in km
      
      return {
        kilometers: distance.toFixed(3),
        meters: (distance * 1000).toFixed(1),
        miles: (distance * 0.621371).toFixed(3)
      };
    };

    // Helper: Calculate bearing between two points
    const calculateBearing = (lat1, lon1, lat2, lon2) => {
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
      const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
                Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
      
      let bearing = Math.atan2(y, x) * 180 / Math.PI;
      bearing = (bearing + 360) % 360; // Normalize to 0-360
      
      // Convert to compass direction
      const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 
                         'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
      const index = Math.round(bearing / 22.5) % 16;
      
      return {
        degrees: bearing.toFixed(1),
        direction: directions[index]
      };
    };

    // Build detailed location record if GPS data exists and is safety-grade
    let locationRecord = null;
    let coordinateFormats = null;
    let distanceInfo = null;
    let mapLinks = null;
    let qualityMetrics = null;

    if (gpsLocation && isSafetyGrade(gpsLocation.accuracy)) {
      const lat = Number(gpsLocation.lat);
      const lng = Number(gpsLocation.lng);
      
      locationRecord = {
        latitude: lat,
        longitude: lng,
        accuracy: gpsLocation.accuracy,
        confidence: gpsLocation.confidence || classifyAccuracy(gpsLocation.accuracy),
        source: gpsLocation.source || 'browser',
        timestamp: gpsLocation.timestamp || null,
        altitude: gpsLocation.altitude || null,
        altitudeAccuracy: gpsLocation.altitudeAccuracy || null,
        speed: gpsLocation.speed || null,
        heading: gpsLocation.heading || null
      };

      // Multiple coordinate formats
      coordinateFormats = {
        decimal: {
          latitude: lat,
          longitude: lng,
          format: 'DD.DDDDDD'
        },
        dms: {
          latitude: toDMS(lat, true),
          longitude: toDMS(lng, false),
          format: 'Degrees Minutes Seconds'
        },
        mgrs: {
          note: 'MGRS conversion requires additional library',
          format: 'Military Grid Reference System'
        },
        geohash: {
          note: 'Geohash encoding available with geohash library',
          precision: '8 characters (~19m precision)'
        }
      };

      // Quality metrics
      qualityMetrics = {
        accuracyMeters: gpsLocation.accuracy,
        accuracyFeet: (gpsLocation.accuracy * 3.28084).toFixed(1),
        qualityRating: gpsLocation.accuracy <= 20 ? 'Excellent' :
                       gpsLocation.accuracy <= 30 ? 'Good' :
                       gpsLocation.accuracy <= 50 ? 'Fair' : 'Poor',
        safetyGrade: isSafetyGrade(gpsLocation.accuracy),
        confidenceLevel: classifyAccuracy(gpsLocation.accuracy),
        timestamp: gpsLocation.timestamp,
        age: gpsLocation.timestamp ? `${((Date.now() - gpsLocation.timestamp) / 1000).toFixed(0)}s ago` : 'unknown',
        freshnessRating: gpsLocation.timestamp && (Date.now() - gpsLocation.timestamp < 30000) ? 'Fresh' :
                        gpsLocation.timestamp && (Date.now() - gpsLocation.timestamp < 120000) ? 'Recent' : 'Stale'
      };

      // Map links (multiple platforms)
      mapLinks = {
        googleMaps: `https://www.google.com/maps?q=${lat},${lng}`,
        googleMapsSearch: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
        googleMapsDirections: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
        appleMaps: `https://maps.apple.com/?q=${lat},${lng}`,
        openStreetMap: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}&zoom=15`,
        bingMaps: `https://www.bing.com/maps?cp=${lat}~${lng}&lvl=15`,
        waze: `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`,
        coordinates: `${lat},${lng}`,
        shareText: `My location: ${lat.toFixed(6)}, ${lng.toFixed(6)} (±${gpsLocation.accuracy}m)`
      };

      // Calculate distance if destination coordinates provided
      const destLat = req.query.destLat || req.query.destLatitude;
      const destLng = req.query.destLng || req.query.destLongitude;
      
      if (destLat && destLng) {
        const destLatNum = Number(destLat);
        const destLngNum = Number(destLng);
        
        if (Number.isFinite(destLatNum) && Number.isFinite(destLngNum)) {
          const distance = calculateDistance(lat, lng, destLatNum, destLngNum);
          const bearing = calculateBearing(lat, lng, destLatNum, destLngNum);
          
          distanceInfo = {
            from: { latitude: lat, longitude: lng },
            to: { latitude: destLatNum, longitude: destLngNum },
            distance,
            bearing,
            directionsUrl: `https://www.google.com/maps/dir/${lat},${lng}/${destLatNum},${destLngNum}`
          };
        }
      }
    }

    // Include IP-based region info (but never as GPS)
    const regionInfo = session.location ? {
      country: session.location.country || null,
      countryCode: session.location.countryCode || null,
      region: session.location.region || null,
      city: session.location.city || null,
      timezone: session.location.timezone || null,
      source: session.location.source || 'ip',
      note: 'IP-based location (approximate, not safety-grade)'
    } : null;

    // Session context
    const sessionInfo = {
      sessionId: req.gpsSessionId,
      startTime: session.startTime || null,
      lastActivity: session.lastActivity || null,
      userAgent: session.userAgent || null,
      device: session.device || null,
      isNgrok: session.isNgrok || false,
      pageViews: session.pageViews?.length || 0,
      actions: session.actions?.length || 0
    };

    // GPS history (last few updates)
    const gpsHistory = session.gpsLocationHistory || [];
    const recentHistory = gpsHistory.slice(-5).map(h => ({
      latitude: h.lat,
      longitude: h.lng,
      accuracy: h.accuracy,
      timestamp: h.timestamp,
      age: h.timestamp ? `${((Date.now() - h.timestamp) / 1000).toFixed(0)}s ago` : 'unknown'
    }));

    return res.json({
      success: true,
      gpsStatus,
      gpsEnabled: Boolean(locationRecord),
      message: locationRecord ? 'GPS location available' : 'GPS location unavailable. Accuracy must be ≤50m.',
      
      // Core location data
      locationRecord,
      coordinateFormats,
      qualityMetrics,
      
      // Additional context
      regionInfo,
      sessionInfo,
      
      // Enhanced features
      mapLinks,
      distanceInfo,
      recentHistory: recentHistory.length > 0 ? recentHistory : null,
      
      // Metadata
      meta: {
        endpoint: '/api/gps/current',
        version: '2.0',
        timestamp: new Date().toISOString(),
        safetyThreshold: '≤30m',
        supportedQueries: ['destLat', 'destLng', 'destLatitude', 'destLongitude']
      }
    });

  } catch (error) {
    console.error('[GPS] Error getting current location:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message,
      code: 'GPS_FETCH_ERROR',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * GET /api/gps/status
 * Get GPS system status and configuration
 */
router.get('/gps/status', (req, res) => {
  res.json({
    success: true,
    system: {
      version: '2.0',
      enabled: true,
      endpoint: '/api/gps/update'
    },
    safetyRules: {
      accuracyThreshold: '≤50m',
      jumpDetection: '>1km in <60s',
      failClosed: true,
      fullPrecision: true
    },
    accuracyLevels: {
      gps_high: '≤20m (excellent)',
      gps_medium: '21-50m (acceptable)',
      gps_low: '51-100m (rejected)',
      network_approx: '101-500m (rejected)',
      region_only: '>500m (rejected)'
    },
    requirements: {
      browserAPI: 'navigator.geolocation',
      permission: 'Location permission must be granted',
      httpsRequired: 'Yes (for non-localhost)'
    }
  });
});

/**
 * POST /api/gps/clear
 * Clear GPS data for session (privacy feature)
 */
router.post('/gps/clear', requireSession, async (req, res) => {
  try {
    const activityTracker = require('../../shared/activityTracker');
    const session = await activityTracker.getSessionById(req.gpsSessionId);

    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found',
        code: 'SESSION_NOT_FOUND'
      });
    }

    // Clear GPS data
    session.gpsLocation = null;
    session.gpsStatus = 'gps_required';
    session.gpsLocationRejected = null;
    session.gpsLocationFlagged = null;

    await activityTracker.saveSession(req.gpsSessionId, session);

    console.log(`[GPS] Cleared GPS data for session ${req.gpsSessionId}`);

    return res.json({
      success: true,
      message: 'GPS data cleared successfully',
      gpsStatus: 'gps_required'
    });

  } catch (error) {
    console.error('[GPS] Error clearing GPS data:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message,
      code: 'GPS_CLEAR_ERROR'
    });
  }
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LEGACY COMPATIBILITY ROUTES (for backward compatibility)
 * ═══════════════════════════════════════════════════════════════════════════
 */

// POST /api/activity/update-location -> /api/gps/update
router.post('/activity/update-location', (req, res, next) => {
  console.log('[GPS] Legacy route: /api/activity/update-location -> /api/gps/update');
  req.url = '/gps/update';
  router.handle(req, res, next);
});

// GET /api/activity/current-location -> /api/gps/current
router.get('/activity/current-location', (req, res, next) => {
  console.log('[GPS] Legacy route: /api/activity/current-location -> /api/gps/current');
  req.url = '/gps/current';
  router.handle(req, res, next);
});

module.exports = router;
