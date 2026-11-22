import http from 'http';
import Redis from 'ioredis';
import dotenv from 'dotenv';
import { getWorkerRedisConnection } from './src/config/redis.js';
import { createDestinationRateLimiter } from './src/utils/destinationRateLimiter.js';
import { executeWebhookRequest } from './src/workers/deliveryService.js';

dotenv.config();

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

async function main() {
  const redis = new Redis(getWorkerRedisConnection());
  const redisWorkerB = new Redis(getWorkerRedisConnection());
  const prefix = `test:webhook-rate-limit:${process.pid}:${Date.now()}`;

  try {
    await redis.ping();

    const limiterA = createDestinationRateLimiter(redis, {
      maxRequests: 2,
      durationMs: 300,
      keyPrefix: prefix
    });

    const first = await limiterA.tryAcquire('Example.COM');
    const second = await limiterA.tryAcquire('example.com');
    const third = await limiterA.tryAcquire('example.com');
    check('same domain shares limit', first.allowed && second.allowed && !third.allowed);

    const other = await limiterA.tryAcquire('other.example');
    check('different domains have independent limits', other.allowed);

    await redis.del(`${prefix}:example.com`);
    const limiterB = createDestinationRateLimiter(redisWorkerB, {
      maxRequests: 2,
      durationMs: 300,
      keyPrefix: prefix
    });

    const workerOneFirst = await limiterA.tryAcquire('shared.example');
    const workerTwoFirst = await limiterB.tryAcquire('shared.example');
    const workerTwoBlocked = await limiterB.tryAcquire('shared.example');
    check(
      'multiple workers share Redis limit',
      workerOneFirst.allowed && workerTwoFirst.allowed && !workerTwoBlocked.allowed
    );

    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(429, { 'Retry-After': '1', 'Content-Type': 'text/plain' });
      res.end('rate limited');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const port = server.address().port;
    await executeWebhookRequest({
      client: http,
      requestOptions: {
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      },
      jsonPayload: '{}',
      timeout: 2000
    }).then(
      () => check('HTTP 429 is retried', false, 'request unexpectedly succeeded'),
      error => {
        check('HTTP 429 has status code', error.statusCode === 429);
        check('HTTP 429 is retryable', error.retryable === true && error.permanent !== true);
      }
    );
    await new Promise(resolve => server.close(resolve));
  } catch (error) {
    failed++;
    console.log(`FAIL: destination rate limit test setup - ${error.message}`);
  } finally {
    await redis.quit();
    await redisWorkerB.quit();
  }

  console.log(`PASS=${passed} FAIL=${failed} SKIPPED=0`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
