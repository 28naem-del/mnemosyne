/**
 * Provenance and outcome ledger.
 *
 * Every belief change and every retrieval that informed one is appended here, so
 * a later consolidation pass can replay what the agent knew, what it was shown,
 * and whether acting on it worked. Entries carry identities, digests and
 * provenance, never the source text of a record: erasing a memory erases its
 * ledger entries and its appearances in past retrievals through foreign keys,
 * so the ledger cannot become a back door around forget().
 */
export type LedgerEvent = 'store' | 'correction' | 'recall' | 'outcome' | 'erasure' | 'promotion' | 'consolidation' | 'dependency';

/** Receipt of one outcome-verified consolidation pass (proposal digest, replay
 * gate scores, verdict, state hashes before and after). The concrete shape is
 * defined by the consolidation module; the ledger stores it as it was given. */
export type LedgerConsolidation = { [key: string]: JsonValue };
/** Receipt of one inferred-dependency review decision (which record was found
 * to silently depend on which, the co-activation evidence, and whether a human
 * or policy accepted it). Defined by the dependencies module. */
export type LedgerDependency = { [key: string]: JsonValue };

/** Where a record came from and what it claimed at the moment it was written. */
export interface LedgerProvenance {
  /** `promotion` marks the superseding record a granted `promote()` wrote. */
  origin: 'store' | 'correction' | 'checkpoint' | 'import' | 'promotion';
  sourceUri: string;
  author?: string;
  observedAt?: string;
  revision?: string;
  kind: MemoryKind;
  trust: MemoryTrust;
  visibility: MemoryVisibility;
  key?: string;
  /** Digest of the stored text, so a later replay can prove it is unchanged. */
  textSha256: string;
  textBytes: number;
  dependencies: string[];
  supersedes?: string;
  validFrom?: string;
  validUntil?: string;
}

/** A ranking stage a candidate passed through on its way to (or out of) the result set.
 * `names` is the name/alias phrase channel; it only appears on a recall that turned
 * it on through `requireNamedMatch`. */
export type RetrievalStage = 'lexical' | 'dense' | 'names' | 'fused' | 'reranked';

/** One candidate as ONE stage ranked it. A candidate the dense channel found and
 * the reranker demoted appears once per stage, which is what makes a retrieval
 * replayable and what turns an outcome into a per-stage training signal. */
export interface LedgerCandidate {
  memoryId: string;
  stage: RetrievalStage;
  /** Zero-based position within that stage. */
  rank: number;
  score: number;
  /** Which granularities nominated this candidate, comma separated and sorted —
   * `'turn'`, `'session'`, `'turn,session,summary'`. Entries written before the
   * multi-granularity index read back as `'turn'`, which is what they were. */
  granularity?: string;
}

/** Every knob that can change what a retrieval returns, so two runs are only
 * comparable when their `configSha256` matches. Nulls are meaningful: a null
 * reranker says no reranker ran, not that one ran and was not recorded. */
export interface LedgerRetrievalConfig {
  mode: RetrievalMode;
  lexicalScoring: 'overlap' | 'bm25';
  embeddingModel: string | null;
  rerankerModel: string | null;
  rrfK: number;
  limit: number;
  maxCandidates: number;
  /** Fused candidates handed to the reranker; null when no reranker ran. */
  rerankTopN: number | null;
  minSimilarity: number;
  /** The score floors this recall enforced. Absent when none was set, so entries
   * written without floors keep the configuration hash they always had. */
  minScores?: RecallScoreFloors;
  /** Present only when the name/alias gate ran. */
  requireNamedMatch?: true | 'auto';
  /** Present only when guarded single-edit term expansion was on. */
  fuzzy?: true;
  /** A kind predicate the caller asked the kernel to evaluate in SQL. Absent when
   * the recall did not restrict kinds. */
  kinds?: MemoryKind[];
  /** The metadata predicate the kernel evaluated in SQL, as the keys it constrained
   * and a digest of the canonical filter. The values are not stored, for the same
   * reason the query is not stored by default. */
  metadataFilter?: { keys: string[]; sha256: string };
}

/** Per-stage score floors. Every floor is optional and inclusive: a candidate
 * scoring exactly the floor clears it.
 *
 * - `keyword`: the lexical channel's own score (BM25 or overlap). A lexical
 *   candidate below it leaves the lexical channel; it can still arrive through
 *   another channel.
 * - `semantic`: the dense cosine, 0-1. Combined with `minSimilarity` by taking
 *   the larger of the two.
 * - `reranker`: the cross-encoder's probability, 0-1 (the logistic of its raw
 *   score). When set and a reranker ran, a candidate the reranker did not clear —
 *   including one it never saw — is not returned.
 * - `final`: the score the result would be returned with.
 * - `finalRelative`: a fraction of the best final score, 0-1.
 *
 * Floors exclude; they never reorder. When nothing clears them the recall
 * returns an empty list and the ledger records why, rather than returning the
 * nearest unrelated record. */
