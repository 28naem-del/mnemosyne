/**
 * Memory bisect: which records are to blame for a retrieval failure.
 *
 * Given a task that used to succeed and now fails — the gold evidence is no
 * longer in the top-k — delta-debug the visible record set down to a minimal
 * set whose removal makes the task pass again. The verifier has **no model in
 * it**: outcome is "are the gold ids in the top-k", which is deterministic,
 * reproducible and costs nothing. That is also the §2.3 principle — the audit
 * root of trust does not contain a thing that can be talked into an answer.
 *
 * Two oracles, because the two jobs have different budgets:
 *
 *  - **Oracle A, cached-rank ablation.** Recall once at `depth`, keep the
 *    ordered id list, and answer "would the task pass with these ids removed?"
 *    by walking that list. Microseconds per test, which is what makes ddmin
 *    affordable on a 10k-record store. It is exact about displacement — who
 *    pushed the gold out of the top-k — and blind to second-order scoring
 *    effects, because removing a record also moves BM25's IDF and average
 *    document length.
 *  - **Oracle B, exact re-execution.** Rebuild a store without the ablated
 *    records and run the real `recall`. This is the real answer and it costs a
 *    full re-index, so it confirms rather than searches. A blame set Oracle B
 *    will not confirm comes back as `outcome: 'unconfirmed'`, not as a blame
 *    set with a flag on it — never quietly kept.
 *
 * **Oracle B re-executes the store's own retriever.** By default it rebuilds on
 * whatever path the source reports through `retrieval.mode` — the zero-model
 * lexical path, or the default `hybrid` path. For hybrid it reproduces the
 * source's configuration as the source reports it (embedding model, `rrfK`,
 * `minSimilarity`, reranker on/off and `rerankTopN`, dense index kind) and does
 * not re-embed anything: a snapshot never carries vectors, so the stored
 * vectors are copied across byte-for-byte with `exportEmbeddings` /
 * `importEmbeddings`, keyed by memory id and text hash, and only the query is
 * embedded — by the same pinned model. After every re-execution the rebuilt
 * store's reported configuration is compared with the source's, and any
 * difference (a custom embedder or reranker the default rebuild cannot load, a
 * different model cache) throws instead of comparing two different retrievers;
 * pass `storeOptions` to supply them. The reported configuration does not
 * cover the instance precision defaults (`requireNamedMatch`, `minScores`,
 * `fuzzy`), and a snapshot does not carry them either, so before Oracle B judges
 * any ablation the default rebuild must also reproduce the source's own
 * unablated ranking at the task's depth, id for id; when it does not, bisect
 * throws and names the defaults to pass in `storeOptions` rather than answering
 * for a different retriever. Two cases refuse outright: asking for a
 * different path than the store retrieves with (e.g. `storeOptions.retrieval:
 * 'lexical'` on a hybrid store), and an `hnsw` dense index, whose approximate
 * graph depends on insertion order and so cannot be rebuilt identically.
 * `exactConfig` in the result is the configuration Oracle B actually ran.
 *
 * Nothing here knows which records were injected. A caller that seeds faults
 * keeps that knowledge to itself and scores the answer afterwards.
 */
import { createLocalMemory, type LocalMemory } from './index.js';
import { replayState, type ReplaySource } from './replay.js';
import type { LocalMemoryOptions, MemoryRecord, MemorySnapshot, RecallInput, RecallResult, StoredEmbedding } from './types.js';

/** A retrieval task with a checkable outcome. `gold` is the evidence that should be found. */
export interface BisectTask {
  id: string;
  query: string;
  /** The bitemporal cut point the failure happened at. Both optional; both are passed to `recall`. */
  asOf?: string;
  knownAt?: string;
  /** Top-k the outcome is judged at. */
  k: number;
  gold: string[];
  /** `any` (default): one gold id in the top-k passes. `all`: every gold id must be there. */
  require?: 'any' | 'all';
  lexicalScoring?: 'overlap' | 'bm25';
  /**
   * Candidate depth for the cached-rank oracle, 1–100. Defaults to 100.
   *
   * The ceiling is the kernel's: `recall` validates `limit` at a maximum of 100
   * (`src/local/validation.ts:30`), so a single recall cannot return a deeper
   * ranking than that. Depth beyond 100 is reached by widening — see
   * {@link BisectOptions.maxWidenings} — which costs a real re-execution.
   */
  depth?: number;
  includeUntrusted?: boolean;
}

