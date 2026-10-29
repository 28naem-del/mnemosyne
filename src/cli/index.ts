#!/usr/bin/env node
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
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
import { bisectRetrievalRequest, selectBisectRetrieval } from './bisect-retrieval.js';
import { MemoryMaintenance } from '../maintenance/index.js';
import { parseJsonWithSpans } from '../migration/json-spans.js';
import { MemoryAgent } from '../agent/index.js';
import { inferDependencies, listPremiseHolds, reviewDependency, type InferDependenciesOptions, type PremiseGuardOptions } from '../dependencies/index.js';

const HELP = `Mnemosyne ${VERSION} — portable agent memory

  mnemosy demo [--classic]         Five-moment demo, offline, each proof measured live (--classic: the old demo)
  mnemosy learning-demo            Run isolated capture-to-skill replay checks
  mnemosy evaluate --file FILE [--out FILE] [--limit 20] [--json JSON]
                   [--provider-config FILE]  Evaluate supplied LongMemEval v1 retrieval
  mnemosy benchmark-agent --file FILE --provider-config FILE --out FILE [--json JSON]
  mnemosy operations --action backup --db DATABASE --out BUNDLE [--encrypt [--passphrase-file FILE]]
  mnemosy operations --action verify --file BUNDLE [--passphrase-file FILE]
  mnemosy operations --action restore --file BUNDLE --out NEW_DATABASE [--passphrase-file FILE]
                   Whole-database recovery. --encrypt (scrypt + AES-256-GCM) also carries
                   DATABASE.consolidation.key and restores it beside NEW_DATABASE; plain bundles
                   never carry it. Passphrase from MNEMOSYNE_BACKUP_PASSPHRASE or a 0600
                   --passphrase-file, never argv
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
  mnemosy replay [scope] --known-at ISO [--as-of ISO] [--hash] [--records]
                   Reconstruct the belief state at a bitemporal cut point
  mnemosy replay [scope] --known-at ISO --diff ISO [--json '{"knownAt":"ISO"}']
                   Belief diff between two cut points, with each change's source
  mnemosy bisect [scope] --file TASKS.json --task ID [--limit K] [--exact]
                   [--retrieval auto|lexical|hybrid]
                   Delta-debug memory to the minimal record set behind a retrieval failure;
                   auto (default) re-executes hybrid when the store has stored vectors
                   for the bundled model, else lexical; an hnsw dense index is refused
  mnemosy consolidate [scope] --propose [--out DIFF] | --apply [--file DIFF] | --rollback PASS_ID | --verify-chain
                   Outcome-gated, reversible consolidation; --demo [--db NEW_FILE] runs it offline
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
  mnemosy dependencies [scope] --infer [--min-support N] [--json JSON]
                   Surface undeclared dependencies inferred from successful co-use (reads only)
  mnemosy dependencies [scope] --holds [--json JSON]
                   List dependents the premise guard holds, as proposals with digests (reads only)
  mnemosy dependencies [scope] --review DIGEST --accept|--reject --reviewer NAME [--reason TEXT]
                   Ledger a review decision on a proposal or a hold; accept links the edge
                   through correct(); rejecting (releasing) a hold requires --reason
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
                  "dimensions":768,"revision":"v1","apiKeyEnv":"NAMED_ENV","timeoutMs":120000}
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

/**
 * A bisect task: the query that failed, the evidence that should have been
 * found, and the cut point it failed at. Taken from `--file` (a JSON array,
 * selected by `--task`) or inline from `--json`. The shape is validated here so
 * a malformed task is a CLI error rather than a confusing retrieval result.
 */
const BISECT_TASK = z.object({
  id: z.string().min(1),
  query: z.string().min(1),
  asOf: z.string().optional(),
  knownAt: z.string().optional(),
  k: z.number().int().min(1).max(100).optional(),
  gold: z.array(z.string().min(1)).min(1),
  require: z.enum(['any', 'all']).optional(),
  lexicalScoring: z.enum(['overlap', 'bm25']).optional(),
  depth: z.number().int().min(1).max(100).optional(),
  includeUntrusted: z.boolean().optional(),
}).strict();

function bisectTask(values: CliValues): z.infer<typeof BISECT_TASK> & { k: number } {
  const limit = values.limit === undefined ? undefined : integer(values.limit as string, 10, 100);
  const selected = values.file === undefined
    ? BISECT_TASK.parse(jsonInput(values.json as string | undefined))
    : (() => {
      const id = required(values.task as string | undefined, '--task');
      const file = z.array(BISECT_TASK).parse(JSON.parse(readLocalText(required(values.file as string | undefined, '--file'), 16_777_216)));
      const match = file.find(entry => entry.id === id);
      if (!match) throw new Error(`No bisect task with id ${id} in ${values.file as string}.`);
      return match;
    })();
  // --limit is the top-k the outcome is judged at, and overrides the task's own.
  return { ...selected, k: limit ?? selected.k ?? 10 };
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
  // Replay reconstructs past state and bisect re-runs retrieval against it; both read, neither writes.
  replay: ['read'], bisect: ['read'],
  // Consolidation reads the store and its outcome ledger, then applies or undoes a pass and writes its receipt.
  consolidate: ['read', 'write'],
  correct: ['read', 'write'], forget: ['erase'], capture: ['read', 'write'],
  observe: ['read', 'write'], 'run-jobs': ['read', 'write'], index: ['read', 'write'],
  // These routes enforce per-request policies and must accept valid combinations.
  mcp: [], serve: [],
  // Isolated evaluations create and read temporary memory, even without an output file.
  demo: ['read', 'write'], 'learning-demo': ['read', 'write'], evaluate: ['read', 'write'], 'benchmark-agent': ['read', 'write'],
  // Inference and --holds only read; --review also writes (receipt, and correct() on accept),
  // which dependenciesCommand checks before SQLite opens.
  dependencies: ['read'],
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
  const drain = { maxJobs: z.number().int().min(1).max(64).optional(), maxCalls: z.number().int().min(0).max(64).optional(), maxTotalInputBytes: z.number().int().min(0).max(4194304).optional(), maxInputBytes: z.number().int().min(1024).max(262144).optional(), maxOutputBytes: z.number().int().min(256).max(65536).optional(), timeoutMs: z.number().int().min(10).max(300000).optional(), leaseMs: z.number().int().min(1).max(600000).optional(), maxAttempts: z.number().int().min(1).max(10).optional() };
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

/** Validates `dependencies` before SQLite opens: one mode, its flags only, and the
 * review's write capability (infer and holds read; review reads and writes). */
function dependenciesCommand(values: CliValues) {
  const review = values.review as string | undefined;
  if ([!!values.infer, !!values.holds, review !== undefined].filter(Boolean).length !== 1) throw new Error('dependencies requires exactly one of --infer, --holds or --review DIGEST.');
  const shared = ['db', 'workspace', 'agent', 'read-only', 'no-capture', 'no-recall', 'json'];
  const allowed = [...shared, ...(values.holds ? ['holds'] : review === undefined ? ['infer', 'min-support'] : ['review', 'accept', 'reject', 'reviewer', 'reason', 'min-support'])];
  if (Object.entries(values).some(([key, value]) => value !== undefined && !allowed.includes(key))) throw new Error('Unsupported option for this dependencies mode.');
  // --holds takes premise guard options (for example holdReliance) and never inference thresholds.
  if (values.holds) return { holds: jsonInput(values.json as string | undefined) as PremiseGuardOptions } as const;
  const settings = jsonInput(values.json as string | undefined) as InferDependenciesOptions;
  const minSupport = values['min-support'] === undefined ? undefined : integer(values['min-support'] as string, 2, 1_000_000);
  if (minSupport !== undefined && minSupport < 2) throw new Error('--min-support must be at least 2: one co-use cannot tell a premise from a coincidence.');
  const options: InferDependenciesOptions = { ...settings, ...(minSupport === undefined ? {} : { minSupport }) };
  if (review === undefined) return { options } as const;
  if (values['read-only']) throw new Error('dependencies review: memory mutations are disabled by --read-only.');
  if (values['no-capture']) throw new Error('dependencies review: memory writes are disabled by --no-capture.');
  if (!/^[a-f0-9]{64}$/.test(review)) throw new Error('--review takes a proposal digest (64 lowercase hex characters) from dependencies --infer or --holds.');
  if (!!values.accept === !!values.reject) throw new Error('dependencies --review requires exactly one of --accept or --reject.');
  const reviewer = required(values.reviewer as string | undefined, '--reviewer');
  const note = values.reason as string | undefined;
  return { options, review: { digest: review, decision: values.accept ? 'accept' as const : 'reject' as const, reviewer, ...(note === undefined ? {} : { note }) } } as const;
}

function providerConfig(path: string | undefined) {
  const configPath = required(path, '--provider-config');
  const schema = z.object({ baseUrl: z.string().min(1).max(2048), model: z.string().min(1).max(512), dimensions: z.number().int().min(1).max(65536).optional(), revision: z.string().min(1).max(512).optional(), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256).optional(), timeoutMs: z.number().int().min(1).max(300000).optional() }).strict();
  let config: z.infer<typeof schema>;
  try { config = schema.parse(JSON.parse(readLocalText(configPath, 16384))); }
  catch { throw new Error('Invalid provider configuration file; use only baseUrl, model, dimensions, revision, apiKeyEnv and timeoutMs (1 to 300000 ms).'); }
  const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
  if (config.apiKeyEnv && (!apiKey?.trim() || apiKey.length > 4096 || /[\r\n]/.test(apiKey))) throw new Error('The explicitly named API key environment variable is missing or invalid.');
  return { ...config, ...(apiKey ? { apiKey } : {}) };
}

function configuredEmbedder(path: string | undefined) {
  const config = providerConfig(path);
  if (!config.dimensions) throw new Error('Embedding provider configuration requires dimensions.');
  return createCompatibleEmbedder({ ...config, dimensions: config.dimensions });
}

const PASSPHRASE_ENV = 'MNEMOSYNE_BACKUP_PASSPHRASE';
const PASSPHRASE_SOURCES = `set ${PASSPHRASE_ENV} or pass --passphrase-file FILE`;

/** Reads a backup passphrase from the environment or a private file; never from argv, never echoed. */
function backupPassphrase(values: CliValues): Buffer | undefined {
  const file = values['passphrase-file'] as string | undefined, env = process.env[PASSPHRASE_ENV];
  if (file !== undefined && env !== undefined) throw new Error(`Use either ${PASSPHRASE_ENV} or --passphrase-file, not both.`);
  let secret: Buffer | undefined;
  if (file !== undefined) {
    const fd = openSync(resolve(file), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error('--passphrase-file must be a regular file.');
      // POSIX only: Windows has no comparable mode bits, so the file's ACL is the operator's responsibility there.
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('--passphrase-file must not be readable or writable by group or others (chmod 600).');
      if (stat.size > 4098) throw new Error('--passphrase-file exceeds 4096 bytes.');
      const buffer = Buffer.alloc(4099); let size = 0;
      for (;;) { const read = readSync(fd, buffer, size, buffer.length - size, null); if (!read) break; size += read; if (size > 4098) throw new Error('--passphrase-file exceeds 4096 bytes.'); }
      let end = size; if (buffer[end - 1] === 0x0a) end--; if (end > 0 && buffer[end - 1] === 0x0d && buffer[end] === 0x0a) end--;
      secret = Buffer.from(buffer.subarray(0, end)); buffer.fill(0);
    } finally { closeSync(fd); }
  } else if (env !== undefined) secret = Buffer.from(env, 'utf8');
  if (secret !== undefined && (!secret.length || secret.length > 4096)) throw new Error('The backup passphrase must be 1 to 4096 bytes.');
  return secret;
}

/** S07: a database with receipts but no key beside it cannot pin or roll back its consolidation chain. */
function consolidationReceiptCount(path: string): number {
  try {
    const db = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 100 });
    try { return Number(db.prepare("SELECT count(*) AS n FROM local_ledger WHERE event = 'consolidation'").get()?.n ?? 0); } finally { db.close(); }
  } catch { return 0; }
}
function warnMissingSigningKey(receipts: number, keyFile: string): void {
  if (receipts > 0) process.stderr.write(`Mnemosyne: warning: ${receipts} consolidation receipt(s) but no consolidation key file at ${keyFile}. --verify-chain cannot pin them, and --rollback would create a new key that refuses them. Restore the key from its protected backup, or restore an encrypted bundle that carries it (docs/OPERATIONS.md#the-consolidation-signing-key).\n`);
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
    classic: { type: 'boolean' },
    'as-of': { type: 'string' }, 'known-at': { type: 'string' }, diff: { type: 'string' },
    hash: { type: 'boolean' }, records: { type: 'boolean' }, task: { type: 'string' }, exact: { type: 'boolean' }, retrieval: { type: 'string' },
    propose: { type: 'boolean' }, apply: { type: 'boolean' }, rollback: { type: 'string' }, 'verify-chain': { type: 'boolean' }, demo: { type: 'boolean' },
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
    infer: { type: 'boolean' }, holds: { type: 'boolean' }, 'min-support': { type: 'string' }, review: { type: 'string' },
    accept: { type: 'boolean' }, reject: { type: 'boolean' }, reviewer: { type: 'string' },
    encrypt: { type: 'boolean' }, 'passphrase-file': { type: 'string' }, 'include-signing-key': { type: 'boolean' },
    // Parsed only to refuse it with a clear message: argv is visible to other processes and shell history.
    passphrase: { type: 'string' },
  } });
  if (values.passphrase !== undefined) throw new Error(`--passphrase is not accepted: a secret on the command line leaks through the process list and shell history. ${PASSPHRASE_SOURCES[0].toUpperCase()}${PASSPHRASE_SOURCES.slice(1)} (mode 0600).`);
  if (values.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (values.help || !positionals.length) { process.stdout.write(HELP); return; }
  if (positionals.length !== 1) throw new Error('Specify exactly one command.');
  const command = positionals[0];
  validateCommandPolicy(command, values);
  if (command === 'migrate') { runMigrationCommand(values); return; }
  if (command === 'operations') {
    const action = values.action ?? 'verify';
    if (action === 'backup' && !values.encrypt) {
      if (values['include-signing-key']) throw new Error('--include-signing-key needs --encrypt: a plain backup never carries the consolidation signing key.');
      if (values['passphrase-file'] !== undefined) throw new Error('--passphrase-file applies to an encrypted backup; add --encrypt.');
    }
    const allowed = ['action', 'json', 'read-only', 'no-capture', 'no-recall', ...(action === 'backup' ? ['db', 'out', 'encrypt', 'passphrase-file', 'include-signing-key'] : action === 'restore' ? ['file', 'out', 'passphrase-file'] : ['file', 'passphrase-file'])];
    if (Object.entries(values).some(([key, value]) => value !== undefined && !allowed.includes(key))) throw new Error('Operations work on a whole database; scoped and unrelated options are unsupported.');
    const limits = z.object({ maxBytes: z.number().int().min(4096).max(4294967296).optional(), timeoutMs: z.number().int().min(1).max(3600000).optional() }).strict().parse(jsonInput(values.json));
    // A plain backup ignores any passphrase in the environment: encryption is never implicit.
    const secret = action === 'backup' && !values.encrypt ? undefined : backupPassphrase(values);
    if (action === 'backup' && values.encrypt && !secret) throw new Error(`--encrypt needs a passphrase: ${PASSPHRASE_SOURCES}; never put it on the command line.`);
    const encryption = secret ? { encryption: { passphrase: secret } } : {};
    const { backupLocalDatabase, verifyLocalBackup, restoreLocalBackup, MemoryOperationError } = await import('../operations/index.js');
    const stop = signalController();
    try {
      if (action === 'backup') {
        const input = { ...limits, sourcePath: required(values.db, '--db'), backupPath: required(values.out, '--out'), signal: stop.signal };
        if (values['include-signing-key'] && !existsSync(`${resolve(input.sourcePath)}.consolidation.key`)) throw new Error(`--include-signing-key: there is no consolidation key file at ${resolve(input.sourcePath)}.consolidation.key.`);
        print(secret ? await backupLocalDatabase({ ...input, encryption: { passphrase: secret }, ...(values['include-signing-key'] ? { includeSigningKey: true } : {}) }) : await backupLocalDatabase(input));
      } else if (action === 'restore') {
        const restored = await restoreLocalBackup({ ...limits, backupPath: required(values.file, '--file'), targetPath: required(values.out, '--out'), signal: stop.signal, ...encryption });
        print(restored);
        const keyFile = `${restored.targetPath}.consolidation.key`;
        if (!existsSync(keyFile)) warnMissingSigningKey(consolidationReceiptCount(restored.targetPath), keyFile);
      } else print(await verifyLocalBackup({ ...limits, backupPath: required(values.file, '--file'), signal: stop.signal, ...encryption }));
    } catch (error) {
      if (error instanceof MemoryOperationError && error.code === 'passphrase-required') throw new Error(`This bundle is encrypted: ${PASSPHRASE_SOURCES}.`);
      throw error;
    } finally { stop.dispose(); secret?.fill(0); }
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
    if (command === 'demo' && !values.classic) {
      // The breakthrough demo streams each moment as it runs, then exits 1 if any implemented proof failed.
      const record = values.record ? resolve(values.record) : undefined;
      // Refuse an existing --record file before minutes of work, not after.
      if (record && (await import('node:fs')).existsSync(record)) throw new Error(`Refusing to overwrite existing file: ${record}`);
      const { runBreakthroughDemo } = await import('../evaluation/breakthrough-demo.js');
      const report = await runBreakthroughDemo({ out: line => { process.stdout.write(`${line}\n`); } });
      if (report.passed !== report.total) process.exitCode = 1;
      if (record) {
        writeFileSync(record, `${JSON.stringify({ ...report, mode: 'recorded' }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        process.stdout.write(`Report saved to ${record}\n`);
      }
      return;
    }
    const report = command === 'demo' ? runMemoryDemo() : await (await import('../evaluation/learning-demo.js')).runLearningDemo();
    if ('passed' in report && !report.passed) process.exitCode = 1;
    if (values.record) {
      writeFileSync(resolve(values.record), `${JSON.stringify({ ...report, mode: 'recorded' }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      print({ file: resolve(values.record), checksPassed: report.checksPassed, checksTotal: report.checksTotal, kind: 'isolated memory-engine demonstration; no external model evaluation' });
    } else print(report);
    return;
  }
  if (command === 'consolidate' && values.demo) {
    // Isolated like `demo`: it seeds a synthetic store of its own, in memory or in a new file the caller can continue with.
    if (['propose', 'apply', 'rollback', 'verify-chain', 'workspace', 'agent', 'file', 'out'].some(key => (values as CliValues)[key] !== undefined)) throw new Error('consolidate --demo takes only --db NEW_FILE.');
    const { runConsolidationDemo } = await import('../consolidation/demo.js');
    const { createConsolidationSigner } = await import('../consolidation/index.js');
    const path = values.db === undefined ? undefined : resolve(values.db);
    if (path !== undefined && existsSync(path)) throw new Error('consolidate --demo seeds a synthetic store; --db must name a new file.');
    const demo = runConsolidationDemo(path === undefined ? {} : { path, signer: createConsolidationSigner({ keyFile: `${path}.consolidation.key` }) });
    if (!demo.chain.ok || !demo.rollback.restored) process.exitCode = 1;
    return;
  }
  const health = command === 'health' ? healthCommand(values) : undefined;
  const agentOptions = command === 'agent' ? agentCommand(values) : undefined;
  const dependencyOptions = command === 'dependencies' ? dependenciesCommand(values) : undefined;
  const bisectRetrieval = command === 'bisect' ? bisectRetrievalRequest(values.retrieval) : undefined;
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
      case 'replay': {
        if (!runtime.recallEnabled) throw new Error('Runtime recall is disabled.');
        // Loaded here, not at module scope: a caller who never replays never pays for it.
        const { replayDiff, replayState } = await import('../local/replay.js');
        // Both bounds are the caller's. Replay never reads a wall clock, so a
        // cut point is reproducible tomorrow and on another machine.
        const knownAt = required(values['known-at'], '--known-at');
        const cut = { knownAt, ...(values['as-of'] === undefined ? {} : { asOf: values['as-of'] }) };
        if (values.diff !== undefined) {
          const settings = z.object({ knownAt: z.string().optional() }).strict().parse(jsonInput(values.json) ?? {});
          print(replayDiff(memory, cut, { asOf: values.diff, knownAt: settings.knownAt ?? knownAt }));
          break;
        }
        const state = replayState(memory, cut, { records: values.records === true });
        // --hash prints the digest alone, for `test "$(mnemosy replay ... --hash)" = ...`.
        if (values.hash && !values.records) { process.stdout.write(`${state.stateSha256}\n`); break; }
        print(state); break;
      }
      case 'bisect': {
        if (!runtime.recallEnabled) throw new Error('Runtime recall is disabled.');
        // Loaded here, not at module scope: a caller who never bisects never pays for it.
        const { bisect, HNSW_REFUSAL } = await import('../local/bisect.js');
        const task = bisectTask(values);
        const store = { path: resolve(required(values.db, '--db')), workspaceId: required(values.workspace, '--workspace'), agentId: required(values.agent, '--agent') };
        // Oracle B re-executes whatever path the auditor retrieves with, so the
        // auditor is opened on the store's own path: read off its stored vectors
        // under --retrieval auto (the default), or named explicitly.
        const selection = selectBisectRetrieval(bisectRetrieval ?? 'auto', store, HNSW_REFUSAL);
        // Its own read handle, with the ledger off: an audit has no business
        // writing recall entries into what it audits. Hybrid must not degrade to
        // lexical without saying so, so a missing model is an error here.
        const auditor = createLocalMemory({
          ...store, retrieval: selection.mode, ledger: false, ...(selection.mode === 'hybrid' ? { requireEmbedder: true } : {}),
        });
        try {
          if (selection.mode === 'hybrid') {
            try { void auditor.retrieval; } catch (error) {
              throw new Error(`bisect needs the hybrid retriever (${selection.requested}: ${selection.signal}), but the bundled embedding model did not load: ${error instanceof Error ? error.message : String(error)}. Run npm run setup:embedder, or pass --retrieval lexical to bisect the lexical path instead.`);
            }
          }
          print({ ...bisect(auditor, task, { exact: values.exact === true }), retrievalSelection: selection });
        } finally { auditor.close(); }
        break;
      }
      case 'consolidate': {
        const { consolidate, createConsolidationSigner, gateConsolidation, proposeConsolidation, rollbackConsolidation, verifyConsolidationChain } = await import('../consolidation/index.js');
        const modes = ['propose', 'apply', 'rollback', 'verify-chain'].filter(mode => (values as CliValues)[mode] !== undefined);
        if (modes.length !== 1) throw new Error('consolidate requires exactly one of --propose, --apply, --rollback PASS_ID, --verify-chain or --demo.');
        if (values.out !== undefined && !values.propose) throw new Error('--out applies to consolidate --propose only.');
        if (values.file !== undefined && !values.apply) throw new Error('--file applies to consolidate --apply only.');
        const keyFile = `${resolve(required(values.db, '--db'))}.consolidation.key`;
        if (values['verify-chain']) {
          // Verification never creates a key; when this store has one, every receipt must be signed by it,
          // so a chain re-signed with a fresh key by someone holding only database write access fails.
          const pinnedKeyIds = existsSync(keyFile) ? [createConsolidationSigner({ keyFile }).keyId] : [];
          const chain = verifyConsolidationChain(memory, pinnedKeyIds.length ? { pinnedKeyIds } : {});
          if (!chain.ok) process.exitCode = 1;
          if (!pinnedKeyIds.length) warnMissingSigningKey(chain.receipts, keyFile);
          print({ ...chain, pinnedKeyIds, pinning: pinnedKeyIds.length ? `receipts must be signed by ${keyFile}` : 'none: this store has no consolidation key file, so foreign-key receipts are reported only as keyChanges' }); break;
        }
        // This store's Ed25519 key, created 0600 next to the database on first use (docs/CONSOLIDATION-SIGNING.md).
        const signer = createConsolidationSigner({ keyFile });
        if (values.rollback !== undefined) {
          // Verifies the kept receipt (digest, signatures, this store's key) before it touches a record.
          const undone = rollbackConsolidation(memory, values.rollback, { signer });
          if (undone.verdict !== 'rolled_back' || !undone.restored) process.exitCode = 1;
          print(undone); break;
        }
        if (values.propose) {
          const diff = proposeConsolidation(memory, { signer });
          if (diff && values.out) {
            const path = resolve(values.out);
            writeFileSync(path, `${JSON.stringify(diff, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
            print({ file: path, digest: diff.digest, stateBefore: diff.stateBefore, proposals: diff.proposals.length, keyId: diff.signature.keyId });
          } else print(diff ?? { proposals: 0, reason: 'nothing to propose' });
          break;
        }
        // A diff must carry this store's own signature (the gate's default pin); anything else is an invalid run.
        const result = values.file === undefined
          ? consolidate(memory, { signer })
          : gateConsolidation(memory, JSON.parse(readLocalText(resolve(values.file), 16_777_216)), { signer, trustedKeyIds: [signer.keyId] });
        print(result ?? { verdict: null, proposals: 0, reason: 'nothing to propose; no receipt written' }); break;
      }
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
      case 'dependencies': {
        if (dependencyOptions!.holds) { print(listPremiseHolds(memory, dependencyOptions!.holds)); break; }
        const { options, review } = dependencyOptions!;
        if (!review) { print(inferDependencies(memory, options)); break; }
        // The digest names a proposal or hold as it was shown; re-derive both and match
        // it, so a reviewer can only decide on evidence that is still current. Held
        // pairs have a changed premise, so they are never also inferred proposals.
        const proposal = inferDependencies(memory, { ...options, maxProposals: 100_000 }).proposals.find(item => item.digest === review.digest)
          ?? listPremiseHolds(memory, options).holds.find(item => item.digest === review.digest);
        if (!proposal) throw new Error('No current proposal or hold has that digest; run dependencies --infer or --holds again.');
        if (proposal.hold && review.decision === 'reject' && review.note === undefined) throw new Error('Releasing a guard hold requires --reason: why the dependent does not rely on the premise.');
        print(reviewDependency(memory, proposal, review.decision, review.reviewer, { runtime, ...(review.note === undefined ? {} : { note: review.note }) }));
        break;
      }
    }
  } finally { memory.close(); }
}

main().catch(error => {
  process.stderr.write(`Mnemosyne: ${error instanceof Error ? error.message : 'command failed'}\n`);
  process.exitCode = 1;
});
