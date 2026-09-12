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
export interface RuntimeSkill {
  id: string;
  recordId: string;
  state: 'candidate' | 'active' | 'retired';
  definition: SkillDefinition;
  fingerprint: string;
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
