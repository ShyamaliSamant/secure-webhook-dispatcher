/**
 * Health Check Service
 * 
 * Provides health check functionality for:
 * 1. Liveness - API process is running
 * 2. Readiness - Redis is available
 * 3. Worker heartbeat monitoring
 */

import Redis from 'ioredis';
import { getRedisConnection } from '../config/redis.js';
import { logger } from '../utils/logger.js';

const healthLogger = logger.child({ component: 'health' });

// Redis client for health checks (separate from BullMQ queue connection)
let redisClient = null;

// Worker heartbeat configuration
const WORKER_HEARTBEAT_KEY = 'webhook-dispatcher:worker:heartbeat';
const WORKER_HEARTBEAT_TTL = 30; // 30 seconds TTL
const WORKER_HEARTBEAT_THRESHOLD = 20; // Consider unhealthy if older than 20 seconds

/**
 * Initialize Redis client for health checks
 * Creates a dedicated connection separate from BullMQ
 */
function getRedisClient() {
  if (!redisClient) {
    const config = getRedisConnection();
    
    // Create dedicated Redis client for health checks
    if (typeof config === 'string') {
      redisClient = new Redis(config, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        retryStrategy: () => null // Don't retry, fail fast for health checks
      });
    } else {
      redisClient = new Redis({
        ...config,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        retryStrategy: () => null // Don't retry, fail fast for health checks
      });
    }
    
    // Handle connection errors silently (health checks handle failures)
    redisClient.on('error', (error) => {
      healthLogger.debug({
        error: error.message
      }, 'Redis health check client error (expected during outages)');
    });
    
    healthLogger.debug('Redis health check client initialized');
  }
  
  return redisClient;
}

/**
 * Check Redis connectivity with PING
 * 
 * @returns {Promise<Object>} Health check result
 */
export async function checkRedisHealth() {
  const startTime = Date.now();
  
  try {
    const client = getRedisClient();
    
    // Ensure connection is established
    if (client.status !== 'ready') {
      await client.connect();
    }
    
    // Execute PING command
    const result = await client.ping();
    const responseTime = Date.now() - startTime;
    
    if (result === 'PONG') {
      healthLogger.debug({
        responseTime
      }, 'Redis health check passed');
      
      return {
        status: 'healthy',
        redis: 'connected',
        responseTimeMs: responseTime
      };
    } else {
      healthLogger.warn({
        result,
        responseTime
      }, 'Redis health check unexpected response');
      
      return {
        status: 'unhealthy',
        redis: 'disconnected',
        error: 'Unexpected PING response'
      };
    }
  } catch (error) {
    const responseTime = Date.now() - startTime;
    
    healthLogger.warn({
      error: error.message,
      responseTime
    }, 'Redis health check failed');
    
    return {
      status: 'unhealthy',
      redis: 'disconnected',
      error: error.code || 'Connection failed',
      responseTimeMs: responseTime
    };
  }
}

/**
 * Check worker heartbeat status
 * 
 * @returns {Promise<Object>} Worker health status
 */
export async function checkWorkerHealth() {
  try {
    const client = getRedisClient();
    
    // Ensure connection is established
    if (client.status !== 'ready') {
      await client.connect();
    }
    
    // Get worker heartbeat timestamp
    const heartbeat = await client.get(WORKER_HEARTBEAT_KEY);
    
    if (!heartbeat) {
      healthLogger.debug('No worker heartbeat found');
      return {
        worker: 'not-running',
        message: 'No heartbeat detected'
      };
    }
    
    // Parse timestamp and check freshness
    const heartbeatTime = parseInt(heartbeat, 10);
    const now = Date.now();
    const age = now - heartbeatTime;
    const ageSeconds = Math.floor(age / 1000);
    
    if (age > WORKER_HEARTBEAT_THRESHOLD * 1000) {
      healthLogger.warn({
        ageSeconds,
        threshold: WORKER_HEARTBEAT_THRESHOLD
      }, 'Worker heartbeat is stale');
      
      return {
        worker: 'unhealthy',
        message: 'Heartbeat is stale',
        lastHeartbeatAgeSeconds: ageSeconds
      };
    }
    
    healthLogger.debug({
      ageSeconds
    }, 'Worker heartbeat is fresh');
    
    return {
      worker: 'healthy',
      lastHeartbeatAgeSeconds: ageSeconds
    };
  } catch (error) {
    healthLogger.warn({
      error: error.message
    }, 'Worker health check failed');
    
    return {
      worker: 'unknown',
      error: error.code || 'Health check failed'
    };
  }
}

/**
 * Update worker heartbeat
 * Called periodically by the worker process
 * 
 * @param {Redis} workerRedisClient - Existing Redis client from worker
 * @returns {Promise<void>}
 */
export async function updateWorkerHeartbeat(workerRedisClient) {
  try {
    const timestamp = Date.now();
    await workerRedisClient.setex(WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL, timestamp.toString());
    
    healthLogger.debug({
      timestamp,
      ttl: WORKER_HEARTBEAT_TTL
    }, 'Worker heartbeat updated');
  } catch (error) {
    healthLogger.error({
      error: error.message
    }, 'Failed to update worker heartbeat');
  }
}

/**
 * Remove worker heartbeat
 * Called during graceful worker shutdown
 * 
 * @param {Redis} workerRedisClient - Existing Redis client from worker
 * @returns {Promise<void>}
 */
export async function removeWorkerHeartbeat(workerRedisClient) {
  try {
    await workerRedisClient.del(WORKER_HEARTBEAT_KEY);
    healthLogger.info('Worker heartbeat removed');
  } catch (error) {
    healthLogger.error({
      error: error.message
    }, 'Failed to remove worker heartbeat');
  }
}

/**
 * Get worker heartbeat configuration
 * Used by worker to determine update interval
 * 
 * @returns {Object} Heartbeat configuration
 */
export function getWorkerHeartbeatConfig() {
  return {
    key: WORKER_HEARTBEAT_KEY,
    ttl: WORKER_HEARTBEAT_TTL,
    updateInterval: 10000 // Update every 10 seconds (well within 30s TTL)
  };
}

/**
 * Close health check Redis client
 * Called during graceful API shutdown
 */
export async function closeHealthCheck() {
  if (redisClient) {
    try {
      await redisClient.quit();
      healthLogger.debug('Health check Redis client closed');
    } catch (error) {
      healthLogger.warn({
        error: error.message
      }, 'Error closing health check Redis client');
    }
    redisClient = null;
  }
}