/** What a store reports about its retrieval path — the subset of `RetrievalStatus` bisect reads. */
export interface BisectRetrievalStatus {
  requested: string;
  mode: string;
  embeddingModel?: string;
  dimensions?: number;
  rerankerModel?: string;
  rerankTopN?: number;
  rrfK?: number;
  minSimilarity?: number;
  index?: { requested: string; mode: string };
}

/** The retrieval configuration Oracle B has to reproduce. `null` where it does not apply (every field but `mode` on the lexical path). */
export interface BisectRetrievalConfig {
  mode: string;
  embeddingModel: string | null;
  dimensions: number | null;
  rerankerModel: string | null;
  rerankTopN: number | null;
  rrfK: number | null;
  minSimilarity: number | null;
  /** Dense index that served recall (`exact`, `sqlite-vec`, `hnsw`); null on the lexical path or before a dense recall ran. */
  index: string | null;
}

/** The subset of `LocalMemory` bisect reads. Structural, so a test can hand in a fake. */
export interface BisectSource extends ReplaySource {
  recall(input: RecallInput): RecallResult[];
  export(): MemorySnapshot;
  /** Read so Oracle B rebuilds the same retriever, and refuses when it cannot. */
  retrieval?: BisectRetrievalStatus;
  /** Stored dense vectors, copied into Oracle B's store so the hybrid path is reproduced without re-embedding. */
  exportEmbeddings?(model?: string): StoredEmbedding[];
}

export interface BisectStore {
  recall(input: RecallInput): RecallResult[];
  close(): void;
  /** When present, compared with the source's after every re-execution; a difference throws. */
  readonly retrieval?: BisectRetrievalStatus;
}

/** What Oracle B carries into a rebuilt store besides the snapshot. */
export interface BisectCarry {
  /** The source's stored vectors for the records that survived the ablation. Empty on the lexical path. */
  embeddings: StoredEmbedding[];
}

export interface BisectOptions {
  /** Promote Oracle B to the search oracle. Correct, and slow enough to be opt-in. */
  exact?: boolean;
  /**
   * How much Oracle B confirmation to run:
   * - `off` — none; `exactConfirmed` is null.
   * - `outcome` (default) — the recorded failure really fails, and removing the blame set really passes.
   * - `minimal` — also re-execute one ablation per blame record to confirm 1-minimality exactly.
   */
  confirm?: 'off' | 'outcome' | 'minimal';
  /**
   * How many times to extend the ranking past `depth` when the gold is not in
   * it. Defaults to 3. Each widening re-executes the real recall with every
   * non-gold id seen so far ablated, which surfaces the next block of
   * candidates — so the effective depth is `depth * (1 + maxWidenings)`, paid
   * one full re-index at a time and only when it is needed.
   */
  maxWidenings?: number;
  /** Hash the belief state at the cut point and report it beside the blame set. Defaults to true. */
  stateHash?: boolean;
  /**
   * Options for the store Oracle B rebuilds, applied over the configuration
   * read from the source (its `retrieval.mode`, and on hybrid its model, fusion
   * and reranker settings). Without a source report it is the zero-model
   * lexical path. Naming a different `retrieval` than the source uses refuses.
   */
  storeOptions?: Partial<LocalMemoryOptions>;
  /** Replaces the default in-memory store Oracle B builds. */
  createStore?: (snapshot: MemorySnapshot, options: Partial<LocalMemoryOptions>, carry: BisectCarry) => BisectStore;
  /** Monotonic clock, in milliseconds. Defaults to `performance.now`. */
  now?: () => number;
  /** Hard cap on Oracle-A tests, a runaway guard. Defaults to 200000. */
  maxTests?: number;
}

