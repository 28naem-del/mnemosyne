import type { AgentContext, AgentContextProvider, BeforeTurnInput } from '../agent/types.js';
import type { MemoryMaintenance } from '../maintenance/index.js';
import type { MigrationFamily } from '../migration/types.js';

/** The host attests the adapter returns only this explicitly selected owner. */
export interface LegacyMemoryAdapter {
  /** Stable adapter implementation/configuration revision. */
  id: string;
  family: MigrationFamily;
  sourceStore: string;
  sourceOwner: string;
  collection?: string;
  /** Read-only: the bridge never calls update, delete, export, or disconnect. */
  search(input: { query: string; limit: number; maxBytes: number; signal: AbortSignal }): Promise<readonly LegacyMemoryMatch[]>;
}
export interface LegacyMemoryMatch {
  /** Stable source-native identity; see the full migration identity rules. */
  id: string;
  /** Opaque equality token. Different bytes with the same revision are rejected. */
  revision: string;
  /** Exact original text, never a model-generated migration summary. */
  text: string;
}
export type BridgeMode = 'auto' | 'legacy';
export type BridgePhase = 'shadow' | 'assist' | 'prefer-mnemosyne';
export interface BridgeBudgets {
  maxMatches?: number;
  maxLegacyBytes?: number;
  maxContextBytes?: number;
  maxSourceBytes?: number;
  maxScanRecords?: number;
  maxLocalCandidates?: number;
  timeoutMs?: number;
  /** Maximum life of a reconciled context, independent of source watch policies. */
  packetLifetimeMs?: number;
}
export interface MemoryBridgeOptions {
  adapter: LegacyMemoryAdapter;
  /** observed means a host assertion, never authenticated factual truth. */
  trust?: 'untrusted' | 'observed';
  budgets?: BridgeBudgets;
  promotion?: { assistAfter?: number; preferAfter?: number; minCoverage?: number };
  maintenance?: MemoryMaintenance;
  /** Trusted synchronous policy; no asynchronous policy or hidden discovery. */
  policy?: () => { readOnly?: boolean; captureEnabled?: boolean; recallEnabled?: boolean };
  /** Defaults to UTF-8 bytes, a conservative complete-envelope allowance. */
  tokenCounter?: (text: string) => number;
  tokenizerId?: string;
}
export interface BridgeStatus {
  mode: BridgeMode;
  phase: BridgePhase;
  consecutiveSuccessfulPairs: number;
  pairedQueries: number;
  pairedMatches: number;
  localMatches: number;
  observedCoverage: number | null;
  failures: number;
  importedRevisions: number;
  knownSourceIdentities: number;
  /** Search results cannot establish the total size of the old memory store. */
  totalLegacyCoverage: 'unknown';
  legacyReconciliation: 'every-query';
  legacyWrites: 0;
  legacyDisconnected: false;
}
export interface BridgeRecallInput extends BeforeTurnInput { maxTokens?: number }
export interface BridgeRecallResult {
  context: AgentContext;
  status: BridgeStatus;
  coverage: { legacyMatches: number; eligibleMatches: number; localMatches: number; fraction: number | null };
  items: { memoryId: string; identity: string; route: 'legacy' | 'mnemosyne'; rendered: boolean }[];
  /** Private native originals merged without changing legacy coverage metrics. */
  nativeMemoryIds: string[];
  excluded: { identity: string; reason: 'forgotten' | 'untrusted' }[];
  importedRevisions: number;
  legacyCalls: 1;
}
export type BridgeErrorCode = 'input' | 'policy' | 'budget' | 'cancelled' | 'timeout' | 'legacy-unavailable' | 'superseded' | 'source-conflict' | 'state' | 'staging-failed' | 'stale-context';
/** No raw provider error is retained. Fallback is transient host-only data. */
export class MemoryBridgeError extends Error {
  constructor(readonly code: BridgeErrorCode,
    /** Only validated, bounded legacy results; never pass this into MemoryAgent. */
    readonly legacyFallback: readonly LegacyMemoryMatch[] = []) {
    super(`Memory bridge operation ${code}.`); this.name = 'MemoryBridgeError';
  }
}
export type { AgentContextProvider };