export interface RecallScoreFloors {
  keyword?: number;
  semantic?: number;
  reranker?: number;
  final?: number;
  finalRelative?: number;
}

/** Why a recall returned nothing.
 * - `no-candidates`: no channel produced a candidate in scope.
 * - `no-named-match`: candidates existed, but the name/alias gate admitted none.
 * - `below-floor`: candidates existed, but none cleared the score floors. */
export type RecallAbstentionReason = 'no-candidates' | 'no-named-match' | 'below-floor';

/** The kernel's own account of an empty recall. `topScore` is the best score the
 * stage that emptied the list saw, or null when there was nothing to score. */
export interface RecallAbstention {
  reason: RecallAbstentionReason;
  floors: RecallScoreFloors;
  topScore: number | null;
}

/** The verdict of a verifier on the task a retrieval informed. The slot exists on
 * every recorded retrieval and stays null until a verifier actually runs, so an
 * unjudged retrieval is distinguishable from a failed one. */
export interface LedgerVerifierOutcome {
  taskId: string;
  success: boolean;
  verifier: string;
  evidenceSha256: string;
  recordedAt: string;
}

/** The time expression a query carried, and the retrieval parameters it produced.
 * Recorded in full so the decision can be re-derived and argued with later: the
 * span that was read, how it was read, and which bounds were actually applied. */
export interface LedgerTemporalRouting {
  /** The literal span of the original query that was read as a time expression. */
  matched: string;
  /** `before`/`after` narrow visibility; `at`/`between` only prioritise. */
  relation: 'at' | 'before' | 'after' | 'between';
  grain: 'day' | 'week' | 'month' | 'year';
  /** How far the parse was trusted, 0-1. Routing runs only above its threshold. */
  confidence: number;
  /** The query the ranking channels actually saw, with the time expression removed. */
  cleanedQuery: string;
  /** The parsed slice: `from` inclusive, `to` exclusive. */
  window: { from: string; to: string };
  /** Present only where the parse supplied a bound the caller had left open. */
  appliedAsOf?: string;
  appliedKnownAt?: string;
}

/** What a retrieval was asked for and what it returned. `results` and `candidates`
 * are rebuilt from the reference tables, so an erased record leaves no identity behind. */
export interface LedgerRetrieval {
  /** Present only when the ledger was configured with `queries: 'text'`. */
  query?: string;
  querySha256: string;
  mode: RetrievalMode;
  lexicalScoring: 'overlap' | 'bm25';
  limit: number;
  returned: number;
  embeddingModel?: string;
  degraded?: string;
  asOf?: string;
  knownAt?: string;
  /** What temporal routing read out of the query and what it did about it.
   * Absent whenever routing did not run or the parser declined, which is every
   * entry written before this field existed. */
  temporalRouting?: LedgerTemporalRouting;
  latencyMs: number;
  results: { memoryId: string; rank: number; score: number }[];
  /** 1 = written before the candidate-set schema existed; 2 = carries `config`,
   * `configSha256` and per-stage `candidates`. Entries are never rewritten to
   * claim a schema they were not recorded under. */
  schema: 1 | 2;
  /** Absent on schema 1 entries, which genuinely did not record their configuration. */
  config?: LedgerRetrievalConfig;
  configSha256?: string;
  /** What the multi-granularity index contributed, present only on a recall that
   * asked for it. `expandedDocs`/`expandedTurns` disclose the caps actually hit,
   * so a bounded expansion never reads as an unbounded one. */
  granularity?: { mode: GranularityMode; channels: { level: GranularityLevel; channel: 'lexical' | 'dense'; documents: number; expandedDocs: number; expandedTurns: number }[]; reserved: number };
  /** The full per-stage candidate set, oldest stage first, bounded by
   * `ledger.maxCandidates`. Empty on schema 1 entries and when candidate
   * recording is off. */
  candidates: LedgerCandidate[];
  /** How many candidates each stage produced against how many were recorded, so a
   * bounded record still discloses what it dropped. */
  candidateCounts: { stage: RetrievalStage; total: number; recorded: number }[];
  /** Null until a verifier judges the task this retrieval informed. */
  verifier: LedgerVerifierOutcome | null;
  /** Present only when this recall returned nothing: the reason, the floors in
   * force and the best score seen. An entry without it either returned results or
   * was written before native abstention existed. */
  abstained?: RecallAbstention;
}

export interface LedgerCorrection {
  supersededId: string;
  correctionId: string;
  reason?: string;
  /** Records the cascade invalidated, so the change can be replayed or undone. */
  invalidatedIds: string[];
  invalidatedCount: number;
}

export interface LedgerOutcome {
  taskId: string;
  success: boolean;
  verifier: string;
  evidenceSha256: string;
}

/** The only promotion rule this kernel implements; recorded on every decision so a
 * later rule can never be mistaken for this one. */
export type PromotionRule = 'ancestry-disjoint-v1';