export interface BisectResult {
  taskId: string;
  /**
   * - `blamed` — a minimal set of records whose removal makes the task pass.
   * - `passing` — the task already passes; there is nothing to blame.
   * - `unfixable` — removing every candidate still does not surface the gold, so
   *   the failure is not a displacement failure at this depth.
   * - `unconfirmed` — ddmin found a set, and Oracle B would not stand behind it.
   *   `blame` still carries the set so it can be looked at; it is not an answer.
   *   Only reachable with confirmation on, which is the default.
   *
   * A consumer that switches on `outcome` gets the truth without having to also
   * read `exactConfirmed` — the v2 lesson about flags nobody checks.
   */
  outcome: 'blamed' | 'passing' | 'unfixable' | 'unconfirmed';
  /** Why the search ended where it did. Present on every outcome, so `unfixable` is never a shrug. */
  reason: 'displaced' | 'already-passing' | 'gold-not-retrievable' | 'ablation-insufficient'
    | 'blame-not-confirmed' | 'failure-not-reproduced';
  blame: string[];
  /** Ordered candidate ids the search ran over, before gold was excluded. */
  candidates: number;
  /**
   * `single-recall` — the ranking came from one real recall.
   * `stacked` — it was extended by widening, so later entries were ranked in a
   * context where the earlier block had been ablated. Oracle A still answers the
   * displacement question over that list; the scores behind it were not all
   * computed against the same corpus statistics, and this is how you know.
   */
  ranking: 'single-recall' | 'stacked';
  /** Size of the ablation universe ddmin searched. */
  universe: number;
  /** Oracle-A tests ddmin spent. */
  tests: number;
  widenings: number;
  depth: number;
  /** Rank of the best-placed gold id in the unablated ranking, 1-based; null if absent. */
  goldRank: number | null;
  /**
   * True when no equally small blame set exists that differs from this one by a
   * single swap. At k > 1 several minimal sets normally exist — any `m` of the
   * records above the gold will do — and this says which case you are in.
   *
   * Computed with the cached-rank oracle, so it inherits that oracle's blindness
   * to second-order scoring effects: it is a statement about the ranking, not a
   * re-executed one. `exactMinimal` under `confirm: 'minimal'` is the re-executed
   * statement, and the two can disagree.
   */
  minimalUnique: boolean | null;
  /** Same-size alternatives found by the cached-rank swap search, capped at 64; null under `exact`. */
  alternatives: number | null;
  /** Oracle B agreed: the recorded failure fails and removing the blame set passes. */
  exactConfirmed: boolean | null;
  /** Oracle B agreed that no single record can be dropped from the blame set. Only under `confirm: 'minimal'`. */
  exactMinimal: boolean | null;
  /** Retrieval mode Oracle B re-executed under; `null` when it did not run. */
  exactRetrieval: string | null;
  /**
   * The configuration Oracle B's rebuilt store reported, already checked equal
   * to the source's (a mismatch throws rather than returning). `null` when
   * Oracle B did not run or a custom `createStore` reports no `retrieval`.
   */
  exactConfig: BisectRetrievalConfig | null;
  /** State hash of the belief state at the cut point, when it was computed. */
  stateSha256: string | null;
  elapsedMs: number;
}

/** `recall` validates `limit` at 1–100 (`src/local/validation.ts:30`); a ranking cannot be deeper in one call. */
const RECALL_LIMIT_MAX = 100;
const DEFAULT_DEPTH = RECALL_LIMIT_MAX;
const MAX_ALTERNATIVES = 64;

/**
 * Zeller & Hildebrandt's ddmin. `interesting(subset)` means "removing this
 * subset makes the task pass". Returns a 1-minimal interesting subset: the
 * final round tests every single-element removal, so no element in the result
 * can be dropped without losing the property.
 */
export function ddmin<T>(universe: readonly T[], interesting: (subset: readonly T[]) => boolean, maxTests = 200_000): { minimal: T[]; tests: number } {
  let tests = 0;
  const test = (subset: readonly T[]): boolean => {
    if (++tests > maxTests) throw new Error(`ddmin exceeded ${maxTests} tests`);
    return interesting(subset);
  };
  let current = [...universe];
  let n = 2;
  while (current.length >= 2) {
    const size = Math.ceil(current.length / n);
    const chunks: T[][] = [];
    for (let start = 0; start < current.length; start += size) chunks.push(current.slice(start, start + size));

    const chunk = chunks.find(candidate => candidate.length > 0 && test(candidate));
    if (chunk) { current = chunk; n = 2; continue; }

    let reduced: T[] | undefined;
    for (const candidate of chunks) {
      const complement = current.filter(entry => !candidate.includes(entry));
      if (complement.length && complement.length < current.length && test(complement)) { reduced = complement; break; }
    }
    if (reduced) { current = reduced; n = Math.max(n - 1, 2); continue; }

    if (n >= current.length) break;
    n = Math.min(n * 2, current.length);
  }
  return { minimal: current, tests };
}

/**
 * Oracle A. `ranked` is the ordered candidate list from one real recall;
 * the predicate replays the top-k over it with `removed` skipped.
 */
