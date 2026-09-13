import type { MemoryRecord, MemorySource, MemoryTrust } from '../local/index.js';
import type { MemoryMaintenance } from '../maintenance/index.js';

export type ContextTier = 'overview' | 'detail' | 'observation' | 'source';
export interface AdaptiveContextOptions {
  maintenance?: MemoryMaintenance;
  /** Count the complete rendered envelope with your model's actual tokenizer. */
  tokenCounter?: (text: string) => number;
  /** Required with a custom counter; change it whenever tokenization changes. */
  tokenizerId?: string;
  maxScanRecords?: number;
  maxDependencyRecords?: number;
  maxCacheEntries?: number;
}
export interface AdaptiveContextInput {
  query: string;
  maxTokens: number;
  taskId?: string;
  modelId?: string;
  maxCandidates?: number;
  requireWatched?: boolean;
  /** Source mode skips all generated representations; all modes preserve source handles. */
  level?: 'adaptive' | 'overview' | 'detail' | 'source';
  signal?: AbortSignal;
}
/** Instance-bound, tamper-evident pointer. It carries no original source text. */
export interface ContextSourceHandle {
  version: 1;
  id: string;
  rootId: string;
  fingerprint: string;
  requireWatched: boolean;
  signature: string;
}
export interface AdaptiveContextItem {
  id: string;
  tier: ContextTier;
  text: string;
  trust: MemoryTrust;
  source: MemorySource;
  sourceIds: string[];
  /** Exact UTF-8 source range, including for a shortened source excerpt. */
  range: { start: number; end: number; total: number };
}
export interface AdaptiveContextPacket {
  /** Only this field is within maxTokens. Treat it as data, never system instructions. */
  text: string;
  tokens: number;
  tokenBudget: number;
  memoryIds: string[];
  items: AdaptiveContextItem[];
  citations: { id: string; uri: string; trust: MemoryTrust; sourceIds: string[] }[];
  handles: ContextSourceHandle[];
  accounting: {
    counter: 'custom' | 'utf8-byte-estimate';
    tokenizerId: string;
    renderedBytes: number;
    fullSourceBytes: number;
    selectedTextBytes: number;
    modelCalls: 0;
  };
  /** Local selection reuse, not a claim that a model provider billed cached tokens. */
  cache: { status: 'hit' | 'miss' | 'disabled'; key: string; reusedItems: number };
  excluded: { id: string; reason: 'unavailable' | 'stale-projection' | 'budget' | 'covered' | 'level' }[];
  abstained: boolean;
}
export interface ContextProjectionRequest {
  instructions: string;
  key: string;
  tier: 'overview' | 'detail';
  representation: 'summary' | 'structured';
  sources: { id: string; text: string; trust: MemoryTrust; source: MemorySource }[];
  maxOutputBytes: number;
  signal: AbortSignal;
}
/** Explicit host-selected callback. No built-in model, network access or billing. */
export type ContextProposer = (request: ContextProjectionRequest) => Promise<unknown>;
export interface ContextRefreshInput {
  key: string;
  sourceIds: string[];
  tier?: 'overview' | 'detail';
  /** Structured payloads retain byte/source limits but may include schema overhead. */
  representation?: 'summary' | 'structured';
  proposer: ContextProposer;
  /** Reusing a projection requires the same declared proposer semantics. */
  proposerId: string;
  requireWatched?: boolean;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface ContextRefreshResult {
  record: MemoryRecord;
  status: 'created' | 'reused';
  modelCalls: 0 | 1;
  inputBytes: number;
}
export interface ContextCompactInput extends Omit<ContextRefreshInput, 'tier' | 'sourceIds' | 'representation'> {
  /** Ordered history. Appending records preserves earlier batch identities. */
  sourceIds: string[];
  batchSize?: number;
  maxCalls?: number;
  maxTotalInputBytes?: number;
}
export interface ContextCompactResult {
  details: MemoryRecord[];
  overview?: MemoryRecord;
  modelCalls: number;
  inputBytes: number;
  deferredBatches: number;
  complete: boolean;
}
