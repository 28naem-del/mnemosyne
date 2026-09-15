/**
 * Approximate-nearest-neighbour indexing for the dense retrieval channel.
 *
 * The contract every index in this directory obeys, and the reason the engine can
 * swap one in without changing what recall returns:
 *
 * **An index is a candidate *proposer*, never an authorizer.** It sees vectors and
 * labels and nothing else — no scope, no visibility, no validity window, no
 * erasure state. Every label it proposes is run back through the exact same SQL
 * predicate and the same bitemporal reconstruction the exact scan uses before it
 * can reach a caller. An index that is stale, corrupt or outright adversarial can
 * therefore cost recall, but it cannot leak a record the exact scan would have
 * withheld.
 */

/** Which dense index to use. `auto` prefers sqlite-vec and silently falls back to `exact`. */
export type DenseIndexMode = 'exact' | 'auto' | 'sqlite-vec' | 'hnsw';

export const DENSE_INDEX_MODES: readonly DenseIndexMode[] = ['exact', 'auto', 'sqlite-vec', 'hnsw'];

/** A vector under the integer label the engine assigned it in `local_vec_labels`. */
export interface DenseIndexEntry {
  label: number;
  vector: Float32Array;
}

export interface DenseIndex {
  readonly kind: 'sqlite-vec' | 'hnsw';
  readonly dimensions: number;
  /** Insert or replace by label. Called inside the engine's write transaction. */
  upsert(entries: readonly DenseIndexEntry[]): void;
  /** Drop labels. Never required for correctness — the post-filter already
   * withholds erased records — but it keeps the candidate budget useful. */
  remove(labels: readonly number[]): void;
  /** Labels of the nearest `k`, best first. Ordering only: the engine rescores
   * every survivor at full precision, so an index never decides a final score. */
  search(query: Float32Array, k: number): number[];
  /** Vectors currently indexed. Bounds the over-fetch loop. */
  size(): number;
  /** Persist anything that lives outside the SQLite file. */
  flush(): void;
  close(): void;
}

/** What the dense channel actually did, as opposed to what was configured. */
export interface DenseIndexStatus {
  requested: DenseIndexMode;
  /** The path that actually ran. `exact` is the O(n) scan. */
  mode: 'exact' | 'sqlite-vec' | 'hnsw';
  /** Why the requested index is not running. Never silent. */
  unavailable?: string;
  /** Vectors in the index. */
  size?: number;
}