export function rankOracle(ranked: readonly string[], gold: readonly string[], k: number, require: 'any' | 'all' = 'any'): (removed: ReadonlySet<string>) => boolean {
  const goldSet = new Set(gold);
  return (removed) => {
    const top: string[] = [];
    for (const id of ranked) {
      if (removed.has(id)) continue;
      top.push(id);
      if (top.length >= k) break;
    }
    const found = top.filter(id => goldSet.has(id));
    return require === 'all' ? gold.every(id => found.includes(id)) : found.length > 0;
  };
}

/**
 * Every record that cannot survive without one of `removed`: anything that
 * depends on it, corrects it, or cites it as an invalidation cause, transitively.
 * A snapshot is self-contained, so importing a dangling link is rejected — the
 * ablation has to take the closure with it, and the caller is told it did.
 */
export function ablationClosure(records: readonly MemoryRecord[], removed: Iterable<string>): Set<string> {
  const dependents = new Map<string, string[]>();
  const link = (target: string | undefined, dependent: string): void => {
    if (!target) return;
    dependents.set(target, [...(dependents.get(target) ?? []), dependent]);
  };
  for (const record of records) {
    for (const id of record.dependencies) link(id, record.id);
    link(record.supersedes, record.id);
    if (record.invalidation) { link(record.invalidation.sourceId, record.id); link(record.invalidation.correctionId, record.id); }
  }
  const closure = new Set<string>();
  const pending = [...removed];
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index];
    if (closure.has(id)) continue;
    closure.add(id);
    pending.push(...(dependents.get(id) ?? []));
  }
  return closure;
}

/** A snapshot with `removed` and everything that depends on it taken out. */
export function ablateSnapshot(snapshot: MemorySnapshot, removed: Iterable<string>): { snapshot: MemorySnapshot; removed: Set<string> } {
  const closure = ablationClosure(snapshot.memories, removed);
  const memories = snapshot.memories.filter(record => !closure.has(record.id));
  return {
    snapshot: {
      ...snapshot,
      memories,
      outcomes: snapshot.outcomes.filter(entry => !closure.has(entry.memoryId)),
      ...(snapshot.idempotency === undefined ? {} : { idempotency: snapshot.idempotency.filter(entry => !closure.has(entry.memoryId)) }),
    },
    removed: closure,
  };
}

function defaultStore(snapshot: MemorySnapshot, options: Partial<LocalMemoryOptions>, carry?: BisectCarry): BisectStore {
  const memory: LocalMemory = createLocalMemory({
    retrieval: 'lexical', rerank: false, ledger: false,
    ...options,
    path: ':memory:', workspaceId: snapshot.workspaceId, agentId: snapshot.agentId,
  });
  try {
    memory.import(snapshot);
    // Byte-identical vectors, so the dense channel scores exactly what the source scored.
    if (carry?.embeddings.length) memory.importEmbeddings(carry.embeddings);
  } catch (error) { memory.close(); throw error; }
  return { recall: (input) => memory.recall(input), close: () => memory.close(), get retrieval() { return memory.retrieval; } };
}

export function retrievalConfig(status: BisectRetrievalStatus): BisectRetrievalConfig {
  return {
    mode: status.mode,
    embeddingModel: status.embeddingModel ?? null, dimensions: status.dimensions ?? null,
    rerankerModel: status.rerankerModel ?? null, rerankTopN: status.rerankTopN ?? null,
    rrfK: status.rrfK ?? null, minSimilarity: status.minSimilarity ?? null,
    index: status.index?.mode ?? null,
  };
}

/** The path Oracle B re-executes on: what the caller named, else what the source retrieves with. */
function wantedRetrieval(source: BisectSource, options: BisectOptions): string {
  return String(options.storeOptions?.retrieval ?? source.retrieval?.mode ?? 'lexical');
}

/** Why an `hnsw` store is refused. Exported so the CLI, which can see a recorded hnsw index before opening one, refuses with the same reason. */
export const HNSW_REFUSAL = 'bisect cannot reproduce an hnsw dense index: its approximate graph depends on insertion order, so a rebuilt store would not retrieve identically; open the store with indexMode: \'exact\' or \'sqlite-vec\'';

interface ReexecutionPlan { mode: string; storeOptions: Partial<LocalMemoryOptions>; expected: BisectRetrievalConfig | null }

/**
 * How Oracle B rebuilds the source's retriever. Read lazily — after bisect's
 * own recall — so the source has already resolved its models and dense index.
 */
