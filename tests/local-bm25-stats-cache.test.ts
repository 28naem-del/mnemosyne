import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory, type StoreMemoryInput } from '../src/local/index.js';

/**
 * `#bm25Recall` used to recompute `documents`/`totalLength` (and per-term
 * document frequency) with a full scan of the scoped corpus on every single
 * call — the reason lexical p95 blew its budget at 1M records. This suite
 * pins the fix: those corpus-wide constants are cached and invalidated on
 * write, and — the genuinely hard part — a *live* (non-historical) cache
 * entry must not survive a validFrom/validUntil boundary crossed by clock
 * advance alone, since that changes which documents are in scope with no
 * write to invalidate against.
 *
 * The `prepare` spy asserts on the corpus-stats query specifically (unique
 * substring `AS temporal_data,s.token_count`, present nowhere else in the
 * class), not on `#bm25Recall` as a whole — the term-indexed candidates
 * query legitimately runs on every call regardless of caching.
 */
const opened: LocalMemory[] = [];
const day = (value: number) => `2026-09-${String(value).padStart(2, '0')}T00:00:00.000Z`;
const fact = (text: string, extra: Partial<StoreMemoryInput> = {}): StoreMemoryInput => ({ text, trust: 'observed', source: { uri: 'test:bm25-cache' }, ...extra });
function memory(agentId = 'alice', workspaceId = 'test', now?: () => Date) {
  const db = createLocalMemory({ path: ':memory:', agentId, workspaceId, retrieval: 'lexical', now });
  opened.push(db); return db;
}
function countCorpusStatsCalls(): { calls: () => number } {
  const prepare = DatabaseSync.prototype.prepare; let calls = 0;
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: DatabaseSync, sql: string) {
    if (sql.includes('AS temporal_data,s.token_count')) calls++;
    return prepare.call(this, sql);
  });
  return { calls: () => calls };
}
afterEach(() => { vi.restoreAllMocks(); opened.splice(0).forEach(db => db.close()); });

