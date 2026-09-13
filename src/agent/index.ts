import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AdaptiveContext, type AdaptiveContextPacket } from '../context/index.js';
import { MemoryMaintenance } from '../maintenance/index.js';
import { canonical, metadata } from '../local/validation.js';
import { MemoryRuntime, parseTranscriptJsonl, type CaptureInput, type RuntimeProposer } from '../runtime/index.js';
import { messagesFromAgentEvents } from './events.js';
import type { AgentAction, AgentActionInput, AgentBackground, AgentContext, AgentContextProvider, AgentDrainReport, AgentEventInput, AgentJobBudgets, AgentResponder, AfterTurnResult, BackgroundOptions, BackgroundReport, BeforeTurnInput, BeforeTurnResult, RunTurnInput, RunTurnResult } from './types.js';
export * from './types.js';
export { messagesFromAgentEvents } from './events.js';

const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const identifier = z.string().min(1).max(160).refine(value => !!value.trim() && !value.includes('\0'));
const query = z.string().min(1).refine(value => !!value.trim() && !value.includes('\0') && Buffer.byteLength(value) <= 4096);
const int = (value: number | undefined, fallback: number, min: number, max: number) => z.number().int().min(min).max(max).parse(value ?? fallback);
const emptyContext = (maxTokens: number): AgentContext => ({ text: '', tokens: 0, tokenBudget: maxTokens, memoryIds: [], abstained: true });
const emptyDrain = (status: AgentDrainReport['status']): AgentDrainReport => ({ status, processed: 0, modelCalls: 0, inputBytes: 0, completed: [], failed: [], skipped: 0 });
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };

export class AgentOperationError extends Error {
  constructor(readonly code: 'cancelled' | 'timeout' | 'host-failed' | 'already-attempted' | 'capture-failed' | 'action-rejected' | 'context-failed' | 'reservation-failed',
    /** Present only when visible host output exists but its capture failed. Never persisted. */
    readonly response?: string) {
    super(`Memory agent operation ${code}.`); this.name = 'AgentOperationError';
  }
}

export interface MemoryAgentOptions {
  maintenance?: MemoryMaintenance;
  /** Trusted host callback; must bind every rendered claim to memoryIds. */
  contextBuilder?: (input: BeforeTurnInput & { maxTokens: number; signal: AbortSignal }) => Promise<AgentContext>;
  /** Context with a final synchronous source-state check; exclusive with contextBuilder. */
  contextProvider?: AgentContextProvider;
  proposer?: RuntimeProposer;
  readOnly?: boolean;
  /** Default untrusted. Set observed only when the host witnessed the supplied messages. */
  captureTrust?: CaptureInput['trust'];
  jobBudgets?: AgentJobBudgets;
}

async function bounded<T>(callback: (signal: AbortSignal) => Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Invalid abort signal.');
  if (signal?.aborted) throw new AgentOperationError('cancelled');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = () => { controller.abort(); reject(new AgentOperationError('cancelled')); };
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new AgentOperationError('timeout')); }, timeoutMs);
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new AgentOperationError('cancelled');
      return callback(controller.signal);
    }), stopped]);
    if (controller.signal.aborted) throw new AgentOperationError('cancelled');
    return result;
  } finally { if (timer) clearTimeout(timer); if (cancel) signal?.removeEventListener('abort', cancel); }
}

/** Opt-in lifecycle for a host-owned agent. Construction starts no work and opens no accounts. */
export class MemoryAgent {
  readonly runtime: MemoryRuntime;
  readonly maintenance: MemoryMaintenance;
  readonly #context: AdaptiveContext;
  readonly #builder?: MemoryAgentOptions['contextBuilder'];
  readonly #provider?: AgentContextProvider;
  readonly #proposer?: RuntimeProposer;
  readonly #readOnly: boolean;
  readonly #trust: NonNullable<CaptureInput['trust']>;
  readonly #budgets: AgentJobBudgets;
  readonly #contextChecks = new WeakMap<AgentContext, () => boolean>();
  readonly #actions = new WeakMap<AgentAction, { key: string; used: boolean }>();
  #draining?: Promise<AgentDrainReport>;
  #drainController?: AbortController;
  #background?: AgentBackground;
  #closed = false;

