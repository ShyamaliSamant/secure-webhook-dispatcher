export const webhookJobOptions = {
  attempts: 4,
  backoff: {
    type: 'exponential',
    delay: 2_000
  },
  removeOnComplete: {
    age: 86_400,
    count: 1_000
  },
  removeOnFail: {
    age: 604_800
  }
};
