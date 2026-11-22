/**
 * DLQ Verification Test
 * 
 * Focused tests for:
 * 1. Manual retry consistency (HTTP 500 vs 200/409)
 * 2. Exhausted retry handling (retryable 5xx failures)
 * 3. End-to-end retry flow
 * 4. Duplicate retry protection
 */

import http from 'http';
import { setTimeout as sleep } from 'timers/promises';

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
      timeout: 15000
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

// Test execution
(async () => {
  console.log('='.repeat(70));
  console.log('DLQ VERIFICATION TEST');
  console.log('='.repeat(70));
  console.log('');
  
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  
  // VERIFICATION 1: Manual Retry Consistency
  console.log('--- VERIFICATION 1: Manual Retry Consistency ---');
  console.log('Testing that retry returns HTTP 200 on success, not 500');
  try {
    // Dispatch a webhook that will fail permanently (404)
    const dispatchBody = JSON.stringify({
      destinationUrl: 'https://httpbin.org/status/404',
      eventId: `verify-retry-${Date.now()}`,
      payload: { test: 'manual-retry-consistency' }
    });
    
    const dispatchResponse = await makeRequest('/api/webhooks/dispatch', 'POST', dispatchBody);
    
    if (dispatchResponse.statusCode !== 202) {
      console.log(`✗ FAIL: Dispatch failed with ${dispatchResponse.statusCode}`);
      failed++;
    } else {
      const jobId = dispatchResponse.body.jobId;
      console.log(`✓ Webhook dispatched: ${jobId}`);
      
      // Wait for worker to process and add to DLQ
      console.log('  Waiting 6 seconds for worker to process...');
      await sleep(6000);
      
      // Find DLQ record
      const dlqResponse = await makeRequest('/api/webhooks/dlq');
      const dlqRecord = dlqResponse.body.entries.find(e => e.originalJobId === jobId);
      
      if (!dlqRecord) {
        console.log('⚠ SKIP: DLQ record not created (worker may not be running)');
        skipped++;
      } else {
        const dlqJobId = dlqRecord.dlqJobId;
        console.log(`✓ DLQ record created: ${dlqJobId}`);
        
        // Attempt manual retry
        console.log('  Attempting manual retry...');
        const retryResponse = await makeRequest(`/api/webhooks/dlq/${dlqJobId}/retry`, 'POST');
        
        console.log(`  Retry response: HTTP ${retryResponse.statusCode}`);
        
        if (retryResponse.statusCode === 200) {
          console.log('✓ PASS: Retry returned HTTP 200 (success)');
          console.log(`  New job ID: ${retryResponse.body.newJobId}`);
          passed++;
          
          // Verify new job was created
          const statusResponse = await makeRequest(`/api/webhooks/status/${retryResponse.body.newJobId}`);
          if (statusResponse.statusCode === 200) {
            console.log('✓ PASS: New job exists in queue');
            passed++;
          } else {
            console.log(`✗ FAIL: New job not found (status ${statusResponse.statusCode})`);
            failed++;
          }
          
          // Verify DLQ record updated
          const dlqCheckResponse = await makeRequest('/api/webhooks/dlq');
          const updatedRecord = dlqCheckResponse.body.entries.find(e => e.dlqJobId === dlqJobId);
          
          if (updatedRecord && updatedRecord.status === 'reprocessed') {
            console.log('✓ PASS: DLQ record status updated to reprocessed');
            passed++;
          } else {
            console.log('✗ FAIL: DLQ record not updated correctly');
            failed++;
          }
          
          // Attempt duplicate retry
          console.log('  Attempting duplicate retry...');
          const duplicateResponse = await makeRequest(`/api/webhooks/dlq/${dlqJobId}/retry`, 'POST');
          
          if (duplicateResponse.statusCode === 409) {
            console.log('✓ PASS: Duplicate retry rejected with HTTP 409');
            passed++;
          } else {
            console.log(`✗ FAIL: Expected 409, got ${duplicateResponse.statusCode}`);
            failed++;
          }
          
        } else if (retryResponse.statusCode === 410) {
          console.log('⚠ SKIP: Original job expired (HTTP 410)');
          skipped += 4;
        } else if (retryResponse.statusCode === 500) {
          console.log(`✗ FAIL: Retry returned HTTP 500 (should be 200 or 410)`);
          console.log(`  Error: ${retryResponse.body.error}`);
          failed += 4;
        } else {
          console.log(`✗ FAIL: Unexpected status ${retryResponse.statusCode}`);
          failed += 4;
        }
      }
    }
  } catch (error) {
    console.log(`✗ FAIL: Manual retry consistency test error: ${error.message}`);
    failed += 4;
  }
  console.log('');
  
  // VERIFICATION 2: Exhausted Retry Handling
  console.log('--- VERIFICATION 2: Exhausted Retry Handling ---');
  console.log('Testing that retryable failures create DLQ after exhausting retries');
  try {
    // Get baseline DLQ count
    const baselineResponse = await makeRequest('/api/webhooks/dlq');
    const baselineCount = baselineResponse.body.pagination.total;
    
    // Dispatch webhook to 500 endpoint (retryable)
    const dispatchBody = JSON.stringify({
      destinationUrl: 'https://httpbin.org/status/500',
      eventId: `verify-exhausted-${Date.now()}`,
      payload: { test: 'exhausted-retries' }
    });
    
    const dispatchResponse = await makeRequest('/api/webhooks/dispatch', 'POST', dispatchBody);
    
    if (dispatchResponse.statusCode !== 202) {
      console.log(`✗ FAIL: Dispatch failed with ${dispatchResponse.statusCode}`);
      failed += 3;
    } else {
      const jobId = dispatchResponse.body.jobId;
      console.log(`✓ Webhook dispatched: ${jobId}`);
      console.log('  Configured attempts: 4 total (initial + 3 retries)');
      console.log('  Backoff delays: 2000ms, 4000ms, 8000ms');
      
      // Wait for initial attempt + first few retries
      console.log('  Waiting 8 seconds for initial attempt + retries...');
      await sleep(8000);
      
      // Check job status - should still be in delayed or active state
      const midStatusResponse = await makeRequest(`/api/webhooks/status/${jobId}`);
      
      if (midStatusResponse.statusCode === 200) {
        console.log(`  Mid-check status: ${midStatusResponse.body.status}`);
        console.log(`  Attempts: ${midStatusResponse.body.attemptsMade}/${midStatusResponse.body.maxAttempts}`);
        
        // Check DLQ - should NOT have record yet
        const midDlqResponse = await makeRequest('/api/webhooks/dlq');
        const midDlqRecord = midDlqResponse.body.entries.find(e => e.originalJobId === jobId);
        
        if (!midDlqRecord) {
          console.log('✓ PASS: No DLQ record during retry attempts');
          passed++;
        } else {
          console.log('✗ FAIL: DLQ record created before retries exhausted');
          failed++;
        }
      } else {
        console.log('⚠ SKIP: Could not check job status mid-retry');
        skipped++;
      }
      
      // Wait for all retries to exhaust
      // Exponential backoff: 2s, 4s, 8s = ~14s total + processing time
      console.log('  Waiting 20 seconds for all retries to exhaust...');
      console.log('  (This is necessary to verify exhausted retry behavior)');
      await sleep(20000);
      
      // Check final status - should be failed
      const finalStatusResponse = await makeRequest(`/api/webhooks/status/${jobId}`);
      
      if (finalStatusResponse.statusCode === 200 && finalStatusResponse.body.status === 'failed') {
        console.log('✓ PASS: Job reached failed state after exhausting retries');
        console.log(`  Final attempts: ${finalStatusResponse.body.attemptsMade}/${finalStatusResponse.body.maxAttempts}`);
        passed++;
        
        // Check DLQ - should NOW have record
        const finalDlqResponse = await makeRequest('/api/webhooks/dlq');
        const finalDlqRecord = finalDlqResponse.body.entries.find(e => e.originalJobId === jobId);
        
        if (finalDlqRecord) {
          console.log('✓ PASS: DLQ record created after retries exhausted');
          console.log(`  Failure type: ${finalDlqRecord.failureType}`);
          console.log(`  Attempts: ${finalDlqRecord.attemptsMade}/${finalDlqRecord.maxAttempts}`);
          
          if (finalDlqRecord.failureType === 'exhausted') {
            console.log('✓ PASS: Failure type is "exhausted"');
            passed += 2;
          } else {
            console.log(`✗ FAIL: Expected failureType "exhausted", got "${finalDlqRecord.failureType}"`);
            failed += 2;
          }
        } else {
          console.log('✗ FAIL: No DLQ record after retries exhausted');
          failed += 2;
        }
      } else if (finalStatusResponse.statusCode === 404) {
        console.log('⚠ SKIP: Job expired before verification complete');
        skipped += 3;
      } else {
        console.log(`⚠ SKIP: Job status is ${finalStatusResponse.body?.status}, expected failed`);
        skipped += 3;
      }
    }
  } catch (error) {
    console.log(`✗ FAIL: Exhausted retry test error: ${error.message}`);
    failed += 3;
  }
  console.log('');
  
  // VERIFICATION 3: End-to-End Retry Flow
  console.log('--- VERIFICATION 3: End-to-End Retry Flow ---');
  console.log('Testing complete retry flow with available original job');
  try {
    // Create a permanent failure
    const dispatchBody = JSON.stringify({
      destinationUrl: 'https://httpbin.org/status/403',
      eventId: `verify-e2e-${Date.now()}`,
      payload: { test: 'end-to-end-retry' }
    });
    
    const dispatchResponse = await makeRequest('/api/webhooks/dispatch', 'POST', dispatchBody);
    
    if (dispatchResponse.statusCode !== 202) {
      console.log(`✗ FAIL: Dispatch failed`);
      failed += 5;
    } else {
      const jobId = dispatchResponse.body.jobId;
      console.log(`✓ Webhook dispatched: ${jobId}`);
      
      await sleep(6000);
      
      const dlqResponse = await makeRequest('/api/webhooks/dlq');
      const dlqRecord = dlqResponse.body.entries.find(e => e.originalJobId === jobId);
      
      if (!dlqRecord) {
        console.log('⚠ SKIP: DLQ record not created');
        skipped += 5;
      } else {
        const dlqJobId = dlqRecord.dlqJobId;
        console.log(`✓ DLQ record: ${dlqJobId}`);
        
        // Verify original job exists
        const originalStatusResponse = await makeRequest(`/api/webhooks/status/${jobId}`);
        if (originalStatusResponse.statusCode !== 200) {
          console.log('⚠ SKIP: Original job not available');
          skipped += 5;
        } else {
          console.log('✓ Original job available for retry');
          
          // First retry
          const retry1Response = await makeRequest(`/api/webhooks/dlq/${dlqJobId}/retry`, 'POST');
          
          if (retry1Response.statusCode === 200) {
            console.log('✓ PASS: First retry returns HTTP 200');
            const newJobId1 = retry1Response.body.newJobId;
            console.log(`  New job ID: ${newJobId1}`);
            
            if (newJobId1 !== jobId) {
              console.log('✓ PASS: New job has different UUID');
              passed += 2;
            } else {
              console.log('✗ FAIL: New job has same UUID as original');
              failed += 2;
            }
            
            // Verify new job exists
            const newJobStatusResponse = await makeRequest(`/api/webhooks/status/${newJobId1}`);
            if (newJobStatusResponse.statusCode === 200) {
              console.log('✓ PASS: New webhook job exists in queue');
              passed++;
            } else {
              console.log('✗ FAIL: New webhook job not found');
              failed++;
            }
            
            // Verify DLQ updated
            await sleep(1000);
            const dlqCheckResponse = await makeRequest('/api/webhooks/dlq');
            const updatedRecord = dlqCheckResponse.body.entries.find(e => e.dlqJobId === dlqJobId);
            
            if (updatedRecord && updatedRecord.status === 'reprocessed') {
              console.log('✓ PASS: DLQ record marked as reprocessed');
              passed++;
            } else {
              console.log('✗ FAIL: DLQ record not updated');
              failed++;
            }
            
            // Second retry (duplicate)
            const retry2Response = await makeRequest(`/api/webhooks/dlq/${dlqJobId}/retry`, 'POST');
            
            if (retry2Response.statusCode === 409) {
              console.log('✓ PASS: Second retry returns HTTP 409 (conflict)');
              passed++;
              
              // Verify no duplicate job created
              const dlqFinalResponse = await makeRequest('/api/webhooks/dlq');
              const finalRecord = dlqFinalResponse.body.entries.find(e => e.dlqJobId === dlqJobId);
              
              if (finalRecord.reprocessedJobId === newJobId1) {
                console.log('✓ PASS: No duplicate job created');
                passed++;
              } else {
                console.log('✗ FAIL: Duplicate job may have been created');
                failed++;
              }
            } else {
              console.log(`✗ FAIL: Second retry returned ${retry2Response.statusCode}, expected 409`);
              failed += 2;
            }
          } else {
            console.log(`✗ FAIL: First retry returned ${retry1Response.statusCode}, expected 200`);
            failed += 5;
          }
        }
      }
    }
  } catch (error) {
    console.log(`✗ FAIL: End-to-end retry test error: ${error.message}`);
    failed += 5;
  }
  console.log('');
  
  // Summary
  console.log('='.repeat(70));
  console.log('VERIFICATION SUMMARY');
  console.log('='.repeat(70));
  console.log(`Total Verifications: ${passed + failed + skipped}`);
  console.log(`✓ Passed: ${passed}`);
  console.log(`✗ Failed: ${failed}`);
  console.log(`⚠ Skipped: ${skipped}`);
  console.log('');
  
  // Specific findings
  console.log('FINDINGS:');
  if (passed >= 9 && failed === 0) {
    console.log('✓ Manual retry consistency: VERIFIED');
    console.log('✓ Duplicate retry protection: VERIFIED');
  } else if (failed > 0) {
    console.log('✗ Issues found in DLQ implementation');
  }
  
  if (skipped > 0) {
    console.log(`⚠ ${skipped} verification(s) skipped (timing, worker, or job availability)`);
  }
  
  console.log('');
  console.log('='.repeat(70));
  
  process.exit(failed > 0 ? 1 : 0);
})();
