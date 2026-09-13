#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { MemoryRuntime, type EnqueueInput, type RunJobsOptions, type SkillDefinition, type SkillTrialInput } from '../runtime/index.js';
import { LocalSourceConnector, readLocalText, type LocalSourceOptions } from '../connectors/index.js';
import { createCompatibleEmbedder, createCompatibleProposer, createCompatibleBenchmarkReader, createCompatibleAgentResponder } from '../providers/index.js';
import { startMemoryHttp } from '../http/index.js';
import { MemoryBranches, type BranchChange } from '../branches/index.js';
import { MemoryRelations, type EntityInput } from '../relations/index.js';
import { createLocalMemory, LOCAL_SNAPSHOT_LIMITS } from '../local/index.js';
import type { MemorySnapshot, StoreMemoryInput } from '../local/types.js';
import { serveMemoryStdio, VERSION } from '../mcp/server.js';
import { runMemoryDemo } from '../evaluation/demo.js';
import { requireExistingDatabase, runMigrationCommand } from './migration.js';
import { MemoryMaintenance } from '../maintenance/index.js';
import { parseJsonWithSpans } from '../migration/json-spans.js';
import { MemoryAgent } from '../agent/index.js';

const HELP = `Mnemosyne ${VERSION} — portable agent memory

  mnemosy demo                     Run a verified, isolated memory-engine demo
  mnemosy learning-demo            Run isolated capture-to-skill replay checks
  mnemosy evaluate --file FILE [--out FILE] [--limit 20] [--json JSON]
                   [--provider-config FILE]  Evaluate supplied LongMemEval v1 retrieval
  mnemosy benchmark-agent --file FILE --provider-config FILE --out FILE [--json JSON]
  mnemosy operations --action backup --db DATABASE --out BUNDLE
  mnemosy operations --action verify --file BUNDLE
  mnemosy operations --action restore --file BUNDLE --out NEW_DATABASE
                   Run a matched reader experiment; explicit configured model calls
  mnemosy agent [scope] --action context|turn|capture-events|work|status [--json JSON]
  mnemosy agent [scope] --action turn --session NAME --key TURN_ID --text TEXT
                   --provider-config FILE [--tokens 4096]
  mnemosy demo --record FILE       Save real demo evidence as JSON
  mnemosy mcp [scope]              Start the MCP stdio server
  mnemosy store [scope] --text TEXT --source URI [--share]
  mnemosy recall [scope] --query TEXT
  mnemosy context [scope] --query TEXT [--tokens 4096]
  mnemosy inspect [scope] [--id ID] [--history]
  mnemosy correct [scope] --id ID --text TEXT --source URI --reason TEXT
  mnemosy forget [scope] --id ID --confirm
  mnemosy export [scope] --out FILE
  mnemosy import [scope] --file FILE
  mnemosy migrate --file manifest.json --out plan.json
  mnemosy migrate --file export.json --profile mem0-array --source-store NAME
                   --source-owner OWNER --workspace NAME --agent NAME --out plan.json
  mnemosy migrate --action apply --file plan.json --db FILE --batch NAME --confirm
  mnemosy migrate [scope] --action inspect --batch NAME
  mnemosy migrate [scope] --action source --batch NAME --id SOURCE_ID [--json JSON]
  mnemosy migrate [scope] --action rollback --batch NAME --revision RECEIPT_HASH --confirm
  mnemosy migrate [scope] --action forget --id SOURCE_ID --confirm
  mnemosy health [scope] --action scan|watch|check|recall [--id ID] [--json JSON]
  mnemosy serve [scope] --token-file FILE [--port 8765]
  mnemosy capture [scope] --file FILE --adapter text|generic|codex|claude
                   [--session NAME] [--trust observed] [--watch --interval 1000]
  mnemosy observe [scope] --json '{"sourceIds":["ID"]}'
  mnemosy jobs [scope]             Inspect durable job states
  mnemosy run-jobs [scope] --provider-config FILE [--json '{"maxCalls":4}']
  mnemosy index [scope] --provider-config FILE
  mnemosy model [scope] --action get|context|refresh --key NAME [--json JSON]
  mnemosy skill [scope] --action create|get|trial|retire --json JSON
  mnemosy branch [scope] --action create|stage|preview|merge --json JSON
  mnemosy entity [scope] --action create|resolve|relate|traverse --json JSON

  Provider file: {"baseUrl":"http://127.0.0.1:11434/v1","model":"chosen-model",
                  "dimensions":768,"revision":"v1","apiKeyEnv":"NAMED_ENV"}
  Only baseUrl and model are mandatory; index/hybrid also require dimensions.
  Provider configuration is explicit; no provider or paid API is selected by default.
  model refresh needs --provider-config and --json '{"sourceIds":["ID"]}'.
  skill trial JSON: {"id":"SKILL_ID","validation":{"passed":true,
      "evidence":"Observed trial result","verifier":"controller","taskId":"trial-1",
      "prerequisitesSatisfied":true}}; assertions remain controller supplied.
  branch stage JSON: {"id":"ID","changes":[{"operation":"add","input":{...}}]}.
  serve: token file or explicitly set MNEMOSYNE_TOKEN; tokens never go in argv/output.
         --provider-config optionally enables hybrid recall; bind stays on loopback.
  capture: only the named regular UTF-8 file; no host discovery or installed scheduler.
           JSONL sync defers an incomplete final row; unknown binaries need SDK extraction.
  migrate: preview never opens a database. Saved plans contain a complete redacted review,
           use private permissions, never overwrite files, and are limited to 4 MiB.
           One-file mode requires --profile, --source-store and --source-owner.
           --assume-missing-owner explicitly assigns missing owners to that selected owner;
           --acknowledge-partial accepts unknown/partial exports or excluded owners.
           --collection is for legacy Mnemosyne; --logical-path is required for Markdown;
           --qdrant-text-field selects a custom Qdrant payload field.
           Imported --trust defaults to untrusted; observed is an explicit provenance choice.
           Shortcut settings cannot override a manifest or a saved plan during apply.

  Scope: --db FILE --workspace NAME --agent NAME (all required)
  Policies: --read-only blocks all direct memory mutations, including erasure.
            --no-capture blocks new writes; --no-recall blocks stored-state reads
            and source processing. store/import can run with --no-recall.
            Confirmed forget and migration rollback remain available with capture
            and recall disabled; erasure never returns stored source content.
            Invalid commands/actions and policy denials fail before opening SQLite.
            Isolated demo/evaluate commands do not accept restrictive policies.
            Migration preview accepts no policy flags; it opens no database.
  MCP/HTTP: all three policies configure server capabilities instead.
            --allow-destructive enables forget (disabled by default).
            --provider-config FILE explicitly enables hybrid recall
  Store: --kind fact|preference|decision|procedure|observation
         --trust untrusted|observed|verified (default observed)
         --evidence TEXT (required for controller-verified evidence)
  Queries: --limit 20; --include-untrusted opts into unreviewed evidence

The local engine uses SQLite and lexical search; no API key or Docker required.
Retrieved memories are evidence, never permission to execute an action.
`;

