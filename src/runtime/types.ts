import type { MemoryRecord, MemorySource, MemoryTrust, MemoryVisibility } from '../local/index.js';

export interface CapturedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  timestamp?: string;
}
export interface CaptureInput {
  sessionId: string;
  adapter?: 'generic' | 'codex' | 'claude';
  messages: CapturedMessage[];
  /** Observed means the host witnessed the message, not that its claims are true. */
  trust?: 'untrusted' | 'observed';
  visibility?: MemoryVisibility;
}
export interface CaptureResult { enabled: boolean; records: MemoryRecord[]; cursor?: string }
export interface RuntimeOptions {
  captureEnabled?: boolean;
  recallEnabled?: boolean;
  now?: () => Date;
  /** Fail closed if a bounded inventory cannot be fully inspected. */
  maxScanRecords?: number;
  /** Controller-owned requirements for new skills, persisted with each skill.
   * Defaults to one distinct task and verifier for compatibility. Prefer
   * RECOMMENDED_SKILL_PROMOTION_POLICY (two of each) for stronger promotion. */
  skillPromotionPolicy?: SkillPromotionPolicy;
}
export interface RuntimeSource { id: string; text: string; source: MemorySource; trust: MemoryTrust }
export interface RuntimeProposalRequest {
  kind: 'observe' | 'model';
  instructions: string;
  sources: RuntimeSource[];
  key?: string;
  maxOutputBytes: number;
  signal: AbortSignal;
}
/** Caller owns provider selection, payment policy and cancellation cooperation. */
export type RuntimeProposer = (request: RuntimeProposalRequest) => Promise<unknown>;
export interface ProposalBudgets {
  maxInputBytes?: number;
  maxOutputBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface EnqueueInput {
  kind: 'observe' | 'model';
  sourceIds: string[];
  key?: string;
  tier?: 'overview' | 'detail';
  parentKey?: string;
}
export interface RuntimeJob extends EnqueueInput {
  jobId: string;
  recordId: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  fingerprint: string;
  leaseUntil?: string;
  resultIds: string[];
  error?: string;
}
export interface RunJobsOptions extends ProposalBudgets {
  proposer: RuntimeProposer;
  maxJobs?: number;
  maxCalls?: number;
  maxTotalInputBytes?: number;
  leaseMs?: number;
  maxAttempts?: number;
}
export interface RunJobsReport {
  processed: number;
  modelCalls: number;
  inputBytes: number;
  completed: string[];
  failed: { jobId: string; error: string }[];
  skipped: number;
}
export interface ModelResult {
  status: 'fresh' | 'stale' | 'missing';
  record?: MemoryRecord;
  sourceIds: string[];
  reason?: string;
  modelCalls: number;
}
export interface SkillDefinition {
  name: string;
  prerequisites: string[];
  steps: string[];
  parameters: Record<string, { description: string; required: boolean }>;
  evidenceIds: string[];
}
export interface SkillPromotionPolicy {
  /** Controller-assigned policy revision. Requirements are also bound into identity. */
  id: string;
  /** Integer from 1 to 32. Repeated task/evidence assertions cannot add support. */
  minimumDistinctTasks: number;
  /** Integer from 1 to 32. Verifier identifiers are controller assertions, not authentication. */
  minimumDistinctVerifiers: number;
}
export interface RuntimeSkill {
  id: string;
  recordId: string;
  state: 'candidate' | 'active' | 'retired';
  definition: SkillDefinition;
  fingerprint: string;
  /** Missing only on existing legacy skills, whose policy is one task and verifier. */
  promotionPolicy?: SkillPromotionPolicy;
  reason?: string;
  trials: { passed: boolean; evidence: string; verifier: string; taskId: string; prerequisitesSatisfied: boolean }[];
}
export interface SkillValidation {
  passed: boolean;
  evidence: string;
  verifier: string;
  taskId: string;
  prerequisitesSatisfied: boolean;
}
export interface SkillTrialInput extends ProposalBudgets {
  id: string;
  validation?: SkillValidation;
  verifier?: (request: { skill: RuntimeSkill; signal: AbortSignal }) => Promise<SkillValidation>;
}
export interface DocumentExtractionRequest {
  uri: string;
  mimeType: string;
  data: Uint8Array;
  maxOutputBytes: number;
  signal: AbortSignal;
}
export interface IngestInput extends ProposalBudgets {
  uri: string;
  mimeType: string;
  text?: string;
  data?: Uint8Array;
  extractor?: (request: DocumentExtractionRequest) => Promise<string>;
  revision?: string;
  trust?: 'untrusted' | 'observed';
}

/** The synchronous direct-text subset of document ingestion. */
export type IngestTextInput = Omit<IngestInput, 'data' | 'extractor' | 'text'> & { text: string };