  constructor(runtime: MemoryRuntime, options: MemoryAgentOptions = {}) {
    if (!(runtime instanceof MemoryRuntime)) throw new TypeError('MemoryAgent requires MemoryRuntime.');
    const allowed = ['maintenance', 'contextBuilder', 'contextProvider', 'proposer', 'readOnly', 'captureTrust', 'jobBudgets'];
    if (Object.keys(options).some(key => !allowed.includes(key))) throw new TypeError('Unknown memory agent option.');
    if ((options.proposer !== undefined && typeof options.proposer !== 'function') || (options.contextBuilder !== undefined && typeof options.contextBuilder !== 'function')) throw new TypeError('Invalid host callback.');
    if (options.contextProvider !== undefined) {
      const provider = options.contextProvider;
      if (!provider || typeof provider !== 'object' || typeof provider.build !== 'function' || typeof provider.validate !== 'function' || (provider.requiresCapture !== undefined && typeof provider.requiresCapture !== 'boolean') || options.contextBuilder !== undefined) throw new TypeError('Invalid or ambiguous context provider.');
      this.#provider = Object.freeze({ build: provider.build.bind(provider), validate: provider.validate.bind(provider), requiresCapture: provider.requiresCapture ?? false });
    }
    this.runtime = runtime;
    this.maintenance = options.maintenance ?? new MemoryMaintenance(runtime);
    if (this.maintenance.runtime !== runtime) throw new TypeError('Maintenance must belong to this runtime.');
    this.#context = new AdaptiveContext(runtime, { maintenance: this.maintenance });
    this.#builder = options.contextBuilder; this.#proposer = options.proposer;
    this.#readOnly = z.boolean().parse(options.readOnly ?? false);
    this.#trust = z.enum(['untrusted', 'observed']).parse(options.captureTrust ?? 'untrusted');
    this.#budgets = z.object({ maxJobs: z.number().int().min(1).max(64).optional(), maxCalls: z.number().int().min(0).max(64).optional(), maxTotalInputBytes: z.number().int().min(0).max(4_194_304).optional(), maxInputBytes: z.number().int().min(1024).max(262_144).optional(), maxOutputBytes: z.number().int().min(256).max(65_536).optional(), timeoutMs: z.number().int().min(10).max(60000).optional(), leaseMs: z.number().int().max(300000).optional(), maxAttempts: z.number().int().min(1).max(10).optional() }).strict().parse(options.jobBudgets ?? {});
    if (this.#budgets.leaseMs !== undefined && this.#budgets.leaseMs <= (this.#budgets.timeoutMs ?? 30000)) throw new TypeError('Lease must exceed the proposer timeout.');
    Object.defineProperties(this, { runtime: { writable: false }, maintenance: { writable: false } });
  }
  #open(): void { if (this.#closed) throw new Error('Memory agent is closed.'); }
  #write(): void { this.#open(); if (this.#readOnly) throw new Error('Memory agent is read-only.'); if (!this.runtime.captureEnabled) throw new Error('Memory agent capture is disabled.'); }

  async beforeTurn(input: BeforeTurnInput): Promise<BeforeTurnResult> {
    this.#open(); const maxTokens = int(input.maxTokens, 4096, 0, 1_000_000);
    if (!this.runtime.recallEnabled) return { enabled: false, context: emptyContext(maxTokens) };
    if (this.#provider?.requiresCapture && (this.#readOnly || !this.runtime.captureEnabled)) throw new AgentOperationError('context-failed');
    query.parse(input.query); if (input.taskId !== undefined) identifier.parse(input.taskId);
    try {
      const context = await bounded(async signal => {
        this.#open();
        const request = { ...input, maxTokens, signal };
        const packet = this.#provider ? await this.#provider.build(request) : this.#builder ? await this.#builder(request) : await this.#context.build({ ...request, maxCandidates: 64 });
        this.#open();
        if (signal.aborted) throw new AgentOperationError('cancelled');
        if (typeof packet.text !== 'string' || !Number.isSafeInteger(packet.tokens) || packet.tokens < 0 || packet.tokens > maxTokens || packet.tokenBudget !== maxTokens || !Array.isArray(packet.memoryIds) || packet.memoryIds.length > 64) throw new Error();
        // Validate complete dependencies again after any asynchronous context builder.
        if (packet.memoryIds.length) this.maintenance.createReadSet({ memoryIds: packet.memoryIds, actionKey: 'agent:context', dependenciesComplete: true, requireWatched: input.requireWatched });
        if (this.#provider) {
          const provider = this.#provider;
          const contextIdentity = () => hash({ text: packet.text, tokens: packet.tokens, tokenBudget: packet.tokenBudget, memoryIds: packet.memoryIds, abstained: packet.abstained });
          const expected = contextIdentity();
          const valid = () => {
            try {
              if (contextIdentity() !== expected) return false;
              const result: unknown = provider.validate(packet);
              // TypeScript permits async callbacks in a void-returning slot. They
              // cannot guard dispatch; observe rejection but never accept them.
              if (result !== undefined) { void Promise.resolve(result).catch(() => undefined); return false; }
              return contextIdentity() === expected;
            } catch { return false; }
          };
          if (!valid()) throw new Error();
          this.#contextChecks.set(packet, valid);
        } else if (!this.#builder) {
          const built = packet as AdaptiveContextPacket;
          if (!this.#context.validate(built).valid) throw new Error();
          this.#contextChecks.set(packet, () => this.#context.validate(built).valid);
        }
        return packet;
      }, input.signal, 60000);
      return { enabled: true, context };
    } catch (error) { if (error instanceof AgentOperationError) throw error; throw new AgentOperationError('context-failed'); }
  }

  afterTurn(input: CaptureInput): AfterTurnResult {
    this.#open();
    if (this.#readOnly || !this.runtime.captureEnabled) return { enabled: false, records: [], jobs: [], scheduling: 'disabled' };
    return this.runtime.memory.atomic(() => {
      const capture = this.runtime.capture({ ...input, trust: input.trust ?? this.#trust });
      if (!capture.records.length) return { ...capture, jobs: [], scheduling: 'empty' as const };
      if (!this.runtime.recallEnabled) return { ...capture, jobs: [], scheduling: 'recall-disabled' as const };
      const eligible = capture.records.filter(record => this.runtime.memory.isEligible(record.id));
      // Per-message jobs keep replay identity stable when callers append transcript batches.
      const jobs = eligible.map(record => this.runtime.enqueue({ kind: 'observe', sourceIds: [record.id] }));
      return { ...capture, jobs, scheduling: jobs.length ? 'queued' as const : 'ineligible' as const };
    });
  }
  afterTranscript(input: Omit<CaptureInput, 'messages'> & { adapter: 'generic' | 'codex' | 'claude'; jsonl: string }): AfterTurnResult {
    this.#open();
    if (this.#readOnly || !this.runtime.captureEnabled) return { enabled: false, records: [], jobs: [], scheduling: 'disabled' };
    const { jsonl, ...capture } = input;
    return this.afterTurn({ ...capture, messages: parseTranscriptJsonl(input.adapter, jsonl) });
  }
  afterEvents(input: AgentEventInput): AfterTurnResult {
    this.#open();
    if (this.#readOnly || !this.runtime.captureEnabled) return { enabled: false, records: [], jobs: [], scheduling: 'disabled' };
    return this.afterTurn({ adapter: input.adapter, sessionId: `sdk:${input.sessionId}`, trust: input.trust, visibility: input.visibility, messages: messagesFromAgentEvents(input) });
  }
  forgetSource(sourceId: string): { deletedIds: string[] } {
    this.#open(); if (this.#readOnly) throw new Error('Memory agent is read-only.');
    return this.runtime.forgetSource(sourceId);
  }

  drain(options: { signal?: AbortSignal } = {}): Promise<AgentDrainReport> {
    this.#open();
    if (this.#draining) return this.#draining;
    if (this.#background) throw new Error('Background drain owns this agent; stop it before manual drain.');
    return this.#drain(options.signal);
  }
  #drain(signal?: AbortSignal, remaining?: { calls: number; bytes: number }): Promise<AgentDrainReport> {
    if (this.#draining) return this.#draining;
    if (this.#readOnly || !this.runtime.captureEnabled || !this.runtime.recallEnabled) return Promise.resolve(emptyDrain('disabled'));
    if (!this.#proposer) return Promise.resolve(emptyDrain('no-proposer'));
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Invalid abort signal.');
    const controller = new AbortController(); this.#drainController = controller;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const run = (async (): Promise<AgentDrainReport> => {
      const report = await this.runtime.runJobs({ maxInputBytes: 262144, ...this.#budgets, proposer: this.#proposer!, signal: controller.signal,
        ...(remaining ? { maxCalls: Math.min(this.#budgets.maxCalls ?? 4, remaining.calls), maxTotalInputBytes: Math.min(this.#budgets.maxTotalInputBytes ?? 131072, remaining.bytes) } : {}) });
      return { ...report, status: 'processed' };
    })();
    this.#draining = run;
    const cleanup = () => { signal?.removeEventListener('abort', abort); if (this.#draining === run) { this.#draining = undefined; this.#drainController = undefined; } };
    void run.then(cleanup, cleanup);
    return run;
  }

  start(options: BackgroundOptions = {}): AgentBackground {
    this.#open();
    if (this.#background) return this.#background;
    if (this.#draining) throw new Error('A manual drain is in progress.');
    const intervalMs = int(options.intervalMs, 1000, 10, 60000), maxCycles = int(options.maxCycles, 60, 1, 10000), duration = int(options.maxDurationMs, 60000, 1, 3_600_000);
    const maxCalls = int(options.maxCalls, 16, 0, 10000), maxBytes = int(options.maxTotalInputBytes, 1_048_576, 0, 67_108_864);
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new TypeError('Invalid abort signal.');
    const controller = new AbortController();
    const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
    const done = Promise.resolve().then(async (): Promise<BackgroundReport> => {
      const report: BackgroundReport = { cycles: 0, processed: 0, modelCalls: 0, inputBytes: 0, completed: 0, failed: 0, reason: 'completed' };
      const timer = setTimeout(abort, duration);
      try {
        while (report.cycles < maxCycles) {
          if (controller.signal.aborted) { report.reason = 'cancelled'; break; }
          if (report.modelCalls >= maxCalls || report.inputBytes >= maxBytes) { report.reason = 'budget'; break; }
          const batch = await this.#drain(controller.signal, { calls: maxCalls - report.modelCalls, bytes: maxBytes - report.inputBytes });
          if (batch.status !== 'processed') { report.reason = batch.status; break; }
          report.cycles++; report.processed += batch.processed; report.modelCalls += batch.modelCalls; report.inputBytes += batch.inputBytes; report.completed += batch.completed.length; report.failed += batch.failed.length;
          if (controller.signal.aborted) { report.reason = 'cancelled'; break; }
          if (report.cycles < maxCycles) await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(wait); controller.signal.removeEventListener('abort', finish); resolve(); };
            const wait = setTimeout(finish, intervalMs); controller.signal.addEventListener('abort', finish, { once: true }); if (controller.signal.aborted) finish();
          });
        }
      } catch { report.reason = controller.signal.aborted ? 'cancelled' : 'failed'; }
      finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
      return report;
    });
    const handle: AgentBackground = Object.freeze({ done, stop: () => { abort(); return done; } });
    this.#background = handle;
    void done.then(() => { if (this.#background === handle) this.#background = undefined; });
    return handle;
  }
  async stop(): Promise<BackgroundReport | undefined> {
    this.#drainController?.abort(); const report = await this.#background?.stop(); await this.#draining?.catch(() => undefined); return report;
  }
  async close(): Promise<void> { this.#closed = true; await this.stop(); await this.#draining?.catch(() => undefined); }

  prepareAction(input: AgentActionInput): AgentAction {
    this.#open(); identifier.parse(input.name);
    // Reuse the kernel's finite, acyclic, depth/node-bounded portable JSON contract.
    const args = metadata({ args: input.args }).args;
    const encoded = JSON.stringify(args); if (Buffer.byteLength(encoded) > 16384) throw new Error('Action arguments exceed 16 KiB.');
    const snapshot = JSON.parse(encoded) as AgentAction['args'];
    const key = hash({ name: input.name, args: snapshot });
    const action = freeze({ name: input.name, args: snapshot, readSet: this.maintenance.createReadSet({ memoryIds: input.memoryIds, actionKey: key, dependenciesComplete: input.dependenciesComplete, lifetimeMs: input.lifetimeMs, requireWatched: input.requireWatched }) });
    this.#actions.set(action, { key, used: false });
    return action;
  }
  async executeAction<T>(action: AgentAction, callback: (request: { name: string; args: AgentAction['args']; signal: AbortSignal }) => Promise<T>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    this.#open(); if (typeof callback !== 'function') throw new TypeError('An explicit host action is required.');
    const timeout = int(options.timeoutMs, 30000, 1, 3_600_000);
    try {
      return await bounded(signal => {
        this.#open(); const claim = this.#actions.get(action);
        if (!claim || claim.used || !this.maintenance.validateReadSet(action.readSet, claim.key).valid) throw new AgentOperationError('action-rejected');
        claim.used = true;
        // No await between evidence validation and invoking the host callback.
        return callback({ name: action.name, args: action.args, signal });
      }, options.signal, timeout);
    } catch (error) { if (error instanceof AgentOperationError) throw error; throw new AgentOperationError('host-failed'); }
  }

  async runTurn(input: RunTurnInput, respond: AgentResponder): Promise<RunTurnResult> {
    this.#write(); identifier.parse(input.sessionId); identifier.parse(input.turnId); query.parse(input.query);
    if (typeof respond !== 'function') throw new TypeError('An explicit host responder is required.');
    const text = z.string().min(1).refine(value => !!value.trim() && !value.includes('\0') && Buffer.byteLength(value) <= 65536).parse(input.input);
    const timeout = int(input.timeoutMs, 300000, 1, 3_600_000);
    const visibility = z.enum(['private', 'workspace']).parse(input.visibility ?? 'private'), trust = z.enum(['untrusted', 'observed']).parse(input.trust ?? this.#trust);
    const identity = hash([input.sessionId, input.turnId]);
    const before = await this.beforeTurn({ query: input.query, maxTokens: input.maxTokens, taskId: input.taskId, requireWatched: input.requireWatched, signal: input.signal });
    const contextTicket = before.context.memoryIds.length ? this.maintenance.createReadSet({ memoryIds: before.context.memoryIds, actionKey: `agent:turn:${identity}`, dependenciesComplete: true }) : undefined;
    let response: string;
    try {
      response = await bounded(signal => {
        this.#write();
        if (this.#contextChecks.has(before.context) && !this.#contextChecks.get(before.context)!()) throw new AgentOperationError('context-failed');
        if (contextTicket && !this.maintenance.validateReadSet(contextTicket, `agent:turn:${identity}`).valid) throw new AgentOperationError('context-failed');
        try {
          // A fresh nonce makes a repeated idempotency key fail closed, even after restart.
          // The retained reservation contains hashes only, and no raw request or response.
          this.runtime.memory.store({ text: 'Host turn dispatch reserved. Automatic replay is blocked.', trust: 'untrusted', kind: 'observation', source: { uri: 'agent:turn-reservation' }, metadata: { runtimeType: 'agent-turn', advisory: false, inputHash: hash(text), identity, attempt: randomUUID() }, idempotencyKey: `agent-turn:${identity}` });
        } catch (error) {
          throw new AgentOperationError(error instanceof Error && error.message.includes('Idempotency') ? 'already-attempted' : 'reservation-failed');
        }
        return respond({ input: text, context: before.context, signal });
      }, input.signal, timeout);
    } catch (error) { if (error instanceof AgentOperationError) throw error; throw new AgentOperationError('host-failed'); }
    try {
      if (typeof response !== 'string') throw new Error();
      this.#write(); if (input.signal?.aborted) throw new Error();
      const after = this.afterTurn({ sessionId: input.sessionId, adapter: 'generic', visibility, trust, messages: [{ id: `${identity}:user`, role: 'user', text }, { id: `${identity}:assistant`, role: 'assistant', text: response }] });
      return { response, before, after };
    } catch { throw new AgentOperationError('capture-failed', typeof response === 'string' ? response : undefined); }
  }
}
