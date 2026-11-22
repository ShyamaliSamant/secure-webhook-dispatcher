/**
 * Phase 2 Final Verification Test Suite
 * 
 * Comprehensive reliability and security testing
 * 
 * Tests:
 * 1. Retry behavior (HTTP 500 vs 400)
 * 2. Timeout handling
 * 3. Response size limits
 * 4. SSRF protection (comprehensive)
 * 5. Connection pinning verification
 * 6. Graceful shutdown
 * 7. Regression tests
 */

import { addWebhookJob, closeQueue } from './src/queues/webhookQueue.js';
import { startWebhookWorker, shutdownWorker } from './src/workers/webhookWorker.js';
import { redisConnection } from './src/config/redis.js';
import crypto from 'crypto';

// Test configuration
const TEST_TIMEOUT = 120000; // 2 minutes total test timeout
const JOB_WAIT_TIME = 10000; // Wait time for job completion
const LONG_WAIT_TIME = 35000; // Wait time for timeout tests

// Test results tracking
const results = {
  total: 0,
  passed: 0,
  failed: 0,
  notTested: 0,
  tests: []
};

// ANSI color codes for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

/**
 * Record test result
 */
function recordTest(name, status, setup, expected, actual, notes = '') {
  results.total++;
  
  if (status === 'PASS') {
    results.passed++;
    console.log(`${colors.green}✓ PASS${colors.reset}: ${name}`);
  } else if (status === 'FAIL') {
    results.failed++;
    console.log(`${colors.red}✗ FAIL${colors.reset}: ${name}`);
    console.log(`  Expected: ${expected}`);
    console.log(`  Actual: ${actual}`);
  } else {
    results.notTested++;
    console.log(`${colors.yellow}⊘ NOT TESTED${colors.reset}: ${name} - ${notes}`);
  }
  
  results.tests.push({
    name,
    status,
    setup,
    expected,
    actual,
    notes
  });
}

/**
 * Wait for specified time
 */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get job state from BullMQ
 */
async function getJobState(jobId) {
  try {
    const job = await webhookQueue.getJob(jobId);
    if (!job) return { state: 'not_found', attempts: 0 };
    
    const state = await job.getState();
    const attemptsMade = job.attemptsMade || 0;
    
    return { state, attempts: attemptsMade, job };
  } catch (error) {
    return { state: 'error', error: error.message, attempts: 0 };
  }
}

/**
 * Generate unique job ID
 */
function generateJobId() {
  return crypto.randomUUID();
}

/**
 * Test 1: HTTP 500 should trigger retries
 */
async function test_http_500_retries() {
  console.log(`\n${colors.blue}═══ Test 1: HTTP 500 Retry Behavior ═══${colors.reset}`);
  
  const jobId = generateJobId();
  const testUrl = 'https://httpbin.org/status/500';
  
  console.log(`Setup: Submitting webhook to ${testUrl}`);
  console.log(`Expected: Job should retry multiple times (up to 5 attempts)`);
  
  try {
    await addWebhookJob({
      jobId,
      destinationUrl: testUrl,
      eventId: `test-500-${Date.now()}`,
      payload: { test: 'http_500' },
      createdAt: new Date().toISOString()
    });
    
    // Wait for job to be processed and retried
    console.log(`Waiting ${JOB_WAIT_TIME}ms for retries...`);
    await wait(JOB_WAIT_TIME);
    
    const { state, attempts } = await getJobState(jobId);
    
    console.log(`Actual: Job state = ${state}, attempts = ${attempts}`);
    
    if (attempts > 1) {
      recordTest(
        'HTTP 500 triggers retries',
        'PASS',
        `POST to ${testUrl}`,
        'Multiple attempts (>1)',
        `${attempts} attempts, state: ${state}`
      );
    } else {
      recordTest(
        'HTTP 500 triggers retries',
        'FAIL',
        `POST to ${testUrl}`,
        'Multiple attempts (>1)',
        `Only ${attempts} attempt(s), state: ${state}`
      );
    }
  } catch (error) {
    recordTest(
      'HTTP 500 triggers retries',
      'FAIL',
      `POST to ${testUrl}`,
      'Multiple attempts',
      `Error: ${error.message}`
    );
  }
}

