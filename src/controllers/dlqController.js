/**
 * DLQ Controller
 * Handles DLQ listing and manual retry endpoints
 */

import { listDLQ, retryFromDLQ } from '../services/dlqService.js';
import { logger } from '../utils/logger.js';

const dlqLogger = logger.child({ component: 'dlq-api' });

/**
 * List DLQ entries
 * GET /api/webhooks/dlq
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function getDLQ(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    dlqLogger.debug({ limit, offset }, 'Listing DLQ entries');
    
    const result = await listDLQ(limit, offset);
    
    dlqLogger.info({
      count: result.entries.length,
      total: result.pagination.total
    }, 'DLQ entries retrieved');
    
    return res.status(200).json({
      success: true,
      ...result
    });
    
  } catch (error) {
    dlqLogger.error({
      error: error.message
    }, 'Failed to list DLQ entries');
    
    // Check if Redis connection error
    const isConnectionError = 
      error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'EHOSTUNREACH' ||
      (error.message && error.message.includes('Connection is closed'));
    
    if (isConnectionError) {
      return res.status(503).json({
        success: false,
        error: 'Queue service temporarily unavailable',
        details: 'Unable to retrieve DLQ entries. Please try again later.'
      });
    }
    
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: 'Failed to retrieve DLQ entries'
    });
  }
}

/**
 * Retry a job from DLQ
 * POST /api/webhooks/dlq/:dlqJobId/retry
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export async function retryDLQJob(req, res) {
  const { dlqJobId } = req.params;
  
  try {
    dlqLogger.info({ dlqJobId }, 'Retry requested for DLQ job');
    
    const result = await retryFromDLQ(dlqJobId);
    
    if (!result.success) {
      // Handle specific error codes
      if (result.code === 'NOT_FOUND') {
        return res.status(404).json({
          success: false,
          error: result.error,
          details: `DLQ job not found: ${dlqJobId}`
        });
      }
      
      if (result.code === 'ALREADY_REPROCESSED') {
        return res.status(409).json({
          success: false,
          error: result.error,
          details: 'This job has already been reprocessed',
          reprocessedJobId: result.reprocessedJobId,
          reprocessedAt: result.reprocessedAt
        });
      }
      
      if (result.code === 'ORIGINAL_EXPIRED') {
        return res.status(410).json({
          success: false,
          error: result.error,
          details: 'The original job data has expired from Redis retention. Cannot retry.'
        });
      }
      
      if (result.code === 'INVALID_STATE') {
        return res.status(400).json({
          success: false,
          error: result.error,
          details: 'Original job is not in a failed state'
        });
      }
      
      // Generic failure
      return res.status(500).json({
        success: false,
        error: result.error || 'Retry failed'
      });
    }
    
    dlqLogger.info({
      dlqJobId,
      originalJobId: result.originalJobId,
      newJobId: result.newJobId
    }, 'DLQ job reprocessed successfully');
    
    return res.status(200).json({
      success: true,
      dlqJobId: result.dlqJobId,
      originalJobId: result.originalJobId,
      newJobId: result.newJobId,
      status: result.status,
      message: 'Job queued for reprocessing'
    });
    
  } catch (error) {
    dlqLogger.error({
      dlqJobId,
      error: error.message
    }, 'Failed to retry DLQ job');
    
    // Check if Redis connection error
    const isConnectionError = 
      error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'EHOSTUNREACH' ||
      (error.message && error.message.includes('Connection is closed'));
    
    if (isConnectionError) {
      return res.status(503).json({
        success: false,
        error: 'Queue service temporarily unavailable',
        details: 'Unable to retry job. Please try again later.'
      });
    }
    
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: 'Failed to retry job'
    });
  }
}
