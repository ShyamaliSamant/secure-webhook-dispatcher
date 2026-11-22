# Phase 2: Webhook Worker Implementation Plan

**Date:** 2026-11-21  
**Phase:** Worker Process with Secure HTTP Delivery  
**Status:** ✅ IMPLEMENTATION COMPLETE - READY FOR TESTING  
**Last Updated:** 2026-11-21  

---

## Table of Contents

1. [Existing Architecture Analysis](#existing-architecture-analysis)
2. [Phase 2 Requirements](#phase-2-requirements)
3. [Worker Architecture Design](#worker-architecture-design)
4. [Security Design](#security-design)
5. [HTTP Delivery Implementation](#http-delivery-implementation)
6. [Error Handling & Retry Strategy](#error-handling--retry-strategy)
7. [Configuration & Environment](#configuration--environment)
8. [File Structure](#file-structure)
9. [Implementation Steps](#implementation-steps)
10. [Testing Strategy](#testing-strategy)
11. [Security Risks & Mitigations](#security-risks--mitigations)
12. [Unresolved Design Decisions](#unresolved-design-decisions)

---

## Existing Architecture Analysis

### Current Dependencies (package.json)

```json
{
  "dependencies": {
    "bullmq": "^6.7.8",      // BullMQ for job queue
    "dotenv": "^18.0.10",     // Environment variables
    "express": "^5.3.0",      // API server
    "ioredis": "^6.0.0"       // Redis client
  }
}
```

**Analysis:** All required dependencies for Worker are already installed. No new packages needed for basic HTTP delivery (using Node.js built-in `http`/`https` modules).

---

### Existing Queue Configuration

**File:** `src/queues/webhookQueue.js`

**Current Setup:**
```javascript
export const webhookQueue = new Queue('webhooks', {
  connection: redisConnection,  // From src/config/redis.js
  defaultJobOptions: {
    attempts: 5,                 // Retry up to 5 times
    backoff: {
      type: 'exponential',
      delay: 2000               // Start with 2s, doubles each retry
    },
    removeOnComplete: {
      age: 86400,               // 24 hours
      count: 1000
    },
    removeOnFail: {
      age: 604800               // 7 days
    }
  }
});
```

**Key Points:**
- Queue name: `'webhooks'`
- Job name: `'dispatch-webhook'` (from addWebhookJob)
- ✅ Retry strategy already configured (5 attempts, exponential backoff)
- ✅ Job retention configured

**Worker Requirements:**
- Must connect to same queue name: `'webhooks'`
- Must process job name: `'dispatch-webhook'`
- Must handle retry logic (BullMQ handles this automatically)

---

### Existing Redis Configuration

**File:** `src/config/redis.js`

**Current Implementation:**
```javascript
export function getRedisConnection() {
  if (process.env.REDIS_URL) {
    return process.env.REDIS_URL;  // URL string
  }
  
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: 3,  // ⚠️ ONLY FOR QUEUE PRODUCER
    enableReadyCheck: true,
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      if (times > 10) return null;
      return delay;
    }
  };
}
```

**⚠️ CRITICAL:** The current config has `maxRetriesPerRequest: 3`, which is appropriate for Queue producers (API process) but **INCORRECT for BullMQ Workers**.

**BullMQ Worker Requirement:**
Workers MUST use `maxRetriesPerRequest: null` to prevent command failures during long-running operations.

**Solution:** Create separate Worker-specific Redis configuration.

---

### Job Data Structure

**From Phase 1 Testing:**
```javascript
{
  "jobId": "uuid-v4",
  "destinationUrl": "https://example.com/webhook",
  "eventId": "user-provided-event-id",
  "payload": {
    // User-provided JSON object
  },
  "createdAt": "2026-11-21T10:00:00.000Z"
}
```

**Worker Processing Requirements:**
1. Extract `destinationUrl` for HTTP delivery
2. Extract `payload` for HTTP request body
3. Use `jobId` for logging/tracking
4. Use `eventId` for correlation
5. Do NOT log sensitive payload data

---

### SSRF Protection Utilities

**File:** `src/utils/ssrfProtection.js`

**Available Functions:**

1. **`isPrivateOrLoopbackIP(ip)`**
   - Checks if IP is private/loopback/reserved
   - Supports IPv4 and IPv6
   - Handles IPv4-mapped IPv6 addresses
   - Returns `true` if IP is non-public

2. **`dnsLookupWithTimeout(hostname, timeout)`**
   - Performs DNS resolution with timeout (default 5s)
   - Returns array of `{address, family}` objects
   - Throws on timeout or DNS failure

3. **`validateDestinationUrl(destinationUrl)`**
   - Full URL validation
   - DNS resolution and IP checking
   - Returns `{valid: boolean, error?: string}`

**Worker Usage:**
- ✅ Must call `validateDestinationUrl()` before EVERY HTTP request
- ✅ This provides DNS rebinding / TOCTOU protection
- ✅ Validates ALL resolved IP addresses

---

### Environment Variables

**From `.env.example`:**
```env
# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_URL=

# Worker (already defined)
WORKER_CONCURRENCY=5
WEBHOOK_TIMEOUT=30000
MAX_RESPONSE_SIZE=1048576
```

**Analysis:**
- ✅ Worker configuration already present
- ✅ Timeout: 30 seconds (30000ms)
- ✅ Response limit: 1MB (1048576 bytes)
- ✅ Concurrency: 5 workers

**No .env modifications needed.**

---

## Phase 2 Requirements

### Core Requirements

1. **Separate Worker Process**
   - Independent Node.js process (not embedded in API)
   - Uses BullMQ Worker to consume jobs
   - Processes jobs from "webhooks" queue

2. **Secure HTTP Delivery**
   - POST request with JSON payload
   - Content-Type: application/json
   - Uses Node.js built-in `http`/`https` modules

3. **DNS Rebinding / TOCTOU Protection**
   - Re-validate URL at delivery time
   - Resolve ALL DNS A/AAAA records
   - Reject if ANY resolved IP is private/loopback
   - Pin HTTP connection to validated IP address

4. **Connection Pinning**
   - Custom DNS lookup callback
   - Explicitly connect to validated IP
   - Preserve hostname for TLS SNI and Host header
   - Prevent automatic DNS resolution by HTTP client

5. **Request Configuration**
   - Timeout: 30 seconds (configurable)
   - Response size limit: 1MB (configurable)
   - Redirects: DISABLED
   - Method: POST
   - Content-Type: application/json

6. **Error Handling**
   - Never retry SSRF validation failures
   - Retry network errors (BullMQ handles this)
   - Log errors without exposing sensitive data
   - Mark jobs as failed appropriately

7. **Graceful Shutdown**
   - Handle SIGTERM/SIGINT
   - Wait for active jobs to complete
   - Close Redis connections cleanly

---

## Worker Architecture Design

### Process Structure

```
┌─────────────────────────────────────────┐
│         API Process (server.js)         │
│  - Express API                          │
│  - Validation Middleware                │
│  - BullMQ Queue (Producer)              │
│  - Adds jobs to Redis                   │
└─────────────┬───────────────────────────┘
              │
              │ Redis
              ▼
┌─────────────────────────────────────────┐
│            Redis / Memurai              │
│  - Job Queue: "webhooks"                │
│  - Job Data Storage                     │
│  - Job State Management                 │
└─────────────┬───────────────────────────┘
              │
              │ Consume Jobs
              ▼
┌─────────────────────────────────────────┐
│      Worker Process (worker.js)         │
│  - BullMQ Worker (Consumer)             │
│  - SSRF Re-validation                   │
│  - DNS Resolution & Pinning             │
│  - HTTP POST Delivery                   │
│  - Error Handling & Logging             │
└─────────────────────────────────────────┘
```

### Worker Initialization Flow

```
1. Load environment variables (dotenv)
2. Create Worker-specific Redis config (maxRetriesPerRequest: null)
3. Initialize BullMQ Worker
   - Connect to 'webhooks' queue
   - Set concurrency (WORKER_CONCURRENCY)
   - Register job processor
4. Set up error handlers
5. Set up graceful shutdown handlers (SIGTERM, SIGINT)
6. Start processing jobs
```

### Job Processing Flow

```
Job Received from Queue
  │
  ├─→ [1] Extract job data (destinationUrl, payload, jobId, eventId)
  │
  ├─→ [2] Re-validate destinationUrl (SSRF check)
  │     ├─ Parse URL
  │     ├─ Check protocol (http/https only)
  │     ├─ Check for credentials (reject)
  │     ├─ Check hostname (reject localhost, metadata endpoints)
  │     ├─ Resolve DNS (ALL A/AAAA records)
  │     └─ Check ALL IPs (reject if ANY is private)
  │
  ├─→ [3] If validation fails:
  │     ├─ Log error (sanitized)
  │     ├─ Mark job as FAILED (permanent)
  │     └─ DO NOT RETRY
  │
  ├─→ [4] If validation passes:
  │     ├─ Select validated IP (first public IP)
  │     ├─ Create HTTP request with custom lookup
  │     ├─ lookup() returns validated IP
  │     ├─ Preserve hostname for SNI/Host header
  │     └─ Send POST with JSON payload
  │
  ├─→ [5] Handle HTTP response:
  │     ├─ 2xx: SUCCESS → Mark job complete
  │     ├─ 3xx: Redirect → FAIL (redirects disabled)
  │     ├─ 4xx: Client error → FAIL (no retry)
  │     ├─ 5xx: Server error → FAIL with retry (BullMQ handles)
  │     └─ Network error → FAIL with retry
  │
  └─→ [6] Cleanup and return
```

---

## Security Design

### SSRF Protection Layers

**Layer 1: Ingestion-Time Validation (Existing)**
- API middleware validates URL before queuing
- Provides early feedback to user
- ✅ Already implemented

**Layer 2: Delivery-Time Re-validation (Phase 2 - NEW)**
- Worker re-validates URL before HTTP request
- Protects against DNS rebinding
- Validates ALL resolved IP addresses
- ✅ **CRITICAL:** This is the defense against TOCTOU attacks

**Layer 3: Connection Pinning (Phase 2 - NEW)**
- HTTP client connects to validated IP explicitly
- Prevents automatic DNS resolution during request
- Uses custom `lookup()` callback
- Preserves hostname for TLS verification

### DNS Rebinding / TOCTOU Protection

**Attack Scenario Without Protection:**
```
1. User submits: https://evil.com/webhook
2. API validation time:
   - evil.com → 1.2.3.4 (public IP) ✅ PASSES
3. Job queued
4. Attacker changes DNS: evil.com → 192.168.1.1 (private)
5. Worker delivery time:
   - evil.com → 192.168.1.1 ❌ SSRF!
```

**Protection Strategy:**
```
1. User submits: https://evil.com/webhook
2. API validation: evil.com → 1.2.3.4 ✅
3. Job queued
4. Worker re-validates: evil.com → ? (resolve again)
5. If ANY resolved IP is private → REJECT
6. If all IPs are public → Connect to first public IP
7. Preserve hostname for TLS/SNI
```

**Implementation:**
```javascript
// Worker job processor
async function processWebhook(job) {
  const { destinationUrl, payload } = job.data;
  
  // STEP 1: Re-validate at delivery time
  const validation = await validateDestinationUrl(destinationUrl);
  
  if (!validation.valid) {
    // SSRF detected - PERMANENT FAILURE
    throw new Error(`SSRF validation failed: ${validation.error}`);
  }
  
  // STEP 2: Resolve DNS and get validated IPs
  const parsedUrl = new URL(destinationUrl);
  const addresses = await dnsLookupAll(parsedUrl.hostname, { all: true });
  
  // STEP 3: Filter to public IPs only
  const publicIPs = addresses.filter(addr => !isPrivateOrLoopbackIP(addr.address));
  
  if (publicIPs.length === 0) {
    throw new Error('No public IP addresses found');
  }
  
  // STEP 4: Pin connection to first public IP
  const targetIP = publicIPs[0].address;
  
  // STEP 5: HTTP request with pinned IP
  await sendWebhook(destinationUrl, payload, targetIP);
}
```

### Connection Pinning Implementation

**Goal:** Force HTTP client to connect to our validated IP, not perform its own DNS lookup.

**Method:** Custom `lookup()` callback in `http.request()` options

**Node.js http.request() Behavior:**
- By default, resolves hostname automatically
- We override with custom lookup function
- Our lookup returns pre-validated IP
- Connection goes to that IP only

**Code Pattern:**
```javascript
const options = {
  hostname: parsedUrl.hostname,  // Original hostname (for TLS SNI)
  port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
  path: parsedUrl.pathname + parsedUrl.search,
  method: 'POST',
  headers: {
    'Host': parsedUrl.hostname,  // Original hostname for Host header
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(jsonPayload),
    'User-Agent': 'WebhookDispatcher/1.0'
  },
  timeout: WEBHOOK_TIMEOUT,
  
  // CRITICAL: Custom lookup pins connection to validated IP
  lookup: (hostname, options, callback) => {
    // Ignore hostname, return our validated IP
    callback(null, pinnedIP, pinnedFamily);
  }
};

const client = parsedUrl.protocol === 'https:' ? https : http;
const req = client.request(options, handleResponse);
```

**Why This Works:**
- TLS certificate verification uses `hostname` (not IP)
- Host header uses `hostname` (not IP)
- Actual TCP connection uses IP from `lookup()`
- No additional DNS resolution performed

---

## HTTP Delivery Implementation

### Request Configuration

```javascript
const WEBHOOK_TIMEOUT = parseInt(process.env.WEBHOOK_TIMEOUT || '30000', 10);
const MAX_RESPONSE_SIZE = parseInt(process.env.MAX_RESPONSE_SIZE || '1048576', 10);

const requestOptions = {
  hostname: originalHostname,  // For SNI/Host
  port: port,
  path: path,
  method: 'POST',
  headers: {
    'Host': originalHostname,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(jsonPayload),
    'User-Agent': 'WebhookDispatcher/1.0'
  },
  timeout: WEBHOOK_TIMEOUT,
  
  // Disable redirects (Node.js doesn't follow by default, but be explicit)
  maxRedirects: 0,
  
  // Custom lookup for connection pinning
  lookup: (hostname, opts, callback) => {
    callback(null, pinnedIP, pinnedFamily);
  }
};
```

### Request Body

```javascript
// Prepare JSON payload
const jsonPayload = JSON.stringify(job.data.payload);

// Validate payload size (optional)
if (jsonPayload.length > MAX_RESPONSE_SIZE) {
  throw new Error('Payload exceeds maximum size');
}
```

### Response Handling

```javascript
req.on('response', (res) => {
  // Track response size
  let receivedBytes = 0;
  let responseBody = '';
  
  res.on('data', (chunk) => {
    receivedBytes += chunk.length;
    
    // Enforce response size limit
    if (receivedBytes > MAX_RESPONSE_SIZE) {
      req.destroy();
      reject(new Error('Response size exceeds limit'));
      return;
    }
    
    responseBody += chunk.toString();
  });
  
  res.on('end', () => {
    // Success: 2xx status codes
    if (res.statusCode >= 200 && res.statusCode < 300) {
      resolve({
        statusCode: res.statusCode,
        success: true
      });
    }
    // Client error: 4xx (permanent failure, no retry)
    else if (res.statusCode >= 400 && res.statusCode < 500) {
      reject(new Error(`HTTP ${res.statusCode}: Client error (no retry)`));
    }
    // Server error: 5xx (temporary failure, allow retry)
    else if (res.statusCode >= 500) {
      reject(new Error(`HTTP ${res.statusCode}: Server error (will retry)`));
    }
    // Redirect: 3xx (not supported)
    else if (res.statusCode >= 300 && res.statusCode < 400) {
      reject(new Error(`HTTP ${res.statusCode}: Redirects not supported`));
    }
    else {
      reject(new Error(`HTTP ${res.statusCode}: Unexpected status`));
    }
  });
});
```

### Timeout Handling

```javascript
req.on('timeout', () => {
  req.destroy();
  reject(new Error('Request timeout'));
});

req.on('error', (error) => {
  reject(error);
});
```

---

## Error Handling & Retry Strategy

### Error Classification

**Permanent Failures (No Retry):**
1. **SSRF Validation Failure**
   - URL validation failed at delivery time
   - DNS rebinding detected
   - Private IP detected
   - Action: Mark job as permanently failed

2. **HTTP 4xx Client Errors**
   - 400 Bad Request
   - 401 Unauthorized
   - 403 Forbidden
   - 404 Not Found
   - Action: Mark job as permanently failed

3. **Invalid Job Data**
   - Missing destinationUrl
   - Invalid payload structure
   - Action: Mark job as permanently failed

**Temporary Failures (Allow Retry):**
1. **Network Errors**
   - ECONNREFUSED
   - ETIMEDOUT
   - ENOTFOUND (DNS failure)
   - EHOSTUNREACH
   - Action: Throw error, BullMQ retries

2. **HTTP 5xx Server Errors**
   - 500 Internal Server Error
   - 502 Bad Gateway
   - 503 Service Unavailable
   - 504 Gateway Timeout
   - Action: Throw error, BullMQ retries

3. **Timeout**
   - Request timeout (30s)
   - Action: Throw error, BullMQ retries

### BullMQ Retry Behavior

**Automatic Retry:** BullMQ automatically retries jobs based on configuration:
- Attempts: 5 (from Phase 1 config)
- Backoff: Exponential, 2000ms initial delay
- Schedule: 2s, 4s, 8s, 16s

**Worker Implementation:**
```javascript
// Permanent failure
throw new Error('SSRF validation failed'); // ← BullMQ will retry!

// Solution: Use job.moveToFailed() for permanent failures
await job.moveToFailed(new Error('SSRF validation failed'), false);
```

**⚠️ IMPORTANT:** For permanent failures (SSRF, 4xx), we must explicitly mark the job as failed and prevent retries.

### Logging Strategy

**Safe Logging (What to Log):**
- ✅ Job ID
- ✅ Event ID
- ✅ Destination hostname (not full URL with query params)
- ✅ HTTP status code
- ✅ Error type/message (sanitized)
- ✅ Retry attempt number

**Unsafe Logging (What NOT to Log):**
- ❌ Full destination URL (may contain secrets in query params)
- ❌ Payload data (may contain PII, secrets)
- ❌ Authorization headers
- ❌ Response body (may contain sensitive data)
- ❌ Redis passwords

**Example Logging:**
```javascript
// ✅ GOOD
console.log(`Job ${job.id}: Delivering to ${hostname}, attempt ${job.attemptsMade + 1}/${job.opts.attempts}`);
console.log(`Job ${job.id}: Delivery successful, HTTP ${statusCode}`);
console.error(`Job ${job.id}: Delivery failed, ${error.message}`);

// ❌ BAD
console.log(`Delivering to ${destinationUrl}`); // May contain secrets
console.log(`Payload: ${JSON.stringify(payload)}`); // May contain PII
console.log(`Response: ${responseBody}`); // May contain sensitive data
```

---

## Configuration & Environment

### Worker-Specific Redis Configuration

**New Function Needed:**
```javascript
// src/config/redis.js

/**
 * Get Redis connection configuration for BullMQ Worker
 * CRITICAL: Workers MUST use maxRetriesPerRequest: null
 */
export function getWorkerRedisConnection() {
  if (process.env.REDIS_URL) {
    // For URL string, we need to return config object to set maxRetriesPerRequest
    return {
      // Parse URL manually or return object with additional options
      // BullMQ Worker will handle URL parsing
      host: parseRedisURL(process.env.REDIS_URL).host,
      port: parseRedisURL(process.env.REDIS_URL).port,
      password: parseRedisURL(process.env.REDIS_URL).password,
      maxRetriesPerRequest: null,  // REQUIRED for Worker
      enableReadyCheck: false,     // Recommended for Worker
    };
  }
  
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,  // REQUIRED for Worker
    enableReadyCheck: false,     // Recommended for Worker
  };
}
```

### Environment Variables

**No changes to .env needed.**

**Usage in Worker:**
```javascript
import { getWorkerRedisConnection } from './src/config/redis.js';

const workerConfig = {
  connection: getWorkerRedisConnection(),
  concurrency: parseInt(process.env.WORKER_CONCURRENCY || '5', 10)
};
```

---

## File Structure

### New Files to Create

```
src/
├── config/
│   └── redis.js                    # ADD: getWorkerRedisConnection()
├── workers/
│   ├── webhookWorker.js           # NEW: Main worker process
│   └── deliveryService.js         # NEW: HTTP delivery logic
└── utils/
    └── ssrfProtection.js          # EXISTING: No changes needed

worker.js                           # NEW: Worker entry point (root level)
```

### File Responsibilities

**`worker.js`** (Root Level)
- Entry point for worker process
- Initialize environment (dotenv)
- Import and start webhook worker
- Handle uncaught errors
- Graceful shutdown

**`src/workers/webhookWorker.js`**
- Initialize BullMQ Worker
- Register job processor
- Configure concurrency
- Set up event handlers (completed, failed, error)
- Graceful shutdown logic

**`src/workers/deliveryService.js`**
- SSRF re-validation
- DNS resolution and IP filtering
- HTTP request with connection pinning
- Response handling
- Error handling

**`src/config/redis.js`** (Modify)
- Add `getWorkerRedisConnection()` function
- Export both queue and worker configs

---

## Implementation Steps

### Step 1: Update Redis Configuration
1. Add `getWorkerRedisConnection()` to `src/config/redis.js`
2. Set `maxRetriesPerRequest: null` for worker
3. Handle both REDIS_URL and individual config

### Step 2: Create Delivery Service
1. Create `src/workers/deliveryService.js`
2. Implement SSRF re-validation
3. Implement DNS resolution and IP filtering
4. Implement connection pinning with custom lookup
5. Implement HTTP POST delivery
6. Implement response handling
7. Add comprehensive error handling

### Step 3: Create Worker Process
1. Create `src/workers/webhookWorker.js`
2. Initialize BullMQ Worker with worker Redis config
3. Register job processor calling delivery service
4. Add event handlers (completed, failed, error)
5. Implement graceful shutdown

### Step 4: Create Worker Entry Point
1. Create `worker.js` at root level
2. Load environment variables
3. Import and start webhook worker
4. Handle process signals (SIGTERM, SIGINT)

### Step 5: Update Package Scripts
1. Verify `npm run worker` script exists
2. Verify `npm run worker:dev` script exists
3. Update if needed (already exist from Phase 1)

### Step 6: Testing
1. Start Redis/Memurai
2. Start API server: `npm start`
3. Start worker: `npm run worker`
4. Submit webhook via API
5. Verify delivery occurs
6. Test error scenarios

---

## Testing Strategy

### Unit Tests (Future)

1. **Delivery Service Tests**
   - SSRF re-validation
   - DNS resolution filtering
   - Connection pinning logic
   - HTTP response handling
   - Error classification

2. **Worker Tests**
   - Job processing flow
   - Retry behavior
   - Graceful shutdown

### Integration Tests

1. **Happy Path**
   - Submit webhook → verify delivery
   - Check HTTP status 200-299 → job completes

2. **SSRF Protection**
   - Submit valid URL → changes to private IP → delivery fails
   - Private IP at delivery time → permanent failure

3. **Error Handling**
   - 4xx response → permanent failure, no retry
   - 5xx response → temporary failure, retries
   - Timeout → temporary failure, retries
   - Network error → temporary failure, retries

4. **Retry Behavior**
   - First failure → retry after 2s
   - Second failure → retry after 4s
   - Continue through 5 attempts
   - After 5 attempts → move to failed queue

5. **Graceful Shutdown**
   - Send SIGTERM → worker finishes current jobs → exits cleanly

### Manual Testing Checklist

- [ ] Worker connects to Redis
- [ ] Worker processes jobs from queue
- [ ] HTTP POST delivery works
- [ ] SSRF re-validation works
- [ ] Connection pinning works (verify in logs)
- [ ] Timeout handling works
- [ ] Retry on 5xx works
- [ ] No retry on 4xx works
- [ ] No retry on SSRF failure works
- [ ] Graceful shutdown works
- [ ] Multiple workers work concurrently
- [ ] Logs don't contain sensitive data

---

## Security Risks & Mitigations

### Risk 1: DNS Rebinding / TOCTOU

**Risk:** Attacker changes DNS between validation and delivery

**Mitigation:** ✅ Re-validate URL at delivery time before HTTP request

**Status:** ADDRESSED in design

---

### Risk 2: Connection Not Pinned

**Risk:** HTTP client performs own DNS lookup, bypassing our validation

**Mitigation:** ✅ Custom `lookup()` callback returns validated IP only

**Status:** ADDRESSED in design

---

### Risk 3: Redirects to Private IPs

**Risk:** Public endpoint redirects to private IP (e.g., http://public.com → http://192.168.1.1)

**Mitigation:** ✅ Disable redirects completely

**Status:** ADDRESSED in design (redirects disabled, 3xx treated as failure)

---

### Risk 4: IPv6 Bypass

**Risk:** Attacker uses IPv6 to bypass IPv4-only validation

**Mitigation:** ✅ `isPrivateOrLoopbackIP()` validates both IPv4 and IPv6

**Status:** ADDRESSED (existing SSRF protection handles IPv6)

---

### Risk 5: Sensitive Data in Logs

**Risk:** Webhook payloads, URLs with secrets, responses logged

**Mitigation:** ✅ Log only job ID, hostname, status codes, sanitized errors

**Status:** ADDRESSED in design

---

### Risk 6: Response Body Attacks

**Risk:** Large response body causes memory exhaustion

**Mitigation:** ✅ Enforce MAX_RESPONSE_SIZE (1MB), destroy connection if exceeded

**Status:** ADDRESSED in design

---

### Risk 7: Slow Loris / Timeout Attacks

**Risk:** Slow responses tie up workers

**Mitigation:** ✅ 30-second timeout, worker concurrency limit (5)

**Status:** ADDRESSED in design

---

### Risk 8: TLS Certificate Validation Bypass

**Risk:** Connection pinning might break TLS verification

**Mitigation:** ✅ Preserve original hostname for SNI, Node.js validates cert against hostname

**Status:** ADDRESSED (hostname in options, IP in lookup)

---

## Unresolved Design Decisions

### Decision 1: Worker Auto-Restart

**Question:** Should worker automatically restart on crash?

**Options:**
1. Use process manager (PM2, systemd) - RECOMMENDED
2. Built-in restart logic
3. Manual restart required

**Recommendation:** Use PM2 or systemd (out of scope for Phase 2)

**Status:** ⚠️ DEFERRED - Document in deployment guide

---

### Decision 2: Job Result Storage

**Question:** Should we store delivery results (status, response) back to a database?

**Options:**
1. Store results in separate table/collection
2. Use BullMQ's completed jobs storage (24 hour retention)
3. No storage, logs only

**Recommendation:** Use BullMQ's built-in storage for now (already configured, 24h retention)

**Status:** ⚠️ DEFERRED - Future enhancement

---

### Decision 3: Delivery Metrics/Monitoring

**Question:** Should we track delivery success rate, latency, etc.?

**Options:**
1. Export metrics (Prometheus, StatsD)
2. Log-based monitoring
3. No metrics

**Recommendation:** Start with log-based monitoring, add metrics later

**Status:** ⚠️ DEFERRED - Future enhancement

---

### Decision 4: Multiple Worker Instances

**Question:** How to scale workers horizontally?

**Options:**
1. Multiple processes on same machine (PM2)
2. Multiple machines/containers
3. Single worker only

**Recommendation:** Design supports multiple workers (BullMQ handles coordination)

**Status:** ✅ SUPPORTED - No code changes needed

---

### Decision 5: Dead Letter Queue

**Question:** What happens to permanently failed jobs after 5 attempts?

**Options:**
1. Move to separate "dead-letter" queue for investigation
2. Delete after 7 days (current config)
3. Keep indefinitely

**Recommendation:** Use BullMQ's failed queue (7-day retention configured)

**Status:** ✅ ALREADY CONFIGURED - Monitor failed queue manually

---

### Decision 6: Webhook Signature/Authentication

**Question:** Should worker sign outbound requests (HMAC, JWT)?

**Options:**
1. Add signature header (HMAC-SHA256)
2. Add JWT in Authorization header
3. No authentication (rely on TLS only)

**Recommendation:** No authentication for Phase 2 (user can add their own auth in payload)

**Status:** ⚠️ DEFERRED - Future enhancement

---

### Decision 7: Custom Lookup Options Callback

**Question:** The custom lookup callback signature - should we handle both callback styles?

**Node.js supports two callback signatures:**
```javascript
// Style 1: (err, address, family)
callback(null, '1.2.3.4', 4);

// Style 2: (err, addresses) - when options.all = true
callback(null, [{address: '1.2.3.4', family: 4}]);
```

**Recommendation:** Use Style 1 (simpler, we're pinning to single IP)

**Status:** ✅ DECIDED - Use Style 1

---

## Implementation Risks

### Risk 1: Worker Doesn't Pick Up Jobs

**Symptom:** Jobs stay in "waiting" state

**Possible Causes:**
- Worker not running
- Redis connection failed
- Wrong queue name
- maxRetriesPerRequest not null

**Mitigation:** Add connection success logs, verify queue name matches

---

### Risk 2: Jobs Retry When They Shouldn't

**Symptom:** SSRF failures retry 5 times

**Cause:** Not using `job.moveToFailed()` for permanent failures

**Mitigation:** Use `job.moveToFailed(error, false)` for SSRF and 4xx errors

---

### Risk 3: Connection Pinning Doesn't Work

**Symptom:** DNS rebinding still succeeds

**Cause:** Custom lookup not called, or lookup signature wrong

**Mitigation:** Add logging in lookup callback, verify IP in logs

---

### Risk 4: TLS Validation Fails

**Symptom:** HTTPS requests fail with certificate errors

**Cause:** Hostname not preserved for SNI

**Mitigation:** Ensure `hostname` option set to original hostname, not IP

---

### Risk 5: Worker Memory Leak

**Symptom:** Worker memory grows over time

**Cause:** Response bodies not released, listeners not cleaned up

**Mitigation:** Destroy request on errors, remove event listeners

---

## Dependencies Analysis

### Required Dependencies

**All dependencies already installed:**
- ✅ `bullmq` - Worker implementation
- ✅ `ioredis` - Redis connection (used by BullMQ)
- ✅ `dotenv` - Environment variables

**Node.js Built-in Modules (No Installation):**
- ✅ `http` - HTTP requests
- ✅ `https` - HTTPS requests
- ✅ `dns` - DNS resolution (already used in SSRF protection)
- ✅ `net` - IP validation (already used in SSRF protection)

**No new dependencies needed for Phase 2.**

---

## Configuration Summary

### Redis Configuration Changes

**File:** `src/config/redis.js`

**New Function:**
```javascript
export function getWorkerRedisConnection() {
  // Returns config with maxRetriesPerRequest: null
}
```

### Environment Variables

**No changes to .env needed.**

**Variables Used:**
- `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` / `REDIS_URL`
- `WORKER_CONCURRENCY` (default: 5)
- `WEBHOOK_TIMEOUT` (default: 30000ms)
- `MAX_RESPONSE_SIZE` (default: 1048576 bytes)

### Package.json Scripts

**Already configured in Phase 1:**
```json
{
  "scripts": {
    "worker": "node worker.js",
    "worker:dev": "nodemon worker.js"
  }
}
```

**No changes needed.**

---

## Deployment Considerations

### Running Worker in Production

**Option 1: PM2 (Recommended)**
```bash
pm2 start worker.js -i 5  # 5 worker instances
pm2 start server.js        # API server
```

**Option 2: Systemd**
```ini
[Unit]
Description=Webhook Worker
After=network.target redis.service

[Service]
Type=simple
User=webhook
WorkingDirectory=/app
ExecStart=/usr/bin/node worker.js
Restart=always

[Install]
WantedBy=multi-user.target
```

**Option 3: Docker**
```dockerfile
# Separate worker container
CMD ["node", "worker.js"]
```

### Monitoring

**Key Metrics to Monitor:**
- Queue depth (waiting jobs)
- Failed jobs count
- Worker process health
- Redis connection status
- Delivery success rate (from logs)

**Logging:**
- Worker logs to stdout/stderr
- Collect with logging agent (Fluentd, Logstash)
- Alert on error patterns

---

## Success Criteria

Phase 2 is complete when:

- [ ] Worker process starts successfully
- [ ] Worker connects to Redis/Memurai
- [ ] Worker processes jobs from "webhooks" queue
- [ ] SSRF re-validation works at delivery time
- [ ] DNS resolution and IP filtering works
- [ ] Connection pinning prevents automatic DNS lookup
- [ ] HTTP POST delivery with JSON payload works
- [ ] Response status handling works (2xx=success, 4xx=fail, 5xx=retry)
- [ ] Timeout handling works (30s)
- [ ] Response size limit works (1MB)
- [ ] Retry logic works (exponential backoff, 5 attempts)
- [ ] Permanent failures (SSRF, 4xx) don't retry
- [ ] Temporary failures (5xx, network) retry correctly
- [ ] Logs don't contain sensitive data
- [ ] Graceful shutdown works (SIGTERM/SIGINT)
- [ ] Multiple workers can run concurrently
- [ ] End-to-end test: API → Queue → Worker → HTTP delivery succeeds

---

## Next Steps

1. ✅ Review this plan
2. ⏭️ Implement Step 1: Update Redis configuration
3. ⏭️ Implement Step 2: Create delivery service
4. ⏭️ Implement Step 3: Create worker process
5. ⏭️ Implement Step 4: Create worker entry point
6. ⏭️ Test with real HTTP endpoints
7. ⏭️ Verify SSRF protection with malicious URLs
8. ⏭️ Load test with multiple workers
9. ⏭️ Document deployment and operations

---

## Conclusion

This plan provides a comprehensive design for Phase 2 Worker implementation with:

- ✅ Secure SSRF protection (re-validation + connection pinning)
- ✅ DNS rebinding / TOCTOU protection
- ✅ Proper error handling and retry logic
- ✅ Safe logging (no sensitive data)
- ✅ Graceful shutdown
- ✅ Scalability (multiple workers supported)
- ✅ No new dependencies required

**Ready for Implementation:** Yes, pending review and approval.

**Security Posture:** Strong - multiple layers of SSRF protection, connection pinning, no redirect following.

**Operational Readiness:** Good - graceful shutdown, error handling, logging, configurable timeouts.

**Scalability:** Excellent - BullMQ handles distributed workers automatically.

---

**Plan Status:** 📋 READY FOR REVIEW  
**Implementation Status:** ⏳ NOT STARTED  
**Estimated Complexity:** MEDIUM  
**Estimated Lines of Code:** ~500-700 lines  
**Estimated Time:** 4-6 hours implementation + 2-4 hours testing
