import { createRequire } from 'node:module';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { DenseIndex, DenseIndexEntry } from './types.js';

/**
 * HNSW, for stores past the point where scoring every vector is affordable.
 *
 * Off unless asked for. It is the one retrieval component in this engine that is
 * *approximate*: a graph walk can miss a true neighbour, so turning it on trades
 * a measurable slice of recall for sublinear latency. That trade is the caller's
 * to make, which is why it is a flag and not a threshold the engine crosses on
 * its own.
 *
 * What it does NOT trade is safety. Like every index here it proposes labels and
 * authorizes nothing; the engine re-derives scope, validity and erasure for each
 * label before anything reaches a caller. A missing neighbour costs recall. It
 * cannot surface a record the exact scan would have withheld.
 *
 * Rebuilds are deterministic: fixed seed, fixed construction parameters, and
 * insertion in label order, which is the order `local_vec_labels` assigns and so
 * is stable across rebuilds of the same database.
 */

const require = createRequire(import.meta.url);

/** Graph parameters. Pinned, because changing them changes the graph a rebuild produces. */
export const HNSW_M = 16;
export const HNSW_EF_CONSTRUCTION = 200;
export const HNSW_SEED = 100;
/** Search breadth. Raised to at least the requested `k`, since ef < k cannot return k. */
export const HNSW_EF_SEARCH = 200;

interface HnswNative {
  initIndex(maxElements: number, m?: number, efConstruction?: number, randomSeed?: number, allowReplaceDeleted?: boolean): void;
  readIndexSync(filename: string, allowReplaceDeleted?: boolean): void;
  writeIndexSync(filename: string): void;
  resizeIndex(maxElements: number): void;
  addPoint(point: number[], label: number, replaceDeleted?: boolean): void;
  markDelete(label: number): void;
  searchKnn(query: number[], k: number, filter?: (label: number) => boolean): { distances: number[]; neighbors: number[] };
  getIdsList(): number[];
  getCurrentCount(): number;
  getMaxElements(): number;
  setEf(ef: number): void;
}

/**
 * Whether the native addon actually loads, not merely whether the package
 * resolves: `npm ci --ignore-scripts` installs `hnswlib-node` without building
 * it, and that host must report unavailable rather than crash on first use.
 */
export function hnswAvailable(): boolean {
  try { require('hnswlib-node'); return true; } catch { return false; }
}

/**
 * `labels` is only present in sidecars written by this build or later. A
 * sidecar from before label tracking existed has exactly `{dimensions, count,
 * maxLabel}` — still trustworthy for `dimensions` and `maxLabel`, just missing
 * the array. See the constructor for how that legacy shape is handled: NOT a
 * lost sidecar, because the graph file it describes is still intact.
 */
interface Sidecar { dimensions: number; count: number; maxLabel: number; labels?: number[] }

export class HnswIndex implements DenseIndex {
  readonly kind = 'hnsw' as const;
  readonly #dimensions: number;
  readonly #path: string | null;
  readonly #index: HnswNative;
  /**
   * The labels this index actually holds — the one source of truth `size()`,
   * `upsert()` and `remove()` all read and write. Not `hnswlib`'s own
   * `getCurrentCount()`: that counts physical graph slots, which does not fall
   * when `markDelete()` runs (a deleted slot is reused by a *future* label, not
   * reclaimed immediately) and does not distinguish "new label" from
   * "label already present" on `addPoint()` — either would silently overcount
   * on a re-upsert or undercount after an erasure. Persisted (sorted) in the
   * sidecar so a reopen knows exactly what was here, not merely how many.
   */
  #labels = new Set<number>();
  #maxLabel = 0;
  #dirty = false;

  constructor(dimensions: number, path: string | null) {
    this.#dimensions = dimensions;
    this.#path = path;
    const { HierarchicalNSW } = require('hnswlib-node') as { HierarchicalNSW: new (space: string, dim: number) => HnswNative };
    this.#index = new HierarchicalNSW('cosine', dimensions);
    const sidecar = this.#readSidecar();
    if (sidecar && path && existsSync(path)) {
      // A sidecar that disagrees about width describes a different model; the
      // engine drops the files and rebuilds rather than reading them as ours.
      this.#index.readIndexSync(path, true);
      if (sidecar.labels) {
        this.#labels = new Set(sidecar.labels);
        this.#maxLabel = sidecar.maxLabel;
      } else {
        // Legacy sidecar: no `labels` array, but the graph readIndexSync just
        // loaded is not lost — it is intact and readable — so reconstruct
        // labels from it instead of discarding it for a fresh, empty index.
        // getIdsList() returns every physical slot in the graph, including
        // ones a prior session already markDelete()'d (hnswlib excludes a
        // deleted id from search results, it does not forget the id itself),
        // so this can over-count relative to what local_vec_labels currently
        // authorizes. That is safe, not merely tolerated: the very next thing
        // the caller does with a freshly opened index is compare size() against
        // local_vec_labels and, on any mismatch, call reconcile(live) — which
        // prunes exactly what the database no longer authorizes and is the
        // authority either way. maxLabel is trusted from the sidecar itself
        // (it already survived a prior flush); the max over the reconstructed
        // ids is only a defensive floor in case that field is ever missing —
        // computed by loop, not `Math.max(...ids)`, since ids can run into the
        // millions and spreading that many arguments overflows the call stack.
        const ids = this.#index.getIdsList();
        this.#labels = new Set(ids);
        let maxSeen = sidecar.maxLabel ?? 0;
        for (const id of ids) if (id > maxSeen) maxSeen = id;
        this.#maxLabel = maxSeen;
      }
    } else {
      this.#index.initIndex(1024, HNSW_M, HNSW_EF_CONSTRUCTION, HNSW_SEED, true);
    }
  }

