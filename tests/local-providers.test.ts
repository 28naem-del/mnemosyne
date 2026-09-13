import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ mode: 'ok', terminated: 0, created: 0, workerData: undefined as unknown }));
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  class Worker extends EventEmitter {
    constructor(_path: URL, args: string[]) {
      super(); state.created++; state.workerData = JSON.parse(args[0]);
      if (state.mode !== 'startup-hang') queueMicrotask(() => this.emit('message', { ready: true }));
    }
    send(request: { id: number; texts: string[]; query?: string }) {
      if (state.mode === 'hang') return;
      queueMicrotask(() => this.emit('message', { id: request.id,
        values: state.mode === 'invalid' ? ['bad'] : request.query ? request.texts.map((_, index) => 2 - index) : request.texts.map(() => Array<number>(384).fill(0.05)) }));
    }
    kill() { state.terminated++; this.emit('exit', 0); return true; }
  }
  return { fork: (path: URL, args: string[]) => new Worker(path, args) };
});
import { createLocalEmbedder, createLocalReranker } from '../src/providers/local.js';
afterEach(() => { state.mode = 'ok'; state.terminated = 0; state.created = 0; vi.useRealTimers(); });
describe('optional isolated local providers', () => {
  it('requires an explicit cache and defaults to no downloads, with reproducible model identity', async () => {
    await expect(createLocalEmbedder({ cacheDir: 'relative' })).rejects.toThrow();
    expect(state.created).toBe(0);
    const provider = await createLocalEmbedder({ cacheDir: '/tmp/explicit-model-cache' });
    expect(state.workerData).toMatchObject({ kind: 'embed', allowDownload: false });
    expect(provider.model).toContain('751bff37182d3f1213fa05d7196b954e230abad9');
    expect(provider.model).toContain('token-weighted-mean');
    expect(await provider.embed(['One sentence.'])).toHaveLength(1);
    await provider.dispose(); expect(state.terminated).toBe(1);
    await expect(provider.embed(['After disposal'])).rejects.toThrow('disposed');
  });
  it('terminates initialization and in-flight inference on timeout or cancellation', async () => {
    state.mode = 'startup-hang';
    await expect(createLocalEmbedder({ cacheDir: '/tmp/model-cache', startupTimeoutMs: 5 })).rejects.toThrow('deadline');
    expect(state.terminated).toBe(1);
    state.mode = 'ok';
    const provider = await createLocalEmbedder({ cacheDir: '/tmp/model-cache' });
    state.mode = 'hang'; const controller = new AbortController();
    const call = provider.embed(['Pending'], { signal: controller.signal });
    controller.abort(); await expect(call).rejects.toThrow('cancelled');
    expect(state.terminated).toBe(2);
  });
  it('rejects invalid results, excessive input and parallel overload', async () => {
    const provider = await createLocalEmbedder({ cacheDir: '/tmp/model-cache' });
    await expect(provider.embed(['x'.repeat(65537)])).rejects.toThrow();
    state.mode = 'invalid'; await expect(provider.embed(['input'])).rejects.toThrow();
    state.mode = 'hang'; const controller = new AbortController();
    const pending = provider.embed(['pending'], { signal: controller.signal });
    await expect(provider.embed(['parallel'])).rejects.toThrow('busy');
    controller.abort(); await expect(pending).rejects.toThrow(); await provider.dispose();
  });
  it('preserves every candidate ID and requires explicit reranker opt-in', async () => {
    const provider = await createLocalReranker({ cacheDir: '/tmp/model-cache', allowDownload: true });
    expect(state.workerData).toMatchObject({ kind: 'rerank', allowDownload: true });
    const candidates = [{ id: 'one', text: 'Relevant' }, { id: 'two', text: 'Other' }] as Parameters<typeof provider.rerank>[1];
    const results = await provider.rerank('query', candidates);
    expect(results.map(item => item.id)).toEqual(['one', 'two']);
    expect(results[0].score).toBeCloseTo(1 / (1 + Math.exp(-2)));
    expect(results[1].score).toBeCloseTo(1 / (1 + Math.exp(-1)));
    expect(await provider.rerank('query', [])).toEqual([]);
    await provider.dispose();
  });
});
