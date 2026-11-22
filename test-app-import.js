console.log('Step 1: Importing app...');
import app from './src/app.js';

console.log('Step 2: App imported');

import http from 'node:http';

const testData = JSON.stringify({
  destinationUrl: 'https://example.com/webhook',
  eventId: 'app-import-test',
  payload: { test: 'import' }
});

const options = {
  hostname: 'localhost',
  port: 9999,  // Use different port
  path: '/api/webhooks/dispatch',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(testData)
  }
};

const server = app.listen(9999, async () => {
  console.log('Step 3: Test server listening on 9999');
  
  // Give it a moment
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  console.log('Step 4: Sending request...');
  
  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      console.log(`Response Status: ${res.statusCode}`);
      console.log('Response:', data);
      server.close();
      process.exit(0);
    });
  });
  
  req.on('error', (e) => {
    console.error('Request error:', e);
    server.close();
    process.exit(1);
  });
  
  req.write(testData);
  req.end();
});
