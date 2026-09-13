import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

const short = (n: number) => z.string().min(1).refine(s => !s.includes('\0') && Buffer.byteLength(s) <= n);
const eventSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('remember'), key: short(256), text: short(65536) }).strict(),
  z.object({ operation: z.literal('correct'), key: short(256), text: short(65536) }).strict(),
  z.object({ operation: z.literal('forget'), key: short(256) }).strict(),
  z.object({ operation: z.literal('task'), id: short(256), query: short(4096),
    answers: z.array(short(8192)).min(1).max(32), action: z.enum(['act', 'abstain']),
    evidenceKeys: z.array(short(256)).max(128), staleAnswers: z.array(short(8192)).max(32).default([]),
  }).strict(),
]);
const datasetSchema = z.object({
  protocol: z.literal('mnemosyne-agent-benchmark-v1'), name: short(256), revision: short(256),
  split: z.enum(['development', 'test']),
  episodes: z.array(z.object({ id: short(256), category: short(256), events: z.array(eventSchema).min(1).max(512) }).strict()).min(1).max(128),
}).strict();
export type AgentBenchmarkDataset = z.input<typeof datasetSchema>;
type ParsedDataset = z.output<typeof datasetSchema>;
export type BenchmarkMemoryEvent = Exclude<ParsedDataset['episodes'][number]['events'][number], { operation: 'task' }>;
export interface BenchmarkContext { text: string; sourceKeys: string[] }
export interface BenchmarkSession {
  apply(event: BenchmarkMemoryEvent, signal: AbortSignal): void | Promise<void>;
  context(request: { query: string; maxContextUnits: number; signal: AbortSignal }): BenchmarkContext | Promise<BenchmarkContext>;
  close(): void | Promise<void>;
}
export interface BenchmarkCondition {
  id: string;
  revision: string;
  /** Create a new isolated instance. No evaluation labels or condition name reach the reader. */
  create(request: { seed: number; maxContextUnits: number; signal: AbortSignal }): BenchmarkSession | Promise<BenchmarkSession>;
}
export interface BenchmarkReaderRequest {
  query: string;
  context: string;
  sourceKeys: string[];
  seed: number;
  maxOutputTokens: number;
  signal: AbortSignal;
}
export interface BenchmarkAnswer {
  answer: string;
  action: 'act' | 'abstain';
  citations: string[];
  usage?: { inputTokens: number; outputTokens: number };
}
export interface BenchmarkReader {
  id: string;
  revision: string;
  /** Caller-attested identity/mode, not independently authenticated by the harness. */
  mode: 'model' | 'scripted';
  run(request: BenchmarkReaderRequest): Promise<BenchmarkAnswer>;
}
export interface AgentBenchmarkOptions {
  reader: BenchmarkReader;
  conditions: BenchmarkCondition[];
  trials?: number;
  seed?: number;
  maxContextUnits?: number;
  maxOutputTokens?: number;
  /** Reader calls are bounded globally, and include failed calls. */
  maxReaderCalls?: number;
  timeoutMs?: number;
  operationTimeoutMs?: number;
  signal?: AbortSignal;
  /** Defaults to exact UTF-8 byte accounting, deliberately not a claimed tokenizer. */
  countContext?: (text: string) => number;
  accountingId?: string;
  includeResponses?: boolean;
}
export interface BenchmarkAttempt {
  episodeId: string; taskId: string; category: string; trial: number; condition: string;
  status: 'completed' | 'memory-error' | 'reader-error' | 'budget-exhausted' | 'cancelled';
  success: boolean; groundedSuccess: boolean; answerCorrect: boolean; actionCorrect: boolean;
  unsupportedAnswer: boolean | null; staleAction: boolean | null;
  citationsValid: boolean | null; evidenceCovered: boolean | null;
  contextUnits: number; contextBytes: number; latencyMs: number;
  readerUsage?: { inputTokens: number; outputTokens: number };
  answerSha256?: string; response?: BenchmarkAnswer;
}
export interface AgentBenchmarkReport {
  kind: 'matched agent-memory experiment'; protocol: 'mnemosyne-agent-benchmark-v1';
  dataset: { name: string; revision: string; split: string; sha256: string; episodes: number; tasks: number };
  reader: { id: string; revision: string; mode: 'model' | 'scripted'; identity: 'caller-attested' };
  conditions: { id: string; revision: string }[];
  settings: { trials: number; seed: number; maxContextUnits: number; accountingId: string; maxOutputTokens: number; maxReaderCalls: number; timeoutMs: number; operationTimeoutMs: number };
  readerCalls: number; complete: boolean; durationMs: number; attempts: BenchmarkAttempt[];
  cleanupErrors: { episodeId: string; trial: number; condition: string }[];
  summaries: Record<string, BenchmarkSummary>;
  limitations: string[];
}
export interface BenchmarkSummary {
  attempts: number; completed: number; errors: number; successes: number; successRate: number;
  answerAccuracy: number; actionAccuracy: number; groundedSuccessRate: number;
  unsupportedAnswerRate: number | null; staleActionRate: number | null;
  negativeTransferRate: number | null; positiveTransferRate: number | null;
  meanContextUnits: number; p50LatencyMs: number; p95LatencyMs: number;
  observedAnyTrialSuccessRate: number; allTrialsSuccessRate: number;
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const normalized = (s: string) => s.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
const positive = (value: number | undefined, fallback: number, maximum: number) => z.number().int().min(1).max(maximum).parse(value ?? fallback);
const answerSchema = z.object({ answer: z.string().max(65536), action: z.enum(['act', 'abstain']), citations: z.array(short(256)).max(128),
  usage: z.object({ inputTokens: z.number().int().nonnegative().max(10000000), outputTokens: z.number().int().nonnegative().max(10000000) }).strict().optional(),
}).strict();

/** Shared public boundary; malformed output errors never echo private model content. */
export function parseBenchmarkAnswer(value: unknown): BenchmarkAnswer {
  const parsed = answerSchema.safeParse(value);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > 131072) throw new Error('Reader returned an invalid or oversized answer.');
  return parsed.data;
}

