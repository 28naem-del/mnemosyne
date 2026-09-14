import type { DatabaseSync } from 'node:sqlite';
import { HnswIndex, hnswAvailable } from './hnsw.js';
import { SqliteVecIndex, loadSqliteVec } from './sqlite-vec.js';
import { DENSE_INDEX_MODES, type DenseIndex, type DenseIndexMode, type DenseIndexStatus } from './types.js';

export { DENSE_INDEX_MODES } from './types.js';
export type { DenseIndex, DenseIndexEntry, DenseIndexMode, DenseIndexStatus } from './types.js';
export { HnswIndex, hnswAvailable } from './hnsw.js';
export { SqliteVecIndex, loadSqliteVec, sqliteVecPath } from './sqlite-vec.js';

/**
 * Label allocation and index selection.
 *
 * Both indexes are keyed by the same integer label rather than by memory id, so
 * there is exactly one mapping from a record to its place in an index and exactly
 * one way for that mapping to end. `local_vec_labels.memory_id` cascades from
 * `memories`, so erasing a record removes its label; a trigger on that removal
 * clears the vec0 row in the same transaction. SQLite fires triggers on rows
 * removed by a foreign-key cascade, which is what makes `forget()` reach into the
 * index without `forget()` knowing an index exists.
 *
 * Labels come from AUTOINCREMENT, so a label is never reused after an erasure.
 * Reuse would let a new record inherit a forgotten record's position in a stale
 * index file — the one way a rebuilt-from-disk HNSW could resurrect something.
 */
export const VECTOR_SCHEMA = `
  CREATE TABLE IF NOT EXISTS local_vec_labels(
    label INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    UNIQUE(memory_id, model));
  CREATE INDEX IF NOT EXISTS local_vec_labels_model ON local_vec_labels(model,label);
`;

/**
 * Reconcile the erasure trigger with what this process can actually reach, at
 * OPEN time rather than at first recall.
 *
 * A trigger naming `local_vec_index` is only safe while that table is reachable.
 * Open the same database on a machine without the extension and the table is not
 * there — `forget()` would fire the trigger and throw, which would make the
 * presence of an optional binary decide whether erasure works. So: when the
 * extension is loaded and this database records a sqlite-vec index, the table is
 * recreated (its width is recorded, so no guessing) and the trigger is created
 * with it. Otherwise the trigger is dropped, and erasure falls back to the
 * post-filter, which withholds the record either way.
 */