/** One named corroborator as the promotion gate judged it. */
export interface PromotionCorroboration {
  id: string;
  /** Null when the id does not resolve to a record visible in this scope. */
  trust: MemoryTrust | null;
  disjointFromCandidate: boolean;
  /** Ancestors it shares with the candidate: `memory:<id>`, `source:<uri>` and
   * `author:<author>` nodes, sorted, at most 32. Empty when disjoint. */
  sharedAncestors: string[];
}

/**
 * A promotion decision (rule M3, ancestry-disjoint corroboration). Written for
 * every `promote()` call, granted or not, so a quarantine is as auditable as a
 * promotion. `reason` is the caller's; `verdict` is the kernel's.
 */
export interface LedgerPromotion {
  /** The candidate the caller asked to promote. */
  memoryId: string;
  from: MemoryTrust;
  to: 'observed' | 'verified';
  decision: 'promoted' | 'quarantined';
  reason: string;
  /** Human-readable machine reason, e.g. `quarantined: corroborator <id> shares
   * ancestor source:doc://handbook with the candidate`. */
  verdict: string;
  corroboration: PromotionCorroboration[];
  /** Pairs of qualifying corroborators whose ancestries are disjoint from each other. */
  disjointPairs: number;
  rule: PromotionRule;
  /** Present on a granted promotion: the record that carries the raised trust.
   * Promotion supersedes the candidate rather than editing it in place, so the
   * belief state at any earlier cut point replays unchanged. */
  promotedId?: string;
}

export interface PromoteInput {
  to: 'observed' | 'verified';
  /** At least two distinct record ids, at most 16. */
  corroboration: string[];
  reason: string;
}

export interface PromotionDecision extends LedgerPromotion {
  /** The superseding record on a granted promotion; the unchanged candidate otherwise. */
  record: MemoryRecord;
  /** Absent when the ledger is disabled. */
  ledgerId?: string;
}

export interface LedgerEntry {
  id: string;
  /** Monotonic within one database; also the pagination cursor. */
  sequence: number;
  event: LedgerEvent;
  recordedAt: string;
  workspaceId: string;
  agentId: string;
  memoryId?: string;
  provenance?: LedgerProvenance;
  retrieval?: LedgerRetrieval;
  correction?: LedgerCorrection;
  outcome?: LedgerOutcome;
  erasure?: { deletedCount: number };
  promotion?: LedgerPromotion;
  consolidation?: LedgerConsolidation;
  dependency?: LedgerDependency;
}

export interface LedgerQuery {
  limit?: number;
  /** Exclusive lower bound; pass the previous page's nextCursor. */
  after?: number;
  events?: LedgerEvent[];
  /** Shorthand for a single-event filter; combined with `events` when both are given. */
  event?: LedgerEvent;
  memoryId?: string;
}
export interface LedgerPage { entries: LedgerEntry[]; nextCursor?: number }

export interface LedgerOptions {
  /** Defaults to true. */
  enabled?: boolean;
  /** `full` (the default) records every retrieval stage's candidate set with its
   * ranks and scores, which is what makes a retrieval replayable and trainable.
   * `off` records only the returned results, restoring the pre-T1.5 write volume
   * for callers that want the smaller ledger. */
  candidates?: 'full' | 'off';
  /** Candidates recorded per stage, 1–1000, default 100. This is the bound on a
   * ledger record's size; the stage's true depth is still disclosed in
   * `candidateCounts` so a truncated record never reads as a complete one.
   * Use `candidates: 'off'` to record none at all. */
  maxCandidates?: number;
  /** `digest` keeps only a SHA-256 of each recall query, and is the default,
   * because a query is user text that no foreign key can erase: storing it
   * verbatim would let a query about a record outlive forget() of that record.
   * `text` keeps queries verbatim for trajectory replay, and is an explicit
   * decision to accept that they survive erasure. */
  queries?: 'text' | 'digest';
}

/** Portable JSON values only; metadata is validated at runtime. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type MemoryKind = 'fact' | 'preference' | 'decision' | 'procedure' | 'observation' | 'checkpoint';
export type MemoryTrust = 'untrusted' | 'observed' | 'verified';
export type MemoryVisibility = 'private' | 'workspace';
export type MemoryStatus = 'active' | 'superseded' | 'invalidated';

export interface MemorySource {
  uri: string;
  author?: string;
  observedAt?: string;
  /** Caller supplied artifact revision/hash; no remote fetch or automatic verification. */
  revision?: string;
}

export interface MemoryRecord {
  id: string;
  text: string;
  kind: MemoryKind;
  workspaceId: string;
  agentId: string;
  visibility: MemoryVisibility;
  trust: MemoryTrust;
  source: MemorySource;
  /** Required for verified trust. This is a controller assertion, not authenticated proof. */
  evidence?: string;
  /** Explicit fact identity; different active texts with the same key remain conflicts. */
  key?: string;
  /** Inclusive real-world validity; defaults to createdAt when absent. */
  validFrom?: string;
  /** Exclusive real-world validity endpoint. */
  validUntil?: string;
  createdAt: string;
  updatedAt: string;
  status: MemoryStatus;
  supersedes?: string;
  /** Kernel-recorded correction cascade. Absent on ambiguous legacy invalidations. */
  invalidation?: { sourceId: string; correctionId: string; recordedAt: string };
  dependencies: string[];
  metadata: Record<string, JsonValue>;
}

