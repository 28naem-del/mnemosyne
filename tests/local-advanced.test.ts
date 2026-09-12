import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory, type MemoryEmbedder, type StoreMemoryInput } from '../src/local/index.js';

const opened: LocalMemory[] = [];
const roots: string[] = [];
const source = { uri: 'test:advanced' };
const fact = (text: string, rest: Partial<StoreMemoryInput> = {}): StoreMemoryInput => ({ text, source, trust: 'observed', ...rest });
function memory(path = ':memory:', agentId = 'alice', workspaceId = 'project', now?: () => Date): LocalMemory {
  const db = createLocalMemory({ path, agentId, workspaceId, now }); opened.push(db); return db;
}
function location(): string { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-advanced-')); roots.push(root); return join(root, 'memory.db'); }
const date = (day: number) => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const embedder: MemoryEmbedder = {
  model: 'deterministic-test-v1', dimensions: 3,
  async embed(texts) { return texts.map((text) => /automobile|vehicle|car|transport/.test(text) ? [1, 0, 0] : /pizza|food/.test(text) ? [0, 1, 0] : [0, 0, 1]); },
};
afterEach(() => { opened.splice(0).forEach((db) => db.close()); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

describe('scoped pagination and atomic controller operations', () => {
  it('paginates all matching IDs without duplicates and binds cursors to scope and exact filters', () => {
    const path = location(); const db = memory(path); const bob = memory(path, 'bob');
    const expected = Array.from({ length: 13 }, (_, index) => db.store(fact(`record ${index}`, { metadata: { type: 'job', dotted: 'a.b', advisory: false }, visibility: 'workspace' })).id);
    db.store(fact('other value', { metadata: { type: 'jobs' } }));
    db.store(fact('non-string', { metadata: { type: 42 } }));
    db.store(fact('untrusted', { trust: 'untrusted', metadata: { type: 'job' } }));
    const found: string[] = []; let cursor: string | undefined;
    do { const page = db.list({ limit: 4, metadata: { type: 'job' }, cursor }); found.push(...page.items.map((record) => record.id)); cursor = page.nextCursor; } while (cursor);
    expect(found.sort()).toEqual(expected.sort());
    const first = db.list({ limit: 2, metadata: { type: 'job' } });
    expect(() => bob.list({ limit: 2, metadata: { type: 'job' }, cursor: first.nextCursor })).toThrow('Invalid cursor');
    expect(() => db.list({ metadata: { type: 'jobs' }, cursor: first.nextCursor })).toThrow('Invalid cursor');
    expect(() => db.list({ cursor: `${first.nextCursor}x` })).toThrow('Invalid cursor');
    expect(db.list({ metadata: { 'type\" OR 1=1--': 'job' } }).items).toEqual([]);
    expect(() => db.list({ limit: 1001 })).toThrow();
  });

  it('cursors survive reopen and exclude hidden private/workspace rows', () => {
    const path = location(); const db = memory(path);
    Array.from({ length: 5 }, (_, index) => db.store(fact(`visible ${index}`)));
    memory(path, 'bob').store(fact('hidden private'));
    memory(path, 'alice', 'other').store(fact('hidden workspace', { visibility: 'workspace' }));
    const first = db.list({ limit: 2 }); db.close();
    const reopened = memory(path);
    const second = reopened.list({ limit: 100, cursor: first.nextCursor });
    expect([...first.items, ...second.items]).toHaveLength(5);
    expect(second.items.every((record) => record.agentId === 'alice' && record.workspaceId === 'project')).toBe(true);
  });

  it('rolls back batched writes, corrections, outcome and idempotency; supports nested savepoints', () => {
    const db = memory(); const original = db.store(fact('original'));
    expect(() => db.atomic(() => {
      db.store(fact('temporary', { idempotencyKey: 'retry' }));
      db.correct(original.id, { text: 'new', source, reason: 'test' });
      throw new Error('abort batch');
    })).toThrow('abort batch');
    expect(db.get(original.id)?.status).toBe('active');
    expect(db.inspect()).toHaveLength(1);
    const retry = db.store(fact('temporary', { idempotencyKey: 'retry' }));
    db.atomic(() => {
      db.store(fact('outer'));
      expect(() => db.atomic(() => { db.recordOutcome({ memoryId: retry.id, success: false, evidence: 'failed trial', verifier: 'test', taskId: 'trial' }); throw new Error('inner'); })).toThrow('inner');
      db.store(fact('after inner'));
    });
    expect(db.getOutcomeSummary(retry.id).failures).toBe(0);
    expect(db.inspect()).toHaveLength(4);
    expect(() => db.atomic(async () => { db.store(fact('async forbidden')); })).toThrow('synchronous');
    expect(db.inspect()).toHaveLength(4);
  });
});

describe('valid time and knowledge time', () => {
  it('answers late corrections at both clocks without leaking future status', () => {
    let day = 2; const db = memory(':memory:', 'alice', 'project', () => new Date(date(day)));
    const original = db.store(fact('Budget is 10', { key: 'budget', validFrom: date(1) }));
    day = 10;
    const corrected = db.correct(original.id, { text: 'Budget is 20', source, reason: 'late entry', validFrom: date(5) });
    const pastKnowledge = db.recall({ query: 'Budget', asOf: date(6), knownAt: date(7) });
    expect(pastKnowledge.map((hit) => hit.memory.id)).toEqual([original.id]);
    expect(pastKnowledge[0].memory.status).toBe('active');
    expect(pastKnowledge[0].memory.updatedAt).toBe(date(2));
    expect(db.recall({ query: 'Budget', asOf: date(6), knownAt: date(10) }).map((hit) => hit.memory.id)).toEqual([corrected.id]);
    expect(db.recall({ query: 'Budget', asOf: date(3), knownAt: date(10) }).map((hit) => hit.memory.id)).toEqual([original.id]);
    expect(db.recall({ query: 'Budget' }).map((hit) => hit.memory.id)).toEqual([corrected.id]);
    expect(db.get(original.id)?.status).toBe('superseded');
  });

  it('uses half-open validity intervals and defaults a correction to retroactive repair', () => {
    let day = 2; const db = memory(':memory:', 'alice', 'project', () => new Date(date(day)));
    const original = db.store(fact('Policy wrong', { validFrom: date(1), validUntil: date(8) }));
    day = 10;
    const fixed = db.correct(original.id, { text: 'Policy correct', source, reason: 'wrong source' });
    expect(db.recall({ query: 'Policy', asOf: date(1) })[0].memory.id).toBe(fixed.id);
    expect(db.recall({ query: 'Policy', asOf: date(8) })).toEqual([]);
    expect(db.recall({ query: 'Policy', asOf: date(1), knownAt: date(1) })).toEqual([]);
    expect(() => db.store(fact('invalid', { validFrom: date(5), validUntil: date(4) }))).toThrow('validUntil');
    expect(() => db.recall({ query: 'Policy', knownAt: 'yesterday' })).toThrow('ISO');
  });

  it('retains temporal semantics through snapshot v1 and hides later outcomes', () => {
    let day = 2; const db = memory(':memory:', 'alice', 'project', () => new Date(date(day)));
    const original = db.store(fact('Car transport works', { idempotencyKey: 'temporal', validFrom: date(1) }));
    day = 5;
    db.recordOutcome({ memoryId: original.id, success: false, taskId: 'later', verifier: 'test', evidence: 'later failure' });
    expect(db.recall({ query: 'transport', knownAt: date(3) })[0].outcomes.failures).toBe(0);
    expect(db.recall({ query: 'transport', knownAt: date(5) })[0].outcomes.failures).toBe(1);
    day = 10;
    const next = db.correct(original.id, { text: 'Car transport repaired', source, reason: 'repair', validFrom: date(6) });
    const snapshot = db.export(); expect(snapshot.version).toBe(1);
    const restored = memory(':memory:', 'alice', 'project', () => new Date(date(day)));
    restored.import(snapshot);
    expect(restored.recall({ query: 'transport', asOf: date(7) })[0].memory.id).toBe(next.id);
    expect(restored.recall({ query: 'transport', asOf: date(3), knownAt: date(4) })[0].memory.id).toBe(original.id);
  });

  it('does not treat expired conflicting facts as current contradictions', () => {
    const db = memory(':memory:', 'alice', 'project', () => new Date(date(10)));
    db.store(fact('Budget expired', { key: 'budget', validFrom: date(1), validUntil: date(5) }));
    const current = db.store(fact('Budget current', { key: 'budget', validFrom: date(5) }));
    expect(db.isEligible(current.id)).toBe(true);
    expect(db.compile({ query: 'Budget', maxTokens: 10000 }).conflicts).toEqual([]);
  });
});

describe('bounded local semantic retrieval', () => {
  it('finds a meaning match without lexical overlap and packs source citations', async () => {
    const db = memory(); const car = db.store(fact('An automobile transports people'));
    db.store(fact('Pizza is food'));
    expect(db.recall({ query: 'vehicle' })).toEqual([]);
    expect(await db.indexEmbeddings({ embedder })).toEqual({ indexed: 2, skipped: 0, remaining: 0 });
    const recalled = await db.recallHybrid({ query: 'vehicle' }, { embedder });
    expect(recalled.map((entry) => entry.memory.id)).toEqual([car.id]);
    const packet = await db.compileHybrid({ query: 'vehicle', maxTokens: 4000 }, { embedder });
    expect(packet.items.map((record) => record.id)).toEqual([car.id]);
    expect(packet.citations[0].uri).toBe(source.uri);
    expect(packet.tokens).toBeLessThanOrEqual(4000);
  });

  it('resumes incremental indexing after reopen and isolates model revisions and dimensions', async () => {
    const path = location(); const db = memory(path); let calls = 0;
    const tracked = { ...embedder, async embed(texts: readonly string[], options: { signal: AbortSignal }) { calls++; return embedder.embed(texts, options); } };
    for (let index = 0; index < 5; index++) db.store(fact(`automobile ${index}`));
    expect(await db.indexEmbeddings({ embedder: tracked, limit: 2, batchSize: 1 })).toEqual({ indexed: 2, skipped: 0, remaining: 3 });
    db.close(); const reopened = memory(path);
    expect(await reopened.indexEmbeddings({ embedder: tracked })).toEqual({ indexed: 3, skipped: 0, remaining: 0 });
    expect(await reopened.indexEmbeddings({ embedder: tracked })).toEqual({ indexed: 0, skipped: 0, remaining: 0 });
    expect(calls).toBe(3);
    await expect(reopened.indexEmbeddings({ embedder: { ...tracked, dimensions: 2 } })).rejects.toThrow('dimension mismatch');
    expect(await reopened.recallHybrid({ query: 'vehicle' }, { embedder: { ...embedder, model: 'unindexed-v2' } })).toEqual([]);
    expect(await reopened.indexEmbeddings({ embedder: { ...embedder, model: 'new-v2' } })).toMatchObject({ indexed: 5 });
  });

  it('does not leak other agents or workspaces, or retrieve control and untrusted records', async () => {
    const path = location(); const db = memory(path);
    memory(path, 'bob').store(fact('automobile private'));
    memory(path, 'alice', 'other').store(fact('automobile hidden', { visibility: 'workspace' }));
    const control = db.store(fact('vehicle car automobile transport', { metadata: { advisory: false } }));
    db.store(fact('automobile untrusted', { trust: 'untrusted' }));
    const shared = memory(path, 'bob').store(fact('automobile shared', { visibility: 'workspace' }));
    await db.indexEmbeddings({ embedder });
    expect((await db.recallHybrid({ query: 'vehicle' }, { embedder })).map((hit) => hit.memory.id)).toEqual([shared.id]);
    expect(db.list().items.some((record) => record.id === control.id)).toBe(true);
    expect(db.recall({ query: 'vehicle' })).toEqual([]);
    expect(db.compile({ query: 'vehicle', maxTokens: 5000 }).items).toEqual([]);
    expect(db.isEligible(control.id)).toBe(false);
  });

  it('invalidates stale vectors after a correction and deletion, including during provider calls', async () => {
    const db = memory(); const original = db.store(fact('automobile trusted'));
    await db.indexEmbeddings({ embedder });
    let fixed: string | undefined;
    const racing = { ...embedder, async embed(texts: readonly string[], options: { signal: AbortSignal }) {
      fixed = db.correct(original.id, { text: 'pizza repaired', source, reason: 'new source' }).id;
      return embedder.embed(texts, options);
    } };
    expect(await db.recallHybrid({ query: 'vehicle' }, { embedder: racing })).toEqual([]);
    expect(await db.indexEmbeddings({ embedder })).toMatchObject({ indexed: 1 });
    expect((await db.recallHybrid({ query: 'food' }, { embedder }))[0].memory.id).toBe(fixed);
    db.forget(fixed!);
    expect(await db.recallHybrid({ query: 'food' }, { embedder })).toEqual([]);
  });

  it('skips a source that changes during indexing and never persists a late timed-out vector', async () => {
    const db = memory(); const original = db.store(fact('automobile initial'));
    const racing = { ...embedder, async embed(texts: readonly string[], options: { signal: AbortSignal }) {
      db.correct(original.id, { text: 'pizza updated', source, reason: 'changed mid-flight' });
      return embedder.embed(texts, options);
    } };
    expect(await db.indexEmbeddings({ embedder: racing })).toEqual({ indexed: 0, skipped: 1, remaining: 1 });
    let observed: AbortSignal | undefined;
    const slow = { ...embedder, embed(_texts: readonly string[], options: { signal: AbortSignal }) { observed = options.signal; return new Promise<number[][]>(() => {}); } };
    await expect(db.indexEmbeddings({ embedder: slow, timeoutMs: 5 })).rejects.toThrow('timed out');
    expect(observed?.aborted).toBe(true);
    expect(await db.indexEmbeddings({ embedder })).toMatchObject({ indexed: 1 });
  });

  it('honors cancellation and validates model outputs before writing', async () => {
    const db = memory(); db.store(fact('automobile'));
    const controller = new AbortController(); controller.abort(new Error('cancelled by caller'));
    let called = false;
    const tracked = { ...embedder, async embed() { called = true; return [[1, 0, 0]]; } };
    await expect(db.indexEmbeddings({ embedder: tracked, signal: controller.signal })).rejects.toThrow('cancelled');
    expect(called).toBe(false);
    await expect(db.indexEmbeddings({ embedder: { ...embedder, async embed() { return [[1, Number.NaN, 0]]; } } })).rejects.toThrow('finite');
    await expect(db.indexEmbeddings({ embedder: { ...embedder, async embed() { return [[0, 0, 0]]; } } })).rejects.toThrow('nonzero');
    await expect(db.recallHybrid({ query: 'car' }, { embedder: { ...embedder, async embed() { return []; } } })).rejects.toThrow('one query');
    expect(await db.indexEmbeddings({ embedder })).toMatchObject({ indexed: 1 });
  });

  it('rejects forged reranker IDs and rechecks negative evidence after reranking', async () => {
    const db = memory(); const original = db.store(fact('automobile advice'));
    await db.indexEmbeddings({ embedder });
    await expect(db.recallHybrid({ query: 'vehicle' }, { embedder, reranker: { async rerank() { return [{ id: 'forged', score: 1 }]; } } })).rejects.toThrow('unknown');
    const results = await db.recallHybrid({ query: 'vehicle' }, { embedder, reranker: { async rerank(_query, candidates) {
      db.recordOutcome({ memoryId: original.id, success: false, taskId: 'trial', verifier: 'test', evidence: 'execution failed' });
      return candidates.map((memory) => ({ id: memory.id, score: 1 }));
    } } });
    expect(results).toEqual([]);
  });

  it('rejects transitive failed or conflicted evidence even when vectors match', async () => {
    const db = memory(); const sourceMemory = db.store(fact('Budget is 10', { key: 'budget' }));
    const advice = db.store(fact('automobile recommendation', { dependencies: [sourceMemory.id] }));
    await db.indexEmbeddings({ embedder });
    expect(db.isEligible(advice.id)).toBe(true);
    db.store(fact('Budget is 20', { key: 'budget' }));
    expect(db.isEligible(advice.id)).toBe(false);
    expect(await db.recallHybrid({ query: 'vehicle' }, { embedder })).toEqual([]);
  });

  it('bounds SQL candidate materialization while keeping an older precise hit first', () => {
    const db = memory(); const exact = db.store(fact('release precise ALPHA728'));
    db.atomic(() => { for (let index = 0; index < 1300; index++) db.store(fact(`release generic ${index}`)); });
    expect(db.recall({ query: 'release ALPHA728', limit: 1, maxCandidates: 10 })[0].memory.id).toBe(exact.id);
    expect(() => db.recall({ query: 'release', maxCandidates: 10001 })).toThrow();
  });
});