export function prepareDenseIndexSchema(db: DatabaseSync, vecLoaded: boolean): void {
  const identity = readIdentity(db);
  const usable = vecLoaded && identity?.kind === 'sqlite-vec';
  if (usable) db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS local_vec_index USING vec0(embedding float[${identity.dimensions}] distance_metric=cosine)`);
  syncVecTrigger(db, usable);
}

/** Fires only while the vec0 table exists; see `syncVecTrigger`. */
const VEC_TRIGGER = `CREATE TRIGGER IF NOT EXISTS local_vec_labels_ad AFTER DELETE ON local_vec_labels
  BEGIN DELETE FROM local_vec_index WHERE rowid=OLD.label; END;`;

export interface DenseIndexIdentity { kind: 'sqlite-vec' | 'hnsw'; model: string; dimensions: number }

export function resolveDenseIndexMode(option: DenseIndexMode | undefined): DenseIndexMode {
  const requested = option ?? process.env.MNEMOSYNE_INDEX_MODE ?? 'auto';
  if (!DENSE_INDEX_MODES.includes(requested as DenseIndexMode)) throw new TypeError(`indexMode must be one of ${DENSE_INDEX_MODES.join(', ')}`);
  return requested as DenseIndexMode;
}

/** Sidecar path for a file-backed index. In-memory databases keep no sidecar. */
export function hnswPath(databasePath: string): string | null {
  return databasePath === ':memory:' ? null : `${databasePath}-hnsw`;
}

export interface DenseIndexSelection {
  index: DenseIndex | null;
  status: DenseIndexStatus;
  /** True when the caller must (re)populate the index from `local_embeddings`. */
  rebuild: boolean;
}

/**
 * Choose and open the dense index for this database and model.
 *
 * Returns `index: null` for the exact scan, which is always a correct answer —
 * every caller of this function must work when it gets one, because that is what
 * a machine without the optional binaries gets.
 */
export function createDenseIndex(db: DatabaseSync, options: {
  mode: DenseIndexMode; model: string; dimensions: number; databasePath: string; vecLoaded: boolean; vecError?: string;
}): DenseIndexSelection {
  const { mode, model, dimensions, databasePath, vecLoaded } = options;
  const requested = mode;
  const exact = (unavailable?: string): DenseIndexSelection => ({ index: null, status: { requested, mode: 'exact', ...(unavailable ? { unavailable } : {}) }, rebuild: false });
  if (mode === 'exact') return exact();

  const recorded = readIdentity(db);
  const wanted: DenseIndexIdentity = { kind: mode === 'hnsw' ? 'hnsw' : 'sqlite-vec', model, dimensions };

  if (wanted.kind === 'hnsw') {
    if (!hnswAvailable()) {
      // An explicit request for hnsw must not quietly become something else.
      return exact('hnswlib-node is not installed; install it to enable the hnsw index');
    }
  } else if (!vecLoaded) {
    const reason = options.vecError ?? 'sqlite-vec is not installed';
    // `auto` is allowed to degrade; naming sqlite-vec explicitly is not.
    return exact(mode === 'auto' ? `${reason}; using the exact scan` : reason);
  }

  const moved = !recorded || recorded.kind !== wanted.kind || recorded.model !== wanted.model || recorded.dimensions !== wanted.dimensions;
  const path = hnswPath(databasePath);
  if (moved) {
    // A different model or width is a different vector space. Rebuild rather
    // than mixing two spaces in one index, which would score nonsense.
    if (vecLoaded) db.exec('DROP TABLE IF EXISTS local_vec_index');
    HnswIndex.discard(path);
    db.exec('DELETE FROM local_vec_labels');
  }
  syncVecTrigger(db, wanted.kind === 'sqlite-vec' && vecLoaded);

  const index = wanted.kind === 'hnsw' ? new HnswIndex(dimensions, path) : new SqliteVecIndex(db, dimensions);
  writeIdentity(db, wanted);
  const indexed = index.size();
  const labels = Number((db.prepare('SELECT count(*) AS count FROM local_vec_labels WHERE model=?').get(model) as { count: number | bigint }).count);
  return { index, status: { requested, mode: index.kind, size: indexed }, rebuild: moved || indexed !== labels };
}

/**
 * The trigger is created only while the vec0 table it names exists. A database
 * opened on a machine without the extension must still be able to delete a
 * record, and a trigger referencing a missing table would make `forget()` throw.
 */
export function syncVecTrigger(db: DatabaseSync, enabled: boolean): void {
  if (enabled) db.exec(VEC_TRIGGER);
  else db.exec('DROP TRIGGER IF EXISTS local_vec_labels_ad');
}

export function readIdentity(db: DatabaseSync): DenseIndexIdentity | null {
  const row = db.prepare("SELECT value FROM local_settings WHERE key='vec-index'").get() as { value: string } | undefined;
  if (!row) return null;
  try { return JSON.parse(row.value) as DenseIndexIdentity; } catch { return null; }
}

export function writeIdentity(db: DatabaseSync, identity: DenseIndexIdentity): void {
  db.prepare("INSERT INTO local_settings(key,value) VALUES('vec-index',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(identity));
}

/** Attempt the extension load, reporting why rather than throwing. */
export function tryLoadSqliteVec(db: DatabaseSync): { loaded: boolean; version?: string; error?: string } {
  try { return { loaded: true, version: loadSqliteVec(db) }; }
  catch (error) { return { loaded: false, error: (error as Error).message }; }
}
