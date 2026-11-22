import { webhookQueue, addWebhookJob } from './src/queues/webhookQueue.js';

console.log('Testing queue connection...');

webhookQueue.on('error', (err) => {
  console.log('❌ Queue error:', err);
});

setTimeout(async () => {
  try {
    console.log('Attempting to add job...');
    const job = await addWebhookJob({
      jobId: 'test-debug-123',
      destinationUrl: 'https://example.com/test',
      eventId: 'debug-test',
      payload: { test: 'debug' },
      createdAt: new Date().toISOString()
    });
    console.log('✅ Job added successfully:', job.id);
    await webhookQueue.close();
    process.exit(0);
  } catch (error) {
    console.log('❌ Error adding job:', error);
    console.log('Error details:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    process.exit(1);
  }
}, 2000);