/** Parses labels separately from runtime input; no execution is performed here. */
export function parseAgentBenchmark(input: unknown): ParsedDataset {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16_777_216) throw new Error('Benchmark dataset exceeds 16 MiB or is not JSON.');
  const dataset = datasetSchema.parse(JSON.parse(raw) as unknown);
  const episodes = new Set<string>();
  for (const episode of dataset.episodes) {
    if (episodes.has(episode.id)) throw new Error('Duplicate episode identity.');
    episodes.add(episode.id);
    const alive = new Set<string>(), ever = new Set<string>(), tasks = new Set<string>();
    for (const event of episode.events) {
      if (event.operation === 'remember') {
        if (ever.has(event.key)) throw new Error('Repeated source identity; use correction or a distinct source.');
        alive.add(event.key); ever.add(event.key);
      } else if (event.operation === 'correct' || event.operation === 'forget') {
        if (!alive.has(event.key)) throw new Error('Mutation references a missing source.');
        if (event.operation === 'forget') alive.delete(event.key);
      } else {
        if (tasks.has(event.id)) throw new Error('Duplicate task identity in episode.');
        tasks.add(event.id);
        if (new Set(event.evidenceKeys).size !== event.evidenceKeys.length || event.evidenceKeys.some(key => !alive.has(key))) throw new Error('Task evidence must reference distinct current sources.');
        if (event.action === 'abstain' && event.evidenceKeys.length) throw new Error('Abstention tasks cannot require affirmative evidence.');
      }
    }
    if (!tasks.size) throw new Error('Every episode requires a task.');
  }
  return dataset;
}

