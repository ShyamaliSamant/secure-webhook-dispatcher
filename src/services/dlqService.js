/**
 * Dead Letter Queue (DLQ) Service
 * 
 * Handles permanently failed webhook jobs by moving them to a separate DLQ queue.
 * Provides DLQ listing and manual retry functionality.
 * 
 * Security: Never exposes payloads, destination URLs, credentials, or stack traces.
 */

import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis.js';
import { webhookQueue } from '../queues/webhookQueue.js';
import { generateJobId } from '../utils/generateJobId.js';
import { logger } from '../utils/logger.js';

const dlqLogger = logger.child({ component: 'dlq' });

/**
 * Dead Letter Queue for failed webhooks
 * Stores only safe metadata, never the original payload or destination URL
 */
export const dlqQueue = new Queue('webhook-dlq', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: {
      age: 2592000, // Keep completed DLQ jobs for 30 days
      count: 10000
    },
    removeOnFail: false // Keep failed DLQ operations indefinitely for investigation
  }
});

// Handle DLQ queue connection events
dlqQueue.on('error', (error) => {
  dlqLogger.error({
    error: error.message
  }, 'DLQ Queue error');
});

/**
 * Sanitize failure reason for safe storage/exposure
 * @param {string} errorMessage - Original error message
 * @returns {string} Sanitized error category
 */
function sanitizeFailureReason(errorMessage) {
  if (!errorMessage) return 'Unknown error';
  
  const msg = errorMessage.toLowerCase();
  
  if (msg.includes('ssrf') || msg.includes('validation failed')) {
    return 'Destination validation failed';
  }
  if (msg.includes('http 4')) {
    return 'HTTP client error';
  }
  if (msg.includes('http 5')) {
    return 'HTTP server error';
  }
  if (msg.includes('timeout')) {
    return 'Request timeout';
  }
  if (msg.includes('dns') || msg.includes('enotfound')) {
    return 'DNS resolution failed';
  }
  if (msg.includes('econnrefused') || msg.includes('connection')) {
    return 'Connection refused';
  }
  
  return 'Delivery failed';
}

/**
 * Generate deterministic DLQ job ID from original job ID
 * Prevents duplicate DLQ records for the same original job
 * @param {string} originalJobId - Original webhook job ID
 * @returns {string} DLQ job ID
 */
function generateDlqJobId(originalJobId) {
  return `dlq-${originalJobId}`;
}

/**
 * Add failed job to Dead Letter Queue
 * 
 * @param {Object} job - BullMQ job object that failed
 * @param {string} failureReason - Error message
 * @param {boolean} isPermanent - True for permanent failures, false for exhausted retries
 * @returns {Promise<void>}
 */
export async function addToDLQ(job, failureReason, isPermanent = false) {
  try {
    const originalJobId = job.data.jobId;
    const dlqJobId = generateDlqJobId(originalJobId);
    
    // Check if DLQ record already exists
    const existingDlqJob = await dlqQueue.getJob(dlqJobId);
    if (existingDlqJob) {
      dlqLogger.debug({
        originalJobId,
        dlqJobId
      }, 'DLQ record already exists, skipping duplicate');
      return;
    }
    
    // Create DLQ record with safe metadata only
    const dlqData = {
      originalJobId,
      failedAt: new Date().toISOString(),
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts,
      failureCategory: sanitizeFailureReason(failureReason),
      failureType: isPermanent ? 'permanent' : 'exhausted',
      status: 'pending'
    };
    
    // Add to DLQ queue with deterministic job ID
    await dlqQueue.add('dlq-entry', dlqData, {
      jobId: dlqJobId
    });
    
    dlqLogger.info({
      originalJobId,
      dlqJobId,
      failureType: dlqData.failureType,
      failureCategory: dlqData.failureCategory
    }, 'Job added to DLQ');
    
  } catch (error) {
    // Log DLQ insertion error but don't crash or hide the original failure
    dlqLogger.error({
      originalJobId: job.data.jobId,
      error: error.message
    }, 'Failed to add job to DLQ');
  }
}

/**
 * List DLQ entries with pagination
 * 
 * @param {number} limit - Maximum number of entries to return (default 50, max 500)
 * @param {number} offset - Offset for pagination (default 0)
 * @returns {Promise<Object>} DLQ entries and pagination info
 */
