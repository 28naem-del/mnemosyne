import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions, type StoreMemoryInput, type SyncMemoryEmbedder, type SyncMemoryReranker } from '../src/local/index.js';
import { parseTemporalQuery, TEMPORAL_ROUTING_CONFIDENCE_FLOOR } from '../src/local/temporal-query.js';

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

/**
 * A bound read out of a query is a guess about what the asker meant; a bound the
 * caller passes is a statement about the clock they want. Only the second is
 * allowed to point into the future. Without that distinction "as of today"
 * resolves to the last instant of today, `#at` drops every record whose validity
 * ends before then, and a question about the present is answered as history —
 * with an empty result and no error.
 */
describe('a bound read out of a query never reaches past now', () => {
  /** Valid from before NOW until later the same day: current at NOW, and gone by
   * the end of the day that "as of today" resolves to. */
  const expiringToday = (db: LocalMemory): string =>
    db.store(fact('Atlas quota is 500 requests per minute', { validFrom: '2026-03-01T00:00:00.000Z', validUntil: '2026-03-15T18:00:00.000Z' })).id;
  const counts = (db: LocalMemory, query: string) => ({
    off: ids(db.recall({ query, limit: 10 })).length,
    on: ids(db.recall({ query, limit: 10, temporalRouting: 'auto' })).length,
  });

  it('still finds a record that is valid at this instant when the query says "as of today"', () => {
    const db = memory();
    const id = expiringToday(db);
    const { off, on } = counts(db, 'what is the Atlas quota as of today');
    expect({ off, on }).toEqual({ off: 1, on: 1 });
    expect(ids(db.recall({ query: 'what is the Atlas quota as of today', limit: 10, temporalRouting: 'auto' }))).toEqual([id]);
  });

  it('declines to route at the confidence floor, where a bare year would otherwise set a bound', () => {
    const db = memory();
    expiringToday(db);
    // "through 2026" parses at exactly the floor — the weakest reading the
    // parser will emit — and it is exclusionary, so admitting it would narrow
    // `asOf` to the last instant of December off nothing but a bare year. The
    // gate is strict, so it does not clear, and routing decides nothing here.
    expect(parseTemporalQuery('Atlas quota through 2026', { now: new Date(NOW) }).confidence).toBe(TEMPORAL_ROUTING_CONFIDENCE_FLOOR);
    db.recall({ query: 'Atlas quota through 2026', limit: 10, temporalRouting: 'auto' });
    expect(retrievalOf(db).temporalRouting).toBeUndefined(); // nothing was routed, so nothing was written down
    expect(counts(db, 'Atlas quota through 2026')).toEqual({ off: 1, on: 1 });
  });

  it('still routes the grade immediately above the floor', () => {
    // The floor must reject the weakest reading and nothing else: the next
    // grade up (a relative expression, 0.85) still routes and still writes down
    // the bound it applied. Without this, "reject the weakest parse" could be
    // satisfied by disabling routing altogether.
    const db = memory();
    expiringToday(db);
    const parse = parseTemporalQuery('what is the Atlas quota as of today', { now: new Date(NOW) });
    expect(parse.confidence).toBeGreaterThan(TEMPORAL_ROUTING_CONFIDENCE_FLOOR);
    db.recall({ query: 'what is the Atlas quota as of today', limit: 10, temporalRouting: 'auto' });
    expect(retrievalOf(db).temporalRouting).toBeDefined();
    expect(retrievalOf(db).temporalRouting!.appliedAsOf).toBe(NOW);
  });

  it('writes down the bound it applied, not the one it read', () => {
    const db = memory();
    expiringToday(db);
    db.recall({ query: 'what is the Atlas quota as of today', limit: 10, temporalRouting: 'auto' });
    const routing = retrievalOf(db).temporalRouting!;
    // The parse is reported verbatim — the query really did say "as of today" —
    // while the bound that governed retrieval is the present.
    expect(routing.window.to).toBe('2026-03-16T00:00:00.000Z');
    expect(routing.appliedAsOf).toBe(NOW);
    expect(routing.appliedAsOf! <= NOW).toBe(true);
  });

  it('leaves a bound that already sits in the past exactly where the query put it', () => {
    const db = memory();
    db.store(fact('Atlas quota is 500 requests per minute', { validFrom: '2025-06-01T00:00:00.000Z' }));
    // Clamping must not become a licence to ignore a real historical question:
    // "before March 2020" still hides evidence dated after it.
    expect(counts(db, 'Atlas quota before March 2020')).toEqual({ off: 1, on: 0 });
    db.recall({ query: 'Atlas quota before March 2020', limit: 10, temporalRouting: 'auto' });
    expect(retrievalOf(db).temporalRouting?.appliedAsOf).toBe('2020-02-29T23:59:59.999Z');
  });

  it('still honours a future asOf the caller stated, because that one is intent', () => {
    const db = memory();
    expiringToday(db);
    const query = 'what is the Atlas quota as of today';
    const stated = '2026-09-15T00:00:00.000Z';
    // The caller asked past the record's expiry on purpose, so it is correctly gone.
    expect(ids(db.recall({ query, limit: 10, temporalRouting: 'auto', asOf: stated }))).toEqual([]);
    const retrieval = retrievalOf(db);
    expect(retrieval.asOf).toBe(stated);
    expect(retrieval.temporalRouting?.appliedAsOf).toBeUndefined();
  });

  it('cannot reach the routing-off path at all', () => {
    const db = memory();
    expiringToday(db);
    const query = 'what is the Atlas quota as of today';
    const plain = db.recall({ query, limit: 10 });
    expect(db.recall({ query, limit: 10, temporalRouting: 'off' })).toEqual(plain);
    // `#route` returns before reading the clock when routing is off, so the
    // clamp is unreachable rather than merely inactive.
    expect(retrievalOf(db).temporalRouting).toBeUndefined();
  });
});

