import type { LocalMemory, MemoryRecord } from '../local/index.js';
import { canonical } from '../local/validation.js';
import type { MemoryRuntime } from '../runtime/index.js';
import { planMigration } from './planner.js';
import type { MigrationArtifact, MigrationPlan, MigrationPlanOptions, MigrationPlannedRecord } from './types.js';
import { bindingSchema, bytesHash, controlMetadata, controlSchema, controlUri, digest, journalKey, journalPageSchema, migrationHash, pageKey, rawPageSchema, type Batch, type Binding, type Control, type JournalPage, type Reference, type SourceEntry } from './journal.js';

export type MigrationServiceErrorCode = 'E_INPUT' | 'E_PLAN' | 'E_SCOPE' | 'E_POLICY' | 'E_ABORTED' | 'E_LIMIT' | 'E_CONFLICT' | 'E_FORGOTTEN' | 'E_NOT_FOUND' | 'E_STATE';
export class MigrationServiceError extends Error {
  constructor(readonly code: MigrationServiceErrorCode, message: string) { super(`${code}: ${message}`); this.name = 'MigrationServiceError'; }
}
export interface MigrationPolicy { captureEnabled: boolean; recallEnabled: boolean; readOnly: boolean; allowDestructive: boolean }
export interface MigrationServiceOptions {
  memory: LocalMemory;
  runtime: MemoryRuntime;
  /** Trusted synchronous policy, rechecked inside each transaction and before commit. */
  policy?: () => Partial<MigrationPolicy>;
  limits?: { maxInventoryRecords?: number; maxCreatedRecords?: number; maxOperationMs?: number };
}
export interface MigrationApplyInput {
  artifacts: readonly MigrationArtifact[];
  /** Original caller options, not the normalized plan.options object. */
  options: MigrationPlanOptions;
  planHash: string;
  batchId: string;
  signal?: AbortSignal | null;
}
export interface MigrationInspection {
  batchId: string;
  planHash: string;
  state: 'applied' | 'rolled-back';
  manifestRevision: string;
  counts: Batch['counts'];
  sourceCount: number;
  createdCount: number;
  /** Original bytes referenced by this batch, including reused originals from prior batches. */
  retainedRawBytes: number;
  newlyRetainedRawBytes: number;
  suppliedSerializationBytesNotRetained: number;
  sources: { identity: string; created: boolean; state: 'available' | 'forgotten' | 'unavailable' }[];
}
type ControlRecord<T extends Control = Control> = { record: MemoryRecord; data: T };
type Inventory = { count: number; controlKeys: Set<string>; rawPageIdentities: Set<string>; bindings: Map<string, ControlRecord<Binding>>; historicalBindings: Map<string, ControlRecord<Binding>[]>; batches: Map<string, ControlRecord<Batch>>; tombstones: Set<string> };
type Operation = 'apply' | 'inspect' | 'rollback' | 'forget';
function fail(code: MigrationServiceErrorCode, message: string): never { throw new MigrationServiceError(code, message); }
function plain(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) fail('E_INPUT', 'Expected a plain input object.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.entries(descriptors).some(([key, property]) => !allowed.includes(key) || !('value' in property))) fail('E_INPUT', 'Unexpected input fields or accessors.');
  return value as Record<string, unknown>;
}
function bounded(value: unknown, fallback: number, maximum: number, minimum = 1): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail('E_LIMIT', 'Invalid service budget.');
  return value;
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 256 || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.from(value).toString('utf8') !== value) fail('E_INPUT', 'Invalid batch identity.');
  return value;
}
function checkedDigest(value: unknown): string { if (!digest.safeParse(value).success) fail('E_INPUT', 'Expected a SHA-256 digest.'); return value as string; }

