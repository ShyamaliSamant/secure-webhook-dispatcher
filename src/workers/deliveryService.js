import http from 'http';
import https from 'https';
import dns from 'dns';
import { promisify } from 'util';
import { validateDestinationUrl, isPrivateOrLoopbackIP } from '../utils/ssrfProtection.js';
import { createLogger, sanitizeUrl } from '../utils/logger.js';

const dnsLookupAll = promisify(dns.lookup);

// Delivery service logger
const deliveryLogger = createLogger({ component: 'delivery' });

// Configuration from environment
const WEBHOOK_TIMEOUT = parseInt(process.env.WEBHOOK_TIMEOUT || '30000', 10);
const MAX_RESPONSE_SIZE = parseInt(process.env.MAX_RESPONSE_SIZE || '1048576', 10);

export function executeWebhookRequest({
  client,
  requestOptions,
  jsonPayload,
  maxResponseSize = MAX_RESPONSE_SIZE,
  timeout = WEBHOOK_TIMEOUT,
  startTime = Date.now(),
  jobLogger = deliveryLogger
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = client.request({ ...requestOptions, timeout }, (res) => {
      let receivedBytes = 0;

      res.on('data', (chunk) => {
        receivedBytes += chunk.length;

        if (receivedBytes > maxResponseSize) {
          jobLogger.warn({
            receivedBytes,
            maxSize: maxResponseSize
          }, 'Response size limit exceeded');

          const error = new Error(`Response size exceeds limit of ${maxResponseSize} bytes`);
          error.code = 'RESPONSE_SIZE_LIMIT';
          res.destroy();
          req.destroy();
          settleReject(error);
        }
      });

      res.on('end', () => {
        if (settled) return;

        const statusCode = res.statusCode;
        const duration = Date.now() - startTime;

        jobLogger.info({
          statusCode,
          duration,
          receivedBytes
        }, 'Received HTTP response');

        if (statusCode >= 200 && statusCode < 300) {
          settleResolve({
            statusCode,
            success: true,
            message: 'Webhook delivered successfully'
          });
        } else if (statusCode >= 400 && statusCode < 500) {
          const error = new Error(`HTTP ${statusCode}: Client error (no retry)`);
          error.permanent = true;
          error.statusCode = statusCode;
          settleReject(error);
        } else if (statusCode >= 500) {
          const error = new Error(`HTTP ${statusCode}: Server error (will retry)`);
          error.statusCode = statusCode;
          settleReject(error);
        } else if (statusCode >= 300 && statusCode < 400) {
          const error = new Error(`HTTP ${statusCode}: Redirects not supported`);
          error.permanent = true;
          error.statusCode = statusCode;
          settleReject(error);
        } else {
          const error = new Error(`HTTP ${statusCode}: Unexpected status`);
          error.statusCode = statusCode;
          settleReject(error);
        }
      });

      res.on('error', (error) => {
        if (settled) return;
        if (!error.code) error.code = 'RESPONSE_STREAM_ERROR';
        settleReject(error);
      });
    });

    req.on('error', (error) => {
      if (settled) return;

      jobLogger.error({
        error: error.message,
        code: error.code
      }, 'HTTP request error');

      settleReject(error);
    });

    req.on('timeout', () => {
      jobLogger.warn({ timeout }, 'HTTP request timeout');

      const error = new Error(`Request timeout after ${timeout}ms`);
      error.code = 'WEBHOOK_TIMEOUT';
      req.destroy(error);
      settleReject(error);
    });

    req.write(jsonPayload);
    req.end();
  });
}

/**
 * Deliver webhook via HTTP POST with secure connection pinning
 * 
 * Security features:
 * 1. Re-validates URL at delivery time (DNS rebinding protection)
 * 2. Resolves all DNS records and validates all IPs
 * 3. Pins connection to validated IP (prevents automatic DNS resolution)
 * 4. Preserves hostname for TLS SNI and Host header
 * 5. Enforces timeout and response size limits
 * 6. Disables redirects
 * 
 * @param {Object} jobData - Job data from BullMQ
 * @param {string} jobData.destinationUrl - Target webhook URL
 * @param {Object} jobData.payload - JSON payload to send
 * @param {string} jobData.jobId - Job identifier for logging
 * @param {string} jobData.eventId - Event identifier for logging
 * @returns {Promise<Object>} Delivery result
 * @throws {Error} On delivery failure
 */
