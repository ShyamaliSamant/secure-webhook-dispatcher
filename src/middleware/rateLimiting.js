/**
 * Rate Limiting Middleware
 * 
 * Implements configurable rate limiting for API endpoints.
 * Uses express-rate-limit with memory store (suitable for single-instance deployments).
 * 
 * For multi-instance deployments, consider using Redis store:
 *   import RedisStore from 'rate-limit-redis';
 *   store: new RedisStore({ client: redisClient })
 * 
 * Environment Variables:
 * - RATE_LIMIT_WINDOW_MS: Time window in milliseconds (default: 60000 = 1 minute)
 * - RATE_LIMIT_MAX_REQUESTS: Max requests per window (default: 100)
 * - RATE_LIMIT_DISPATCH_MAX: Max dispatch requests per window (default: 50)
 * - TRUST_PROXY: Set to 'true' if behind reverse proxy (default: false)
 */

import rateLimit from 'express-rate-limit';
import { logger } from '../utils/logger.js';

const rateLimitLogger = logger.child({ component: 'rate-limit' });

// Configuration
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10);
const RATE_LIMIT_DISPATCH_MAX = parseInt(process.env.RATE_LIMIT_DISPATCH_MAX || '50', 10);

/**
 * Custom handler for rate limit exceeded
 * Logs the event and returns 429 response
 */
function rateLimitHandler(req, res) {
  rateLimitLogger.warn({
    ip: req.ip,
    path: req.path,
    method: req.method
  }, 'Rate limit exceeded');
  
  res.status(429).json({
    success: false,
    error: 'Too many requests',
    details: 'Rate limit exceeded. Please try again later.',
    retryAfter: Math.ceil(req.rateLimit.resetTime / 1000)
  });
}

/**
 * General rate limiter for API endpoints
 * Default: 100 requests per minute per IP
 */
export const generalRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_REQUESTS,
  message: {
    success: false,
    error: 'Too many requests',
    details: 'Rate limit exceeded. Please try again later.'
  },
  standardHeaders: true, // Return rate limit info in RateLimit-* headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
  handler: rateLimitHandler,
  skip: (req) => {
    // Don't rate limit health endpoints
    return req.path.startsWith('/health');
  }
});

/**
 * Strict rate limiter for webhook dispatch endpoint
 * Default: 50 requests per minute per IP
 */
export const dispatchRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_DISPATCH_MAX,
  message: {
    success: false,
    error: 'Too many webhook dispatch requests',
    details: 'Rate limit exceeded. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});

/**
 * Lenient rate limiter for job status checks
 * Default: 200 requests per minute per IP
 */
export const statusRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_REQUESTS * 2,
  message: {
    success: false,
    error: 'Too many status requests',
    details: 'Rate limit exceeded. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});

/**
 * Strict rate limiter for DLQ operations
 * Default: 20 requests per minute per IP
 */
export const dlqRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: 20,
  message: {
    success: false,
    error: 'Too many DLQ requests',
    details: 'Rate limit exceeded. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler
});

// Log rate limiting configuration at startup
rateLimitLogger.info({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: RATE_LIMIT_MAX_REQUESTS,
  dispatchMax: RATE_LIMIT_DISPATCH_MAX,
  trustProxy: process.env.TRUST_PROXY === 'true'
}, 'Rate limiting configured');
