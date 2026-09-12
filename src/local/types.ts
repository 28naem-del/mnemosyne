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
  createdAt: string;
  updatedAt: string;
  status: MemoryStatus;
  supersedes?: string;
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
  /** Retries must use exactly the same normalized payload. */
  idempotencyKey?: string;
}

export interface LocalMemoryOptions {
  path: string;
  workspaceId: string;
  agentId: string;
  now?: () => Date;
  /** Counts rendered context text, including its instruction/citation envelope. */
  tokenCounter?: (text: string) => number;
}

export interface RecallInput {
  query: string;
  limit?: number;
  kinds?: MemoryKind[];
  includeUntrusted?: boolean;
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
