import { afterEach, describe, expect, it } from 'vitest';
import { gatedDescribe } from './env-gates.js';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions, type SyncMemoryEmbedder } from '../src/local/index.js';
import { bisect, exactRunner, retrievalConfig, type BisectTask } from '../src/local/bisect.js';
import { BUNDLED_EMBEDDING_ID, bundledModelStatus } from '../src/local/embedding/index.js';
import { BUNDLED_RERANKER_ID, bundledRerankerStatus } from '../src/local/reranking/model-assets.js';

/**
 * Bisect on the default `hybrid` path.
 *
 * Oracle B has to re-execute the retriever the store actually runs. On hybrid
 * that means the same embedding model, fusion constant, dense floor, reranker
 * and dense index — and the same vectors, which a snapshot does not carry, so
 * they are copied across rather than recomputed. These cases pin that the
 * rebuilt store retrieves identically, that the blame it confirms is the seeded
 * record, and that a configuration it cannot reproduce is refused, not
 * quietly compared.
 */

const opened: LocalMemory[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); });

const T0 = Date.UTC(2024, 5, 1);
const NOTES = [
  'The quarterly invoice for the printer lease was paid on Tuesday.',
  'Priya prefers green tea over coffee in the afternoon.',
  'The bicycle needs a new rear tyre before the race.',
  'Weather on the coast turned stormy by the weekend.',
  'Marco is learning to play the cello at evening classes.',
  'The garden fence was painted dark blue last spring.',
  'Our team retrospective moved to Thursday mornings.',
  'The library returns desk closes at six on Fridays.',
  'Lena booked a cabin by the lake for August.',
  'The kitchen tap has been dripping since Monday.',
  'Sam adopted a grey cat called Pepper from the shelter.',
  'The museum exhibition on maps opens next month.',
  'Our backup server runs its nightly job at two a.m.',
  'The bakery on Elm Street sells rye bread on Saturdays.',
  'Jonas ran his first half marathon in under two hours.',
  'The harbour master inspects moorings every April.',
  'Dana repainted the hull of her boat in May.',
];

/** Nineteen records: seventeen unrelated notes, the sourced gold answer, and one short unsourced claim that outranks it. */
function seeded(options: Partial<LocalMemoryOptions> = {}): { memory: LocalMemory; gold: string; poison: string; task: BisectTask } {
  const memory = createLocalMemory({ path: ':memory:', workspaceId: 'bisect-hybrid', agentId: 'auditor', now: () => new Date(T0), ...options });
  opened.push(memory);
  NOTES.forEach((text, index) => memory.store({ text, trust: 'observed', source: { uri: `test://note/${index}` } }));
  const gold = memory.store({
    text: 'Dana named her sailboat Corvina after the summer refit at the boatyard.',
    kind: 'fact', trust: 'verified', evidence: 'transcript://session-4', source: { uri: 'test://transcript/gold' },
  });
  const poison = memory.store({ text: 'Dana named the sailboat Mistral.', trust: 'observed', source: { uri: 'test://rumour/0' } });
  const task: BisectTask = { id: 'sailboat', query: 'What did Dana name the sailboat?', k: 1, gold: [gold.id], depth: 20 };
  return { memory, gold: gold.id, poison: poison.id, task };
}

const withModels = gatedDescribe('model', bundledModelStatus().present && bundledRerankerStatus().present);

