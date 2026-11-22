import pino from 'pino';

const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Create Pino logger with environment-appropriate configuration
 * 
 * Production: JSON output for log aggregation
 * Development: Pretty-printed for readability
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info'),
  
  // Development: Pretty-printed, Production: JSON
  transport: isDevelopment ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname'
    }
  } : undefined,
  
  // Base context included in every log
  base: {
    service: process.env.SERVICE_NAME || 'webhook-dispatcher',
    environment: process.env.NODE_ENV || 'development',
    pid: process.pid
  },
  
  // Redact sensitive fields
  redact: {
    paths: [
      // Credentials and secrets
      'password',
      'secret',
      'token',
      'apiKey',
      'api_key',
      'authorization',
      'bearer',
      
      // Webhook payloads (may contain sensitive data)
      'payload',
      'data.payload',
      'job.data.payload',
      'jobData.payload',
      
      // Sensitive headers
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'res.headers["set-cookie"]',
      
      // Environment variables (never log .env values)
      'env',
      'process.env'
    ],
    remove: true  // Remove rather than mask (more secure)
  },
  
  // Custom serializers for common objects
  serializers: {
    req: (req) => {
      if (!req) return req;
      return {
        method: req.method,
        url: req.url,
        // Sanitize query parameters (may contain tokens)
        query: req.query ? '[REDACTED]' : undefined,
        headers: {
          'user-agent': req.headers?.['user-agent'],
          'content-type': req.headers?.['content-type']
        },
        remoteAddress: req.socket?.remoteAddress,
        remotePort: req.socket?.remotePort
      };
    },
    res: (res) => {
      if (!res) return res;
      return {
        statusCode: res.statusCode
      };
    },
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err
  }
});

/**
 * Create child logger with additional context
 * 
 * @param {Object} context - Additional context (e.g., { jobId, eventId })
 * @returns {pino.Logger} Child logger with context
 */
export function createLogger(context) {
  return logger.child(context);
}

/**
 * Sanitize destination URL (remove credentials, keep hostname)
 * 
 * @param {string} url - Full URL
 * @returns {string} Sanitized hostname
 */
export function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return '[invalid-url]';
  }
}

/**
 * Log levels:
 * - trace: Very detailed debugging (rarely used)
 * - debug: Detailed debugging information
 * - info: General information about normal operations
 * - warn: Warning messages for recoverable issues
 * - error: Error messages for failures
 * - fatal: Fatal errors (process will exit)
 */
