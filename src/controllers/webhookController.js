import { generateJobId } from '../utils/generateJobId.js';
import { addWebhookJob } from '../queues/webhookQueue.js';
import { logger, sanitizeUrl } from '../utils/logger.js';
import { recordJobReceived } from '../services/metricsService.js';

/**
 * Dispatch webhook controller
 * Handles POST /api/webhooks/dispatch
 * 
 * Validates request, generates job ID, and adds job to BullMQ queue.
 * Returns immediately with 202 Accepted - actual delivery happens in worker process.
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function dispatchWebhook(req, res) {
  try {
    const { destinationUrl, eventId, payload } = req.body;

    // Generate unique job ID
    const jobId = generateJobId();

    // Prepare job data structure
    const jobData = {
      jobId,
      destinationUrl,
      eventId,
      payload,
      createdAt: new Date().toISOString()
    };

    logger.info({
      jobId,
      eventId,
      destination: sanitizeUrl(destinationUrl),
      payloadSize: JSON.stringify(payload).length
    }, 'Dispatching webhook');

    // Add job to BullMQ queue
    // This will throw an error if Redis is unavailable
    await addWebhookJob(jobData);

    // Record metric: Job received
    recordJobReceived();

    logger.info({
      jobId,
      eventId
    }, 'Webhook queued successfully');

    // Return 202 Accepted with job ID
    // Job is now in Redis queue and will be processed by worker
    return res.status(202).json({
      status: 'queued',
      jobId
    });

  } catch (error) {
    // Log error without exposing internal details
    logger.error({
      error: error.message,
      code: error.code
    }, 'Failed to queue webhook');
    
    // Check if this is a Redis/queue connection error using error.code
    // This is more reliable than string matching on error.message
    const isConnectionError = 
      error.code === 'ECONNREFUSED' ||   // Redis connection refused
      error.code === 'ETIMEDOUT' ||       // Connection timeout
      error.code === 'ENOTFOUND' ||       // DNS resolution failed
      error.code === 'EHOSTUNREACH' ||    // Network unreachable
      (error.message && error.message.includes('Connection is closed')); // ioredis specific
    
    if (isConnectionError) {
      // Redis unavailable - return 503 Service Unavailable
      return res.status(503).json({
        success: false,
        error: 'Queue service temporarily unavailable',
        details: 'Unable to queue webhook for delivery. Please try again later.'
      });
    }
    
    // Other errors - return 500 Internal Server Error
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: 'Failed to process webhook dispatch request'
    });
  }
}
