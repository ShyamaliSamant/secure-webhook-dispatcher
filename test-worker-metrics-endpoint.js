/**
 * Worker Metrics Endpoint Verification
 * 
 * Verifies:
 * 1. API /metrics returns valid Prometheus text
 * 2. Worker /metrics returns valid Prometheus text
 * 3. Successful delivery increments worker success counter
 */

import http from 'http';

const API_HOST = 'localhost';
const API_PORT = 5000;
const WORKER_PORT = 9090;

function makeRequest(host, port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: host,
      port: port,
      path: path,
      method: 'GET',
      timeout: 5000
    }, (res) => {
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

function makePostRequest(host, port, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request({
      hostname: host,
      port: port,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      },
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body: data
        });
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    req.write(bodyStr);
    req.end();
  });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseMetricValue(text, metricName) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith(metricName + '{') || line.startsWith(metricName + ' ')) {
      const match = line.match(/\s+([0-9.]+)$/);
      if (match) return parseFloat(match[1]);
    }
  }
  return null;
}

(async () => {
  console.log('='.repeat(60));
  console.log('WORKER METRICS ENDPOINT VERIFICATION');
  console.log('='.repeat(60));
  console.log('');
  
  let passed = 0;
  let failed = 0;
  
  // TEST 1: API metrics endpoint
  console.log('--- TEST 1: API Metrics Endpoint ---');
  try {
    const response = await makeRequest(API_HOST, API_PORT, '/metrics');
    
    if (response.statusCode === 200) {
      console.log('✓ PASS: API metrics returns HTTP 200');
      passed++;
    } else {
      console.log(`✗ FAIL: Expected 200, got ${response.statusCode}`);
      failed++;
    }
    
    if (response.body.includes('webhook_jobs_received_total')) {
      console.log('✓ PASS: API metrics contains webhook_jobs_received_total');
      passed++;
    } else {
      console.log('✗ FAIL: webhook_jobs_received_total not found');
      failed++;
    }
    
    if (response.body.includes('queue_jobs_total')) {
      console.log('✓ PASS: API metrics contains queue_jobs_total');
      passed++;
    } else {
      console.log('✗ FAIL: queue_jobs_total not found');
      failed++;
    }
  } catch (error) {
    console.log('✗ FAIL: API metrics request failed:', error.message);
    failed += 3;
  }
  console.log('');
  
  // TEST 2: Worker metrics endpoint
  console.log('--- TEST 2: Worker Metrics Endpoint ---');
  try {
    const response = await makeRequest(API_HOST, WORKER_PORT, '/metrics');
    
    if (response.statusCode === 200) {
      console.log('✓ PASS: Worker metrics returns HTTP 200');
      console.log(`  Worker metrics endpoint: http://localhost:${WORKER_PORT}/metrics`);
      passed++;
    } else {
      console.log(`✗ FAIL: Expected 200, got ${response.statusCode}`);
      failed++;
    }
    
    const contentType = response.headers['content-type'];
    if (contentType && contentType.includes('text/plain')) {
      console.log('✓ PASS: Worker metrics Content-Type is text/plain');
      passed++;
    } else {
      console.log(`✗ FAIL: Unexpected Content-Type: ${contentType}`);
      failed++;
    }
    
    // Check for worker-specific metrics
    if (response.body.includes('webhook_deliveries_success_total')) {
      console.log('✓ PASS: Worker metrics contains webhook_deliveries_success_total');
      passed++;
    } else {
      console.log('✗ FAIL: webhook_deliveries_success_total not found');
      failed++;
    }
    
    if (response.body.includes('webhook_deliveries_failed_total')) {
      console.log('✓ PASS: Worker metrics contains webhook_deliveries_failed_total');
      passed++;
    } else {
      console.log('✗ FAIL: webhook_deliveries_failed_total not found');
      failed++;
    }
    
    if (response.body.includes('webhook_delivery_duration_seconds')) {
      console.log('✓ PASS: Worker metrics contains webhook_delivery_duration_seconds');
      passed++;
    } else {
      console.log('✗ FAIL: webhook_delivery_duration_seconds not found');
      failed++;
    }
    
    if (response.body.includes('process_cpu_user_seconds_total')) {
      console.log('✓ PASS: Worker metrics contains default process metrics');
      passed++;
    } else {
      console.log('✗ FAIL: Default process metrics not found');
      failed++;
    }
  } catch (error) {
    console.log('✗ FAIL: Worker metrics request failed:', error.message);
    console.log('  Make sure worker is running: npm run worker');
    failed += 6;
  }
  console.log('');
  
  // TEST 3: Successful delivery increments worker counter
  console.log('--- TEST 3: Delivery Success Counter ---');
  try {
    // Get baseline
    const beforeResponse = await makeRequest(API_HOST, WORKER_PORT, '/metrics');
    const baselineSuccess = parseMetricValue(beforeResponse.body, 'webhook_deliveries_success_total') || 0;
    console.log(`Baseline success count: ${baselineSuccess}`);
    
    // Dispatch webhook
    const dispatchResponse = await makePostRequest(API_HOST, API_PORT, '/api/webhooks/dispatch', {
      destinationUrl: 'https://httpbin.org/post',
      eventId: 'worker-metrics-test',
      payload: { test: 'worker-metrics-verification' }
    });
    
    if (dispatchResponse.statusCode === 202) {
      const jobData = JSON.parse(dispatchResponse.body);
      console.log(`✓ Webhook dispatched: ${jobData.jobId}`);
      
      // Wait for worker to process
      console.log('Waiting 5 seconds for worker to process...');
      await sleep(5000);
      
      // Check metrics
      const afterResponse = await makeRequest(API_HOST, WORKER_PORT, '/metrics');
      const currentSuccess = parseMetricValue(afterResponse.body, 'webhook_deliveries_success_total') || 0;
      console.log(`Current success count: ${currentSuccess}`);
      
      if (currentSuccess > baselineSuccess) {
        console.log('✓ PASS: Success counter incremented');
        console.log(`  Increment: ${currentSuccess - baselineSuccess}`);
        passed++;
      } else {
        console.log('✗ FAIL: Success counter did not increment');
        console.log('  Worker may not have processed the job or job may have failed');
        failed++;
      }
    } else {
      console.log(`✗ FAIL: Dispatch failed with status ${dispatchResponse.statusCode}`);
      failed++;
    }
  } catch (error) {
    console.log('✗ FAIL: Delivery test failed:', error.message);
    failed++;
  }
  console.log('');
  
  // Summary
  console.log('='.repeat(60));
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total Tests: ${passed + failed}`);
  console.log(`✓ Passed: ${passed}`);
  console.log(`✗ Failed: ${failed}`);
  console.log('');
  
  if (failed === 0) {
    console.log('✓ ALL TESTS PASSED');
    console.log('');
    console.log('Prometheus scrape targets:');
    console.log(`  - API: http://localhost:${API_PORT}/metrics`);
    console.log(`  - Worker: http://localhost:${WORKER_PORT}/metrics`);
  } else {
    console.log(`✗ ${failed} TEST(S) FAILED`);
  }
  
  console.log('='.repeat(60));
  console.log('');
  
  process.exit(failed > 0 ? 1 : 0);
})();
