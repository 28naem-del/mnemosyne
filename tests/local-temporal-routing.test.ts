import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions, type StoreMemoryInput, type SyncMemoryEmbedder } from '../src/local/index.js';

/**
 * Temporal routing at the recall and compile entry points (master plan T1.4).
 *
 * The contract being pinned here is narrow and mostly about restraint: routing
 * is opt-in, an explicit caller clock always beats a parsed one, an exclusionary
 * phrase is the only thing allowed to hide evidence, and whatever routing
 * decided is written down where it can be argued with afterwards.
 */

const NOW = '2026-03-15T12:30:00.000Z';
const source = { uri: 'test://temporal/routing' };
const opened: LocalMemory[] = [];
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const fact = (text: string, more: Partial<StoreMemoryInput> = {}): StoreMemoryInput => ({ text, source, trust: 'observed', ...more });
afterEach(() => { opened.splice(0).forEach(db => db.close()); });

/** A deterministic stand-in for the bundled model: no weights, no cache, no network. */
function stubEmbedder(): SyncMemoryEmbedder {
  const vector = (text: string): number[] => {
    const out = new Array<number>(8).fill(0);
    for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) out[createHash('sha256').update(token).digest()[0] % 8] += 1;
    const norm = Math.hypot(...out) || 1;
    return out.map(value => value / norm);
  };
  const embedSync = (texts: readonly string[]): number[][] => texts.map(vector);
  const self: SyncMemoryEmbedder = {
    model: 'test-stub-embedder@v1', dimensions: 8, embedSync,
    embed: async (texts: readonly string[]) => embedSync(texts),
    forQueries: () => self, forPassages: () => self, close: () => {},
  };
  return self;
}

function memory(options: Partial<LocalMemoryOptions> = {}): LocalMemory {
  const db = createLocalMemory({
    path: ':memory:', workspaceId: 'project', agentId: 'alice',
    embedder: stubEmbedder(), reranker: null, now: () => new Date(NOW), ...options,
  });
  opened.push(db); return db;
}

// Mid-month on purpose: prioritisation widens a window by a week, so a seed on
// the 5th would let a June query reach into July and the promotion assertions
// below would stop distinguishing the named month from its neighbour.
const month = (index: number): string => `2023-${String(index).padStart(2, '0')}-15T00:00:00.000Z`;
/** One competing record per month of 2023, all sharing a vocabulary so that
 * nothing but the date can separate them. */
function seed(db: LocalMemory): string[] {
  return Array.from({ length: 12 }, (_value, index) =>
    db.store(fact(`Atlas quota review session ${index + 1}`, { validFrom: month(index + 1) })).id);
}
const retrievalOf = (db: LocalMemory) => db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
const ids = (results: { memory: { id: string } }[]): string[] => results.map(result => result.memory.id);

describe('temporal routing is opt-in', () => {
  it('changes nothing at all until it is asked for', () => {
    const db = memory();
    seed(db);
    const query = 'Atlas quota review in June 2023';
    const plain = db.recall({ query, limit: 5 });
    const off = db.recall({ query, limit: 5, temporalRouting: 'off' });
    expect(off).toEqual(plain);
    // ...and the claim is not vacuous: the same query with routing on differs.
    const auto = db.recall({ query, limit: 5, temporalRouting: 'auto' });
    expect(auto).not.toEqual(plain);
  });

  it('leaves no trace in the ledger when it is off', () => {
    const db = memory();
    seed(db);
    db.recall({ query: 'Atlas quota review in June 2023', limit: 5, temporalRouting: 'off' });
    const retrieval = retrievalOf(db);
    // Absent, not merely undefined: an entry written with routing off is
    // indistinguishable from one written before the field existed.
    expect('temporalRouting' in retrieval).toBe(false);
    expect(retrieval.schema).toBe(2);
  });

  it('declines to route a query with no time expression, or an ambiguous one', () => {
    const db = memory();
    seed(db);
    for (const query of ['Atlas quota review', 'Atlas quota review on 2/3/2023', 'Atlas quota review for ticket 1234']) {
      expect(db.recall({ query, limit: 5, temporalRouting: 'auto' })).toEqual(db.recall({ query, limit: 5 }));
      expect('temporalRouting' in retrievalOf(db)).toBe(false);
    }
  });

  it('rejects an unknown routing mode on recall and on compile', () => {
    const db = memory();
    seed(db);
    expect(() => db.recall({ query: 'Atlas quota', temporalRouting: 'sometimes' as 'auto' })).toThrow(TypeError);
    expect(() => db.compile({ query: 'Atlas quota', maxTokens: 512, temporalRouting: 'sometimes' as 'auto' })).toThrow(TypeError);
  });
});

