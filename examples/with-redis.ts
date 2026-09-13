/** Explicit broadcast API example; use an isolated Redis instance. No persistent memory is written. */
import { randomUUID } from 'node:crypto';
import { MemoryPublisher, MemorySubscriber } from '../dist/index.js';
const url = process.env.REDIS_URL;
if (!url) throw new Error('Set REDIS_URL to an isolated example Redis instance.');
const publisher = new MemoryPublisher(url);
const subscriber = new MemorySubscriber(url, 'example-listener');
const memoryId = randomUUID();
// Bound the complete example, including connection failures and cleanup.
const deadline = setTimeout(() => { console.error('Broadcast example exceeded 15 seconds.'); process.exit(1); }, 15_000);
let delivered!: () => void;
const received = new Promise<void>(resolve => { delivered = resolve; });
subscriber.onMessage(message => { if (message.memoryId === memoryId && message.textPreview) { console.log('Received:', message.textPreview); delivered(); } });
try {
  await subscriber.start();
  await publisher.connect();
  await publisher.publish({ memoryId, agentId: 'example-writer', memoryType: 'semantic', scope: 'public', textPreview: 'A synthetic catalogue example completed.', event: 'new_memory', linkedCount: 0, timestamp: new Date().toISOString() });
  await received;
} finally {
  await Promise.all([subscriber.stop(), publisher.disconnect()]);
  clearTimeout(deadline);
}
