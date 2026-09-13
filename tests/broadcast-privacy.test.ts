import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryPublisher, CHANNELS } from '../src/broadcast/publisher.js';
import type { BroadcastMessage } from '../src/core/types.js';
const calls = vi.hoisted(() => ({ publish: vi.fn().mockResolvedValue(1), connect: vi.fn().mockResolvedValue(undefined), quit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('ioredis', () => ({ default: class { publish = calls.publish; connect = calls.connect; quit = calls.quit; } }));
afterEach(() => vi.clearAllMocks());
describe('broadcast scope', () => {
  it.each(['core', 'profile'] as const)('keeps private %s content out of shared channels', async (memoryType) => {
    const publisher = new MemoryPublisher('redis://fixture');
    await publisher.connect();
    const message: BroadcastMessage = { memoryId: 'private-id', agentId: 'alice', memoryType, scope: 'private', textPreview: 'PRIVATE_CANARY', event: 'new_memory', linkedCount: 0, timestamp: new Date().toISOString() };
    try {
      await publisher.publish(message);
      const contentDeliveries = calls.publish.mock.calls.filter(([, body]) => String(body).includes('PRIVATE_CANARY'));
      expect(contentDeliveries.map(([channel]) => channel)).toEqual([CHANNELS.PRIVATE('alice')]);
      expect(calls.publish.mock.calls.some(([channel]) => channel === CHANNELS.CRITICAL)).toBe(false);
    } finally { await publisher.disconnect(); }
  });
  it('continues broadcasting public high-priority records to the critical channel', async () => {
    const publisher = new MemoryPublisher('redis://fixture');
    await publisher.connect();
    try {
      await publisher.publish({ memoryId: 'shared', agentId: 'alice', memoryType: 'core', scope: 'public', textPreview: 'Shared approval rule', event: 'new_memory', linkedCount: 0, timestamp: new Date().toISOString() });
      expect(calls.publish.mock.calls.map(([channel]) => channel)).toContain(CHANNELS.CRITICAL);
    } finally { await publisher.disconnect(); }
  });
});