function reexecutionPlan(source: BisectSource, options: BisectOptions): ReexecutionPlan {
  const status = source.retrieval;
  const mode = wantedRetrieval(source, options);
  if (status && status.mode !== mode) {
    throw new Error(`bisect re-executes on the ${mode} path but the store retrieves with ${status.mode}: Oracle B must run the store's own retriever, so drop storeOptions.retrieval or open the store with retrieval: '${mode}'`);
  }
  const expected = status ? retrievalConfig(status) : null;
  if (mode !== 'hybrid' || !status) return { mode, storeOptions: { ...options.storeOptions }, expected };
  if (status.index?.mode === 'hnsw' || status.index?.requested === 'hnsw') {
    throw new Error(HNSW_REFUSAL);
  }
  return {
    mode, expected,
    storeOptions: {
      retrieval: 'hybrid', requireEmbedder: true, ledger: false,
      rerank: status.rerankerModel !== undefined,
      ...(status.rerankTopN === undefined ? {} : { rerankTopN: status.rerankTopN }),
      ...(status.rrfK === undefined ? {} : { rrfK: status.rrfK }),
      ...(status.minSimilarity === undefined ? {} : { minSimilarity: status.minSimilarity }),
      ...(status.index === undefined ? {} : { indexMode: status.index.requested as LocalMemoryOptions['indexMode'] }),
      ...options.storeOptions,
    },
  };
}

/** Throws unless the rebuilt store runs the retriever the source runs. The index kind is compared once the source has reported one. */
function assertSameRetrieval(expected: BisectRetrievalConfig, actual: BisectRetrievalConfig): void {
  for (const key of Object.keys(expected) as (keyof BisectRetrievalConfig)[]) {
    if (key === 'index' && expected.index === null) continue;
    if (expected[key] !== actual[key]) {
      throw new Error(`bisect cannot reproduce the store's retrieval: Oracle B's rebuilt store has ${key} ${JSON.stringify(actual[key])} where the source has ${JSON.stringify(expected[key])}; pass storeOptions (the same embedder, reranker or modelCacheDir) so both run the same retriever`);
    }
  }
}

function recallInput(task: BisectTask, limit: number): RecallInput {
  return {
    query: task.query, limit,
    ...(task.asOf === undefined ? {} : { asOf: task.asOf }),
    ...(task.knownAt === undefined ? {} : { knownAt: task.knownAt }),
    ...(task.lexicalScoring === undefined ? {} : { lexicalScoring: task.lexicalScoring }),
    ...(task.includeUntrusted === undefined ? {} : { includeUntrusted: task.includeUntrusted }),
  };
}

function satisfied(found: readonly string[], task: BisectTask): boolean {
  const gold = new Set(task.gold);
  const hits = found.filter(id => gold.has(id));
  return (task.require ?? 'any') === 'all' ? task.gold.every(id => hits.includes(id)) : hits.length > 0;
}

/**
 * Re-executes the real recall against a store rebuilt without `removed`. One
 * export is taken per bisect and reused; each call pays a fresh import and
 * index build, which is why this confirms rather than searches. Before the
 * first, the default rebuild is checked against one real recall on the source
 * at the task's depth (a recall a ledgered source records like any other), and
 * throws when the two do not rank the same.
 */
export function exactRunner(source: BisectSource, task: BisectTask, options: BisectOptions = {}): (removed: ReadonlySet<string>, limit: number) => { ids: string[]; goldRemoved: boolean } {
  return reexecutor(source, task, options).run;
}

/** The source's own unablated ranking, which the default rebuild has to reproduce. */
interface SourceRanking { ids: readonly string[]; limit: number }

/**
 * Throws unless the rebuilt store, with nothing ablated, ranks exactly as the
 * source does. `retrieval` reports neither the instance precision defaults
 * (`requireNamedMatch`, `minScores`, `fuzzy`) nor anything else a snapshot does
 * not carry, so the configuration check alone cannot see them dropped; the
 * ranking can.
 */
function assertSameRanking(source: SourceRanking, rebuilt: readonly string[]): void {
  const length = Math.max(source.ids.length, rebuilt.length);
  for (let index = 0; index < length; index++) {
    if (source.ids[index] === rebuilt[index]) continue;
    throw new Error(`bisect cannot reproduce the store's retrieval: with nothing ablated, Oracle B's rebuilt store ranks ${rebuilt.length} record(s) for this task where the source ranks ${source.ids.length}, first differing at rank ${index + 1} of ${source.limit}. The source probably sets precision defaults a snapshot does not carry (requireNamedMatch, minScores, fuzzy); pass the same values in storeOptions so both run the same retriever`);
  }
}

