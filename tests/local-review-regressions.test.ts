import { describe, expect, it } from 'vitest';
import { createLocalMemory, type MemoryEmbedder } from '../src/local/index.js';
import { MemoryRelations } from '../src/relations/index.js';

const day = (value: number) => new Date(`2026-09-${String(value).padStart(2, '0')}T00:00:00.000Z`);
const source = { uri: 'test:independent-review' };

describe('independent review regressions', () => {
  it('projects graph status and timestamps at historical knowledge time', () => {
    let current = day(2);
    const memory = createLocalMemory({ path: ':memory:', workspaceId: 'review', agentId: 'agent', now: () => current });
    try {
      const graph = new MemoryRelations(memory);
      const evidence = memory.store({ text: 'Alice owns the service', source, trust: 'observed' });
      const person = graph.entity({ name: 'Alice', type: 'person', source });
      const service = graph.entity({ name: 'Service', type: 'service', source });
      const edge = graph.relate({ fromId: person.id, toId: service.id, predicate: 'owns', evidenceIds: [evidence.id], source, validFrom: day(3).toISOString(), validUntil: day(7).toISOString() });
      current = day(10);
      memory.correct(evidence.id, { text: 'Bob owns the service', source, reason: 'Ownership changed' });
      expect(memory.get(edge.id)?.status).toBe('invalidated');
      const paths = graph.traverse({ entityId: person.id, asOf: day(5).toISOString(), knownAt: day(6).toISOString() });
      expect(paths).toHaveLength(1);
      expect(paths[0].edges[0].status).toBe('active');
      expect(paths[0].edges[0].updatedAt).toBe(day(2).toISOString());
      expect(graph.traverse({ entityId: person.id })).toEqual([]);
    } finally { memory.close(); }
  });
  it('blocks nested atomic writes escaping a rejected asynchronous continuation', async () => {
    const memory = createLocalMemory({ path: ':memory:', workspaceId: 'review', agentId: 'agent' });
    try {
      let continuation: Promise<unknown> | undefined;
      expect(() => memory.atomic(() => {
        memory.store({ text: 'rolled back', source });
        continuation = Promise.resolve().then(() => memory.atomic(() => memory.store({ text: 'escaped write', source })));
        return continuation;
      })).toThrow('synchronous');
      await expect(continuation).rejects.toThrow('escaped');
      expect(memory.inspect()).toEqual([]);
      expect(memory.atomic(() => memory.store({ text: 'valid later transaction', source })).text).toBe('valid later transaction');
    } finally { memory.close(); }
  });

  for (const boundary of ['embed', 'rerank'] as const) {
    it(`withholds corrected unkeyed evidence after a clock change during ${boundary}`, async () => {
      let current = day(2);
      const memory = createLocalMemory({ path: ':memory:', workspaceId: 'review', agentId: 'agent', now: () => current });
      try {
        const old = memory.store({ text: 'Release service with unsafe procedure', source, trust: 'observed' });
        const embedder: MemoryEmbedder = { model: 'review-constant-v1', dimensions: 2, embed: async texts => texts.map(() => [1, 0]) };
        await memory.indexEmbeddings({ embedder });
        const change = () => { current = day(3); memory.correct(old.id, { text: 'Revised procedure requires approval', source, reason: 'New evidence' }); };
        const options = boundary === 'embed'
          ? { embedder: { ...embedder, embed: async (texts: readonly string[]) => { change(); return texts.map(() => [1, 0]); } } }
          : { embedder, reranker: { rerank: async (_query: string, candidates: readonly { id: string }[]) => { change(); return candidates.map(record => ({ id: record.id, score: 1 })); } } };
        const result = await memory.recallHybrid({ query: 'service procedure' }, options);
        expect(result.some(item => item.memory.id === old.id)).toBe(false);
        expect(memory.get(old.id)?.status).toBe('superseded');
      } finally { memory.close(); }
    });
  }

  it('never compiles evidence superseded during the query embedding call', async () => {
    let current = day(2);
    const memory = createLocalMemory({ path: ':memory:', workspaceId: 'review', agentId: 'agent', now: () => current });
    try {
      const old = memory.store({ text: 'Outdated launch advice', source, trust: 'observed' });
      const packet = await memory.compileHybrid({ query: 'launch advice', maxTokens: 4096 }, {
        embedder: { model: 'review-compile-v1', dimensions: 2, embed: async texts => {
          current = day(3); memory.correct(old.id, { text: 'Changed approval process', source, reason: 'Changed' });
          return texts.map(() => [1, 0]);
        } },
      });
      expect(packet.items.some(item => item.id === old.id)).toBe(false);
      expect(packet.text).not.toContain('Outdated launch advice');
    } finally { memory.close(); }
  });

  it('preserves explicitly requested historical knowledge across provider awaits', async () => {
    let current = day(2);
    const memory = createLocalMemory({ path: ':memory:', workspaceId: 'review', agentId: 'agent', now: () => current });
    try {
      const old = memory.store({ text: 'Original policy', source, trust: 'observed' });
      const result = await memory.recallHybrid({ query: 'Original policy', knownAt: day(2).toISOString() }, {
        embedder: { model: 'review-historical-v1', dimensions: 2, embed: async texts => {
          current = day(3); memory.correct(old.id, { text: 'New policy', source, reason: 'Changed' });
          return texts.map(() => [1, 0]);
        } },
      });
      expect(result.map(item => item.memory.id)).toContain(old.id);
    } finally { memory.close(); }
  });
});
