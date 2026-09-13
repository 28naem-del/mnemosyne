import { lstatSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import { readLocalText } from '../connectors/index.js';
import { createLocalMemory } from '../local/index.js';
import { MemoryRuntime } from '../runtime/index.js';
import { MigrationService, planMigration, type MigrationArtifact, type MigrationPlanOptions } from '../migration/index.js';
import { parseJsonWithSpans } from '../migration/json-spans.js';

const profile = z.enum(['mnemosyne-memcell-array', 'mnemosyne-qdrant-scroll', 'markdown', 'mem0-array', 'mem0-results', 'mem0-page', 'letta-blocks']);
const localFile = z.object({ path: z.string().min(1).max(4096), name: z.string().min(1).max(1024).optional(), profile, logicalPath: z.string().min(1).max(4096).optional(), page: z.object({ index: z.number().int().nonnegative(), totalPages: z.number().int().min(1).max(256) }).strict().optional() }).strict();
const manifest = z.object({ version: z.literal(1), files: z.array(localFile).min(1).max(256), options: z.record(z.string(), z.unknown()) }).strict();
const savedPlan = manifest.extend({ kind: z.literal('mnemosyne-migration-plan'), planHash: z.string().regex(/^[a-f0-9]{64}$/), review: z.unknown(), manifestPath: z.string().min(1).max(4096).optional() }).strict();
const jsonLimits = Object.freeze({ maxInputBytes: 4 * 1024 * 1024, maxNodes: 100000, maxDepth: 32 });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const batchIdentifier = z.string().refine(value => !!value.trim() && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value).toString('utf8') === value);
const scopeIdentifier = z.string().refine(value => !!value.trim() && Buffer.byteLength(value) <= 160 && !value.includes('\0'));
const sourcePage = z.object({ offset: z.number().int().min(0).max(65536).optional(), maxBytes: z.number().int().min(1).max(65536).optional() }).strict();
const shortcutFlags = ['profile', 'source-store', 'source-owner', 'assume-missing-owner', 'acknowledge-partial', 'collection', 'logical-path', 'qdrant-text-field', 'trust'];
type Values = Record<string, string | boolean | undefined>;
const required = (value: unknown, label: string): string => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`); return value; };
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
function readJson(path: string): unknown {
  return parseJsonWithSpans(Buffer.from(readLocalText(path, jsonLimits.maxInputBytes)), jsonLimits).value;
}
function flags(values: Values, allowed: string[]): void {
  if (Object.entries(values).some(([name, value]) => value !== undefined && !allowed.includes(name))) throw new Error('Unsupported option for this migration action; use the manifest for advanced settings');
}
function serializePlan(value: unknown): string {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > jsonLimits.maxInputBytes) throw new Error('Saved review plan exceeds 4 MiB; split sources into smaller explicit batches');
  try { parseJsonWithSpans(Buffer.from(text), jsonLimits); }
  catch { throw new Error('Saved review plan exceeds the JSON complexity limit; split sources into smaller explicit batches'); }
  return text;
}
function artifacts(files: z.infer<typeof localFile>[]): MigrationArtifact[] {
  let remaining = 4 * 1024 * 1024;
  return files.map(file => {
    const bytes = Buffer.from(readLocalText(file.path, Math.max(1, remaining)));
    remaining -= bytes.length; if (remaining < 0) throw new Error('CLI migration input exceeds 4 MiB; split into explicit batches');
    return { name: file.name ?? basename(file.path), profile: file.profile, bytes, ...(file.logicalPath ? { logicalPath: file.logicalPath } : {}), ...(file.page ? { page: file.page } : {}) };
  });
}
export function requireExistingDatabase(path: string): void {
  const file = lstatSync(path); if (!file.isFile() || file.isSymbolicLink()) throw new Error('Use an existing regular migration database');
  protectDestination(path, []);
}
function protectDestination(path: string, sources: string[]): void {
  const destinations = [path, `${path}-wal`, `${path}-shm`].map(candidate => {
    let file: ReturnType<typeof lstatSync> | undefined;
    try { file = lstatSync(candidate); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (file && (!file.isFile() || file.isSymbolicLink() || file.nlink > 1)) throw new Error('Database and SQLite sidecars must be regular, non-linked files');
    return { path: candidate, file };
  });
  if (!destinations[0].file && destinations.slice(1).some(destination => destination.file)) throw new Error('A new database cannot reuse preexisting SQLite sidecar files');
  for (const destination of destinations) for (const source of sources) {
    if (destination.path === resolve(source)) throw new Error('Database and SQLite sidecars must differ from every source and plan file');
    let file: ReturnType<typeof statSync> | undefined;
    try { file = statSync(source); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (file && destination.file && destination.file.dev === file.dev && destination.file.ino === file.ino) throw new Error('Database and SQLite sidecars must differ from every source and plan file');
  }
}

/** Preview reads explicit files only and never opens a destination database. */
export function runMigrationCommand(values: Values): void {
  const action = values.action ?? 'plan';
  if (!['plan', 'apply', 'inspect', 'source', 'rollback', 'forget'].includes(String(action))) throw new Error('Migration action must be plan, apply, inspect, source, rollback or forget');
  if (action === 'plan') {
    const shortcut = values.profile !== undefined;
    flags(values, ['action', 'file', 'out', ...(shortcut ? [...shortcutFlags, 'workspace', 'agent'] : [])]);
    const path = resolve(required(values.file, '--file'));
    let files: z.infer<typeof localFile>[], options: MigrationPlanOptions;
    if (shortcut) {
      const selected = profile.parse(values.profile), owner = required(values['source-owner'], '--source-owner');
      files = [{ path, profile: selected, ...(values['logical-path'] === undefined ? {} : { logicalPath: required(values['logical-path'], '--logical-path') }) }];
      options = { sourceStore: required(values['source-store'], '--source-store'), sourceOwner: { allowedIds: [owner], ...(values['assume-missing-owner'] === true ? { assumeMissing: owner } : {}) },
        destination: { workspaceId: scopeIdentifier.parse(required(values.workspace, '--workspace')), agentId: scopeIdentifier.parse(required(values.agent, '--agent')) },
        trust: z.enum(['untrusted', 'observed']).parse(values.trust ?? 'untrusted'), evaluatedAt: new Date().toISOString(), acknowledgePartial: values['acknowledge-partial'] === true,
        ...(values.collection === undefined ? {} : { collection: required(values.collection, '--collection') }), ...(values['qdrant-text-field'] === undefined ? {} : { qdrantTextField: required(values['qdrant-text-field'], '--qdrant-text-field') }) };
    } else {
      const input = manifest.parse(readJson(path));
      files = input.files.map(file => ({ ...file, path: resolve(dirname(path), file.path) }));
      options = { ...input.options, evaluatedAt: input.options.evaluatedAt ?? new Date().toISOString() } as unknown as MigrationPlanOptions;
    }
    const plan = planMigration(artifacts(files), options);
    const review = { inputs: plan.inputs, report: plan.report, records: plan.records.map(({ rawText: _raw, text: _text, ...record }) => record) };
    const document = { version: 1, kind: 'mnemosyne-migration-plan', files, options, planHash: plan.planHash, review, ...(shortcut ? {} : { manifestPath: path }) };
    if (values.out) writeFileSync(resolve(required(values.out, '--out')), serializePlan(document), { flag: 'wx', mode: 0o600 });
    print({ ...(values.out ? { file: resolve(String(values.out)) } : {}), planHash: plan.planHash, ...plan.report });
    if (!plan.report.readyToApply) process.exitCode = 2;
    return;
  }
  const common = ['action', 'db', 'workspace', 'agent', 'read-only', 'no-capture', 'no-recall'];
  flags(values, [...common, ...(action === 'apply' ? ['file', 'batch', 'confirm'] : action === 'inspect' ? ['batch'] : action === 'source' ? ['batch', 'id', 'json'] : action === 'rollback' ? ['batch', 'revision', 'confirm'] : ['id', 'confirm'])]);
  if (['apply', 'rollback', 'forget'].includes(String(action)) && (values.confirm !== true || values['read-only'])) throw new Error('Explicit mutation requires --confirm and a writable policy');
  if (action === 'apply' && values['no-capture']) throw new Error('Migration capture is disabled');
  if (['inspect', 'source'].includes(String(action)) && values['no-recall']) throw new Error('Migration recall is disabled');
  // Validate every action argument before any database opener or sidecar write.
  const batchId = action === 'forget' ? undefined : batchIdentifier.parse(required(values.batch, '--batch'));
  const identity = action === 'source' || action === 'forget' ? digest.parse(required(values.id, '--id source-identity')) : undefined;
  const revision = action === 'rollback' ? digest.parse(required(values.revision, '--revision manifest-revision')) : undefined;
  const paging = action === 'source' ? sourcePage.parse(values.json === undefined ? {} : parseJsonWithSpans(Buffer.from(required(values.json, '--json')), { maxInputBytes: 16384, maxDepth: 8, maxNodes: 32 }).value) : undefined;
  let apply: { artifacts: MigrationArtifact[]; options: MigrationPlanOptions; planHash: string } | undefined;
  let inputs: string[] = [];
  if (action === 'apply') {
    const path = resolve(required(values.file, '--file saved-plan.json')), input = savedPlan.parse(readJson(path));
    // Stored descriptors are absolute, so a moved plan cannot select other files.
    if (input.files.some(file => resolve(file.path) !== file.path)) throw new Error('Saved migration source paths must be absolute');
    if (input.manifestPath !== undefined && resolve(input.manifestPath) !== input.manifestPath) throw new Error('Saved migration manifest path must be absolute');
    apply = { artifacts: artifacts(input.files), options: input.options as unknown as MigrationPlanOptions, planHash: input.planHash };
    const checked = planMigration(apply.artifacts, apply.options);
    if (checked.planHash !== apply.planHash || !checked.report.readyToApply) throw new Error('Source bytes or plan options changed; preview again before applying');
    inputs = [path, ...input.files.map(file => file.path), ...(input.manifestPath ? [input.manifestPath] : [])];
  }
  const db = resolve(required(values.db, '--db'));
  const workspaceId = scopeIdentifier.parse(required(values.workspace ?? apply?.options.destination.workspaceId, '--workspace')), agentId = scopeIdentifier.parse(required(values.agent ?? apply?.options.destination.agentId, '--agent'));
  if (apply && (workspaceId !== apply.options.destination.workspaceId || agentId !== apply.options.destination.agentId)) throw new Error('Destination scope differs from the reviewed plan');
  if (action !== 'apply') requireExistingDatabase(db);
  else protectDestination(db, inputs);
  const memory = createLocalMemory({ path: db, workspaceId, agentId });
  try {
    const runtime = new MemoryRuntime(memory, { captureEnabled: !values['no-capture'], recallEnabled: !values['no-recall'] });
    const service = new MigrationService({ memory, runtime, policy: () => ({ readOnly: !!values['read-only'], allowDestructive: !!values.confirm }) });
    switch (action) {
      case 'apply': print(service.applyMigration({ ...apply!, batchId: batchId! })); break;
      case 'inspect': print(service.inspectMigration(batchId!)); break;
      case 'source': print(service.inspectMigrationSource(batchId!, identity!, paging)); break;
      case 'rollback': print(service.rollbackMigration(batchId!, revision!)); break;
      case 'forget': print(service.forgetMigratedSource(identity!)); break;
    }
  } finally { memory.close(); }
}