export interface StoreMemoryInput {
  text: string;
  kind?: MemoryKind;
  visibility?: MemoryVisibility;
  trust?: MemoryTrust;
  source: MemorySource;
  evidence?: string;
  key?: string;
  dependencies?: string[];
  /** Free-form JSON. One key is read by recall: `names`, an array of strings
   * naming what this record is about (a canonical name and its aliases). A recall
   * with `requireNamedMatch` matches them as whole token phrases against the query
   * — underscores and punctuation separate tokens, case and accents are ignored —
   * so `"github actions"` matches "GitHub Actions" but not "actions" alone.
   * Non-string entries are ignored; nothing else about the record changes. */
  metadata?: Record<string, JsonValue>;
  validFrom?: string;
  validUntil?: string;
  /** Retries must use exactly the same normalized payload. */
  idempotencyKey?: string;
}

/** `hybrid` fuses dense and lexical candidates with RRF. `lexical` is the
 * zero-model deterministic path: no model participates in retrieval at all,
 * which is what makes it auditable, so it remains a first-class selection. */
export type RetrievalMode = 'hybrid' | 'lexical';

import type { DenseIndexMode, DenseIndexStatus } from './vector/types.js';
export type { DenseIndexMode, DenseIndexStatus } from './vector/types.js';

export interface LocalMemoryOptions {
  path: string;
  workspaceId: string;
  agentId: string;
  now?: () => Date;
  /** Counts rendered context text, including its instruction/citation envelope. */
  tokenCounter?: (text: string) => number;
  /** Defaults to `hybrid`. Select `lexical` for the zero-model deterministic path. */
  retrieval?: RetrievalMode;
  /** Explicit synchronous embedder. Defaults to the bundled pinned local model.
   * `null` is equivalent to selecting `lexical`. */
  embedder?: SyncMemoryEmbedder | null;
  /** Absolute cache directory for the bundled model. Defaults to MNEMOSYNE_MODEL_CACHE. */
  modelCacheDir?: string;
  /** Throw when `hybrid` is requested but no embedder is available, instead of
   * reporting a degradation and retrieving lexically. Defaults to false. */
  requireEmbedder?: boolean;
  /** Rescore the fused candidates with the bundled cross-encoder before
   * truncating to `limit`. Defaults to true, and only ever applies on the hybrid
   * path: the zero-model deterministic path loads no model of any kind. */
  rerank?: boolean;
  /** Explicit synchronous reranker. Defaults to the bundled pinned cross-encoder.
   * `null` is equivalent to `rerank: false`. */
  reranker?: SyncMemoryReranker | null;
  /** Fused candidates handed to the reranker, 1–200. Defaults to 50.
   *
   * Reranking is the expensive stage — it runs one model pass per candidate,
   * against one per query for the dense channel — so this is the knob that trades
   * recall against latency. */
  rerankTopN?: number;
  /** Default dense similarity floor for every recall, 0-1. Defaults to 0. */
  minSimilarity?: number;
  /** Reciprocal rank fusion constant, 1-1000. Defaults to 10.
   *
   * RRF scores a candidate as the sum of 1/(k + rank) over the channels that
   * returned it, so k sets how quickly rank differences stop mattering. The
   * widely quoted k=60 comes from fusing TREC runs a thousand results deep; this
   * engine fuses two hundred-result channels into a top-ten answer, where k on
   * the order of the cut depth keeps the head of each channel meaningful.
   * Measured on LoCoMo: k=60 scores 61.75 mean recall@10 and k=10 scores 65.63. */
  rrfK?: number;
  /** Provenance and outcome ledger settings. `false` disables it entirely. */
  ledger?: LedgerOptions | false;
  /** Which dense index to search. Defaults to `MNEMOSYNE_INDEX_MODE`, else `auto`.
   *
   * - `exact` — score every authorized vector. No optional binaries, no index
   *   files, and the answer every other mode is measured against.
   * - `auto` — sqlite-vec when the extension loads, otherwise `exact`. Still an
   *   exact search: `vec0` scores the same vectors in C instead of in JS.
   * - `sqlite-vec` — as `auto`, but refuses to degrade silently.
   * - `hnsw` — approximate, sublinear, for stores past a few hundred thousand
   *   vectors. It is the one retrieval component here that can *miss* a true
   *   neighbour, which is why it is never selected on your behalf.
   *
   * No mode changes what a record scores or whether it may be returned: every
   * candidate an index proposes is re-authorized and rescored against the stored
   * vector before it reaches a caller. */
  indexMode?: DenseIndexMode;
  /** Explicit filesystem path to a `sqlite-vec` loadable extension, overriding
   * the bundled `sqlite-vec` package's own resolution. Only consulted when
   * `indexMode` is `auto` or `sqlite-vec`. There is no environment-variable
   * equivalent: an env-controlled path would make every `LocalMemory` opened
   * on a machine `dlopen` whatever that variable points at, by default and
   * without the caller asking for it. This option requires the caller to name
   * the path explicitly. */
  sqliteVecPath?: string;
  /** `PRAGMA cache_size`, applied on every open. SQLite's own units: a
   * **positive** value is a page count; a **negative** value is a KiB budget
   * (what this engine defaults to and recommends, since page size can vary).
   * Defaults to `-65536` — 64 MiB. A larger page cache means fewer trips
   * through the OS page cache for the shortlist rescore and BM25 postings the
   * hot recall path reads on every query, which matters once the working set
   * stops fitting in whatever RAM SQLite would otherwise settle for on its
   * own (a few MB). Must be a nonzero integer, magnitude at most 2,097,152. */
  cacheSize?: number;
  /** Multi-granularity index settings. The index is only ever built by an
   * explicit `indexGranularity()` call and is only ever read by a recall that
   * asks for `granularity: 'multi'`, so these settings change nothing on their
   * own. */
  granularity?: GranularityOptions;
  /** Default score floors for every recall; a recall's own `minScores` replaces
   * them key by key. See {@link RecallScoreFloors}. Defaults to none. */
  minScores?: RecallScoreFloors;
  /** Default for `RecallInput.requireNamedMatch`. Defaults to false. */
  requireNamedMatch?: boolean | 'auto';
  /** Default for `RecallInput.fuzzy`. Defaults to false. */
  fuzzy?: boolean;
}