describe('a scoping window prioritises and never narrows', () => {
  it('promotes the named month without dropping a single candidate', () => {
    const db = memory();
    const seeded = seed(db);
    const query = 'Atlas quota review session in June 2023';
    const off = db.recall({ query, limit: 12 });
    const auto = db.recall({ query, limit: 12, temporalRouting: 'auto' });
    // Same evidence, different order: reordering cannot hide what the caller asked for.
    expect(new Set(ids(auto))).toEqual(new Set(ids(off)));
    expect(ids(auto)).toHaveLength(12);
    expect(ids(auto)).not.toEqual(ids(off));
    expect(auto[0]!.memory.id).toBe(seeded[5]);
    expect(auto[0]!.memory.validFrom).toBe(month(6));
  });

  it('reaches a record written a few days after the window, but not a month after', () => {
    const db = memory();
    const seeded = seed(db);
    // A memory is dated when something was said, not when it happened, so the
    // report filed on 3 July still answers a question about June. The record a
    // month later does not, and must stay where the retriever put it.
    const justAfter = db.store(fact('Atlas quota review session wrap-up', { validFrom: '2023-07-03T00:00:00.000Z' })).id;
    const query = 'Atlas quota review session in June 2023';
    const auto = db.recall({ query, limit: 14, temporalRouting: 'auto' });
    expect(ids(auto).slice(0, 2)).toEqual(expect.arrayContaining([seeded[5], justAfter]));
    // 13 of the 14 are outside the window; none of them was dropped.
    expect(ids(auto)).toHaveLength(13);
    expect(new Set(ids(auto))).toEqual(new Set(ids(db.recall({ query, limit: 14 }))));
    expect(ids(auto).indexOf(seeded[6]!)).toBeGreaterThan(1);
  });

  it('keeps the returned scores descending after a promotion', () => {
    const db = memory();
    seed(db);
    const auto = db.recall({ query: 'Atlas quota review session in June 2023', limit: 12, temporalRouting: 'auto' });
    for (let index = 1; index < auto.length; index++) expect(auto[index]!.score).toBeLessThanOrEqual(auto[index - 1]!.score);
  });

  it('does not set a real clock for a scoping phrase', () => {
    const db = memory();
    seed(db);
    db.recall({ query: 'Atlas quota review in June 2023', limit: 5, temporalRouting: 'auto' });
    const retrieval = retrievalOf(db);
    expect(retrieval.temporalRouting?.relation).toBe('at');
    expect(retrieval.temporalRouting?.appliedAsOf).toBeUndefined();
    expect(retrieval.temporalRouting?.appliedKnownAt).toBeUndefined();
  });

  it('routes a relative expression against the engine clock, not the wall clock', () => {
    const db = memory({ now: () => new Date('2023-07-06T00:00:00.000Z') });
    seed(db);
    const lastWeek = db.store(fact('Atlas quota review session edition', { validFrom: '2023-06-28T00:00:00.000Z' })).id;
    const query = 'Atlas quota review session last week';
    const off = db.recall({ query, limit: 13 });
    const auto = db.recall({ query, limit: 13, temporalRouting: 'auto' });
    // That Thursday's previous whole ISO week is 26 June to 2 July 2023, read off
    // the engine clock, which is three years from the wall clock this test runs at.
    expect(retrievalOf(db).temporalRouting?.window).toEqual({ from: '2023-06-26T00:00:00.000Z', to: '2023-07-03T00:00:00.000Z' });
    expect(auto[0]!.memory.id).toBe(lastWeek);
    // Only the six months up to the clock are valid yet, plus the new record;
    // routing reorders exactly that set and adds nothing to it.
    expect(new Set(ids(auto))).toEqual(new Set(ids(off)));
    expect(ids(auto)).toHaveLength(7);
    // The identical query against a clock a month on names a different week.
    const later = memory({ now: () => new Date('2023-08-10T00:00:00.000Z') });
    seed(later);
    later.recall({ query, limit: 13, temporalRouting: 'auto' });
    expect(retrievalOf(later).temporalRouting?.window).toEqual({ from: '2023-07-31T00:00:00.000Z', to: '2023-08-07T00:00:00.000Z' });
  });
});