/**
 * `reference` supplies the source ranking the default rebuild is checked
 * against (else one source recall is made for it). With `keepBaseline` the
 * checked, unablated rebuild stays open and answers every later no-removal run,
 * so the check costs no extra re-index; `dispose` closes it.
 */
function reexecutor(source: BisectSource, task: BisectTask, options: BisectOptions, reference?: () => SourceRanking | undefined, keepBaseline = false): {
  run: (removed: ReadonlySet<string>, limit: number) => { ids: string[]; goldRemoved: boolean };
  plan: () => ReexecutionPlan;
  observed: () => BisectRetrievalConfig | null;
  dispose: () => void;
} {
  let prepared: { plan: ReexecutionPlan; snapshot: MemorySnapshot; embeddings: StoredEmbedding[] } | undefined;
  let observed: BisectRetrievalConfig | null = null;
  let baseline: BisectStore | undefined;
  const create = options.createStore ?? defaultStore;
  const prepare = (): NonNullable<typeof prepared> => {
    if (prepared) return prepared;
    const plan = reexecutionPlan(source, options);
    const model = plan.mode === 'hybrid' ? plan.expected?.embeddingModel ?? null : null;
    // A source that cannot hand over its vectors still gets a correct rebuild —
    // the store re-embeds with the same model, which the config check pins.
    const embeddings = model !== null && source.exportEmbeddings ? source.exportEmbeddings(model) : [];
    const snapshot = source.export();
    // The default rebuild must be the source's retriever before any ablation is
    // judged against it. A caller-supplied `createStore` owns that equivalence.
    if (!options.createStore) {
      const expected = reference?.() ?? (() => {
        const limit = task.depth ?? DEFAULT_DEPTH;
        return { limit, ids: source.recall(recallInput(task, limit)).map(hit => hit.memory.id) };
      })();
      const store = create(snapshot, plan.storeOptions, { embeddings });
      let keep = false;
      try {
        const ids = store.recall(recallInput(task, expected.limit)).map(hit => hit.memory.id);
        const reported = store.retrieval;
        if (reported) {
          observed = retrievalConfig(reported);
          if (plan.expected) assertSameRetrieval(plan.expected, observed);
        }
        assertSameRanking(expected, ids);
        keep = keepBaseline;
      } finally { if (keep) baseline = store; else store.close(); }
    }
    return (prepared = { plan, snapshot, embeddings });
  };
  const run = (removed: ReadonlySet<string>, limit: number): { ids: string[]; goldRemoved: boolean } => {
    const { plan, snapshot, embeddings } = prepare();
    const ablated = ablateSnapshot(snapshot, removed);
    // Ablating the gold itself, or a record the gold depends on, answers a different question.
    if (task.gold.some(id => ablated.removed.has(id))) return { ids: [], goldRemoved: true };
    const kept = embeddings.filter(row => !ablated.removed.has(row.memoryId));
    const reuse = ablated.removed.size === 0 ? baseline : undefined;
    const store = reuse ?? create(ablated.snapshot, plan.storeOptions, { embeddings: kept });
    try {
      const ids = store.recall(recallInput(task, limit)).map(hit => hit.memory.id);
      const reported = store.retrieval;
      if (reported) {
        observed = retrievalConfig(reported);
        if (plan.expected) assertSameRetrieval(plan.expected, observed);
      }
      return { ids, goldRemoved: false };
    } finally { if (store !== reuse) store.close(); }
  };
  const dispose = (): void => { baseline?.close(); baseline = undefined; };
  return { run, plan: () => prepare().plan, observed: () => observed, dispose };
}

/** Oracle B as a predicate: does the task pass with `removed` really gone? */
export function exactOracle(source: BisectSource, task: BisectTask, options: BisectOptions = {}): (removed: ReadonlySet<string>) => boolean {
  const run = exactRunner(source, task, options);
  return (removed) => {
    const result = run(removed, task.k);
    return result.goldRemoved ? false : satisfied(result.ids, task);
  };
}

/**
 * Counts same-size blame sets reachable by swapping one member for one
 * non-member. At k > 1 the minimal set is genuinely not unique — any `m` of the
 * records ranked above the gold is a minimal fix — and this measures that
 * instead of letting the precision number quietly absorb it.
 */
