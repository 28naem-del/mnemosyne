import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory, type LocalMemory, type MemoryEmbedder } from '../src/local/index.js';

const day = (value: number) => `2026-09-${String(value).padStart(2, '0')}T00:00:00.000Z`;
const source = { uri: 'test:temporal-context' };
const opened: LocalMemory[] = [];
const open = (now: () => Date) => {
  const memory = createLocalMemory({ path: ':memory:', workspaceId: 'temporal', agentId: 'alice', now });
  opened.push(memory); return memory;
};
const embedder: MemoryEmbedder = { model: 'temporal-fixture-v1', dimensions: 2, async embed(texts) { return texts.map(() => [1, 0]); } };
afterEach(() => { opened.splice(0).forEach(memory => memory.close()); });

describe('temporal context and correction descendants', () => {
  it('keeps current guidance usable until a scheduled correction is effective in world time', async () => {
    let current = 2; const memory = open(() => new Date(day(current)));
    const original = memory.store({ text: 'Protocol uses port 443', source, trust: 'observed', validFrom: day(1) });
    const derived = memory.store({ text: 'Protocol recipe uses port 443', source, trust: 'observed', dependencies: [original.id] });
    await memory.indexEmbeddings({ embedder });
    current = 5; memory.correct(original.id, { text: 'Protocol uses port 8443', source, reason: 'Scheduled change', validFrom: day(10) });
    current = 6;
    const restored = open(() => new Date(day(current))); restored.import(memory.export());
    for (const db of [memory, restored]) {
      expect(db.getAt(original.id)).not.toBeNull();
      expect(db.getAt(derived.id)).not.toBeNull();
      expect(db.isEligible(derived.id)).toBe(true);
      expect(db.isEligible(derived.id, { asOf: day(6), knownAt: day(6) })).toBe(true);
      for (const lexicalScoring of ['bm25', 'overlap'] as const) {
        expect(db.recall({ query: 'recipe', lexicalScoring }).map(hit => hit.memory.id)).toContain(derived.id);
        expect(db.compile({ query: 'recipe', lexicalScoring, maxTokens: 10000 }).items.map(item => item.id)).toContain(derived.id);
      }
    }
    expect((await memory.compileHybrid({ query: 'unmatched', maxTokens: 10000 }, { embedder })).items.map(item => item.id)).toContain(derived.id);
    current = 10;
    expect(memory.getAt(derived.id)).toBeNull(); expect(memory.isEligible(derived.id)).toBe(false);
    expect(memory.compile({ query: 'recipe', maxTokens: 10000 }).items).toEqual([]);
  });

  it('does not attribute a later imported invalidation to a correction before the dependent existed', () => {
    let current = 2; const memory = open(() => new Date(day(current)));
    const original = memory.store({ text: 'Port 443', source, trust: 'observed', validFrom: day(1) });
    const derived = memory.store({ text: 'Use old port 443', source, trust: 'observed', dependencies: [original.id] });
    current = 5; memory.correct(original.id, { text: 'Port 8443', source, reason: 'Scheduled change', validFrom: day(10) });
    const snapshot = memory.export(), retired = snapshot.memories.find(record => record.id === derived.id)!;
    retired.createdAt = day(6); retired.updatedAt = day(8);
    const restored = open(() => new Date(day(12)));
    expect(() => restored.import(snapshot)).toThrow('invalidation cause');
    // Legacy imports have no cause record. Their ambiguity must fail closed.
    delete retired.invalidation;
    restored.import(snapshot);
    expect(restored.getAt(derived.id, { asOf: day(7), knownAt: day(12) })).toBeNull();
    expect(restored.isEligible(derived.id, { asOf: day(7), knownAt: day(12) })).toBe(false);
  });

  it('rejects a same-time correction cause that is outside the dependent ancestry', () => {
    let current = 2; const memory = open(() => new Date(day(current)));
    const original = memory.store({ text: 'Port 443', source, trust: 'observed' });
    const unrelated = memory.store({ text: 'Unrelated service', source, trust: 'observed' });
    const derived = memory.store({ text: 'Use port 443', source, trust: 'observed', dependencies: [original.id] });
    current = 5;
    memory.correct(original.id, { text: 'Port 8443', source, reason: 'Scheduled', validFrom: day(10) });
    const otherCorrection = memory.correct(unrelated.id, { text: 'Unrelated revised service', source, reason: 'Also scheduled', validFrom: day(10) });
    const snapshot = memory.export(), retired = snapshot.memories.find(record => record.id === derived.id)!;
    retired.invalidation = { sourceId: unrelated.id, correctionId: otherCorrection.id, recordedAt: day(5) };
    expect(() => open(() => new Date(day(6))).import(snapshot)).toThrow('invalidation cause');
  });

  it('does not expose a private checkpoint successor through a shared invalidation cause', () => {
    let current = 2; const memory = open(() => new Date(day(current)));
    const input = { taskId: 'visibility-task', goal: 'Ship', completed: [], pending: ['Review'], decisions: [], constraints: [], artifacts: [], nextAction: 'Review' };
    const original = memory.checkpoint({ ...input, visibility: 'workspace' });
    const shared = memory.store({ text: 'Shared advice', source, trust: 'observed', visibility: 'workspace', dependencies: [original.id] });
    const privateAdvice = memory.store({ text: 'Private advice', source, trust: 'observed', dependencies: [original.id] });
    current = 5; const successor = memory.checkpoint({ ...input, visibility: 'private', nextAction: 'Internal review' });
    expect(memory.get(shared.id)?.invalidation).toBeUndefined();
    expect(JSON.stringify(memory.get(shared.id))).not.toContain(successor.id);
    expect(memory.get(privateAdvice.id)?.invalidation?.correctionId).toBe(successor.id);
    const restored = open(() => new Date(day(current)));
    expect(() => restored.import(memory.export())).not.toThrow();
    expect(restored.isEligible(shared.id)).toBe(false);
  });

  it('preserves transitive advice before a correction becomes effective, through snapshot restore', () => {
    let current = 2; const memory = open(() => new Date(day(current)));
    const original = memory.store({ text: 'Protocol uses port 443', source, trust: 'observed', validFrom: day(1) });
    const derived = memory.store({ text: 'Protocol recipe uses port 443', source, trust: 'observed', dependencies: [original.id] });
    const nested = memory.store({ text: 'Protocol checklist follows the recipe', source, trust: 'observed', dependencies: [derived.id] });
    current = 10;
    memory.correct(original.id, { text: 'Protocol uses port 8443', source, reason: 'Effective change', validFrom: day(5) });
    const restored = open(() => new Date(day(current))); restored.import(memory.export());
    for (const db of [memory, restored]) {
      const before = { asOf: day(3), knownAt: day(10) };
      expect(db.getAt(nested.id, before)?.status).toBe('active');
      expect(db.isEligible(nested.id, before)).toBe(true);
      expect(db.recall({ query: 'Protocol', ...before }).map(item => item.memory.id)).toContain(nested.id);
      expect(db.compile({ query: 'Protocol', maxTokens: 10000, ...before }).items.map(item => item.id)).toContain(nested.id);
      expect(db.isEligible(nested.id, { asOf: day(5), knownAt: day(10) })).toBe(false);
      expect(db.isEligible(nested.id)).toBe(false);
      expect(db.isEligible(nested.id, { asOf: day(6), knownAt: day(7) })).toBe(true);
      expect(db.get(nested.id)?.status).toBe('invalidated');
    }
  });

  it('never resurrects retroactively false dependencies', () => {
    let current = 2; const memory = open(() => new Date(day(current)));
    const original = memory.store({ text: 'Claim is wrong', source, trust: 'observed', validFrom: day(1) });
    const derived = memory.store({ text: 'Advice relies on claim', source, trust: 'observed', dependencies: [original.id] });
    current = 10; memory.correct(original.id, { text: 'Claim corrected', source, reason: 'Original was never true' });
    expect(memory.getAt(derived.id, { asOf: day(3), knownAt: day(10) })).toBeNull();
    expect(memory.compile({ query: 'Advice', maxTokens: 10000, asOf: day(3), knownAt: day(10) }).items).toEqual([]);
  });

  it('keeps failed and expired ancestors ineligible and deletion removes historical advice', () => {
    let current = 2; const memory = open(() => new Date(day(current)));
    const original = memory.store({ text: 'Port is 443', source, trust: 'observed', validFrom: day(1), validUntil: day(7) });
    const derived = memory.store({ text: 'Recipe uses the port', source, trust: 'observed', dependencies: [original.id] });
    current = 4; memory.recordOutcome({ memoryId: original.id, success: false, taskId: 'failure', evidence: 'Source was disproved', verifier: 'fixture' });
    current = 10; memory.correct(original.id, { text: 'Port is 8443', source, reason: 'Effective change', validFrom: day(5) });
    expect(memory.isEligible(derived.id, { asOf: day(3), knownAt: day(3) })).toBe(true);
    expect(memory.isEligible(derived.id, { asOf: day(3), knownAt: day(10) })).toBe(false);
    expect(memory.compile({ query: 'Recipe', maxTokens: 10000, asOf: day(3), knownAt: day(10) }).items).toEqual([]);
    expect(memory.getAt(derived.id, { asOf: day(8), knownAt: day(10) })).toBeNull();
    memory.forget(original.id);
    expect(memory.getAt(derived.id, { asOf: day(3), knownAt: day(3) })).toBeNull();
    expect(memory.compile({ query: 'Recipe', maxTokens: 10000, asOf: day(3), knownAt: day(3) }).items).toEqual([]);
  });

  it('does not infer recovery for invalidated imported records without a correction cause', () => {
    let current = 2; const memory = open(() => new Date(day(current)));
    const original = memory.store({ text: 'Source is available', source, trust: 'observed' });
    const derived = memory.store({ text: 'Unexplained retired advice', source, trust: 'observed', dependencies: [original.id] });
    current = 10; const snapshot = memory.export();
    const retired = snapshot.memories.find(record => record.id === derived.id)!;
    retired.status = 'invalidated'; retired.updatedAt = day(10);
    const restored = open(() => new Date(day(current))); restored.import(snapshot);
    expect(restored.getAt(derived.id, { asOf: day(3), knownAt: day(10) })).toBeNull();
    expect(restored.isEligible(derived.id, { asOf: day(3), knownAt: day(10) })).toBe(false);
  });

  it('uses knowledge time for failures and conflicts throughout compiled provenance', () => {
    let current = 2; const memory = open(() => new Date(day(current)));
    const original = memory.store({ text: 'Protocol port 443', source, trust: 'observed', key: 'port' });
    const derived = memory.store({ text: 'Run secure protocol', source, trust: 'observed', dependencies: [original.id] });
    current = 6; memory.store({ text: 'Protocol port 8443', source, trust: 'observed', key: 'port', validFrom: day(2) });
    current = 8; memory.recordOutcome({ memoryId: derived.id, success: false, taskId: 'failure', evidence: 'Later controller failure', verifier: 'fixture' });
    const earlier = memory.compile({ query: 'Run secure', maxTokens: 10000, asOf: day(3), knownAt: day(4) });
    expect(earlier.items.map(item => item.id)).toEqual([derived.id]);
    expect(earlier.conflicts).toEqual([]);
    expect(JSON.parse(earlier.text).temporal).toEqual({ asOf: day(3), knownAt: day(4) });
    const conflicted = memory.compile({ query: 'Run secure', maxTokens: 10000, asOf: day(3), knownAt: day(7) });
    expect(conflicted.items).toEqual([]);
    expect(conflicted.conflicts[0].key).toBe('port');
    expect(memory.compile({ query: 'Run secure', maxTokens: 10000, asOf: day(3), knownAt: day(9) }).items).toEqual([]);
    expect(memory.compile({ query: 'Protocol', maxTokens: 10000, asOf: day(3), knownAt: day(7) }).conflicts[0].ids).toHaveLength(2);
  });

  it('does not let future outcome evidence suppress a historically usable recommendation', () => {
    let current = 2; const memory = open(() => new Date(day(current)));
    const record = memory.store({ text: 'Follow procedure', source, trust: 'observed' });
    current = 8; memory.recordOutcome({ memoryId: record.id, success: false, taskId: 'trial', evidence: 'Failed later', verifier: 'fixture' });
    expect(memory.compile({ query: 'procedure', maxTokens: 10000, knownAt: day(4) }).items.map(item => item.id)).toEqual([record.id]);
    expect(memory.compile({ query: 'procedure', maxTokens: 10000, knownAt: day(9) }).items).toEqual([]);
  });

  it('selects historical task checkpoints instead of injecting the latest task state', () => {
    let current = 2; const memory = open(() => new Date(day(current)));
    const input = { taskId: 'task', goal: 'Ship', completed: [], pending: ['Review'], decisions: [], constraints: [], artifacts: [], nextAction: 'Review' };
    const old = memory.checkpoint(input);
    const derived = memory.store({ text: 'Review before deploying', source, trust: 'observed', dependencies: [old.id] });
    current = 10; const latest = memory.checkpoint({ ...input, completed: ['Review'], pending: [], nextAction: 'Deploy' });
    const packet = memory.compile({ query: 'unrelated', taskId: 'task', maxTokens: 10000, asOf: day(3), knownAt: day(4) });
    expect(packet.items.map(item => item.id)).toEqual([old.id]);
    expect(packet.text).not.toContain(latest.id);
    expect(memory.compile({ query: 'unrelated', taskId: 'task', maxTokens: 10000 }).items.map(item => item.id)).toEqual([latest.id]);
    expect(memory.isEligible(derived.id, { asOf: day(3), knownAt: day(10) })).toBe(true);
    expect(memory.isEligible(derived.id)).toBe(false);
  });

  it('uses the requested clocks through hybrid compilation and asynchronous corrections', async () => {
    let current = 2; const memory = open(() => new Date(day(current)));
    const original = memory.store({ text: 'Protocol uses port 443', source, trust: 'observed', validFrom: day(1) });
    const derived = memory.store({ text: 'Protocol recipe uses port 443', source, trust: 'observed', dependencies: [original.id] });
    await memory.indexEmbeddings({ embedder });
    const packet = await memory.compileHybrid({ query: 'protocol', maxTokens: 10000, asOf: day(3), knownAt: day(4) }, {
      embedder: { ...embedder, async embed(texts, options) {
        current = 10; memory.correct(original.id, { text: 'Protocol uses port 8443', source, reason: 'Later change', validFrom: day(5) });
        return embedder.embed(texts, options);
      } },
    });
    expect(packet.items.map(item => item.id)).toContain(derived.id);
    expect(packet.items.every(item => item.updatedAt <= day(4))).toBe(true);
    expect((await memory.compileHybrid({ query: 'protocol', maxTokens: 10000, asOf: day(3), knownAt: day(10) }, { embedder })).items.map(item => item.id)).toContain(derived.id);
    expect((await memory.compileHybrid({ query: 'protocol', maxTokens: 10000 }, { embedder })).items.map(item => item.id)).not.toContain(derived.id);
  });
});
