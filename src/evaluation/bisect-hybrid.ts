/**
 * The seeded 2,000-record bisect case, on the hybrid path.
 *
 * The same store as the demo's moment 3 (`breakthrough/moment-3.ts`): a
 * synthetic ops corpus with one verified answer and, written later at ordinary
 * trust, one short false record that displaces it from rank 1. Here the store
 * retrieves on the `hybrid` path — dense and lexical fused — instead of the
 * zero-model lexical one, with the exact scan or the sqlite-vec index serving
 * the dense channel, and `bisect` has to isolate the seeded record with Oracle B
 * re-executing that hybrid retriever.
 *
 * The embedder is {@link hashedEmbedder}: a deterministic hashed bag of words,
 * so the case runs anywhere, with no model on disk and no network, and gives
 * the same ranking on every machine. It is a stand-in for the bundled model, not
 * a semantic one; what the case pins is bisect's mechanics on the hybrid path
 * (fusion, a dense index, stored vectors carried into every rebuild), not the
 * quality of any embedding model. The reranker is off for the same reason.
 *
 * Nothing in `bisect` knows which record was seeded. The case keeps that to
 * itself and scores the blame set afterwards, exactly as moment 3 does:
 * precision is the share of blamed records that are the seeded one.
 */
import { performance } from 'node:perf_hooks';
import { createLocalMemory, type SyncMemoryEmbedder } from '../local/index.js';
import { bisect, type BisectRetrievalConfig, type BisectTask } from '../local/bisect.js';
import { buildOpsCorpus, iso } from './breakthrough/corpus.js';

/** Seed and size of the published case; the same seed and floor as the five-moment demo. */
export const BISECT_HYBRID_SEED = 20261028;
export const BISECT_HYBRID_RECORDS = 2000;
export const HASHED_EMBEDDER_MODEL = 'mnemosyne-hashed-bow@1';

/**
 * A deterministic stand-in embedder: a hashed bag of lowercase alphanumeric
 * tokens, with a small constant floor so no vector has a zero norm. Counts the
 * passages it embeds, so a caller can see that a re-execution embedded none.
 */
export function hashedEmbedder(model = HASHED_EMBEDDER_MODEL, dimensions = 256): SyncMemoryEmbedder & { passages: number } {
  const vector = (text: string): number[] => {
    const out = new Array<number>(dimensions).fill(0.01);
    for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let hash = 0;
      for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      out[hash % dimensions] += 1;
    }
    return out;
  };
  const view = () => ({ model, dimensions, embed: async (texts: readonly string[]) => texts.map(vector) });
  const embedder = {
    model, dimensions, passages: 0,
    embedSync(texts: readonly string[], role?: 'query' | 'passage'): number[][] {
      if (role === 'passage') embedder.passages += texts.length;
      return texts.map(vector);
    },
    embed: async (texts: readonly string[]) => texts.map(vector),
    forQueries: view,
    forPassages: view,
    close: () => {},
  };
  return embedder;
}

export interface HybridBisectCaseOptions {
  seed?: number;
  records?: number;
  /** Dense index serving the source and every Oracle B rebuild. `hnsw` is refused by bisect, so it is not offered. */
  indexMode?: 'exact' | 'sqlite-vec';
}

export interface HybridBisectCaseResult {
  seed: number;
  records: number;
  k: number;
  depth: number;
  embedder: { model: string; dimensions: number; kind: string };
  indexRequested: 'exact' | 'sqlite-vec';
  /** The gold answer was rank 1 at the cut point before the false record arrived. */
  passedBefore: boolean;
  /** And the same question fails afterwards: the false record is rank 1. */
  failingAfter: boolean;
  outcome: string;
  reason: string;
  blame: number;
  seeded: number;
  /** Share of the blame set that is the seeded record; 0 for an empty blame set. */
  precision: number;
  /** The blame set is exactly the seeded record. */
  exact: boolean;
  goldRank: number | null;
  tests: number;
  universe: number;
  exactConfirmed: boolean | null;
  exactRetrieval: string | null;
  exactConfig: BisectRetrievalConfig | null;
  /** Passages embedded by Oracle B's rebuilds: 0 when every rebuild reused the stored vectors. */
  reembeddedPassages: number;
  /** Wall time of the `bisect` call alone, and of the whole case (seeding, embedding, bisect). */
  bisectSeconds: number;
  totalSeconds: number;
}

