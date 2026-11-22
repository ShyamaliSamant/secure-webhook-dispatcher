/**
 * Health Check Routes
 * 
 * Endpoints:
 * - GET /health/live - Liveness check (always returns 200 if process is running)
 * - GET /health/ready - Readiness check (verifies Redis and worker health)
 */

import express from 'express';
import { checkRedisHealth, checkWorkerHealth } from '../services/healthService.js';
import { logger } from '../utils/logger.js';

const router = express.Router();
const healthLogger = logger.child({ component: 'health' });

/**
 * Liveness endpoint
 * Returns 200 if the API process is running
 * Does NOT depend on Redis availability
 * 
 * Use for: Kubernetes liveness probes, container orchestration
 */
router.get('/live', (req, res) => {
  healthLogger.debug('Liveness check requested');
  
  res.status(200).json({
    status: 'ok',
    service: 'webhook-dispatcher-api',
    timestamp: new Date().toISOString()
  });
});

/**
 * Readiness endpoint
 * Verifies Redis connectivity and worker health
 * Returns 200 when ready to accept traffic
 * Returns 503 when not ready (Redis unavailable or worker unhealthy)
 * 
 * Use for: Kubernetes readiness probes, load balancer health checks
 */
router.get('/ready', async (req, res) => {
  healthLogger.debug('Readiness check requested');
  
  try {
    // Check Redis connectivity
    const redisHealth = await checkRedisHealth();
    
    // Check worker heartbeat (only if Redis is available)
    let workerHealth = { worker: 'unknown', message: 'Redis unavailable' };
    if (redisHealth.status === 'healthy') {
      workerHealth = await checkWorkerHealth();
    }
    
    // Determine overall readiness
    const isReady = redisHealth.status === 'healthy';
    const statusCode = isReady ? 200 : 503;
    
    const response = {
      status: isReady ? 'ready' : 'not-ready',
      service: 'webhook-dispatcher-api',
      timestamp: new Date().toISOString(),
      checks: {
        redis: {
          status: redisHealth.redis,
          responseTimeMs: redisHealth.responseTimeMs
        },
        worker: {
          status: workerHealth.worker,
          lastHeartbeatAgeSeconds: workerHealth.lastHeartbeatAgeSeconds
        }
      }
    };
    
    // Include error details if unhealthy
    if (!isReady) {
      if (redisHealth.error) {
        response.checks.redis.error = redisHealth.error;
      }
      if (workerHealth.error) {
        response.checks.worker.error = workerHealth.error;
      }
      if (workerHealth.message) {
        response.checks.worker.message = workerHealth.message;
      }
    }
    
    // Log readiness check result
    if (isReady) {
      healthLogger.debug({
        redisStatus: redisHealth.redis,
        workerStatus: workerHealth.worker
      }, 'Readiness check passed');
    } else {
      healthLogger.warn({
        redisStatus: redisHealth.redis,
        redisError: redisHealth.error,
        workerStatus: workerHealth.worker
      }, 'Readiness check failed');
    }
    
    res.status(statusCode).json(response);
    
  } catch (error) {
    // Unexpected error during health check
    healthLogger.error({
      error: error.message,
      stack: error.stack
    }, 'Readiness check error');
    
    res.status(503).json({
      status: 'error',
      service: 'webhook-dispatcher-api',
      timestamp: new Date().toISOString(),
      error: 'Health check failed'
    });
  }
});

export default router;
