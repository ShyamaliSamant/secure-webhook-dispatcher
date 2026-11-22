import assert from 'node:assert/strict';

const originalEnv = {
  REDIS_URL: process.env.REDIS_URL,
  REDIS_HOST: process.env.REDIS_HOST,
  REDIS_PORT: process.env.REDIS_PORT,
  REDIS_PASSWORD: process.env.REDIS_PASSWORD
};

let passed = 0;
let failed = 0;

function check(name, assertion) {
  try {
    assertion();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL: ${name} - ${error.message}`);
  }
}

try {
  process.env.REDIS_URL = 'rediss://test-user:test-password@redis.example.invalid:6380/2';
  delete process.env.REDIS_PASSWORD;

  const redisConfig = await import(`./src/config/redis.js?test=${Date.now()}`);
  const bullMqConnection = redisConfig.getBullMQConnectionOptions();

  check('BullMQ URL configuration is an options object', () => {
    assert.equal(typeof bullMqConnection, 'object');
    assert.equal(bullMqConnection.url, process.env.REDIS_URL);
    assert.equal(bullMqConnection.maxRetriesPerRequest, 3);
  });

  check('Queue and DLQ exported connection is an options object', () => {
    assert.equal(typeof redisConfig.redisConnection, 'object');
    assert.equal(redisConfig.redisConnection.url, process.env.REDIS_URL);
  });

  check('health check keeps direct URL behavior', () => {
    assert.equal(redisConfig.getRedisConnection(), process.env.REDIS_URL);
  });

  delete process.env.REDIS_URL;
  process.env.REDIS_HOST = 'redis.internal';
  process.env.REDIS_PORT = '6381';
  process.env.REDIS_PASSWORD = 'test-password';

  const hostConfig = redisConfig.getBullMQConnectionOptions();
  check('individual Redis settings remain supported', () => {
    assert.equal(typeof hostConfig, 'object');
    assert.equal(hostConfig.host, 'redis.internal');
    assert.equal(hostConfig.port, 6381);
    assert.equal(hostConfig.password, 'test-password');
  });

  check('worker connection configuration remains independent', () => {
    const workerConfig = redisConfig.getWorkerRedisConnection();
    assert.equal(workerConfig.host, 'redis.internal');
    assert.equal(workerConfig.port, 6381);
    assert.equal(workerConfig.maxRetriesPerRequest, null);
  });
} finally {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

console.log(`PASS=${passed} FAIL=${failed}`);
process.exit(failed === 0 ? 0 : 1);
