import { Queue } from 'bullmq';

const jobId = '5749ad8a-9080-4eaa-8ffe-8bacadc96dc2';

const queue = new Queue('webhooks', {
  connection: {
    host: 'localhost',
    port: 6379
  }
});

console.log(`Retrieving job ${jobId} from Redis...`);

try {
  const job = await queue.getJob(jobId);
  
  if (!job) {
    console.log('❌ Job not found!');
    await queue.close();
    process.exit(1);
  }
  
  console.log('✅ Job found in Redis!');
  console.log('\nJob Details:');
  console.log('  ID:', job.id);
  console.log('  Name:', job.name);
  console.log('\nJob Data:');
  console.log(JSON.stringify(job.data, null, 2));
  console.log('\nJob Options:');
  console.log('  Attempts:', job.opts.attempts);
  console.log('  Backoff:', JSON.stringify(job.opts.backoff));
  
  await queue.close();
  process.exit(0);
} catch (error) {
  console.error('❌ Error:', error.message);
  await queue.close();
  process.exit(1);
}
