import type { MemoryEmbedder, MemoryReranker } from '../local/index.js';
import type { MatchedSystem } from './matched-types.js';

/** Public history and questions are separate from evaluator-only reference labels. */
export interface EvaluationTurn {
  id: string;
  text: string;
  role?: 'user' | 'assistant';
  speaker?: string;
  date?: string;
  /** Original evidence identities, used only by the scorer, never the search index. */
  evidenceGroups: string[];
}
export interface EvaluationCorpus { id: string; turns: EvaluationTurn[] }
export interface EvaluationQuestion { id: string; corpusId: string; query: string; category: string }
export interface EvaluationLabel {
  questionId: string;
  evidenceGroups: string[];
  answerability: 'answerable' | 'unanswerable' | 'unknown';
  answerSchema: 'text' | 'rubric-only' | 'missing' | 'unsupported';
  /** Never sent to embedding, retrieval, packing or reader code. */
  reference?: unknown;
}
export interface CorpusDataset {
  protocol: 'mnemosyne-corpus-retrieval-v1';
  adapter: string;
  provenance: {
    dataset: string; revision: string; license: string; sourceUrl?: string;
    sourceSha256?: string; sourceBytes?: number;
    verification: 'caller-supplied';
  };
  corpora: EvaluationCorpus[];
  questions: EvaluationQuestion[];
  labels: EvaluationLabel[];
  notices: string[];
}
export type CorpusProvenance = Omit<CorpusDataset['provenance'], 'verification'>;
export type CorpusCondition = 'no-memory' | 'full-context' | 'lexical' | 'bm25' | 'hybrid' | 'hybrid-norerank';
/** A competitor system's condition key, kept in a separate namespace from ours. */
export type MatchedConditionId = `system:${string}`;
/** Every key that can appear in `summaries` and on an attempt. */
export type BenchmarkConditionId = CorpusCondition | MatchedConditionId;
export interface CorpusBenchmarkOptions {
  topK?: number;
  maxContextUnits?: number;
  chunkBytes?: number;
  maxQuestions?: number;
  maxTurnsPerCorpus?: number;
  maxCorpusBytes?: number;
  maxTotalBytes?: number;
  maxCandidates?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  embedder?: MemoryEmbedder;
  /** Optional query-side embedder for models trained with an asymmetric query
   * convention. It must declare the same model identity and width as `embedder`,
   * because both sides have to land in one vector space. Defaults to `embedder`. */
  queryEmbedder?: MemoryEmbedder;
  /** Cross-encoder applied to the hybrid condition only, after fusion. The
   * zero-model conditions never see it, so their numbers stay comparable across runs. */
  reranker?: MemoryReranker;
  /** Fused candidates handed to `reranker`, 1-1000. Defaults to 50, matching the
   * engine's default hybrid path, so the benchmark measures the shipped configuration. */
  rerankTopN?: number;
  /** Additional named condition, keeping the existing overlap baseline unchanged. */
  includeBm25?: boolean;
  /**
   * Scores the fused ranking as its own `hybrid-norerank` condition alongside the
   * reranked `hybrid` one, from a single ingestion and a single embedding pass.
   * Off by default, so an existing run's conditions and numbers are unchanged.
   * With a reranker supplied this is what makes the reranker's contribution a
   * within-run delta rather than a comparison across two separate runs.
   */
  includeHybridWithoutRerank?: boolean;
  hybridLexicalScoring?: 'overlap' | 'bm25';
  /**
   * Retrieval granularity for the hybrid conditions.
   *
   * `turn` is the default and is exactly the run this harness has always done.
   * `multi` additionally derives a session and summary index over the same chunks
   * — keyed on the turn date each chunk already carries — and fuses it into the
   * hybrid ranking. The zero-model conditions never see it, so their numbers stay
   * comparable across runs, and a `multi` run reports its index build time beside
   * its embedding time rather than hiding it inside retrieval latency.
   */
  granularity?: 'turn' | 'multi';
  /**
   * Competitor systems scored in the same loop, on the same chunks, with the same
   * packing budget and the same scorer. Each becomes a `system:<id>` condition.
   */
  systems?: MatchedSystem[];
  /** Per-system wall-clock bound for loading one corpus. Defaults to the run timeout. */
  systemIngestTimeoutMs?: number;
  /**
   * Ordinal of this run's first corpus within the whole dataset.
   *
   * Chunk identities are derived from the corpus ordinal, so a run over corpora
   * 5-9 would otherwise number them 0-4 and mint different identities for the
   * same passages. Identities feed insertion order and therefore tie-breaking
   * among equally-scored candidates, so a long run split into parts would not
   * quite equal the same run done in one — which is exactly the kind of
   * difference a reproducible comparison cannot carry. Setting the base makes a
   * split run produce byte-identical identities to the whole run. Defaults to 0,
   * so an unsplit run is unchanged.
   */
  corpusIndexBase?: number;
  maxEmbeddingCalls?: number;
  maxEmbeddingInputBytes?: number;
  /** All conditions use this same counter over the exact complete envelope. */
  countContext?: (text: string) => number;
  accountingId?: string;
}
export interface EvidenceScore {
  annotated: boolean;
  targetGroups: number;
  matchedGroups: number;
  retrievedGroups: number;
  anyHit: boolean | null;
  allHit: boolean | null;
  recall: number | null;
  precision: number | null;
  reciprocalRank: number | null;
}
export interface CorpusAttempt {
  questionId: string; category: string; condition: BenchmarkConditionId;
  answerability: EvaluationLabel['answerability']; answerSchema: EvaluationLabel['answerSchema'];
  status: 'completed' | 'context-overflow' | 'retrieval-error' | 'embedding-error' | 'budget-exhausted' | 'cancelled' | 'system-error';
  retrieval: EvidenceScore;
  packed: EvidenceScore;
  retrievedChunks: number; packedChunks: number;
  contextBytes: number; contextUnits: number; requiredFullContextUnits?: number;
  retrievalMs: number; packingMs: number;
  /** Original identities and offsets permit audit without publishing conversation text. */
  selected: { turnId: string; startByte: number; endByte: number }[];
}
export interface CorpusSummary {
  questions: number; completed: number; overflows: number; errors: number;
  annotatedQuestions: number; anyHitRate: number | null; allHitRate: number | null;
  meanRecall: number | null; meanPrecision: number | null; mrr: number | null;
  packedAnyHitRate: number | null; packedAllHitRate: number | null; packedMeanRecall: number | null;
  meanContextUnits: number; p50RetrievalMs: number | null; p95RetrievalMs: number | null;
}
export interface CorpusBenchmarkReport {
  kind: 'offline corpus retrieval evaluation'; protocol: CorpusDataset['protocol'];
  dataset: CorpusDataset['provenance'] & { adapter: string; normalizedSha256: string; questions: number; corpora: number };
  runtime: { node: string; platform: string; implementationSha256: string; fingerprint: string }; settings: Record<string, string | number>;
  calls: { embedding: number; embeddingInputBytes: number; generation: 0; judge: 0 };
  embedding?: { model: string; dimensions: number; asymmetric: boolean };
  /**
   * Every competitor that was offered to the run, with its caller-attested mode
   * label and, when it could not be loaded, the verbatim reason. A system that
   * failed is reported here with a reason and never with a score.
   */
  systems?: { id: string; condition: MatchedConditionId; revision: string; mode: string; status: 'scored' | 'ingest-failed'; reason?: string; ingestMilliseconds: number }[];
  answerQuality: 'not-evaluated'; complete: boolean;
  ingestion: { corpusId: string; turns: number; chunks: number; bytes: number; milliseconds: number; embeddingMilliseconds: number;
    /** Present only on a multi-granularity run: what the derived index cost to
     * build and how much of it there is. Absent means it was never built. */
    granularity?: { milliseconds: number; sessions: number; documents: number; embedded: number; unsessioned: number } }[];
  attempts: CorpusAttempt[]; summaries: Partial<Record<BenchmarkConditionId, CorpusSummary>>;
  notices: string[]; limitations: string[]; durationMs: number;
}
