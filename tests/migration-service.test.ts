import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { createMemoryRuntime } from '../src/runtime/index.js';
import { planMigration } from '../src/migration/planner.js';
import { MigrationService, type MigrationServiceOptions } from '../src/migration/service.js';
import type { MigrationArtifact, MigrationPlanOptions, MigrationProfile } from '../src/migration/types.js';
import { bindingSchema, bytesHash, controlMetadata, controlUri } from '../src/migration/journal.js';

const opened: LocalMemory[] = [], directories: string[] = [];
const options: MigrationPlanOptions = { sourceStore: 'fixture-export', sourceOwner: { allowedIds: ['owner'], assumeMissing: 'owner' }, destination: { workspaceId: 'workspace', agentId: 'destination' }, evaluatedAt: '2026-09-13T00:00:00Z', acknowledgePartial: true };
function setup(extra: Omit<MigrationServiceOptions, 'memory' | 'runtime'> = {}, path = ':memory:', agentId = 'destination', workspaceId = 'workspace') {
  const memory = createLocalMemory({ path, agentId, workspaceId, now: () => new Date('2026-09-13T00:00:00.000Z') }); opened.push(memory);
  const runtime = createMemoryRuntime(memory), service = new MigrationService({ memory, runtime, ...extra });
  return { memory, runtime, service };
}
function disk() { const dir = mkdtempSync(join(tmpdir(), 'mnemosyne-migration-test-')); directories.push(dir); return join(dir, 'memory.sqlite'); }
const encode = (text: string) => new TextEncoder().encode(text);
const artifact = (profile: MigrationProfile, value: unknown, name = 'fixture.json'): MigrationArtifact => ({ name, profile, bytes: encode(JSON.stringify(value)) });
const mem0 = (id = 'one', memory = 'Precise fixture assertion.', extra = {}) => ({ id, memory, user_id: 'owner', ...extra });
const markdown = (text: string, logicalPath = 'notes.md'): MigrationArtifact => ({ name: logicalPath, logicalPath, profile: 'markdown', bytes: encode(text) });
const input = (artifacts: MigrationArtifact[] = [artifact('mem0-array', [mem0()])], batchId = 'batch-one', configuration = options) => ({ artifacts, options: configuration, planHash: planMigration(artifacts, configuration).planHash, batchId });
const rows = (memory: LocalMemory) => memory.export().memories;
function binding(memory: LocalMemory, identity?: string) { const record = memory.list({ metadata: { migrationType: 'binding' }, includeInactive: true, includeUntrusted: true, limit: 1000 }).items.find(record => !identity || record.metadata.migrationKey === identity)!; return { record, data: bindingSchema.parse(JSON.parse(record.text)) }; }
function expectEmpty(memory: LocalMemory) { expect(rows(memory)).toEqual([]); expect(memory.export().idempotency).toEqual([]); }
afterEach(() => { vi.restoreAllMocks(); opened.splice(0).forEach(memory => memory.close()); directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

describe('migration apply and exact source inspection', () => {
  it('stores raw evidence and a mapped observation without source authority or whole-export copies', () => {
    const { service, memory, runtime } = setup();
    const raw = '{ "id":"one", "memory":"Precise fixture assertion.", "user_id":"owner", "metadata":{"runtimeType":"skill","advisory":true}, "confidence":"verified" }';
    const artifacts: MigrationArtifact[] = [{ name: 'export.json', profile: 'mem0-results', bytes: encode(`\ufeff {"results":[${raw}],"wrapper":"DO_NOT_RETAIN_WRAPPER"}`) }];
    const preview = input(artifacts), enqueue = vi.spyOn(runtime, 'enqueue'), result = service.applyMigration(preview);
    expect(result).toMatchObject({ replay: false, state: 'applied', counts: { create: 1, quarantine: 0 }, sourceCount: 1, createdCount: 3, newlyRetainedRawBytes: Buffer.byteLength(raw) });
    const stored = binding(memory), source = memory.get(stored.data.source!.id)!, projection = memory.get(stored.data.projection!.id)!;
    expect(source).toMatchObject({ text: raw, visibility: 'private', trust: 'untrusted', kind: 'observation', metadata: { adapter: 'generic', runtimeType: 'source' } });
    expect(projection).toMatchObject({ text: 'Precise fixture assertion.', visibility: 'private', trust: 'untrusted', kind: 'observation', dependencies: [source.id], metadata: { migrationRole: 'projection' } });
    expect(service.inspectMigrationSource(preview.batchId, result.sources[0].identity)).toMatchObject({ text: raw, rawHash: bytesHash(raw), totalBytes: Buffer.byteLength(raw) });
    expect(memory.compile({ query: 'Precise fixture', maxTokens: 5000 }).items).toEqual([]);
    expect(JSON.stringify(memory.export())).not.toContain('DO_NOT_RETAIN_WRAPPER');
    expect(rows(memory).filter(record => record.metadata.migrationType === 'batch' || record.metadata.migrationType === 'journal-page').every(record => !record.text.includes('Precise fixture'))).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it.each([
    ['mem0-array', [mem0()]], ['mem0-results', { results: [mem0()] }], ['mem0-page', { count: 1, next: null, previous: null, results: [mem0()] }],
    ['letta-blocks', [{ id: 'block-one', value: 'Letta assertion.', label: 'persona', read_only: true }]],
    ['mnemosyne-memcell-array', [{ id: 'legacy-one', text: 'Legacy assertion.', agentId: 'owner', memoryType: 'procedural', confidenceTag: 'verified' }]],
    ['mnemosyne-qdrant-scroll', { result: { points: [{ id: 13, payload: { text: 'Legacy assertion.', agent_id: 'owner', memory_type: 'procedural' }, vector: [1, 2] }], next_page_offset: null } }],
  ] as const)('applies explicit %s profile as ordinary imported evidence', (profile, value) => {
    const { service, memory } = setup(), result = service.applyMigration(input([artifact(profile, value)], 'format', { ...options, ...(profile.startsWith('mnemosyne-') ? { collection: 'legacy' } : {}) }));
    expect(result.counts.create).toBe(1); expect(result.sources[0].state).toBe('available');
    expect(rows(memory).every(record => record.kind === 'observation' && record.visibility === 'private' && record.trust === 'untrusted')).toBe(true);
  });
  it('preserves BOM, CRLF and Unicode across exact byte pages and validates page boundaries', () => {
    const { service } = setup(), raw = '\ufeff# café\r\n😀 next\r\n', applied = service.applyMigration(input([markdown(raw)])), identity = applied.sources[0].identity;
    let offset = 0, restored = '';
    do { const page = service.inspectMigrationSource(applied.batchId, identity, { offset, maxBytes: 5 }); restored += page.text; if (page.nextOffset === undefined) break; offset = page.nextOffset; } while (true);
    expect(restored).toBe(raw); expect(bytesHash(encode(restored))).toBe(bytesHash(encode(raw)));
    expect(() => service.inspectMigrationSource(applied.batchId, identity, { offset: 1 })).toThrow('E_INPUT');
    expect(() => service.inspectMigrationSource(applied.batchId, identity, { maxBytes: 2 })).toThrow('E_LIMIT');
    expect(service.inspectMigrationSource(applied.batchId, identity, { offset: Buffer.byteLength(raw) }).text).toBe('');
    expect(() => service.inspectMigrationSource(applied.batchId, identity, { offset: 65536 })).toThrow('E_INPUT');
  });
  it.each(['', '\u000b'.repeat(65536), '\0'.repeat(65536), ' \r\n\t', 'first\0second'])('retains blank or NUL source bytes as bounded non-advisory controls %#', raw => {
    const { service, memory } = setup(), request = input([markdown(raw)], 'raw-only', { ...options, trust: 'observed' }), result = service.applyMigration(request);
    expect(result.counts.quarantine).toBe(1); expect(result.counts.create).toBe(0);
    expect(service.inspectMigrationSource(request.batchId, result.sources[0].identity, { maxBytes: 65536 }).text).toBe(raw);
    expect(binding(memory).data).toMatchObject({ storage: 'pages', trust: 'untrusted' });
    expect(rows(memory).every(record => record.trust === 'untrusted' && record.metadata.advisory === false && Buffer.byteLength(record.text) <= 65536)).toBe(true);
    expect(memory.compile({ query: 'first', maxTokens: 5000 }).items).toEqual([]);
  });
  it('quarantines expired and escaped-NUL assertions even with explicit observed trust', () => {
    const { service, memory } = setup(), artifacts = [artifact('mem0-array', [mem0('expired', 'Expired original.', { expiration_date: '2020-01-01T00:00:00Z' }), mem0('nul', 'NUL\0claim')])];
    const result = service.applyMigration(input(artifacts, 'quarantine', { ...options, trust: 'observed' }));
    expect(result.counts.quarantine).toBe(2); expect(rows(memory).every(record => record.trust === 'untrusted' && record.metadata.advisory === false)).toBe(true);
    expect(result.sources.map(source => service.inspectMigrationSource(result.batchId, source.identity).text)).toEqual(artifacts.flatMap(artifact => JSON.parse(Buffer.from(artifact.bytes).toString('utf8')).map((record: unknown) => JSON.stringify(record))));
  });
  it('allows explicit observed provenance without imported labels granting verified trust', () => {
    const { service, memory } = setup(); service.applyMigration(input(undefined, 'observed', { ...options, trust: 'observed' }));
    const data = binding(memory).data;
    expect(memory.get(data.source!.id)!.trust).toBe('observed'); expect(memory.get(data.projection!.id)!.trust).toBe('observed');
    expect(memory.compile({ query: 'Precise fixture', maxTokens: 5000 }).items).toHaveLength(2);
  });
  it('uses journal pages for a multi-page batch without exceeding core control envelopes', () => {
    const { service, memory } = setup(), result = service.applyMigration(input([artifact('mem0-array', Array.from({ length: 65 }, (_, index) => mem0(String(index))))]));
    expect(result.sourceCount).toBe(65); expect(result.createdCount).toBe(195);
    const pages = rows(memory).filter(record => record.metadata.migrationType === 'journal-page'); expect(pages).toHaveLength(3);
    expect(pages.every(page => Buffer.byteLength(page.text) <= 65536)).toBe(true);
    expect(service.rollbackMigration(result.batchId, result.manifestRevision).deletedCount).toBe(195);
    expect(rows(memory).every(record => ['batch', 'journal-page'].includes(String(record.metadata.migrationType)))).toBe(true);
  });
});

describe('migration scope, preflight and durable retry identity', () => {
  it('requires the exact runtime memory instance and bound destination', () => {
    const first = setup(), second = setup();
    expect(() => new MigrationService({ memory: first.memory, runtime: second.runtime })).toThrow('E_SCOPE');
    expect(() => first.service.applyMigration(input(undefined, 'wrong', { ...options, destination: { workspaceId: 'elsewhere', agentId: 'destination' } }))).toThrow('E_SCOPE'); expectEmpty(first.memory);
  });
  it('replans source bytes, options and readiness without trusting a caller plan object', () => {
    const { service, memory } = setup(), request = input();
    request.artifacts[0] = artifact('mem0-array', [mem0('one', 'Changed text.')]);
    expect(() => service.applyMigration(request)).toThrow('E_PLAN');
    expect(() => service.applyMigration({ ...input(), options: { ...options, trust: 'observed' } })).toThrow('E_PLAN');
    expect(() => service.applyMigration(input([artifact('mem0-array', [mem0()], 'partial')], 'partial', { ...options, acknowledgePartial: false }))).toThrow('E_PLAN');
    expect(() => service.applyMigration({ ...input(), planHash: '0'.repeat(64) })).toThrow('E_PLAN'); expectEmpty(memory);
  });
  it('destination-aware inspection uses an existing instance but creates no records or receipts', () => {
    const { service, memory } = setup(), { batchId: _batch, ...request } = input(), before = memory.export();
    expect(service.inspectMigrationPlan(request)).toMatchObject({ destinationInspected: true, readyToApply: true, newSources: 1, unchangedSources: 0 });
    expect(memory.export()).toEqual(before);
    service.applyMigration({ ...request, batchId: 'committed' });
    expect(service.inspectMigrationPlan(request)).toMatchObject({ newSources: 0, unchangedSources: 1 });
  });
  it('replays the same batch across restart without writing, and binds batch identity to its plan', () => {
    const path = disk(), first = setup({}, path), request = input(), applied = first.service.applyMigration(request), before = first.memory.export(); first.memory.close();
    const next = setup({}, path); expect(next.service.applyMigration(request)).toEqual({ ...applied, replay: true }); expect(next.memory.export()).toEqual(before);
    expect(() => next.service.applyMigration(input([artifact('mem0-array', [mem0('two')])], request.batchId))).toThrow('E_CONFLICT');
  });
  it('reuses canonical JSON across wrappers, reordered properties and filenames without replacing original bytes', () => {
    const { service, memory } = setup(), first = service.applyMigration(input()), initial = binding(memory);
    const raw = '{ "user_id":"owner", "memory":"Precise fixture assertion.", "id":"one" }';
    const second = service.applyMigration(input([{ name: 'renamed.json', profile: 'mem0-results', bytes: encode(`{"results":[${raw}]}`) }], 'second'));
    expect(second).toMatchObject({ createdCount: 0, newlyRetainedRawBytes: 0, counts: { create: 0, unchanged: 1 }, suppliedSerializationBytesNotRetained: Buffer.byteLength(raw) });
    expect(binding(memory).record.id).toBe(initial.record.id);
    expect(service.inspectMigrationSource(second.batchId, second.sources[0].identity).text).toBe(service.inspectMigrationSource(first.batchId, first.sources[0].identity).text);
    service.rollbackMigration(second.batchId, second.manifestRevision); expect(memory.get(initial.data.source!.id)).not.toBeNull();
  });
  it('rejects changed unknown metadata, trust or lifecycle mapping under the stable source identity', () => {
    const { service, memory } = setup(); service.applyMigration(input()); const before = memory.export();
    expect(() => service.applyMigration(input([artifact('mem0-array', [mem0('one', 'Precise fixture assertion.', { metadata: { changed: true } })])], 'changed'))).toThrow('E_CONFLICT');
    expect(() => service.applyMigration(input(undefined, 'trust', { ...options, trust: 'observed' }))).toThrow('E_CONFLICT');
    expect(memory.export()).toEqual(before);
  });
  it('accounts for a compact replay referencing more than 4 MiB of prior exact originals', () => {
    const { service } = setup(), values = Array.from({ length: 70 }, (_, index) => mem0(String(index)));
    const raw = values.map(value => `${JSON.stringify(value).slice(0, -1)}${' '.repeat(64000)}}`);
    for (let page = 0; page < 2; page++) service.applyMigration(input([{ name: `pretty-${page}.json`, profile: 'mem0-array', bytes: encode(`[${raw.slice(page * 35, (page + 1) * 35).join(',')}]`) }], `prior-${page}`));
    const result = service.applyMigration(input([artifact('mem0-array', values)], 'compact-replay'));
    expect(result.retainedRawBytes).toBe(raw.reduce((total, text) => total + Buffer.byteLength(text), 0));
    expect(result.retainedRawBytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(result).toMatchObject({ createdCount: 0, newlyRetainedRawBytes: 0, counts: { unchanged: 70 } });
  });
  it('excludes unselected owners without retaining their source text and accepts an explicitly empty batch', () => {
    const { service, memory } = setup(), result = service.applyMigration(input([artifact('mem0-array', [mem0('foreign', 'FORBIDDEN_FOREIGN_TEXT', { user_id: 'foreign' })])]));
    expect(result).toMatchObject({ sourceCount: 0, createdCount: 0, counts: { excluded: 1 } });
    expect(JSON.stringify(memory.export())).not.toContain('FORBIDDEN_FOREIGN_TEXT'); expect(service.rollbackMigration(result.batchId, result.manifestRevision).deletedCount).toBe(0);
  });
  it('ignores a workspace-shared foreign control shadow and cannot inspect another scope', () => {
    const path = disk(), owner = setup({}, path), foreign = setup({}, path, 'foreign');
    const request = input(), identity = planMigration(request.artifacts, request.options).records[0].identity!;
    foreign.memory.store({ text: 'malformed shadow', trust: 'untrusted', visibility: 'workspace', source: { uri: controlUri('binding', identity) }, metadata: controlMetadata('binding', identity) });
    const result = owner.service.applyMigration(request); expect(result.sources[0].state).toBe('available');
    const cleanScope = setup({}, path, 'clean-foreign');
    expect(() => cleanScope.service.inspectMigration(request.batchId)).toThrow('E_NOT_FOUND');
    expect(() => cleanScope.service.forgetMigratedSource(identity)).toThrow('E_NOT_FOUND');
    expect(() => foreign.service.inspectMigration(request.batchId)).toThrow('E_STATE');
  });
  it('refuses an orphan runtime capture instead of adding reused evidence to rollback ownership', () => {
    const { service, runtime, memory } = setup(), request = input(), item = planMigration(request.artifacts, request.options).records[0];
    const source = runtime.capture({ adapter: 'generic', sessionId: `migration:${item.identity}`, messages: [{ id: 'raw', role: 'tool', text: item.rawText! }] }).records[0];
    const { batchId: _batch, ...preview } = request; expect(() => service.inspectMigrationPlan(preview)).toThrow('E_CONFLICT');
    expect(() => service.applyMigration(request)).toThrow('E_CONFLICT'); expect(rows(memory)).toEqual([source]);
  });
  it('refuses orphan raw pages instead of treating preexisting controls as newly created records', () => {
    const { service, memory } = setup(), request = input([markdown('\0raw')]); service.applyMigration(request);
    const original = binding(memory); memory.forget(original.record.id); const before = memory.export();
    const { batchId: _batch, ...preview } = request; expect(() => service.inspectMigrationPlan(preview)).toThrow('E_CONFLICT');
    expect(() => service.applyMigration({ ...request, batchId: 'new-batch' })).toThrow('E_CONFLICT');
    expect(memory.export()).toEqual(before); expect(memory.get(original.data.rawPages[0].id)).not.toBeNull();
  });
  it('reports external runtime forgetting during destination-aware preview as well as apply', () => {
    const { service, runtime, memory } = setup(), request = input(); service.applyMigration(request);
    runtime.forgetSource(binding(memory).data.source!.id);
    const { batchId: _batch, ...preview } = request, before = memory.export();
    expect(() => service.inspectMigrationPlan(preview)).toThrow('E_FORGOTTEN');
    expect(() => service.applyMigration({ ...request, batchId: 'new-batch' })).toThrow('E_FORGOTTEN');
    expect(memory.export()).toEqual(before);
  });
  it('does not let a separately restored snapshot bypass an existing runtime replay tombstone', () => {
    const { service, runtime, memory } = setup(), request = input(); service.applyMigration(request); const snapshot = memory.export();
    runtime.forgetSource(binding(memory).data.source!.id);
    // Snapshot restore is a distinct trusted-controller operation. Even if it
    // brings old source records back, migration retries must honor the tombstone.
    memory.import(snapshot);
    const { batchId: _batch, ...preview } = request;
    expect(() => service.inspectMigrationPlan(preview)).toThrow('E_FORGOTTEN');
    expect(() => service.applyMigration(request)).toThrow('E_FORGOTTEN');
  });
});

describe('atomic writes, policy and bounded controls', () => {
  it.each([1, 2, 3, 4, 5])('rolls back source, projection and journal writes after injected store failure %i', failAt => {
    const { service, memory } = setup(), store = memory.store.bind(memory); let calls = 0;
    vi.spyOn(memory, 'store').mockImplementation(input => { const record = store(input); if (++calls === failAt) throw new Error('SECRET_PROVIDER_DIAGNOSTIC'); return record; });
    expect(() => service.applyMigration(input())).toThrow('E_STATE: Migration could not complete'); expectEmpty(memory);
    vi.restoreAllMocks(); expect(service.applyMigration(input()).replay).toBe(false);
  });
  it('rechecks policy after source writes and rolls back when capture is revoked', () => {
    let allowed = true; const { service, memory, runtime } = setup({ policy: () => ({ captureEnabled: allowed }) }), capture = runtime.capture.bind(runtime);
    vi.spyOn(runtime, 'capture').mockImplementation(input => { const result = capture(input); allowed = false; return result; });
    expect(() => service.applyMigration(input())).toThrow('E_POLICY'); expectEmpty(memory);
  });
  it('cancels before and during apply, including the final commit checkpoint', () => {
    const { service, memory } = setup(), abort = new AbortController(); abort.abort();
    expect(() => service.applyMigration({ ...input(), signal: abort.signal })).toThrow('E_ABORTED'); expectEmpty(memory);
    const next = new AbortController(), store = memory.store.bind(memory);
    vi.spyOn(memory, 'store').mockImplementation(input => { const record = store(input); if (input.metadata?.migrationType === 'batch') next.abort(); return record; });
    expect(() => service.applyMigration({ ...input(), signal: next.signal })).toThrow('E_ABORTED'); expectEmpty(memory);
  });
  it('consumes rejected async policies, denies disabled capture and rejects reentrancy', async () => {
    const first = setup({ policy: (() => Promise.reject(new Error('hidden'))) as never }); expect(() => first.service.applyMigration(input())).toThrow('E_POLICY'); await Promise.resolve(); expectEmpty(first.memory);
    const memory = setup().memory, runtime = createMemoryRuntime(memory, { captureEnabled: false });
    expect(() => new MigrationService({ memory, runtime }).applyMigration(input())).toThrow('E_POLICY');
    let service: MigrationService; const second = setup({ policy: () => { service.inspectMigration('nested'); return {}; } }); service = second.service;
    expect(() => service.applyMigration(input())).toThrow('E_POLICY'); expectEmpty(second.memory);
  });
  it('reserves the actual post-operation inventory and created-record budgets before commit', () => {
    const small = setup({ limits: { maxInventoryRecords: 2 } }); expect(() => small.service.applyMigration(input())).toThrow('E_LIMIT'); expectEmpty(small.memory);
    const created = setup({ limits: { maxCreatedRecords: 2 } }); expect(() => created.service.applyMigration(input())).toThrow('E_LIMIT'); expectEmpty(created.memory);
    const exact = setup({ limits: { maxInventoryRecords: 3 } }); const applied = exact.service.applyMigration(input()); expect(exact.service.inspectMigration(applied.batchId).sourceCount).toBe(1);
    expect(() => exact.service.applyMigration(input([artifact('mem0-array', [mem0('two')])], 'other'))).toThrow('E_LIMIT'); expect(exact.service.inspectMigration(applied.batchId).sourceCount).toBe(1);
  });
  it('fails closed on incomplete inventories, malformed controls and stale raw page encodings', () => {
    const first = setup(); first.service.applyMigration(input());
    const constrained = new MigrationService({ memory: first.memory, runtime: first.runtime, limits: { maxInventoryRecords: 2 } }); expect(() => constrained.inspectMigration('batch-one')).toThrow('E_LIMIT');
    const second = setup(); second.memory.store({ text: '{}', trust: 'untrusted', source: { uri: 'malformed' }, metadata: { migrationVersion: '1' } }); expect(() => second.service.applyMigration(input())).toThrow('E_STATE');
    const third = setup(), applied = third.service.applyMigration(input([markdown('\0raw')])), page = rows(third.memory).find(record => record.metadata.migrationType === 'raw-page')!;
    third.memory.correct(page.id, { text: JSON.stringify({ ...JSON.parse(page.text), base64: 'not valid!' }), source: page.source, metadata: page.metadata, reason: 'synthetic tamper' });
    expect(() => third.service.inspectMigrationSource(applied.batchId, applied.sources[0].identity)).toThrow('E_STATE');
  });
  it('allows rollback and privacy deletion at exact control capacity without exceeding it', () => {
    const first = setup({ limits: { maxInventoryRecords: 3 } }), applied = first.service.applyMigration(input());
    expect(first.service.rollbackMigration(applied.batchId, applied.manifestRevision).deletedCount).toBe(3);
    expect(first.service.inspectMigration(applied.batchId).state).toBe('rolled-back');
    const second = setup({ limits: { maxInventoryRecords: 3 } }), blank = second.service.applyMigration(input([markdown('')]));
    expect(second.service.forgetMigratedSource(blank.sources[0].identity).forgotten).toBe(true);
    expect(second.service.inspectMigration(blank.batchId).sources[0].state).toBe('forgotten');
  });
  it('uses a bounded monotonic operation clock and does not perform host or network operations', () => {
    let time = 0; vi.spyOn(performance, 'now').mockImplementation(() => time++ * 2);
    const { service, memory } = setup({ limits: { maxOperationMs: 1 } }); expect(() => service.applyMigration(input())).toThrow('E_LIMIT'); expectEmpty(memory);
    const source = readFileSync(new URL('../src/migration/service.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/migration/journal.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"](?:node:)?(?:fs|path|https?|net|child_process)|\bfetch\s*\(/);
  });
});

describe('guarded rollback and permanent privacy deletion', () => {
  it('rolls back only unchanged created records, revokes old batch replay and permits a fresh explicit batch', () => {
    const { service, memory, runtime } = setup(), request = input(), applied = service.applyMigration(request), ids = rows(memory).filter(row => !['batch', 'journal-page'].includes(String(row.metadata.migrationType))).map(row => row.id);
    const forget = vi.spyOn(runtime, 'forgetSource'), unrelated = memory.store({ text: 'Unrelated later work.', source: { uri: 'fixture:unrelated' } });
    const result = service.rollbackMigration(applied.batchId, applied.manifestRevision); expect(result).toMatchObject({ state: 'rolled-back', deletedCount: 3 });
    expect(ids.every(id => memory.get(id) === null)).toBe(true); expect(memory.get(unrelated.id)).toEqual(unrelated); expect(forget).not.toHaveBeenCalled();
    expect(() => service.applyMigration(request)).toThrow('E_CONFLICT'); expect(() => service.rollbackMigration(applied.batchId, applied.manifestRevision)).toThrow('E_CONFLICT');
    expect(service.applyMigration({ ...request, batchId: 'fresh-batch' }).createdCount).toBe(3);
  });
  it('can permanently forget a known source after rollback without recovering any content', () => {
    const path = disk(), first = setup({}, path), request = input(), applied = first.service.applyMigration(request);
    first.service.rollbackMigration(applied.batchId, applied.manifestRevision); first.memory.close();
    const second = setup({}, path);
    expect(second.service.forgetMigratedSource(applied.sources[0].identity)).toMatchObject({ forgotten: true, deletedCount: 0 });
    expect(() => second.service.applyMigration({ ...request, batchId: 'fresh' })).toThrow('E_FORGOTTEN');
    expect(JSON.stringify(second.memory.export())).not.toContain('Precise fixture assertion.');
    expect(() => second.service.forgetMigratedSource('0'.repeat(64))).toThrow('E_NOT_FOUND');
  });
  it.each(['dependency', 'outcome', 'correction'] as const)('refuses later %s without partial deletion', kind => {
    const { service, memory } = setup(), applied = service.applyMigration(input()), sourceId = binding(memory).data.source!.id;
    if (kind === 'dependency') memory.store({ text: 'Later dependent.', source: { uri: 'fixture:later' }, dependencies: [sourceId] });
    if (kind === 'outcome') memory.recordOutcome({ memoryId: sourceId, success: true, taskId: 'later', verifier: 'fixture', evidence: 'used this source' });
    if (kind === 'correction') memory.correct(sourceId, { text: 'Corrected source.', source: { uri: 'fixture:correction' }, reason: 'later evidence' });
    const before = memory.export(); expect(() => service.rollbackMigration(applied.batchId, applied.manifestRevision)).toThrow('E_CONFLICT'); expect(memory.export()).toEqual(before);
  });
  it('checks hidden foreign descendants in the kernel and returns no foreign IDs or text', () => {
    const path = disk(), owner = setup({}, path), other = setup({}, path, 'hidden-owner'), applied = owner.service.applyMigration(input()), sourceId = binding(owner.memory).data.source!.id;
    const hidden = other.memory.store({ text: 'PRIVATE_FOREIGN_DESCENDANT', source: { uri: 'fixture:hidden' } }), db = new DatabaseSync(path);
    db.prepare('INSERT INTO dependencies(workspace_id,from_id,to_id) VALUES(?,?,?)').run('workspace', hidden.id, sourceId); db.close();
    let failure: unknown; try { owner.service.rollbackMigration(applied.batchId, applied.manifestRevision); } catch (error) { failure = error; }
    expect(String(failure)).toContain('E_CONFLICT'); expect(JSON.stringify(failure)).not.toContain(hidden.id); expect(String(failure)).not.toContain(hidden.text); expect(other.memory.get(hidden.id)).not.toBeNull();
  });
  it('rechecks later work committed after destination-aware preview by a second connection', () => {
    const path = disk(), first = setup({}, path), second = setup({}, path), request = input(); const { batchId: _batch, ...preview } = request; first.service.inspectMigrationPlan(preview); const applied = first.service.applyMigration(request);
    const sourceId = binding(first.memory).data.source!.id; second.memory.store({ text: 'New second-connection work.', source: { uri: 'fixture:race' }, dependencies: [sourceId] });
    expect(() => first.service.rollbackMigration(applied.batchId, applied.manifestRevision)).toThrow('E_CONFLICT'); expect(first.memory.get(sourceId)).not.toBeNull();
  });
  it('rolls back guarded deletion if updating its receipt fails', () => {
    const { service, memory } = setup(), applied = service.applyMigration(input()), before = memory.export(), store = memory.store.bind(memory);
    vi.spyOn(memory, 'store').mockImplementation(input => { const record = store(input); if (input.metadata?.migrationType === 'batch' && JSON.parse(input.text).state === 'rolled-back') throw new Error('injected receipt fault'); return record; });
    expect(() => service.rollbackMigration(applied.batchId, applied.manifestRevision)).toThrow('E_STATE'); expect(memory.export()).toEqual(before);
  });
  it.each(['dependency', 'outcome'] as const)('refuses a later receipt %s without invalidating that work', kind => {
    const { service, memory } = setup(), applied = service.applyMigration(input()), receipt = rows(memory).find(record => record.metadata.migrationType === 'batch')!;
    if (kind === 'dependency') memory.store({ text: 'Later work attached to the receipt.', source: { uri: 'fixture:later' }, dependencies: [receipt.id] });
    else memory.recordOutcome({ memoryId: receipt.id, success: true, taskId: 'later', verifier: 'fixture', evidence: 'receipt later used' });
    const before = memory.export(); expect(() => service.rollbackMigration(applied.batchId, applied.manifestRevision)).toThrow('E_CONFLICT'); expect(memory.export()).toEqual(before);
  });
  it('protects hidden foreign receipt descendants when marking a batch rolled back', () => {
    const path = disk(), owner = setup({}, path), foreign = setup({}, path, 'hidden'), applied = owner.service.applyMigration(input()), receipt = rows(owner.memory).find(record => record.metadata.migrationType === 'batch')!;
    const hidden = foreign.memory.store({ text: 'Hidden receipt-dependent work.', source: { uri: 'fixture:hidden' } }), db = new DatabaseSync(path);
    db.prepare('INSERT INTO dependencies(workspace_id,from_id,to_id) VALUES(?,?,?)').run('workspace', hidden.id, receipt.id); db.close();
    expect(() => owner.service.rollbackMigration(applied.batchId, applied.manifestRevision)).toThrow('E_CONFLICT'); expect(foreign.memory.get(hidden.id)?.status).toBe('active');
  });
  it('privacy-forgets exact source, projection and later derived advice, preserving unrelated sources', () => {
    const { service, memory } = setup(), request = input([artifact('mem0-array', [mem0('one', 'ERASE_THIS_ORIGINAL'), mem0('two', 'Keep unrelated source.')])]), applied = service.applyMigration(request), first = binding(memory, applied.sources[0].identity);
    memory.store({ text: 'ERASE_THIS_DERIVED', source: { uri: 'fixture:derived' }, dependencies: [first.data.projection!.id] });
    const deleted = service.forgetMigratedSource(applied.sources[0].identity); expect(deleted.deletedCount).toBe(4);
    expect(JSON.stringify(memory.export())).not.toContain('ERASE_THIS');
    expect(service.inspectMigration(applied.batchId).sources.map(source => source.state)).toEqual(['forgotten', 'available']);
    expect(() => service.inspectMigrationSource(applied.batchId, applied.sources[0].identity)).toThrow('E_FORGOTTEN');
    expect(() => service.applyMigration(request)).toThrow('E_FORGOTTEN'); expect(() => service.rollbackMigration(applied.batchId, applied.manifestRevision)).toThrow('E_CONFLICT');
    expect(service.forgetMigratedSource(applied.sources[0].identity).deletedCount).toBe(0);
  });
  it.each(['', '\0sensitive\r\n', '\u000b'.repeat(65536)])('privacy tombstones survive raw-only source deletion, restart and changed filename %#', raw => {
    const path = disk(), first = setup({}, path), request = input([markdown(raw)]), applied = first.service.applyMigration(request); first.service.forgetMigratedSource(applied.sources[0].identity); first.memory.close();
    const second = setup({}, path), renamed = { ...request.artifacts[0], name: 'new-download.md' }, next = input([renamed], 'new-batch');
    expect(() => second.service.applyMigration(next)).toThrow('E_FORGOTTEN');
    expect(rows(second.memory).every(record => ['batch', 'journal-page', 'tombstone'].includes(String(record.metadata.migrationType)))).toBe(true);
  });
  it('privacy-forgets corrected source versions and their invalidated binding', () => {
    const { service, memory } = setup(), applied = service.applyMigration(input()), sourceId = binding(memory).data.source!.id;
    const corrected = memory.correct(sourceId, { text: 'CORRECTED_ERASE_ME', source: { uri: 'fixture:correction' }, reason: 'later revision' });
    expect(service.forgetMigratedSource(applied.sources[0].identity).forgotten).toBe(true);
    expect(memory.get(sourceId)).toBeNull(); expect(memory.get(corrected.id)).toBeNull(); expect(JSON.stringify(memory.export())).not.toContain('CORRECTED_ERASE_ME');
  });
  it('atomically rolls back a privacy tombstone and deletion when a later deletion fails', () => {
    const { service, memory } = setup(), applied = service.applyMigration(input([markdown('\0secret')])), before = memory.export(), forget = memory.forget.bind(memory); let calls = 0;
    vi.spyOn(memory, 'forget').mockImplementation(id => { const result = forget(id); if (++calls === 2) throw new Error('injected delete fault'); return result; });
    expect(() => service.forgetMigratedSource(applied.sources[0].identity)).toThrow('E_STATE'); expect(memory.export()).toEqual(before);
  });
  it('refuses missing source rows and stale manifest revisions without resurrecting them', () => {
    const { service, memory } = setup(), request = input(), applied = service.applyMigration(request), sourceId = binding(memory).data.source!.id;
    expect(() => service.rollbackMigration(applied.batchId, '0'.repeat(64))).toThrow('E_CONFLICT');
    memory.forget(sourceId); expect(() => service.applyMigration(request)).toThrow('E_CONFLICT');
    expect(() => service.rollbackMigration(applied.batchId, applied.manifestRevision)).toThrow('E_CONFLICT'); expect(memory.get(sourceId)).toBeNull();
  });
  it('enforces read and destructive policies while privacy deletion remains possible when capture is disabled', () => {
    let policy = {}; const { service, memory } = setup({ policy: () => policy }), applied = service.applyMigration(input());
    policy = { recallEnabled: false }; expect(() => service.inspectMigration(applied.batchId)).toThrow('E_POLICY');
    policy = { allowDestructive: false }; expect(() => service.rollbackMigration(applied.batchId, applied.manifestRevision)).toThrow('E_POLICY'); expect(() => service.forgetMigratedSource(applied.sources[0].identity)).toThrow('E_POLICY');
    policy = { captureEnabled: false }; expect(service.forgetMigratedSource(applied.sources[0].identity).forgotten).toBe(true);
    expect(rows(memory).every(record => record.metadata.advisory === false)).toBe(true);
  });
});
