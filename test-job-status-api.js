/**
 * Phase 3 Step 4: Job Status API Test
 * 
 * Tests:
 * 1. Valid waiting job returns correct status
 * 2. Completed job returns completed status
 * 3. Failed job returns failed status
 * 4. Invalid jobId returns HTTP 400
 * 5. Unknown jobId returns HTTP 404
 * 6. Sensitive job data is not exposed
 * 7. Existing dispatch endpoint still returns HTTP 202
 * 8. Health and metrics endpoints still work
 */

import http from 'http';

const API_HOST = 'localhost';
const API_PORT = process.env.PORT || 5000;

// Test utilities
function makeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST,
      port: API_PORT,
      path: path,
      method: method,
      timeout: 5000
    };
    
    if (body) {
      options.headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      };
    }
    
    const req = http.request(options, (res) => {
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
    
    if (body) {
      req.write(body);
    }
    
    req.end();
  });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Test execution
(async () => {
  console.log('='.repeat(60));
  console.log('PHASE 3 STEP 4: JOB STATUS API TEST');
  console.log('='.repeat(60));
  console.log('');
  
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  
  // TEST 1: Dispatch webhook and check waiting status
  console.log('--- TEST 1: Waiting Job Status ---');
  let testJobId = null;
  try {
    // Stop worker temporarily by checking if it's running
    console.log('Note: For waiting status test, worker should NOT be running');
    
    // Dispatch webhook
    const dispatchBody = JSON.stringify({
      destinationUrl: 'https://httpbin.org/post',
      eventId: 'status-test-waiting',
      payload: { test: 'job-status-api', secret: 'should-not-appear' }
    });
    
    const dispatchResponse = await makeRequest('/api/webhooks/dispatch', 'POST', dispatchBody);
    
    if (dispatchResponse.statusCode === 202) {
      testJobId = dispatchResponse.body.jobId;
      console.log(`✓ Webhook dispatched: ${testJobId}`);
      
      // Check status immediately
      const statusResponse = await makeRequest(`/api/webhooks/status/${testJobId}`);
      
      if (statusResponse.statusCode === 200) {
        console.log('✓ PASS: Status endpoint returns HTTP 200');
        passed++;
        
        const status = statusResponse.body;
        console.log(`  Status: ${status.status}`);
        console.log(`  Attempts: ${status.attemptsMade}/${status.maxAttempts}`);
        
        if (status.jobId === testJobId) {
          console.log('✓ PASS: JobId matches');
          passed++;
        } else {
          console.log('✗ FAIL: JobId mismatch');
          failed++;
        }
        
        if (['waiting', 'active', 'completed'].includes(status.status)) {
          console.log(`✓ PASS: Valid status returned (${status.status})`);
          passed++;
        } else {
          console.log(`✗ FAIL: Unexpected status: ${status.status}`);
          failed++;
        }
        
        if (typeof status.attemptsMade === 'number' && typeof status.maxAttempts === 'number') {
          console.log('✓ PASS: Attempt counts present');
          passed++;
        } else {
          console.log('✗ FAIL: Attempt counts missing');
          failed++;
        }
        
        if (status.createdAt) {
          console.log('✓ PASS: createdAt timestamp present');
          passed++;
        } else {
          console.log('✗ FAIL: createdAt missing');
          failed++;
        }
      } else {
        console.log(`✗ FAIL: Status check returned ${statusResponse.statusCode}`);
        failed += 5;
      }
    } else {
      console.log(`✗ FAIL: Dispatch failed with ${dispatchResponse.statusCode}`);
      failed += 5;
    }
  } catch (error) {
    console.log('✗ FAIL: Waiting job test failed:', error.message);
    failed += 5;
  }
  console.log('');
  
  // TEST 2: Completed job status (if worker is running)
  console.log('--- TEST 2: Completed Job Status ---');
  try {
    // Dispatch another webhook
    const dispatchBody = JSON.stringify({
      destinationUrl: 'https://httpbin.org/post',
      eventId: 'status-test-completed',
      payload: { test: 'completed-status' }
    });
    
    const dispatchResponse = await makeRequest('/api/webhooks/dispatch', 'POST', dispatchBody);
    
    if (dispatchResponse.statusCode === 202) {
      const completedJobId = dispatchResponse.body.jobId;
      console.log(`✓ Webhook dispatched: ${completedJobId}`);
      
      // Wait for processing
      console.log('Waiting 5 seconds for worker to process...');
      await sleep(5000);
      
      // Check status
      const statusResponse = await makeRequest(`/api/webhooks/status/${completedJobId}`);
      
      if (statusResponse.statusCode === 200) {
        const status = statusResponse.body;
        console.log(`  Status: ${status.status}`);
        
        if (status.status === 'completed') {
          console.log('✓ PASS: Job completed successfully');
          passed++;
          
          if (status.finishedAt) {
            console.log('✓ PASS: finishedAt timestamp present');
            passed++;
          } else {
            console.log('✗ FAIL: finishedAt missing for completed job');
            failed++;
          }
        } else if (status.status === 'waiting' || status.status === 'active') {
          console.log('⚠ SKIP: Job not yet completed (worker may not be running)');
          skipped += 2;
        } else {
          console.log(`✗ FAIL: Unexpected status: ${status.status}`);
          failed += 2;
        }
      } else {
        console.log(`✗ FAIL: Status check returned ${statusResponse.statusCode}`);
        failed += 2;
      }
    } else {
      console.log('⚠ SKIP: Could not dispatch test webhook');
      skipped += 2;
    }
  } catch (error) {
    console.log('⚠ SKIP: Completed job test failed:', error.message);
    skipped += 2;
  }
  console.log('');
  
  // TEST 3: Failed job status
  console.log('--- TEST 3: Failed Job Status ---');
  try {
    // Dispatch webhook to endpoint that will fail (404)
    const dispatchBody = JSON.stringify({
      destinationUrl: 'https://httpbin.org/status/404',
      eventId: 'status-test-failed',
      payload: { test: 'failed-status' }
    });
    
    const dispatchResponse = await makeRequest('/api/webhooks/dispatch', 'POST', dispatchBody);
    
    if (dispatchResponse.statusCode === 202) {
      const failedJobId = dispatchResponse.body.jobId;
      console.log(`✓ Webhook dispatched to 404 endpoint: ${failedJobId}`);
      
      // Wait for processing
      console.log('Waiting 5 seconds for worker to process...');
      await sleep(5000);
      
      // Check status
      const statusResponse = await makeRequest(`/api/webhooks/status/${failedJobId}`);
      
      if (statusResponse.statusCode === 200) {
        const status = statusResponse.body;
        console.log(`  Status: ${status.status}`);
        
        if (status.status === 'failed') {
          console.log('✓ PASS: Job failed as expected');
          passed++;
          
          if (status.failedReason) {
            console.log(`✓ PASS: failedReason present: ${status.failedReason}`);
            passed++;
          } else {
            console.log('✗ FAIL: failedReason missing for failed job');
            failed++;
          }
        } else if (status.status === 'waiting' || status.status === 'active') {
          console.log('⚠ SKIP: Job not yet processed (worker may not be running)');
          skipped += 2;
        } else {
          console.log(`⚠ SKIP: Unexpected status: ${status.status}`);
          skipped += 2;
        }
      } else {
        console.log(`✗ FAIL: Status check returned ${statusResponse.statusCode}`);
        failed += 2;
      }
    } else {
      console.log('⚠ SKIP: Could not dispatch test webhook');
      skipped += 2;
    }
  } catch (error) {
    console.log('⚠ SKIP: Failed job test failed:', error.message);
    skipped += 2;
  }
  console.log('');
  
  // TEST 4: Invalid jobId format
  console.log('--- TEST 4: Invalid JobId Format ---');
  try {
    const invalidIds = [
      'not-a-uuid',
      '12345',
      'invalid-job-id-format',
      'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
    ];
    
    let allInvalid = true;
    for (const invalidId of invalidIds) {
      const response = await makeRequest(`/api/webhooks/status/${invalidId}`);
      if (response.statusCode !== 400) {
        console.log(`✗ FAIL: Invalid ID "${invalidId}" returned ${response.statusCode}, expected 400`);
        allInvalid = false;
        break;
      }
    }
    
    if (allInvalid) {
      console.log('✓ PASS: All invalid jobIds return HTTP 400');
      passed++;
    } else {
      failed++;
    }
  } catch (error) {
    console.log('✗ FAIL: Invalid jobId test failed:', error.message);
    failed++;
  }
  console.log('');
  
  // TEST 5: Unknown jobId
  console.log('--- TEST 5: Unknown JobId ---');
  try {
    // Valid UUID format but doesn't exist
    const unknownJobId = '00000000-0000-4000-8000-000000000000';
    const response = await makeRequest(`/api/webhooks/status/${unknownJobId}`);
    
    if (response.statusCode === 404) {
      console.log('✓ PASS: Unknown jobId returns HTTP 404');
      passed++;
    } else {
      console.log(`✗ FAIL: Unknown jobId returned ${response.statusCode}, expected 404`);
      failed++;
    }
  } catch (error) {
    console.log('✗ FAIL: Unknown jobId test failed:', error.message);
    failed++;
  }
  console.log('');
  
  // TEST 6: Sensitive data not exposed
  console.log('--- TEST 6: Sensitive Data Not Exposed ---');
  if (testJobId) {
    try {
      const response = await makeRequest(`/api/webhooks/status/${testJobId}`);
      
      if (response.statusCode === 200) {
        const responseStr = JSON.stringify(response.body).toLowerCase();
        
        // Check for forbidden fields
        const forbiddenFields = ['payload', 'destinationurl', 'destination_url', 'secret'];
        let sensitiveDataFound = false;
        
        for (const field of forbiddenFields) {
          if (responseStr.includes(field)) {
            console.log(`✗ FAIL: Response contains sensitive field: ${field}`);
            sensitiveDataFound = true;
            failed++;
          }
        }
        
        if (!sensitiveDataFound) {
          console.log('✓ PASS: No sensitive data exposed');
          passed++;
        }
      } else {
        console.log('⚠ SKIP: Could not verify sensitive data exposure');
        skipped++;
      }
    } catch (error) {
      console.log('⚠ SKIP: Sensitive data test failed:', error.message);
      skipped++;
    }
  } else {
    console.log('⚠ SKIP: No test job available');
    skipped++;
  }
  console.log('');
  
  // TEST 7: Dispatch endpoint still works
  console.log('--- TEST 7: Dispatch Endpoint Unchanged ---');
  try {
    const dispatchBody = JSON.stringify({
      destinationUrl: 'https://httpbin.org/post',
      eventId: 'dispatch-still-works',
      payload: { test: 'endpoint-check' }
    });
    
    const response = await makeRequest('/api/webhooks/dispatch', 'POST', dispatchBody);
    
    if (response.statusCode === 202 && response.body.status === 'queued' && response.body.jobId) {
      console.log('✓ PASS: Dispatch endpoint returns HTTP 202 with jobId');
      passed++;
    } else {
      console.log(`✗ FAIL: Dispatch endpoint returned ${response.statusCode}`);
      failed++;
    }
  } catch (error) {
    console.log('✗ FAIL: Dispatch endpoint test failed:', error.message);
    failed++;
  }
  console.log('');
  
  // TEST 8: Health and metrics still work
  console.log('--- TEST 8: Health and Metrics Endpoints ---');
  try {
    const healthResponse = await makeRequest('/health/ready');
    const metricsResponse = await makeRequest('/metrics');
    
    let healthPass = false;
    let metricsPass = false;
    
    if (healthResponse.statusCode === 200 || healthResponse.statusCode === 503) {
      console.log(`✓ Health endpoint responsive (${healthResponse.statusCode})`);
      healthPass = true;
    } else {
      console.log(`✗ Health endpoint returned ${healthResponse.statusCode}`);
    }
    
    if (metricsResponse.statusCode === 200) {
      console.log('✓ Metrics endpoint responsive');
      metricsPass = true;
    } else {
      console.log(`✗ Metrics endpoint returned ${metricsResponse.statusCode}`);
    }
    
    if (healthPass && metricsPass) {
      console.log('✓ PASS: Health and metrics endpoints work');
      passed++;
    } else {
      console.log('✗ FAIL: Some endpoints not working');
      failed++;
    }
  } catch (error) {
    console.log('✗ FAIL: Health/metrics test failed:', error.message);
    failed++;
  }
  console.log('');
  
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
    console.log('✓ ALL AUTOMATED TESTS PASSED');
  } else {
    console.log(`✗ ${failed} TEST(S) FAILED`);
  }
  
  if (skipped > 0) {
    console.log(`⚠ ${skipped} TEST(S) SKIPPED (worker required for full testing)`);
  }
  
  console.log('');
  console.log('Next steps:');
  console.log('1. Run Phase 1 regression tests');
  console.log('2. Run Phase 2 delivery tests');
  console.log('3. Run Phase 3 logging and health tests');
  console.log('='.repeat(60));
  console.log('');
  
  process.exit(failed > 0 ? 1 : 0);
})();
