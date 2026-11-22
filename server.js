import app from './src/app.js';
import { logger } from './src/utils/logger.js';

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  logger.info({
    port: PORT,
    service: 'api'
  }, 'Webhook Dispatcher Server started');
  
  logger.info({
    healthEndpoint: `http://localhost:${PORT}/health`
  }, 'Health check endpoint available');
});
