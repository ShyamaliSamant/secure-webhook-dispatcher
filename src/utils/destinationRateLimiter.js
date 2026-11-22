import Redis from 'ioredis';
import { getWorkerRedisConnection } from '../config/redis.js';
import { createLogger } from './logger.js';

const limiterLogger = createLogger({ component: 'destination-rate-limiter' });

function readPositiveInteger(name, defaultValue) {
  const rawValue = process.env[name];
  const value = rawValue === undefined || rawValue === '' ? defaultValue : Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function normalizeDomain(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
}

const ACQUIRE_SCRIPT = `
local key = KEYS[1]
local maxRequests = tonumber(ARGV[1])
local durationMs = tonumber(ARGV[2])
local nowMember = ARGV[3]
local redisTime = redis.call('TIME')
local nowMs = (tonumber(redisTime[1]) * 1000) + math.floor(tonumber(redisTime[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', key, '-inf', nowMs - durationMs)
local count = redis.call('ZCARD', key)

if count < maxRequests then
  redis.call('ZADD', key, nowMs, nowMember)
  redis.call('PEXPIRE', key, durationMs)
  return {1, 0}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retryMs = math.max(1, (tonumber(oldest[2]) + durationMs) - nowMs)
redis.call('PEXPIRE', key, math.max(retryMs, 1))
return {0, retryMs}
`;

export function createDestinationRateLimiter(redisClient, options = {}) {
  const maxRequests = options.maxRequests;
  const durationMs = options.durationMs;

  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new Error('Destination rate limit maxRequests must be a positive integer');
  }
  if (!Number.isSafeInteger(durationMs) || durationMs < 1) {
    throw new Error('Destination rate limit durationMs must be a positive integer');
  }

  const keyPrefix = options.keyPrefix || 'webhook-dispatcher:destination-rate-limit';
  const waitIntervalMs = options.waitIntervalMs || 1000;

  async function tryAcquire(hostname) {
    const domain = normalizeDomain(hostname);
    if (!domain) throw new Error('Destination hostname is required for rate limiting');

    const member = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const key = `${keyPrefix}:${domain}`;
    const result = await redisClient.eval(
      ACQUIRE_SCRIPT,
      1,
      key,
      maxRequests,
      durationMs,
      member
    );

    return {
      allowed: Number(result[0]) === 1,
      retryAfterMs: Number(result[1])
    };
  }

  async function waitForSlot(hostname, onWait) {
    while (true) {
      const acquisition = await tryAcquire(hostname);
      if (acquisition.allowed) return acquisition;

      const delayMs = Math.min(acquisition.retryAfterMs, waitIntervalMs);
      if (typeof onWait === 'function') {
        await onWait(acquisition.retryAfterMs);
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return { tryAcquire, waitForSlot };
}

let redisClient = null;
let limiter = null;

function getLimiter() {
  if (limiter) return limiter;

  redisClient = new Redis(getWorkerRedisConnection());
  redisClient.on('error', (error) => {
    limiterLogger.error({ message: error.message }, 'Destination rate limiter Redis error');
  });

  limiter = createDestinationRateLimiter(redisClient, {
    maxRequests: readPositiveInteger('DESTINATION_RATE_LIMIT_MAX', 10),
    durationMs: readPositiveInteger('DESTINATION_RATE_LIMIT_DURATION', 60_000),
    keyPrefix: process.env.DESTINATION_RATE_LIMIT_KEY_PREFIX || 'webhook-dispatcher:destination-rate-limit'
  });
  return limiter;
}

export async function waitForDestinationSlot(hostname, onWait) {
  return getLimiter().waitForSlot(hostname, onWait);
}

export async function closeDestinationRateLimiter() {
  if (redisClient && redisClient.status !== 'end') {
    await redisClient.quit();
  }
  redisClient = null;
  limiter = null;
}
