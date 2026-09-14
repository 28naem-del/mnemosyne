import type { DatabaseSync } from 'node:sqlite';

/**
 * `#bm25Recall`'s corpus-wide constants — `documents` (count) and `totalLength`
 * (for `averageLength`) over its scope predicate — cached out of the hot path.
 * Before this module existed, computing them cost a full scan of every scoped
 * document on every query: at 1M records that is the whole store, every time.
 * Per-term document frequency stays where it always cost the least: read off
 * the term-indexed candidates query in `#bm25Recall` itself, never cached here,
 * since it is query-term-dependent and already touches only matching postings.
 *
 * Invalidated the same way `LocalMemory`'s `#vectorsDrained` cache is:
 * `writeSeq` for this connection's own writes, `dataVersion`
 * (`PRAGMA data_version`) for another connection's — both passed in by the
 * caller, which owns that state.
 *
 * That invalidation is exactly correct for a *historical* view: an explicit
 * asOf/knownAt never drifts on its own, so nothing but a write can change
 * which documents it sees, and the caller's cache key includes the literal
 * timestamps (see {@link corpusStatsCacheKey}) so different historical
 * instants never collide.
 *
 * For a *live* view (asOf=knownAt=now, both advancing every call) it is
 * exactly correct UNLESS some record in the workspace has ever set
 * `validFrom` or `validUntil`. Every other predicate in `#bm25Recall`'s scope
 * — created_at, status, trust, advisory, kind — only changes value through a
 * write (store/correct/invalidate/supersede), already covered by
 * `writeSeq`/`dataVersion`. `validFrom`/`validUntil` are the one pair that can
 * flip a document in or out of scope by clock advance alone, with no
 * intervening write to invalidate against. {@link hasTemporalBounds} answers
 * whether that is even possible for a workspace; until the first record sets
 * either field, live-view stats are cached exactly like a historical one.
 */
export type CorpusStatsEntry = { documents: number; totalLength: number; writeSeq: number; dataVersion: number };
export type CorpusStatsCache = Map<string, CorpusStatsEntry>;

/** Bounded so a caller sweeping many distinct historical instants (a
 * point-in-time replay, say) cannot grow this without limit; the key space
 * for a live view is tiny (includeUntrusted x kind subsets) and never
 * approaches this. */
const MAX_CACHE_ENTRIES = 256;

/** The cache key for a scope signature: distinct per `includeUntrusted` /
 * `kinds` combination, and — for a historical view — per literal instant, so
 * two different `asOf`/`knownAt` values never collide. */
export function corpusStatsCacheKey(includeUntrusted: boolean, kinds: readonly string[], time: { historical: boolean; knownAt: string; asOf: string }): string {
  const scope = `${includeUntrusted} ${[...kinds].sort().join(',')}`;
  return time.historical ? `h:${scope} ${time.knownAt} ${time.asOf}` : `l:${scope}`;
}

export function corpusStats(args: {
  db: DatabaseSync;
  cache: CorpusStatsCache;
  scope: string;
  parameters: readonly string[];
  key: string;
  cacheable: boolean;
  writeSeq: number;
  dataVersion: number;
  /** True if a row whose `data` (as stored, not yet decoded to the live
   * record) reads back as temporally visible under the caller's current
   * view. Only called for rows the query already flags as non-`active`
   * (temporally interesting); an `active` row is unconditionally visible. */
  isVisible: (temporalData: string) => boolean;
}): { documents: number; totalLength: number } {
  const cached = args.cache.get(args.key);
  if (cached && cached.writeSeq === args.writeSeq && cached.dataVersion === args.dataVersion) return cached;
  const statement = args.db.prepare(`SELECT CASE WHEN m.status='active' THEN NULL ELSE m.data END AS temporal_data,s.token_count
    FROM memories m JOIN local_search s ON s.memory_id=m.id WHERE ${args.scope}`);
  let documents = 0, totalLength = 0;
  for (const value of statement.iterate(...args.parameters)) {
    const row = value as { temporal_data: string | null; token_count: number };
    if (row.temporal_data !== null && !args.isVisible(row.temporal_data)) continue;
    documents++; totalLength += row.token_count;
  }
  const result = { documents, totalLength, writeSeq: args.writeSeq, dataVersion: args.dataVersion };
  if (args.cacheable) {
    if (args.cache.size >= MAX_CACHE_ENTRIES) args.cache.clear();
    args.cache.set(args.key, result);
  }
  return result;
}

/** Sticky once true: sees a fresh read from `local_settings` (not merely this
 * connection's own writes) every time `state.present` is still false, so a
 * different process setting the flag is picked up the moment this one next
 * needs to know — never stale in the direction that would let a live-view
 * cache entry survive that it should not. `state` is caller-owned (a plain
 * mutable holder, e.g. a `LocalMemory` instance field) so the sticky bit
 * survives across calls without this module holding any per-workspace state
 * of its own. */
export function hasTemporalBounds(db: DatabaseSync, workspaceId: string, state: { present: boolean }): boolean {
  if (state.present) return true;
  const row = db.prepare('SELECT 1 FROM local_settings WHERE key=?').get(`bm25-temporal-bounds:${workspaceId}`);
  if (row) state.present = true;
  return state.present;
}

/** Marks a workspace as carrying a `validFrom`/`validUntil` record, ever —
 * see {@link hasTemporalBounds}. Sticky (`INSERT OR IGNORE`, never cleared):
 * it only needs to answer "could a live BM25 stats cache go stale from clock
 * advance alone", and a record that once existed with a bound still could
 * have, even if since erased. Call on every insert; a no-op when
 * `hasBound` is false. */
export function markTemporalBoundsIfNeeded(db: DatabaseSync, workspaceId: string, hasBound: boolean): void {
  if (!hasBound) return;
  db.prepare('INSERT OR IGNORE INTO local_settings(key,value) VALUES(?,?)').run(`bm25-temporal-bounds:${workspaceId}`, '1');
}
