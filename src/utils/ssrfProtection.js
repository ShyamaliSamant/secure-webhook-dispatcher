import dns from 'dns';
import net from 'net';
import { promisify } from 'util';

const dnsLookupAll = promisify(dns.lookup);
const DNS_TIMEOUT = 5000;

/**
 * Check if an IP address is private, loopback, or otherwise non-public
 * This is a security-critical function used to prevent SSRF attacks
 * 
 * @param {string} ip - The IP address to check
 * @returns {boolean} True if the IP is private/loopback
 */
export function isPrivateOrLoopbackIP(ip) {
  if (!ip) return true; // Treat empty/null as private
  
  // Strip IPv6 brackets if present (from URL hostname like [::ffff:192.168.1.1])
  let normalizedIP = ip.trim().toLowerCase();
  if (normalizedIP.startsWith('[') && normalizedIP.endsWith(']')) {
    normalizedIP = normalizedIP.slice(1, -1);
  }
  
  // Validate using Node.js net.isIP() - rejects malformed IPs
  const ipVersion = net.isIP(normalizedIP);
  if (ipVersion === 0) {
    // Not a valid IP address format, treat as potentially dangerous
    // (could be hostname that needs DNS resolution)
    return false; // Will be checked via DNS lookup
  }
  
  // IPv6 IPv4-mapped addresses: ::ffff:192.168.1.1
  if (normalizedIP.includes('::ffff:')) {
    const ipv4Part = normalizedIP.split('::ffff:')[1];
    if (ipv4Part) {
      return isPrivateOrLoopbackIP(ipv4Part);
    }
  }

  // IPv4 loopback: 127.0.0.0/8
  if (normalizedIP === '127.0.0.1' || normalizedIP.startsWith('127.')) {
    return true;
  }

  // IPv4 link-local: 0.0.0.0 and broadcast
  if (normalizedIP === '0.0.0.0' || normalizedIP === '255.255.255.255') {
    return true;
  }

  // IPv6 loopback (including compressed forms)
  if (normalizedIP === '::1' || normalizedIP === '::' || normalizedIP === '0:0:0:0:0:0:0:1') {
    return true;
  }

  // Check IPv4 private ranges
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const ipv4Match = normalizedIP.match(ipv4Regex);
  
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number);
    const [octet1, octet2, octet3, octet4] = octets;
    
    // Validate octets are in valid range
    if (octets.some(octet => octet < 0 || octet > 255)) {
      return true;
    }
    
    // 10.0.0.0/8 - Private
    if (octet1 === 10) {
      return true;
    }
    
    // 172.16.0.0/12 - Private
    if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) {
      return true;
    }
    
    // 192.168.0.0/16 - Private
    if (octet1 === 192 && octet2 === 168) {
      return true;
    }
    
    // 169.254.0.0/16 - Link-local (CRITICAL: Includes cloud metadata endpoints)
    if (octet1 === 169 && octet2 === 254) {
      return true;
    }
    
    // 100.64.0.0/10 - Shared address space (Carrier-grade NAT)
    if (octet1 === 100 && octet2 >= 64 && octet2 <= 127) {
      return true;
    }
    
    // 192.0.0.0/24 - IETF Protocol Assignments
    if (octet1 === 192 && octet2 === 0 && octet3 === 0) {
      return true;
    }
    
    // 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 - Documentation
    if (
      (octet1 === 192 && octet2 === 0 && octet3 === 2) ||
      (octet1 === 198 && octet2 === 51 && octet3 === 100) ||
      (octet1 === 203 && octet2 === 0 && octet3 === 113)
    ) {
      return true;
    }
    
    // 224.0.0.0/4 - Multicast
    if (octet1 >= 224 && octet1 <= 239) {
      return true;
    }
    
    // 240.0.0.0/4 - Reserved
    if (octet1 >= 240) {
      return true;
    }
  }

  // Check IPv6 private and special ranges
  // Remove zone identifier if present (e.g., fe80::1%eth0)
  const ipv6WithoutZone = normalizedIP.split('%')[0];
  
  // IPv6 loopback (various representations)
  if (ipv6WithoutZone === '::1' || ipv6WithoutZone === '0:0:0:0:0:0:0:1') {
    return true;
  }
  
  // IPv6 unspecified address
  if (ipv6WithoutZone === '::' || ipv6WithoutZone === '0:0:0:0:0:0:0:0') {
    return true;
  }
  
  // IPv6 link-local: fe80::/10
  if (ipv6WithoutZone.startsWith('fe80:') || ipv6WithoutZone.startsWith('fe8') || 
      ipv6WithoutZone.startsWith('fe9') || ipv6WithoutZone.startsWith('fea') || 
      ipv6WithoutZone.startsWith('feb')) {
    return true;
  }
  
  // IPv6 unique local addresses: fc00::/7 (fc00::/8 and fd00::/8)
  if (ipv6WithoutZone.startsWith('fc') || ipv6WithoutZone.startsWith('fd')) {
    return true;
  }
  
  // IPv6 documentation: 2001:db8::/32
  if (ipv6WithoutZone.startsWith('2001:db8:') || ipv6WithoutZone.startsWith('2001:0db8:')) {
    return true;
  }
  
  // IPv6 multicast: ff00::/8
  if (ipv6WithoutZone.startsWith('ff')) {
    return true;
  }

  return false;
}

