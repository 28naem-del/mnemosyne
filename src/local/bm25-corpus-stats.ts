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
 * exactly correct UNLESS some record in the workspace has ever been stored
 * with a `validFrom` or `validUntil` that was still in the future at the time
 * it was stored. Every other predicate in `#bm25Recall`'s scope — created_at,
 * status, trust, advisory, kind — only changes value through a write
 * (store/correct/invalidate/supersede), already covered by
 * `writeSeq`/`dataVersion`. `validFrom`/`validUntil` are the one pair that can
 * flip a document in or out of scope by clock advance alone, with no
 * intervening write to invalidate against — and only while the boundary is
 * still ahead of the clock. {@link hasTemporalBounds} answers whether that is
 * even possible for a workspace and {@link markTemporalBoundsIfNeeded} states
 * the exact predicate; until some record schedules a crossing, live-view stats
 * are cached exactly like a historical one.
 *
 * All of that reasoning — and {@link markTemporalBoundsIfNeeded}'s "already
 * `<= now` at insert, so no later `asOf` can push it out" argument in
 * particular — holds only while the reader's clock runs *forwards*. Nothing
 * guarantees that: `LocalMemoryOptions.now` is a public constructor option
 * with no monotonicity contract, so an NTP step, a sleep/resume, a VM snapshot
 * restore or simply a caller's own clock can move `now` backwards across a
 * warm entry. A backward step re-opens
 * every boundary the flag declined to record precisely *because* it was
 * already crossed, and no write happens, so neither `writeSeq` nor
 * `dataVersion` moves and no sticky flag can fire. Hence {@link
 * CorpusStatsEntry.computedAt}: an entry is only reusable at an instant at or
 * after the one it was computed for. On a monotone clock that test never
 * fires and nothing about the caching changes.
 */