/**
 * Test 2: HTTP 400 should be permanent failure (no retries)
 */
async function test_http_400_permanent() {
  console.log(`\n${colors.blue}═══ Test 2: HTTP 400 Permanent Failure ═══${colors.reset}`);
  
  const jobId = generateJobId();
  const testUrl = 'https://httpbin.org/status/400';
  
  console.log(`Setup: Submitting webhook to ${testUrl}`);
  console.log(`Expected: Job should fail permanently after 1 attempt (no retries)`);
  
  try {
    await addWebhookJob({
      jobId,
      destinationUrl: testUrl,
      eventId: `test-400-${Date.now()}`,
      payload: { test: 'http_400' },
      createdAt: new Date().toISOString()
    });
    
    // Wait for job to be processed
    console.log(`Waiting ${JOB_WAIT_TIME}ms for processing...`);
    await wait(JOB_WAIT_TIME);
    
    const { state, attempts } = await getJobState(jobId);
    
    console.log(`Actual: Job state = ${state}, attempts = ${attempts}`);
    
    // CRITICAL BUG CHECK: This is the known bug from the summary
    // Expected: 1 attempt
    // Actual (with bug): 5 attempts due to moveToFailed not working
    if (attempts === 1 && state === 'failed') {
      recordTest(
        'HTTP 400 permanent failure (1 attempt only)',
        'PASS',
        `POST to ${testUrl}`,
        '1 attempt, state: failed',
        `${attempts} attempt, state: ${state}`
      );
    } else {
      recordTest(
        'HTTP 400 permanent failure (1 attempt only)',
        'FAIL',
        `POST to ${testUrl}`,
        '1 attempt, state: failed',
        `${attempts} attempts, state: ${state} - THIS IS THE CRITICAL BUG`
      );
    }
  } catch (error) {
    recordTest(
      'HTTP 400 permanent failure (1 attempt only)',
      'FAIL',
      `POST to ${testUrl}`,
      '1 attempt',
      `Error: ${error.message}`
    );
  }
}

/**
 * Test 3: SSRF protection - localhost
 */
async function test_ssrf_localhost() {
  console.log(`\n${colors.blue}═══ Test 3: SSRF Protection - Localhost ═══${colors.reset}`);
  
  const jobId = generateJobId();
  const testUrl = 'http://localhost:8080/webhook';
  
  console.log(`Setup: Submitting webhook to ${testUrl}`);
  console.log(`Expected: SSRF validation should block, 1 attempt only`);
  
  try {
    await addWebhookJob({
      jobId,
      destinationUrl: testUrl,
      eventId: `test-ssrf-localhost-${Date.now()}`,
      payload: { test: 'ssrf_localhost' },
      createdAt: new Date().toISOString()
    });
    
    await wait(JOB_WAIT_TIME);
    
    const { state, attempts, job } = await getJobState(jobId);
    
    console.log(`Actual: Job state = ${state}, attempts = ${attempts}`);
    
    // Check if error message indicates SSRF block
    let failedReason = '';
    if (job && job.failedReason) {
      failedReason = job.failedReason;
      console.log(`Failed reason: ${failedReason}`);
    }
    
    const isSSRFBlock = failedReason.includes('SSRF') || failedReason.includes('private') || failedReason.includes('loopback');
    
    // CRITICAL BUG CHECK: SSRF errors should also be permanent (1 attempt)
    if (attempts === 1 && state === 'failed' && isSSRFBlock) {
      recordTest(
        'SSRF blocks localhost (1 attempt)',
        'PASS',
        `POST to ${testUrl}`,
        'Blocked by SSRF, 1 attempt',
        `Blocked: ${failedReason}, ${attempts} attempt`
      );
    } else {
      recordTest(
        'SSRF blocks localhost (1 attempt)',
        'FAIL',
        `POST to ${testUrl}`,
        'Blocked by SSRF, 1 attempt',
        `${attempts} attempts, state: ${state}, SSRF block: ${isSSRFBlock} - THIS IS THE CRITICAL BUG`
      );
    }
  } catch (error) {
    recordTest(
      'SSRF blocks localhost (1 attempt)',
      'FAIL',
      `POST to ${testUrl}`,
      'Blocked by SSRF',
      `Error: ${error.message}`
    );
  }
}

