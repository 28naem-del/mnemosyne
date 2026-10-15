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

  it('gives up the live cache for an imported record dated into the importer\'s future by createdAt alone, with no validFrom at all', () => {
    // The scope test is `(validFrom ?? createdAt) <= asOf`, so `createdAt`
    // carries the lower bound whenever `validFrom` is absent. A record with no
    // temporal bound whatsoever is still out of scope now and in scope later if
    // it was written by a clock ahead of this one. Only reachable via import():
    // every local write path takes createdAt from this same clock.
    const producer = memory('alice', 'producer-clock-ahead', () => new Date(day(10)));
    producer.store(fact('widget gamma imported')); // no validFrom, no validUntil — createdAt is day(10)
    const snapshot = { ...producer.export(), workspaceId: 'test' };
    snapshot.memories = snapshot.memories.map(record => ({ ...record, workspaceId: 'test' }));
    expect(snapshot.memories.every(record => record.validFrom === undefined)).toBe(true);

    const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-created-'));
    const path = join(root, 'memory.sqlite');
    let current = 1; // the importer is nine days behind the producer
    const db = createLocalMemory({ path, agentId: 'alice', workspaceId: 'test', retrieval: 'lexical', now: () => new Date(day(current)) });
    opened.push(db);
    const anchor = db.store(fact('widget alpha'));
    db.import(snapshot);
    const probe = countCorpusStatsCalls();
    const before = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(before.map(r => r.memory.id)).toEqual([anchor.id]); // not in scope yet

    current = 11; // createdAt day(10) crossed by clock advance alone, with no write
    const after = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    const live = probe.calls();
    const cold = createLocalMemory({ path, agentId: 'alice', workspaceId: 'test', retrieval: 'lexical', now: () => new Date(day(11)) });
    opened.push(cold);
    const truth = cold.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(truth).toHaveLength(2);
    expect(after.map(r => [r.memory.id, r.score])).toEqual(truth.map(r => [r.memory.id, r.score]));
    expect(after.map(r => r.memory.id)).toContain(anchor.id); // the unrelated local row must survive
    expect(live).toBe(2); // nothing cached live while a crossing is pending
    rmSync(root, { recursive: true, force: true });
  });

  it('gives up the live cache for a backdated import: past validFrom, but a createdAt still future for the importer', () => {
    // `m.created_at<=knownAt` is its OWN conjunct in #bm25Recall's scope,
    // independent of validFrom. So `validFrom ?? createdAt` is not a mirror of
    // the SQL — it drops createdAt exactly when validFrom is present, which is
    // the backdated case: "true since 2020", recorded on a clock running fast.
    const producer = memory('alice', 'producer-clock-ahead', () => new Date(day(10)));
    // validFrom must be past for the *importer* (day(1)), not merely for the producer —
    // otherwise `validFrom > now` catches it and this never exercises the createdAt clause.
    producer.store(fact('widget gamma imported', { validFrom: '2026-08-01T00:00:00.000Z' }));
    const snapshot = { ...producer.export(), workspaceId: 'test' };
    snapshot.memories = snapshot.memories.map(record => ({ ...record, workspaceId: 'test' }));

    const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-backdated-'));
    const path = join(root, 'memory.sqlite');
    let current = 1;
    const db = createLocalMemory({ path, agentId: 'alice', workspaceId: 'test', retrieval: 'lexical', now: () => new Date(day(current)) });
    opened.push(db);
    const anchor = db.store(fact('widget alpha'));
    db.import(snapshot);
    const probe = countCorpusStatsCalls();
    expect(db.recall({ query: 'widget', lexicalScoring: 'bm25' }).map(r => r.memory.id)).toEqual([anchor.id]);

    current = 11; // createdAt day(10) crossed by clock advance alone
    const after = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    const live = probe.calls();
    const cold = createLocalMemory({ path, agentId: 'alice', workspaceId: 'test', retrieval: 'lexical', now: () => new Date(day(11)) });
    opened.push(cold);
    const truth = cold.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(truth).toHaveLength(2);
    expect(after.map(r => [r.memory.id, r.score])).toEqual(truth.map(r => [r.memory.id, r.score]));
    expect(after.map(r => r.memory.id)).toContain(anchor.id);
    expect(live).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  it('gives up the live cache for an imported superseded record whose updatedAt is still future for the importer', () => {
    // #at() only filters `superseded`/`invalidated` once `updatedAt <= knownAt`,
    // so updatedAt is a fourth clock-dependent field. Here `documents` goes
    // stale-HIGH rather than low, so scores inflate instead of rows vanishing.
    // createdAt must be PAST for the importer and updatedAt FUTURE, so that only the
    // updatedAt clause can fire: store at day(1), supersede at day(10), import at day(2).
    let producerNow = 1;
    const producer = memory('alice', 'producer-clock-ahead', () => new Date(day(producerNow)));
    const original = producer.store(fact('widget original text here'));
    producerNow = 10;
    producer.correct(original.id, { text: 'widget corrected text here', reason: 'revised', source: { uri: 'test:bm25-cache' } });
    const exported = producer.export();
    // Keep ONLY the superseded original: the correction itself carries createdAt=day(10),
    // which would be future for the importer and flag via createdAt instead.
    const snapshot = { ...exported, workspaceId: 'test', idempotency: [], outcomes: [],
      memories: exported.memories.filter(r => r.status === 'superseded').map(record => ({ ...record, workspaceId: 'test' })) };
    expect(snapshot.memories).toHaveLength(1);
    expect(snapshot.memories[0].createdAt).toBe(day(1));   // past for the importer at day(2)
    expect(snapshot.memories[0].updatedAt).toBe(day(10));  // still future for it

    const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-updated-'));
    const path = join(root, 'memory.sqlite');
    let current = 2;
    const db = createLocalMemory({ path, agentId: 'alice', workspaceId: 'test', retrieval: 'lexical', now: () => new Date(day(current)) });
    opened.push(db);
    db.store(fact('widget survivor local row'));
    db.import(snapshot);
    const probe = countCorpusStatsCalls();
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });

    current = 11; // updatedAt crossed by clock advance alone, with no write
    const after = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    const live = probe.calls();
    const cold = createLocalMemory({ path, agentId: 'alice', workspaceId: 'test', retrieval: 'lexical', now: () => new Date(day(11)) });
    opened.push(cold);
    const truth = cold.recall({ query: 'widget', lexicalScoring: 'bm25' });
    // Scores, not just ids: this hazard inflates scores rather than dropping rows.
    expect(after.map(r => [r.memory.id, r.score])).toEqual(truth.map(r => [r.memory.id, r.score]));
    expect(live).toBe(2);
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

  /**
   * Everything above invalidates a live entry for a boundary the clock has yet
   * to reach. The opposite direction is the one `markTemporalBoundsIfNeeded`
   * explicitly declines to flag — "already `<= now` at insert, so it can never
   * be crossed again" — and that argument holds only while the clock runs
   * *forwards*. `#time()` does not check that it does, and
   * `LocalMemoryOptions.now` is a public constructor option with no
   * monotonicity contract, so an NTP step, a sleep/resume, a VM snapshot
   * restore or a caller's own clock can move `now` backwards across a warm
   * entry. No write happens, so `writeSeq`/`dataVersion` cannot fire, and no
   * sticky flag can either. The two tests below pin both damage directions:
   * stale-HIGH `documents` (inflated scores) and stale-LOW (total recall loss).
   */
  it('recomputes live statistics when the reader clock steps backwards, with no temporal bound anywhere in the workspace', () => {
    // Nothing here is flagged and nothing should be: every instant came off
    // this engine's own clock and was already `<= now` at insert. That is
    // precisely the workspace the live cache is designed to serve, which is
    // what makes a backward step dangerous rather than merely inefficient.
    const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-stepback-'));
    const path = join(root, 'memory.sqlite');
    let current = 3;
    const db = createLocalMemory({ path, agentId: 'alice', workspaceId: 'test', retrieval: 'lexical', now: () => new Date(day(current)) });
    opened.push(db);
    db.store(fact('widget alpha report'));
    db.store(fact('widget beta report'));
    current = 12; // the clock advances normally, and two more rows are written
    db.store(fact('gadget gamma notice'));
    db.store(fact('gadget delta notice'));
    const check = new DatabaseSync(path);
    expect(check.prepare('SELECT 1 FROM local_settings WHERE key=?').get('bm25-temporal-bounds:test')).toBeUndefined();
    check.close();

    db.recall({ query: 'widget', lexicalScoring: 'bm25' }); // warms the live entry at documents=4
    const probe = countCorpusStatsCalls();
    current = 3; // the reader's clock STEPS BACK. No write in between.
    const after = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    const live = probe.calls(); // read before the ground-truth connection adds its own
    // Ground truth: the same database read at day(3) by a connection that never cached.
    const cold = createLocalMemory({ path, agentId: 'alice', workspaceId: 'test', retrieval: 'lexical', now: () => new Date(day(3)) });
    opened.push(cold);
    const truth = cold.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(truth).toHaveLength(2); // `m.created_at<=knownAt` puts the two day(12) rows back out of scope
    const pairs = (rows: typeof truth) => rows.map(r => [r.memory.id, r.score] as const).sort((a, b) => a[0].localeCompare(b[0]));
    expect(pairs(after)).toEqual(pairs(truth));
    expect(live).toBe(1); // the step-back is a miss: documents=4 must not be served at day(3)
    rmSync(root, { recursive: true, force: true });
  });

  it('recomputes live statistics when the reader clock steps back behind an import whose validUntil had already expired', () => {
    // "`validUntil <= now` — already expired, and a larger `asOf` keeps it
    // expired. Safe to cache." Only under a monotone clock: a step back to
    // before `validUntil` puts both imported rows back in scope. `documents`
    // then runs stale-LOW against a live `df`, IDF turns negative and
    // #bm25Recall's `score > 0` gate drops every row — silent, total recall
    // loss, including the purely local row that has nothing to do with the import.
    const producer = memory('alice', 'producer', () => new Date(day(1)));
    producer.store(fact('widget alpha report', { validUntil: day(5) }));
    producer.store(fact('widget beta report', { validUntil: day(5) }));
    const exported = producer.export();
    const snapshot = { ...exported, workspaceId: 'test', idempotency: [], outcomes: [],
      memories: exported.memories.map(record => ({ ...record, workspaceId: 'test' })) };

    const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-stepback-expired-'));
    const path = join(root, 'memory.sqlite');
    let current = 10; // the importer's clock is well past the imported validUntil
    const db = createLocalMemory({ path, agentId: 'alice', workspaceId: 'test', retrieval: 'lexical', now: () => new Date(day(current)) });
    opened.push(db);
    const anchor = db.store(fact('widget survivor local row'));
    db.import(snapshot);
    const check = new DatabaseSync(path);
    // Expired on arrival, so nothing is flagged and the live cache stays on.
    expect(check.prepare('SELECT 1 FROM local_settings WHERE key=?').get('bm25-temporal-bounds:test')).toBeUndefined();
    check.close();

    const warm = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(warm.map(r => r.memory.id)).toEqual([anchor.id]); // documents=1: the imports are expired
    const probe = countCorpusStatsCalls();
    current = 3; // the clock steps BACK behind day(5): both imported rows re-enter scope
    const after = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    const live = probe.calls();
    const cold = createLocalMemory({ path, agentId: 'alice', workspaceId: 'test', retrieval: 'lexical', now: () => new Date(day(3)) });
    opened.push(cold);
    const truth = cold.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(truth).toHaveLength(2); // the anchor's createdAt is day(10), so at day(3) only the two imports are in scope
    expect(after).not.toHaveLength(0); // the failure this guards is returning nothing at all
    const pairs = (rows: typeof truth) => rows.map(r => [r.memory.id, r.score] as const).sort((a, b) => a[0].localeCompare(b[0]));
    expect(pairs(after)).toEqual(pairs(truth));
    expect(live).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });
  it('does not re-cache below the high-water clock, so a forward advance after a step-back cannot serve stale statistics', () => {
    // `computedAt` alone is necessary but NOT sufficient. It makes the
    // step-back itself a miss, but the entry recomputed at the stepped-back
    // instant is then served on the way back up — and everything written while
    // the clock was high is in the reader's future again, unflagged (all of it
    // was `<= now` at insert), so ordinary forward advance re-crosses it with
    // no write. Statistics recomputed below the high-water mark must therefore
    // not be cached at all.
    const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-recross-'));
    const path = join(root, 'memory.sqlite');
    let current = 3;
    const db = createLocalMemory({ path, agentId: 'alice', workspaceId: 'test', retrieval: 'lexical', now: () => new Date(day(current)) });
    opened.push(db);
    db.store(fact('widget alpha report'));
    db.store(fact('widget beta report'));
    current = 12; // two more rows land while the clock is high
    db.store(fact('gadget gamma notice'));
    db.store(fact('gadget delta notice'));
    const recall = () => db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    recall();     // warms documents=4 at day(12)
    current = 3;  // step back: documents=2 is the truth here
    recall();
    current = 20; // and now forward again, past everything
    const after = recall();

    const cold = createLocalMemory({ path, agentId: 'alice', workspaceId: 'test', retrieval: 'lexical', now: () => new Date(day(20)) });
    opened.push(cold);
    const truth = cold.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(truth).toHaveLength(2); // only the two 'widget' rows match, but over documents=4
    const pairs = (rows: typeof truth) => rows.map(r => [r.memory.id, r.score] as const).sort((a, b) => a[0].localeCompare(b[0]));
    expect(pairs(after)).toEqual(pairs(truth));
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps caching live statistics once the clock has climbed back to its high-water mark', () => {
    // The high-water rule must not become a permanent opt-out: a connection
    // that sees one backward step should return to normal caching, not spend
    // the rest of its life rescanning the corpus on every query.
    let current = 12;
    const db = memory('alice', 'test', () => new Date(day(current)));
    db.store(fact('widget alpha'));
    db.store(fact('gadget beta'));
    const probe = countCorpusStatsCalls();
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(1);
    current = 3; // below the mark: recomputed every time, never cached
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(3);
    current = 12; // back at the mark: the day(12) entry is valid again
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(3);
    current = 30; // and normal forward advance keeps hitting
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    db.recall({ query: 'widget', lexicalScoring: 'bm25' });
    expect(probe.calls()).toBe(3);
  });
  /**
   * The regression suite for the silent-recall-loss blocker. The existing
   * step-back tests above all warm the cache with a `recall()` at the high
   * instant, which is the one carrier the first version of the guard covered:
   * only `#bm25Recall` fed the high-water mark, so only a *recall* at a high
   * clock was ever remembered. A **write** at a high clock reads the very same
   * clock and was invisible to it. These tests are the same scenarios with the
   * warming recall removed — the mark now comes from `#time()` itself, so every
   * clock reading feeds it whatever the caller was doing.
   */
  describe('a write at a high clock counts as having seen that clock', () => {
    const pairs = (rows: { memory: { id: string }; score: number }[]) =>
      rows.map(r => [r.memory.id, r.score] as const).sort((a, b) => a[0].localeCompare(b[0]));

    it('does not serve statistics cached below a write\'s clock, on retrieval:\'lexical\'', () => {
      // Two rows land at day(12) with NO recall there, so nothing but the write
      // itself ever observes day(12). The clock then steps back to day(3),
      // where the rows are legitimately invisible and `documents` is 0 — and
      // that 0 must not be cached, because ordinary forward advance re-crosses
      // day(12) with no write to invalidate against. Served stale, `documents`
      // runs low, the idf term goes negative and `score > 0` drops every row:
      // 0 results where the truth is 2, indefinitely.
      const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-writeclock-lexical-'));
      const path = join(root, 'memory.sqlite');
      let current = 12;
      const db = createLocalMemory({ path, agentId: 'alice', workspaceId: 'test', retrieval: 'lexical', now: () => new Date(day(current)) });
      opened.push(db);
      db.store(fact('widget alpha'));
      db.store(fact('widget beta'));

      current = 3; // backward step (NTP correction, snapshot restore, sleep/resume)
      expect(db.recall({ query: 'widget', lexicalScoring: 'bm25' })).toHaveLength(0); // correct: created_at is day(12)

      const probe = countCorpusStatsCalls();
      current = 20; // the clock recovers and moves on past the writes
      const after = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
      const recomputed = probe.calls();
      vi.restoreAllMocks();

      const cold = createLocalMemory({ path, agentId: 'alice', workspaceId: 'test', retrieval: 'lexical', now: () => new Date(day(20)) });
      opened.push(cold);
      const truth = cold.recall({ query: 'widget', lexicalScoring: 'bm25' });
      expect(truth).toHaveLength(2);
      expect(after).toHaveLength(2);        // the defect returned 0 here
      expect(pairs(after)).toEqual(pairs(truth)); // ...and, when it returned rows at all, deflated their scores
      expect(recomputed).toBe(1);           // 0 would mean the stepped-back entry was served
      rmSync(root, { recursive: true, force: true });
    });

    it('does not serve statistics cached below a write\'s clock, on retrieval:\'hybrid\'', () => {
      // Same carrier on the default-shaped hybrid path. The embedder is
      // constant, so every row ties on the dense side and RRF cannot paper over
      // a collapsed lexical stage the way it does when dense ranking happens to
      // agree — which is exactly why the audit could demonstrate total loss
      // only on 'lexical'. What is asserted here is the defect itself: the
      // corpus statistics must be recomputed rather than served from the entry
      // built at the stepped-back instant, and the answer must match a cold
      // engine at the same instant.
      const constant = Object.freeze({
        model: 'test-bm25-clock-embedder@1', dimensions: 4,
        embedSync: (texts: string[]) => texts.map(() => [0, 1, 0, 0]),
        embed: async (texts: string[]) => texts.map(() => [0, 1, 0, 0]),
        forQueries: () => ({ model: 'test-bm25-clock-embedder@1', dimensions: 4, embed: async (texts: string[]) => texts.map(() => [0, 1, 0, 0]) }),
        forPassages: () => ({ model: 'test-bm25-clock-embedder@1', dimensions: 4, embed: async (texts: string[]) => texts.map(() => [0, 1, 0, 0]) }),
        close: () => {},
      });
      const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-writeclock-hybrid-'));
      const path = join(root, 'memory.sqlite');
      let current = 12;
      const options = { path, agentId: 'alice', workspaceId: 'test', retrieval: 'hybrid' as const, embedder: constant };
      const db = createLocalMemory({ ...options, now: () => new Date(day(current)) });
      opened.push(db);
      db.store(fact('widget alpha'));
      db.store(fact('widget beta'));

      current = 3;
      expect(db.recall({ query: 'widget', lexicalScoring: 'bm25' })).toHaveLength(0);

      const probe = countCorpusStatsCalls();
      current = 20;
      const after = db.recall({ query: 'widget', lexicalScoring: 'bm25' });
      const recomputed = probe.calls();
      vi.restoreAllMocks();

      const cold = createLocalMemory({ ...options, now: () => new Date(day(20)) });
      opened.push(cold);
      const truth = cold.recall({ query: 'widget', lexicalScoring: 'bm25' });
      expect(truth).toHaveLength(2);
      expect(after.map(r => r.memory.id).sort()).toEqual(truth.map(r => r.memory.id).sort());
      expect(recomputed).toBe(1); // 0 would mean the stepped-back entry was served
      rmSync(root, { recursive: true, force: true });
    });

    it('leaves a monotone clock caching exactly as before, writes included', () => {
      // The guard must cost nothing on the path everyone is actually on. A
      // clock that only ever advances never reads below its own mark, so the
      // comparison is false every time and caching is untouched: one recompute
      // for the first recall, one more after each write, and nothing else.
      let current = 3;
      const db = memory('alice', 'test', () => new Date(day(current)));
      db.store(fact('widget alpha'));
      db.store(fact('widget beta'));
      const probe = countCorpusStatsCalls();
      const recall = () => db.recall({ query: 'widget', lexicalScoring: 'bm25' });

      recall();
      expect(probe.calls()).toBe(1);
      current = 5; recall();
      current = 6; recall(); recall();
      expect(probe.calls()).toBe(1);   // forward advance keeps hitting

      current = 12;
      db.store(fact('widget gamma')); // a write at a *higher* clock than any recall so far
      current = 13; recall();
      expect(probe.calls()).toBe(2);   // the write invalidated, the clock did not
      current = 20; recall(); recall();
      expect(probe.calls()).toBe(2);
    });

    it('does not treat a caller-supplied historical asOf as a backward clock step', () => {
      // `#time()` only ever sees `this.#now()`, so an `asOf` in the past is a
      // query parameter and not a clock reading. It must neither raise the mark
      // nor be tested against it: a historical view is keyed by its own literal
      // instants and stays cacheable however far back the caller looks.
      let current = 20;
      const db = memory('alice', 'test', () => new Date(day(current)));
      db.store(fact('widget alpha'));
      db.store(fact('widget beta'));
      const probe = countCorpusStatsCalls();

      db.recall({ query: 'widget', lexicalScoring: 'bm25' });
      expect(probe.calls()).toBe(1);
      db.recall({ query: 'widget', lexicalScoring: 'bm25', asOf: day(25) }); // historical, its own key
      db.recall({ query: 'widget', lexicalScoring: 'bm25', asOf: day(25) }); // ...and still cached
      expect(probe.calls()).toBe(2);
      db.recall({ query: 'widget', lexicalScoring: 'bm25' }); // the live entry survived the excursion
      expect(probe.calls()).toBe(2);
      current = 21;
      db.recall({ query: 'widget', lexicalScoring: 'bm25' });
      expect(probe.calls()).toBe(2); // the past asOf never became the high-water mark
    });
    it('does not serve statistics cached below a clock another connection wrote at', () => {
      // The cross-connection carrier `noteLiveClock` cannot reach: the writer
      // commits at day(12) and closes *before* the reader exists, so the
      // reader's `writeSeq` is 0 and `PRAGMA data_version` is already final —
      // neither counter can move. The reader's first clock reading is day(3),
      // which is its own high-water mark, so nothing looks like a step back.
      // The store's own `created_at` is the evidence that some engine read a
      // clock that high, and seeding from it is what closes this.
      const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-writeclock-crossconn-'));
      const path = join(root, 'memory.sqlite');
      const shared = { path, workspaceId: 'test', retrieval: 'lexical' as const };

      const writer = createLocalMemory({ ...shared, agentId: 'writer', now: () => new Date(day(12)) });
      writer.store(fact('widget alpha one', { visibility: 'workspace' }));
      writer.store(fact('widget beta two', { visibility: 'workspace' }));
      writer.close(); // gone before the reader opens

      let current = 3; // the reader's clock is behind the writer's
      const reader = createLocalMemory({ ...shared, agentId: 'reader', now: () => new Date(day(current)) });
      opened.push(reader);
      expect(reader.recall({ query: 'widget', lexicalScoring: 'bm25' })).toHaveLength(0);

      const probe = countCorpusStatsCalls();
      current = 20; // the reader's clock corrects forward, past the writes
      const after = reader.recall({ query: 'widget', lexicalScoring: 'bm25' });
      const recomputed = probe.calls();
      vi.restoreAllMocks();

      const cold = createLocalMemory({ ...shared, agentId: 'reader', now: () => new Date(day(20)) });
      opened.push(cold);
      const truth = cold.recall({ query: 'widget', lexicalScoring: 'bm25' });
      expect(truth).toHaveLength(2);
      expect(after).toHaveLength(2); // the defect returned 0 here
      expect(pairs(after)).toEqual(pairs(truth));
      expect(recomputed).toBe(1);
      rmSync(root, { recursive: true, force: true });
    });

    it('seeds the mark once per connection and still caches a workspace at rest', () => {
      // The seed is a covering-index MAX on `memories_page`, but it must also
      // not become a per-recall cost or a reason to stop caching: a reader
      // whose clock is at or above everything in the store caches exactly as it
      // did before the seed existed.
      const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-seed-once-'));
      const path = join(root, 'memory.sqlite');
      const shared = { path, workspaceId: 'test', retrieval: 'lexical' as const };
      const writer = createLocalMemory({ ...shared, agentId: 'writer', now: () => new Date(day(5)) });
      writer.store(fact('widget alpha', { visibility: 'workspace' }));
      writer.close();

      let seeds = 0;
      const prepare = DatabaseSync.prototype.prepare;
      vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: DatabaseSync, sql: string) {
        if (sql.includes('MAX(created_at)')) seeds++;
        return prepare.call(this, sql);
      });
      let current = 9; // ahead of everything already stored
      const reader = createLocalMemory({ ...shared, agentId: 'reader', now: () => new Date(day(current)) });
      opened.push(reader);
      expect(seeds).toBe(0); // nothing paid at open
      expect(reader.recall({ query: 'widget', lexicalScoring: 'bm25' })).toHaveLength(1);
      expect(seeds).toBe(1);
      current = 10; reader.recall({ query: 'widget', lexicalScoring: 'bm25' });
      current = 11; reader.recall({ query: 'widget', lexicalScoring: 'bm25' });
      expect(seeds).toBe(1); // once per connection, not once per recall
      vi.restoreAllMocks();

      const probe = countCorpusStatsCalls();
      current = 12; reader.recall({ query: 'widget', lexicalScoring: 'bm25' });
      current = 13; reader.recall({ query: 'widget', lexicalScoring: 'bm25' });
      expect(probe.calls()).toBe(0); // still served from the warm entry
      rmSync(root, { recursive: true, force: true });
    });

    // --- d2 regression: seedLiveClockFromStore's `seeded` boolean latch only
    // ever reads the store's MAX(created_at) once per connection. A foreign
    // commit that lands AFTER the reader's first live recall can never raise
    // `highWater` after that point, so the recompute triggered by the commit
    // (correctly invalidated via `data_version`) is wrongly judged cacheable
    // at the reader's low clock, and ordinary forward advance then serves it
    // forever. Fixed by keying the seed on `PRAGMA data_version` instead of a
    // boolean, so a later foreign commit re-seeds `highWater` too.
    it('does not serve statistics cached below a clock another connection wrote at AFTER the reader\'s first recall (d2)', () => {
      const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-d2-crossconn-after-'));
      const path = join(root, 'memory.sqlite');
      const shared = { path, workspaceId: 'test', retrieval: 'lexical' as const };

      const seed = createLocalMemory({ ...shared, agentId: 'writer', now: () => new Date(day(1)) });
      seed.store(fact('widget alpha one', { visibility: 'workspace' }));
      seed.store(fact('widget beta two', { visibility: 'workspace' }));
      seed.store(fact('widget gamma three', { visibility: 'workspace' }));
      seed.store(fact('widget delta four', { visibility: 'workspace' }));
      seed.close();

      let current = 3; // reader opens behind, and takes its FIRST live recall here
      const reader = createLocalMemory({ ...shared, agentId: 'reader', now: () => new Date(day(current)) });
      opened.push(reader);
      expect(reader.recall({ query: 'widget', lexicalScoring: 'bm25' })).toHaveLength(4); // latches `seeded`

      const writer = createLocalMemory({ ...shared, agentId: 'writer', now: () => new Date(day(12)) });
      writer.store(fact('widget epsilon five', { visibility: 'workspace' }));
      writer.store(fact('widget zeta six', { visibility: 'workspace' }));
      writer.close(); // bumps the reader's `data_version`, but NOT after seeding above

      reader.recall({ query: 'widget', lexicalScoring: 'bm25' }); // recomputes at day(3); must not cache a stale-low count

      const probe = countCorpusStatsCalls();
      current = 20; // ordinary forward advance, no step back anywhere
      const after = reader.recall({ query: 'widget', lexicalScoring: 'bm25' });
      const recomputed = probe.calls();
      vi.restoreAllMocks();

      const cold = createLocalMemory({ ...shared, agentId: 'reader', now: () => new Date(day(20)) });
      opened.push(cold);
      const truth = cold.recall({ query: 'widget', lexicalScoring: 'bm25' });
      expect(truth).toHaveLength(6);
      expect(after).toHaveLength(6); // d2: this returned 0
      expect(pairs(after)).toEqual(pairs(truth));
      expect(recomputed).toBe(1); // the day(20) recall must recompute, not hit a stale entry
      rmSync(root, { recursive: true, force: true });
    });

    // Minimal shape (MIN-d2): the reader's first live recall sees an EMPTY
    // store, so `documents === 0` and `#bm25Recall`'s `if (!documents) return
    // []` fires total loss for every query on that connection, not just the
    // one whose df crosses `documents`. Pins that an unrelated term also
    // recovers its true rows once the store is no longer empty from the
    // reader's point of view.
    it('does not serve a stale empty-at-reader-clock entry after a later foreign write (MIN-d2 shape)', () => {
      const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-min-d2-'));
      const path = join(root, 'memory.sqlite');
      const shared = { path, workspaceId: 'test', retrieval: 'lexical' as const };

      let current = 5;
      const reader = createLocalMemory({ ...shared, agentId: 'reader', now: () => new Date(day(current)) });
      opened.push(reader);
      expect(reader.recall({ query: 'widget', lexicalScoring: 'bm25' })).toHaveLength(0); // store is empty: latches `seeded` at documents=0

      const writer = createLocalMemory({ ...shared, agentId: 'writer', now: () => new Date(day(25)) });
      writer.store(fact('widget alpha three', { visibility: 'workspace' }));
      writer.store(fact('widget beta four', { visibility: 'workspace' }));
      writer.store(fact('gadget unrelated five', { visibility: 'workspace' }));
      writer.close();

      reader.recall({ query: 'widget', lexicalScoring: 'bm25' }); // recomputes at day(5): still 0 rows visible, still correct

      current = 29; // ordinary forward advance past every created_at
      const warmWidget = reader.recall({ query: 'widget', lexicalScoring: 'bm25' });
      const warmGadget = reader.recall({ query: 'gadget', lexicalScoring: 'bm25' }); // unrelated term, same cache entry

      const cold = createLocalMemory({ ...shared, agentId: 'reader', now: () => new Date(day(29)) });
      opened.push(cold);
      expect(warmWidget).toHaveLength(2); // MIN-d2: this returned 0
      expect(warmGadget).toHaveLength(1); // the total-loss path drops every query, not just the df-crossing one
      expect(cold.recall({ query: 'widget', lexicalScoring: 'bm25' })).toHaveLength(2);
      expect(cold.recall({ query: 'gadget', lexicalScoring: 'bm25' })).toHaveLength(1);
      rmSync(root, { recursive: true, force: true });
    });

    // The blast radius VERIFY-FULL widened: compile() always uses the lexical
    // (#rankedRecall -> #bm25Recall) path regardless of retrieval mode, so a
    // fully modelled hybrid engine still loses every citation when d2 fires,
    // even though recall()'s dense channel can mask the same loss.
    it('does not lose compile() citations to a post-first-recall foreign commit, on a hybrid engine', () => {
      const constant = Object.freeze({
        model: 'test-bm25-clock-embedder@1', dimensions: 4,
        embedSync: (texts: string[]) => texts.map(() => [0, 1, 0, 0]),
        embed: async (texts: string[]) => texts.map(() => [0, 1, 0, 0]),
        forQueries: () => ({ model: 'test-bm25-clock-embedder@1', dimensions: 4, embed: async (texts: string[]) => texts.map(() => [0, 1, 0, 0]) }),
        forPassages: () => ({ model: 'test-bm25-clock-embedder@1', dimensions: 4, embed: async (texts: string[]) => texts.map(() => [0, 1, 0, 0]) }),
        close: () => {},
      });
      const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-d2-compile-'));
      const path = join(root, 'memory.sqlite');
      const shared = { path, workspaceId: 'test', retrieval: 'hybrid' as const, embedder: constant };

      const seed = createLocalMemory({ ...shared, agentId: 'writer', now: () => new Date(day(1)) });
      seed.store(fact('widget alpha one', { visibility: 'workspace' }));
      seed.store(fact('widget beta two', { visibility: 'workspace' }));
      seed.store(fact('widget gamma three', { visibility: 'workspace' }));
      seed.store(fact('widget delta four', { visibility: 'workspace' }));
      seed.close();

      let current = 3;
      const reader = createLocalMemory({ ...shared, agentId: 'reader', now: () => new Date(day(current)) });
      opened.push(reader);
      reader.recall({ query: 'widget', lexicalScoring: 'bm25' }); // latches `seeded`

      const writer = createLocalMemory({ ...shared, agentId: 'writer', now: () => new Date(day(12)) });
      writer.store(fact('widget epsilon five', { visibility: 'workspace' }));
      writer.store(fact('widget zeta six', { visibility: 'workspace' }));
      writer.close();

      reader.recall({ query: 'widget', lexicalScoring: 'bm25' }); // recomputes and caches at the low clock

      current = 20;
      const warm = reader.compile({ query: 'widget', maxTokens: 4096 });

      const cold = createLocalMemory({ ...shared, agentId: 'reader', now: () => new Date(day(20)) });
      opened.push(cold);
      const truth = cold.compile({ query: 'widget', maxTokens: 4096 });
      expect(truth.citations).toHaveLength(6);
      expect(warm.citations).toHaveLength(6); // d2: this was 0 even on the default hybrid constructor
      rmSync(root, { recursive: true, force: true });
    });

    // Cost guard: the seed must not become a per-recall cost, but it also must
    // not stay latched forever — it should re-run exactly when another
    // connection has committed since the last time it ran, and not otherwise.
    it('re-seeds the live clock mark only when another connection has committed since the last seed', () => {
      const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-d2-reseed-guard-'));
      const path = join(root, 'memory.sqlite');
      const shared = { path, workspaceId: 'test', retrieval: 'lexical' as const };
      const seed = createLocalMemory({ ...shared, agentId: 'writer', now: () => new Date(day(1)) });
      seed.store(fact('widget alpha', { visibility: 'workspace' }));
      seed.close();

      let seeds = 0;
      const prepare = DatabaseSync.prototype.prepare;
      vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: DatabaseSync, sql: string) {
        if (sql.includes('MAX(created_at)')) seeds++;
        return prepare.call(this, sql);
      });

      let current = 3;
      const reader = createLocalMemory({ ...shared, agentId: 'reader', now: () => new Date(day(current)) });
      opened.push(reader);
      reader.recall({ query: 'widget', lexicalScoring: 'bm25' });
      expect(seeds).toBe(1); // first live recall on this connection

      current = 4; reader.recall({ query: 'widget', lexicalScoring: 'bm25' });
      current = 5;
      reader.store(fact('widget beta', { visibility: 'workspace' })); // this connection's OWN write: never moves data_version
      reader.recall({ query: 'widget', lexicalScoring: 'bm25' });
      expect(seeds).toBe(1); // no foreign commit yet

      const writer = createLocalMemory({ ...shared, agentId: 'writer', now: () => new Date(day(9)) });
      writer.store(fact('widget gamma', { visibility: 'workspace' }));
      writer.close(); // a foreign commit: bumps this reader's data_version

      current = 6; reader.recall({ query: 'widget', lexicalScoring: 'bm25' });
      expect(seeds).toBe(2); // re-seeded exactly once for the foreign commit

      current = 7; reader.recall({ query: 'widget', lexicalScoring: 'bm25' });
      current = 8; reader.recall({ query: 'widget', lexicalScoring: 'bm25' });
      expect(seeds).toBe(2); // and not again until the next foreign commit
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    });

    // Ordinary multi-handle use with a SHARED clock must keep caching exactly
    // as before: every foreign `created_at` is <= the shared clock's current
    // reading, so a re-seed can never push `highWater` above `now`, and the
    // fix must not turn this into a per-recall cost.
    it('still caches across a foreign commit when both handles share one clock', () => {
      const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-d2-shared-clock-'));
      const path = join(root, 'memory.sqlite');
      const shared = { path, workspaceId: 'test', retrieval: 'lexical' as const };
      const clock = { t: 5 };
      const now = () => new Date(day(clock.t));

      const a = createLocalMemory({ ...shared, agentId: 'a', now });
      opened.push(a);
      a.store(fact('widget alpha', { visibility: 'workspace' }));
      a.recall({ query: 'widget', lexicalScoring: 'bm25' }); // latches the seed on `a`

      const b = createLocalMemory({ ...shared, agentId: 'b', now });
      b.store(fact('widget beta', { visibility: 'workspace' })); // foreign commit from `a`'s point of view, same clock instant
      b.close();

      const probe = countCorpusStatsCalls();
      clock.t = 6;
      const first = a.recall({ query: 'widget', lexicalScoring: 'bm25' });
      expect(probe.calls()).toBe(1); // the foreign commit correctly forces one recompute
      clock.t = 7;
      const second = a.recall({ query: 'widget', lexicalScoring: 'bm25' });
      expect(probe.calls()).toBe(1); // and is cached from there on, same clock never looking stepped-back
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
      rmSync(root, { recursive: true, force: true });
    });
  });
});
