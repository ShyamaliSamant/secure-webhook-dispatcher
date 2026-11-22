#!/usr/bin/env node
/**
 * Redis Integration Test for Phase 1
 * 
 * Tests webhook queue functionality with actual Redis connection attempts.
 * This script simulates the full integration workflow.
 */

import { Queue } from 'bullmq';
import fetch from 'node:http';
import { randomUUID } from 'node:crypto';

const API_BASE_URL = 'http://localhost:5000';
const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10)
};

// Test results tracker
const results = {
  passed: 0,
  failed: 0,
  skipped: 0,
  tests: []
};

function logTest(name, status, details = '') {
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⏭️';
  console.log(`${icon} ${name}`);
  if (details) {
    console.log(`   ${details}`);
  }
  results.tests.push({ name, status, details });
  if (status === 'PASS') results.passed++;
  else if (status === 'FAIL') results.failed++;
  else results.skipped++;
}

async function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 5000,
      path,
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = fetch.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    
    req.end();
  });
}

async function testRedisConnection() {
  console.log('\n🔍 Testing Redis Connection...\n');
  
  try {
    // Try to create a test queue to check Redis connectivity
    const testQueue = new Queue('test-connection', {
      connection: REDIS_CONFIG
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout after 3 seconds'));
      }, 3000);

      testQueue.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      testQueue.client.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    await testQueue.close();
    logTest('Redis Connection', 'PASS', `Connected to ${REDIS_CONFIG.host}:${REDIS_CONFIG.port}`);
    return true;
  } catch (error) {
    logTest('Redis Connection', 'FAIL', `Not available: ${error.message}`);
    return false;
  }
}

async function testHealthEndpoint() {
  console.log('\n🏥 Testing Health Endpoint...\n');
  
  try {
    const response = await makeRequest('GET', '/health');
    
    if (response.status === 200 && response.data.success) {
      logTest('GET /health', 'PASS', 'Status: 200 OK');
      return true;
    } else {
      logTest('GET /health', 'FAIL', `Unexpected response: ${response.status}`);
      return false;
    }
  } catch (error) {
    logTest('GET /health', 'FAIL', error.message);
    return false;
  }
}

async function testWebhookDispatchWithRedis() {
  console.log('\n📤 Testing Webhook Dispatch (Redis Available)...\n');
  
  const testPayload = {
    destinationUrl: 'https://example.com/webhook',
    eventId: 'test-event-' + Date.now(),
    payload: {
      test: 'data',
      timestamp: new Date().toISOString()
    }
  };

  try {
    const response = await makeRequest('POST', '/api/webhooks/dispatch', testPayload);
    
    if (response.status === 202) {
      logTest('POST /api/webhooks/dispatch (Redis UP)', 'PASS', 
        `Status: 202 Accepted, JobID: ${response.data.jobId}`);
      return { success: true, jobId: response.data.jobId };
    } else {
      logTest('POST /api/webhooks/dispatch (Redis UP)', 'FAIL', 
        `Expected 202, got ${response.status}: ${JSON.stringify(response.data)}`);
      return { success: false };
    }
  } catch (error) {
    logTest('POST /api/webhooks/dispatch (Redis UP)', 'FAIL', error.message);
    return { success: false };
  }
}

async function testWebhookDispatchWithoutRedis() {
  console.log('\n📤 Testing Webhook Dispatch (Redis Unavailable)...\n');
  
  const testPayload = {
    destinationUrl: 'https://example.com/webhook',
    eventId: 'test-event-' + Date.now(),
    payload: {
      test: 'data'
    }
  };

  try {
    const response = await makeRequest('POST', '/api/webhooks/dispatch', testPayload);
    
    if (response.status === 503) {
      logTest('POST /api/webhooks/dispatch (Redis DOWN)', 'PASS', 
        'Status: 503 Service Unavailable (expected)');
      return true;
    } else {
      logTest('POST /api/webhooks/dispatch (Redis DOWN)', 'FAIL', 
        `Expected 503, got ${response.status}`);
      return false;
    }
  } catch (error) {
    logTest('POST /api/webhooks/dispatch (Redis DOWN)', 'FAIL', error.message);
    return false;
  }
}

