import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import { logger, sanitizeUrl } from '../utils/logger.js';

/**
 * BullMQ Queue for webhook dispatch jobs
 * This is the producer side - adds jobs to the queue
 * 
 * IMPORTANT: No Worker is created in this file.
 * Workers are created in separate worker processes.
 */
export const webhookQueue = new Queue('webhooks', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 4,
    backoff: {
      type: 'exponential',
      delay: 2000 // Start with 2 seconds, doubles each retry
    },
    removeOnComplete: {
      age: 86400, // Keep completed jobs for 24 hours
      count: 1000  // Keep max 1000 completed jobs
    },
    removeOnFail: {
      age: 604800  // Keep failed jobs for 7 days
    }
  }
});

// Handle queue connection events
webhookQueue.on('error', (error) => {
  // Log errors but don't crash the application
  logger.error({
    error: error.message,
    component: 'queue'
  }, 'BullMQ Queue error');
});

/**
 * Add a webhook job to the queue
 * 
 * @param {Object} jobData - The webhook job data
 * @param {string} jobData.jobId - Unique job identifier (UUID)
 * @param {string} jobData.destinationUrl - Target webhook URL
 * @param {string} jobData.eventId - User-provided event ID
 * @param {Object} jobData.payload - Webhook payload data
 * @param {string} jobData.createdAt - ISO timestamp when job was created
 * @returns {Promise<Job>} The created BullMQ job
 * @throws {Error} If queue operation fails
 */
export async function addWebhookJob(jobData) {
  try {
    // Extract URL hostname for safe logging (no full URL with potential credentials)
    const urlHostname = sanitizeUrl(jobData.destinationUrl);
    
    // Add job to queue using our jobId as the BullMQ job ID
    // This prevents duplicate jobs with the same UUID
    const job = await webhookQueue.add(
      'dispatch-webhook', // Job name
      {
        jobId: jobData.jobId,
        destinationUrl: jobData.destinationUrl,
        eventId: jobData.eventId,
        payload: jobData.payload,
        createdAt: jobData.createdAt
      },
      {
        jobId: jobData.jobId // Use our UUID as BullMQ job ID (prevents duplicates)
      }
    );

    // Log job addition (sanitized - no full payload or URL credentials)
    logger.info({
      jobId: jobData.jobId,
      eventId: jobData.eventId,
      destination: urlHostname
    }, 'Job queued');
    
    return job;
  } catch (error) {
    // Log error without exposing sensitive data
    logger.error({
      jobId: jobData.jobId,
      error: error.message
    }, 'Failed to queue job');
    throw error;
  }
}

/**
 * Graceful shutdown - close queue connection
 * Call this when shutting down the application
 */
export async function closeQueue() {
  await webhookQueue.close();
  logger.info('Webhook queue closed');
}