export type CorpusStatsEntry = {
  documents: number; totalLength: number; writeSeq: number; dataVersion: number;
  /** The instant this entry's scope was evaluated at, so a *backward* move of
   * the clock invalidates it. For a live view this is the reader's own clock
   * (`#temporal()` sets `asOf === knownAt === #time()`); for a historical one
   * it is the pinned `asOf`, which {@link corpusStatsCacheKey} already puts in
   * the key, so it never varies within a key and historical caching is
   * untouched. */
  computedAt: string;
};
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
  /** The instant to evaluate this scope at — for a live view the reader's
   * current clock. Stored on the entry so a clock that moves *backwards*
   * (NTP step, sleep/resume, snapshot restore, an injected `now`) misses
   * instead of serving counts computed for a later instant; see
   * {@link CorpusStatsEntry.computedAt}. */
  computedAt: string;
  /** True if a row whose `data` (as stored, not yet decoded to the live
   * record) reads back as temporally visible under the caller's current
   * view. Only called for rows the query already flags as non-`active`
   * (temporally interesting); an `active` row is unconditionally visible. */
  isVisible: (temporalData: string) => boolean;
}): { documents: number; totalLength: number } {
  const cached = args.cache.get(args.key);
  // `computedAt` guards the one direction the write counters cannot: a clock
  // that moves backwards re-opens boundaries that were already crossed when
  // the entry was built, with no write to bump `writeSeq`/`dataVersion`.
  // Forward moves stay hits, so a monotone clock is unaffected.
  if (cached && cached.writeSeq === args.writeSeq && cached.dataVersion === args.dataVersion && args.computedAt >= cached.computedAt) return cached;
  const statement = args.db.prepare(`SELECT CASE WHEN m.status='active' THEN NULL ELSE m.data END AS temporal_data,s.token_count
    FROM memories m JOIN local_search s ON s.memory_id=m.id WHERE ${args.scope}`);
  let documents = 0, totalLength = 0;
  for (const value of statement.iterate(...args.parameters)) {
    const row = value as { temporal_data: string | null; token_count: number };
    if (row.temporal_data !== null && !args.isVisible(row.temporal_data)) continue;
    documents++; totalLength += row.token_count;
  }
  const result = { documents, totalLength, writeSeq: args.writeSeq, dataVersion: args.dataVersion, computedAt: args.computedAt };
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

/**
 * Raises this connection's high-water clock mark to `now`, unless `now` is
 * already below it.
 *
 * **Every** reading of the engine's clock must come through here, which is why
 * `LocalMemory` calls it from `#time()` itself rather than from any one
 * consumer. The mark's job is to remember the highest instant this connection
 * has ever *observed*, and a write observes the clock exactly as a read does:
 * `#insert` stamps `createdAt`, `#updateStatus` stamps `updatedAt`, `#audit`
 * stamps its row. Feeding the mark only from the recall path — as the first
 * version of this guard did — leaves every one of those readings invisible, so
 * a write at a high instant followed by a backward step is not seen as a step
 * back at all, and the stats computed at the low instant are cached and then
 * served on the way back up. That is a silent, total loss of recall for the
 * query: `documents` runs stale-low, `log1p((documents - df + 0.5) / (df + 0.5))`
 * goes negative, and `#bm25Recall`'s `score > 0` gate drops every row.
 *
 * Raising only on `>=` is what keeps {@link liveClockSteppedBack} a pure
 * comparison at the call site: the mark never records a reading that was itself
 * below the mark, so testing the reading against the mark it just fed still
 * answers "was this below some earlier reading?".
 */
export function noteLiveClock(now: string, state: { highWater: string }): void {
  if (now > state.highWater) state.highWater = now;
}

/**
 * Answers whether `now` is *below* this connection's high-water clock mark —
 * i.e. whether the reader's clock has moved backwards at some point in this
 * connection's life. Pure: {@link noteLiveClock} owns the mark.
 *
 * {@link CorpusStatsEntry.computedAt} keeps a single entry from being served
 * at an instant before the one it was computed for. That is necessary but not
 * sufficient, because a backward step also invalidates the guarantee that
 * {@link markTemporalBoundsIfNeeded} rests on. The flag deliberately records
 * nothing for a record whose instants were all `<= now` at insert; that is
 * sound only while the clock never goes below the insert clock again. Once it
 * does, those instants are in the reader's future once more and will be
 * re-crossed by ordinary forward advance, with no write and nothing flagged.
 * So an entry computed *below* the high-water mark must not be cached at all:
 * it would be served later, at a higher instant, having gone stale in exactly
 * the way nothing can detect. Entries computed at or above the mark stay
 * cacheable, so a clock that steps back and then catches up returns to normal
 * caching rather than giving it up for good.
 *
 * The caller owns the holder (a `LocalMemory` instance field, same shape as
 * {@link hasTemporalBounds}'s) so the mark survives across calls without this
 * module holding per-connection state. Test for **live views only** — a
 * historical `asOf` is a caller-chosen literal, not a clock reading, and it is
 * routinely far below the mark on purpose. Historical entries do not need the
 * mark anyway, since {@link corpusStatsCacheKey} already puts their instants in
 * the key.
 *
 * On a monotone clock this returns false every time and nothing changes.
 */
export function liveClockSteppedBack(now: string, state: { highWater: string }): boolean {
  return now < state.highWater;
}

/**
 * Seeds this connection's high-water mark, once, from the highest `created_at`
 * the store itself carries for this workspace.
 *
 * {@link noteLiveClock} can only remember clocks *this* connection has read,
 * which leaves the cross-connection carrier open: a writer at a high clock
 * commits and closes, a reader then opens with its clock behind (NTP step,
 * snapshot restore, a second machine), and the reader's first live recall is
 * its own first clock reading — so nothing looks like a step back. The write
 * landed before the reader existed, so `PRAGMA data_version` is already at its
 * final value and `writeSeq` is 0: neither counter moves, the count computed
 * at the low instant is cached, and forward advance serves it. Same silent
 * total loss as the same-connection carrier, just across a process boundary.
 *
 * The store's own `created_at` column is the evidence that some engine's clock
 * once read that high, so it is the right seed, and `memories_page`
 * (`workspace_id, created_at, id`) makes it a covering-index MAX — measured at
 * ~1.4us, paid once per connection on the first live corpus-stats computation
 * rather than at open, so a connection that never runs a live BM25 recall
 * never pays it at all.
 *
 * This cannot cost a workspace its live caching in the case the flag was
 * carefully written to avoid. A record whose `createdAt` is above the *writer's*
 * own clock is a future-dated import, and {@link markTemporalBoundsIfNeeded}
 * already flags exactly that, so {@link hasTemporalBounds} has already turned
 * live caching off for the workspace before this is ever consulted. What is
 * left is honest clock skew between engines, and declining to cache while this
 * reader is behind another writer's clock is the conservative answer for
 * precisely as long as the skew lasts.
 *
 * **Re-seeds, rather than seeding once** (d2 fix): a one-time boolean latch
 * only covers the ordering "the foreign writer commits and closes *before*
 * the reader exists". A foreign commit that lands *after* the reader's first
 * live recall bumps `PRAGMA data_version` (correctly invalidating the cache
 * entry) but, with a once-only latch, never raises `highWater` — so the
 * recompute triggered by that invalidation is wrongly judged cacheable at the
 * reader's own, still-low clock, and ordinary forward clock advance then
 * serves that stale-low `documents` count forever: silent, total recall loss.
 * Keying the reseed on `dataVersion` instead closes that gap at the same O(1)
 * cost — this connection's own writes never change `data_version` (see
 * {@link LocalMemory.#dataVersion}), so on a single connection the seed still
 * runs exactly once, same as before; it only re-runs when some *other*
 * connection has actually committed since the last time this ran.
 */
export function seedLiveClockFromStore(db: DatabaseSync, workspaceId: string, state: { highWater: string; seededAt: number | undefined }, dataVersion: number): void {
  if (state.seededAt === dataVersion) return;
  state.seededAt = dataVersion;
  const row = db.prepare('SELECT MAX(created_at) AS high FROM memories WHERE workspace_id=?').get(workspaceId) as { high: string | null } | undefined;
  if (typeof row?.high === 'string' && row.high > state.highWater) state.highWater = row.high;
}

/**
 * Marks a workspace as carrying a record whose scope membership can still
 * change from clock advance alone — see {@link hasTemporalBounds}.
 *
 * The predicate is deliberately narrower than "the record has a `validFrom`
 * or a `validUntil`". What matters is not that a boundary exists but that one
 * is still *ahead of this engine's clock* at insert time, because only an
 * uncrossed boundary can be crossed later with no write to invalidate
 * against. `#bm25Recall`'s scope test is `(validFrom ?? createdAt) <= asOf
 * AND (validUntil IS NULL OR validUntil > asOf)`, which for a live view is
 * monotone in the clock:
 *
 *  - `validFrom <= now`, no `validUntil` — in scope now, and no later `asOf`
 *    can push it out. **Safe to cache.**
 *  - `validUntil <= now` — already expired, and a larger `asOf` keeps it
 *    expired. **Safe to cache.**
 *  - `validFrom > now` — future-dated: it *enters* scope at that instant.
 *    **Unsafe.**
 *  - `validUntil > now` — it *leaves* scope at that instant. **Unsafe.**
 *
 * The past-`validFrom` case is not an edge case: `correct()` always writes a
 * `validFrom` (`previous.validFrom ?? previous.createdAt`, never `undefined`)
 * and it is always already in the past, so flagging on presence alone made a
 * single correction permanently disable live-view caching for that whole
 * workspace and put its live queries back on the O(corpus) scan.
 *
 * `now` must be **the reading engine's** current time, and the caller passes
 * it in rather than this reading a clock of its own (a clock read per insert
 * would break the engine's determinism under an injected clock and tick a
 * monotonic one an extra time). It is emphatically *not* `record.createdAt`:
 * on the `import()` path `createdAt` came from the producing machine's clock,
 * which `#snapshotRecord` deliberately does not bound to the importer's
 * present. A producer whose clock is a few minutes fast writes a `validFrom`
 * that is past for it and still future for the importer; measured against
 * `createdAt` that reads as already-crossed, the flag is not set, and the
 * importer then crosses the boundary by clock advance alone. That is not a
 * small drift: `documents` goes stale-low while `df` stays live, so
 * `log1p((documents - df + 0.5) / (df + 0.5))` turns negative and
 * `#bm25Recall`'s `score > 0` gate drops the rows outright — silent, total
 * recall loss for the query, including rows that have nothing to do with the
 * imported record. So the baseline is the reader's clock, always.
 *
 * Sticky (`INSERT OR IGNORE`, never cleared): the pending crossing may happen
 * at any later time, and the flag has to outlive the record — erasing it does
 * not un-stale a cache entry built while it was there.
 *
 * **Four fields, not two.** `#bm25Recall`'s live scope and `#at()` between them
 * compare *four* record instants against the clock, and a crossing in any of
 * them changes corpus membership with no write:
 *
 *  1. `m.created_at <= knownAt` — applies **on its own**, independently of
 *     `validFrom`. Testing `validFrom ?? createdAt` is therefore NOT a mirror
 *     of the SQL: it discards `createdAt` exactly when `validFrom` is present,
 *     leaving a backdated record ("true since 2020") written by a fast clock
 *     unflagged and still gated by this clause.
 *  2. `coalesce(validFrom, created_at) <= asOf`.
 *  3. `validUntil IS NULL OR validUntil > asOf`.
 *  4. `updatedAt <= knownAt`, which gates the `superseded` and `invalidated`
 *     branches of `#at()`. Here the stale `documents` runs *high* rather than
 *     low, so scores inflate instead of rows vanishing — it corrupts RRF
 *     ordering and score thresholds rather than emptying the result.
 *
 * All four are only reachable through `import()`: every local write path takes
 * `createdAt`/`updatedAt` from this same clock, so `> now` is false for them
 * and those paths are unaffected.
 *
 * Call on every insert; a no-op unless the record carries a boundary still in
 * the reader's future at insert time.
 */
export function markTemporalBoundsIfNeeded(db: DatabaseSync, record: { workspaceId: string; createdAt: string; updatedAt: string; validFrom?: string; validUntil?: string }, now: string): void {
  // Every instant on the record that a live scope test compares against the
  // clock, not just the declared validity bounds. See the four conjuncts listed
  // above: `createdAt` gates scope on its own via `m.created_at<=knownAt`
  // *independently* of `validFrom`, and `updatedAt` gates the superseded and
  // invalidated branches in `#at()`. Any one of them still in the future is a
  // crossing that can happen with no write.
  if (!(record.createdAt > now || record.updatedAt > now
    || (record.validFrom !== undefined && record.validFrom > now)
    || (record.validUntil !== undefined && record.validUntil > now))) return;
  db.prepare('INSERT OR IGNORE INTO local_settings(key,value) VALUES(?,?)').run(`bm25-temporal-bounds:${record.workspaceId}`, '1');
}
