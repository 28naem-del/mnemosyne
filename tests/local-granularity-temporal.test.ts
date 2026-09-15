import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions, type RecallResult, type StoreMemoryInput, type SyncMemoryEmbedder, type SyncMemoryReranker } from '../src/local/index.js';

/**
 * The two Tier-1 switches meeting in one engine: T1.3's granularity blend and
 * T1.4's temporal prioritisation.
 *
 * They were built on separate branches against the same three lines of
 * `#hybridRecall`, so the composition is a decision rather than a merge
 * mechanic, and it was decided this way: **the granularity blend runs first and
 * temporal prioritisation runs on the blended list.** Prioritisation re-orders
 * whichever candidate list exists; the blend is what defines that list; so
 * prioritising first would let the blend undo it.
 *
 * What is pinned here is the full switch matrix, because that is where a
 * regression would actually land — not in either feature alone but in one
 * quietly disabling the other:
 *
 *   off  / off   the base engine, byte-identical
 *   multi/ off   exactly the granularity branch's behaviour
 *   off  / auto  exactly the temporal branch's behaviour
 *   multi/ auto  blend, THEN prioritise
 */

const NOW = '2026-03-15T12:30:00.000Z';
const source = { uri: 'test://granularity/temporal' };
const opened: LocalMemory[] = [];
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

/** Orders the year backwards, so the cross-encoder's opinion actively disagrees
 * with the June window and a promotion is visible rather than coincidental. */
const newestFirst: SyncMemoryReranker = {
  model: 'test-stub-reranker@v1',
  rerankSync: (_query, passages) => passages.map(text => { const found = /session (\d+)/.exec(text); return found ? Number(found[1]) : 0; }),
  close: () => {},
};

function memory(options: Partial<LocalMemoryOptions> = {}): LocalMemory {
  const db = createLocalMemory({
    path: ':memory:', workspaceId: 'project', agentId: 'alice',
    embedder: stubEmbedder(), reranker: newestFirst, now: () => new Date(NOW), ...options,
  });
  opened.push(db); return db;
}

// Mid-month on purpose: prioritisation widens the parsed window by a week, so a
// seed nearer either edge would let a June query reach into May or July and the
// in-window assertions would stop distinguishing the named month.
const month = (index: number): string => `2023-${String(index).padStart(2, '0')}-15T00:00:00.000Z`;
const QUERY = 'Atlas quota review session in June 2023';
const JUNE = 6;
const LIMIT = 24;

/** Twelve months, two turns each, grouped into four six-turn sessions — which is
 * exactly `windowTurns`, so each session derives one whole window.
 *
 * Every month contributes one turn that answers the query on its own text and
 * one that shares no term with it at all. The second kind is the entire reason
 * the granularity layer exists: turn-level retrieval has nothing to rank it by,
 * and only its session can carry it into the pool. */
function seed(db: LocalMemory): { quotable: string[]; contextOnly: string[]; monthOf: Map<string, number> } {
  const quotable: string[] = [], contextOnly: string[] = [], monthOf = new Map<string, number>();
  for (let index = 1; index <= 12; index += 1) {
    const metadata = { sessionId: `quarter-${Math.ceil(index / 3)}` };
    const fact = (text: string): StoreMemoryInput => ({ text, source, trust: 'observed', validFrom: month(index), metadata });
    const a = db.store(fact(`Atlas quota review session ${index}`)).id;
    const b = db.store(fact(`Yeah, that one too, and nobody minded afterwards ${index}`)).id;
    quotable.push(a); contextOnly.push(b);
    monthOf.set(a, index); monthOf.set(b, index);
  }
  return { quotable, contextOnly, monthOf };
}

const ids = (results: RecallResult[]): string[] => results.map(result => result.memory.id);
const shape = (results: RecallResult[]): string => JSON.stringify(results);
const retrievalOf = (db: LocalMemory) => db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;

/** The three leading results `#prioritize` is documented to hold exactly where it
 * found them; everything below is partitioned in-window first. */
const TEMPORAL_PRIORITY_KEEP = 3;

async function ready(): Promise<{ db: LocalMemory; seeded: ReturnType<typeof seed> }> {
  const db = memory();
  const seeded = seed(db);
  await db.indexGranularity({ embedder: stubEmbedder() });
  return { db, seeded };
}