/** What retrieval actually does, as opposed to what was asked for. A hybrid
 * request that could not load a model reports `mode: 'lexical'` with the
 * reason in `degraded`; it is never silent. */
export interface RetrievalStatus {
  requested: RetrievalMode;
  mode: RetrievalMode;
  embeddingModel?: string;
  dimensions?: number;
  degraded?: string;
  /** Present when a reranker will run on this path. */
  rerankerModel?: string;
  rerankTopN?: number;
  /** Why reranking is not running although it was requested. Never silent. */
  rerankDegraded?: string;
  /** Which dense index served this path. Absent until a dense recall has run. */
  index?: DenseIndexStatus;
  /** Why a `granularity: 'multi'` recall could not consult the derived index —
   * no embedder on this path, or nothing built yet. Never silent. */
  granularityDegraded?: string;
  /** The fusion constant and default dense floor, present on the hybrid path so
   * a re-execution (memory bisect's Oracle B) can rebuild the same retriever. */
  rrfK?: number;
  minSimilarity?: number;
}

/** One stored dense vector, byte-for-byte as `local_embeddings` holds it: packed
 * float32 (or legacy JSON text), keyed by the hash of the text it was computed
 * from. Carried by `exportEmbeddings`/`importEmbeddings`, never by a snapshot. */
export interface StoredEmbedding {
  memoryId: string;
  model: string;
  dimensions: number;
  sourceHash: string;
  data: Uint8Array | string;
}

export interface RecallInput {
  query: string;
  /** BM25 is the default. Explicit overlap retains the earlier lexical formula. */
  lexicalScoring?: 'overlap' | 'bm25';
  limit?: number;
  kinds?: MemoryKind[];
  includeUntrusted?: boolean;
  /** Read the time expression in `query` and retrieve accordingly. Off by default,
   * so results, ledger entries and benchmark numbers are unchanged until asked for.
   * An explicit `asOf` or `knownAt` always wins over a parsed one. Declared beside
   * the other time options rather than at the end of the interface, which is where
   * a parallel branch appends its own field. */
  temporalRouting?: 'auto' | 'off';
  /** Real-world time to recall. Historical mode is enabled by either time field. */
  asOf?: string;
  /** Only use memories and outcome evidence recorded by this time. */
  knownAt?: string;
  /** Candidate budget, at most 10000. BM25 scores all scoped matches before retaining candidates. */
  maxCandidates?: number;
  /** Minimum cosine for a dense candidate to count as affirmative evidence, 0-1.
   * Defaults to the value given to createLocalMemory, which itself defaults to 0.
   *
   * A dense retriever always has a nearest neighbour, so an unrelated query still
   * returns its closest record. Measured on the bundled model, true matches score
   * about 0.69-0.77 while unrelated text still scores about 0.33-0.53, so a useful
   * floor sits near 0.55 and a floor below ~0.5 filters almost nothing. Raw recall
   * is a diagnostic view and defaults to no floor; compile() gates separately. */
  minSimilarity?: number;
  /** Consult the session and summary indexes beside the turn index. Defaults to
   * `'turn'`, which is exactly the pre-existing engine. Results are turn-level
   * records either way: a session or summary hit is expanded back into its member
   * records, and each of those passes the same eligibility gate as any other
   * candidate before it can be returned. */
  granularity?: GranularityMode;
  /** Score floors for this recall, replacing the instance defaults key by key.
   * See {@link RecallScoreFloors}. */
  minScores?: RecallScoreFloors;
  /** The name/alias gate over `metadata.names` (see {@link StoreMemoryInput}).
   *
   * - `false` (default): names are not consulted; retrieval is unchanged.
   * - `true`: only records whose names occur in the query as a whole phrase may
   *   be returned. A query that names nothing returns `[]`, recorded in the ledger
   *   as the abstention reason `no-named-match`.
   * - `'auto'`: a record that declares names may only be returned through one of
   *   them; a record without names is retrieved as usual.
   *
   * Either way the names stage is also a candidate channel fused beside the
   * others, so a record named in the query is found even when no content term
   * matches. */
  requireNamedMatch?: boolean | 'auto';
  /** Guarded single-edit typo tolerance (see `fuzzy.ts`): a query term with no
   * exact posting in scope also matches stored terms one edit away that share its
   * first two letters, with at least four letters each and no digits. Name phrases
   * match per token under the same guard. Deterministic and model-free; off by
   * default. Expanded terms score at half weight. */
  fuzzy?: boolean;
  /** A metadata predicate the kernel evaluates in the SQL of every channel, before
   * ranking: each key must hold a string equal to the value, or to one of the
   * values when an array is given. At most 32 keys and 64 values per key. This is
   * a scope selector, not an authentication boundary. */
  metadata?: Record<string, string | string[]>;
}