describe('BM25 corpus statistics cache', () => {
  it('reuses cached corpus statistics across live queries with different terms, and invalidates on a write', () => {
    const db = memory();
    db.store(fact('widget alpha'));
    db.store(fact('gadget beta'));
    const probe = countCorpusStatsCalls();
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(1); // first call: cache miss, one full scan
    db.recall({ query: 'gadget', lexicalScoring: 'bm25' });
    db.recall({ query: 'widget alpha', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(1); // same scope, different terms: no rescan
    db.store(fact('widget gamma'));
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(2); // a write invalidates the cached entry
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(2); // and the new value is cached again
  });

  it('keeps a distinct cache entry per scope signature (includeUntrusted, kinds) so entries never leak across scope', () => {
    const db = memory();
    db.store(fact('widget alpha'));
    db.store(fact('widget beta', { trust: 'untrusted' }));
    db.store(fact('widget gamma', { kind: 'decision' }));
    const probe = countCorpusStatsCalls();
    const plain = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(1);
    const trusted = db.recall({ query: 'widget', lexicalScoring: 'bm25', includeUntrusted: true });
    expect(probe.calls()).toBe(2); // different includeUntrusted: separate cache entry
    const decisionOnly = db.recall({ query: 'widget', lexicalScoring: 'bm25', kinds: ['decision'] });
    expect(probe.calls()).toBe(3); // different kinds filter: separate cache entry
    // Repeating each scope hits its own cached entry, not a shared/blended one.
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    db.recall({ query: 'widget', lexicalScoring: 'bm25', includeUntrusted: true });
    db.recall({ query: 'widget', lexicalScoring: 'bm25', kinds: ['decision'] });
    expect(probe.calls()).toBe(3);
    expect(plain.map(r => r.memory.id).sort()).toEqual([...plain.map(r => r.memory.id)].sort());
    expect(trusted.length).toBeGreaterThan(plain.length);
    expect(decisionOnly).toHaveLength(1);
  });

  it('caches identical historical (asOf/knownAt) queries and recomputes for a different historical instant', () => {
    const db = memory();
    db.store(fact('widget one'));
    db.store(fact('widget two'));
    const probe = countCorpusStatsCalls();
    db.recall({ query: 'widget', lexicalScoring: 'bm25', asOf: day(10), knownAt: day(10) });
    expect(probe.calls()).toBe(1);
    db.recall({ query: 'widget', lexicalScoring: 'bm25', asOf: day(10), knownAt: day(10) });
    expect(probe.calls()).toBe(1); // same historical instant: cached
    db.recall({ query: 'widget', lexicalScoring: 'bm25', asOf: day(11), knownAt: day(11) });
    expect(probe.calls()).toBe(2); // a different historical instant: never collides
  });

  it('keeps live BM25 statistics correct across a validFrom boundary crossed by clock advance alone, with no write in between', () => {
    let current = 1;
    const db = memory('alice', 'test', () => new Date(day(current)));
    const anchor = db.store(fact('widget alpha')); // 2 tokens, no temporal bounds
    // Out of live scope until day(5); never matches the query term either way,
    // so the only way it can move `anchor`'s score is through documents/totalLength.
    db.store(fact('gizmo filler unrelated words entirely', { validFrom: day(5) })); // 5 tokens
    const probe = countCorpusStatsCalls();
    const before = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(before.map(r => r.memory.id)).toEqual([anchor.id]);
    const avgBefore = 2 / 1; // only `anchor` is in scope: documents=1, totalLength=2
    const expectedBefore = Math.log1p((1 - 1 + 0.5) / (1 + 0.5)) * (1 * 2.2) / (1 + 1.2 * (0.25 + 0.75 * 2 / avgBefore));
    expect(before[0].score).toBeCloseTo(expectedBefore, 12);

    current = 6; // no write in between — validFrom(day 5) is now in the past
    const after = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(after.map(r => r.memory.id)).toEqual([anchor.id]); // gizmo still never matches 'widget'
    const avgAfter = (2 + 5) / 2; // gizmo has entered scope: documents=2, totalLength=7
    const expectedAfter = Math.log1p((2 - 1 + 0.5) / (1 + 0.5)) * (1 * 2.2) / (1 + 1.2 * (0.25 + 0.75 * 2 / avgAfter));
    expect(after[0].score).toBeCloseTo(expectedAfter, 12);
    expect(after[0].score).not.toBeCloseTo(before[0].score, 6);
    // A workspace that has ever stored a validFrom/validUntil record disables
    // the live cache for that workspace entirely, so every call up to here
    // recomputed rather than trusting a stale cached document count.
    expect(probe.calls()).toBe(2);
  });

  it('keeps live BM25 statistics correct across a validUntil boundary crossed by clock advance alone, with no write in between', () => {
    let current = 1;
    const db = memory('alice', 'test', () => new Date(day(current)));
    const anchor = db.store(fact('widget alpha')); // 2 tokens
    db.store(fact('gizmo filler unrelated words entirely', { validUntil: day(5) })); // 5 tokens, expires day(5)
    const before = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    const avgBefore = (2 + 5) / 2; // gizmo still valid: documents=2
    const expectedBefore = Math.log1p((2 - 1 + 0.5) / (1 + 0.5)) * (1 * 2.2) / (1 + 1.2 * (0.25 + 0.75 * 2 / avgBefore));
    expect(before[0].score).toBeCloseTo(expectedBefore, 12);

    current = 6; // no write — gizmo's validUntil has now passed
    const after = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(after.map(r => r.memory.id)).toEqual([anchor.id]);
    const avgAfter = 2 / 1; // gizmo has left scope: documents=1
    const expectedAfter = Math.log1p((1 - 1 + 0.5) / (1 + 0.5)) * (1 * 2.2) / (1 + 1.2 * (0.25 + 0.75 * 2 / avgAfter));
    expect(after[0].score).toBeCloseTo(expectedAfter, 12);
    expect(after[0].score).not.toBeCloseTo(before[0].score, 6);
  });

  /**
   * The flag only has to answer one question: can this record's scope
   * membership still change from clock advance alone? A bound that is already
   * in the past cannot — `validFrom <= now` with no `validUntil` is in scope
   * now and stays in scope, and `validUntil <= now` is out and stays out. The
   * four tests below pin both halves of that: the past-bound cases keep the
   * live cache, the future-bound cases give it up.
   */
  it('keeps the live cache after correct(): a correction inherits a past validFrom, which can never move by clock advance', () => {
    const db = memory();
    const first = db.store(fact('widget alpha'));
    db.store(fact('gadget beta'));
    // correct() always writes a validFrom (`previous.validFrom ?? previous.createdAt`),
    // so a presence-only flag would permanently disable this workspace's live cache.
    const corrected = db.correct(first.id, { text: 'widget alpha revised', source: { uri: 'test:bm25-cache' }, reason: 'clarify' });
    expect(corrected.validFrom).toBeDefined();
    const probe = countCorpusStatsCalls();
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(1); // first call: cache miss
    db.recall({ query: 'gadget', lexicalScoring: 'bm25' });
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(1); // the correction must not have disabled live caching
  });

  it('keeps the live cache for a validFrom already in the past at insert: in scope now, and no later instant removes it', () => {
    let current = 10;
    const db = memory('alice', 'test', () => new Date(day(current)));
    db.store(fact('widget alpha', { validFrom: day(2) }));
    db.store(fact('gadget beta'));
    const probe = countCorpusStatsCalls();
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(1);
    current = 11; // clock advance with no write cannot change this record's membership
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    db.recall({ query: 'gadget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(1);
  });

  it('keeps the live cache for a validUntil already expired at insert: out of scope now, and it stays out', () => {
    let current = 10;
    const db = memory('alice', 'test', () => new Date(day(current)));
    db.store(fact('widget alpha'));
    db.store(fact('gizmo filler unrelated words entirely', { validFrom: day(2), validUntil: day(5) }));
    const probe = countCorpusStatsCalls();
    const before = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(1);
    current = 11;
    const after = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(1); // expired before it was ever stored: nothing left to cross
    // ...and the cached statistics are the right ones: the expired record is excluded.
    const expected = Math.log1p((1 - 1 + 0.5) / (1 + 0.5)) * (1 * 2.2) / (1 + 1.2 * (0.25 + 0.75 * 2 / (2 / 1)));
    expect(before[0].score).toBeCloseTo(expected, 12);
    expect(after[0].score).toBeCloseTo(expected, 12);
  });

  it('gives up the live cache for a future-dated validFrom: the record enters scope later by clock advance alone', () => {
    let current = 1;
    const db = memory('alice', 'test', () => new Date(day(current)));
    db.store(fact('widget alpha'));
    db.store(fact('gizmo filler unrelated words entirely', { validFrom: day(5) }));
    const probe = countCorpusStatsCalls();
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(3); // no live entry is cached at all while a crossing is pending
  });

  it('gives up the live cache for a validUntil still in the future: the record leaves scope later by clock advance alone', () => {
    let current = 1;
    const db = memory('alice', 'test', () => new Date(day(current)));
    db.store(fact('widget alpha'));
    db.store(fact('gizmo filler unrelated words entirely', { validUntil: day(5) }));
    const probe = countCorpusStatsCalls();
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(2);
    current = 6; // the boundary is crossed with no write in between
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(3);
  });

  it('gives up the live cache for an imported record whose validFrom is past for the producer but still future for the importer', () => {
    // `record.createdAt` is no guide to whether a bound has been crossed *here*:
    // on the import path it came off the producing machine's clock, and
    // `#snapshotRecord` deliberately does not bound it to the importer's
    // present. A producer running ahead writes a validFrom that is already past
    // for it and still future for the reader, so the baseline has to be the
    // reader's own clock.
    const producer = memory('alice', 'producer-clock-ahead', () => new Date(day(10)));
    producer.store(fact('widget gamma imported', { validFrom: day(5) })); // past for the producer
    const snapshot = { ...producer.export(), workspaceId: 'test' };
    snapshot.memories = snapshot.memories.map(record => ({ ...record, workspaceId: 'test' }));

    // A real file, so a second connection can read the same database as ground truth.
    const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-import-'));
    const path = join(root, 'memory.sqlite');
    let current = 1; // the importer is nine days behind the producer
    const db = createLocalMemory({ path, agentId: 'alice', workspaceId: 'test', retrieval: 'lexical', now: () => new Date(day(current)) });
    opened.push(db);
    const anchor = db.store(fact('widget alpha'));
    db.import(snapshot);
    const probe = countCorpusStatsCalls();
    const before = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(before.map(r => r.memory.id)).toEqual([anchor.id]); // the import is not in scope yet

    current = 11; // day(5)/day(10) crossed by clock advance alone, with no write
    const after = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    const live = probe.calls(); // read before the ground-truth connection below adds its own
    // Ground truth: the same store read by a connection that never cached anything.
    const cold = createLocalMemory({ path, agentId: 'alice', workspaceId: 'test', retrieval: 'lexical', now: () => new Date(day(11)) });
    opened.push(cold);
    const truth = cold.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(truth).toHaveLength(2);
    expect(after.map(r => [r.memory.id, r.score])).toEqual(truth.map(r => [r.memory.id, r.score]));
    // A stale-low `documents` against a live `df` sends IDF negative and
    // #bm25Recall's `score > 0` gate drops BOTH rows — including `anchor`,
    // which has nothing to do with the import. Guard that explicitly.
    expect(after.map(r => r.memory.id)).toContain(anchor.id);
    expect(live).toBe(2); // nothing is cached live while a crossing is pending
    rmSync(root, { recursive: true, force: true });
  });

  it('scopes the temporal-bounds flag per workspace: a validFrom record in one workspace does not disable the live cache in another', () => {
    // node:sqlite's `:memory:` is a distinct database per connection, so use a
    // real temp file to actually share one database across two workspaces.
    const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-cache-'));
    const path = join(root, 'memory.sqlite');
    const withBounds = createLocalMemory({ path, agentId: 'alice', workspaceId: 'bounded', retrieval: 'lexical' });
    const plain = createLocalMemory({ path, agentId: 'alice', workspaceId: 'plain', retrieval: 'lexical' });
    opened.push(withBounds, plain);
    // Far-future so the bound is genuinely uncrossed under the real clock this
    // pair of connections uses; a validFrom already in the past would (rightly)
    // not set the flag at all and leave this test asserting nothing.
    withBounds.store(fact('widget alpha', { validFrom: '2099-01-01T00:00:00.000Z' }));
    plain.store(fact('widget one'));
    plain.store(fact('widget two'));
    const probe = countCorpusStatsCalls();
    plain.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(1);
    plain.recall({ query: 'widget', lexicalScoring: 'bm25' });
    // The other workspace's validFrom record must not disable this one's cache.
    expect(probe.calls()).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
});