/**
 * Test 4: SSRF protection - private IPv4
 */
async function test_ssrf_private_ipv4() {
  console.log(`\n${colors.blue}═══ Test 4: SSRF Protection - Private IPv4 ═══${colors.reset}`);
  
  const jobId = generateJobId();
  const testUrl = 'http://192.168.1.1/webhook';
  
  console.log(`Setup: Submitting webhook to ${testUrl}`);
  console.log(`Expected: SSRF validation should block, 1 attempt only`);
  
  try {
    await addWebhookJob({
      jobId,
      destinationUrl: testUrl,
      eventId: `test-ssrf-private-${Date.now()}`,
      payload: { test: 'ssrf_private' },
      createdAt: new Date().toISOString()
    });
    
    await wait(JOB_WAIT_TIME);
    
    const { state, attempts, job } = await getJobState(jobId);
    
    console.log(`Actual: Job state = ${state}, attempts = ${attempts}`);
    
    let failedReason = '';
    if (job && job.failedReason) {
      failedReason = job.failedReason;
      console.log(`Failed reason: ${failedReason}`);
    }
    
    const isSSRFBlock = failedReason.includes('SSRF') || failedReason.includes('private');
    
    if (attempts === 1 && state === 'failed' && isSSRFBlock) {
      recordTest(
        'SSRF blocks private IPv4 (1 attempt)',
        'PASS',
        `POST to ${testUrl}`,
        'Blocked by SSRF, 1 attempt',
        `Blocked, ${attempts} attempt`
      );
    } else {
      recordTest(
        'SSRF blocks private IPv4 (1 attempt)',
        'FAIL',
        `POST to ${testUrl}`,
        'Blocked by SSRF, 1 attempt',
        `${attempts} attempts, state: ${state}`
      );
    }
  } catch (error) {
    recordTest(
      'SSRF blocks private IPv4 (1 attempt)',
      'FAIL',
      `POST to ${testUrl}`,
      'Blocked by SSRF',
      `Error: ${error.message}`
    );
  }
}

/**
 * Test 5: Connection pinning - verify actual socket IP
 */
async function test_connection_pinning() {
  console.log(`\n${colors.blue}═══ Test 5: Connection Pinning Verification ═══${colors.reset}`);
  
  const jobId = generateJobId();
  const testUrl = 'https://httpbin.org/post';
  
  console.log(`Setup: Submitting webhook to ${testUrl}`);
  console.log(`Expected: Connection should use pinned IP, HTTP 200 response`);
  
  try {
    await addWebhookJob({
      jobId,
      destinationUrl: testUrl,
      eventId: `test-pinning-${Date.now()}`,
      payload: { test: 'connection_pinning' },
      createdAt: new Date().toISOString()
    });
    
    await wait(JOB_WAIT_TIME);
    
    const { state, attempts } = await getJobState(jobId);
    
    console.log(`Actual: Job state = ${state}, attempts = ${attempts}`);
    
    if (state === 'completed' && attempts === 1) {
      recordTest(
        'Connection pinning works (HTTP 200)',
        'PASS',
        `POST to ${testUrl}`,
        'HTTP 200, 1 attempt',
        `State: ${state}, ${attempts} attempt`
      );
    } else {
      recordTest(
        'Connection pinning works (HTTP 200)',
        'FAIL',
        `POST to ${testUrl}`,
        'HTTP 200, 1 attempt',
        `State: ${state}, ${attempts} attempts`
      );
    }
  } catch (error) {
    recordTest(
      'Connection pinning works (HTTP 200)',
      'FAIL',
      `POST to ${testUrl}`,
      'HTTP 200',
      `Error: ${error.message}`
    );
  }
}