function countAlternatives(universe: readonly string[], blame: readonly string[], interesting: (removed: ReadonlySet<string>) => boolean): number {
  const chosen = new Set(blame);
  const outside = universe.filter(id => !chosen.has(id));
  let found = 0;
  for (const drop of blame) {
    for (const add of outside) {
      const candidate = new Set(blame.filter(id => id !== drop));
      candidate.add(add);
      if (interesting(candidate)) { if (++found >= MAX_ALTERNATIVES) return found; }
    }
  }
  return found;
}

/**
 * Every id whose removal would take a gold record with it: the gold itself and
 * everything it hangs off — dependencies, the record it supersedes, its
 * invalidation cause and correction — transitively.
 *
 * These can never be candidates. Ablating one deletes the evidence, so the task
 * cannot pass in the resulting store no matter what else is removed, and a
 * "blame set" containing one is an answer to a different question. `exactRunner`
 * already refuses such an ablation; this keeps them out of the search itself, so
 * the cheap oracle — which walks a flat id list and knows nothing about links —
 * cannot propose one.
 */
export function goldSupport(source: Pick<BisectSource, 'getAt'>, task: BisectTask): Set<string> {
  const time = {
    ...(task.asOf === undefined ? {} : { asOf: task.asOf }),
    ...(task.knownAt === undefined ? {} : { knownAt: task.knownAt }),
  };
  const support = new Set<string>();
  const pending = [...task.gold];
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index];
    if (support.has(id)) continue;
    support.add(id);
    const record = source.getAt(id, time);
    if (!record) continue;
    pending.push(...record.dependencies);
    if (record.supersedes) pending.push(record.supersedes);
    if (record.invalidation?.sourceId) pending.push(record.invalidation.sourceId);
    if (record.invalidation?.correctionId) pending.push(record.invalidation.correctionId);
  }
  return support;
}

function goldRank(ranked: readonly string[], gold: ReadonlySet<string>): number | null {
  const index = ranked.findIndex(id => gold.has(id));
  return index === -1 ? null : index + 1;
}

/** Delta-debug `task`'s failure down to a minimal blame set. */
export function bisect(source: BisectSource, task: BisectTask, options: BisectOptions = {}): BisectResult {
  const clock = options.now ?? (() => performance.now());
  const started = clock();
  const require = task.require ?? 'any';
  const depth = task.depth ?? DEFAULT_DEPTH;
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > RECALL_LIMIT_MAX) {
    throw new TypeError(`bisect depth must be an integer between 1 and ${RECALL_LIMIT_MAX}: recall itself caps limit there`);
  }
  const maxWidenings = options.maxWidenings ?? 3;
  const maxTests = options.maxTests ?? 200_000;
  const confirm = options.confirm ?? 'outcome';
  const goldSet = new Set(task.gold);
  // Oracle B rebuilds the store and re-runs recall. That is only the same
  // question when the rebuilt store retrieves the same way, so it re-executes
  // on the path the source reports — lexical, or hybrid with the vectors
  // carried across — and refuses up front, before any work, when the caller
  // names a different one rather than quietly comparing two retrievers.
  const mode = source.retrieval?.mode;
  const wanted = wantedRetrieval(source, options);
  if (mode !== undefined && mode !== wanted) {
    throw new Error(`bisect re-executes on the ${wanted} path but the store retrieves with ${mode}: Oracle B must run the store's own retriever, so drop storeOptions.retrieval or open the store with retrieval: '${wanted}'`);
  }
  // Filled by the first real recall below, before Oracle B can run: the default
  // rebuild has to reproduce it before any ablation is judged.
  let sourceRanking: SourceRanking | undefined;
  const reexecution = reexecutor(source, task, options, () => sourceRanking, true);
  try {
    return locate(source, task, options, reexecution, (ranking) => { sourceRanking = ranking; }, { started, clock, require, depth, maxWidenings, maxTests, confirm, goldSet });
  } finally { reexecution.dispose(); }
}

interface SearchSettings {
  started: number; clock: () => number; require: 'any' | 'all'; depth: number;
  maxWidenings: number; maxTests: number; confirm: NonNullable<BisectOptions['confirm']>; goldSet: Set<string>;
}

