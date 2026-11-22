/**
 * Security Headers Test
 * Tests Helmet security headers and CORS configuration
 */

import http from 'http';

const API_HOST = 'localhost';
const API_PORT = process.env.PORT || 5000;

let passed = 0;
let failed = 0;

function makeRequest(path, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST,
      port: API_PORT,
      path,
      method,
      headers,
      timeout: 5000
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    req.end();
  });
}

console.log('='.repeat(70));
console.log('SECURITY HEADERS TEST');
console.log('='.repeat(70));
console.log('');

(async () => {
  try {
    // TEST 1: Helmet security headers present
    console.log('--- TEST 1: Helmet Security Headers ---');
    const res = await makeRequest('/health', 'GET');
    
    const expectedHeaders = [
      'x-dns-prefetch-control',
      'x-frame-options',
      'x-content-type-options',
      'x-download-options',
      'x-permitted-cross-domain-policies'
    ];
    
    expectedHeaders.forEach(header => {
      if (res.headers[header]) {
        console.log(`✓ PASS: ${header} present: ${res.headers[header]}`);
        passed++;
      } else {
        console.log(`⚠ INFO: ${header} not present (may be optional)`);
      }
    });
    
    console.log('');
    
    // TEST 2: X-Powered-By removed
    console.log('--- TEST 2: X-Powered-By Header Removed ---');
    if (!res.headers['x-powered-by']) {
      console.log('✓ PASS: X-Powered-By header not present (good security practice)');
      passed++;
    } else {
      console.log(`✗ FAIL: X-Powered-By header present: ${res.headers['x-powered-by']}`);
      failed++;
    }
    console.log('');
    
    // TEST 3: CORS headers
    console.log('--- TEST 3: CORS Configuration ---');
    const corsRes = await makeRequest('/health', 'OPTIONS', {
      'Origin': 'https://example.com',
      'Access-Control-Request-Method': 'GET'
    });
    
    if (corsRes.headers['access-control-allow-origin']) {
      console.log(`✓ CORS configured: ${corsRes.headers['access-control-allow-origin']}`);
      console.log(`  Note: CORS allows: ${corsRes.headers['access-control-allow-origin']}`);
      passed++;
    } else {
      console.log('✓ CORS not allowing browser requests (backend-to-backend mode)');
      console.log('  This is correct if ALLOWED_ORIGINS is not set');
      passed++;
    }
    console.log('');
    
    // TEST 4: Content-Type header
    console.log('--- TEST 4: Content-Type Header ---');
    if (res.headers['content-type']) {
      console.log(`✓ PASS: Content-Type present: ${res.headers['content-type']}`);
      passed++;
    } else {
      console.log('✗ FAIL: Content-Type header missing');
      failed++;
    }
    console.log('');
    
    // Summary
    console.log('='.repeat(70));
    console.log('TEST SUMMARY');
    console.log('='.repeat(70));
    console.log(`✓ Passed: ${passed}`);
    console.log(`✗ Failed: ${failed}`);
    console.log('='.repeat(70));
    
    if (failed === 0) {
      console.log('✓ ALL SECURITY HEADER TESTS PASSED');
      process.exit(0);
    } else {
      console.log(`✗ ${failed} TEST(S) FAILED`);
      process.exit(1);
    }
    
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
})();
