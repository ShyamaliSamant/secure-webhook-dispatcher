/**
 * Prometheus Metrics Routes
 * 
 * Endpoint:
 * - GET /metrics - Prometheus metrics in text format
 */

import express from 'express';
import { getMetrics, getMetricsContentType, updateQueueMetrics } from '../services/metricsService.js';
import { webhookQueue } from '../queues/webhookQueue.js';
import { logger } from '../utils/logger.js';

const router = express.Router();
const metricsLogger = logger.child({ component: 'metrics' });

/**
 * Prometheus metrics endpoint
 * Returns metrics in Prometheus text format
 * 
 * Updates queue state metrics before returning to ensure freshness
 */
router.get('/', async (req, res) => {
  try {
    metricsLogger.debug('Metrics endpoint requested');
    
    // Update queue metrics before serving (ensures fresh data)
    await updateQueueMetrics(webhookQueue);
    
    // Get metrics in Prometheus text format
    const metrics = await getMetrics();
    
    // Set appropriate content type
    res.set('Content-Type', getMetricsContentType());
    res.send(metrics);
    
    metricsLogger.debug('Metrics served successfully');
  } catch (error) {
    metricsLogger.error({
      error: error.message
    }, 'Failed to serve metrics');
    
    // Return 500 with plain text error
    res.status(500).send('# Error collecting metrics\n');
  }
});

export default router;
