import http from 'http';
import { executeWebhookRequest } from './src/workers/deliveryService.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS: ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`FAIL: ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

async function main() {
  const timeoutServer = http.createServer((req, res) => {
    req.resume();
    setTimeout(() => res.end('too late'), 250);
  });

  const timeoutPort = await listen(timeoutServer);
  try {
    await executeWebhookRequest({
      client: http,
      requestOptions: {
        hostname: '127.0.0.1',
        port: timeoutPort,
        path: '/',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      jsonPayload: '{}',
      timeout: 50
    }).then(
      () => check('timeout request aborts', false, 'request unexpectedly succeeded'),
      error => {
        check('timeout request aborts', error.code === 'WEBHOOK_TIMEOUT');
        check('timeout is classified consistently', error.message.includes('timeout'));
      }
    );
  } catch (error) {
    failed++;
    console.log(`FAIL: timeout test could not execute - ${error.message}`);
  } finally {
    await close(timeoutServer);
  }

  const sizeServer = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(Buffer.alloc(1024 * 1024 + 64, 'x'));
  });

  const sizePort = await listen(sizeServer);
  try {
    await executeWebhookRequest({
      client: http,
      requestOptions: {
        hostname: '127.0.0.1',
        port: sizePort,
        path: '/',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      jsonPayload: '{}',
      maxResponseSize: 1024 * 1024,
      timeout: 2000
    }).then(
      () => check('response size limit aborts oversized stream', false, 'request unexpectedly succeeded'),
      error => {
        check('response size limit aborts oversized stream', error.code === 'RESPONSE_SIZE_LIMIT');
        check('response size limit failure is stable', error.message.includes('Response size exceeds limit'));
      }
    );
  } catch (error) {
    failed++;
    console.log(`FAIL: response-size test could not execute - ${error.message}`);
  } finally {
    await close(sizeServer);
  }

  console.log(`PASS=${passed} FAIL=${failed} SKIPPED=0`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
