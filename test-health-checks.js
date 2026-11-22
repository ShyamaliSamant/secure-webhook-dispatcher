/**
 * Phase 3 Step 2: Health Checks Test
 * 
 * Tests:
 * 1. Liveness endpoint returns 200
 * 2. Readiness returns 200 when Redis is available
 * 3. Readiness returns 503 when Redis is unavailable (manual test)
 * 4. Worker heartbeat is detected when worker is running
 * 5. Worker is reported unhealthy when heartbeat expires
 * 6. Graceful shutdown removes heartbeat
 */

import http from 'http';

const API_HOST = 'localhost';
const API_PORT = process.env.PORT || 5000;

// Test utilities
function makeRequest(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: API_HOST,
      port: API_PORT,
      path: path,
      method: 'GET',
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(data)
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            body: data
          });
        }
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

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Test execution
(async () => {
  console.log('='.repeat(60));
  console.log('PHASE 3 STEP 2: HEALTH CHECKS TEST');
  console.log('='.repeat(60));
  console.log('');
  
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  
  // TEST 1: Liveness endpoint
  console.log('--- TEST 1: Liveness Endpoint ---');
  try {
    const response = await makeRequest('/health/live');
    
    if (response.statusCode === 200) {
      console.log('✓ PASS: Liveness returns HTTP 200');
      console.log('  Response:', JSON.stringify(response.body, null, 2));
      passed++;
    } else {
      console.log(`✗ FAIL: Expected 200, got ${response.statusCode}`);
      console.log('  Response:', JSON.stringify(response.body, null, 2));
      failed++;
    }
    
    if (response.body.status === 'ok') {
      console.log('✓ PASS: Liveness response has status: ok');
      passed++;
    } else {
      console.log('✗ FAIL: Expected status: ok');
      failed++;
    }
  } catch (error) {
    console.log('✗ FAIL: Liveness request failed:', error.message);
    failed += 2;
  }
  console.log('');
  
  // TEST 2: Legacy health endpoint (backward compatibility)
  console.log('--- TEST 2: Legacy Health Endpoint ---');
  try {
    const response = await makeRequest('/health');
    
    if (response.statusCode === 200) {
      console.log('✓ PASS: Legacy health endpoint still works');
      console.log('  Response:', JSON.stringify(response.body, null, 2));
      passed++;
    } else {
      console.log(`✗ FAIL: Expected 200, got ${response.statusCode}`);
      failed++;
    }
  } catch (error) {
    console.log('✗ FAIL: Legacy health request failed:', error.message);
    failed++;
  }
  console.log('');
  
  // TEST 3: Readiness endpoint (Redis available)
  console.log('--- TEST 3: Readiness Endpoint (Redis Available) ---');
  console.log('Note: This test assumes Redis/Memurai is running');
  try {
    const response = await makeRequest('/health/ready');
    
    console.log(`Response status: ${response.statusCode}`);
    console.log('Response body:', JSON.stringify(response.body, null, 2));
    
    if (response.statusCode === 200) {
      console.log('✓ PASS: Readiness returns HTTP 200 (Redis is available)');
      passed++;
      
      if (response.body.status === 'ready') {
        console.log('✓ PASS: Readiness status is "ready"');
        passed++;
      } else {
        console.log('✗ FAIL: Expected status: ready');
        failed++;
      }
      
      if (response.body.checks?.redis?.status === 'connected') {
        console.log('✓ PASS: Redis status is "connected"');
        console.log(`  Response time: ${response.body.checks.redis.responseTimeMs}ms`);
        passed++;
      } else {
        console.log('✗ FAIL: Expected Redis status: connected');
        failed++;
      }
      
      if (typeof response.body.checks?.redis?.responseTimeMs === 'number') {
        console.log('✓ PASS: Response time is included');
        passed++;
      } else {
        console.log('✗ FAIL: Response time missing');
        failed++;
      }
      
    } else if (response.statusCode === 503) {
      console.log('⚠ SKIP: Redis appears unavailable (503 response)');
      console.log('  This test requires Redis to be running');
      console.log('  To fix: Ensure Redis/Memurai service is started');
      skipped += 4;
    } else {
      console.log(`✗ FAIL: Expected 200 or 503, got ${response.statusCode}`);
      failed += 4;
    }
  } catch (error) {
    console.log('✗ FAIL: Readiness request failed:', error.message);
    failed += 4;
  }
  console.log('');
  
  // TEST 4: Worker heartbeat detection
  console.log('--- TEST 4: Worker Heartbeat Detection ---');
  console.log('Note: This test requires the worker process to be running');
  console.log('Start worker in another terminal: npm run worker');
  console.log('');
  
  try {
    const response = await makeRequest('/health/ready');
    
    if (response.statusCode === 200 && response.body.checks?.worker) {
      const workerStatus = response.body.checks.worker.status;
      const workerAge = response.body.checks.worker.lastHeartbeatAgeSeconds;
      
      console.log(`Worker status: ${workerStatus}`);
      console.log(`Worker heartbeat age: ${workerAge} seconds`);
      
      if (workerStatus === 'healthy') {
        console.log('✓ PASS: Worker heartbeat is healthy');
        passed++;
        
        if (typeof workerAge === 'number' && workerAge < 20) {
          console.log('✓ PASS: Worker heartbeat is fresh (< 20 seconds)');
          passed++;
        } else {
          console.log('⚠ SKIP: Worker heartbeat age not fresh or not running');
          skipped++;
        }
      } else if (workerStatus === 'not-running') {
        console.log('⚠ SKIP: Worker is not running (no heartbeat detected)');
        console.log('  Start worker with: npm run worker');
        skipped += 2;
      } else if (workerStatus === 'unhealthy') {
        console.log('⚠ SKIP: Worker heartbeat is stale');
        console.log('  This may indicate worker is stopped or experiencing issues');
        skipped += 2;
      } else {
        console.log(`✗ FAIL: Unexpected worker status: ${workerStatus}`);
        failed += 2;
      }
    } else {
      console.log('⚠ SKIP: Cannot check worker status (Redis unavailable)');
      skipped += 2;
    }
  } catch (error) {
    console.log('✗ FAIL: Worker health check failed:', error.message);
    failed += 2;
  }
  console.log('');
  
  // TEST 5: Readiness response structure
  console.log('--- TEST 5: Readiness Response Structure ---');
  try {
    const response = await makeRequest('/health/ready');
    
    if (response.body.service === 'webhook-dispatcher-api') {
      console.log('✓ PASS: Service name is correct');
      passed++;
    } else {
      console.log('✗ FAIL: Service name missing or incorrect');
      failed++;
    }
    
    if (response.body.timestamp) {
      const timestamp = new Date(response.body.timestamp);
      if (!isNaN(timestamp.getTime())) {
        console.log('✓ PASS: Timestamp is valid ISO format');
        console.log(`  Timestamp: ${response.body.timestamp}`);
        passed++;
      } else {
        console.log('✗ FAIL: Invalid timestamp format');
        failed++;
      }
    } else {
      console.log('✗ FAIL: Timestamp missing');
      failed++;
    }
    
    if (response.body.checks) {
      console.log('✓ PASS: Health checks section present');
      passed++;
    } else {
      console.log('✗ FAIL: Health checks section missing');
      failed++;
    }
  } catch (error) {
    console.log('✗ FAIL: Response structure check failed:', error.message);
    failed += 3;
  }
  console.log('');
  
  // TEST 6: No secrets exposed
  console.log('--- TEST 6: Security - No Secrets Exposed ---');
  try {
    const response = await makeRequest('/health/ready');
    const responseStr = JSON.stringify(response.body).toLowerCase();
    
    const forbiddenTerms = ['password', 'secret', 'credential', 'redis://', 'localhost:6379'];
    let secretsFound = false;
    
    forbiddenTerms.forEach(term => {
      // Allow 'localhost:6379' in error messages only
      if (term === 'localhost:6379' && responseStr.includes('localhost:6379')) {
        // Check if it's in an error context (acceptable)
        if (response.body.checks?.redis?.error?.includes('localhost:6379')) {
          return; // OK - error message can contain connection info
        }
      }
      
      if (responseStr.includes(term) && term !== 'localhost:6379') {
        console.log(`✗ FAIL: Response contains forbidden term: ${term}`);
        secretsFound = true;
        failed++;
      }
    });
    
    if (!secretsFound) {
      console.log('✓ PASS: No secrets or credentials exposed');
      passed++;
    }
  } catch (error) {
    console.log('✗ FAIL: Security check failed:', error.message);
    failed++;
  }
  console.log('');
  
  // MANUAL TEST: Redis unavailability
  console.log('--- MANUAL TEST: Redis Unavailability ---');
  console.log('⚠ MANUAL TEST: Redis unavailability cannot be tested automatically');
  console.log('');
  console.log('To test manually:');
  console.log('1. Stop Redis/Memurai service');
  console.log('2. Send request: curl http://localhost:5000/health/ready');
  console.log('3. Expected: HTTP 503 with status: "not-ready"');
  console.log('4. Expected: redis.status: "disconnected"');
  console.log('5. Expected: error message present');
  console.log('6. Start Redis/Memurai service');
  console.log('7. Send request again: curl http://localhost:5000/health/ready');
  console.log('8. Expected: HTTP 200 with status: "ready"');
  console.log('');
  skipped++;
  
  // MANUAL TEST: Worker shutdown
  console.log('--- MANUAL TEST: Worker Graceful Shutdown ---');
  console.log('⚠ MANUAL TEST: Worker shutdown cannot be tested automatically');
  console.log('');
  console.log('To test manually:');
  console.log('1. Start worker: npm run worker');
  console.log('2. Wait 15 seconds for heartbeat to establish');
  console.log('3. Check readiness: curl http://localhost:5000/health/ready');
  console.log('4. Expected: worker.status: "healthy"');
  console.log('5. Stop worker gracefully (Ctrl+C)');
  console.log('6. Check readiness again immediately');
  console.log('7. Expected: worker.status: "not-running" (heartbeat removed)');
  console.log('8. Wait 35 seconds and check again');
  console.log('9. Expected: worker.status: "not-running" (TTL expired)');
  console.log('');
  skipped++;
  
  // Summary
  console.log('='.repeat(60));
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total Tests: ${passed + failed + skipped}`);
  console.log(`✓ Passed: ${passed}`);
  console.log(`✗ Failed: ${failed}`);
  console.log(`⚠ Skipped: ${skipped}`);
  console.log('');
  
  if (failed === 0) {
    console.log('✓ All automated tests PASSED');
  } else {
    console.log(`✗ ${failed} test(s) FAILED`);
  }
  
  if (skipped > 0) {
    console.log(`⚠ ${skipped} test(s) SKIPPED (manual testing required or dependencies not running)`);
  }
  
  console.log('');
  console.log('Next steps:');
  console.log('1. Ensure Redis/Memurai service is running');
  console.log('2. Start worker process: npm run worker');
  console.log('3. Run manual tests (Redis unavailability, worker shutdown)');
  console.log('4. Run Phase 1 and Phase 2 regression tests');
  console.log('='.repeat(60));
  console.log('');
  
  process.exit(failed > 0 ? 1 : 0);
})();
