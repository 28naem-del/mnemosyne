import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { DenseIndex, DenseIndexEntry } from './types.js';

/**
 * The dense index as a `vec0` virtual table inside the same SQLite file.
 *
 * This keeps the one-file promise exactly as it was: no service, no sidecar, no
 * second database. `vec0` scores in C over packed float32 rather than in JS over
 * `JSON.parse`d arrays, which is where the win comes from — the search itself is
 * still exact brute force, so the ordering it returns is the ordering the exact
 * scan would have produced, and the engine can trust set equality rather than
 * merely hoping for it. Past a few hundred thousand vectors that exactness stops
 * being affordable and the HNSW path takes over.
 */

const require = createRequire(import.meta.url);

/**
 * Resolve the extension file via the optional `sqlite-vec` package.
 *
 * Deliberately reads no environment variable: `auto` (the default `indexMode`)
 * runs this on every open, and an env-controlled path would make every
 * `LocalMemory` on a machine `dlopen` whatever that variable points at,
 * undetectably and by default. The only supported override is the explicit
 * `sqliteVecPath` constructor option (`LocalMemory`'s caller must ask for it
 * by name), which bypasses this resolver entirely by passing a path straight
 * to `loadSqliteVec`.
 */
export function sqliteVecPath(): string {
  return (require('sqlite-vec') as { getLoadablePath(): string }).getLoadablePath();
}

/**
 * Load the extension into an open database.
 *
 * `enableLoadExtension` is switched back off immediately afterwards, so SQL
 * reaching this database can never call `load_extension()` itself. The C-level
 * capability is opened for exactly the span of this call.
 */
export function loadSqliteVec(db: DatabaseSync, path = sqliteVecPath()): string {
  db.enableLoadExtension(true);
  try { db.loadExtension(path); } finally { db.enableLoadExtension(false); }
  return (db.prepare('SELECT vec_version() AS version').get() as { version: string }).version;
}

export class SqliteVecIndex implements DenseIndex {
  readonly kind = 'sqlite-vec' as const;
  readonly #db: DatabaseSync;
  readonly #dimensions: number;

  constructor(db: DatabaseSync, dimensions: number) {
    this.#db = db;
    this.#dimensions = dimensions;
    // The dimension is baked into the table definition, so a model change is a
    // rebuild rather than a silently mismatched index. createDenseIndex() drops
    // the table when the recorded identity moves.
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS local_vec_index USING vec0(embedding float[${dimensions}] distance_metric=cosine)`);
  }

  get dimensions(): number { return this.#dimensions; }

  upsert(entries: readonly DenseIndexEntry[]): void {
    if (!entries.length) return;
    // vec0 has no upsert, and a rewritten record keeps its label, so clear first.
    const drop = this.#db.prepare('DELETE FROM local_vec_index WHERE rowid=?');
    const write = this.#db.prepare('INSERT INTO local_vec_index(rowid,embedding) VALUES(?,?)');
    for (const entry of entries) {
      drop.run(BigInt(entry.label));
      write.run(BigInt(entry.label), new Uint8Array(entry.vector.buffer, entry.vector.byteOffset, entry.vector.byteLength));
    }
  }

  remove(labels: readonly number[]): void {
    const drop = this.#db.prepare('DELETE FROM local_vec_index WHERE rowid=?');
    for (const label of labels) drop.run(BigInt(label));
  }

  search(query: Float32Array, k: number): number[] {
    if (k <= 0) return [];
    const rows = this.#db.prepare('SELECT rowid AS label FROM local_vec_index WHERE embedding MATCH ? AND k=?')
      .all(new Uint8Array(query.buffer, query.byteOffset, query.byteLength), BigInt(k)) as { label: number | bigint }[];
    return rows.map((row) => Number(row.label));
  }

  size(): number {
    return Number((this.#db.prepare('SELECT count(*) AS count FROM local_vec_index').get() as { count: number | bigint }).count);
  }

  /** Nothing lives outside the database file, so a commit is the flush. */
  flush(): void {}
  close(): void {}
}
