import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import type { DenseIndexMode, SyncMemoryEmbedder } from '../src/local/types.js';
import { hnswAvailable, loadSqliteVec } from '../src/local/vector/index.js';

/**
 * The differential suite: an index may narrow, never widen.
 *
 * Two questions are asked separately, because they can fail separately.
 *
 * 1. **Does the index agree with the exact scan?** Same database, same query,
 *    same clocks — the dense candidate sets must be equal, order-insensitively.
 *    This catches an index that quietly loses or invents candidates.
 *
 * 2. **Is the exact scan itself withholding what it must?** Agreement with a
 *    wrong answer is not safety, so the forbidden set is recomputed here from
 *    the fixture — erased records, another agent's private records, records not
 *    yet created at `knownAt`, records outside their validity window at `asOf` —
 *    and asserted against BOTH paths independently.
 */

const opened: LocalMemory[] = [];
const roots: string[] = [];
afterEach(() => { opened.splice(0).forEach(db => { try { db.close(); } catch { /* closed */ } }); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function location(): string { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-diff-')); roots.push(root); return join(root, 'memory.sqlite'); }

/** Seeded so a failure reproduces exactly rather than once in a hundred runs. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}

const DIMENSIONS = 24;
function embedder(): SyncMemoryEmbedder {
  const encode = (text: string): number[] => {
    const vector = new Array<number>(DIMENSIONS).fill(0);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      vector[code % DIMENSIONS] += 1;
      vector[(code * 13 + index) % DIMENSIONS] += 0.5;
    }
    vector[0] += 1;
    const norm = Math.hypot(...vector);
    return vector.map(value => value / norm);
  };
  const model: SyncMemoryEmbedder = {
    model: 'diff-embedder@v1', dimensions: DIMENSIONS,
    embedSync: (texts) => texts.map(encode), embed: async (texts) => texts.map(encode),
    forQueries: () => model, forPassages: () => model, close: () => {},
  };
  return model;
}

const WORDS = ['ledger', 'garage', 'coffee', 'frankfurt', 'payroll', 'bicycle', 'archive', 'revenue', 'carburettor', 'audit', 'cluster', 'invoice', 'harbour', 'lantern', 'quarry', 'sextant'];
function phrase(random: () => number, count = 6): string {
  return Array.from({ length: count }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ');
}

interface Fixture {
  path: string;
  /** Everything the fixture knows about each record, for the independent oracle. */
  records: { id: string; agentId: string; visibility: string; createdAt: string; validFrom?: string; validUntil?: string }[];
  erased: string[];
}

/**
 * A store built so the filters actually bite: two agents, both visibilities,
 * validity windows that open late and close early, records created across a
 * span of days, untrusted and advisory records, and corrections that supersede.
 * Over 64 records, so the ANN shortlist is a real shortlist rather than the
 * whole index.
 */
function buildCorpus(path: string, seed = 20260914): Fixture {
  const random = rng(seed);
  let clock = Date.parse('2024-01-01T00:00:00.000Z');
  const now = (): Date => new Date(clock);
  const records: Fixture['records'] = [];
  const open = (agentId: string): LocalMemory => {
    const db = createLocalMemory({ path, workspaceId: 'project', agentId, embedder: embedder(), rerank: false, indexMode: 'exact', now, ledger: { maxCandidates: 1000 } });
    opened.push(db); return db;
  };
  const alice = open('alice'), bob = open('bob');
  const day = (offset: number): string => new Date(Date.parse('2024-01-01T00:00:00.000Z') + offset * 86_400_000).toISOString();

  for (let index = 0; index < 200; index++) {
    clock += 3_600_000; // an hour between writes, so createdAt spreads over days
    const db = random() < 0.5 ? alice : bob;
    const agentId = db === alice ? 'alice' : 'bob';
    const visibility = random() < 0.45 ? 'workspace' : 'private';
    const roll = random();
    const validFrom = roll < 0.15 ? day(40 + Math.floor(random() * 20)) : undefined;   // opens well after most cut-offs
    // Closes a few hours after this record was written, so it is expired for
    // almost every asOf the plan picks, but still legal at store time.
    const validUntil = roll >= 0.15 && roll < 0.3 ? new Date(clock + 3_600_000 * (1 + Math.floor(random() * 6))).toISOString() : undefined;
    const record = db.store({
      text: phrase(random), source: { uri: `test://diff/${index}` },
      trust: random() < 0.12 ? 'untrusted' : 'observed',
      visibility: visibility as 'workspace' | 'private',
      kind: random() < 0.2 ? 'decision' : 'fact',
      ...(validFrom ? { validFrom } : {}), ...(validUntil ? { validUntil } : {}),
      ...(random() < 0.1 ? { metadata: { advisory: false } } : {}),
    });
    // Read back off the stored record, not off the inputs: the engine is the
    // authority on what was actually written.
    records.push({ id: record.id, agentId, visibility, createdAt: record.createdAt, ...(record.validFrom ? { validFrom: record.validFrom } : {}), ...(record.validUntil ? { validUntil: record.validUntil } : {}) });
  }
  // Corrections, so some records are superseded and some invalidated.
  for (const entry of records.filter(() => random() < 0.1).slice(0, 12)) {
    clock += 3_600_000;
    const db = entry.agentId === 'alice' ? alice : bob;
    try {
      const replacement = db.correct(entry.id, { text: phrase(random), source: { uri: `test://diff/correction` }, reason: 'superseded by a later observation' });
      // A correction INHERITS the corrected record's validity interval, because it
      // asserts a fact about that interval rather than about the moment it was
      // written. So it is legitimately visible `asOf` a time before it existed, as
      // long as `knownAt` is after it. Taking validFrom off the returned record
      // rather than assuming `createdAt` is what keeps this oracle honest.
      records.push({ id: replacement.id, agentId: entry.agentId, visibility: entry.visibility, createdAt: replacement.createdAt,
        ...(replacement.validFrom ? { validFrom: replacement.validFrom } : {}), ...(replacement.validUntil ? { validUntil: replacement.validUntil } : {}) });
    } catch { /* not correctable in this state */ }
  }
  clock += 3_600_000;
  alice.close(); bob.close();
  opened.splice(opened.indexOf(alice), 1); opened.splice(opened.indexOf(bob), 1);
  return { path, records, erased: [] };
}

interface State { query: string; limit: number; maxCandidates: number; asOf?: string; knownAt?: string; kinds?: ('fact' | 'decision')[]; includeUntrusted?: boolean }

function states(count: number, seed = 7): State[] {
  const random = rng(seed);
  const day = (offset: number): string => new Date(Date.parse('2024-01-01T00:00:00.000Z') + offset * 86_400_000).toISOString();
  return Array.from({ length: count }, () => {
    const roll = random();
    return {
      query: phrase(random, 3),
      limit: 1 + Math.floor(random() * 10),
      // Small on purpose: a budget larger than the store makes every shortlist
      // the whole index, which would make this suite prove nothing.
      maxCandidates: 3 + Math.floor(random() * 8),
      ...(roll < 0.6 ? { asOf: day(Math.floor(random() * 50)) } : {}),
      ...(roll < 0.4 ? { knownAt: day(Math.floor(random() * 50)) } : {}),
      ...(random() < 0.3 ? { kinds: ['fact' as const] } : {}),
      ...(random() < 0.3 ? { includeUntrusted: true } : {}),
    };
  });
}

interface Observation { dense: string[]; results: string[] }

/** Run every state under one index mode, capturing the dense stage from the ledger. */
function observe(path: string, mode: DenseIndexMode, agentId: string, plan: State[]): { observations: Observation[]; mode: string } {
  const db = createLocalMemory({ path, workspaceId: 'project', agentId, embedder: embedder(), rerank: false, indexMode: mode, ledger: { maxCandidates: 1000 } });
  opened.push(db);
  const observations = plan.map((state) => {
    const results = db.recall(state).map(hit => hit.memory.id);
    // Addressed by the id of the retrieval just recorded, NOT by "the last row in
    // a page". The ledger accumulates across every mode this suite runs, so a
    // paged read silently starts returning a previous mode's recall.
    const retrievalId = db.lastRetrievalId!;
    const entry = db.ledger({ events: ['recall'], limit: 1000 }).entries.find(row => row.id === retrievalId)!;
    const dense = entry.retrieval!.candidates.filter(candidate => candidate.stage === 'dense').map(candidate => candidate.memoryId);
    return { dense, results };
  });
  const reported = db.retrieval.index!.mode;
  db.close(); opened.splice(opened.indexOf(db), 1);
  return { observations, mode: reported };
}

/**
 * Recomputed from the fixture, never from the engine: what must never come back,
 * and why. The reason travels with the verdict so a failure names the rule that
 * was broken instead of just an identifier.
 *
 * The clock defaults mirror `#temporal()` exactly: `knownAt` defaults to NOW —
 * NOT to `asOf` — so asking only for a past `asOf` does not also pretend not to
 * know about anything recorded since.
 */
function forbidden(fixture: Fixture, state: State, viewer: string): Map<string, string> {
  const knownAt = state.knownAt ?? '9999-12-31T23:59:59.999Z';
  const asOf = state.asOf ?? knownAt;
  const banned = new Map<string, string>();
  for (const id of fixture.erased) banned.set(id, 'erased');
  for (const record of fixture.records) {
    if (record.agentId !== viewer && record.visibility !== 'workspace') banned.set(record.id, `private to ${record.agentId}`);
    else if (record.createdAt > knownAt) banned.set(record.id, `created ${record.createdAt} > knownAt ${knownAt}`);
    else if ((record.validFrom ?? record.createdAt) > asOf) banned.set(record.id, `validFrom ${record.validFrom ?? record.createdAt} > asOf ${asOf}`);
    else if (record.validUntil !== undefined && record.validUntil <= asOf) banned.set(record.id, `validUntil ${record.validUntil} <= asOf ${asOf}`);
  }
  return banned;
}

const MODES: DenseIndexMode[] = hnswAvailable() ? ['sqlite-vec', 'hnsw'] : ['sqlite-vec'];

describe('the dense index preserves every filter the exact scan enforces', () => {
  it('agrees with the exact scan, and leaks nothing, across 80 random states', () => {
    const path = location();
    const fixture = buildCorpus(path);
    const plan = states(80);
    const baseline = observe(path, 'exact', 'alice', plan);
    expect(baseline.mode).toBe('exact');

    for (const mode of MODES) {
      const candidate = observe(path, mode, 'alice', plan);
      expect(candidate.mode).toBe(mode);
      for (let index = 0; index < plan.length; index++) {
        const exact = baseline.observations[index], through = candidate.observations[index];
        const context = `${mode} state#${index} ${JSON.stringify(plan[index])}`;
        // 1. subset — the index may narrow, never widen
        expect(through.dense.filter(id => !exact.dense.includes(id)), `${context}: dense candidates absent from the exact scan`).toEqual([]);
        // 2. top-k sets match, order-insensitively
        expect([...through.dense].sort(), `${context}: dense set differs`).toEqual([...exact.dense].sort());
        expect([...through.results].sort(), `${context}: results differ`).toEqual([...exact.results].sort());
        // 3. independent oracle — agreement with a wrong answer is not safety
        const banned = forbidden(fixture, plan[index], 'alice');
        const describe = (ids: string[]): string[] => ids.filter(id => banned.has(id)).map(id => `${id} (${banned.get(id)})`);
        expect(describe(exact.results), `${context}: LEAK through the exact scan`).toEqual([]);
        expect(describe(through.dense), `${context}: LEAK into the index's dense channel`).toEqual([]);
        expect(describe(through.results), `${context}: LEAK through the index`).toEqual([]);
      }
    }
  }, 120_000);

  it('erases from the index itself, and no replay resurrects the record', () => {
    const path = location();
    const fixture = buildCorpus(path);
    const plan = states(40, 99);

    const writer = createLocalMemory({ path, workspaceId: 'project', agentId: 'alice', embedder: embedder(), rerank: false, indexMode: 'sqlite-vec', ledger: { maxCandidates: 1000 } });
    opened.push(writer);
    writer.recall({ query: 'ledger audit archive' });               // build the index first
    const mine = fixture.records.filter(record => record.agentId === 'alice');
    const doomed = [mine[3], mine[11], mine[19]].map(record => record.id);
    const labels = doomed.map(id => (new DatabaseSync(path).prepare('SELECT label FROM local_vec_labels WHERE memory_id=?').get(id) as { label: number } | undefined)?.label);
    for (const id of doomed) writer.forget(id);
    writer.close(); opened.splice(opened.indexOf(writer), 1);
    fixture.erased = doomed;

    // The vectors are gone from the index itself, not merely hidden behind it.
    const raw = new DatabaseSync(path, { allowExtension: true });
    loadSqliteVec(raw);
    try {
      for (const id of doomed) expect((raw.prepare('SELECT count(*) AS count FROM local_vec_labels WHERE memory_id=?').get(id) as { count: number }).count).toBe(0);
      for (const label of labels.filter((label): label is number => label !== undefined)) {
        expect((raw.prepare("SELECT count(*) AS count FROM local_vec_index WHERE rowid=?").get(BigInt(label)) as { count: number }).count).toBe(0);
      }
    } finally { raw.close(); }

    // And no replay brings them back — including at clocks from before the erasure.
    const baseline = observe(path, 'exact', 'alice', plan);
    for (const mode of MODES) {
      const candidate = observe(path, mode, 'alice', plan);
      for (let index = 0; index < plan.length; index++) {
        const context = `${mode} state#${index}`;
        expect(candidate.observations[index].dense.filter(id => doomed.includes(id)), `${context}: erased record resurrected in the dense channel`).toEqual([]);
        expect(candidate.observations[index].results.filter(id => doomed.includes(id)), `${context}: erased record resurrected`).toEqual([]);
        expect([...candidate.observations[index].results].sort(), `${context}: results differ after erasure`).toEqual([...baseline.observations[index].results].sort());
      }
    }
  }, 120_000);

  it('agrees on the shortlist path, where the index does NOT widen to the whole store', () => {
    // The cases above filter hard enough that the shortlist often widens until it
    // covers the index, which makes equality easy. This one removes the filtering
    // pressure — one agent, no validity windows, no corrections — so a shortlist
    // of 64 yields more survivors than the budget on the FIRST attempt and the
    // engine returns without widening. That is the path a large store actually
    // takes, so it is the one worth pinning.
    const path = location();
    const random = rng(31337);
    const writer = createLocalMemory({ path, workspaceId: 'project', agentId: 'alice', embedder: embedder(), rerank: false, indexMode: 'exact', ledger: { maxCandidates: 1000 } });
    opened.push(writer);
    for (let index = 0; index < 400; index++) writer.store({ text: phrase(random), source: { uri: `test://wide/${index}` }, trust: 'observed', visibility: 'workspace' });
    writer.close(); opened.splice(opened.indexOf(writer), 1);

    const plan = Array.from({ length: 40 }, () => ({ query: phrase(random, 3), limit: 10, maxCandidates: 5 }));
    const baseline = observe(path, 'exact', 'alice', plan);
    for (const mode of MODES) {
      const candidate = observe(path, mode, 'alice', plan);
      for (let index = 0; index < plan.length; index++) {
        // A budget of 5 filled from a 64-deep shortlist over 400 records: if the
        // shortlist were being ignored these would not line up.
        expect(baseline.observations[index].dense.length).toBe(5);
        expect([...candidate.observations[index].dense].sort(), `${mode} state#${index}: dense set differs on the shortlist path`).toEqual([...baseline.observations[index].dense].sort());
        expect([...candidate.observations[index].results].sort()).toEqual([...baseline.observations[index].results].sort());
      }
    }
  }, 120_000);

  it('withholds the private records of another agent through every index', () => {
    const path = location();
    const fixture = buildCorpus(path);
    const secret = new Set(fixture.records.filter(record => record.agentId === 'bob' && record.visibility === 'private').map(record => record.id));
    expect(secret.size).toBeGreaterThan(0);
    const plan = states(30, 4242);
    for (const mode of ['exact', ...MODES] as DenseIndexMode[]) {
      for (const observation of observe(path, mode, 'alice', plan).observations) {
        expect(observation.results.filter(id => secret.has(id))).toEqual([]);
        expect(observation.dense.filter(id => secret.has(id))).toEqual([]);
      }
    }
  }, 120_000);
});
