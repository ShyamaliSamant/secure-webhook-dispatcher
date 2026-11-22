/**
 * Redis connection configuration for BullMQ
 * 
 * IMPORTANT: This configuration is for Queue producers (API process).
 * Workers require different settings (maxRetriesPerRequest: null).
 */

import { logger } from '../utils/logger.js';

/**
 * Get Redis connection options from environment variables
 * Supports both REDIS_URL and individual REDIS_HOST/PORT settings
 * 
 * @returns {string|Object} Redis connection URL string or configuration object for ioredis
 */
export function getRedisConnection() {
  // Check for REDIS_URL first (connection string format)
  // BullMQ/ioredis accepts URL strings directly
  if (process.env.REDIS_URL) {
    // Return URL string directly - ioredis will parse it
    // Note: maxRetriesPerRequest and retry strategy are configured in Queue options
    return process.env.REDIS_URL;
  }

  // Fall back to individual host/port configuration
  const config = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy(times) {
      // Exponential backoff with max delay of 2 seconds
      const delay = Math.min(times * 50, 2000);
      if (times > 10) {
        // Stop retrying after 10 attempts
        logger.error({
          retryAttempts: times,
          component: 'redis-api'
        }, 'Redis connection failed after max retry attempts');
        return null;
      }
      return delay;
    }
  };

  // Add password if provided (never log this)
  if (process.env.REDIS_PASSWORD) {
    config.password = process.env.REDIS_PASSWORD;
  }

  return config;
}

/**
 * Get Redis connection configuration for BullMQ Worker
 * 
 * CRITICAL: Workers MUST use maxRetriesPerRequest: null
 * This prevents commands from failing during long-running job processing.
 * 
 * @returns {Object} Redis connection configuration for ioredis (Worker)
 */
export function getWorkerRedisConnection() {
  if (process.env.REDIS_URL) {
    // For connection string, we need to return config object
    // to ensure maxRetriesPerRequest: null is set
    // Parse basic URL format: redis://[user:password@]host:port[/db]
    try {
      const url = new URL(process.env.REDIS_URL);
      const config = {
        host: url.hostname,
        port: parseInt(url.port, 10) || 6379,
        maxRetriesPerRequest: null,  // REQUIRED for Worker
        enableReadyCheck: false,      // Recommended for Worker
      };
      
      // Add password if present in URL
      if (url.password) {
        config.password = url.password;
      }
      
      // Add database number if present
      if (url.pathname && url.pathname.length > 1) {
        const db = parseInt(url.pathname.slice(1), 10);
        if (!isNaN(db)) {
          config.db = db;
        }
      }
      
      return config;
    } catch (error) {
      // If URL parsing fails, fall back to host/port config
      logger.warn({
        component: 'redis-worker',
        error: error.message
      }, 'Failed to parse REDIS_URL, falling back to host/port config');
    }
  }

  // Individual host/port configuration
  const config = {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,  // REQUIRED for Worker
    enableReadyCheck: false,      // Recommended for Worker
  };

  // Add password if provided
  if (process.env.REDIS_PASSWORD) {
    config.password = process.env.REDIS_PASSWORD;
  }

  return config;
}

/**
 * Redis connection configuration for BullMQ Queue (producer)
 * This is used by the API process to add jobs to the queue
 */
export const redisConnection = getRedisConnection();

// Log connection info (without credentials)
const redisHost = typeof redisConnection === 'string' 
  ? 'REDIS_URL (connection string)' 
  : `${redisConnection.host || 'localhost'}:${redisConnection.port || 6379}`;

logger.info({
  redisHost,
  component: 'redis-api'
}, 'Redis connection configured');