export interface ListMemoryInput {
  limit?: number;
  cursor?: string;
  kinds?: MemoryKind[];
  includeInactive?: boolean;
  includeUntrusted?: boolean;
  /** Exact top-level string equality, not JSON path expressions. */
  metadata?: Record<string, string>;
}
export interface MemoryPage { items: MemoryRecord[]; nextCursor?: string }

export interface MemoryEmbedder {
  /** Stable model AND revision identifier. Changing output semantics requires a new identifier. */
  model: string;
  dimensions: number;
  embed(texts: readonly string[], options: { signal: AbortSignal }): Promise<number[][]>;
}
/** An embedder that can also run inline on a synchronous call path. The bundled
 * model satisfies this; remote embedders cannot, which is why they stay on the
 * explicit `recallHybrid` path. */
export interface SyncMemoryEmbedder extends MemoryEmbedder {
  embedSync(texts: readonly string[], role?: 'query' | 'passage'): number[][];
  forQueries(): MemoryEmbedder;
  forPassages(): MemoryEmbedder;
  close(): void;
}
export interface MemoryReranker {
  /**
   * `options.passages`, when present, is the text to score for each candidate at
   * the same index, in place of `candidate.text`.
   *
   * It exists so a caller can score a turn together with its in-session
   * neighbours WITHOUT handing this boundary a record that lies about itself:
   * `MemoryRecord` is the provider-agnostic contract and overwriting its `text`
   * would corrupt it for every implementer. A reranker that ignores the array
   * behaves exactly as it does today, which is the correct degradation.
   */
  rerank(query: string, candidates: readonly MemoryRecord[], options: { signal: AbortSignal; passages?: readonly string[] }): Promise<{ id: string; score: number }[]>;
  /** See `SyncMemoryReranker.countTokens`. */
  countTokens?(text: string): number;
}
/**
 * A cross-encoder that rescores candidates against the query on a synchronous
 * call path, so it composes with `recall()` without making it async — the same
 * property that let the bundled embedder become the default.
 *
 * It scores query/passage PAIRS jointly rather than comparing two independent
 * vectors, which is why it can reorder candidates a bi-encoder ranked wrongly.
 */
