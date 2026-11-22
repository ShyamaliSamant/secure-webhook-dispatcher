/**
 * Job Status Controller
 * Handles GET /api/webhooks/status/:jobId
 * 
 * Returns the status of a previously submitted webhook job.
 * Does NOT expose sensitive data (payload, destinationUrl, credentials).
 */

import { webhookQueue } from '../queues/webhookQueue.js';
import { logger } from '../utils/logger.js';

const statusLogger = logger.child({ component: 'job-status' });

/**
 * Validate jobId format (UUID v4)
 * @param {string} jobId - Job ID to validate
 * @returns {boolean} True if valid UUID v4 format
 */
function isValidJobId(jobId) {
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidV4Regex.test(jobId);
}

/**
 * Get job status by jobId
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function getJobStatus(req, res) {
  const { jobId } = req.params;
  
  try {
    // Validate jobId format
    if (!isValidJobId(jobId)) {
      statusLogger.debug({ jobId }, 'Invalid jobId format');
      return res.status(400).json({
        success: false,
        error: 'Invalid job ID format',
        details: 'Job ID must be a valid UUID v4'
      });
    }
    
    statusLogger.debug({ jobId }, 'Fetching job status');
    
    // Get job from BullMQ queue
    const job = await webhookQueue.getJob(jobId);
    
    // Job not found
    if (!job) {
      statusLogger.debug({ jobId }, 'Job not found');
      return res.status(404).json({
        success: false,
        error: 'Job not found',
        details: `No job found with ID: ${jobId}`
      });
    }
    
    // Get job state
    const state = await job.getState();
    
    // Build response (exclude sensitive data)
    const response = {
      success: true,
      jobId: job.id,
      status: state,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts,
      createdAt: job.data.createdAt,
      timestamp: new Date().toISOString()
    };
    
    // Add processedAt if job has been processed
    if (job.processedOn) {
      response.processedAt = new Date(job.processedOn).toISOString();
    }
    
    // Add finishedAt if job is completed
    if (job.finishedOn) {
      response.finishedAt = new Date(job.finishedOn).toISOString();
    }
    
    // Add failedAt if job failed
    if (state === 'failed' && job.failedReason) {
      response.failedAt = job.finishedOn ? new Date(job.finishedOn).toISOString() : null;
      // Sanitize error message (don't expose internal details)
      response.failedReason = job.failedReason.includes('SSRF') 
        ? 'Destination validation failed'
        : job.failedReason.includes('HTTP')
        ? 'HTTP delivery error'
        : 'Delivery failed';
    }
    
    statusLogger.info({
      jobId,
      status: state,
      attemptsMade: job.attemptsMade
    }, 'Job status retrieved');
    
    return res.status(200).json(response);
    
  } catch (error) {
    // Log error without exposing internal details
    statusLogger.error({
      jobId,
      error: error.message,
      code: error.code
    }, 'Failed to retrieve job status');
    
    // Check if this is a Redis/queue connection error
    const isConnectionError = 
      error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'EHOSTUNREACH' ||
      (error.message && error.message.includes('Connection is closed'));
    
    if (isConnectionError) {
      // Redis unavailable - return 503 Service Unavailable
      return res.status(503).json({
        success: false,
        error: 'Queue service temporarily unavailable',
        details: 'Unable to retrieve job status. Please try again later.'
      });
    }
    
    // Other errors - return 500 Internal Server Error
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: 'Failed to retrieve job status'
    });
  }
}