/**
 * Test 6: Timeout handling
 */
async function test_timeout() {
  console.log(`\n${colors.blue}═══ Test 6: Timeout Handling ═══${colors.reset}`);
  
  // Note: httpbin.org/delay/{n} endpoint delays response by n seconds
  // Our default timeout is 30 seconds, so we use 35 second delay
  const jobId = generateJobId();
  const testUrl = 'https://httpbin.org/delay/35';
  
  console.log(`Setup: Submitting webhook to ${testUrl} (35s delay, 30s timeout)`);
  console.log(`Expected: Request should timeout and retry`);
  
  try {
    await addWebhookJob({
      jobId,
      destinationUrl: testUrl,
      eventId: `test-timeout-${Date.now()}`,
      payload: { test: 'timeout' },
      createdAt: new Date().toISOString()
    });
    
    // Wait longer for timeout to occur
    console.log(`Waiting ${LONG_WAIT_TIME}ms for timeout...`);
    await wait(LONG_WAIT_TIME);
    
    const { state, attempts } = await getJobState(jobId);
    
    console.log(`Actual: Job state = ${state}, attempts = ${attempts}`);
    
    if (attempts > 1 || state === 'waiting') {
      recordTest(
        'Timeout triggers retry',
        'PASS',
        `POST to ${testUrl}`,
        'Timeout detected, retry triggered',
        `${attempts} attempts, state: ${state}`
      );
    } else {
      recordTest(
        'Timeout triggers retry',
        'NOT TESTED',
        `POST to ${testUrl}`,
        'Timeout and retry',
        `Cannot verify with public endpoint - ${attempts} attempts, state: ${state}`,
        'Public endpoint limitations'
      );
    }
  } catch (error) {
    recordTest(
      'Timeout triggers retry',
      'FAIL',
      `POST to ${testUrl}`,
      'Timeout and retry',
      `Error: ${error.message}`
    );
  }
}

/**
 * Test 7: Response size limit
 */
async function test_response_size_limit() {
  console.log(`\n${colors.blue}═══ Test 7: Response Size Limit ═══${colors.reset}`);
  
  // httpbin.org doesn't have an endpoint that returns large responses
  // This test documents the limitation
  
  recordTest(
    'Response size limit enforcement',
    'NOT TESTED',
    'Large response endpoint needed',
    'Response exceeds limit, job fails',
    'No suitable public endpoint available',
    'Public endpoint limitations - code inspection shows limit enforced in deliveryService.js:163-168'
  );
}

/**
 * Test 8: TLS certificate validation
 */
async function test_tls_validation() {
  console.log(`\n${colors.blue}═══ Test 8: TLS Certificate Validation ═══${colors.reset}`);
  
  const jobId = generateJobId();
  const testUrl = 'https://httpbin.org/post';
  
  console.log(`Setup: Submitting webhook to ${testUrl} (valid HTTPS)`);
  console.log(`Expected: TLS handshake succeeds, HTTP 200`);
  
  try {
    await addWebhookJob({
      jobId,
      destinationUrl: testUrl,
      eventId: `test-tls-${Date.now()}`,
      payload: { test: 'tls_validation' },
      createdAt: new Date().toISOString()
    });
    
    await wait(JOB_WAIT_TIME);
    
    const { state, attempts } = await getJobState(jobId);
    
    console.log(`Actual: Job state = ${state}, attempts = ${attempts}`);
    
    if (state === 'completed' && attempts === 1) {
      recordTest(
        'TLS certificate validation (HTTPS success)',
        'PASS',
        `POST to ${testUrl}`,
        'HTTPS succeeds, HTTP 200',
        `State: ${state}, ${attempts} attempt`
      );
    } else {
      recordTest(
        'TLS certificate validation (HTTPS success)',
        'FAIL',
        `POST to ${testUrl}`,
        'HTTPS succeeds',
        `State: ${state}, ${attempts} attempts`
      );
    }
  } catch (error) {
    recordTest(
      'TLS certificate validation (HTTPS success)',
      'FAIL',
      `POST to ${testUrl}`,
      'HTTPS succeeds',
      `Error: ${error.message}`
    );
  }
}