export async function deliverWebhook(jobData) {
  const { destinationUrl, payload, jobId, eventId } = jobData;
  
  // Create job-specific logger
  const jobLogger = deliveryLogger.child({ jobId, eventId });
  
  // STEP 1: Re-validate URL at delivery time (SSRF + DNS rebinding protection)
  jobLogger.debug('Validating destination URL');
  
  const validation = await validateDestinationUrl(destinationUrl);
  
  if (!validation.valid) {
    // SSRF validation failed - this is a PERMANENT failure
    jobLogger.warn({
      error: validation.error,
      destination: sanitizeUrl(destinationUrl)
    }, 'SSRF validation failed');
    
    const error = new Error(`SSRF validation failed: ${validation.error}`);
    error.permanent = true;  // Mark as permanent to prevent retries
    throw error;
  }
  
  jobLogger.debug('URL validation passed');
  
  // STEP 2: Parse URL and resolve DNS
  const parsedUrl = new URL(destinationUrl);
  const hostname = parsedUrl.hostname;
  
  jobLogger.debug({ hostname }, 'Resolving DNS');
  
  let addresses;
  try {
    addresses = await dnsLookupAll(hostname, { all: true });
  } catch (dnsError) {
    jobLogger.error({
      error: dnsError.message,
      hostname
    }, 'DNS resolution failed');
    throw new Error(`DNS resolution failed: ${dnsError.message}`);
  }
  
  jobLogger.debug({
    hostname,
    addressCount: addresses.length
  }, 'DNS resolved');
  
  // STEP 3: Filter to public IPs only (defense in depth)
  const publicAddresses = addresses.filter(addr => !isPrivateOrLoopbackIP(addr.address));
  
  if (publicAddresses.length === 0) {
    jobLogger.warn({
      hostname,
      totalAddresses: addresses.length
    }, 'No public IP addresses found after filtering');
    
    const error = new Error('No public IP addresses found after filtering');
    error.permanent = true;  // Permanent failure
    throw error;
  }
  
  // STEP 4: Select first public IP for connection pinning
  const targetIP = publicAddresses[0].address;
  const targetFamily = publicAddresses[0].family;
  
  jobLogger.info({
    pinnedIP: targetIP,
    ipFamily: targetFamily,
    hostname
  }, 'Connection pinned to validated IP');
  
  // STEP 5: Prepare HTTP request with connection pinning
  const port = parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80);
  const path = parsedUrl.pathname + parsedUrl.search;
  const jsonPayload = JSON.stringify(payload);
  
  // Validate payload size
  if (Buffer.byteLength(jsonPayload) > MAX_RESPONSE_SIZE) {
    jobLogger.warn({
      payloadSize: Buffer.byteLength(jsonPayload),
      maxSize: MAX_RESPONSE_SIZE
    }, 'Payload exceeds maximum size');
    
    const error = new Error('Payload exceeds maximum size');
    error.permanent = true;
    throw error;
  }
  
  const requestOptions = {
    hostname: hostname,  // Original hostname for TLS SNI and Host header
    port: port,
    path: path,
    method: 'POST',
    headers: {
      'Host': hostname,  // Original hostname for Host header
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(jsonPayload),
      'User-Agent': 'WebhookDispatcher/1.0'
    },
    timeout: WEBHOOK_TIMEOUT,
    
    // CRITICAL: Custom lookup pins connection to validated IP
    // This prevents Node.js from performing its own DNS lookup
    // Node.js can call lookup with either 2 or 3 arguments:
    //   lookup(hostname, callback)           - 2 args
    //   lookup(hostname, options, callback)  - 3 args
    lookup: (hostname, options, callback) => {
      // Handle both 2-arg and 3-arg calling conventions
      const cb = typeof options === 'function' ? options : callback;
      
      // Validate callback is a function
      if (typeof cb !== 'function') {
        throw new Error('lookup callback is not a function');
      }
      
      // Check if options.all is requested (when options is an object)
      const needsAll = typeof options === 'object' && options && options.all === true;
      
      if (needsAll) {
        // Return array of address objects when all=true
        cb(null, [{ address: targetIP, family: targetFamily }]);
      } else {
        // Return single address and family
        cb(null, targetIP, targetFamily);
      }
    }
  };
  
  // Select http or https module based on protocol
  const client = parsedUrl.protocol === 'https:' ? https : http;
  
  jobLogger.debug({
    method: 'POST',
    protocol: parsedUrl.protocol,
    hostname,
    port,
    path
  }, 'Sending HTTP request');
  
  // STEP 6: Send HTTP request
  const startTime = Date.now();
  
  return executeWebhookRequest({
    client,
    requestOptions,
    jsonPayload,
    maxResponseSize: MAX_RESPONSE_SIZE,
    timeout: WEBHOOK_TIMEOUT,
    startTime,
    jobLogger
  });
}
