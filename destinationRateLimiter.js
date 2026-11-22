import Redis from 'ioredis';
import { getWorkerRedisConnection } from './redis.js';
import { createDestinationRateLimiter } from '../utils/destinationRateLimiter.js';
import { logEvent } from '../utils/logger.js';

function readPositiveInteger(name, defaultValue) {
  const rawValue = process.env[name];
  const value = rawValue === undefined || rawValue === '' ? defaultValue : Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const maxRequests = readPositiveInteger('DESTINATION_RATE_LIMIT_MAX', 10);
const durationMs = readPositiveInteger('DESTINATION_RATE_LIMIT_DURATION', 60_000);
const redisClient = new Redis(getWorkerRedisConnection());
redisClient.on('error', (error) => {
  logEvent('error', 'destination_rate_limiter.redis_error', { message: error.message });
});

const limiter = createDestinationRateLimiter(redisClient, {
  maxRequests,
  durationMs
});

export const waitForDestinationSlot = limiter.waitForSlot;

export async function closeDestinationRateLimiter() {
  if (redisClient.status !== 'end') await redisClient.quit();
}
