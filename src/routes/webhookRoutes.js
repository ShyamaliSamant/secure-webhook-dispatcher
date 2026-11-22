import express from 'express';
import { dispatchWebhook } from '../controllers/webhookController.js';
import { getJobStatus } from '../controllers/jobStatusController.js';
import { getDLQ, retryDLQJob } from '../controllers/dlqController.js';
import { validateWebhook } from '../middleware/validateWebhook.js';
import { requireAuth } from '../middleware/authentication.js';
import { 
  dispatchRateLimiter, 
  statusRateLimiter, 
  dlqRateLimiter 
} from '../middleware/rateLimiting.js';

const router = express.Router();

/**
 * POST /api/webhooks/dispatch
 * 
 * Accepts webhook dispatch requests with:
 * - destinationUrl: Target URL for webhook delivery
 * - eventId: Unique event identifier
 * - payload: JSON object containing event data
 * 
 * Security:
 * - Requires API key authentication
 * - Rate limited to 50 requests/minute per IP
 * - Input validation via validateWebhook middleware
 * 
 * Returns 202 with jobId on success
 */
router.post('/dispatch', requireAuth, dispatchRateLimiter, validateWebhook, dispatchWebhook);

/**
 * GET /api/webhooks/status/:jobId
 * 
 * Returns the status of a previously submitted webhook job
 * Does not expose sensitive data (payload, destinationUrl)
 * 
 * Security:
 * - Requires API key authentication
 * - Rate limited to 200 requests/minute per IP
 */
router.get('/status/:jobId', requireAuth, statusRateLimiter, getJobStatus);

/**
 * GET /api/webhooks/dlq
 * 
 * Lists failed webhook jobs in the Dead Letter Queue
 * Supports pagination via ?limit and ?offset query parameters
 * 
 * Security:
 * - Requires API key authentication
 * - Rate limited to 20 requests/minute per IP
 */
router.get('/dlq', requireAuth, dlqRateLimiter, getDLQ);

/**
 * POST /api/webhooks/dlq/:dlqJobId/retry
 * 
 * Manually retry a failed webhook from the DLQ
 * Creates a new job with the original job data
 * 
 * Security:
 * - Requires API key authentication
 * - Rate limited to 20 requests/minute per IP
 */
router.post('/dlq/:dlqJobId/retry', requireAuth, dlqRateLimiter, retryDLQJob);

export default router;
