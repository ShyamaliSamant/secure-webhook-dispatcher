import app from './src/app.js';
import { logger } from './src/utils/logger.js';
import { closeQueue } from './src/queues/webhookQueue.js';
import { closeHealthCheck } from './src/services/healthService.js';

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  logger.info({
    port: PORT,
    service: 'api'
  }, 'Webhook Dispatcher Server started');
  
  logger.info({
    healthEndpoint: `http://localhost:${PORT}/health`
  }, 'Health check endpoint available');
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, service: 'api' }, 'API shutdown requested');

  await new Promise(resolve => server.close(resolve));
  await closeHealthCheck();
  await closeQueue();
  logger.info({ service: 'api' }, 'API shutdown complete');
}

process.once('SIGINT', () => void shutdown('SIGINT').then(() => {
  process.exitCode = 0;
}).catch(error => {
  logger.error({ error: error.message, service: 'api' }, 'API shutdown failed');
  process.exitCode = 1;
}));

process.once('SIGTERM', () => void shutdown('SIGTERM').then(() => {
  process.exitCode = 0;
}).catch(error => {
  logger.error({ error: error.message, service: 'api' }, 'API shutdown failed');
  process.exitCode = 1;
}));
