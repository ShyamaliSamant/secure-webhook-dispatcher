# Phase 3: Observability & Monitoring - Implementation Plan

**Date:** November 21, 2026  
**Project:** Webhook Dispatcher Engine  
**Status:** Ready for Implementation (Pending Approval)

---

## Table of Contents

1. [Overview](#overview)
2. [Implementation Roadmap](#implementation-roadmap)
3. [Feature Details](#feature-details)
4. [Testing Strategy](#testing-strategy)
5. [Configuration](#configuration)
6. [Rollback Plan](#rollback-plan)

---

## Overview

### Goals

Implement production-grade observability features to enable:
- **Operational visibility:** Know what's happening in production
- **Debugging:** Quickly identify and diagnose issues
- **Performance monitoring:** Track system health and performance
- **Alerting:** Get notified of problems proactively
- **Compliance:** Meet operational SLAs and audit requirements

### Priorities

**P0 (Critical):** Must implement for production readiness
**P1 (High):** Should implement for operational excellence
**P2 (Medium):** Nice to have for enhanced monitoring
**P3 (Low):** Future enhancements

### Non-Goals (Out of Scope for Phase 3)

- ❌ UI/Dashboard (separate Phase 4)
- ❌ External integrations (PagerDuty, Datadog) beyond Prometheus
- ❌ Advanced analytics (ML-based anomaly detection)
- ❌ Multi-region deployment features

---

## Implementation Roadmap

### Timeline Estimate

- **P0 Features:** 8-10 hours
- **P1 Features:** 6-8 hours
- **P2 Features:** 4-6 hours
- **Testing:** 4-6 hours
- **Documentation:** 2-3 hours
- **Total:** ~25-35 hours

### Implementation Sequence

```
Phase 3.1: Foundation (P0)
├─ Step 1: Structured Logging       [2-3h]
├─ Step 2: Health Checks            [2h]
├─ Step 3: Basic Metrics            [3-4h]
└─ Test P0 Features                 [1-2h]

Phase 3.2: Core Features (P1)
├─ Step 4: Request ID Tracking      [1-2h]
├─ Step 5: Job Status API           [2-3h]
├─ Step 6: Dead Letter Queue        [3-4h]
└─ Test P1 Features                 [2-3h]

Phase 3.3: Enhancements (P2)
├─ Step 7: Statistics Endpoint      [2h]
├─ Step 8: Advanced Metrics         [2-3h]
└─ Test P2 Features                 [1h]

Phase 3.4: Documentation & Polish
├─ Update README                    [1h]
├─ Update Continuation Guide        [1h]
├─ Create Operations Manual         [1-2h]
└─ Final Integration Test           [1h]
```

---

## Feature Details

---

## STEP 1: Structured Logging (P0 - Critical)

### Objective

Replace console.log with structured JSON logging using Pino for:
- Consistent log format
- Log levels (debug, info, warn, error, fatal)
- Contextual information (timestamps, service name, hostname)
- Machine-parseable logs for analysis

### Dependencies

```bash
npm install pino pino-pretty
```

- **pino:** Fast, low-overhead JSON logger
- **pino-pretty:** Pretty-print logs in development

### Files to Create

**1. `src/utils/logger.js`** (New file)

```javascript
import pino from 'pino';

const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Create Pino logger with environment-appropriate configuration
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  
  // Production: JSON output for log aggregation
  // Development: Pretty-printed for readability
  transport: isDevelopment ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname'
    }
  } : undefined,
  
  // Base context included in every log
  base: {
    service: process.env.SERVICE_NAME || 'webhook-dispatcher',
    environment: process.env.NODE_ENV || 'development',
    pid: process.pid
  },
  
  // Redact sensitive fields
  redact: {
    paths: [
      'password',
      'destinationUrl',  // May contain credentials
      'payload.password',
      'payload.secret',
      'payload.token',
      'req.headers.authorization',
      'res.headers["set-cookie"]'
    ],
    remove: true  // Remove rather than mask
  },
  
  // Custom serializers
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
      headers: {
        'user-agent': req.headers['user-agent'],
        'content-type': req.headers['content-type']
      },
      remoteAddress: req.socket?.remoteAddress,
      remotePort: req.socket?.remotePort
    }),
    res: (res) => ({
      statusCode: res.statusCode
    }),
    err: pino.stdSerializers.err
  }
});

/**
 * Create child logger with additional context
 */
export function createLogger(context) {
  return logger.child(context);
}

/**
 * Log levels:
 * - trace: Very detailed debugging
 * - debug: Detailed debugging
 * - info: General information
 * - warn: Warning messages
 * - error: Error messages
 * - fatal: Fatal errors (process will exit)
 */
```

### Files to Modify

**2. `src/app.js`** - Add logging middleware

```javascript
import { logger } from './utils/logger.js';
import { randomUUID } from 'crypto';

// Request ID middleware (before routes)
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// Logging middleware (before routes)
app.use((req, res, next) => {
  const startTime = Date.now();
  
  // Log request
  logger.info({
    req,
    requestId: req.id
  }, 'Incoming request');
  
  // Log response
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    
    logger.info({
      requestId: req.id,
      res,
      duration
    }, 'Request completed');
  });
  
  next();
});

// Update error handler
app.use((err, req, res, next) => {
  logger.error({
    err,
    requestId: req.id
  }, 'Request error');
  
  // ... rest of error handler
});
```

**3. `src/controllers/webhookController.js`** - Replace console with logger

```javascript
import { logger } from '../utils/logger.js';

export async function dispatchWebhook(req, res) {
  try {
    const { destinationUrl, eventId, payload } = req.body;
    const jobId = generateJobId();
    
    logger.info({
      jobId,
      eventId,
      requestId: req.id,
      destination: new URL(destinationUrl).hostname
    }, 'Dispatching webhook');
    
    const jobData = { /* ... */ };
    await addWebhookJob(jobData);
    
    logger.info({
      jobId,
      eventId,
      requestId: req.id
    }, 'Webhook queued successfully');
    
    return res.status(202).json({ status: 'queued', jobId });
    
  } catch (error) {
    logger.error({
      error: error.message,
      code: error.code,
      requestId: req.id
    }, 'Failed to queue webhook');
    
    // ... rest of error handling
  }
}
```

**4. `src/workers/webhookWorker.js`** - Replace console with logger

```javascript
import { createLogger } from '../utils/logger.js';

const workerLogger = createLogger({ component: 'worker' });

async function processWebhookJob(job) {
  const { jobId, destinationUrl, eventId } = job.data;
  const jobLogger = workerLogger.child({ jobId, eventId });
  
  jobLogger.info({
    attempt: job.attemptsMade + 1,
    maxAttempts: job.opts.attempts,
    destination: new URL(destinationUrl).hostname
  }, 'Processing webhook job');
  
  try {
    const result = await deliverWebhook(job.data);
    
    jobLogger.info({
      statusCode: result.statusCode,
      message: result.message
    }, 'Delivery successful');
    
    return result;
    
  } catch (error) {
    jobLogger.error({
      error: error.message,
      permanent: error.permanent,
      statusCode: error.statusCode
    }, 'Delivery failed');
    
    if (error.permanent) {
      jobLogger.warn({ error: error.message }, 'Permanent failure - will not retry');
      throw new UnrecoverableError(error.message);
    }
    
    jobLogger.warn({ error: error.message }, 'Temporary failure - will retry');
    throw error;
  }
}
```

**5. `src/workers/deliveryService.js`** - Replace console with logger

```javascript
import { createLogger } from '../utils/logger.js';

const deliveryLogger = createLogger({ component: 'delivery' });

export async function deliverWebhook(jobData) {
  const { jobId, destinationUrl, eventId } = jobData;
  const jobLogger = deliveryLogger.child({ jobId, eventId });
  
  jobLogger.debug('Validating destination URL');
  const validation = await validateDestinationUrl(destinationUrl);
  
  if (!validation.valid) {
    jobLogger.warn({
      error: validation.error
    }, 'SSRF validation failed');
    
    const error = new Error(`SSRF validation failed: ${validation.error}`);
    error.permanent = true;
    throw error;
  }
  
  jobLogger.debug('URL validation passed');
  
  // ... DNS resolution
  jobLogger.debug({
    hostname,
    addressCount: addresses.length
  }, 'DNS resolved');
  
  // ... Connection pinning
  jobLogger.info({
    pinnedIP: targetIP,
    family: targetFamily
  }, 'Connection pinned to IP');
  
  // ... HTTP request
  jobLogger.debug({
    method: 'POST',
    protocol: parsedUrl.protocol,
    hostname,
    port,
    path
  }, 'Sending HTTP request');
  
  // ... Response handling
  jobLogger.info({
    statusCode,
    duration: Date.now() - startTime
  }, 'Received HTTP response');
}
```

### Configuration

Add to `.env`:

```env
# Logging Configuration
LOG_LEVEL=info                    # trace, debug, info, warn, error, fatal
NODE_ENV=production               # development, production
SERVICE_NAME=webhook-dispatcher   # Service identifier
```

### Testing

**Test File:** `test-structured-logging.js`

```javascript
import { logger } from './src/utils/logger.js';

// Test 1: Verify JSON format
console.log('\nTest 1: JSON Format');
logger.info({ test: true }, 'Test message');

// Test 2: Verify log levels
console.log('\nTest 2: Log Levels');
logger.trace('Trace message'); // Not logged if level=info
logger.debug('Debug message'); // Not logged if level=info
logger.info('Info message');   // Logged
logger.warn('Warn message');   // Logged
logger.error('Error message'); // Logged

// Test 3: Verify redaction
console.log('\nTest 3: Sensitive Data Redaction');
logger.info({
  password: 'secret123',
  destinationUrl: 'https://user:pass@example.com/webhook',
  payload: { data: 'safe', token: 'should-be-redacted' }
}, 'Test redaction');

// Test 4: Verify child logger
console.log('\nTest 4: Child Logger Context');
const childLogger = logger.child({ jobId: 'test-123', eventId: 'evt-456' });
childLogger.info('Message with context');

console.log('\n✅ All logging tests complete - Check output format');
```

**Run test:**
```bash
node test-structured-logging.js
```

**Expected output (production):**
```json
{"level":30,"time":1700000000000,"service":"webhook-dispatcher","jobId":"test-123","eventId":"evt-456","msg":"Message with context"}
```

**Expected output (development):**
```
[14:30:15] INFO  (webhook-dispatcher): Message with context
    jobId: "test-123"
    eventId: "evt-456"
```

### Impact on Existing Features

- **No breaking changes** - Logs still go to stdout/stderr
- **Log format changes** - From plain text to JSON (may affect log parsing)
- **Performance:** Pino is faster than console.log (<5% overhead)
- **All Phase 1 & 2 tests should still pass** - Logging is output only

---

## STEP 2: Health Checks (P0 - Critical)

### Objective

Enhance health checks to verify actual system health:
- API health check verifies Redis connectivity
- Worker health endpoint on separate port
- Liveness and readiness probes

### Files to Create

**1. `src/services/healthService.js`** (New file)

```javascript
import { redisConnection } from '../config/redis.js';
import { logger } from '../utils/logger.js';

/**
 * Check Redis connectivity by sending PING command
 * @returns {Promise<{healthy: boolean, latency: number, error?: string}>}
 */
export async function checkRedis() {
  const startTime = Date.now();
  
  try {
    // BullMQ uses ioredis, which has ping() method
    if (typeof redisConnection === 'string') {
      // Connection string - can't ping directly
      return {
        healthy: true,
        latency: Date.now() - startTime,
        note: 'Connection string used - cannot verify'
      };
    }
    
    // For object config, we need to create a test client
    // This is safe because ioredis reuses connections
    const IORedis = (await import('ioredis')).default;
    const testClient = new IORedis(redisConnection);
    
    await testClient.ping();
    const latency = Date.now() - startTime;
    
    await testClient.quit();
    
    return {
      healthy: true,
      latency
    };
    
  } catch (error) {
    logger.error({ error: error.message }, 'Redis health check failed');
    
    return {
      healthy: false,
      latency: Date.now() - startTime,
      error: error.message
    };
  }
}

/**
 * Get queue statistics
 * @param {Queue} queue - BullMQ Queue instance
 * @returns {Promise<Object>} Queue statistics
 */
export async function getQueueStats(queue) {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount()
    ]);
    
    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      total: waiting + active + completed + failed + delayed
    };
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get queue stats');
    return null;
  }
}
```

**2. `src/routes/healthRoutes.js`** (New file)

```javascript
import express from 'express';
import { checkRedis, getQueueStats } from '../services/healthService.js';
import { webhookQueue } from '../queues/webhookQueue.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/**
 * Basic health check - process is running
 * GET /health
 */
router.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'healthy',
    service: 'webhook-dispatcher-api',
    timestamp: new Date().toISOString()
  });
});

/**
 * Readiness check - can accept traffic
 * GET /health/ready
 */
router.get('/health/ready', async (req, res) => {
  try {
    const redis = await checkRedis();
    
    if (!redis.healthy) {
      return res.status(503).json({
        success: false,
        status: 'not ready',
        reason: 'Redis connection failed',
        redis,
        timestamp: new Date().toISOString()
      });
    }
    
    return res.status(200).json({
      success: true,
      status: 'ready',
      checks: {
        redis: {
          healthy: true,
          latency: redis.latency
        }
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error({ error: error.message }, 'Readiness check failed');
    
    return res.status(503).json({
      success: false,
      status: 'not ready',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Detailed health check with dependencies
 * GET /health/detailed
 */
router.get('/health/detailed', async (req, res) => {
  try {
    const redis = await checkRedis();
    const queueStats = await getQueueStats(webhookQueue);
    
    const isHealthy = redis.healthy;
    
    return res.status(isHealthy ? 200 : 503).json({
      success: isHealthy,
      status: isHealthy ? 'healthy' : 'unhealthy',
      service: 'webhook-dispatcher-api',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      checks: {
        redis,
        queue: queueStats
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error({ error: error.message }, 'Detailed health check failed');
    
    return res.status(503).json({
      success: false,
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

export default router;
```

### Files to Modify

**3. `src/app.js`** - Add health routes

```javascript
import healthRoutes from './routes/healthRoutes.js';

// Remove old health check
// app.get('/health', ...)

// Add new health routes
app.use(healthRoutes);

// Rest of routes
app.use('/api/webhooks', webhookRoutes);
```

**4. `worker.js`** - Add worker health check server

```javascript
import express from 'express';
import { createLogger } from './src/utils/logger.js';

const workerLogger = createLogger({ component: 'worker-health' });

// Create health check server on separate port
const healthApp = express();
const HEALTH_PORT = process.env.WORKER_HEALTH_PORT || 5001;

healthApp.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'healthy',
    service: 'webhook-dispatcher-worker',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

healthApp.get('/health/ready', (req, res) => {
  // Worker is ready if it's connected to Redis
  // This is indicated by worker.on('ready') event
  const isReady = worker.isRunning();
  
  res.status(isReady ? 200 : 503).json({
    success: isReady,
    status: isReady ? 'ready' : 'not ready',
    timestamp: new Date().toISOString()
  });
});

healthApp.listen(HEALTH_PORT, () => {
  workerLogger.info({
    port: HEALTH_PORT
  }, 'Worker health check server started');
});
```

### Configuration

Add to `.env`:

```env
# Health Check Configuration
WORKER_HEALTH_PORT=5001   # Worker health check port
```

### Testing

**Test File:** `test-health-checks.js`

```javascript
// Test API health checks
const tests = [
  { name: 'Basic health', url: 'http://localhost:5000/health', expectStatus: 200 },
  { name: 'Readiness check', url: 'http://localhost:5000/health/ready', expectStatus: 200 },
  { name: 'Detailed health', url: 'http://localhost:5000/health/detailed', expectStatus: 200 },
  { name: 'Worker health', url: 'http://localhost:5001/health', expectStatus: 200 }
];

for (const test of tests) {
  const response = await fetch(test.url);
  const data = await response.json();
  
  console.log(`${test.name}: ${response.status === test.expectStatus ? '✅' : '❌'}`);
  console.log(JSON.stringify(data, null, 2));
}
```

### Impact on Existing Features

- **Phase 1 health tests need update** - Endpoint path unchanged, response format enhanced
- **No breaking changes** - Old health endpoint still works (/health)
- **New endpoints** - /health/ready, /health/detailed (additional)
- **Worker health** - New port 5001 (doesn't conflict with API port 5000)

---

## STEP 3: Basic Metrics (P0 - Critical)

### Objective

Collect and expose basic metrics in Prometheus format:
- Request counters
- Job counters
- Delivery success/failure rates
- HTTP response times

### Dependencies

```bash
npm install prom-client
```

### Files to Create

**1. `src/utils/metrics.js`** (New file)

```javascript
import { Registry, Counter, Histogram, Gauge } from 'prom-client';

// Create a Registry to register the metrics
export const register = new Registry();

// Add default metrics (process CPU, memory, etc.)
import { collectDefaultMetrics } from 'prom-client';
collectDefaultMetrics({ register });

/**
 * API Metrics
 */

// HTTP request counter
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

// HTTP request duration
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register]
});

/**
 * Webhook Queue Metrics
 */

// Webhooks queued
export const webhooksQueued = new Counter({
  name: 'webhooks_queued_total',
  help: 'Total number of webhooks queued',
  registers: [register]
});

// Webhook queue failures
export const webhookQueueFailures = new Counter({
  name: 'webhook_queue_failures_total',
  help: 'Total number of webhook queue failures',
  labelNames: ['reason'],
  registers: [register]
});

/**
 * Worker Metrics
 */

// Jobs processed
export const jobsProcessed = new Counter({
  name: 'jobs_processed_total',
  help: 'Total number of jobs processed',
  labelNames: ['status'],  // completed, failed
  registers: [register]
});

// Job processing duration
export const jobProcessingDuration = new Histogram({
  name: 'job_processing_duration_seconds',
  help: 'Job processing duration in seconds',
  labelNames: ['status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register]
});

// Active jobs gauge
export const activeJobs = new Gauge({
  name: 'active_jobs',
  help: 'Number of currently active jobs',
  registers: [register]
});

/**
 * Delivery Metrics
 */

// Webhook deliveries
export const webhookDeliveries = new Counter({
  name: 'webhook_deliveries_total',
  help: 'Total number of webhook deliveries',
  labelNames: ['status', 'status_code'],  // success/failed, HTTP status
  registers: [register]
});

// Delivery attempts
export const deliveryAttempts = new Counter({
  name: 'delivery_attempts_total',
  help: 'Total number of delivery attempts',
  labelNames: ['attempt_number'],
  registers: [register]
});

// Delivery duration
export const deliveryDuration = new Histogram({
  name: 'delivery_duration_seconds',
  help: 'Webhook delivery duration in seconds',
  labelNames: ['status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register]
});

// Permanent failures by reason
export const permanentFailures = new Counter({
  name: 'permanent_failures_total',
  help: 'Total number of permanent failures',
  labelNames: ['reason'],  // ssrf, http_4xx, redirect, etc.
  registers: [register]
});

/**
 * Queue Statistics Gauges
 */

export const queueWaiting = new Gauge({
  name: 'queue_waiting_jobs',
  help: 'Number of jobs waiting in queue',
  registers: [register]
});

export const queueActive = new Gauge({
  name: 'queue_active_jobs',
  help: 'Number of active jobs',
  registers: [register]
});

export const queueCompleted = new Gauge({
  name: 'queue_completed_jobs',
  help: 'Number of completed jobs',
  registers: [register]
});

export const queueFailed = new Gauge({
  name: 'queue_failed_jobs',
  help: 'Number of failed jobs',
  registers: [register]
});

export const queueDelayed = new Gauge({
  name: 'queue_delayed_jobs',
  help: 'Number of delayed jobs',
  registers: [register]
});
```

**2. `src/routes/metricsRoutes.js`** (New file)

```javascript
import express from 'express';
import { register } from '../utils/metrics.js';

const router = express.Router();

/**
 * Prometheus metrics endpoint
 * GET /metrics
 */
router.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    res.status(500).end(error.message);
  }
});

export default router;
```

### Files to Modify

**3. `src/app.js`** - Add metrics middleware and routes

```javascript
import metricsRoutes from './routes/metricsRoutes.js';
import { httpRequestsTotal, httpRequestDuration } from './utils/metrics.js';

// Metrics middleware (before routes)
app.use((req, res, next) => {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const route = req.route?.path || req.path;
    
    httpRequestsTotal.inc({
      method: req.method,
      route,
      status_code: res.statusCode
    });
    
    httpRequestDuration.observe({
      method: req.method,
      route,
      status_code: res.statusCode
    }, duration);
  });
  
  next();
});

// Add metrics routes
app.use(metricsRoutes);
```

**4. `src/controllers/webhookController.js`** - Track webhook queuing

```javascript
import { webhooksQueued, webhookQueueFailures } from '../utils/metrics.js';

export async function dispatchWebhook(req, res) {
  try {
    // ... existing code
    await addWebhookJob(jobData);
    
    // Track successful queuing
    webhooksQueued.inc();
    
    return res.status(202).json({ status: 'queued', jobId });
    
  } catch (error) {
    // Track queue failures
    const reason = isConnectionError ? 'redis_connection' : 'unknown';
    webhookQueueFailures.inc({ reason });
    
    // ... existing error handling
  }
}
```

**5. `src/workers/webhookWorker.js`** - Track job processing

```javascript
import {
  jobsProcessed,
  jobProcessingDuration,
  activeJobs,
  deliveryAttempts
} from '../utils/metrics.js';

async function processWebhookJob(job) {
  const startTime = Date.now();
  activeJobs.inc();
  
  try {
    // Track attempt number
    deliveryAttempts.inc({
      attempt_number: String(job.attemptsMade + 1)
    });
    
    const result = await deliverWebhook(job.data);
    
    // Track success
    const duration = (Date.now() - startTime) / 1000;
    jobsProcessed.inc({ status: 'completed' });
    jobProcessingDuration.observe({ status: 'completed' }, duration);
    
    return result;
    
  } catch (error) {
    // Track failure
    const duration = (Date.now() - startTime) / 1000;
    jobsProcessed.inc({ status: 'failed' });
    jobProcessingDuration.observe({ status: 'failed' }, duration);
    
    throw error;
  } finally {
    activeJobs.dec();
  }
}
```

**6. `src/workers/deliveryService.js`** - Track delivery metrics

```javascript
import {
  webhookDeliveries,
  deliveryDuration,
  permanentFailures
} from '../utils/metrics.js';

export async function deliverWebhook(jobData) {
  const startTime = Date.now();
  
  try {
    // ... validation
    if (!validation.valid) {
      permanentFailures.inc({ reason: 'ssrf' });
      // ... throw error
    }
    
    // ... HTTP request
    const statusCode = res.statusCode;
    const duration = (Date.now() - startTime) / 1000;
    
    if (statusCode >= 200 && statusCode < 300) {
      webhookDeliveries.inc({ status: 'success', status_code: String(statusCode) });
      deliveryDuration.observe({ status: 'success' }, duration);
    } else if (statusCode >= 400 && statusCode < 500) {
      webhookDeliveries.inc({ status: 'failed', status_code: String(statusCode) });
      deliveryDuration.observe({ status: 'failed' }, duration);
      permanentFailures.inc({ reason: 'http_4xx' });
    } else if (statusCode >= 500) {
      webhookDeliveries.inc({ status: 'failed', status_code: String(statusCode) });
      deliveryDuration.observe({ status: 'failed' }, duration);
    }
    
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    deliveryDuration.observe({ status: 'failed' }, duration);
    throw error;
  }
}
```

### Testing

**Test Metrics Endpoint:**

```bash
# Start API and Worker
npm start &
npm run worker &

# Generate some traffic
curl -X POST http://localhost:5000/api/webhooks/dispatch \
  -H "Content-Type: application/json" \
  -d '{"destinationUrl":"https://httpbin.org/post","eventId":"test","payload":{}}'

# Check metrics
curl http://localhost:5000/metrics
```

**Expected output (excerpt):**

```
# HELP http_requests_total Total number of HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="POST",route="/api/webhooks/dispatch",status_code="202"} 1

# HELP webhooks_queued_total Total number of webhooks queued
# TYPE webhooks_queued_total counter
webhooks_queued_total 1

# HELP jobs_processed_total Total number of jobs processed
# TYPE jobs_processed_total counter
jobs_processed_total{status="completed"} 1

# HELP webhook_deliveries_total Total number of webhook deliveries
# TYPE webhook_deliveries_total counter
webhook_deliveries_total{status="success",status_code="200"} 1
```

### Impact on Existing Features

- **No breaking changes** - Metrics collection is passive
- **Performance:** <2% overhead (Prometheus client is optimized)
- **Memory:** ~1-2MB for metrics registry
- **All Phase 1 & 2 tests should still pass**

---

## STEP 4-6: Additional Features (P1)

Due to length, Steps 4-6 (Request ID, Job Status API, DLQ) will be documented in separate sections upon approval of P0 features.

---

## Configuration Reference

### Environment Variables (Phase 3)

```env
# Logging
LOG_LEVEL=info                    # trace, debug, info, warn, error, fatal
NODE_ENV=production               # development, production
SERVICE_NAME=webhook-dispatcher

# Health Checks
WORKER_HEALTH_PORT=5001

# Metrics
METRICS_ENABLED=true              # Enable/disable metrics collection

# Future (P1+)
# ENABLE_JOB_STATUS_API=true
# ENABLE_DLQ=true
# DLQ_RETENTION_DAYS=30
```

---

## Testing Strategy

### Regression Testing

After each step, run full test suite:

```bash
# Phase 1 tests
node phase1-final-test.js
# Expected: 20/20 PASS

# Phase 2 tests
node final-phase2-verification.js
# Expected: 7/7 PASS

# Phase 3 tests (new)
node test-phase3-observability.js
# Expected: All new features tested
```

### New Test Files

1. **`test-structured-logging.js`** - Verify JSON logging format
2. **`test-health-checks.js`** - Verify health endpoints
3. **`test-metrics.js`** - Verify Prometheus metrics
4. **`test-phase3-integration.js`** - End-to-end Phase 3 test

---

## Rollback Plan

### If Issues Arise

**Step 1: Disable Phase 3 Features**

Set environment variables:
```env
LOG_LEVEL=error           # Reduce logging verbosity
METRICS_ENABLED=false     # Disable metrics collection
```

**Step 2: Revert Code (if needed)**

All Phase 3 changes are additive. To fully revert:
1. Keep existing files unchanged
2. Remove new files (`src/utils/logger.js`, `src/utils/metrics.js`, etc.)
3. Revert modified files to Phase 2 versions
4. Restart services

**Step 3: Verify System Health**

```bash
# Run regression tests
node phase1-final-test.js
node final-phase2-verification.js

# Both should pass with or without Phase 3
```

---

## Next Steps

**Awaiting Approval:**

1. ✅ Review audit report (`PHASE3_OBSERVABILITY_AUDIT.md`)
2. ✅ Review implementation plan (this document)
3. ⏳ **Get approval to proceed with P0 features (Steps 1-3)**
4. ⏳ Implement P0 features
5. ⏳ Test P0 features
6. ⏳ Get approval for P1 features (Steps 4-6)

**DO NOT START IMPLEMENTATION until explicit approval is received.**

---

**End of Implementation Plan**