const MINUTE = 60_000;
const START = Date.UTC(2025, 0, 6, 8);

/** Seed the store, confirm the failure is real, bisect it, and score the blame set against the seeded record. */
export function runHybridBisectCase(options: HybridBisectCaseOptions = {}): HybridBisectCaseResult {
  const seed = options.seed ?? BISECT_HYBRID_SEED;
  const records = options.records ?? BISECT_HYBRID_RECORDS;
  const indexRequested = options.indexMode ?? 'exact';
  const started = performance.now();
  const corpus = buildOpsCorpus(seed, records);
  const embedder = hashedEmbedder();
  const clock = { value: START };
  const memory = createLocalMemory({
    path: ':memory:', workspaceId: 'bisect-hybrid-2k', agentId: 'operator',
    retrieval: 'hybrid', requireEmbedder: true, embedder, rerank: false, indexMode: indexRequested,
    now: () => new Date(clock.value),
  });
  try {
    let goldId = '', poisonId = '', goodUntil = '';
    memory.atomic(() => {
      corpus.filler.forEach((entry, index) => {
        clock.value += MINUTE;
        memory.store({ text: entry.text, kind: entry.kind, trust: 'observed', source: { uri: `synthetic://orion/ops/${index}`, author: `engineer-${index % 17}` } });
        if (index === corpus.goldAfter) {
          clock.value += MINUTE;
          goldId = memory.store({ text: corpus.gold.text, kind: 'fact', trust: 'verified', evidence: corpus.gold.evidence, source: corpus.gold.source }).id;
        }
        if (index === corpus.poisonAfter) {
          goodUntil = iso(clock.value);
          clock.value += MINUTE;
          poisonId = memory.store({ text: corpus.poison.text, kind: 'fact', trust: 'observed', source: corpus.poison.source }).id;
        }
      });
    });
    clock.value += MINUTE;
    const total = memory.export().memories.length;
    const before = memory.recall({ query: corpus.query, limit: 1, knownAt: goodUntil })[0]?.memory.id;
    const after = memory.recall({ query: corpus.query, limit: 1 })[0]?.memory.id;
    const embedded = embedder.passages;

    const task: BisectTask = { id: 'billing-port', query: corpus.query, k: 1, gold: [goldId], depth: 100 };
    const bisectStarted = performance.now();
    // A custom embedder cannot be rebuilt from a snapshot, so Oracle B is handed
    // the same one; every other setting is read off the source's `retrieval`.
    const result = bisect(memory, task, { storeOptions: { embedder } });
    const bisectSeconds = (performance.now() - bisectStarted) / 1000;

    const hits = result.blame.filter((id) => id === poisonId).length;
    return {
      seed, records: total, k: task.k, depth: task.depth ?? 100,
      embedder: { model: embedder.model, dimensions: embedder.dimensions, kind: 'hashed bag of words (deterministic stand-in, not semantic)' },
      indexRequested,
      passedBefore: before === goldId, failingAfter: after === poisonId,
      outcome: result.outcome, reason: result.reason,
      blame: result.blame.length, seeded: 1,
      precision: result.blame.length ? hits / result.blame.length : 0,
      exact: result.blame.length === 1 && hits === 1,
      goldRank: result.goldRank, tests: result.tests, universe: result.universe,
      exactConfirmed: result.exactConfirmed, exactRetrieval: result.exactRetrieval, exactConfig: result.exactConfig,
      reembeddedPassages: embedder.passages - embedded,
      bisectSeconds, totalSeconds: (performance.now() - started) / 1000,
    };
  } finally {
    memory.close();
  }
}
