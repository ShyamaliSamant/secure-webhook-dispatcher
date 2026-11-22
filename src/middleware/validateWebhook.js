import { isPrivateOrLoopbackIP, dnsLookupWithTimeout } from '../utils/ssrfProtection.js';

// DNS lookup timeout in milliseconds
const DNS_TIMEOUT = 5000;

/**
 * Middleware to validate webhook dispatch requests
 * Validates destinationUrl, eventId, and payload
 * Prevents SSRF attacks by rejecting localhost, loopback, and private IPs
 * 
 * SECURITY NOTE: DNS Rebinding Risk
 * This validation performs DNS lookup at request time, but there's a window
 * between validation and actual HTTP delivery where DNS could change.
 * 
 * Mitigation: The worker that performs actual HTTP delivery (Step 3+) MUST
 * re-validate the destination immediately before making the HTTP request
 * using the validateDestinationUrl() function from utils/ssrfProtection.js
 */
export async function validateWebhook(req, res, next) {
  const { destinationUrl, eventId, payload } = req.body;

  // Validate destinationUrl presence
  if (!destinationUrl) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: 'destinationUrl is required'
    });
  }

  // Validate destinationUrl type
  if (typeof destinationUrl !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: 'destinationUrl must be a string'
    });
  }

  // Validate destinationUrl length (prevent memory exhaustion)
  if (destinationUrl.length > 2048) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: 'destinationUrl exceeds maximum length of 2048 characters'
    });
  }

  // Validate URL format and protocol
  let parsedUrl;
  try {
    parsedUrl = new URL(destinationUrl);
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: 'destinationUrl must be a valid URL'
    });
  }

  // Only allow HTTP and HTTPS protocols
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: 'Only HTTP and HTTPS protocols are allowed'
    });
  }

  // Block URLs with user credentials (potential bypass technique)
  if (parsedUrl.username || parsedUrl.password) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: 'URLs with credentials are not allowed'
    });
  }

  // Prevent SSRF: Block localhost, loopback, and private IPs
  const hostname = parsedUrl.hostname.toLowerCase();
  
  // Block common localhost names and variations
  const localhostVariations = [
    'localhost',
    'localhost.localdomain',
    'ip6-localhost',
    'ip6-loopback'
  ];
  
  if (localhostVariations.includes(hostname)) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: 'Localhost and loopback addresses are not allowed'
    });
  }

  // Block cloud metadata hostnames
  const metadataHosts = [
    'metadata.google.internal',
    'metadata',
    '169.254.169.254',
    'instance-data',
    'instance-data.ec2.internal'
  ];
  
  if (metadataHosts.includes(hostname)) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: 'Cloud metadata endpoints are not allowed'
    });
  }

  // Direct IP check (before DNS lookup)
  if (isPrivateOrLoopbackIP(hostname)) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: 'Private IP addresses are not allowed'
    });
  }

  // Perform DNS lookup with timeout to check if hostname resolves to private/loopback IP
  try {
    const addresses = await dnsLookupWithTimeout(hostname, DNS_TIMEOUT);
    
    // Check all resolved addresses
    for (const addr of addresses) {
      if (isPrivateOrLoopbackIP(addr.address)) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: 'Destination resolves to a private or loopback IP address'
        });
      }
    }
  } catch (dnsError) {
    // DNS lookup failed or timed out
    if (dnsError.message === 'DNS lookup timeout') {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: 'DNS lookup timeout - destination cannot be verified'
      });
    }
    
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: 'Unable to resolve destination hostname'
    });
  }

  // Validate eventId
  if (!eventId) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: 'eventId is required'
    });
  }

  if (typeof eventId !== 'string' || eventId.trim() === '') {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: 'eventId must be a non-empty string'
    });
  }

  // Validate eventId length (prevent memory exhaustion)
  if (eventId.length > 256) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: 'eventId exceeds maximum length of 256 characters'
    });
  }

  // Validate payload
  if (payload === undefined || payload === null) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: 'payload is required'
    });
  }

  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: 'payload must be a valid JSON object'
    });
  }

  // All validations passed
  next();
}
