import { dispatchWebhook } from './src/controllers/webhookController.js';

// Mock Express req/res
const req = {
  body: {
    destinationUrl: 'https://example.com/webhook',
    eventId: 'direct-test-' + Date.now(),
    payload: { test: 'direct' }
  }
};

const res = {
  statusCode: null,
  jsonData: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(data) {
    this.jsonData = data;
    console.log(`Response Status: ${this.statusCode}`);
    console.log('Response Body:', JSON.stringify(data, null, 2));
    return this;
  }
};

console.log('Testing controller directly...');
console.log('Request body:', JSON.stringify(req.body, null, 2));
console.log('');

try {
  await dispatchWebhook(req, res);
} catch (error) {
  console.error('Uncaught error from controller:', error);
}
