import crypto from 'crypto';

/**
 * Generate a unique job ID using crypto.randomUUID()
 * @returns {string} A unique UUID v4 identifier
 */
export function generateJobId() {
  return crypto.randomUUID();
}
