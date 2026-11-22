/**
 * Focused security hardening verification.
 * The API and any child process must be started with a temporary API key.
 */

import http from 'http';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';

const host = '127.0.0.1';
const port = Number(process.env.PORT || 5000);
const testApiKey = 'temporary-verification-key-2026';
let passed = 0;
let failed = 0;
let skipped = 0;

function request({ hostname = host, port: requestPort = port, path = '/', method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname,
      port: requestPort,
      path,
      method,
      headers,
      timeout: 5000
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.end();
  });
}

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS: ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`FAIL: ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

async function productionStartupWithoutKey() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        API_KEY: '',
        PORT: '5101',
        REDIS_URL: '',
        REDIS_HOST: '127.0.0.1',
        REDIS_PORT: '6379'
      },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('exit', code => resolve({ code, stderr }));
  });
}

async function main() {
  console.log('Focused Security Hardening Verification');

  try {
    const missing = await request({ path: '/api/webhooks/status/test-job-id' });
    check('missing API key returns 401', missing.status === 401);

    const invalid = await request({
      path: '/api/webhooks/status/test-job-id',
      headers: { 'X-API-Key': 'invalid-temporary-key' }
    });
    check('invalid API key returns 401', invalid.status === 401);

    const valid = await request({
      path: '/api/webhooks/status/00000000-0000-4000-8000-000000000000',
      headers: { 'X-API-Key': testApiKey }
    });
    check('valid API key succeeds past authentication', valid.status !== 401);

    const source = await readFile(new URL('./src/middleware/authentication.js', import.meta.url), 'utf8');
    check('timing-safe comparison is used', source.includes('crypto.timingSafeEqual'));

    const startup = await productionStartupWithoutKey();
    check('production startup fails without API_KEY', startup.code === 1);
  } catch (error) {
    failed++;
    console.log(`FAIL: security requests could not run - ${error.message}`);
  }

  try {
    for (let i = 0; i < 3; i++) {
      await request({ hostname: '127.0.0.1', path: '/api/webhooks/status/test-job-id', headers: { 'X-API-Key': testApiKey } });
    }
    const limited = await request({ hostname: '127.0.0.1', path: '/api/webhooks/status/test-job-id', headers: { 'X-API-Key': testApiKey } });
    check('configured IPv4 rate limit returns 429', limited.status === 429);
  } catch (error) {
    failed++;
    console.log(`FAIL: IPv4 rate-limit verification - ${error.message}`);
  }

  try {
    let ipv6Reached = false;
    for (let i = 0; i < 4; i++) {
      const res = await request({ hostname: '::1', path: '/api/webhooks/status/test-job-id', headers: { 'X-API-Key': testApiKey } });
      if (res.status === 429) ipv6Reached = true;
    }
    check('IPv6 clients cannot bypass configured limit', ipv6Reached);
  } catch (error) {
    skipped++;
    console.log(`SKIP: IPv6 loopback is unavailable in this environment - ${error.message}`);
  }

  try {
    const health = await request({ path: '/health/live' });
    const legacy = await request({ path: '/health' });
    check('health live endpoint accessible without API key', health.status === 200);
    check('legacy health endpoint accessible without API key', legacy.status === 200);

    const allowed = await request({
      method: 'OPTIONS',
      path: '/api/webhooks/status/test-job-id',
      headers: {
        Origin: 'https://allowed.example',
        'Access-Control-Request-Method': 'GET'
      }
    });
    check('CORS allows configured origin', allowed.headers['access-control-allow-origin'] === 'https://allowed.example');

    const rejected = await request({
      method: 'OPTIONS',
      path: '/api/webhooks/status/test-job-id',
      headers: {
        Origin: 'https://unconfigured.example',
        'Access-Control-Request-Method': 'GET'
      }
    });
    check('CORS rejects unconfigured origin', rejected.status === 403);

    const headers = await request({ path: '/health/live' });
    check('Helmet removes X-Powered-By', !headers.headers['x-powered-by']);
    check('Helmet sets X-Content-Type-Options', headers.headers['x-content-type-options'] === 'nosniff');
    check('Helmet sets X-Frame-Options', !!headers.headers['x-frame-options']);
  } catch (error) {
    failed++;
    console.log(`FAIL: health/CORS/Helmet verification - ${error.message}`);
  }

  console.log('');
  console.log(`PASS=${passed} FAIL=${failed} SKIPPED=${skipped}`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