async function testSSRFProtection() {
  console.log('\n🛡️  Testing SSRF Protection...\n');
  
  const privateIPs = [
    'http://127.0.0.1/webhook',
    'http://localhost/webhook',
    'http://10.0.0.1/webhook',
    'http://192.168.1.1/webhook'
  ];

  let allPassed = true;
  
  for (const privateIP of privateIPs) {
    try {
      const response = await makeRequest('POST', '/api/webhooks/dispatch', {
        destinationUrl: privateIP,
        eventId: 'ssrf-test-' + Date.now(),
        payload: { test: 'data' }
      });
      
      if (response.status === 400) {
        logTest(`SSRF Block: ${privateIP}`, 'PASS', 'Status: 400 Bad Request');
      } else {
        logTest(`SSRF Block: ${privateIP}`, 'FAIL', `Expected 400, got ${response.status}`);
        allPassed = false;
      }
    } catch (error) {
      logTest(`SSRF Block: ${privateIP}`, 'FAIL', error.message);
      allPassed = false;
    }
  }
  
  return allPassed;
}

async function verifyJobInQueue(jobId) {
  console.log('\n🔎 Verifying Job in BullMQ Queue...\n');
  
  try {
    const queue = new Queue('webhooks', {
      connection: REDIS_CONFIG
    });

    const job = await queue.getJob(jobId);
    
    if (!job) {
      logTest('Job Retrieval', 'FAIL', `Job ${jobId} not found in queue`);
      await queue.close();
      return false;
    }

    // Verify job data structure
    const requiredFields = ['jobId', 'destinationUrl', 'eventId', 'payload', 'createdAt'];
    const missingFields = requiredFields.filter(field => !(field in job.data));
    
    if (missingFields.length > 0) {
      logTest('Job Data Structure', 'FAIL', `Missing fields: ${missingFields.join(', ')}`);
      await queue.close();
      return false;
    }

    logTest('Job Retrieval', 'PASS', `Job ${jobId} found in queue`);
    logTest('Job Data Structure', 'PASS', 'All required fields present');
    
    // Verify job ID matches
    if (job.id === jobId && job.data.jobId === jobId) {
      logTest('Job ID Consistency', 'PASS', `BullMQ job.id and data.jobId both match: ${jobId}`);
    } else {
      logTest('Job ID Consistency', 'FAIL', 
        `Mismatch: job.id=${job.id}, data.jobId=${job.data.jobId}, returned=${jobId}`);
      await queue.close();
      return false;
    }

    // Log job data (sanitized)
    console.log('\n   Job Data:');
    console.log(`   - JobID: ${job.data.jobId}`);
    console.log(`   - Destination: ${new URL(job.data.destinationUrl).hostname}`);
    console.log(`   - EventID: ${job.data.eventId}`);
    console.log(`   - Payload: ${JSON.stringify(job.data.payload)}`);
    console.log(`   - Created: ${job.data.createdAt}`);

    await queue.close();
    return true;
  } catch (error) {
    logTest('Job Verification', 'FAIL', error.message);
    return false;
  }
}

async function testDuplicateJobID() {
  console.log('\n🔄 Testing Duplicate Job ID Handling...\n');
  
  const duplicateJobId = randomUUID();
  
  try {
    const queue = new Queue('webhooks', {
      connection: REDIS_CONFIG
    });

    // Add first job with specific ID
    const job1 = await queue.add('dispatch-webhook', {
      jobId: duplicateJobId,
      destinationUrl: 'https://example.com/test1',
      eventId: 'dup-test-1',
      payload: { test: 'first' },
      createdAt: new Date().toISOString()
    }, {
      jobId: duplicateJobId
    });

    logTest('First Job Addition', 'PASS', `JobID: ${job1.id}`);

    // Try to add second job with same ID
    try {
      const job2 = await queue.add('dispatch-webhook', {
        jobId: duplicateJobId,
        destinationUrl: 'https://example.com/test2',
        eventId: 'dup-test-2',
        payload: { test: 'second' },
        createdAt: new Date().toISOString()
      }, {
        jobId: duplicateJobId
      });

      // If we get here, check if it's the same job or a new one
      const retrievedJob = await queue.getJob(duplicateJobId);
      
      if (retrievedJob && retrievedJob.data.eventId === 'dup-test-1') {
        logTest('Duplicate Job Prevention', 'PASS', 
          'Second addition reused existing job (deduplication working)');
      } else {
        logTest('Duplicate Job Prevention', 'FAIL', 
          'Duplicate job ID created new job instead of reusing');
      }
    } catch (dupError) {
      if (dupError.message.includes('already exists') || dupError.message.includes('duplicate')) {
        logTest('Duplicate Job Prevention', 'PASS', 'BullMQ rejected duplicate job ID');
      } else {
        logTest('Duplicate Job Prevention', 'FAIL', `Unexpected error: ${dupError.message}`);
      }
    }

    // Clean up
    await job1.remove();
    await queue.close();
    return true;
  } catch (error) {
    logTest('Duplicate Job Test', 'FAIL', error.message);
    return false;
  }
}