function locate(source: BisectSource, task: BisectTask, options: BisectOptions, reexecution: ReturnType<typeof reexecutor>, recordRanking: (ranking: SourceRanking) => void, settings: SearchSettings): BisectResult {
  const { started, clock, require, depth, maxWidenings, maxTests, confirm, goldSet } = settings;
  const run = reexecution.run;

  const stateSha256 = options.stateHash === false || (task.asOf === undefined && task.knownAt === undefined)
    ? null
    : replayState(source, { knownAt: task.knownAt ?? task.asOf!, ...(task.asOf === undefined ? {} : { asOf: task.asOf }) }).stateSha256;

  // The ranking the search runs over. One real recall, extended by widening only
  // if the gold is not in it — each widening is a real re-execution, so it is
  // paid for and counted, never assumed.
  const ranked: string[] = source.recall(recallInput(task, depth)).map(hit => hit.memory.id);
  recordRanking({ ids: [...ranked], limit: depth });
  let widenings = 0;
  while (!ranked.some(id => goldSet.has(id)) && widenings < maxWidenings && ranked.length >= depth) {
    const next = run(new Set(ranked.filter(id => !goldSet.has(id))), depth);
    widenings++;
    const fresh = next.ids.filter(id => !ranked.includes(id));
    if (!fresh.length) break;
    ranked.push(...fresh);
  }

  const passes = rankOracle(ranked, task.gold, task.k, require);
  // Not `!goldSet.has(id)`: a record the gold depends on takes the gold with it
  // when it is ablated, so removing it can never make the task pass.
  const support = goldSupport(source, task);
  const universe = ranked.filter(id => !support.has(id));
  const ranking: BisectResult['ranking'] = widenings === 0 ? 'single-recall' : 'stacked';
  const shared = {
    taskId: task.id, blame: [] as string[], candidates: ranked.length, universe: universe.length,
    tests: 0, widenings, depth, ranking, goldRank: goldRank(ranked, goldSet), stateSha256,
    minimalUnique: null, alternatives: null, exactConfirmed: null, exactMinimal: null, exactRetrieval: null,
    exactConfig: reexecution.observed(),
  };

  if (passes(new Set())) return { ...shared, outcome: 'passing', reason: 'already-passing', elapsedMs: clock() - started };
  if (!passes(new Set(universe))) {
    // Either the gold is not retrievable at this cut point at all, or removing
    // every candidate above it still does not bring it inside the top-k.
    const reason = shared.goldRank === null ? 'gold-not-retrievable' : 'ablation-insufficient';
    return { ...shared, outcome: 'unfixable', reason, elapsedMs: clock() - started };
  }

  const search = options.exact
    ? (subset: readonly string[]) => { const result = run(new Set(subset), task.k); return result.goldRemoved ? false : satisfied(result.ids, task); }
    : (subset: readonly string[]) => passes(new Set(subset));
  const { minimal, tests } = ddmin(universe, search, maxTests);

  // Under `exact` the search predicate is a full re-index per test, so the swap
  // scan is not run at all rather than run against a cheaper oracle than the one
  // that produced the blame set.
  const alternatives = options.exact ? null : countAlternatives(universe, minimal, removed => passes(removed));

  let exactConfirmed: boolean | null = null;
  let exactMinimal: boolean | null = null;
  let exactRetrieval: string | null = null;
  let refused: BisectResult['reason'] | null = null;
  if (confirm !== 'off') {
    exactRetrieval = reexecution.plan().mode;
    const oracle = (removed: ReadonlySet<string>): boolean => {
      const result = run(removed, task.k);
      return result.goldRemoved ? false : satisfied(result.ids, task);
    };
    // The recorded failure really fails, and removing the blame set really fixes
    // it. Either half can fail: the cheap oracle is blind to the IDF and average
    // document length that ablation moves, so it can call a failure that a real
    // re-execution does not reproduce, and it can propose a set that does not
    // actually fix one.
    const reproduced = !oracle(new Set());
    const fixes = oracle(new Set(minimal));
    exactConfirmed = reproduced && fixes;
    if (!reproduced) refused = 'failure-not-reproduced';
    else if (!fixes) refused = 'blame-not-confirmed';
    if (confirm === 'minimal') exactMinimal = minimal.every(id => !oracle(new Set(minimal.filter(entry => entry !== id))));
  }

  return {
    ...shared,
    ...(refused === null ? { outcome: 'blamed' as const, reason: 'displaced' as const } : { outcome: 'unconfirmed' as const, reason: refused }),
    blame: minimal, tests,
    minimalUnique: alternatives === null ? null : alternatives === 0, alternatives,
    exactConfirmed, exactMinimal, exactRetrieval, exactConfig: reexecution.observed(),
    elapsedMs: clock() - started,
  };
}
