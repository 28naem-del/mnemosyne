import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LedgerEntry, type LocalMemory, type LocalMemoryOptions, type StoreMemoryInput } from '../src/local/index.js';

const opened: LocalMemory[] = [];
const roots: string[] = [];
const source = { uri: 'test://ledger/brief-v1', author: 'owner', observedAt: '2026-01-01T00:00:00.000Z', revision: 'rev-7' };
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
function location(): string { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-ledger-')); roots.push(root); return join(root, 'memory.sqlite'); }
function memory(options: Partial<LocalMemoryOptions> = {}): LocalMemory {
  // The ledger must be provable without a model in the loop, so these cases run
  // on the zero-model path unless a case says otherwise.
  const db = createLocalMemory({ path: ':memory:', workspaceId: 'project', agentId: 'alice', retrieval: 'lexical', ...options });
  opened.push(db); return db;
}
const fact = (text: string, more: Partial<StoreMemoryInput> = {}): StoreMemoryInput => ({ text, source, trust: 'observed', ...more });
const events = (entries: LedgerEntry[]): string[] => entries.map(entry => entry.event);
afterEach(() => { opened.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('provenance and outcome ledger', () => {
  it('records provenance for every store, without copying the source text', () => {
    const db = memory();
    const record = db.store(fact('Catalogue exports use a 1200 x 900 canvas.', { kind: 'decision', key: 'canvas', visibility: 'workspace', validFrom: '2026-01-02T00:00:00.000Z' }));
    const { entries } = db.ledger({ events: ['store'] });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: 'store', memoryId: record.id, workspaceId: 'project', agentId: 'alice' });
    expect(entries[0].provenance).toEqual({
      origin: 'store', sourceUri: 'test://ledger/brief-v1', author: 'owner', observedAt: '2026-01-01T00:00:00.000Z', revision: 'rev-7',
      kind: 'decision', trust: 'observed', visibility: 'workspace', key: 'canvas',
      textSha256: sha('Catalogue exports use a 1200 x 900 canvas.'), textBytes: 42,
      dependencies: [], validFrom: '2026-01-02T00:00:00.000Z',
    });
    expect(JSON.stringify(entries[0])).not.toContain('1200 x 900');
    expect(entries[0].sequence).toBeGreaterThan(0);
    expect(Date.parse(entries[0].recordedAt)).toBeGreaterThan(0);
  });

  it('records declared dependencies so a later replay can rebuild the graph', () => {
    const db = memory();
    const spec = db.store(fact('Owner approval is required before publishing.'));
    const procedure = db.store(fact('Request owner approval, then publish.', { kind: 'procedure', dependencies: [spec.id] }));
    const entry = db.ledger({ events: ['store'], memoryId: procedure.id }).entries[0];
    expect(entry.provenance?.dependencies).toEqual([spec.id]);
  });

  it('records every recall with its query, ranking and latency', () => {
    const db = memory();
    const first = db.store(fact('Catalogue approval is required.'));
    const second = db.store(fact('Catalogue exports need approval from the owner.'));
    const results = db.recall({ query: 'catalogue approval', limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    const entry = db.ledger({ events: ['recall'] }).entries.at(-1)!;
    expect(entry.memoryId).toBeUndefined();
    expect(entry.retrieval).toMatchObject({ querySha256: sha('catalogue approval'), mode: 'lexical', lexicalScoring: 'bm25', limit: 5, returned: results.length });
    expect(entry.retrieval!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(entry.retrieval!.results.map(result => result.memoryId)).toEqual(results.map(result => result.memory.id));
    expect(entry.retrieval!.results.map(result => result.rank)).toEqual(results.map((_, index) => index));
    expect(entry.retrieval!.results[0].score).toBeCloseTo(results[0].score, 10);
    expect([first.id, second.id]).toContain(entry.retrieval!.results[0].memoryId);
  });

  it('records the model identity when the hybrid engine answered the recall', () => {
    const constant = Object.freeze({
      model: 'test-ledger-embedder@1', dimensions: 4,
      embedSync: () => [[0, 1, 0, 0]], embed: async () => [[0, 1, 0, 0]],
      forQueries: () => ({ model: 'test-ledger-embedder@1', dimensions: 4, embed: async () => [[0, 1, 0, 0]] }),
      forPassages: () => ({ model: 'test-ledger-embedder@1', dimensions: 4, embed: async () => [[0, 1, 0, 0]] }),
      close: () => {},
    });
    const db = memory({ retrieval: 'hybrid', embedder: constant });
    db.store(fact('Catalogue approval is required.'));
    db.recall({ query: 'catalogue approval' });
    const entry = db.ledger({ events: ['recall'] }).entries.at(-1)!;
    expect(entry.retrieval).toMatchObject({ mode: 'hybrid', embeddingModel: 'test-ledger-embedder@1' });
  });

  it('records a correction, its reason and the cascade it invalidated', () => {
    const db = memory();
    const spec = db.store(fact('Exports use a 1200 canvas.'));
    const derived = db.store(fact('Resize to the 1200 canvas before publishing.', { kind: 'procedure', dependencies: [spec.id] }));
    const fixed = db.correct(spec.id, { text: 'Exports use a 1600 canvas.', source, reason: 'owner revised the brief' });
    const correction = db.ledger({ events: ['correction'] }).entries;
    expect(correction).toHaveLength(1);
    expect(correction[0]).toMatchObject({ event: 'correction', memoryId: fixed.id });
    expect(correction[0].correction).toEqual({ supersededId: spec.id, correctionId: fixed.id, reason: 'owner revised the brief', invalidatedIds: [derived.id], invalidatedCount: 1 });
    const replacement = db.ledger({ events: ['store'], memoryId: fixed.id }).entries[0];
    expect(replacement.provenance).toMatchObject({ origin: 'correction', supersedes: spec.id });
  });

  it('records an outcome by digest rather than copying its evidence', () => {
    const db = memory();
    const record = db.store(fact('Pad unused canvas space instead of stretching.', { kind: 'procedure' }));
    db.recordOutcome({ memoryId: record.id, success: true, taskId: 'catalogue-1', verifier: 'deterministic:aspect-ratio', evidence: 'ratio invariant held at 1920x1080' });
    const entry = db.ledger({ events: ['outcome'] }).entries[0];
    expect(entry).toMatchObject({ event: 'outcome', memoryId: record.id });
    expect(entry.outcome).toEqual({ taskId: 'catalogue-1', success: true, verifier: 'deterministic:aspect-ratio', evidenceSha256: sha('ratio invariant held at 1920x1080') });
    expect(JSON.stringify(entry)).not.toContain('ratio invariant held');
  });

  it('writes one ledger entry per belief change across a whole session', () => {
    const db = memory();
    const record = db.store(fact('Exports use a 1200 canvas.'));
    db.recall({ query: 'canvas' });
    db.correct(record.id, { text: 'Exports use a 1600 canvas.', source, reason: 'revised' });
    db.recordOutcome({ memoryId: db.recall({ query: 'canvas' })[0].memory.id, success: true, taskId: 't1', verifier: 'v', evidence: 'e' });
    expect(events(db.ledger().entries)).toEqual(['store', 'recall', 'store', 'correction', 'recall', 'outcome']);
  });

  it('erases a record from the ledger and from every past retrieval that returned it', () => {
    const db = memory();
    const record = db.store(fact('Private review code BLUE HERON 42.'));
    db.recall({ query: 'private review code' });
    db.recordOutcome({ memoryId: record.id, success: true, taskId: 't1', verifier: 'v', evidence: 'e' });
    expect(db.ledger({ memoryId: record.id }).entries.length).toBeGreaterThanOrEqual(3);
    db.forget(record.id);
    expect(db.ledger({ memoryId: record.id }).entries).toEqual([]);
    const remaining = db.ledger().entries;
    expect(JSON.stringify(remaining)).not.toContain(record.id);
    const recalls = remaining.filter(entry => entry.event === 'recall');
    expect(recalls).toHaveLength(1);
    expect(recalls[0].retrieval!.results).toEqual([]);
    // The fact that a retrieval happened survives; only the identity is gone.
    expect(recalls[0].retrieval!.returned).toBe(1);
    expect(remaining.filter(entry => entry.event === 'erasure')[0].erasure).toEqual({ deletedCount: 1 });
  });

  it('never writes an entry for a belief change that was rolled back', () => {
    const db = memory();
    db.store(fact('Kept record.'));
    expect(() => db.atomic(() => { db.store(fact('Discarded record.')); throw new Error('rollback'); })).toThrow('rollback');
    const stores = db.ledger({ events: ['store'] }).entries;
    expect(stores).toHaveLength(1);
    expect(stores[0].provenance?.textSha256).toBe(sha('Kept record.'));
  });

  it('pages with a stable cursor and filters by event and record', () => {
    const db = memory();
    const ids = Array.from({ length: 5 }, (_, index) => db.store(fact(`Record number ${index}.`)).id);
    const first = db.ledger({ limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).toBe(first.entries[1].sequence);
    const second = db.ledger({ limit: 2, after: first.nextCursor });
    expect(second.entries.map(entry => entry.sequence)).toEqual([first.nextCursor! + 1, first.nextCursor! + 2]);
    expect(db.ledger({ memoryId: ids[3] }).entries.map(entry => entry.memoryId)).toEqual([ids[3]]);
    expect(db.ledger({ events: ['outcome'] }).entries).toEqual([]);
    expect(() => db.ledger({ events: ['nonsense'] as never })).toThrow();
  });

  it('keeps each agent to its own ledger', () => {
    const path = location();
    const alice = memory({ path });
    const bob = memory({ path, agentId: 'bob' });
    alice.store(fact('Alice wrote this.'));
    bob.store(fact('Bob wrote this.'));
    expect(alice.ledger().entries).toHaveLength(1);
    expect(alice.ledger().entries[0].agentId).toBe('alice');
    expect(bob.ledger().entries).toHaveLength(1);
    expect(bob.ledger().entries[0].agentId).toBe('bob');
  });

  it('records query digests by default, so a query cannot outlive the records it searched', () => {
    // A query is user text and no foreign key can erase it, so recording it
    // verbatim would be a way around forget(). The digest is the default.
    const db = memory();
    const record = db.store(fact('Catalogue approval is required.'));
    db.recall({ query: 'who approved the catalogue' });
    const entry = db.ledger({ events: ['recall'] }).entries.at(-1)!;
    expect(entry.retrieval!.query).toBeUndefined();
    expect(entry.retrieval!.querySha256).toBe(sha('who approved the catalogue'));
    expect(JSON.stringify(entry)).not.toContain('who approved');
    db.forget(record.id);
    expect(JSON.stringify(db.ledger().entries)).not.toContain('who approved');
  });

  it('keeps queries verbatim only when a caller explicitly asks for replayable trajectories', () => {
    const db = memory({ ledger: { queries: 'text' } });
    db.store(fact('Catalogue approval is required.'));
    db.recall({ query: 'who approved the catalogue' });
    const entry = db.ledger({ events: ['recall'] }).entries.at(-1)!;
    expect(entry.retrieval!.query).toBe('who approved the catalogue');
    expect(entry.retrieval!.querySha256).toBe(sha('who approved the catalogue'));
  });

  it('can be switched off entirely, and then records nothing', () => {
    const db = memory({ ledger: false });
    const record = db.store(fact('Nothing is recorded.'));
    db.recall({ query: 'nothing' });
    db.recordOutcome({ memoryId: record.id, success: true, taskId: 't', verifier: 'v', evidence: 'e' });
    expect(db.ledger().entries).toEqual([]);
  });
});
