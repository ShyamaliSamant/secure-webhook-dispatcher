// Simulate server startup sequence
console.log('Step 1: Loading queue module...');
const queueModule = await import('./src/queues/webhookQueue.js');
console.log('Step 2: Queue module loaded');

console.log('Step 3: Waiting 3 seconds for connection...');
await new Promise(resolve => setTimeout(resolve, 3000));

console.log('Step 4: Testing job addition...');
try {
  const job = await queueModule.addWebhookJob({
    jobId: 'startup-test-' + Date.now(),
    destinationUrl: 'https://example.com/test',
    eventId: 'startup-test',
    payload: { test: 'startup' },
    createdAt: new Date().toISOString()
  });
  console.log('✅ Success! Job ID:', job.id);
  await queueModule.webhookQueue.close();
} catch (error) {
  console.log('❌ Failed:', error.message);
  console.log('Error code:', error.code);
  console.log('Error details:', error);
}
