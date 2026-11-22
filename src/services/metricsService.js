/**
 * Prometheus Metrics Service
 * 
 * Centralized metrics collection using prom-client.
 * Metrics are registered once and exported for use across modules.
 * 
 * IMPORTANT: Metrics are process-local unless explicitly noted.
 * Use only bounded labels (service, status) - NEVER use high-cardinality values
 * like jobId, eventId, destinationUrl, or payload data.
 * 
 * Endpoints:
 * - API: http://localhost:5000/metrics (webhook_jobs_received_total, queue_jobs_total)
 * - Worker: http://localhost:9090/metrics (delivery metrics, duration histogram)
 * 
 * Prometheus scrape configuration:
 * scrape_configs:
 *   - job_name: 'webhook-dispatcher-api'
 *     static_configs:
 *       - targets: ['localhost:5000']
 *     metrics_path: '/metrics'
 *   
 *   - job_name: 'webhook-dispatcher-worker'
 *     static_configs:
 *       - targets: ['localhost:9090']
 *     metrics_path: '/metrics'
 */

import promClient from 'prom-client';
import { logger } from '../utils/logger.js';

const metricsLogger = logger.child({ component: 'metrics' });

// Create a registry for metrics
export const register = new promClient.Registry();

// Add default metrics (process CPU, memory, etc.)
promClient.collectDefaultMetrics({ register });

// ============================================================================
// WEBHOOK JOB METRICS
// ============================================================================

/**
 * Total webhook jobs received by API
 * Counter increments when API accepts a webhook dispatch request
 * Process-local: Only counts jobs received by this API instance
 */
export const webhookJobsReceivedTotal = new promClient.Counter({
  name: 'webhook_jobs_received_total',
  help: 'Total number of webhook jobs received by API',
  labelNames: ['service'],
  registers: [register]
});

/**
 * Successful webhook deliveries
 * Counter increments when worker receives HTTP 2xx response
 * Process-local: Only counts deliveries from this worker instance
 */
export const webhookDeliveriesSuccessTotal = new promClient.Counter({
  name: 'webhook_deliveries_success_total',
  help: 'Total number of successful webhook deliveries',
  labelNames: ['service'],
  registers: [register]
});

/**
 * Failed webhook deliveries
 * Counter increments when job moves to failed state (all retries exhausted or permanent failure)
 * Process-local: Only counts failures from this worker instance
 * 
 * Labels:
 * - status: "permanent" (4xx, SSRF) or "exhausted" (retries exceeded)
 */
export const webhookDeliveriesFailedTotal = new promClient.Counter({
  name: 'webhook_deliveries_failed_total',
  help: 'Total number of failed webhook deliveries',
  labelNames: ['service', 'status'],
  registers: [register]
});

/**
 * Retry attempts
 * Counter increments each time a job is retried (attempt > 1)
 * Process-local: Only counts retries from this worker instance
 */
export const webhookRetryAttemptsTotal = new promClient.Counter({
  name: 'webhook_retry_attempts_total',
  help: 'Total number of webhook retry attempts',
  labelNames: ['service'],
  registers: [register]
});

/**
 * Webhook delivery duration histogram
 * Records time from job processing start to HTTP response received
 * Buckets: 100ms, 500ms, 1s, 2s, 5s, 10s, 30s
 * Process-local: Only records deliveries from this worker instance
 */
export const webhookDeliveryDuration = new promClient.Histogram({
  name: 'webhook_delivery_duration_seconds',
  help: 'Webhook delivery duration in seconds',
  labelNames: ['service', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register]
});

// ============================================================================
// QUEUE STATE METRICS
// ============================================================================

/**
 * Queue jobs by state
 * Gauge shows current count of jobs in each state
 * Redis-derived: Queries BullMQ queue for actual counts
 * 
 * States: waiting, active, completed, failed, delayed
 */
export const queueJobsGauge = new promClient.Gauge({
  name: 'queue_jobs_total',
  help: 'Number of jobs in queue by state',
  labelNames: ['service', 'state'],
  registers: [register]
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Increment jobs received counter
 */
export function recordJobReceived() {
  webhookJobsReceivedTotal.inc({ service: 'webhook-dispatcher' });
  metricsLogger.debug('Metric: Job received');
}

/**
 * Record successful delivery
 * @param {number} durationSeconds - Delivery duration in seconds
 */
export function recordDeliverySuccess(durationSeconds) {
  webhookDeliveriesSuccessTotal.inc({ service: 'webhook-dispatcher' });
  webhookDeliveryDuration.observe(
    { service: 'webhook-dispatcher', status: 'success' },
    durationSeconds
  );
  metricsLogger.debug({ durationSeconds }, 'Metric: Delivery success');
}

/**
 * Record failed delivery
 * @param {string} failureType - "permanent" or "exhausted"
 * @param {number} durationSeconds - Delivery duration in seconds (if available)
 */
export function recordDeliveryFailure(failureType, durationSeconds = null) {
  webhookDeliveriesFailedTotal.inc({ 
    service: 'webhook-dispatcher', 
    status: failureType 
  });
  
  if (durationSeconds !== null) {
    webhookDeliveryDuration.observe(
      { service: 'webhook-dispatcher', status: 'failure' },
      durationSeconds
    );
  }
  
  metricsLogger.debug({ failureType, durationSeconds }, 'Metric: Delivery failure');
}

/**
 * Record retry attempt
 */
export function recordRetryAttempt() {
  webhookRetryAttemptsTotal.inc({ service: 'webhook-dispatcher' });
  metricsLogger.debug('Metric: Retry attempt');
}

/**
 * Update queue state metrics from BullMQ
 * @param {Object} queue - BullMQ Queue instance
 */
export async function updateQueueMetrics(queue) {
  try {
    // Get job counts from BullMQ
    const counts = await queue.getJobCounts();
    
    // Update gauge for each state
    queueJobsGauge.set(
      { service: 'webhook-dispatcher', state: 'waiting' },
      counts.waiting || 0
    );
    queueJobsGauge.set(
      { service: 'webhook-dispatcher', state: 'active' },
      counts.active || 0
    );
    queueJobsGauge.set(
      { service: 'webhook-dispatcher', state: 'completed' },
      counts.completed || 0
    );
    queueJobsGauge.set(
      { service: 'webhook-dispatcher', state: 'failed' },
      counts.failed || 0
    );
    queueJobsGauge.set(
      { service: 'webhook-dispatcher', state: 'delayed' },
      counts.delayed || 0
    );
    
    metricsLogger.debug({ counts }, 'Metric: Queue state updated');
  } catch (error) {
    metricsLogger.warn({
      error: error.message
    }, 'Failed to update queue metrics');
  }
}

/**
 * Get all metrics in Prometheus text format
 * @returns {Promise<string>} Prometheus metrics text
 */
export async function getMetrics() {
  try {
    return await register.metrics();
  } catch (error) {
    metricsLogger.error({
      error: error.message
    }, 'Failed to collect metrics');
    throw error;
  }
}

/**
 * Get metrics content type
 * @returns {string} Content-Type header value
 */
export function getMetricsContentType() {
  return register.contentType;
}

metricsLogger.debug('Prometheus metrics initialized');
