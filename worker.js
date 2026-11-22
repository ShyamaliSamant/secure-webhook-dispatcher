import dotenv from 'dotenv';
import http from 'http';
import { createLogger } from './src/utils/logger.js';
import { getMetrics, getMetricsContentType } from './src/services/metricsService.js';

// Load configuration before importing BullMQ or the worker modules.
dotenv.config();

const workerLogger = createLogger({ component: 'worker-main' });

// Worker metrics HTTP server
const METRICS_PORT = parseInt(process.env.WORKER_METRICS_PORT || '9090', 10);
let metricsServer = null;

// Start metrics HTTP server for Prometheus scraping
function startMetricsServer() {
  metricsServer = http.createServer(async (req, res) => {
    if (req.url === '/metrics' && req.method === 'GET') {
      try {
        const metrics = await getMetrics();
        res.writeHead(200, { 'Content-Type': getMetricsContentType() });
        res.end(metrics);
      } catch (error) {
        workerLogger.error({ error: error.message }, 'Failed to serve worker metrics');
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('# Error collecting metrics\n');
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found\n');
    }
  });

  metricsServer.listen(METRICS_PORT, () => {
    workerLogger.info({ port: METRICS_PORT }, 'Worker metrics endpoint started');
  });

  metricsServer.on('error', (error) => {
    workerLogger.error({ error: error.message }, 'Metrics server error');
  });
}

// Start webhook worker and metrics server
const { startWebhookWorker, shutdownWorker } = await import('./src/workers/webhookWorker.js');
const worker = startWebhookWorker();
startMetricsServer();

let shuttingDown = false;

async function handleShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  
  workerLogger.info({ signal }, 'Shutdown signal received, waiting for active jobs to finish');

  try {
    // Shutdown worker first
    await shutdownWorker(worker);
    
    // Close metrics server
    if (metricsServer) {
      await new Promise((resolve) => {
        metricsServer.close(resolve);
      });
      workerLogger.info('Metrics server closed');
    }
    
    process.exitCode = 0;
  } catch (error) {
    workerLogger.error({
      error: error.message
    }, 'Worker shutdown failed');
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void handleShutdown('SIGINT'));
process.once('SIGTERM', () => void handleShutdown('SIGTERM'));