function summarize(attempts: BenchmarkAttempt[], condition: string): BenchmarkSummary {
  const own = attempts.filter(a => a.condition === condition), done = own.filter(a => a.status === 'completed');
  const baseline = new Map(attempts.filter(a => a.condition === 'no-memory').map(a => [JSON.stringify([a.episodeId, a.taskId, a.trial]), a]));
  const pairs = own.map(a => [a, baseline.get(JSON.stringify([a.episodeId, a.taskId, a.trial]))] as const).filter((p): p is readonly [BenchmarkAttempt, BenchmarkAttempt] => !!p[1] && p[0].status === 'completed' && p[1].status === 'completed');
  const referenceSuccess = pairs.filter(([, b]) => b.success), referenceFailure = pairs.filter(([, b]) => !b.success);
  const latencies = done.map(a => a.latencyMs).sort((a, b) => a - b);
  const percentile = (p: number) => latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] ?? 0;
  const groups = new Map<string, BenchmarkAttempt[]>();
  for (const item of own) { const key = JSON.stringify([item.episodeId, item.taskId]); groups.set(key, [...(groups.get(key) ?? []), item]); }
  return { attempts: own.length, completed: done.length, errors: own.length - done.length,
    successes: own.filter(a => a.success).length, successRate: own.length ? own.filter(a => a.success).length / own.length : 0,
    answerAccuracy: own.length ? own.filter(a => a.answerCorrect).length / own.length : 0,
    actionAccuracy: own.length ? own.filter(a => a.actionCorrect).length / own.length : 0,
    groundedSuccessRate: own.length ? own.filter(a => a.groundedSuccess).length / own.length : 0,
    unsupportedAnswerRate: done.length ? done.filter(a => a.unsupportedAnswer).length / done.length : null,
    staleActionRate: done.length ? done.filter(a => a.staleAction).length / done.length : null,
    negativeTransferRate: referenceSuccess.length ? referenceSuccess.filter(([a]) => !a.success).length / referenceSuccess.length : null,
    positiveTransferRate: referenceFailure.length ? referenceFailure.filter(([a]) => a.success).length / referenceFailure.length : null,
    meanContextUnits: own.length ? own.reduce((n, a) => n + a.contextUnits, 0) / own.length : 0,
    p50LatencyMs: percentile(0.5), p95LatencyMs: percentile(0.95),
    observedAnyTrialSuccessRate: groups.size ? [...groups.values()].filter(xs => xs.some(a => a.success)).length / groups.size : 0,
    allTrialsSuccessRate: groups.size ? [...groups.values()].filter(xs => xs.every(a => a.success)).length / groups.size : 0 };
}