/**
 * The final ordering stage only exists when a reranker does. Every other test
 * here runs with `reranker: null`, which leaves `TEMPORAL_PRIORITY_KEEP` and the
 * post-rerank pass unmeasured — a stub reranker is what makes them observable.
 */
describe('the ordering stage protects the podium a reranker produced', () => {
  /** Scores by month, newest first: a deliberately date-blind order, so any
   * movement in the result is the window's doing and not the reranker's. */
  const newestFirst: SyncMemoryReranker = {
    model: 'test-stub-reranker@v1',
    rerankSync: (_query, passages) => passages.map(text => Number(/session (\d+)/.exec(text)![1])),
    close: () => {},
  };

  it('holds the top three and partitions everything below them', () => {
    const db = memory({ reranker: newestFirst });
    const seeded = seed(db);
    const query = 'Atlas quota review session in June 2023';
    const plain = ids(db.recall({ query, limit: 12 }));
    // The reranker alone orders December down to January.
    expect(plain).toEqual([...seeded].reverse());
    const routed = ids(db.recall({ query, limit: 12, temporalRouting: 'auto' }));
    // December, November and October are held. June — the only record inside the
    // widened window — is promoted to just below them, and the rest keep their
    // reranked order. Reducing TEMPORAL_PRIORITY_KEEP to 0 would put June first;
    // dropping the post-rerank pass would leave it in seventh place.
    expect(routed).toEqual([seeded[11], seeded[10], seeded[9], seeded[5], seeded[8], seeded[7], seeded[6], seeded[4], seeded[3], seeded[2], seeded[1], seeded[0]]);
  });
});

/**
 * T1.4 option B, pre-registered in
 * the T1.4 analysis note (option B): a "when did…" /
 * "how long…" style question usually carries no parseable date of its own (the
 * time is the ANSWER, not a constraint), so `#route` correctly declines it. This
 * prior reorders candidates by whether their OWN text is time-bearing instead,
 * strictly when routing is already opted in and the window parser found
 * nothing — so it can never fire on the default path or compete with an actual
 * parsed window.
 */
describe('T1.4 option B: the when-intent prior', () => {
  /** Seven lexically-similar candidates; only one mentions an actual date, so
   * nothing but that difference can move it. */
  function seedWhenIntent(db: LocalMemory): { plain: string[]; dated: string } {
    const plain = Array.from({ length: 6 }, (_value, index) =>
      db.store(fact(`launch report filed by team member number ${index + 1}`)).id);
    const dated = db.store(fact('launch report filed by team member number 7 on 10 March 2023')).id;
    return { plain, dated };
  }

  it('changes nothing until temporal routing is opted in', () => {
    const db = memory();
    const { dated } = seedWhenIntent(db);
    const query = 'when did the launch happen';
    const plain = ids(db.recall({ query, limit: 10 }));
    expect(ids(db.recall({ query, limit: 10, temporalRouting: 'off' }))).toEqual(plain);
    expect(plain.indexOf(dated)).toBeGreaterThan(0);
  });

  it('promotes the candidate whose own text is time-bearing, without dropping any', () => {
    const db = memory();
    const { dated } = seedWhenIntent(db);
    const query = 'when did the launch happen';
    const off = ids(db.recall({ query, limit: 10 }));
    const auto = ids(db.recall({ query, limit: 10, temporalRouting: 'auto' }));
    expect(new Set(auto)).toEqual(new Set(off));
    expect(auto).toHaveLength(off.length);
    expect(auto[0]).toBe(dated);
    // No window was parsed — this is the predicate prior, not window routing.
    expect(retrievalOf(db).temporalRouting).toBeUndefined();
  });

  it('does not fire on a query that is not when-intent-shaped', () => {
    const db = memory();
    const { dated } = seedWhenIntent(db);
    const query = 'tell me about the launch report';
    const off = ids(db.recall({ query, limit: 10 }));
    const auto = ids(db.recall({ query, limit: 10, temporalRouting: 'auto' }));
    expect(auto).toEqual(off);
    expect(off.indexOf(dated)).toBe(auto.indexOf(dated));
  });

  it('defers to real window routing when the query also names a parseable date', () => {
    const db = memory();
    seedWhenIntent(db);
    const query = 'when did the launch happen before March 2023';
    db.recall({ query, limit: 10, temporalRouting: 'auto' });
    // The window parser won, not the when-intent predicate: a real relation is
    // recorded, which only ever happens on the window-routing branch.
    expect(retrievalOf(db).temporalRouting?.relation).toBe('before');
  });

  it('is a no-op on the lexical-only path, which never calls #hybridRecall', () => {
    const db = memory({ embedder: null, retrieval: 'lexical' });
    const { dated } = seedWhenIntent(db);
    const query = 'when did the launch happen';
    const off = ids(db.recall({ query, limit: 10 }));
    const auto = ids(db.recall({ query, limit: 10, temporalRouting: 'auto' }));
    expect(auto).toEqual(off);
    expect(off.indexOf(dated)).toBe(auto.indexOf(dated));
  });

  it('promotes on the asynchronous hybrid path too', async () => {
    const db = memory();
    const { dated } = seedWhenIntent(db);
    const query = 'when did the launch happen';
    const options = { embedder: stubEmbedder() };
    const off = ids(await db.recallHybrid({ query, limit: 10 }, options));
    const auto = ids(await db.recallHybrid({ query, limit: 10, temporalRouting: 'auto' }, options));
    expect(new Set(auto)).toEqual(new Set(off));
    expect(auto[0]).toBe(dated);
  });
});