withModels('bisect on the default hybrid path', () => {
  it('blames the seeded record and Oracle B re-executes the same hybrid retriever', () => {
    const { memory, gold, poison, task } = seeded();
    // The default path, not a configured one: no `retrieval` option was given.
    expect(memory.retrieval.requested).toBe('hybrid');
    const top = memory.recall({ query: task.query, limit: 5 }).map(hit => hit.memory.id);
    // The fixture has to actually be poisoned, or the case proves nothing.
    expect(top.slice(0, 2)).toEqual([poison, gold]);

    const result = bisect(memory, task);
    expect(result.outcome).toBe('blamed');
    expect(result.reason).toBe('displaced');
    expect(result.blame).toEqual([poison]);
    expect(result.goldRank).toBe(2);
    expect(result.exactConfirmed).toBe(true);
    expect(result.exactRetrieval).toBe('hybrid');

    // What Oracle B ran is what the source runs, field for field.
    const source = retrievalConfig(memory.retrieval);
    expect(result.exactConfig).toEqual(source);
    expect(source).toMatchObject({ mode: 'hybrid', embeddingModel: BUNDLED_EMBEDDING_ID, dimensions: 384, rerankerModel: BUNDLED_RERANKER_ID, rrfK: 10, minSimilarity: 0 });
    expect(source.index).not.toBeNull();
  });

  it('rebuilds a store that retrieves identically to the source', () => {
    const { memory, task } = seeded();
    const expected = memory.recall({ query: task.query, limit: 19 }).map(hit => hit.memory.id);
    expect(expected).toHaveLength(19);
    const run = exactRunner(memory, task);
    // Nothing ablated: the rebuilt store must return every record in the same order.
    expect(run(new Set(), 19).ids).toEqual(expected);
    // Twice, so the second rebuild is not leaning on anything the first one left behind.
    expect(run(new Set(), 19).ids).toEqual(expected);
  });

  it('confirms 1-minimality by real hybrid re-execution', () => {
    const { memory, poison, task } = seeded();
    const result = bisect(memory, task, { confirm: 'minimal' });
    expect(result.blame).toEqual([poison]);
    expect(result.exactConfirmed).toBe(true);
    expect(result.exactMinimal).toBe(true);
  });

  it('refuses when the caller asks Oracle B for a different path than the store uses', () => {
    const { memory, task } = seeded();
    expect(() => bisect(memory, task, { storeOptions: { retrieval: 'lexical' } }))
      .toThrow(/re-executes on the lexical path but the store retrieves with hybrid/);
  });
});

/**
 * A deterministic stand-in embedder: hashed bag of words. It runs without any
 * model on disk, counts the passages it is asked to embed, and lets a second
 * instance claim a different model identity.
 */
function hashedEmbedder(model: string): SyncMemoryEmbedder & { passages: number } {
  const dimensions = 256;
  const vector = (text: string): number[] => {
    const out = new Array<number>(dimensions).fill(0.01);
    for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let hash = 0;
      for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      out[hash % dimensions] += 1;
    }
    return out;
  };
  const embedder = {
    model, dimensions, passages: 0,
    embedSync(texts: readonly string[], role?: 'query' | 'passage'): number[][] {
      if (role === 'passage') embedder.passages += texts.length;
      return texts.map(vector);
    },
    embed: async (texts: readonly string[]) => texts.map(vector),
    forQueries: () => ({ model, dimensions, embed: async (texts: readonly string[]) => texts.map(vector) }),
    forPassages: () => ({ model, dimensions, embed: async (texts: readonly string[]) => texts.map(vector) }),
    close: () => {},
  };
  return embedder;
}

describe('bisect carries the stored vectors instead of re-embedding', () => {
  it('re-executes hybrid without embedding a single passage again', () => {
    const embedder = hashedEmbedder('test-hashed-embedder@1');
    const { memory, gold, poison, task } = seeded({ embedder, rerank: false });
    expect(memory.recall({ query: task.query, limit: 2 }).map(hit => hit.memory.id)).toEqual([poison, gold]);
    const embedded = embedder.passages;
    expect(embedded).toBe(19);

    // A custom embedder cannot be conjured from a snapshot, so it is supplied;
    // everything else is read off the source.
    const result = bisect(memory, task, { storeOptions: { embedder }, confirm: 'minimal' });
    expect(result.outcome).toBe('blamed');
    expect(result.blame).toEqual([poison]);
    expect(result.exactConfirmed).toBe(true);
    expect(result.exactConfig).toEqual(retrievalConfig(memory.retrieval));
    expect(result.exactConfig).toMatchObject({ mode: 'hybrid', embeddingModel: 'test-hashed-embedder@1', rerankerModel: null });
    // Every Oracle B store got its vectors from the source: only queries were embedded.
    expect(embedder.passages).toBe(embedded);
  });

  it('refuses when the rebuilt store would embed with a different model', () => {
    const { memory, task } = seeded({ embedder: hashedEmbedder('test-hashed-embedder@1'), rerank: false });
    expect(() => bisect(memory, task, { storeOptions: { embedder: hashedEmbedder('test-hashed-embedder@2') } }))
      .toThrow(/cannot reproduce the store's retrieval: .*embeddingModel "test-hashed-embedder@2" where the source has "test-hashed-embedder@1"/);
  });

  it('refuses when the caller names the lexical path for a hybrid store', () => {
    const { memory, task } = seeded({ embedder: hashedEmbedder('test-hashed-embedder@1'), rerank: false });
    expect(() => bisect(memory, task, { storeOptions: { retrieval: 'lexical' } }))
      .toThrow(/re-executes on the lexical path but the store retrieves with hybrid/);
  });
});