async function testRedisURLConfiguration() {
  console.log('\n🔗 Testing REDIS_URL Configuration...\n');
  
  // Test with connection string
  const redisURL = `redis://${REDIS_CONFIG.host}:${REDIS_CONFIG.port}`;
  
  try {
    const queue = new Queue('test-url-config', {
      connection: redisURL // Pass URL string directly
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout'));
      }, 3000);

      queue.client.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });

      queue.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    logTest('REDIS_URL String Format', 'PASS', `Connection string: ${redisURL}`);
    await queue.close();
    return true;
  } catch (error) {
    logTest('REDIS_URL String Format', 'FAIL', error.message);
    return false;
  }
}

async function printSummary() {
  console.log('\n' + '='.repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`✅ Passed: ${results.passed}`);
  console.log(`❌ Failed: ${results.failed}`);
  console.log(`⏭️  Skipped: ${results.skipped}`);
  console.log(`Total: ${results.tests.length}`);
  console.log('='.repeat(60));
  
  if (results.failed > 0) {
    console.log('\n❌ FAILED TESTS:');
    results.tests.filter(t => t.status === 'FAIL').forEach(t => {
      console.log(`   - ${t.name}: ${t.details}`);
    });
  }
  
  console.log('\n');
}

// Main test execution
async function runTests() {
  console.log('='.repeat(60));
  console.log('🧪 PHASE 1 REDIS INTEGRATION TEST');
  console.log('='.repeat(60));
  console.log(`Target API: ${API_BASE_URL}`);
  console.log(`Redis Config: ${REDIS_CONFIG.host}:${REDIS_CONFIG.port}`);
  console.log('='.repeat(60));

  // Check Redis availability
  const redisAvailable = await testRedisConnection();
  
  // Test health endpoint (should work regardless of Redis)
  await testHealthEndpoint();
  
  if (redisAvailable) {
    // Full test suite with Redis
    console.log('\n✅ Redis is available - running full integration tests\n');
    
    // Test REDIS_URL configuration
    await testRedisURLConfiguration();
    
    // Test webhook dispatch
    const dispatchResult = await testWebhookDispatchWithRedis();
    
    if (dispatchResult.success && dispatchResult.jobId) {
      // Verify job in queue
      await verifyJobInQueue(dispatchResult.jobId);
      
      // Test duplicate job ID handling
      await testDuplicateJobID();
    }
    
    // Test SSRF protection
    await testSSRFProtection();
    
  } else {
    // Limited test suite without Redis
    console.log('\n⚠️  Redis is NOT available - running limited tests\n');
    console.log('Note: Install Redis and start redis-server for full integration testing\n');
    
    // Test error handling when Redis is down
    await testWebhookDispatchWithoutRedis();
    
    // SSRF protection should still work
    await testSSRFProtection();
    
    console.log('\n⏭️  Skipped tests (Redis required):');
    console.log('   - Job verification in queue');
    console.log('   - Duplicate job ID handling');
    console.log('   - REDIS_URL configuration');
  }
  
  await printSummary();
  
  // Exit with appropriate code
  process.exit(results.failed > 0 ? 1 : 0);
}

// Start tests
runTests().catch(error => {
  console.error('\n❌ Test execution failed:', error);
  process.exit(1);
});
