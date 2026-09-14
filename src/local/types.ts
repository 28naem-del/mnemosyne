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
export type LedgerEvent = 'store' | 'correction' | 'recall' | 'outcome' | 'erasure';

/** Where a record came from and what it claimed at the moment it was written. */
export interface LedgerProvenance {
  origin: 'store' | 'correction' | 'checkpoint' | 'import';
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

/** A ranking stage a candidate passed through on its way to (or out of) the result set. */
export type RetrievalStage = 'lexical' | 'dense' | 'fused' | 'reranked';

/** One candidate as ONE stage ranked it. A candidate the dense channel found and
 * the reranker demoted appears once per stage, which is what makes a retrieval
 * replayable and what turns an outcome into a per-stage training signal. */
export interface LedgerCandidate {
  memoryId: string;
  stage: RetrievalStage;
  /** Zero-based position within that stage. */
  rank: number;
  score: number;
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
  grain: 'day' | 'month' | 'year';
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
  /** The full per-stage candidate set, oldest stage first, bounded by
   * `ledger.maxCandidates`. Empty on schema 1 entries and when candidate
   * recording is off. */
  candidates: LedgerCandidate[];
  /** How many candidates each stage produced against how many were recorded, so a
   * bounded record still discloses what it dropped. */
  candidateCounts: { stage: RetrievalStage; total: number; recorded: number }[];
  /** Null until a verifier judges the task this retrieval informed. */
  verifier: LedgerVerifierOutcome | null;
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
}

export interface LedgerQuery {
  limit?: number;
  /** Exclusive lower bound; pass the previous page's nextCursor. */
  after?: number;
  events?: LedgerEvent[];
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
}

export interface RecallInput {
  query: string;
  /** BM25 is the default. Explicit overlap retains the earlier lexical formula. */
  lexicalScoring?: 'overlap' | 'bm25';
  limit?: number;
  kinds?: MemoryKind[];
  includeUntrusted?: boolean;
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
  /** Read the time expression in `query` and retrieve accordingly. Off by default,
   * so results, ledger entries and benchmark numbers are unchanged until asked for.
   * An explicit `asOf` or `knownAt` always wins over a parsed one. */
  temporalRouting?: 'auto' | 'off';
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
  rerank(query: string, candidates: readonly MemoryRecord[], options: { signal: AbortSignal }): Promise<{ id: string; score: number }[]>;
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
export interface HybridRecallOptions {
  embedder: MemoryEmbedder;
  /** Reciprocal rank fusion constant, 1-1000. Defaults to the memory's setting. */
  rrfK?: number;
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
  /** Real-world time represented by this packet. Historical context is labeled in its envelope. */
  asOf?: string;
  /** Excludes records, corrections and outcome evidence learned after this instant. */
  knownAt?: string;
  /** Read the time expression in `query` and compile accordingly. Off by default.
   * An explicit `asOf` or `knownAt` always wins over a parsed one. */
  temporalRouting?: 'auto' | 'off';
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
