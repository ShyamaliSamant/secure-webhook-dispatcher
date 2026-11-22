import { Worker, UnrecoverableError } from 'bullmq';
import Redis from 'ioredis';
import { getWorkerRedisConnection } from '../config/redis.js';
import { deliverWebhook } from './deliveryService.js';
import { createLogger, sanitizeUrl } from '../utils/logger.js';
import { 
  updateWorkerHeartbeat, 
  removeWorkerHeartbeat, 
  getWorkerHeartbeatConfig 
} from '../services/healthService.js';
import {
  recordDeliverySuccess,
  recordDeliveryFailure,
  recordRetryAttempt
} from '../services/metricsService.js';
import { addToDLQ } from '../services/dlqService.js';
import { closeDestinationRateLimiter } from '../utils/destinationRateLimiter.js';

// Worker logger with component context
const workerLogger = createLogger({ component: 'worker' });

// Heartbeat state
let heartbeatInterval = null;
let heartbeatRedisClient = null;

// Worker configuration from environment
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);
const WORKER_JOB_LOCK_DURATION =
  parseInt(process.env.WORKER_JOB_LOCK_DURATION_MS || '300000', 10);

/**
 * Process a webhook delivery job
 * 
 * @param {Object} job - BullMQ job object
 * @returns {Promise<Object>} Processing result
 */
async function processWebhookJob(job, token) {
  const { jobId, destinationUrl, eventId, payload } = job.data;
  
  // Create job-specific logger with context
  const jobLogger = workerLogger.child({ jobId, eventId });
  
  // Record retry metric if this is not the first attempt
  if (job.attemptsMade > 0) {
    recordRetryAttempt();
  }
  
  jobLogger.info({
    attempt: job.attemptsMade + 1,
    maxAttempts: job.opts.attempts,
    destination: sanitizeUrl(destinationUrl)
  }, 'Processing webhook job');
  
  const startTime = Date.now();
  
  try {
    // Deliver webhook via HTTP POST
    const result = await deliverWebhook(job.data, {
      renewLock: async () => {
        if (token) {
          await job.extendLock(token, WORKER_JOB_LOCK_DURATION);
        }
      }
    });
    
    const durationSeconds = (Date.now() - startTime) / 1000;
    
    jobLogger.info({
      message: result.message,
      statusCode: result.statusCode
    }, 'Delivery successful');
    
    // Record success metric
    recordDeliverySuccess(durationSeconds);
    
    return result;
    
  } catch (error) {
    const durationSeconds = (Date.now() - startTime) / 1000;
    
    jobLogger.error({
      error: error.message,
      permanent: error.permanent,
      statusCode: error.statusCode
    }, 'Delivery failed');
    
    // Check if this is a permanent failure (SSRF, 4xx errors)
    if (error.permanent) {
      jobLogger.warn({
        error: error.message
      }, 'Permanent failure - will not retry');
      
      // Record permanent failure metric
      recordDeliveryFailure('permanent', durationSeconds);
      
      // Add to DLQ immediately for permanent failures
      await addToDLQ(job, error.message, true);
      
      // Throw UnrecoverableError to prevent BullMQ retries
      // This moves the job to failed state immediately without consuming retry attempts
      throw new UnrecoverableError(error.message);
    }
    
    // For temporary failures (network errors, 5xx), throw to trigger BullMQ retry
    jobLogger.warn({
      error: error.message
    }, 'Temporary failure - will retry');
    throw error;
  }
}

/**
 * Initialize and start the webhook worker
 * 
 * @returns {Worker} BullMQ Worker instance
 */