export async function listDLQ(limit = 50, offset = 0) {
  try {
    // Enforce limits
    const safeLimit = Math.min(Math.max(1, limit), 500);
    const safeOffset = Math.max(0, offset);
    
    // Get failed jobs from DLQ (jobs with status 'pending' or 'reprocessed')
    const jobs = await dlqQueue.getJobs(['waiting', 'completed'], safeOffset, safeOffset + safeLimit - 1);
    
    // Get total count
    const counts = await dlqQueue.getJobCounts('waiting', 'completed');
    const total = (counts.waiting || 0) + (counts.completed || 0);
    
    // Map to safe response format
    const entries = jobs.map(job => ({
      dlqJobId: job.id,
      originalJobId: job.data.originalJobId,
      failedAt: job.data.failedAt,
      attemptsMade: job.data.attemptsMade,
      maxAttempts: job.data.maxAttempts,
      failureCategory: job.data.failureCategory,
      failureType: job.data.failureType,
      status: job.data.status,
      reprocessedJobId: job.data.reprocessedJobId || null,
      reprocessedAt: job.data.reprocessedAt || null
    }));
    
    dlqLogger.debug({
      count: entries.length,
      limit: safeLimit,
      offset: safeOffset
    }, 'DLQ entries listed');
    
    return {
      entries,
      pagination: {
        limit: safeLimit,
        offset: safeOffset,
        total,
        hasMore: safeOffset + safeLimit < total
      }
    };
    
  } catch (error) {
    dlqLogger.error({
      error: error.message
    }, 'Failed to list DLQ entries');
    throw error;
  }
}

/**
 * Retry a failed job from DLQ
 * 
 * @param {string} dlqJobId - DLQ job ID
 * @returns {Promise<Object>} Retry result
 */
export async function retryFromDLQ(dlqJobId) {
  try {
    // Get DLQ record
    const dlqJob = await dlqQueue.getJob(dlqJobId);
    
    if (!dlqJob) {
      return {
        success: false,
        error: 'DLQ record not found',
        code: 'NOT_FOUND'
      };
    }
    
    // Check if already reprocessed
    if (dlqJob.data.status === 'reprocessed') {
      dlqLogger.warn({
        dlqJobId,
        originalJobId: dlqJob.data.originalJobId
      }, 'DLQ record already reprocessed');
      
      return {
        success: false,
        error: 'Job already reprocessed',
        code: 'ALREADY_REPROCESSED',
        reprocessedJobId: dlqJob.data.reprocessedJobId,
        reprocessedAt: dlqJob.data.reprocessedAt
      };
    }
    
    const originalJobId = dlqJob.data.originalJobId;
    
    // Get original failed job from webhook queue
    const originalJob = await webhookQueue.getJob(originalJobId);
    
    if (!originalJob) {
      dlqLogger.warn({
        dlqJobId,
        originalJobId
      }, 'Original job not found (expired from retention)');
      
      return {
        success: false,
        error: 'Original job has expired from retention',
        code: 'ORIGINAL_EXPIRED'
      };
    }
    
    // Verify original job is in failed state
    const originalState = await originalJob.getState();
    if (originalState !== 'failed' && originalState !== 'completed') {
      dlqLogger.warn({
        dlqJobId,
        originalJobId,
        state: originalState
      }, 'Original job is not in failed state');
      
      return {
        success: false,
        error: `Original job is in ${originalState} state, not failed`,
        code: 'INVALID_STATE'
      };
    }
    
    // Create new job with original job data but new UUID
    const newJobId = generateJobId();
    const newJobData = {
      ...originalJob.data,
      jobId: newJobId,
      createdAt: new Date().toISOString(),
      retriedFromDLQ: true,
      originalJobId: originalJobId
    };
    
    // Update DLQ record status BEFORE creating new job to prevent race conditions
    // If this fails, we haven't created a new job yet, so state is consistent
    const reprocessedAt = new Date().toISOString();
    await dlqJob.updateData({
      ...dlqJob.data,
      status: 'reprocessed',
      reprocessedJobId: newJobId,
      reprocessedAt: reprocessedAt
    });
    
    try {
      // Add new job to webhook queue
      await webhookQueue.add('dispatch-webhook', newJobData, {
        jobId: newJobId
      });
      
      // No need to call moveToCompleted - DLQ jobs are not active/locked
      // The status update above is sufficient for tracking reprocessed state
      
      dlqLogger.info({
        dlqJobId,
        originalJobId,
        newJobId
      }, 'Job reprocessed from DLQ');
      
      return {
        success: true,
        dlqJobId,
        originalJobId,
        newJobId,
        status: 'reprocessed'
      };
      
    } catch (enqueueError) {
      // Rollback: revert DLQ status if webhook enqueue failed
      dlqLogger.error({
        dlqJobId,
        originalJobId,
        newJobId,
        error: enqueueError.message
      }, 'Failed to enqueue new job, rolling back DLQ status');
      
      await dlqJob.updateData({
        ...dlqJob.data,
        status: 'pending',
        reprocessedJobId: undefined,
        reprocessedAt: undefined
      });
      
      throw enqueueError;
    }
    
  } catch (error) {
    dlqLogger.error({
      dlqJobId,
      error: error.message
    }, 'Failed to retry job from DLQ');
    throw error;
  }
}

/**
 * Close DLQ queue connection
 * Call during graceful shutdown
 */
export async function closeDLQ() {
  try {
    await dlqQueue.close();
    dlqLogger.info('DLQ queue closed');
  } catch (error) {
    dlqLogger.error({
      error: error.message
    }, 'Error closing DLQ queue');
  }
}