/**
 * Perform DNS lookup with timeout
 * 
 * IMPORTANT: Node.js dns.lookup() cannot be cancelled.
 * Promise.race() allows us to reject early on timeout, but the underlying
 * DNS operation will continue to completion in the background.
 * 
 * This is an acceptable limitation because:
 * 1. Validation fails fast (rejects on timeout)
 * 2. The DNS query will eventually complete or fail silently
 * 3. No security impact - we've already rejected the request
 * 
 * For production: Consider implementing DNS caching to reduce repeated
 * lookups and mitigate resource usage from background operations.
 * 
 * @param {string} hostname - The hostname to resolve
 * @param {number} timeout - Timeout in milliseconds (default: 5000ms)
 * @returns {Promise<Array>} Resolved addresses
 * @throws {Error} 'DNS lookup timeout' if timeout is reached
 */
export async function dnsLookupWithTimeout(hostname, timeout = DNS_TIMEOUT) {
  let timeoutId;
  
  try {
    // Start DNS lookup
    const lookupPromise = dnsLookupAll(hostname, { all: true });
    
    // Create timeout promise
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('DNS lookup timeout'));
      }, timeout);
    });
    
    // Race between lookup and timeout
    const result = await Promise.race([lookupPromise, timeoutPromise]);
    
    // Clear timeout if lookup completed first
    clearTimeout(timeoutId);
    return result;
    
  } catch (error) {
    // Clean up timeout if it exists
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    
    // Re-throw the error (either DNS error or timeout error)
    // Note: If timeout occurred, the DNS lookup continues in background
    // but the promise chain is broken, preventing unhandled rejections
    throw error;
  }
}

/**
 * Validate a destination URL for SSRF protection
 * This function should be called before making any outbound HTTP request
 * 
 * @param {string} destinationUrl - The URL to validate
 * @returns {Promise<{valid: boolean, error?: string}>} Validation result
 */
export async function validateDestinationUrl(destinationUrl) {
  try {
    // Parse URL
    const parsedUrl = new URL(destinationUrl);
    
    // Only allow HTTP and HTTPS
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return { valid: false, error: 'Only HTTP and HTTPS protocols are allowed' };
    }
    
    // Block URLs with credentials
    if (parsedUrl.username || parsedUrl.password) {
      return { valid: false, error: 'URLs with credentials are not allowed' };
    }
    
    const hostname = parsedUrl.hostname.toLowerCase();
    
    // Block localhost variations
    const localhostVariations = [
      'localhost',
      'localhost.localdomain',
      'ip6-localhost',
      'ip6-loopback'
    ];
    
    if (localhostVariations.includes(hostname)) {
      return { valid: false, error: 'Localhost addresses are not allowed' };
    }
    
    // Block cloud metadata endpoints
    const metadataHosts = [
      'metadata.google.internal',
      'metadata',
      '169.254.169.254',
      'instance-data',
      'instance-data.ec2.internal'
    ];
    
    if (metadataHosts.includes(hostname)) {
      return { valid: false, error: 'Cloud metadata endpoints are not allowed' };
    }
    
    // Check if hostname is a private IP
    if (isPrivateOrLoopbackIP(hostname)) {
      return { valid: false, error: 'Private IP addresses are not allowed' };
    }
    
    // Perform DNS resolution and check all addresses
    const addresses = await dnsLookupWithTimeout(hostname);
    
    for (const addr of addresses) {
      if (isPrivateOrLoopbackIP(addr.address)) {
        return { valid: false, error: 'Destination resolves to a private or loopback IP address' };
      }
    }
    
    return { valid: true };
    
  } catch (error) {
    if (error.message === 'DNS lookup timeout') {
      return { valid: false, error: 'DNS lookup timeout' };
    }
    return { valid: false, error: 'Unable to resolve destination hostname' };
  }
}