describe('both switches off is the base engine', () => {
  it('returns byte-identical results whether the flags are absent or explicitly off', async () => {
    const { db } = await ready();
    const bare = shape(db.recall({ query: QUERY, limit: LIMIT }));
    expect(shape(db.recall({ query: QUERY, limit: LIMIT, granularity: 'turn' }))).toEqual(bare);
    expect(shape(db.recall({ query: QUERY, limit: LIMIT, temporalRouting: 'off' }))).toEqual(bare);
    expect(shape(db.recall({ query: QUERY, limit: LIMIT, granularity: 'turn', temporalRouting: 'off' }))).toEqual(bare);
  });

  it('is identical to the same database before the derived index was ever built', () => {
    const db = memory();
    seed(db);
    // The same database before and after, so the comparison is over the same
    // record identities and any difference at all would be a real one.
    const before = shape(db.recall({ query: QUERY, limit: LIMIT, granularity: 'turn', temporalRouting: 'off' }));
    return db.indexGranularity({ embedder: stubEmbedder() }).then(() => {
      expect(shape(db.recall({ query: QUERY, limit: LIMIT, granularity: 'turn', temporalRouting: 'off' }))).toEqual(before);
    });
  });

  it('leaves no trace of either feature in the ledger', async () => {
    const { db } = await ready();
    db.recall({ query: QUERY, limit: LIMIT });
    const retrieval = retrievalOf(db);
    expect('temporalRouting' in retrieval).toBe(false);
    expect(retrieval.granularity).toBeUndefined();
    expect(new Set(retrieval.candidates.map(candidate => candidate.granularity))).toEqual(new Set(['turn']));
  });
});

describe('each switch alone behaves exactly as its own branch does', () => {
  it('granularity alone blends the derived indexes and routes nothing', async () => {
    const { db } = await ready();
    const multi = db.recall({ query: QUERY, limit: LIMIT, granularity: 'multi' });
    expect(shape(db.recall({ query: QUERY, limit: LIMIT, granularity: 'multi', temporalRouting: 'off' }))).toEqual(shape(multi));
    expect(shape(multi)).not.toEqual(shape(db.recall({ query: QUERY, limit: LIMIT })));
    db.recall({ query: QUERY, limit: LIMIT, granularity: 'multi' });
    const retrieval = retrievalOf(db);
    expect('temporalRouting' in retrieval).toBe(false);
    expect(retrieval.granularity).toBeDefined();
  });

  it('temporal routing alone prioritises and consults no derived index', async () => {
    const { db } = await ready();
    const auto = db.recall({ query: QUERY, limit: LIMIT, temporalRouting: 'auto' });
    expect(shape(db.recall({ query: QUERY, limit: LIMIT, temporalRouting: 'auto', granularity: 'turn' }))).toEqual(shape(auto));
    expect(shape(auto)).not.toEqual(shape(db.recall({ query: QUERY, limit: LIMIT })));
    db.recall({ query: QUERY, limit: LIMIT, temporalRouting: 'auto' });
    const retrieval = retrievalOf(db);
    expect(retrieval.temporalRouting?.relation).toBe('at');
    expect(retrieval.granularity).toBeUndefined();
  });
});

describe('both on: the blend runs first, prioritisation runs on the blended list', () => {
  it('permutes the blended candidate list rather than producing a different one', async () => {
    const { db } = await ready();
    const multi = db.recall({ query: QUERY, limit: LIMIT, granularity: 'multi' });
    const both = db.recall({ query: QUERY, limit: LIMIT, granularity: 'multi', temporalRouting: 'auto' });
    // Prioritisation only permutes. The membership of the answer is therefore
    // the BLEND's decision, which is what "blend first" has to mean.
    expect(new Set(ids(both))).toEqual(new Set(ids(multi)));
    // And both switches genuinely contributed: neither single-switch run matches.
    expect(shape(both)).not.toEqual(shape(multi));
    expect(shape(both)).not.toEqual(shape(db.recall({ query: QUERY, limit: LIMIT, temporalRouting: 'auto' })));
  });

  it('leaves the June records ahead of every other month below the held head', async () => {
    const { db, seeded } = await ready();
    const both = ids(db.recall({ query: QUERY, limit: LIMIT, granularity: 'multi', temporalRouting: 'auto' }));
    const band = both.slice(TEMPORAL_PRIORITY_KEEP).map(id => seeded.monthOf.get(id) === JUNE);
    // Prioritisation applied LAST leaves the band partitioned: every in-window
    // record precedes every out-of-window one. Had it run before the blend, the
    // blend's RRF would have interleaved them again.
    expect(band.lastIndexOf(true)).toBeLessThan(band.indexOf(false));
    expect(band.filter(Boolean)).not.toHaveLength(0);
  });

  it('is a partition the blend alone does not already produce', async () => {
    const { db, seeded } = await ready();
    // The negative control for the assertion above: without prioritisation the
    // June records are NOT contiguous at the front, so that test has teeth.
    const multi = ids(db.recall({ query: QUERY, limit: LIMIT, granularity: 'multi' }));
    const band = multi.slice(TEMPORAL_PRIORITY_KEEP).map(id => seeded.monthOf.get(id) === JUNE);
    expect(band.lastIndexOf(true)).toBeGreaterThan(band.indexOf(false));
  });

  it('records both decisions in the ledger', async () => {
    const { db } = await ready();
    db.recall({ query: QUERY, limit: LIMIT, granularity: 'multi', temporalRouting: 'auto' });
    const retrieval = retrievalOf(db);
    expect(retrieval.temporalRouting?.relation).toBe('at');
    expect(retrieval.granularity).toBeDefined();
    expect([...new Set(retrieval.candidates.map(candidate => candidate.granularity))].some(level => level !== 'turn')).toBe(true);
  });
});
