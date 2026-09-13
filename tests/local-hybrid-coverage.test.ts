import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalMemory, type LocalMemory, type MemoryEmbedder } from '../src/local/index.js';

const opened: LocalMemory[] = [];
const source = { uri: 'test:hybrid-coverage' };
const embedder: MemoryEmbedder = { model: 'coverage-fixture-v1', dimensions: 2, async embed(texts) { return texts.map(text => /automobile|vehicle/.test(text) ? [1, 0] : [0, 1]); } };
const open = (now?: () => Date) => { const db = createLocalMemory({ path: ':memory:', workspaceId: 'coverage', agentId: 'alice', now }); opened.push(db); return db; };
async function corpus(db: LocalMemory, count: number) {
  db.atomic(() => { for (let i = 0; i < count; i++) db.store({ text: `Fresh fruit ${i}`, source, trust: 'observed' }); });
  while ((await db.indexEmbeddings({ embedder, limit: 1000 })).remaining) { /* Explicit fixture indexing. */ }
}
afterEach(async () => { vi.restoreAllMocks(); await new Promise<void>(resolve => setImmediate(resolve)); opened.splice(0).forEach(db => db.close()); });

describe('complete scoped hybrid candidate coverage', () => {
  it('finds the older semantic match beyond 1000 newer records even with a one-candidate heap', async () => {
    let day = 1; const db = open(() => new Date(`2026-09-0${day}T00:00:00.000Z`));
    const old = db.store({ text: 'An automobile transports people', source, trust: 'observed' }); day = 2;
    await corpus(db, 1000);
    expect((await db.recallHybrid({ query: 'vehicle' }, { embedder })).map(item => item.memory.id)).toEqual([old.id]);
    expect((await db.recallHybrid({ query: 'vehicle' }, { embedder, maxCandidates: 1 })).map(item => item.memory.id)).toEqual([old.id]);
  });

  it('yields while scanning so cancellation cannot return a partial answer', async () => {
    const db = open(); await corpus(db, 300); const controller = new AbortController();
    await expect(db.recallHybrid({ query: 'vehicle' }, {
      signal: controller.signal,
      embedder: { ...embedder, async embed(texts, options) { setImmediate(() => controller.abort(new Error('Stop scan'))); return embedder.embed(texts, options); } },
    })).rejects.toThrow('Stop scan');
  });

  it('enforces a scan deadline instead of silently returning incomplete coverage', async () => {
    const db = open(); await corpus(db, 2);
    let ticks = 0; vi.spyOn(performance, 'now').mockImplementation(() => ticks += 5);
    await expect(db.recallHybrid({ query: 'vehicle' }, { embedder, timeoutMs: 1 })).rejects.toThrow(/scan.*timed out/i);
  });

  it('rehydrates evidence corrected while a scan yields', async () => {
    const db = open(); const old = db.store({ text: 'An automobile transports people', source, trust: 'observed' }); await corpus(db, 300);
    const result = await db.recallHybrid({ query: 'vehicle' }, {
      embedder: { ...embedder, async embed(texts, options) {
        setImmediate(() => db.correct(old.id, { text: 'Fruit is food', source, reason: 'Source corrected during scan' }));
        return embedder.embed(texts, options);
      } },
    });
    expect(result).toEqual([]);
  });
});