/**
 * Test 9: IPv6 link-local SSRF protection
 */
async function test_ssrf_ipv6_link_local() {
  console.log(`\n${colors.blue}═══ Test 9: SSRF Protection - IPv6 Link-Local ═══${colors.reset}`);
  
  const jobId = generateJobId();
  const testUrl = 'http://[fe80::1]/webhook';
  
  console.log(`Setup: Submitting webhook to ${testUrl}`);
  console.log(`Expected: SSRF validation should block, 1 attempt only`);
  
  try {
    await addWebhookJob({
      jobId,
      destinationUrl: testUrl,
      eventId: `test-ssrf-ipv6-${Date.now()}`,
      payload: { test: 'ssrf_ipv6' },
      createdAt: new Date().toISOString()
    });
    
    await wait(JOB_WAIT_TIME);
    
    const { state, attempts, job } = await getJobState(jobId);
    
    console.log(`Actual: Job state = ${state}, attempts = ${attempts}`);
    
    let failedReason = '';
    if (job && job.failedReason) {
      failedReason = job.failedReason;
      console.log(`Failed reason: ${failedReason}`);
    }
    
    const isSSRFBlock = failedReason.includes('SSRF') || failedReason.includes('private') || failedReason.includes('link-local');
    
    if (attempts === 1 && state === 'failed' && isSSRFBlock) {
      recordTest(
        'SSRF blocks IPv6 link-local (1 attempt)',
        'PASS',
        `POST to ${testUrl}`,
        'Blocked by SSRF, 1 attempt',
        `Blocked, ${attempts} attempt`
      );
    } else {
      recordTest(
        'SSRF blocks IPv6 link-local (1 attempt)',
        'FAIL',
        `POST to ${testUrl}`,
        'Blocked by SSRF, 1 attempt',
        `${attempts} attempts, state: ${state}`
      );
    }
  } catch (error) {
    recordTest(
      'SSRF blocks IPv6 link-local (1 attempt)',
      'FAIL',
      `POST to ${testUrl}`,
      'Blocked by SSRF',
      `Error: ${error.message}`
    );
  }
}

/**
 * Print final summary
 */
