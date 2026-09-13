import type { MemoryEmbedder } from '../local/index.js';

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
export type CorpusCondition = 'no-memory' | 'full-context' | 'lexical' | 'bm25' | 'hybrid';
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
  /** Additional named condition, keeping the existing overlap baseline unchanged. */
  includeBm25?: boolean;
  hybridLexicalScoring?: 'overlap' | 'bm25';
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
  questionId: string; category: string; condition: CorpusCondition;
  answerability: EvaluationLabel['answerability']; answerSchema: EvaluationLabel['answerSchema'];
  status: 'completed' | 'context-overflow' | 'retrieval-error' | 'embedding-error' | 'budget-exhausted' | 'cancelled';
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
  embedding?: { model: string; dimensions: number };
  answerQuality: 'not-evaluated'; complete: boolean;
  ingestion: { corpusId: string; turns: number; chunks: number; bytes: number; milliseconds: number; embeddingMilliseconds: number }[];
  attempts: CorpusAttempt[]; summaries: Partial<Record<CorpusCondition, CorpusSummary>>;
  notices: string[]; limitations: string[]; durationMs: number;
}
