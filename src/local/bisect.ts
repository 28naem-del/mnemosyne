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
 *    will not confirm is reported as `exactConfirmed: false` — never quietly
 *    kept.
 *
 * Nothing here knows which records were injected. A caller that seeds faults
 * keeps that knowledge to itself and scores the answer afterwards.
 */
import { createLocalMemory, type LocalMemory } from './index.js';
import { replayState, type ReplaySource } from './replay.js';
import type { LocalMemoryOptions, MemoryRecord, MemorySnapshot, RecallInput, RecallResult } from './types.js';

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

/** The subset of `LocalMemory` bisect reads. Structural, so a test can hand in a fake. */
export interface BisectSource extends ReplaySource {
  recall(input: RecallInput): RecallResult[];
  export(): MemorySnapshot;
  /** Read to refuse a source whose retrieval path bisect cannot reproduce exactly. */
  retrieval?: { requested: string; mode: string };
}

export interface BisectStore {
  recall(input: RecallInput): RecallResult[];
  close(): void;
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
  /** Options for the store Oracle B rebuilds. Defaults to the zero-model lexical path. */
  storeOptions?: Partial<LocalMemoryOptions>;
  /** Replaces the default in-memory store Oracle B builds. */
  createStore?: (snapshot: MemorySnapshot, options: Partial<LocalMemoryOptions>) => BisectStore;
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
   * - `unfixable` — removing every non-gold candidate still does not surface the
   *   gold, so the failure is not a displacement failure at this depth.
   */
  outcome: 'blamed' | 'passing' | 'unfixable';
  /** Why the search ended where it did. Present on every outcome, so `unfixable` is never a shrug. */
  reason: 'displaced' | 'already-passing' | 'gold-not-retrievable' | 'ablation-insufficient';
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
   */
  minimalUnique: boolean | null;
  /** Same-size alternatives found by the swap search, capped at 64; null under `exact`. */
  alternatives: number | null;
  /** Oracle B agreed: the recorded failure fails and removing the blame set passes. */
  exactConfirmed: boolean | null;
  /** Oracle B agreed that no single record can be dropped from the blame set. Only under `confirm: 'minimal'`. */
  exactMinimal: boolean | null;
  /** Retrieval mode Oracle B re-executed under; `null` when it did not run. */
  exactRetrieval: string | null;
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

function defaultStore(snapshot: MemorySnapshot, options: Partial<LocalMemoryOptions>): BisectStore {
  const memory: LocalMemory = createLocalMemory({
    retrieval: 'lexical', rerank: false, ledger: false,
    ...options,
    path: ':memory:', workspaceId: snapshot.workspaceId, agentId: snapshot.agentId,
  });
  memory.import(snapshot);
  return { recall: (input) => memory.recall(input), close: () => memory.close() };
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
 * index build, which is why this confirms rather than searches.
 */
export function exactRunner(source: BisectSource, task: BisectTask, options: BisectOptions = {}): (removed: ReadonlySet<string>, limit: number) => { ids: string[]; goldRemoved: boolean } {
  let snapshot: MemorySnapshot | undefined;
  const create = options.createStore ?? defaultStore;
  const storeOptions = options.storeOptions ?? {};
  return (removed, limit) => {
    snapshot ??= source.export();
    const ablated = ablateSnapshot(snapshot, removed);
    // Ablating the gold itself, or a record the gold depends on, answers a different question.
    if (task.gold.some(id => ablated.removed.has(id))) return { ids: [], goldRemoved: true };
    const store = create(ablated.snapshot, storeOptions);
    try { return { ids: store.recall(recallInput(task, limit)).map(hit => hit.memory.id), goldRemoved: false }; }
    finally { store.close(); }
  };
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
  // question when the rebuilt store retrieves the same way, and the dense path
  // cannot be reproduced from a snapshot without re-embedding every record — so
  // bisect runs on the deterministic lexical path and refuses rather than
  // quietly comparing two different retrievers.
  const mode = source.retrieval?.mode;
  const wanted = String(options.storeOptions?.retrieval ?? 'lexical');
  if (mode !== undefined && mode !== wanted) {
    throw new Error(`bisect re-executes on the ${wanted} path but the store retrieves with ${mode}: open it with retrieval: '${wanted}'`);
  }
  const run = exactRunner(source, task, options);

  const stateSha256 = options.stateHash === false || (task.asOf === undefined && task.knownAt === undefined)
    ? null
    : replayState(source, { knownAt: task.knownAt ?? task.asOf!, ...(task.asOf === undefined ? {} : { asOf: task.asOf }) }).stateSha256;

  // The ranking the search runs over. One real recall, extended by widening only
  // if the gold is not in it — each widening is a real re-execution, so it is
  // paid for and counted, never assumed.
  const ranked: string[] = source.recall(recallInput(task, depth)).map(hit => hit.memory.id);
  let widenings = 0;
  while (!ranked.some(id => goldSet.has(id)) && widenings < maxWidenings && ranked.length >= depth) {
    const next = run(new Set(ranked.filter(id => !goldSet.has(id))), depth);
    widenings++;
    const fresh = next.ids.filter(id => !ranked.includes(id));
    if (!fresh.length) break;
    ranked.push(...fresh);
  }

  const passes = rankOracle(ranked, task.gold, task.k, require);
  const universe = ranked.filter(id => !goldSet.has(id));
  const ranking: BisectResult['ranking'] = widenings === 0 ? 'single-recall' : 'stacked';
  const shared = {
    taskId: task.id, blame: [] as string[], candidates: ranked.length, universe: universe.length,
    tests: 0, widenings, depth, ranking, goldRank: goldRank(ranked, goldSet), stateSha256,
    minimalUnique: null, alternatives: null, exactConfirmed: null, exactMinimal: null, exactRetrieval: null,
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
  if (confirm !== 'off') {
    exactRetrieval = String(options.storeOptions?.retrieval ?? 'lexical');
    const oracle = (removed: ReadonlySet<string>): boolean => {
      const result = run(removed, task.k);
      return result.goldRemoved ? false : satisfied(result.ids, task);
    };
    // The recorded failure really fails, and removing the blame set really fixes it.
    exactConfirmed = !oracle(new Set()) && oracle(new Set(minimal));
    if (confirm === 'minimal') exactMinimal = minimal.every(id => !oracle(new Set(minimal.filter(entry => entry !== id))));
  }

  return {
    ...shared, outcome: 'blamed', reason: 'displaced', blame: minimal, tests,
    minimalUnique: alternatives === null ? null : alternatives === 0, alternatives,
    exactConfirmed, exactMinimal, exactRetrieval,
    elapsedMs: clock() - started,
  };
}