function required(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required. Run mnemosy --help for usage.`);
  return value;
}

function integer(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error('Numeric options must be positive integers.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`Numeric option must be between 1 and ${maximum}.`);
  return parsed;
}

function jsonInput(value?: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value ?? '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--json must contain an object.');
  return parsed as Record<string, unknown>;
}

type CliAccess = 'read' | 'write' | 'erase';
type CliValues = Record<string, string | boolean | undefined>;

// Every executable route needs an explicit policy. A write that reads existing
// sources (including replay or provider input) needs both capabilities. Privacy
// erasure needs neither capture nor recall, but still requires a writable policy
// and the command handler's explicit confirmation/destructive authorization.
const COMMAND_ACCESS: Readonly<Record<string, readonly CliAccess[]>> = {
  store: ['write'], import: ['write'],
  recall: ['read'], context: ['read'], inspect: ['read'], export: ['read'], jobs: ['read'],
  correct: ['read', 'write'], forget: ['erase'], capture: ['read', 'write'],
  observe: ['read', 'write'], 'run-jobs': ['read', 'write'], index: ['read', 'write'],
  // These routes enforce per-request policies and must accept valid combinations.
  mcp: [], serve: [],
  // Isolated evaluations create and read temporary memory, even without an output file.
  demo: ['read', 'write'], 'learning-demo': ['read', 'write'], evaluate: ['read', 'write'], 'benchmark-agent': ['read', 'write'],
};
const ACTION_ACCESS: Readonly<Record<string, { defaultAction?: string; actions: Readonly<Record<string, readonly CliAccess[]>> }>> = {
  agent: { defaultAction: 'context', actions: { context: ['read'], turn: ['read', 'write'], 'capture-events': ['read', 'write'], work: ['read', 'write'], status: ['read'] } },
  operations: { defaultAction: 'verify', actions: { backup: ['read', 'write'], verify: ['read'], restore: ['read', 'write'] } },
  model: { defaultAction: 'get', actions: { get: ['read'], context: ['read'], refresh: ['read', 'write'] } },
  skill: { actions: { create: ['read', 'write'], get: ['read'], trial: ['read', 'write'], retire: ['read', 'write'] } },
  branch: { actions: { create: ['read', 'write'], stage: ['read', 'write'], preview: ['read'], merge: ['read', 'write'] } },
  entity: { actions: { create: ['read', 'write'], resolve: ['read'], relate: ['read', 'write'], traverse: ['read'] } },
  health: { defaultAction: 'scan', actions: { scan: ['read'], recall: ['read'], watch: ['read', 'write'], check: ['read', 'write'] } },
  // The migration handler additionally checks action-specific flags and confirmation.
  // Preview reads supplied files only, and rejects all policy flags itself.
  migrate: { defaultAction: 'plan', actions: { plan: [], apply: ['read', 'write'], inspect: ['read'], source: ['read'], rollback: ['erase'], forget: ['erase'] } },
};

function validateCommandPolicy(command: string, values: CliValues): void {
  let access: readonly CliAccess[];
  let route = command;
  if (Object.hasOwn(ACTION_ACCESS, command)) {
    const policy = ACTION_ACCESS[command];
    const action = values.action ?? policy.defaultAction;
    if (typeof action !== 'string' || !Object.hasOwn(policy.actions, action)) {
      throw new Error(`${command} requires --action ${Object.keys(policy.actions).join('|')}.`);
    }
    access = policy.actions[action];
    route += ` ${action}`;
  } else {
    if (!Object.hasOwn(COMMAND_ACCESS, command)) throw new Error(`Unknown command: ${command}`);
    if (values.action !== undefined) throw new Error(`${command} does not support --action.`);
    access = COMMAND_ACCESS[command];
  }
  if ((access.includes('write') || access.includes('erase')) && values['read-only']) throw new Error(`${route}: memory mutations are disabled by --read-only.`);
  if (access.includes('write') && values['no-capture']) throw new Error(`${route}: memory writes are disabled by --no-capture.`);
  if (access.includes('read') && values['no-recall']) throw new Error(`${route}: stored-state reads are disabled by --no-recall.`);
}

function agentCommand(values: CliValues) {
  const action = String(values.action ?? 'context');
  if (values.watch && action !== 'work') throw new Error('--watch is only valid for agent work.');
  const shared = ['action', 'db', 'workspace', 'agent', 'read-only', 'no-capture', 'no-recall', 'json'];
  const allowed = [...shared, ...(action === 'context' ? ['query', 'tokens'] : action === 'turn' ? ['session', 'key', 'text', 'query', 'tokens', 'trust', 'share', 'provider-config'] : action === 'capture-events' ? ['session', 'file', 'adapter', 'trust', 'share'] : action === 'work' ? ['watch', 'provider-config'] : [])];
  if (Object.entries(values).some(([key, value]) => value !== undefined && !allowed.includes(key))) throw new Error('Unsupported option for this agent action.');
  const context = { requireWatched: z.boolean().optional(), taskId: z.string().min(1).max(160).optional() };
  const background = { intervalMs: z.number().int().min(10).max(60000).optional(), maxCycles: z.number().int().min(1).max(10000).optional(), maxDurationMs: z.number().int().min(1).max(3600000).optional(), maxCalls: z.number().int().min(0).max(10000).optional(), maxTotalInputBytes: z.number().int().min(0).max(67108864).optional() };
  const drain = { maxJobs: z.number().int().min(1).max(64).optional(), maxCalls: z.number().int().min(0).max(64).optional(), maxTotalInputBytes: z.number().int().min(0).max(4194304).optional(), maxInputBytes: z.number().int().min(1024).max(262144).optional(), maxOutputBytes: z.number().int().min(256).max(65536).optional(), timeoutMs: z.number().int().min(10).max(60000).optional(), leaseMs: z.number().int().min(1).max(300000).optional(), maxAttempts: z.number().int().min(1).max(10).optional() };
  const settings = action === 'context' ? z.object(context).strict().parse(jsonInput(values.json as string | undefined))
    : action === 'turn' ? z.object({ ...context, timeoutMs: z.number().int().min(1).max(300000).optional() }).strict().parse(jsonInput(values.json as string | undefined))
    : action === 'work' ? (values.watch ? z.object(background) : z.object(drain)).strict().parse(jsonInput(values.json as string | undefined))
    : z.object({}).strict().parse(jsonInput(values.json as string | undefined));
  if (action === 'context') required(values.query as string | undefined, '--query');
  if (action === 'turn') { required(values.session as string | undefined, '--session'); required(values.key as string | undefined, '--key'); required(values.text as string | undefined, '--text'); }
  if (action === 'capture-events') { required(values.session as string | undefined, '--session'); required(values.file as string | undefined, '--file'); if (!['codex', 'claude'].includes(String(values.adapter))) throw new Error('--adapter must be codex or claude.'); }
  if (values.trust !== undefined) z.enum(['observed', 'untrusted']).parse(values.trust);
  const jobBudgets = action === 'work' && !values.watch ? z.object(drain).strict().parse(settings) : undefined;
  if (jobBudgets?.leaseMs !== undefined && jobBudgets.leaseMs <= (jobBudgets.timeoutMs ?? 30000)) throw new Error('Lease must exceed the proposer timeout.');
  const provider = ['turn', 'work'].includes(action) ? providerConfig(required(values['provider-config'] as string | undefined, '--provider-config')) : undefined;
  return { action, settings, jobBudgets, provider };
}

function healthCommand(values: Record<string, string | boolean | undefined>) {
  const action = z.enum(['scan', 'watch', 'check', 'recall']).parse(values.action ?? 'scan');
  const shared = ['action', 'db', 'workspace', 'agent', 'read-only', 'no-capture', 'no-recall'];
  const allowed = [...shared, ...(action === 'recall' ? ['query', 'limit', 'json'] : action === 'scan' ? [] : ['id', 'json'])];
  if (Object.entries(values).some(([name, value]) => value !== undefined && !allowed.includes(name))) throw new Error('Unsupported option for this health action');
  if (values['no-recall']) throw new Error('Maintenance recall is disabled');
  if (['watch', 'check'].includes(action) && (values['read-only'] || values['no-capture'])) throw new Error('Health writes are disabled by current policy');
  const text = (bytes: number) => z.string().refine(value => !!value.trim() && !value.includes('\0') && Buffer.byteLength(value) <= bytes);
  const json = () => parseJsonWithSpans(Buffer.from(required(values.json as string | undefined, '--json')), { maxInputBytes: 65536, maxDepth: 8, maxNodes: 128 }).value;
  if (action === 'scan') return { action } as const;
  if (action === 'recall') return { action, input: { query: text(4096).parse(required(values.query as string | undefined, '--query')), limit: integer(values.limit as string | undefined, 20, 100), ...z.object({ requireWatched: z.boolean().optional() }).strict().parse(values.json === undefined ? {} : json()) } } as const;
  const memoryId = text(160).parse(required(values.id as string | undefined, '--id'));
  if (action === 'watch') return { action, input: { memoryId, ...z.object({ maxAgeMs: z.number().int().min(1).max(3650 * 86400_000), priority: z.number().int().min(0).max(100).optional() }).strict().parse(json()) } } as const;
  return { action, input: { memoryId, ...z.object({ expectedStateHash: z.string().regex(/^[a-f0-9]{64}$/), observation: z.object({ status: z.enum(['confirmed', 'changed', 'unavailable']), evidence: text(8192), verifier: text(512), sourceRevision: text(1024).optional() }).strict() }).strict().parse(json()) } } as const;
}

function providerConfig(path: string | undefined) {
  const configPath = required(path, '--provider-config');
  const schema = z.object({ baseUrl: z.string().min(1).max(2048), model: z.string().min(1).max(512), dimensions: z.number().int().min(1).max(65536).optional(), revision: z.string().min(1).max(512).optional(), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256).optional() }).strict();
  let config: z.infer<typeof schema>;
  try { config = schema.parse(JSON.parse(readLocalText(configPath, 16384))); }
  catch { throw new Error('Invalid provider configuration file; use only baseUrl, model, dimensions, revision and apiKeyEnv.'); }
  const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
  if (config.apiKeyEnv && (!apiKey?.trim() || apiKey.length > 4096 || /[\r\n]/.test(apiKey))) throw new Error('The explicitly named API key environment variable is missing or invalid.');
  return { ...config, ...(apiKey ? { apiKey } : {}) };
}

function configuredEmbedder(path: string | undefined) {
  const config = providerConfig(path);
  if (!config.dimensions) throw new Error('Embedding provider configuration requires dimensions.');
  return createCompatibleEmbedder({ ...config, dimensions: config.dimensions });
}

function signalController() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return { signal: controller.signal, dispose() { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); } };
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readSnapshot(path: string): MemorySnapshot {
  const maximum = LOCAL_SNAPSHOT_LIMITS.maxBytes;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('Snapshot must be a regular file.');
    if (stat.size > maximum) throw new Error('Snapshot exceeds the 32 MiB import limit.');
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > stat.size || fstatSync(fd).size !== stat.size) throw new Error('Snapshot changed during import; retry with a stable file.');
    return JSON.parse(buffer.subarray(0, size).toString('utf8')) as MemorySnapshot;
  } finally { closeSync(fd); }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    db: { type: 'string' }, workspace: { type: 'string' }, agent: { type: 'string' },
    text: { type: 'string' }, source: { type: 'string' }, query: { type: 'string' },
    id: { type: 'string' }, kind: { type: 'string' }, trust: { type: 'string' },
    evidence: { type: 'string' }, reason: { type: 'string' }, limit: { type: 'string' },
    tokens: { type: 'string' }, out: { type: 'string' }, file: { type: 'string' },
    share: { type: 'boolean' }, confirm: { type: 'boolean' }, history: { type: 'boolean' },
    record: { type: 'string' }, 'read-only': { type: 'boolean' },
    'allow-destructive': { type: 'boolean' }, 'include-untrusted': { type: 'boolean' },
    'provider-config': { type: 'string' }, 'token-file': { type: 'string' }, port: { type: 'string' },
    json: { type: 'string' }, action: { type: 'string' }, key: { type: 'string' },
    adapter: { type: 'string' }, session: { type: 'string' }, mime: { type: 'string' },
    watch: { type: 'boolean' }, interval: { type: 'string' },
    'no-capture': { type: 'boolean' }, 'no-recall': { type: 'boolean' },
    batch: { type: 'string' }, revision: { type: 'string' },
    profile: { type: 'string' }, 'source-store': { type: 'string' }, 'source-owner': { type: 'string' },
    'assume-missing-owner': { type: 'boolean' }, 'acknowledge-partial': { type: 'boolean' },
    collection: { type: 'string' }, 'logical-path': { type: 'string' }, 'qdrant-text-field': { type: 'string' },
  } });
  if (values.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (values.help || !positionals.length) { process.stdout.write(HELP); return; }
  if (positionals.length !== 1) throw new Error('Specify exactly one command.');
  const command = positionals[0];
  validateCommandPolicy(command, values);
  if (command === 'migrate') { runMigrationCommand(values); return; }
  if (command === 'operations') {
    const action = values.action ?? 'verify';
    const allowed = ['action', 'json', 'read-only', 'no-capture', 'no-recall', ...(action === 'backup' ? ['db', 'out'] : action === 'restore' ? ['file', 'out'] : ['file'])];
    if (Object.entries(values).some(([key, value]) => value !== undefined && !allowed.includes(key))) throw new Error('Operations work on a whole database; scoped and unrelated options are unsupported.');
    const limits = z.object({ maxBytes: z.number().int().min(4096).max(4294967296).optional(), timeoutMs: z.number().int().min(1).max(3600000).optional() }).strict().parse(jsonInput(values.json));
    const { backupLocalDatabase, verifyLocalBackup, restoreLocalBackup } = await import('../operations/index.js');
    const stop = signalController();
    try {
      if (action === 'backup') print(await backupLocalDatabase({ ...limits, sourcePath: required(values.db, '--db'), backupPath: required(values.out, '--out'), signal: stop.signal }));
      else if (action === 'restore') print(await restoreLocalBackup({ ...limits, backupPath: required(values.file, '--file'), targetPath: required(values.out, '--out'), signal: stop.signal }));
      else print(await verifyLocalBackup({ ...limits, backupPath: required(values.file, '--file'), signal: stop.signal }));
    } finally { stop.dispose(); }
    return;
  }
  if (command === 'benchmark-agent') {
    const config = providerConfig(required(values['provider-config'], '--provider-config'));
    const revision = required(config.revision, 'provider revision');
    const settings = z.object({ trials: z.number().int().min(1).max(20).optional(), seed: z.number().int().nonnegative().max(2147483647).optional(), maxContextUnits: z.number().int().min(128).max(262144).optional(), maxOutputTokens: z.number().int().min(1).max(16384).optional(), maxReaderCalls: z.number().int().min(1).max(10000).optional(), timeoutMs: z.number().int().min(1).max(3600000).optional(), operationTimeoutMs: z.number().int().min(1).max(300000).optional(), includeResponses: z.boolean().optional() }).strict().parse(jsonInput(values.json));
    const path = resolve(required(values.out, '--out'));
    // Reserve the report before any provider call; never spend then discover an output collision.
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const stop = signalController();
    try {
      const { runAgentBenchmark, noMemoryCondition, recentHistoryCondition, lexicalMemoryCondition, adaptiveMemoryCondition } = await import('../evaluation/index.js');
      const report = await runAgentBenchmark(readLocalText(required(values.file, '--file'), 16_777_216), { ...settings, reader: createCompatibleBenchmarkReader({ ...config, revision }), conditions: [noMemoryCondition(), recentHistoryCondition(), lexicalMemoryCondition(), adaptiveMemoryCondition()], signal: stop.signal });
      writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`);
      if (!report.complete) process.exitCode = 1;
      print({ file: path, complete: report.complete, readerCalls: report.readerCalls, summaries: report.summaries });
    } finally { closeSync(fd); stop.dispose(); }
    return;
  }
  if (command === 'evaluate') {
    const settings = jsonInput(values.json);
    if (['embedder', 'signal', 'tempParent'].some(key => key in settings)) throw new Error('Evaluation JSON accepts dataset labels and numeric budgets; use --provider-config for embeddings.');
    const stop = signalController();
    try {
      const { runLongMemEvalFile } = await import('../evaluation/longmemeval.js');
      const report = await runLongMemEvalFile(required(values.file, '--file'), {
        ...settings,
        ...(values.limit ? { topK: integer(values.limit, 20, 100) } : {}),
        ...(values['provider-config'] ? { embedder: configuredEmbedder(values['provider-config']) } : {}),
        signal: stop.signal,
      });
      if (values.out) {
        const path = resolve(values.out);
        writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        print({ file: path, kind: report.kind, questions: report.results.length, answerQuality: report.answerQuality, calls: report.calls });
      } else print(report);
    } finally { stop.dispose(); }
    return;
  }
  if (command === 'demo' || command === 'learning-demo') {
    const report = command === 'demo' ? runMemoryDemo() : await (await import('../evaluation/learning-demo.js')).runLearningDemo();
    if ('passed' in report && !report.passed) process.exitCode = 1;
    if (values.record) {
      writeFileSync(resolve(values.record), `${JSON.stringify({ ...report, mode: 'recorded' }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      print({ file: resolve(values.record), checksPassed: report.checksPassed, checksTotal: report.checksTotal, kind: 'isolated memory-engine demonstration; no external model evaluation' });
    } else print(report);
    return;
  }
  const health = command === 'health' ? healthCommand(values) : undefined;
  const agentOptions = command === 'agent' ? agentCommand(values) : undefined;
  if (health) requireExistingDatabase(resolve(required(values.db, '--db')));
  const memory = createLocalMemory({ path: resolve(required(values.db, '--db')), workspaceId: required(values.workspace, '--workspace'), agentId: required(values.agent, '--agent') });
  const runtime = new MemoryRuntime(memory, { captureEnabled: !values['no-capture'], recallEnabled: !values['no-recall'] });
  if (command === 'mcp') {
    try {
      const server = await serveMemoryStdio(memory, { readOnly: values['read-only'], allowDestructive: values['allow-destructive'], runtime, ...(values['provider-config'] ? { hybrid: { embedder: configuredEmbedder(values['provider-config']) } } : {}) });
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await server.close();
        memory.close();
      };
      process.once('SIGINT', () => { void close().catch(() => { process.exitCode = 1; }); });
      process.once('SIGTERM', () => { void close().catch(() => { process.exitCode = 1; }); });
      process.stdin.once('end', () => { void close().catch(() => { process.exitCode = 1; }); });
    } catch (error) { memory.close(); throw error; }
    return;
  }
  try {
    switch (command) {
      case 'agent': {
        const { action, settings, jobBudgets, provider } = agentOptions!;
        const stop = signalController();
        const agent = new MemoryAgent(runtime, { readOnly: !!values['read-only'], jobBudgets, ...(provider ? { proposer: createCompatibleProposer(provider) } : {}) });
        try {
          if (action === 'context') print(await agent.beforeTurn({ query: required(values.query, '--query'), maxTokens: integer(values.tokens, 4096, 262144), ...settings, signal: stop.signal }));
          else if (action === 'status') print(runtime.jobs());
          else if (action === 'capture-events') {
            const events: unknown = JSON.parse(readLocalText(required(values.file, '--file')));
            if (!Array.isArray(events) || !['codex', 'claude'].includes(String(values.adapter))) throw new Error('Supply an event array and --adapter codex|claude.');
            print(agent.afterEvents({ sessionId: required(values.session, '--session'), adapter: values.adapter as 'codex' | 'claude', events, visibility: values.share ? 'workspace' : 'private', ...(values.trust ? { trust: z.enum(['observed', 'untrusted']).parse(values.trust) } : {}) }));
          } else if (action === 'turn') {
            const result = await agent.runTurn({ ...settings, sessionId: required(values.session, '--session'), turnId: required(values.key, '--key'), input: required(values.text, '--text'), query: values.query ?? required(values.text, '--text'), maxTokens: integer(values.tokens, 4096, 262144), ...(values.trust ? { trust: z.enum(['observed', 'untrusted']).parse(values.trust) } : {}), visibility: values.share ? 'workspace' : 'private', signal: stop.signal }, createCompatibleAgentResponder(provider!));
            print(result);
          } else if (values.watch) print(await agent.start({ ...settings, signal: stop.signal }).done);
          else print(await agent.drain({ signal: stop.signal }));
        } finally { await agent.close(); stop.dispose(); }
        break;
      }
      case 'health': {
        const maintenance = new MemoryMaintenance(runtime);
        if (health!.action === 'scan') print(maintenance.scan());
        else if (health!.action === 'recall') print(maintenance.recall(health!.input));
        else if (health!.action === 'watch') print(maintenance.watchMemory(health!.input));
        else print(maintenance.recordCheck(health!.input));
        break;
      }
      case 'store': {
        const trust = values.trust ?? 'observed';
        const kind = values.kind ?? 'observation';
        if (!['untrusted', 'observed', 'verified'].includes(trust)) throw new Error('Invalid --trust.');
        if (!['fact', 'preference', 'decision', 'procedure', 'observation'].includes(kind)) throw new Error('Invalid --kind.');
        print(memory.store({ text: required(values.text, '--text'), source: { uri: required(values.source, '--source') }, trust: trust as StoreMemoryInput['trust'], kind: kind as StoreMemoryInput['kind'], visibility: values.share ? 'workspace' : 'private', evidence: values.evidence }));
        break;
      }
      case 'recall': {
        if (!runtime.recallEnabled) throw new Error('Runtime recall is disabled.');
        const input = { query: required(values.query, '--query'), limit: integer(values.limit, 20, 100), includeUntrusted: values['include-untrusted'] };
        print(values['provider-config'] ? await memory.recallHybrid(input, { embedder: configuredEmbedder(values['provider-config']) }) : memory.recall(input)); break;
      }
      case 'context': {
        if (!runtime.recallEnabled) throw new Error('Runtime recall is disabled.');
        const input = { query: required(values.query, '--query'), maxTokens: integer(values.tokens, 4_096, 32_768) };
        print(values['provider-config'] ? await memory.compileHybrid(input, { embedder: configuredEmbedder(values['provider-config']) }) : memory.compile(input)); break;
      }
      case 'inspect': print(values.id ? memory.get(values.id) : memory.inspect({ limit: integer(values.limit, 20, 100), includeInactive: values.history })); break;
      case 'correct': {
        const id = required(values.id, '--id'); const record = memory.get(id);
        if (record?.metadata.advisory === false || ['model', 'skill'].includes(String(record?.metadata.runtimeType))) throw new Error('Internal runtime state requires its controller interface.');
        print(memory.correct(id, { text: required(values.text, '--text'), source: { uri: required(values.source, '--source') }, reason: required(values.reason, '--reason') })); break;
      }
      case 'forget': {
        if (!values.confirm) throw new Error('Forgetting purges live memory content. Supply --confirm to perform this action.');
        const id = required(values.id, '--id'); const record = memory.get(id);
        if (record?.metadata.advisory === false) throw new Error('Internal state requires its controller interface.');
        print(record?.metadata.runtimeType === 'source' ? runtime.forgetSource(id) : memory.forget(id)); break;
      }
      case 'serve': {
        const token = values['token-file'] ? readLocalText(values['token-file'], 4096).trim() : required(process.env.MNEMOSYNE_TOKEN, '--token-file or MNEMOSYNE_TOKEN');
        const embedder = values['provider-config'] ? configuredEmbedder(values['provider-config']) : undefined;
        const control = signalController();
        try {
          const server = await startMemoryHttp({ host: '127.0.0.1', port: values.port === '0' ? 0 : integer(values.port, 8765, 65535), principals: [{ token, memory, runtime, readOnly: values['read-only'], allowDestructive: values['allow-destructive'],
            ...(embedder ? { recall: input => memory.recallHybrid(input, { embedder }), context: input => memory.compileHybrid(input, { embedder }) } : {}) }] });
          print({ url: server.url, workspaceId: memory.workspaceId, agentId: memory.agentId, authentication: 'bearer token', retrieval: embedder ? 'hybrid' : 'lexical' });
          try { await new Promise<void>(done => { if (control.signal.aborted) done(); else control.signal.addEventListener('abort', () => done(), { once: true }); }); }
          finally { await server.close(); }
        } finally { control.dispose(); }
        break;
      }
      case 'capture': {
        const adapter = required(values.adapter, '--adapter');
        if (!['text', 'generic', 'codex', 'claude'].includes(adapter)) throw new Error('Invalid --adapter.');
        if (values.mime && !['text/plain', 'text/markdown', 'application/json'].includes(values.mime)) throw new Error('Unsupported direct-text --mime; binary extraction uses the SDK callback.');
        const connector = new LocalSourceConnector(runtime, { path: required(values.file, '--file'), format: adapter as LocalSourceOptions['format'], sessionId: values.session, mimeType: values.mime as LocalSourceOptions['mimeType'], trust: (values.trust ?? 'untrusted') as LocalSourceOptions['trust'] });
        if (values.watch) {
          const control = signalController();
          try { for await (const result of connector.watch({ signal: control.signal, intervalMs: integer(values.interval, 1000, 60000) })) if (result.changed) print(result); }
          finally { control.dispose(); }
        } else print(await connector.sync());
        break;
      }
      case 'observe': print(runtime.enqueue({ ...jsonInput(values.json), kind: 'observe' } as EnqueueInput)); break;
      case 'jobs': print(runtime.jobs()); break;
      case 'run-jobs': print(await runtime.runJobs({ ...jsonInput(values.json), proposer: createCompatibleProposer(providerConfig(values['provider-config'])) } as RunJobsOptions)); break;
      case 'index': print(await memory.indexEmbeddings({ embedder: configuredEmbedder(values['provider-config']) })); break;
      case 'model': {
        const input = jsonInput(values.json); const key = required(values.key ?? input.key as string | undefined, '--key');
        switch (values.action ?? 'get') {
          case 'get': print(runtime.getModel(key, { sourceIds: input.sourceIds as string[] | undefined })); break;
          case 'context': print(runtime.modelContext(key, { maxBytes: input.maxBytes as number | undefined })); break;
          case 'refresh': print(await runtime.refreshModel({ ...input, kind: 'model', key, sourceIds: input.sourceIds as string[], proposer: createCompatibleProposer(providerConfig(values['provider-config'])) })); break;
          default: throw new Error('Model action must be get, context or refresh.');
        } break;
      }
      case 'skill': {
        const input = jsonInput(values.json);
        switch (required(values.action, '--action')) {
          case 'create': print(runtime.createSkill(input as unknown as SkillDefinition)); break;
          case 'get': print(runtime.getSkill(required(values.id ?? input.id as string | undefined, '--id or JSON id'))); break;
          case 'trial': print(await runtime.trialSkill(input as unknown as SkillTrialInput)); break;
          case 'retire': print(runtime.retireSkill(required(values.id ?? input.id as string | undefined, '--id or JSON id'), required(values.reason ?? input.reason as string | undefined, '--reason or JSON reason'))); break;
          default: throw new Error('Skill action must be create, get, trial or retire.');
        } break;
      }
      case 'branch': {
        const branches = new MemoryBranches(memory); const input = jsonInput(values.json);
        switch (required(values.action, '--action')) {
          case 'create': print(branches.create(input as unknown as { name: string; baseIds: string[] })); break;
          case 'stage': print(branches.stage(required(values.id ?? input.id as string | undefined, '--id or JSON id'), input.changes as BranchChange[])); break;
          case 'preview': print(branches.preview(required(values.id ?? input.id as string | undefined, '--id or JSON id'))); break;
          case 'merge': print(branches.merge(required(values.id ?? input.id as string | undefined, '--id or JSON id'))); break;
          default: throw new Error('Branch action must be create, stage, preview or merge.');
        } break;
      }
      case 'entity': {
        const relations = new MemoryRelations(memory); const input = jsonInput(values.json);
        switch (required(values.action, '--action')) {
          case 'create': print(relations.entity(input as unknown as EntityInput)); break;
          case 'resolve': print(relations.resolve(input.name as string, input.type as string | undefined)); break;
          case 'relate': print(relations.relate(input as unknown as Parameters<MemoryRelations['relate']>[0])); break;
          case 'traverse': print(relations.traverse(input as unknown as Parameters<MemoryRelations['traverse']>[0])); break;
          default: throw new Error('Entity action must be create, resolve, relate or traverse.');
        } break;
      }
      case 'export': {
        const path = resolve(required(values.out, '--out'));
        if (path === resolve(values.db!)) throw new Error('Export must not overwrite the memory database.');
        // Use the same compact encoding that the kernel measures for its size limit.
        writeFileSync(path, JSON.stringify(memory.export()), { mode: 0o600, flag: 'wx' });
        print({ file: path }); break;
      }
      case 'import': {
        const path = resolve(required(values.file, '--file'));
        print(memory.import(readSnapshot(path))); break;
      }
    }
  } finally { memory.close(); }
}

main().catch(error => {
  process.stderr.write(`Mnemosyne: ${error instanceof Error ? error.message : 'command failed'}\n`);
  process.exitCode = 1;
});