describe('an exclusionary phrase applies a real clock', () => {
  const query = 'Atlas quota review session before March 2023';

  it('hides evidence the caller said to exclude, and only then', () => {
    const db = memory();
    const seeded = seed(db);
    expect(ids(db.recall({ query, limit: 12 }))).toHaveLength(12);
    const auto = db.recall({ query, limit: 12, temporalRouting: 'auto' });
    // "before March 2023" ends the visible world where March begins, so January
    // and February survive and March onwards does not.
    expect(ids(auto).sort()).toEqual([seeded[0], seeded[1]].sort());
  });

  it('records the applied bounds as the decision that produced them', () => {
    const db = memory();
    seed(db);
    db.recall({ query, limit: 12, temporalRouting: 'auto' });
    const retrieval = retrievalOf(db);
    expect(retrieval.temporalRouting).toEqual({
      matched: 'before March 2023', relation: 'before', grain: 'month', confidence: 0.9,
      cleanedQuery: 'Atlas quota review session',
      window: { from: '1970-01-01T00:00:00.000Z', to: '2023-03-01T00:00:00.000Z' },
      appliedAsOf: '2023-02-28T23:59:59.999Z',
    });
    // knownAt is never parsed from a query, so routing leaves transaction time
    // exactly where the caller left it.
    expect(retrieval.knownAt).toBeUndefined();
    // The ledger still records the query the caller actually asked, so entries
    // stay comparable across routing on and off.
    expect(retrieval.querySha256).toBe(sha(query));
  });

  it('searches with the cleaned query, not the one carrying the date', () => {
    const db = memory();
    seed(db);
    db.recall({ query, limit: 12, temporalRouting: 'auto' });
    expect(retrievalOf(db).temporalRouting?.cleanedQuery).toBe('Atlas quota review session');
  });
});

describe('an explicit caller clock always wins', () => {
  it('ignores a parsed asOf when the caller stated one', () => {
    const db = memory();
    const seeded = seed(db);
    const auto = db.recall({ query: 'Atlas quota review session before March 2023', asOf: '2023-08-01T00:00:00.000Z', limit: 12, temporalRouting: 'auto' });
    // The caller's August clock governs, so everything up to August is visible.
    expect(ids(auto)).toHaveLength(7);
    expect(ids(auto)).toEqual(expect.arrayContaining([seeded[6]]));
    const retrieval = retrievalOf(db);
    expect(retrieval.asOf).toBe('2023-08-01T00:00:00.000Z');
    expect(retrieval.temporalRouting?.appliedAsOf).toBeUndefined();
    // The parse is still recorded — it was read, it just did not get to apply.
    expect(retrieval.temporalRouting?.relation).toBe('before');
  });

  it('leaves a caller knownAt alone while still applying the parsed asOf', () => {
    const db = memory();
    seed(db);
    db.recall({ query: 'Atlas quota review session before March 2023', knownAt: '2026-01-01T00:00:00.000Z', limit: 12, temporalRouting: 'auto' });
    const retrieval = retrievalOf(db);
    expect(retrieval.knownAt).toBe('2026-01-01T00:00:00.000Z');
    expect(retrieval.temporalRouting?.appliedKnownAt).toBeUndefined();
    expect(retrieval.temporalRouting?.appliedAsOf).toBe('2023-02-28T23:59:59.999Z');
  });
});

describe('temporal routing on the other retrieval entry points', () => {
  it('routes compile the same way it routes recall, and stays off by default', () => {
    const db = memory();
    const seeded = seed(db);
    const query = 'Atlas quota review session before March 2023';
    const plain = db.compile({ query, maxTokens: 4096 });
    expect(plain.items.map(item => item.id)).toEqual(db.compile({ query, maxTokens: 4096, temporalRouting: 'off' }).items.map(item => item.id));
    const routed = db.compile({ query, maxTokens: 4096, temporalRouting: 'auto' });
    expect(routed.items.map(item => item.id).sort()).toEqual([seeded[0], seeded[1]].sort());
    expect(plain.items.length).toBeGreaterThan(routed.items.length);
  });

  it('routes the asynchronous hybrid path', async () => {
    const db = memory();
    const seeded = seed(db);
    const query = 'Atlas quota review session before March 2023';
    const options = { embedder: stubEmbedder() };
    expect(ids(await db.recallHybrid({ query, limit: 12 }, options))).toHaveLength(12);
    const routed = await db.recallHybrid({ query, limit: 12, temporalRouting: 'auto' }, options);
    expect(ids(routed).sort()).toEqual([seeded[0], seeded[1]].sort());
  });

  it('routes compileHybrid and leaves it off by default', async () => {
    const db = memory();
    const seeded = seed(db);
    const query = 'Atlas quota review session before March 2023';
    const options = { embedder: stubEmbedder() };
    const plain = await db.compileHybrid({ query, maxTokens: 4096 }, options);
    const routed = await db.compileHybrid({ query, maxTokens: 4096, temporalRouting: 'auto' }, options);
    expect(routed.items.map(item => item.id).sort()).toEqual([seeded[0], seeded[1]].sort());
    expect(plain.items.length).toBeGreaterThan(routed.items.length);
  });

  it('falls back to lexical-only retrieval without an embedder', () => {
    const db = memory({ embedder: null, retrieval: 'lexical' });
    const seeded = seed(db);
    const query = 'Atlas quota review session before March 2023';
    expect(ids(db.recall({ query, limit: 12 }))).toHaveLength(12);
    expect(ids(db.recall({ query, limit: 12, temporalRouting: 'auto' })).sort()).toEqual([seeded[0], seeded[1]].sort());
  });
});
