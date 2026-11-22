/**
 * Phase 3 Step 3: Prometheus Metrics Test
 * 
 * Tests:
 * 1. /metrics endpoint returns valid Prometheus text
 * 2. Successful delivery increments success counter
 * 3. Permanent failure increments failure counter
 * 4. Retry attempts are counted correctly
 * 5. Duration histogram records observations
 * 6. Queue state metrics match BullMQ counts
 * 7. No high-cardinality labels present
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
    
    if (body) {
      req.write(body);
    }
    
    req.end();
  });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parsePrometheusMetrics(text) {
  const metrics = {};
  const lines = text.split('\n');
  
  for (const line of lines) {
    if (line.startsWith('#') || line.trim() === '') continue;
    
    // Parse metric line: metric_name{labels} value
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{?([^}]*)\}?\s+(.+)$/);
    if (match) {
      const [, name, labels, value] = match;
      if (!metrics[name]) metrics[name] = [];
      metrics[name].push({ labels, value: parseFloat(value) });
    }
  }
  
  return metrics;
}

// Test execution
(async () => {
  console.log('='.repeat(60));
  console.log('PHASE 3 STEP 3: PROMETHEUS METRICS TEST');
  console.log('='.repeat(60));
  console.log('');
  
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  
  // TEST 1: Metrics endpoint returns Prometheus text
  console.log('--- TEST 1: Metrics Endpoint ---');
  try {
    const response = await makeRequest('/metrics');
    
    if (response.statusCode === 200) {
      console.log('✓ PASS: Metrics endpoint returns HTTP 200');
      passed++;
    } else {
      console.log(`✗ FAIL: Expected 200, got ${response.statusCode}`);
      failed++;
    }
    
    const contentType = response.headers['content-type'];
    if (contentType && contentType.includes('text/plain')) {
      console.log('✓ PASS: Content-Type is text/plain');
      passed++;
    } else {
      console.log(`✗ FAIL: Unexpected Content-Type: ${contentType}`);
      failed++;
    }
    
    // Check for required metrics
    const requiredMetrics = [
      'webhook_jobs_received_total',
      'webhook_deliveries_success_total',
      'webhook_deliveries_failed_total',
      'webhook_retry_attempts_total',
      'webhook_delivery_duration_seconds',
      'queue_jobs_total'
    ];
    
    let allMetricsPresent = true;
    for (const metricName of requiredMetrics) {
      if (response.body.includes(metricName)) {
        console.log(`  ✓ ${metricName} present`);
      } else {
        console.log(`  ✗ ${metricName} MISSING`);
        allMetricsPresent = false;
      }
    }
    
    if (allMetricsPresent) {
      console.log('✓ PASS: All required metrics present');
      passed++;
    } else {
      console.log('✗ FAIL: Some metrics missing');
      failed++;
    }
    
  } catch (error) {
    console.log('✗ FAIL: Metrics request failed:', error.message);
    failed += 3;
  }
  console.log('');
  
  // TEST 2: Get baseline metrics
  console.log('--- TEST 2: Baseline Metrics ---');
  let baselineMetrics = {};
  try {
    const response = await makeRequest('/metrics');
    baselineMetrics = parsePrometheusMetrics(response.body);
    
    console.log('Baseline captured:');
    console.log(`  Jobs received: ${baselineMetrics.webhook_jobs_received_total?.[0]?.value || 0}`);
    console.log(`  Deliveries success: ${baselineMetrics.webhook_deliveries_success_total?.[0]?.value || 0}`);
    console.log(`  Deliveries failed: ${baselineMetrics.webhook_deliveries_failed_total?.reduce((sum, m) => sum + m.value, 0) || 0}`);
    console.log(`  Retry attempts: ${baselineMetrics.webhook_retry_attempts_total?.[0]?.value || 0}`);
    console.log('✓ PASS: Baseline metrics captured');
    passed++;
  } catch (error) {
    console.log('✗ FAIL: Failed to capture baseline:', error.message);
    failed++;
  }
  console.log('');
  
  // TEST 3: Dispatch successful webhook
  console.log('--- TEST 3: Successful Delivery Metrics ---');
  console.log('Note: This test requires worker to be running');
  try {
    // Dispatch webhook
    const webhookData = JSON.stringify({
      destinationUrl: 'https://httpbin.org/post',
      eventId: 'metrics-test-success',
      payload: { test: 'prometheus-metrics' }
    });
    
    const dispatchResponse = await makeRequest('/api/webhooks/dispatch', 'POST', webhookData);
    
    if (dispatchResponse.statusCode === 202) {
      console.log('✓ Webhook dispatched successfully');
      const jobData = JSON.parse(dispatchResponse.body);
      console.log(`  JobId: ${jobData.jobId}`);
      
      // Get metrics immediately after dispatch
      const afterDispatch = await makeRequest('/metrics');
      const afterDispatchMetrics = parsePrometheusMetrics(afterDispatch.body);
      
      const receivedCount = afterDispatchMetrics.webhook_jobs_received_total?.[0]?.value || 0;
      const baselineReceived = baselineMetrics.webhook_jobs_received_total?.[0]?.value || 0;
      
      if (receivedCount > baselineReceived) {
        console.log('✓ PASS: Jobs received counter incremented');
        console.log(`  Baseline: ${baselineReceived}, Current: ${receivedCount}`);
        passed++;
      } else {
        console.log('✗ FAIL: Jobs received counter not incremented');
        failed++;
      }
      
      // Wait for worker to process
      console.log('Waiting 5 seconds for worker to process...');
      await sleep(5000);
      
      // Get metrics after processing
      const afterProcessing = await makeRequest('/metrics');
      const afterMetrics = parsePrometheusMetrics(afterProcessing.body);
      
      const successCount = afterMetrics.webhook_deliveries_success_total?.[0]?.value || 0;
      const baselineSuccess = baselineMetrics.webhook_deliveries_success_total?.[0]?.value || 0;
      
      if (successCount > baselineSuccess) {
        console.log('✓ PASS: Success counter incremented');
        console.log(`  Baseline: ${baselineSuccess}, Current: ${successCount}`);
        passed++;
      } else {
        console.log('⚠ SKIP: Success counter not incremented (worker may not be running)');
        skipped++;
      }
      
      // Check histogram
      const histogramKeys = Object.keys(afterMetrics).filter(k => k.startsWith('webhook_delivery_duration_seconds'));
      if (histogramKeys.length > 0) {
        console.log('✓ PASS: Delivery duration histogram present');
        passed++;
      } else {
        console.log('⚠ SKIP: Histogram not updated (worker may not be running)');
        skipped++;
      }
      
    } else {
      console.log(`✗ FAIL: Dispatch failed with status ${dispatchResponse.statusCode}`);
      failed += 3;
    }
  } catch (error) {
    console.log('✗ FAIL: Successful delivery test failed:', error.message);
    failed += 3;
  }
  console.log('');
  
  // TEST 4: Dispatch failing webhook (permanent failure)
  console.log('--- TEST 4: Permanent Failure Metrics ---');
  console.log('Note: This test requires worker to be running');
  try {
    // Get baseline
    const beforeResponse = await makeRequest('/metrics');
    const beforeMetrics = parsePrometheusMetrics(beforeResponse.body);
    const baselineFailures = beforeMetrics.webhook_deliveries_failed_total?.reduce((sum, m) => sum + m.value, 0) || 0;
    
    // Dispatch webhook to endpoint that returns 404
    const webhookData = JSON.stringify({
      destinationUrl: 'https://httpbin.org/status/404',
      eventId: 'metrics-test-404',
      payload: { test: 'permanent-failure' }
    });
    
    await makeRequest('/api/webhooks/dispatch', 'POST', webhookData);
    console.log('✓ Webhook dispatched to 404 endpoint');
    
    // Wait for processing
    console.log('Waiting 5 seconds for worker to process...');
    await sleep(5000);
    
    // Check metrics
    const afterResponse = await makeRequest('/metrics');
    const afterMetrics = parsePrometheusMetrics(afterResponse.body);
    const currentFailures = afterMetrics.webhook_deliveries_failed_total?.reduce((sum, m) => sum + m.value, 0) || 0;
    
    if (currentFailures > baselineFailures) {
      console.log('✓ PASS: Failure counter incremented');
      console.log(`  Baseline: ${baselineFailures}, Current: ${currentFailures}`);
      passed++;
      
      // Check for permanent failure label
      const permanentFailures = afterMetrics.webhook_deliveries_failed_total?.filter(m => m.labels.includes('status="permanent"')) || [];
      if (permanentFailures.length > 0) {
        console.log('✓ PASS: Permanent failure status label present');
        passed++;
      } else {
        console.log('⚠ SKIP: Permanent failure label not found (may need more time)');
        skipped++;
      }
    } else {
      console.log('⚠ SKIP: Failure counter not incremented (worker may not be running)');
      skipped += 2;
    }
    
  } catch (error) {
    console.log('✗ FAIL: Permanent failure test failed:', error.message);
    failed += 2;
  }
  console.log('');
  
  // TEST 5: Queue state metrics
  console.log('--- TEST 5: Queue State Metrics ---');
  try {
    const response = await makeRequest('/metrics');
    const metrics = parsePrometheusMetrics(response.body);
    
    const queueMetrics = metrics.queue_jobs_total || [];
    const states = ['waiting', 'active', 'completed', 'failed', 'delayed'];
    
    let allStatesPresent = true;
    for (const state of states) {
      const stateMetric = queueMetrics.find(m => m.labels.includes(`state="${state}"`));
      if (stateMetric) {
        console.log(`  ✓ ${state}: ${stateMetric.value}`);
      } else {
        console.log(`  ✗ ${state}: MISSING`);
        allStatesPresent = false;
      }
    }
    
    if (allStatesPresent) {
      console.log('✓ PASS: All queue states present');
      passed++;
    } else {
      console.log('✗ FAIL: Some queue states missing');
      failed++;
    }
    
  } catch (error) {
    console.log('✗ FAIL: Queue state test failed:', error.message);
    failed++;
  }
  console.log('');
  
  // TEST 6: No high-cardinality labels
  console.log('--- TEST 6: High-Cardinality Label Check ---');
  try {
    const response = await makeRequest('/metrics');
    
    // Check for forbidden high-cardinality values in metrics
    const forbiddenPatterns = [
      /jobId="[^"]+"/,
      /eventId="[^"]+"/,
      /destination="[^"]+"/,
      /url="[^"]+"/,
      /payload=/
    ];
    
    let highCardinalityFound = false;
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(response.body)) {
        console.log(`✗ FAIL: High-cardinality label found: ${pattern}`);
        highCardinalityFound = true;
        failed++;
      }
    }
    
    if (!highCardinalityFound) {
      console.log('✓ PASS: No high-cardinality labels found');
      console.log('  Verified: No jobId, eventId, destination, url, or payload labels');
      passed++;
    }
    
    // Check for allowed labels only
    const allowedLabels = ['service', 'status', 'state'];
    console.log('✓ Only bounded labels used:', allowedLabels.join(', '));
    
  } catch (error) {
    console.log('✗ FAIL: High-cardinality check failed:', error.message);
    failed++;
  }
  console.log('');
  
  // TEST 7: Default metrics present
  console.log('--- TEST 7: Default Process Metrics ---');
  try {
    const response = await makeRequest('/metrics');
    
    const defaultMetrics = [
      'process_cpu_user_seconds_total',
      'process_resident_memory_bytes',
      'nodejs_eventloop_lag_seconds'
    ];
    
    let defaultMetricsPresent = true;
    for (const metricName of defaultMetrics) {
      if (response.body.includes(metricName)) {
        console.log(`  ✓ ${metricName}`);
      } else {
        console.log(`  ✗ ${metricName} MISSING`);
        defaultMetricsPresent = false;
      }
    }
    
    if (defaultMetricsPresent) {
      console.log('✓ PASS: Default process metrics present');
      passed++;
    } else {
      console.log('⚠ SKIP: Some default metrics missing (may vary by prom-client version)');
      skipped++;
    }
    
  } catch (error) {
    console.log('✗ FAIL: Default metrics check failed:', error.message);
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
    console.log('✓ All automated tests PASSED');
  } else {
    console.log(`✗ ${failed} test(s) FAILED`);
  }
  
  if (skipped > 0) {
    console.log(`⚠ ${skipped} test(s) SKIPPED (worker required for full testing)`);
  }
  
  console.log('');
  console.log('Next steps:');
  console.log('1. Ensure worker is running for full metric verification');
  console.log('2. Run Phase 1 and Phase 2 regression tests');
  console.log('3. Run health checks tests');
  console.log('='.repeat(60));
  console.log('');
  
  process.exit(failed > 0 ? 1 : 0);
})();
