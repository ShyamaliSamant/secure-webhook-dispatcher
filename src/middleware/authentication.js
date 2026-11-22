/**
 * API Authentication Middleware
 * 
 * Implements API key authentication for secure endpoints.
 * Uses timing-safe comparison to prevent timing attacks.
 * 
 * Environment Variables:
 * - NODE_ENV: 'production' or 'development' (default: 'development')
 * - API_KEY: Required in production mode for authentication
 * - API_KEY_HEADER: Header name for API key (default: 'X-API-Key')
 * 
 * Security:
 * - API key never logged or exposed in responses
 * - Timing-safe comparison prevents timing attacks
 * - Production mode requires API_KEY to be set
 * - Development mode allows bypass for testing
 */

import crypto from 'crypto';
import { logger } from '../utils/logger.js';

const authLogger = logger.child({ component: 'auth' });

// Configuration
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const API_KEY = process.env.API_KEY;
const API_KEY_HEADER = (process.env.API_KEY_HEADER || 'X-API-Key').toLowerCase();

// Validate configuration at startup
if (IS_PRODUCTION && !API_KEY) {
  authLogger.fatal(
    'FATAL: API_KEY environment variable is required in production mode'
  );
  process.exit(1);
}

if (!IS_PRODUCTION && !API_KEY) {
  authLogger.warn(
    'WARN: API_KEY not set. Authentication disabled in development mode. ' +
    'Set API_KEY environment variable for testing authentication.'
  );
}

/**
 * Timing-safe string comparison
 * Prevents timing attacks by ensuring comparison takes constant time
 * 
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} True if strings are equal
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  
  // Convert to buffers for constant-time comparison
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  
  // If lengths differ, still do comparison to prevent timing leak
  if (bufA.length !== bufB.length) {
    // Compare against a constant buffer to maintain timing consistency
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Authentication middleware
 * 
 * Validates API key from request headers.
 * Returns 401 for missing or invalid credentials.
 * 
 * Usage:
 *   router.post('/api/webhooks/dispatch', requireAuth, dispatchWebhook);
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
export function requireAuth(req, res, next) {
  // Development mode bypass
  if (!IS_PRODUCTION && !API_KEY) {
    // No API key configured in development - allow request
    return next();
  }
  
  // Get API key from header
  const providedKey = req.headers[API_KEY_HEADER];
  
  // Check if API key is present
  if (!providedKey) {
    authLogger.warn({
      ip: req.ip,
      path: req.path,
      method: req.method
    }, 'Authentication failed: Missing API key');
    
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
      details: `Missing ${API_KEY_HEADER} header`
    });
  }
  
  // Validate API key using timing-safe comparison
  if (!timingSafeEqual(providedKey, API_KEY)) {
    authLogger.warn({
      ip: req.ip,
      path: req.path,
      method: req.method
    }, 'Authentication failed: Invalid API key');
    
    return res.status(401).json({
      success: false,
      error: 'Authentication failed',
      details: 'Invalid API key'
    });
  }
  
  // Authentication successful
  authLogger.debug({
    ip: req.ip,
    path: req.path,
    method: req.method
  }, 'Authentication successful');
  
  next();
}

/**
 * Optional authentication middleware
 * 
 * Validates API key if provided, but allows requests without authentication.
 * Useful for endpoints that have both authenticated and public access.
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
export function optionalAuth(req, res, next) {
  if (!IS_PRODUCTION && !API_KEY) {
    return next();
  }
  
  const providedKey = req.headers[API_KEY_HEADER];
  
  if (!providedKey) {
    // No key provided - continue without authentication
    req.authenticated = false;
    return next();
  }
  
  if (!timingSafeEqual(providedKey, API_KEY)) {
    // Invalid key provided - reject
    authLogger.warn({
      ip: req.ip,
      path: req.path
    }, 'Authentication failed: Invalid API key');
    
    return res.status(401).json({
      success: false,
      error: 'Authentication failed',
      details: 'Invalid API key'
    });
  }
  
  // Valid key provided
  req.authenticated = true;
  next();
}

// Log authentication configuration at startup
if (API_KEY) {
  authLogger.info({
    mode: NODE_ENV,
    headerName: API_KEY_HEADER,
    keyConfigured: true
  }, 'API authentication enabled');
} else {
  authLogger.warn({
    mode: NODE_ENV,
    headerName: API_KEY_HEADER,
    keyConfigured: false
  }, 'API authentication disabled (development mode)');
}