export function startWebhookWorker() {
  workerLogger.info({
    concurrency: WORKER_CONCURRENCY,
    timeout: process.env.WEBHOOK_TIMEOUT || 30000,
    maxResponseSize: process.env.MAX_RESPONSE_SIZE || 1048576
  }, 'Starting Webhook Worker');
  
  // Create worker with worker-specific Redis configuration
  const worker = new Worker(
    'webhooks',  // Queue name (must match queue in webhookQueue.js)
    processWebhookJob,  // Job processor function
    {
      connection: getWorkerRedisConnection(),
      concurrency: WORKER_CONCURRENCY,
      
      // Prevent job stalling detection issues
      lockDuration: WORKER_JOB_LOCK_DURATION,
      
      // Remove completed jobs (keep for 24 hours as configured in queue)
      removeOnComplete: { count: 0 },  // Let queue config handle retention
      
      // Remove failed jobs (keep for 7 days as configured in queue)
      removeOnFail: { count: 0 }  // Let queue config handle retention
    }
  );
  
  // Event: Job completed successfully
  worker.on('completed', (job, result) => {
    workerLogger.info({
      jobId: job.data.jobId,
      eventId: job.data.eventId
    }, 'Job completed');
  });
  
  // Event: Job failed
  worker.on('failed', async (job, error) => {
    if (job) {
      // Check if job has exhausted retries (not a permanent failure)
      const exhaustedRetries = job.attemptsMade >= job.opts.attempts && !(error instanceof UnrecoverableError);
      
      if (exhaustedRetries) {
        // Record exhausted retries failure
        recordDeliveryFailure('exhausted');
        
        // Add to DLQ after retries are exhausted
        await addToDLQ(job, error.message, false);
      }
      
      workerLogger.error({
        jobId: job.data.jobId,
        eventId: job.data.eventId,
        attempts: job.attemptsMade,
        error: error.message
      }, 'Job failed');
    } else {
      workerLogger.error({
        error: error.message
      }, 'Job failed');
    }
  });
  
  // Event: Worker error
  worker.on('error', (error) => {
    workerLogger.error({
      error: error.message
    }, 'Worker error');
  });
  
  // Event: Worker ready
  worker.on('ready', () => {
    workerLogger.info('Worker connected to Redis and ready to process jobs');
    
    // Start heartbeat mechanism when worker is ready
    startHeartbeat();
  });
  
  // Event: Worker stalled
  worker.on('stalled', (jobId) => {
    workerLogger.warn({ jobId }, 'Job has stalled');
  });
  
  workerLogger.info('Webhook Worker started successfully, waiting for jobs');
  
  return worker;
}

/**
 * Start worker heartbeat mechanism
 * Updates Redis key periodically to indicate worker is alive
 */
function startHeartbeat() {
  // Create dedicated Redis client for heartbeat (reuse worker connection config)
  const config = getWorkerRedisConnection();
  heartbeatRedisClient = new Redis(config);
  
  heartbeatRedisClient.on('error', (error) => {
    workerLogger.warn({
      error: error.message
    }, 'Heartbeat Redis client error');
  });
  
  const heartbeatConfig = getWorkerHeartbeatConfig();
  
  workerLogger.info({
    interval: heartbeatConfig.updateInterval,
    ttl: heartbeatConfig.ttl
  }, 'Starting worker heartbeat');
  
  // Send initial heartbeat immediately
  updateWorkerHeartbeat(heartbeatRedisClient).catch(err => {
    workerLogger.warn({
      error: err.message
    }, 'Initial heartbeat failed');
  });
  
  // Set up periodic heartbeat updates
  heartbeatInterval = setInterval(() => {
    updateWorkerHeartbeat(heartbeatRedisClient).catch(err => {
      workerLogger.warn({
        error: err.message
      }, 'Heartbeat update failed');
    });
  }, heartbeatConfig.updateInterval);
  
  // Prevent heartbeat interval from keeping process alive during shutdown
  if (heartbeatInterval.unref) {
    heartbeatInterval.unref();
  }
}

/**
 * Stop worker heartbeat mechanism
 * Clears interval and removes heartbeat key
 */
async function stopHeartbeat() {
  workerLogger.info('Stopping worker heartbeat');
  
  // Clear interval
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  
  // Remove heartbeat key from Redis
  if (heartbeatRedisClient) {
    try {
      await removeWorkerHeartbeat(heartbeatRedisClient);
      await heartbeatRedisClient.quit();
      heartbeatRedisClient = null;
    } catch (error) {
      workerLogger.warn({
        error: error.message
      }, 'Error stopping heartbeat');
    }
  }
}

/**
 * Gracefully shutdown the worker
 * 
 * @param {Worker} worker - BullMQ Worker instance
 * @returns {Promise<void>}
 */
export async function shutdownWorker(worker) {
  workerLogger.info('Shutting down worker, waiting for active jobs to complete');
  
  try {
    // Stop heartbeat first (removes heartbeat key)
    await stopHeartbeat();
    
    // Close worker gracefully (waits for active jobs to complete)
    await worker.close();
    await closeDestinationRateLimiter();
    workerLogger.info('Worker shutdown complete');
  } catch (error) {
    workerLogger.error({
      error: error.message
    }, 'Error during worker shutdown');
    throw error;
  }
}