  get dimensions(): number { return this.#dimensions; }

  /** The highest label this index has seen, so the engine can feed it only what is new. */
  get watermark(): number { return this.#maxLabel; }

  #sidecarPath(): string | null { return this.#path ? `${this.#path}.meta.json` : null; }

  #readSidecar(): Sidecar | null {
    const path = this.#sidecarPath();
    if (!path || !existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Sidecar;
      // Width is the one field that must agree for the graph to mean what this
      // sidecar says it means; a legacy sidecar missing `labels` still agrees
      // on `dimensions` and is handled in the constructor, not rejected here.
      if (parsed.dimensions !== this.#dimensions) return null;
      return 'labels' in parsed && !Array.isArray(parsed.labels) ? null : parsed;
    } catch { return null; }
  }

  upsert(entries: readonly DenseIndexEntry[]): void {
    if (!entries.length) return;
    const needed = this.#labels.size + entries.length;
    if (needed > this.#index.getMaxElements()) this.#index.resizeIndex(Math.max(needed * 2, 1024));
    const point = new Array<number>(this.#dimensions);
    for (const entry of entries) {
      for (let index = 0; index < this.#dimensions; index++) point[index] = entry.vector[index];
      this.#index.addPoint(point, entry.label, true);
      // A Set: re-upserting a label already present (a correction, replayed
      // batch, or retried write) grows nothing. That is what makes size() an
      // element count instead of an add-call count.
      this.#labels.add(entry.label);
      if (entry.label > this.#maxLabel) this.#maxLabel = entry.label;
    }
    this.#dirty = true;
  }

  remove(labels: readonly number[]): void {
    let removed = false;
    for (const label of labels) {
      // Already-absent labels are not an error: the engine reconciles against a
      // database that may have moved on without this file. Gate the native
      // call on our own bookkeeping so remove() is idempotent either way.
      if (!this.#labels.delete(label)) continue;
      try { this.#index.markDelete(label); } catch { /* not indexed in the graph itself */ }
      removed = true;
    }
    if (removed) this.#dirty = true;
  }

  /**
   * Drop whatever this index believes it holds that `live` does not.
   *
   * `remove()` runs at erasure time, but only reaches an index this process
   * already opened. A `forget()` (or `rollbackUnchangedRecords()`) issued while
   * the dense index was never resolved — or issued by an entirely different
   * process — leaves the label gone from `local_vec_labels` (the cascade
   * already took it) with no in-memory index around to tell. That erasure still
   * holds: the label is unreachable, because authorization is re-derived from
   * `local_vec_labels` on every proposal regardless of what the graph itself
   * still contains. What is missing without this is the accounting — `size()`
   * staying honest, and the eventual compaction that markDelete() performs on
   * a label at all. So this runs whenever the index is (re)opened and its
   * label count disagrees with the database's, which a stale entry always
   * causes (see `createDenseIndex`'s `rebuild` check).
   */
  reconcile(live: ReadonlySet<number>): void {
    const stale = [...this.#labels].filter((label) => !live.has(label));
    if (stale.length) this.remove(stale);
  }

  search(query: Float32Array, k: number): number[] {
    if (k <= 0 || this.#labels.size === 0) return [];
    this.#index.setEf(Math.max(HNSW_EF_SEARCH, k));
    const point = new Array<number>(this.#dimensions);
    for (let index = 0; index < this.#dimensions; index++) point[index] = query[index];
    return this.#index.searchKnn(point, Math.min(k, this.#labels.size)).neighbors;
  }

  size(): number { return this.#labels.size; }

  flush(): void {
    const path = this.#sidecarPath();
    if (!this.#path || !path || !this.#dirty) return;
    // Written through a temporary name so an interrupted flush leaves the
    // previous index readable instead of a truncated one.
    const staged = `${this.#path}.tmp`;
    this.#index.writeIndexSync(staged);
    renameSync(staged, this.#path);
    const labels = [...this.#labels].sort((a, b) => a - b);
    writeFileSync(path, JSON.stringify({ dimensions: this.#dimensions, count: labels.length, maxLabel: this.#maxLabel, labels } satisfies Sidecar), { mode: 0o600 });
    this.#dirty = false;
  }

  close(): void { this.flush(); }

  /** Remove a persisted index whose identity no longer matches the database. */
  static discard(path: string | null): void {
    if (!path) return;
    for (const file of [path, `${path}.meta.json`, `${path}.tmp`]) { try { rmSync(file); } catch { /* absent */ } }
  }
}
