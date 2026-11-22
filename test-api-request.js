import http from 'node:http';

const payload = {
  destinationUrl: 'https://example.com/webhook',
  eventId: 'nodejs-test-' + Date.now(),
  payload: {
    test: 'data',
    timestamp: new Date().toISOString()
  }
};

const postData = JSON.stringify(payload);

const options = {
  hostname: 'localhost',
  port: 5000,
  path: '/api/webhooks/dispatch',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  }
};

console.log('Sending request with properly formatted JSON...');
console.log('Payload:', postData);

const req = http.request(options, (res) => {
  console.log(`\nHTTP Status: ${res.statusCode}`);
  console.log('Headers:', JSON.stringify(res.headers, null, 2));
  
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    console.log('\nResponse Body:');
    try {
      const parsed = JSON.parse(data);
      console.log(JSON.stringify(parsed, null, 2));
    } catch (e) {
      console.log(data);
    }
  });
});

req.on('error', (e) => {
  console.error('Request error:', e.message);
});

req.write(postData);
req.end();