export interface SyncMemoryReranker {
  /** Stable model AND revision identifier. Changing scoring semantics requires a new identifier. */
  readonly model: string;
  /** One score per passage, in input order. Higher is more relevant; the scale is
   * the model's own and is only meaningful for ordering within one call. */
  rerankSync(query: string, passages: readonly string[]): number[];
  /** The model's own piece count for a string, when it can report one. Callers
   * that assemble a passage under a token budget need the encoder's unit rather
   * than an approximation of it; a reranker that cannot answer simply omits this
   * and its callers fall back to leaving the budget unspent. */
  countTokens?(text: string): number;
  close(): void;
}
export interface EmbeddingIndexOptions {
  embedder: MemoryEmbedder;
  /** Maximum records submitted in this invocation, at most 1000. */
  limit?: number;
  /** Maximum records in each provider call, at most 100. */
  batchSize?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface EmbeddingIndexResult { indexed: number; skipped: number; remaining: number }
/** Weights of the two first-stage channels `recallHybrid` fuses. */
export interface HybridFusionWeights {
  /** Lexical (BM25 or overlap) channel. Defaults to 1. */
  lexical?: number;
  /** Dense (cosine) channel. Defaults to 1. */
  dense?: number;
}
export interface HybridRecallOptions {
  embedder: MemoryEmbedder;
  /** Reciprocal rank fusion constant, 1-1000. Defaults to the memory's setting. */
  rrfK?: number;
  /** Per-channel RRF weights, each 0-1000. Each channel contributes
   * `weight / (rrfK + rank)` per candidate. Both default to 1, which is the
   * unweighted fusion this path has always done, bit for bit. */
  fusionWeights?: HybridFusionWeights;
  reranker?: MemoryReranker;
  /** Fused candidates handed to the reranker, 1-1000. Defaults to 100, which is
   * the depth this path has always rescored. The synchronous default path uses
   * its own `rerankTopN` (50); set this to match when comparing the two. */
  rerankTopN?: number;
  signal?: AbortSignal;
  /** Deadline for each provider call and for the cooperative full vector scan; incomplete scans reject. */
  timeoutMs?: number;
  /** Maximum best-scoring vector candidates retained, at most 10000. Every authorized indexed row is scanned. */
  maxCandidates?: number;
}

export interface CompileInput {
  query: string;
  /** BM25 is the default; overlap retains the earlier lexical formula. */
  lexicalScoring?: 'overlap' | 'bm25';
  maxTokens: number;
  taskId?: string;
  /** Read the time expression in `query` and compile accordingly. Off by default.
   * An explicit `asOf` or `knownAt` always wins over a parsed one. */
  temporalRouting?: 'auto' | 'off';
  /** Real-world time represented by this packet. Historical context is labeled in its envelope. */
  asOf?: string;
  /** Excludes records, corrections and outcome evidence learned after this instant. */
  knownAt?: string;
  /** Consult the session and summary indexes beside the turn index. Defaults to `'turn'`. */
  granularity?: GranularityMode;
}

export interface RecallResult {
  memory: MemoryRecord;
  score: number;
  outcomes: { successes: number; failures: number };
}

export interface ContextCitation {
  id: string;
  uri: string;
  trust: MemoryTrust;
  evidence?: string;
}

export interface ContextPacket {
  /** Pass this field to the model. Structured diagnostics are outside the text budget. */
  text: string;
  tokens: number;
  tokenBudget: number;
  items: MemoryRecord[];
  citations: ContextCitation[];
  excluded: { id: string; reason: 'budget' | 'failed-outcome' | 'conflict-budget' | 'provenance-conflict' | 'checkpoint-conflict' }[];
  conflicts: { key: string; ids: string[] }[];
  uncertainty: string[];
  abstained: boolean;
  /** Why the packet is empty, present only when `abstained` is true. `budget` and
   * `withheld` mean candidates existed but none fit the token budget or passed the
   * provenance/outcome gate; the other reasons come from retrieval itself. */
  abstention?: ContextAbstention;
}

/** The reason a context packet carries no items. */
export interface ContextAbstention {
  reason: RecallAbstentionReason | 'budget' | 'withheld';
  floors: RecallScoreFloors;
  topScore: number | null;
}

export interface CheckpointInput {
  taskId: string;
  /** Source/procedure memories that must remain usable for this task handoff. */
  dependencies?: string[];
  goal: string;
  completed: string[];
  pending: string[];
  decisions: string[];
  constraints: string[];
  artifacts: string[];
  rejectedApproaches?: string[];
  nextAction: string;
  visibility?: MemoryVisibility;
}

export interface OutcomeInput {
  memoryId: string;
  success: boolean;
  evidence: string;
  verifier: string;
  taskId: string;
}

/** Attaches a verifier's verdict to the retrieval that informed it, filling that
 * entry's reserved slot. This is the join that makes a ledger row a training
 * example: one query, one configuration, the full candidate set, and whether
 * acting on it worked. */
export interface RetrievalOutcomeInput {
  /** Defaults to the most recent retrieval recorded by this instance. */
  retrievalId?: string;
  taskId: string;
  success: boolean;
  evidence: string;
  verifier: string;
}

export interface OutcomeRecord extends OutcomeInput {
  id: string;
  workspaceId: string;
  agentId: string;
  createdAt: string;
}

export interface SnapshotIdempotencyEntry {
  workspaceId: string;
  agentId: string;
  key: string;
  memoryId: string;
  payload: Omit<StoreMemoryInput, 'idempotencyKey'>;
}

export interface MemorySnapshot {
  format: 'mnemosyne-local';
  version: 1;
  workspaceId: string;
  agentId: string;
  exportedAt: string;
  memories: MemoryRecord[];
  outcomes: OutcomeRecord[];
  /** Retry identity and its original normalized payload, scoped to the owner. */
  idempotency?: SnapshotIdempotencyEntry[];
  /** Owned records omitted because their provenance includes another agent. */
  omitted?: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  outcomesImported: number;
}

/** An opaque full-record revision captured by a trusted controller. */
export interface RollbackRecordExpectation { id: string; fingerprint: string }
export interface RollbackUnchangedRecordsInput {
  /** Exact private records created by the operation being undone, at most 10000. */
  records: readonly RollbackRecordExpectation[];
}

// The multi-granularity declarations live at the end of this file rather than
// beside the option that references them: the other tier-1 branches append their
// own fields to LocalMemoryOptions at the same anchor, and a seventy-line block
// there turns a one-line additive merge into a seventy-line one.

/** The coarser grains the same content is indexed at beside the turn itself. */
export type GranularityLevel = 'session' | 'summary';
/** `turn` is the default and is exactly the pre-existing engine. `multi` also
 * consults the session and summary indexes and expands what they return back into
 * member records, so the result shape is unchanged either way. */
export type GranularityMode = 'turn' | 'multi';

export interface GranularityOptions {
  /** Metadata keys naming the session a record belongs to, in priority order.
   * Defaults to `['sessionId', 'conversationId', 'threadId']`. A record carrying
   * none of them is never derived from and stays turn-only. */
  sessionKeys?: string[];
  /** Records per session window, 1-256. Defaults to 6. */
  windowTurns?: number;
  /** Window stride, 1-256, at most `windowTurns`. Defaults to 3, so windows
   * overlap by half and evidence straddling a boundary is still covered whole. */
  windowStride?: number;
  /** Sentences kept in a session summary, 1-64. Defaults to 5. */
  summarySentences?: number;
  /** Salient terms prefixed to a session summary, 1-128. Defaults to 12. */
  summaryKeywords?: number;
  /** Weight of one derived channel's RRF contribution, 0-4. Defaults to 0.5.
   *
   * The turn level has two channels and so a total voice of 2.0. At 0.5 the
   * session level and the summary level each total 1.0, which is the intended
   * relationship: derived evidence corroborates turn evidence rather than
   * outvoting it. */
  weight?: number;
  /** In-session neighbours concatenated on EITHER side of a candidate when the
   * cross-encoder rescores it, 0-4. Defaults to 0, which is the feature off.
   *
   * A cross-encoder scores each turn against the query in isolation, which is the
   * judgement a session index exists to correct: a turn that is evidence only in
   * context gets pulled into the pool by session expansion and then rescored to
   * the floor. Above 0, and only on the `multi` path, each candidate is scored a
   * SECOND time against a passage that leads with its own text and continues with
   * its neighbours, and that ordering joins the fusion as one more channel. The
   * isolated score is never replaced. Measured on LoCoMo, 2 is the knee: a radius
   * of 2 reaches 28.5 % of all-evidence-hit failures and 3 adds a further 1.5 %. */
  rerankContext?: number;
  /** Wordpieces of context admitted per candidate, 0-448. Defaults to 192.
   *
   * This is the one latency dial. Sequence cost is set by the LONGEST member of a
   * batch, so capping the context caps the padded width of the contextual pass
   * regardless of how long the corpus's turns are. Neighbours are admitted whole
   * and skipped when they do not fit; the candidate is never budgeted and never
   * truncated. */
  rerankContextTokens?: number;
  /** Candidates given a contextual pass, 1-1000. Defaults to 14.
   *
   * The latency valve, and the one that actually bites: ONLY these rows are
   * submitted to the second pass, so its cost is proportional to this number and
   * not to the whole rerank head. Everything below the cut keeps the isolated
   * pass's ordering in the contextual channel, so lowering this withholds help
   * from a candidate rather than penalising it.
   *
   * 14 is not a taste call, it is the budget divided by the measured price. A
   * windowed row costs ~11.9 ms on the bundled int8 cross-encoder (measured: 32
   * rows add 379.5 ms to p95), and the p95 budget a multi run has over the turn
   * path it must stay within twice of is ~162 ms on a quiet host. The cost is
   * flat rather than tail-heavy — p50 and p95 move together — so this is a
   * throughput cap and not a timeout. */
  rerankContextTopN?: number;
  /** Derived documents expanded per channel, 1-500. Defaults to 12. */
  expandDocs?: number;
  /** Distinct member records expanded per channel, 1-2000. Defaults to 24.
   *
   * Capped on members and not only on documents because one summary document is
   * a whole session — a mean of 21.6 records on LoCoMo — so a document-only cap
   * would let one channel inject several hundred records into a rerank pool of
   * fifty. */
  expandTurns?: number;
  /** Extra rerank slots reserved for candidates only the derived index found,
   * 0-500. Defaults to 16.
   *
   * Multi-granularity never takes a slot away from the turn-level ranking. The
   * reranker receives the whole turn-only pool it would have received anyway,
   * plus at most this many additional candidates, so expansion can only ever add
   * work and never evict a turn-level candidate it would have scored. */
  reserve?: number;
}

export interface GranularityIndexOptions {
  /** Embeds the derived documents. Omit to build the lexical index only. */
  embedder?: MemoryEmbedder;
  /** Documents in each provider call, at most 100. Defaults to 32. */
  batchSize?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GranularityIndexResult {
  /** Sessions the current records imply. */
  sessions: number;
  /** Derived documents the current records imply. */
  documents: number;
  inserted: number;
  removed: number;
  /** Documents left untouched because their content was unchanged, and whose
   * vectors therefore did not need recomputing. */
  unchanged: number;
  embedded: number;
  /** Records carrying no session key, which are never derived from. */
  unsessioned: number;
}