/** Offline migration controller: no filesystem, network, discovery, model calls or async work. */
export class MigrationService {
  readonly #memory: LocalMemory;
  readonly #runtime: MemoryRuntime;
  readonly #policy?: MigrationServiceOptions['policy'];
  readonly #limits: Required<NonNullable<MigrationServiceOptions['limits']>>;
  #running = false;
  #deadline = 0;
  constructor(options: MigrationServiceOptions) {
    plain(options, ['memory', 'runtime', 'policy', 'limits']);
    if (!options.memory || options.runtime?.memory !== options.memory) fail('E_SCOPE', 'runtime.memory must be the supplied scoped memory.');
    if (options.policy !== undefined && typeof options.policy !== 'function') fail('E_INPUT', 'Policy must be a function.');
    const limits = plain(options.limits ?? {}, ['maxInventoryRecords', 'maxCreatedRecords', 'maxOperationMs']);
    this.#limits = { maxInventoryRecords: bounded(limits.maxInventoryRecords, 10000, 100000), maxCreatedRecords: bounded(limits.maxCreatedRecords, 10000, 10000), maxOperationMs: bounded(limits.maxOperationMs, 10000, 60000) };
    this.#memory = options.memory; this.#runtime = options.runtime; this.#policy = options.policy;
  }
  #run<T>(operation: Operation, signal: AbortSignal | null | undefined, work: () => T): T {
    if (this.#running) fail('E_STATE', 'Reentrant migration operations are not allowed.');
    if (signal !== undefined && signal !== null && !(signal instanceof AbortSignal)) fail('E_INPUT', 'Invalid cancellation signal.');
    this.#running = true; this.#deadline = performance.now() + this.#limits.maxOperationMs;
    try { this.#permission(operation, signal); return work(); }
    catch (error) {
      if (error instanceof MigrationServiceError) throw error;
      if (error instanceof Error && error.name === 'RollbackConflictError') fail('E_CONFLICT', 'Later work or a missing record prevents atomic rollback.');
      fail('E_STATE', 'Migration could not complete; no partial transaction was committed.');
    } finally { this.#running = false; }
  }
  #permission(operation: Operation, signal?: AbortSignal | null): void {
    if (signal?.aborted) fail('E_ABORTED', 'Migration was cancelled.');
    if (performance.now() > this.#deadline) fail('E_LIMIT', 'Migration operation time budget exceeded.');
    let value: Record<string, unknown>;
    try {
      const output: unknown = this.#policy?.() ?? {};
      if (output && typeof (output as { then?: unknown }).then === 'function') { void Promise.resolve(output).catch(() => {}); fail('E_POLICY', 'Policy must be synchronous.'); }
      value = plain(output, ['captureEnabled', 'recallEnabled', 'readOnly', 'allowDestructive']);
      if (Object.values(value).some(flag => typeof flag !== 'boolean')) fail('E_POLICY', 'Invalid policy flags.');
    } catch { fail('E_POLICY', 'Current migration policy is unavailable.'); }
    if (operation === 'inspect' ? !this.#runtime.recallEnabled || value.recallEnabled === false : value.readOnly === true) fail('E_POLICY', 'Operation is disabled by current policy.');
    if (operation === 'apply' && (!this.#runtime.captureEnabled || value.captureEnabled === false)) fail('E_POLICY', 'Capture is disabled by current policy.');
    if ((operation === 'rollback' || operation === 'forget') && value.allowDestructive === false) fail('E_POLICY', 'Destructive operations are disabled by current policy.');
  }
  #batchKey(batchId: string): string { return migrationHash(['batch', this.#memory.workspaceId, this.#memory.agentId, token(batchId)]); }
  #reference(record: MemoryRecord): Reference {
    const fingerprint = this.#memory.getRecordFingerprint(record.id);
    if (!fingerprint) fail('E_STATE', 'A just-written migration record is unavailable.');
    return { id: record.id, fingerprint };
  }
  #control(record: MemoryRecord): Control {
    let data: Control;
    try { data = controlSchema.parse(JSON.parse(record.text)); } catch { return fail('E_STATE', 'Invalid persisted migration control data.'); }
    if (record.agentId !== this.#memory.agentId || record.workspaceId !== this.#memory.workspaceId || record.visibility !== 'private' || record.trust !== 'untrusted' || record.kind !== 'observation' || record.evidence || record.key || record.validFrom || record.validUntil || record.supersedes
      || canonical(record.metadata) !== canonical(controlMetadata(data.type, data.key)) || canonical(record.source) !== canonical({ uri: controlUri(data.type, data.key) })) fail('E_STATE', 'Invalid persisted migration control envelope.');
    if (data.type === 'batch' && ((data.state === 'rolled-back') !== !!data.rollbackOf || (data.rollbackOf && this.#memory.get(data.rollbackOf.id)))) fail('E_STATE', 'Invalid migration receipt transition.');
    const dependencies = data.type === 'binding' && data.source ? [data.source.id] : [];
    if (canonical(record.dependencies) !== canonical(dependencies)) fail('E_STATE', 'Invalid migration control lineage.');
    if (data.type === 'binding' && (data.origin.endByte - data.origin.startByte !== data.rawBytes || (data.storage === 'capture') !== !!data.source || (data.storage === 'capture' && (data.rawPages.length || data.disposition !== 'create')) || (data.storage === 'pages' && (data.trust !== 'untrusted' || data.disposition !== 'quarantine' || data.projection || data.textHash)) || !!data.projection !== !!data.textHash)) fail('E_STATE', 'Invalid migration source layout.');
    if (data.type === 'raw-page' && data.key !== pageKey(data.identity, data.rawHash, data.index)) fail('E_STATE', 'Invalid raw page identity.');
    if (data.type === 'journal-page' && data.key !== journalKey(data.batchKey, data.index)) fail('E_STATE', 'Invalid journal page identity.');
    return data;
  }
  #inventory(): Inventory {
    const result: Inventory = { count: 0, controlKeys: new Set(), rawPageIdentities: new Set(), bindings: new Map(), historicalBindings: new Map(), batches: new Map(), tombstones: new Set() };
    const seen = new Set<string>(); let cursor: string | undefined;
    do {
      const page = this.#memory.list({ metadata: { migrationVersion: '1' }, includeInactive: true, includeUntrusted: true, limit: Math.min(1000, this.#limits.maxInventoryRecords), cursor });
      result.count += page.items.length;
      if (result.count > this.#limits.maxInventoryRecords || (page.nextCursor && result.count >= this.#limits.maxInventoryRecords)) fail('E_LIMIT', 'Migration control inventory exceeds the scan budget.');
      for (const record of page.items) {
        if (record.agentId !== this.#memory.agentId) continue;
        const data = this.#control(record);
        result.controlKeys.add(`${data.type}:${data.key}`);
        if (data.type === 'raw-page') result.rawPageIdentities.add(data.identity);
        if (data.type === 'tombstone') result.tombstones.add(data.key);
        if (data.type === 'binding') result.historicalBindings.set(data.key, [...(result.historicalBindings.get(data.key) ?? []), { record, data }]);
        if (record.status !== 'active') continue;
        const unique = `${data.type}:${data.key}`;
        if (seen.has(unique)) fail('E_STATE', 'Conflicting active migration controls.');
        seen.add(unique);
        if (data.type === 'binding') result.bindings.set(data.key, { record, data });
        if (data.type === 'batch') result.batches.set(data.key, { record, data });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return result;
  }
  #readReference(reference: Reference, active = true): MemoryRecord {
    const record = this.#memory.get(reference.id);
    if (!record || record.agentId !== this.#memory.agentId || record.visibility !== 'private' || record.workspaceId !== this.#memory.workspaceId || (active && record.status !== 'active') || this.#memory.getRecordFingerprint(reference.id) !== reference.fingerprint) fail('E_CONFLICT', 'A migration record is unavailable or has changed.');
    return record;
  }
  #raw(binding: ControlRecord<Binding>): Buffer {
    const { data, record } = binding;
    this.#control(record);
    if (record.status !== 'active') fail('E_CONFLICT', 'Migrated source has changed.');
    let bytes: Buffer;
    if (data.source) {
      const source = this.#readReference(data.source);
      const sessionId = `migration:${data.key}`, ingestKey = `capture:${migrationHash(['generic', sessionId, 'raw'])}`;
      if (source.kind !== 'observation' || source.trust !== data.trust || source.supersedes || source.dependencies.length || source.evidence || source.key || source.validFrom || source.validUntil
        || canonical(source.metadata) !== canonical({ runtimeType: 'source', sessionId, adapter: 'generic', cursor: 'raw', role: 'tool', ingestKey })
        || canonical(source.source) !== canonical({ uri: `transcript://generic/${encodeURIComponent(sessionId)}/raw`, revision: migrationHash({ id: 'raw', role: 'tool', text: source.text }) })
        || this.#memory.getOutcomeSummary(source.id).failures) fail('E_CONFLICT', 'Captured source lineage is no longer valid.');
      bytes = Buffer.from(source.text);
    } else {
      const chunks = data.rawPages.map((reference, index) => {
        const record = this.#readReference(reference), page = rawPageSchema.parse(this.#control(record));
        if (page.identity !== data.key || page.rawHash !== data.rawHash || page.index !== index) fail('E_STATE', 'Raw source pages do not match their binding.');
        const bytes = Buffer.from(page.base64, 'base64');
        if (bytes.length > 16384 || bytes.toString('base64') !== page.base64 || (index < data.rawPages.length - 1 && bytes.length !== 16384)) fail('E_STATE', 'Invalid persisted source byte encoding.');
        return bytes;
      });
      bytes = Buffer.concat(chunks);
    }
    if (bytes.length !== data.rawBytes || bytesHash(bytes) !== data.rawHash) fail('E_STATE', 'Retained source bytes failed integrity validation.');
    try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail('E_STATE', 'Retained source bytes are not UTF-8.'); }
    if (data.projection) {
      const projection = this.#readReference(data.projection);
      if (projection.kind !== 'observation' || projection.trust !== data.trust || projection.supersedes || projection.evidence || projection.key || projection.validFrom || projection.validUntil || canonical(projection.dependencies) !== canonical([data.source!.id])
        || canonical(projection.metadata) !== canonical({ migrationIdentity: data.key, migrationRole: 'projection' })
        || canonical(projection.source) !== canonical({ uri: `migration:assertion:${data.key}`, revision: data.canonicalHash }) || bytesHash(projection.text) !== data.textHash
        || this.#memory.getOutcomeSummary(projection.id).failures) fail('E_CONFLICT', 'Mapped observation lineage is no longer valid.');
    }
    return bytes;
  }
  #journals(batch: Batch): { sources: SourceEntry[]; created: Reference[] } {
    const sources: SourceEntry[] = [], created: Reference[] = [];
    batch.journalPages.forEach((reference, index) => {
      const record = this.#readReference(reference), data = journalPageSchema.parse(this.#control(record));
      if (data.batchKey !== batch.key || data.index !== index) fail('E_STATE', 'Batch journal identity mismatch.');
      sources.push(...data.sources); created.push(...data.created);
    });
    if (sources.length !== batch.sourceCount || created.length !== batch.createdCount || new Set(sources.map(source => source.identity)).size !== sources.length || new Set(created.map(record => record.id)).size !== created.length) fail('E_STATE', 'Batch journal is incomplete or duplicated.');
    return { sources, created };
  }
  #storeControl(data: Control, inventory: Inventory, dependencies: string[] = []): MemoryRecord {
    const key = `${data.type}:${data.key}`;
    if (inventory.controlKeys.has(key)) fail('E_CONFLICT', 'A migration control already exists without a reusable source binding.');
    if (++inventory.count > this.#limits.maxInventoryRecords) fail('E_LIMIT', 'Migration controls would exceed the scan budget.');
    const parsed = controlSchema.parse(data), text = JSON.stringify(parsed);
    if (Buffer.byteLength(text) > 65536) fail('E_LIMIT', 'Migration control exceeds the core text budget.');
    const record = this.#memory.store({ text, kind: 'observation', trust: 'untrusted', visibility: 'private', source: { uri: controlUri(parsed.type, parsed.key) }, metadata: controlMetadata(parsed.type, parsed.key), dependencies, idempotencyKey: `migration:${parsed.type}:${parsed.key}` });
    if (record.status !== 'active' || record.supersedes) fail('E_CONFLICT', 'Migration control identity was previously changed.');
    this.#control(record);
    inventory.controlKeys.add(key);
    return record;
  }
  #plan(input: Omit<MigrationApplyInput, 'batchId'>): MigrationPlan {
    checkedDigest(input.planHash);
    let plan: MigrationPlan;
    try { plan = planMigration(input.artifacts, input.options); } catch { return fail('E_PLAN', 'Migration input or options could not be replanned.'); }
    if (plan.planHash !== input.planHash || !plan.report.readyToApply) fail('E_PLAN', 'The supplied plan changed or is not ready to apply.');
    if (plan.options.destination.workspaceId !== this.#memory.workspaceId || plan.options.destination.agentId !== this.#memory.agentId) fail('E_SCOPE', 'Plan destination does not match this memory scope.');
    return plan;
  }
  #preflight(plan: MigrationPlan, inventory: Inventory): { records: MigrationPlannedRecord[]; reused: Map<string, ControlRecord<Binding>> } {
    const records = plan.records.filter(record => record.disposition === 'create' || record.disposition === 'quarantine');
    const reused = new Map<string, ControlRecord<Binding>>();
    for (const record of records) {
      if (!record.identity || !record.canonicalHash || record.rawText === undefined) fail('E_PLAN', 'A retained source lacks its required identity or raw bytes.');
      if (inventory.tombstones.has(record.identity)) fail('E_FORGOTTEN', 'A source identity was privacy-forgotten; replay is blocked.');
      const ingestKey = `capture:${migrationHash(['generic', `migration:${record.identity}`, 'raw'])}`;
      const ownedRuntimeRecord = (metadata: Record<string, string>): boolean => {
        const page = this.#memory.list({ metadata, includeInactive: true, includeUntrusted: true, limit: Math.min(1000, this.#limits.maxInventoryRecords) });
        if (page.nextCursor) fail('E_LIMIT', 'Runtime identity inventory exceeds the scan budget.');
        return page.items.some(item => item.agentId === this.#memory.agentId);
      };
      if (ownedRuntimeRecord({ runtimeType: 'tombstone', identity: migrationHash(ingestKey) })) fail('E_FORGOTTEN', 'Runtime capture identity was privacy-forgotten.');
      const binding = inventory.bindings.get(record.identity);
      if (!binding) {
        if (inventory.historicalBindings.has(record.identity) || inventory.rawPageIdentities.has(record.identity) || ownedRuntimeRecord({ runtimeType: 'source', ingestKey })) fail('E_CONFLICT', 'Source records exist without a reusable migration binding.');
        continue;
      }
      if (binding.data.canonicalHash !== record.canonicalHash || binding.data.trust !== record.trust || binding.data.disposition !== record.disposition || binding.data.textHash !== (record.text === undefined ? undefined : bytesHash(record.text))) fail('E_CONFLICT', 'A stable source identity has a different payload or mapping.');
      this.#raw(binding); reused.set(record.identity, binding);
    }
    return { records, reused };
  }
  inspectMigrationPlan(input: Omit<MigrationApplyInput, 'batchId'>) {
    plain(input, ['artifacts', 'options', 'planHash', 'signal']);
    return this.#run('inspect', input.signal, () => this.#memory.atomic(() => {
      const plan = this.#plan(input), inventory = this.#inventory(), { records, reused } = this.#preflight(plan, inventory);
      this.#permission('inspect', input.signal);
      return { destinationInspected: true as const, readyToApply: true as const, planHash: plan.planHash, newSources: records.length - reused.size, unchangedSources: reused.size, sourceIdentities: records.map(record => record.identity!) };
    }));
  }
  applyMigration(input: MigrationApplyInput): MigrationInspection & { replay: boolean } {
    plain(input, ['artifacts', 'options', 'planHash', 'batchId', 'signal']);
    return this.#run('apply', input.signal, () => {
      const batchId = token(input.batchId), key = this.#batchKey(batchId), plan = this.#plan(input);
      return this.#memory.atomic(() => {
        this.#permission('apply', input.signal);
        const inventory = this.#inventory(), prior = inventory.batches.get(key);
        if (prior && (prior.data.planHash !== plan.planHash || prior.data.state !== 'applied')) fail('E_CONFLICT', 'Batch identity has a different plan or was rolled back.');
        const { records, reused } = this.#preflight(plan, inventory);
        if (prior) {
          if (reused.size !== records.length) fail('E_CONFLICT', 'A previously committed batch source is missing.');
          const result = this.#inspection(batchId, prior, inventory);
          if (result.sources.some(source => source.state !== 'available')) fail('E_CONFLICT', 'A previously committed batch source is unavailable.');
          this.#permission('apply', input.signal); return { ...result, replay: true };
        }
        const counts = { ...plan.report.counts }, sources: SourceEntry[] = [], created: Reference[] = [];
        let retainedRawBytes = 0, newlyRetainedRawBytes = 0, suppliedSerializationBytesNotRetained = plan.report.accounting.duplicateRawBytesNotRetained;
        const track = (record: MemoryRecord): Reference => {
          if (created.length >= this.#limits.maxCreatedRecords) fail('E_LIMIT', 'Created record budget exceeded.');
          const reference = this.#reference(record); created.push(reference); return reference;
        };
        for (const item of records) {
          this.#permission('apply', input.signal);
          const identity = item.identity!, existing = reused.get(identity);
          if (existing) {
            counts[item.disposition as 'create' | 'quarantine']--; counts.unchanged++;
            retainedRawBytes += existing.data.rawBytes; suppliedSerializationBytesNotRetained += item.rawBytes;
            sources.push({ identity, binding: this.#reference(existing.record), created: false }); continue;
          }
          const raw = Buffer.from(item.rawText!), data: Binding = { version: 1, type: 'binding', key: identity, canonicalHash: item.canonicalHash!, rawHash: item.rawHash, rawBytes: item.rawBytes, trust: item.trust, disposition: item.disposition as 'create' | 'quarantine', storage: item.disposition === 'create' ? 'capture' : 'pages', rawPages: [], origin: { inputHash: plan.inputs[item.artifactIndex].sha256, startByte: item.startByte, endByte: item.endByte, profile: item.profile } };
          if (raw.length !== item.rawBytes || bytesHash(raw) !== item.rawHash) fail('E_PLAN', 'Replanned raw source bytes are inconsistent.');
          if (data.storage === 'capture') {
            const result = this.#runtime.capture({ adapter: 'generic', sessionId: `migration:${identity}`, messages: [{ id: 'raw', role: 'tool', text: item.rawText! }], trust: item.trust, visibility: 'private' });
            if (!result.enabled || result.records.length !== 1) fail('E_POLICY', 'Runtime capture did not accept the source.');
            data.source = track(result.records[0]);
            if (item.text !== undefined) {
              const projection = this.#memory.store({ text: item.text, kind: 'observation', trust: item.trust, visibility: 'private', source: { uri: `migration:assertion:${identity}`, revision: item.canonicalHash! }, dependencies: [data.source.id], metadata: { migrationIdentity: identity, migrationRole: 'projection' } });
              data.projection = track(projection); data.textHash = bytesHash(item.text);
            }
          } else {
            for (let offset = 0, index = 0; offset < raw.length; offset += 16384, index++) data.rawPages.push(track(this.#storeControl({ version: 1, type: 'raw-page', key: pageKey(identity, item.rawHash, index), identity, rawHash: item.rawHash, index, base64: raw.subarray(offset, offset + 16384).toString('base64') }, inventory)));
          }
          const binding = this.#storeControl(data, inventory, data.source ? [data.source.id] : []);
          sources.push({ identity, binding: track(binding), created: true });
          this.#raw({ record: binding, data });
          retainedRawBytes += data.rawBytes; newlyRetainedRawBytes += data.rawBytes;
        }
        const pages: Reference[] = [];
        for (let offset = 0; offset < sources.length; offset += 32) {
          const selected = sources.slice(offset, offset + 32), owned = new Set(selected.filter(source => source.created).map(source => source.binding.id));
          for (const source of selected.filter(source => source.created)) {
            const binding = bindingSchema.parse(this.#control(this.#memory.get(source.binding.id)!));
            if (binding.source) owned.add(binding.source.id); if (binding.projection) owned.add(binding.projection.id); binding.rawPages.forEach(page => owned.add(page.id));
          }
          const page: JournalPage = { version: 1, type: 'journal-page', key: journalKey(key, pages.length), batchKey: key, index: pages.length, sources: selected, created: created.filter(record => owned.has(record.id)) };
          pages.push(this.#reference(this.#storeControl(page, inventory)));
        }
        const data: Batch = { version: 1, type: 'batch', key, planHash: plan.planHash, state: 'applied', counts, sourceCount: sources.length, createdCount: created.length, retainedRawBytes, newlyRetainedRawBytes, suppliedSerializationBytesNotRetained, journalPages: pages, inputHashes: plan.inputs.map(input => input.sha256) };
        const record = this.#storeControl(data, inventory);
        this.#journals(data);
        const result = { ...this.#inspection(batchId, { record, data }, this.#inventory()), replay: false };
        this.#permission('apply', input.signal); return result;
      });
    });
  }
  #inspection(batchId: string, batch: ControlRecord<Batch>, inventory: Inventory): MigrationInspection {
    const { sources } = this.#journals(batch.data);
    return { batchId, planHash: batch.data.planHash, state: batch.data.state, manifestRevision: this.#reference(batch.record).fingerprint, counts: { ...batch.data.counts }, sourceCount: batch.data.sourceCount, createdCount: batch.data.createdCount, retainedRawBytes: batch.data.retainedRawBytes, newlyRetainedRawBytes: batch.data.newlyRetainedRawBytes, suppliedSerializationBytesNotRetained: batch.data.suppliedSerializationBytesNotRetained,
      sources: sources.map(source => {
        let state: 'available' | 'forgotten' | 'unavailable' = inventory.tombstones.has(source.identity) ? 'forgotten' : 'unavailable';
        const binding = inventory.bindings.get(source.identity);
        if (state !== 'forgotten' && binding && binding.record.id === source.binding.id && this.#memory.getRecordFingerprint(binding.record.id) === source.binding.fingerprint) {
          try { this.#raw(binding); state = 'available'; } catch (error) { if (!(error instanceof MigrationServiceError) || error.code !== 'E_CONFLICT') throw error; }
        }
        return { identity: source.identity, created: source.created, state };
      }) };
  }
  inspectMigration(batchId: string): MigrationInspection {
    return this.#run('inspect', undefined, () => this.#memory.atomic(() => {
      const key = this.#batchKey(batchId), inventory = this.#inventory(), batch = inventory.batches.get(key);
      if (!batch) fail('E_NOT_FOUND', 'Migration batch was not found.');
      const result = this.#inspection(batchId, batch, inventory); this.#permission('inspect'); return result;
    }));
  }
  inspectMigrationSource(batchId: string, sourceIdentity: string, options: { offset?: number; maxBytes?: number; signal?: AbortSignal | null } = {}) {
    plain(options, ['offset', 'maxBytes', 'signal']);
    return this.#run('inspect', options.signal, () => this.#memory.atomic(() => {
      const identity = checkedDigest(sourceIdentity), inventory = this.#inventory(), batch = inventory.batches.get(this.#batchKey(batchId));
      if (!batch) fail('E_NOT_FOUND', 'Migration batch was not found.');
      if (inventory.tombstones.has(identity)) fail('E_FORGOTTEN', 'Source was privacy-forgotten.');
      const entry = this.#journals(batch.data).sources.find(source => source.identity === identity), binding = inventory.bindings.get(identity);
      if (batch.data.state !== 'applied' || !entry || !binding || binding.record.id !== entry.binding.id || this.#memory.getRecordFingerprint(binding.record.id) !== entry.binding.fingerprint) fail('E_NOT_FOUND', 'Source is not available in this batch.');
      const bytes = this.#raw(binding), offset = bounded(options.offset, 0, 65536, 0), maxBytes = bounded(options.maxBytes, 8192, 65536);
      if (offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)) fail('E_INPUT', 'Source offset must be a UTF-8 character boundary.');
      let end = Math.min(bytes.length, offset + maxBytes);
      while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      if (end === offset && offset < bytes.length) fail('E_LIMIT', 'Page budget cannot fit the next UTF-8 character.');
      this.#permission('inspect', options.signal);
      return { identity, text: bytes.subarray(offset, end).toString('utf8'), offset, ...(end < bytes.length ? { nextOffset: end } : {}), totalBytes: bytes.length, rawHash: binding.data.rawHash, trust: binding.data.trust, disposition: binding.data.disposition, origin: { ...binding.data.origin } };
    }));
  }
  rollbackMigration(batchId: string, expectedManifestRevision: string, options: { signal?: AbortSignal | null } = {}) {
    plain(options, ['signal']); checkedDigest(expectedManifestRevision);
    return this.#run('rollback', options.signal, () => this.#memory.atomic(() => {
      const inventory = this.#inventory(), batch = inventory.batches.get(this.#batchKey(batchId));
      if (!batch) fail('E_NOT_FOUND', 'Migration batch was not found.');
      if (batch.data.state !== 'applied' || this.#reference(batch.record).fingerprint !== expectedManifestRevision) fail('E_CONFLICT', 'Migration receipt changed or was already rolled back.');
      const journal = this.#journals(batch.data);
      const expected: Reference[] = [];
      for (const source of journal.sources.filter(source => source.created)) {
        const binding = inventory.bindings.get(source.identity);
        if (inventory.tombstones.has(source.identity) || !binding || binding.record.id !== source.binding.id) fail('E_CONFLICT', 'A created source is missing or privacy-forgotten.');
        this.#readReference(source.binding); this.#raw(binding);
        expected.push(source.binding, ...binding.data.rawPages, ...(binding.data.source ? [binding.data.source] : []), ...(binding.data.projection ? [binding.data.projection] : []));
      }
      const ordered = (records: Reference[]) => [...records].sort((a, b) => a.id.localeCompare(b.id));
      if (canonical(ordered(expected)) !== canonical(ordered(journal.created))) fail('E_STATE', 'Rollback ownership does not match its source bindings.');
      this.#permission('rollback', options.signal);
      // Replacing a receipt must not invalidate later work depending on it.
      // Guard and remove the old receipt too, then write its terminal successor.
      // The terminal record cannot be revived through the old batch identity.
      const rollbackOf = this.#reference(batch.record);
      this.#memory.rollbackUnchangedRecords({ records: [...journal.created, rollbackOf] });
      const data: Batch = { ...batch.data, state: 'rolled-back', rollbackOf };
      const record = this.#storeControl(data, this.#inventory());
      this.#control(record); this.#permission('rollback', options.signal);
      return { batchId, state: 'rolled-back' as const, manifestRevision: this.#reference(record).fingerprint, deletedCount: journal.created.length };
    }));
  }
  forgetMigratedSource(sourceIdentity: string, options: { signal?: AbortSignal | null } = {}) {
    plain(options, ['signal']);
    return this.#run('forget', options.signal, () => this.#memory.atomic(() => {
      const identity = checkedDigest(sourceIdentity), inventory = this.#inventory();
      if (inventory.tombstones.has(identity)) return { identity, forgotten: true as const, deletedCount: 0 };
      const history = inventory.historicalBindings.get(identity) ?? [];
      if (history.length > 1) fail('E_STATE', 'Source identity has conflicting bindings.');
      const binding = history[0];
      if (!binding) {
        // An undo removes source bytes, but the caller can still explicitly
        // turn that known prior identity into a permanent privacy deletion.
        const rolledBack = [...inventory.batches.values()].some(batch => batch.data.state === 'rolled-back' && this.#journals(batch.data).sources.some(source => source.identity === identity && source.created));
        if (!rolledBack) fail('E_NOT_FOUND', 'Migrated source was not found.');
        this.#permission('forget', options.signal);
        this.#storeControl({ version: 1, type: 'tombstone', key: identity }, inventory);
        this.#permission('forget', options.signal);
        return { identity, forgotten: true as const, deletedCount: 0 };
      }
      // Privacy deletion may remove corrected/invalidated source versions; it is
      // deliberately broader than rollback and does not depend on old fingerprints.
      const data = bindingSchema.parse(this.#control(binding.record));
      const ids = [binding.record.id, ...(data.source ? [data.source.id] : []), ...data.rawPages.map(page => page.id), ...(data.projection ? [data.projection.id] : [])];
      for (const id of ids) { const record = this.#memory.get(id); if (record && (record.agentId !== this.#memory.agentId || record.visibility !== 'private')) fail('E_CONFLICT', 'Source deletion ownership changed.'); }
      const deleted = new Set<string>();
      for (const id of ids) { this.#permission('forget', options.signal); if (this.#memory.get(id)) this.#memory.forget(id).deletedIds.forEach(id => deleted.add(id)); }
      // The outer transaction makes deletion and tombstoning inseparable. Check
      // the post-deletion inventory so a full namespace can still forget data.
      this.#storeControl({ version: 1, type: 'tombstone', key: identity }, this.#inventory());
      this.#permission('forget', options.signal);
      return { identity, forgotten: true as const, deletedCount: deleted.size };
    }));
  }
}