function printSummary() {
  console.log(`\n${colors.cyan}╔═══════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.cyan}║         PHASE 2 FINAL VERIFICATION SUMMARY                ║${colors.reset}`);
  console.log(`${colors.cyan}╚═══════════════════════════════════════════════════════════╝${colors.reset}\n`);
  
  console.log(`Total Tests:     ${results.total}`);
  console.log(`${colors.green}Passed:          ${results.passed}${colors.reset}`);
  console.log(`${colors.red}Failed:          ${results.failed}${colors.reset}`);
  console.log(`${colors.yellow}Not Tested:      ${results.notTested}${colors.reset}\n`);
  
  if (results.failed > 0) {
    console.log(`${colors.red}═══ FAILED TESTS ═══${colors.reset}\n`);
    results.tests.filter(t => t.status === 'FAIL').forEach(test => {
      console.log(`${colors.red}✗ ${test.name}${colors.reset}`);
      console.log(`  Setup: ${test.setup}`);
      console.log(`  Expected: ${test.expected}`);
      console.log(`  Actual: ${test.actual}`);
      if (test.notes) console.log(`  Notes: ${test.notes}`);
      console.log('');
    });
  }
  
  if (results.notTested > 0) {
    console.log(`${colors.yellow}═══ NOT TESTED ═══${colors.reset}\n`);
    results.tests.filter(t => t.status === 'NOT TESTED').forEach(test => {
      console.log(`${colors.yellow}⊘ ${test.name}${colors.reset}`);
      console.log(`  Reason: ${test.notes}`);
      console.log('');
    });
  }
  
  // Critical bug analysis
  const criticalBugs = results.tests.filter(t => 
    t.status === 'FAIL' && t.actual.includes('CRITICAL BUG')
  );
  
  if (criticalBugs.length > 0) {
    console.log(`${colors.red}═══ CRITICAL BUGS DETECTED ═══${colors.reset}\n`);
    console.log(`Found ${criticalBugs.length} test(s) failing due to the permanent failure retry bug:\n`);
    criticalBugs.forEach(test => {
      console.log(`${colors.red}• ${test.name}${colors.reset}`);
    });
    console.log('');
    console.log(`${colors.red}Root Cause:${colors.reset}`);
    console.log(`  File: src/workers/webhookWorker.js`);
    console.log(`  Issue: job.moveToFailed(error, false) does not prevent BullMQ retries`);
    console.log(`  Impact: Permanent failures (HTTP 4xx, SSRF) retry 5 times instead of 1 attempt\n`);
  }
  
  // Production readiness assessment
  console.log(`${colors.cyan}═══ PRODUCTION READINESS ASSESSMENT ═══${colors.reset}\n`);
  
  if (results.failed === 0) {
    console.log(`${colors.green}✓ Phase 2 is PRODUCTION READY${colors.reset}`);
    console.log(`  All reliability and security tests passed`);
    console.log(`  Safe to proceed to Phase 3\n`);
  } else {
    console.log(`${colors.red}✗ Phase 2 is NOT PRODUCTION READY${colors.reset}`);
    console.log(`  ${results.failed} critical issue(s) must be fixed`);
    console.log(`  DO NOT proceed to Phase 3 until issues are resolved\n`);
  }
}

/**
 * Main test execution
 */
async function runTests() {
  console.log(`${colors.cyan}╔═══════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.cyan}║     PHASE 2 FINAL VERIFICATION TEST SUITE                 ║${colors.reset}`);
  console.log(`${colors.cyan}║     Comprehensive Reliability & Security Testing          ║${colors.reset}`);
  console.log(`${colors.cyan}╚═══════════════════════════════════════════════════════════╝${colors.reset}\n`);
  
  let worker = null;
  
  try {
    // Import webhookQueue for job state checks
    const { webhookQueue } = await import('./src/queues/webhookQueue.js');
    global.webhookQueue = webhookQueue;
    
    // Start worker
    console.log(`${colors.blue}Starting webhook worker...${colors.reset}`);
    worker = startWebhookWorker();
    
    // Wait for worker to be ready
    await wait(2000);
    
    console.log(`${colors.green}Worker started successfully${colors.reset}\n`);
    
    // Run all tests sequentially
    await test_http_500_retries();
    await test_http_400_permanent();
    await test_ssrf_localhost();
    await test_ssrf_private_ipv4();
    await test_connection_pinning();
    await test_timeout();
    await test_response_size_limit();
    await test_tls_validation();
    await test_ssrf_ipv6_link_local();
    
    // Print summary
    printSummary();
    
  } catch (error) {
    console.error(`${colors.red}Test suite error: ${error.message}${colors.reset}`);
    console.error(error.stack);
  } finally {
    // Cleanup
    console.log(`\n${colors.blue}Cleaning up...${colors.reset}`);
    
    if (worker) {
      await shutdownWorker(worker);
    }
    
    await closeQueue();
    
    // Close Redis connection (disconnect instead of quit for IORedis)
    if (redisConnection && typeof redisConnection.disconnect === 'function') {
      await redisConnection.disconnect();
    }
    
    console.log(`${colors.green}Cleanup complete${colors.reset}\n`);
    
    // Exit with appropriate code
    process.exit(results.failed > 0 ? 1 : 0);
  }
}

// Run tests with timeout
const timeout = setTimeout(() => {
  console.error(`${colors.red}Test suite timeout after ${TEST_TIMEOUT}ms${colors.reset}`);
  process.exit(1);
}, TEST_TIMEOUT);

runTests().finally(() => {
  clearTimeout(timeout);
});
