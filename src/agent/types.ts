import type { JsonValue } from '../local/index.js';
import type { MemoryReadSet } from '../maintenance/index.js';
import type { CaptureInput, CaptureResult, RunJobsOptions, RunJobsReport, RuntimeJob, RuntimeProposer } from '../runtime/index.js';

export interface AgentContext {
  text: string;
  tokens: number;
  tokenBudget: number;
  memoryIds: string[];
  abstained: boolean;
}
export interface BeforeTurnInput {
  query: string;
  maxTokens?: number;
  taskId?: string;
  requireWatched?: boolean;
  signal?: AbortSignal;
}
/** Trusted host integration with a synchronous final dispatch check. */
export interface AgentContextProvider {
  build(input: BeforeTurnInput & { maxTokens: number; signal: AbortSignal }): Promise<AgentContext>;
  /** Throw if the exact packet or its source state is no longer valid. No async work. */
  validate(context: AgentContext): void;
  /** Providers that stage source records must opt in to capture policy checks. */
  requiresCapture?: boolean;
}
export interface BeforeTurnResult { enabled: boolean; context: AgentContext }
export interface AfterTurnResult extends CaptureResult {
  jobs: RuntimeJob[];
  scheduling: 'queued' | 'empty' | 'disabled' | 'recall-disabled' | 'ineligible';
}
export type AgentJobBudgets = Omit<RunJobsOptions, 'proposer' | 'signal'>;
export interface AgentDrainReport extends RunJobsReport {
  status: 'processed' | 'disabled' | 'no-proposer';
}
export interface BackgroundOptions {
  /** No timer starts until start() is explicitly called. */
  intervalMs?: number;
  maxCycles?: number;
  maxDurationMs?: number;
  /** Totals for this start(), not renewed at each cycle. */
  maxCalls?: number;
  maxTotalInputBytes?: number;
  signal?: AbortSignal;
}
export interface BackgroundReport {
  cycles: number;
  processed: number;
  modelCalls: number;
  inputBytes: number;
  completed: number;
  failed: number;
  reason: 'completed' | 'budget' | 'cancelled' | 'disabled' | 'no-proposer' | 'failed';
}
export interface AgentBackground {
  readonly done: Promise<BackgroundReport>;
  stop(): Promise<BackgroundReport>;
}
export interface AgentActionInput {
  name: string;
  args: JsonValue;
  memoryIds: string[];
  dependenciesComplete: true;
  lifetimeMs?: number;
  requireWatched?: boolean;
}
export interface AgentAction {
  readonly name: string;
  readonly args: JsonValue;
  readonly readSet: MemoryReadSet;
}
export interface RunTurnInput extends BeforeTurnInput {
  sessionId: string;
  turnId: string;
  /** Visible user input; never hidden reasoning or tool payloads. */
  input: string;
  /** Overall host callback deadline. Does not retry the host on failure. */
  timeoutMs?: number;
  visibility?: CaptureInput['visibility'];
  trust?: CaptureInput['trust'];
}
export interface RunTurnResult {
  response: string;
  before: BeforeTurnResult;
  after: AfterTurnResult;
}
export type AgentResponder = (request: { input: string; context: AgentContext; signal: AbortSignal }) => Promise<string>;
export interface AgentEventInput {
  adapter: 'codex' | 'claude';
  /** Explicit thread/session identity. Event envelopes cannot change this scope. */
  sessionId: string;
  events: readonly unknown[];
  trust?: CaptureInput['trust'];
  visibility?: CaptureInput['visibility'];
}
export type { RuntimeProposer };
