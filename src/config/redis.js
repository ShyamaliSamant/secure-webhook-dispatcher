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
 * @returns {string|Object} Raw Redis URL or ioredis options for direct clients
 */
export function getRedisConnection() {
  // Direct ioredis clients such as health checks accept a raw connection URL.
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
 * Get Redis connection options compatible with BullMQ Queue.
 * The health service uses getRedisConnection() directly and retains raw URL
 * support; BullMQ requires a Redis options object for URL-based connections.
 *
 * @returns {Object} Redis connection options for BullMQ Queue
 */
export function getBullMQConnectionOptions() {
  const connection = getRedisConnection();
  if (typeof connection === 'string') {
    return {
      url: connection,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true
    };
  }
  return connection;
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
    // Supports redis:// and TLS-protected rediss:// provider URLs.
    try {
      const url = new URL(process.env.REDIS_URL);
      const isTls = url.protocol === 'rediss:';
      const config = {
        host: url.hostname,
        port: parseInt(url.port, 10) || (isTls ? 6380 : 6379),
        maxRetriesPerRequest: null,  // REQUIRED for Worker
        enableReadyCheck: false,      // Recommended for Worker
      };

      if (isTls) {
        config.tls = {};
      }
      
      // Add password if present in URL
      if (url.password) {
        config.password = decodeURIComponent(url.password);
      }

      if (url.username && url.username !== 'default') {
        config.username = decodeURIComponent(url.username);
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
export const redisConnection = getBullMQConnectionOptions();

// Log connection info (without credentials)
const redisHost = process.env.REDIS_URL
  ? 'REDIS_URL (connection string)' 
  : `${redisConnection.host || 'localhost'}:${redisConnection.port || 6379}`;

logger.info({
  redisHost,
  component: 'redis-api'
}, 'Redis connection configured');