/** One shared reader, isolated condition/episode/trial state, equal budgets and rotated order. */
export async function runAgentBenchmark(input: unknown, options: AgentBenchmarkOptions): Promise<AgentBenchmarkReport> {
  const dataset = parseAgentBenchmark(input);
  const reader = options.reader;
  short(256).parse(reader?.id); short(256).parse(reader?.revision); z.enum(['model', 'scripted']).parse(reader.mode);
  if (typeof reader.run !== 'function' || !Array.isArray(options.conditions) || options.conditions.length < 2 || options.conditions.length > 8) throw new Error('Supply one reader and two to eight conditions.');
  const names = new Set<string>();
  const conditions = options.conditions.map(c => {
    short(256).parse(c.id); short(256).parse(c.revision);
    if (names.has(c.id) || typeof c.create !== 'function') throw new Error('Conditions require unique identities and factories.');
    names.add(c.id); return { ...c };
  });
  if (!names.has('no-memory')) throw new Error('Include the no-memory reference condition.');
  const settings = {
    trials: positive(options.trials, 3, 20), seed: z.number().int().min(0).max(2147483647).parse(options.seed ?? 1),
    maxContextUnits: positive(options.maxContextUnits, 8192, 262144), accountingId: short(256).parse(options.accountingId ?? 'utf8-bytes-v1'),
    maxOutputTokens: positive(options.maxOutputTokens, 512, 16384), maxReaderCalls: positive(options.maxReaderCalls, 1000, 10000),
    timeoutMs: positive(options.timeoutMs, 60000, 3600000), operationTimeoutMs: positive(options.operationTimeoutMs, 10000, 300000),
  };
  if (options.countContext && (!options.accountingId || typeof options.countContext !== 'function')) throw new Error('Custom accounting requires a named counter.');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new Error('Invalid cancellation signal.');
  const count = options.countContext ?? ((text: string) => Buffer.byteLength(text));
  const taskCount = dataset.episodes.reduce((n, e) => n + e.events.filter(v => v.operation === 'task').length, 0);
  if (taskCount * settings.trials * conditions.length > 10000) throw new Error('Benchmark exceeds 10000 planned attempts.');
  const started = performance.now(), deadline = started + settings.timeoutMs;
  let readerCalls = 0;
  const attempts: BenchmarkAttempt[] = [];
  const cleanupErrors: AgentBenchmarkReport['cleanupErrors'] = [];
  const shutdown = new AbortController();
  const globalSignal = options.signal ? AbortSignal.any([options.signal, shutdown.signal]) : shutdown.signal;
  async function bounded<T>(work: (signal: AbortSignal) => T | Promise<T>, cleanup = false): Promise<T> {
    if (!cleanup && (globalSignal.aborted || performance.now() >= deadline)) throw new Error('Evaluation stopped.');
    const control = new AbortController();
    const signal = cleanup ? control.signal : AbortSignal.any([control.signal, globalSignal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { if (signal.aborted) throw new Error('Evaluation stopped.'); return work(signal); }),
        new Promise<never>((_, reject) => {
          stop = () => reject(new Error('Evaluation stopped.'));
          signal.addEventListener('abort', stop, { once: true });
          timer = setTimeout(() => control.abort(), cleanup ? 1000 : Math.max(1, Math.min(settings.operationTimeoutMs, deadline - performance.now())));
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); if (stop) signal.removeEventListener('abort', stop); control.abort(); }
  }
  for (let trial = 0; trial < settings.trials; trial++) {
    for (let episodeIndex = 0; episodeIndex < dataset.episodes.length; episodeIndex++) {
      const episode = dataset.episodes[episodeIndex];
      const offset = (trial + episodeIndex + settings.seed) % conditions.length;
      const ordered = [...conditions.slice(offset), ...conditions.slice(0, offset)];
      for (const condition of ordered) {
        let session: BenchmarkSession | undefined, memoryFailed = false;
        const trialSeed = (settings.seed + trial) % 2147483648;
        try {
          try {
            if (readerCalls >= settings.maxReaderCalls) throw new Error('Reader budget exhausted.');
            session = await bounded(async signal => {
              const opened = await condition.create({ seed: trialSeed, maxContextUnits: settings.maxContextUnits, signal });
              if (signal.aborted) { await opened.close(); throw new Error('Late memory factory.'); }
              return opened;
            });
            if (!session || typeof session.apply !== 'function' || typeof session.context !== 'function' || typeof session.close !== 'function') throw new Error('Invalid memory session.');
          } catch { memoryFailed = true; }
          for (const event of episode.events) {
            if (event.operation !== 'task') {
              if (!memoryFailed && readerCalls < settings.maxReaderCalls) try { await bounded(signal => session!.apply(structuredClone(event), signal)); } catch { memoryFailed = true; }
              continue;
            }
            const at = performance.now();
            const row: BenchmarkAttempt = { episodeId: episode.id, taskId: event.id, category: episode.category, trial,
              condition: condition.id, status: 'memory-error', success: false, groundedSuccess: false, answerCorrect: false, actionCorrect: false,
              unsupportedAnswer: null, staleAction: null, citationsValid: null, evidenceCovered: null,
              contextUnits: 0, contextBytes: 0, latencyMs: 0 };
            try {
              if (globalSignal.aborted) { row.status = 'cancelled'; continue; }
              if (performance.now() >= deadline || readerCalls >= settings.maxReaderCalls) { row.status = 'budget-exhausted'; continue; }
              if (memoryFailed) continue;
              const context = await bounded(signal => session!.context({ query: event.query, maxContextUnits: settings.maxContextUnits, signal }));
              z.object({ text: z.string().max(1048576), sourceKeys: z.array(short(256)).max(1024) }).strict().parse(context);
              const envelope = JSON.stringify(context);
              row.contextBytes = Buffer.byteLength(envelope); row.contextUnits = count(envelope);
              if (!Number.isSafeInteger(row.contextUnits) || row.contextUnits < 0 || row.contextUnits > settings.maxContextUnits || row.contextBytes > 1048576) throw new Error('Context budget exceeded.');
              row.status = 'reader-error';
              const response = parseBenchmarkAnswer(await bounded(signal => {
                readerCalls++;
                return reader.run({ query: event.query, context: context.text, sourceKeys: [...context.sourceKeys], seed: trialSeed, maxOutputTokens: settings.maxOutputTokens, signal });
              }));
              if (Buffer.byteLength(JSON.stringify(response)) > 131072 || (response.usage?.outputTokens ?? 0) > settings.maxOutputTokens) throw new Error('Reader output budget exceeded.');
              row.status = 'completed';
              row.answerCorrect = event.answers.some(s => normalized(s) === normalized(response.answer));
              row.actionCorrect = response.action === event.action;
              row.citationsValid = response.citations.every(key => context.sourceKeys.includes(key) && event.evidenceKeys.includes(key));
              row.evidenceCovered = event.evidenceKeys.every(key => response.citations.includes(key));
              row.unsupportedAnswer = response.action === 'act' && (!row.answerCorrect || !row.citationsValid || !row.evidenceCovered);
              row.staleAction = response.action === 'act' && event.staleAnswers.some(s => normalized(s) === normalized(response.answer));
              row.success = row.answerCorrect && row.actionCorrect;
              row.groundedSuccess = row.success && row.citationsValid && row.evidenceCovered;
              row.answerSha256 = digest(JSON.stringify(response));
              if (response.usage) row.readerUsage = { ...response.usage };
              if (options.includeResponses) row.response = response;
            } catch { if (globalSignal.aborted) row.status = 'cancelled'; else if (performance.now() >= deadline) row.status = 'budget-exhausted'; }
            finally { row.latencyMs = performance.now() - at; attempts.push(row); }
          }
        } finally {
          if (session) try { await bounded(() => session!.close(), true); } catch { cleanupErrors.push({ episodeId: episode.id, trial, condition: condition.id }); }
        }
      }
    }
  }
  shutdown.abort();
  return { kind: 'matched agent-memory experiment', protocol: dataset.protocol,
    dataset: { name: dataset.name, revision: dataset.revision, split: dataset.split, sha256: digest(JSON.stringify(dataset)), episodes: dataset.episodes.length, tasks: taskCount },
    reader: { id: reader.id, revision: reader.revision, mode: reader.mode, identity: 'caller-attested' },
    conditions: conditions.map(c => ({ id: c.id, revision: c.revision })), settings, readerCalls,
    complete: !cleanupErrors.length && attempts.length === taskCount * settings.trials * conditions.length && attempts.every(a => a.status === 'completed'),
    durationMs: performance.now() - started, attempts, cleanupErrors,
    summaries: Object.fromEntries(conditions.map(c => [c.id, summarize(attempts, c.id)])),
    limitations: [
      'Exact normalized answer matching and declared evidence/action labels; not open-ended semantic correctness or an official benchmark score.',
      'Reader/condition identities and reported token usage are caller-attested. Factories must isolate state and callbacks must honor cancellation.',
      'One reader call per task with equal requested limits; external condition/provider compute cannot be enforced by this in-process harness.',
      'Order is rotated, not randomized independently; latency includes context preparation and reader time, excludes source ingestion.',
      'Scripted readers verify mechanisms only. Positive/negative transfer use paired completed attempts relative to no-memory; errors remain in overall success denominators.',
      'Any-trial success is the observed proportion of tasks with a successful trial, not the unbiased pass@k estimator.',
      'Task success and transfer depend on answer/action correctness only; source grounding is reported separately so no-memory can succeed without citations.',
    ],
  };
}
