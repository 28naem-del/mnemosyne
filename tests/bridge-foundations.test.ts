import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { MemoryRuntime } from '../src/runtime/index.js';
import { forgetMigrationOrigin, isMigrationOriginForgotten, migrationOriginIdentity, registerMigrationOriginForgotten, MigrationService, planMigration, type MigrationArtifact, type MigrationOrigin, type MigrationPlanOptions } from '../src/migration/index.js';
import { controlMetadata, controlUri, tombstoneSchema } from '../src/migration/journal.js';

const opened: LocalMemory[] = [], roots: string[] = [];
function setup(path = ':memory:', agentId = 'agent', workspaceId = 'workspace') {
  const memory = createLocalMemory({ path, agentId, workspaceId, now: () => new Date('2026-09-13T00:00:00.000Z') }); opened.push(memory);
  const runtime = new MemoryRuntime(memory), service = new MigrationService({ memory, runtime });
  return { memory, runtime, service };
}
function disk() { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bridge-foundation-')); roots.push(root); return join(root, 'memory.db'); }
const origin: MigrationOrigin = { family: 'mem0', sourceStore: 'fixture-store', sourceOwner: 'owner', externalId: 'entry' };
const options: MigrationPlanOptions = { sourceStore: origin.sourceStore, sourceOwner: { allowedIds: ['owner'], assumeMissing: 'owner' }, destination: { workspaceId: 'workspace', agentId: 'agent' }, evaluatedAt: '2026-09-13T00:00:00Z', acknowledgePartial: true };
const artifacts: MigrationArtifact[] = [{ name: 'supplied.json', profile: 'mem0-array', bytes: Buffer.from(JSON.stringify([{ id: 'entry', user_id: 'owner', memory: 'Private fixture text.' }])) }];
const request = (batchId = 'batch') => ({ artifacts, options, planHash: planMigration(artifacts, options).planHash, batchId });
const direct = { uri: 'fixture:document', mimeType: 'text/plain', text: '  Exact Ω source\n', trust: 'observed' as const };
const bridgeInput = (text = 'Bridge private fixture.', revision = 'first') => ({ uri: `bridge:${migrationOriginIdentity(origin)}`, mimeType: 'text/plain', text, revision });
afterEach(() => { vi.restoreAllMocks(); opened.splice(0).forEach(memory => memory.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('synchronous document ingestion foundation', () => {
  it('commits source and controller journal together, or rolls both back without consuming stable identity', () => {
    const { memory, runtime } = setup();
    expect(() => memory.atomic(() => {
      const result = runtime.ingestText(direct);
      expect(result).not.toBeInstanceOf(Promise);
      memory.store({ text: 'Controller receipt.', source: { uri: 'fixture:receipt' }, dependencies: [result.records[0].id], metadata: { advisory: false } });
      throw new Error('Fail before outer commit.');
    })).toThrow('Fail before outer commit');
    expect(memory.export().memories).toHaveLength(0); expect(memory.export().idempotency).toHaveLength(0);
    const committed = memory.atomic(() => {
      const source = runtime.ingestText(direct).records[0];
      memory.store({ text: 'Controller receipt.', source: { uri: 'fixture:receipt' }, dependencies: [source.id], metadata: { advisory: false } });
      return source;
    });
    expect(committed.text).toBe(direct.text); expect(committed.visibility).toBe('private'); expect(memory.export().memories).toHaveLength(2);
    expect(runtime.ingestText(direct).records[0].id).toBe(committed.id);
  });
  it('shares direct async identity, invalidates dependents on revision changes and preserves historical replay semantics', async () => {
    const { memory, runtime } = setup(), first = (await runtime.ingest(direct)).records[0];
    expect(runtime.ingestText(direct).records[0].id).toBe(first.id);
    const lesson = memory.store({ text: 'Derived fixture.', source: { uri: 'fixture:lesson' }, dependencies: [first.id], trust: 'observed' });
    const next = runtime.ingestText({ ...direct, text: 'Changed document.' }).records[0];
    expect(next.supersedes).toBe(first.id); expect(memory.isEligible(lesson.id)).toBe(false);
    const restored = runtime.ingestText(direct).records[0];
    expect(restored.id).not.toBe(first.id); expect(restored.supersedes).toBe(next.id);
    expect((await runtime.ingest(direct)).records[0].id).toBe(restored.id);
    expect(() => runtime.ingestText({ ...direct, text: 'Conflict.', revision: restored.source.revision })).toThrow('payload conflict');
    expect(() => runtime.ingestText({ ...direct, text: 'Changed trust.', trust: 'untrusted' })).toThrow('trust classification');
  });
  it('preserves tombstones across restart and direct/async entry points', async () => {
    const path = disk(), first = setup(path), source = first.runtime.ingestText(direct).records[0];
    first.runtime.forgetSource(source.id); first.memory.close();
    const second = setup(path);
    expect(() => second.runtime.ingestText({ ...direct, revision: 'new' })).toThrow('tombstone');
    await expect(second.runtime.ingest(direct)).rejects.toThrow('tombstone');
  });
  it.each([
    { text: '' }, { text: '   ' }, { text: 'a\0b' }, { maxInputBytes: 1 }, { maxOutputBytes: 1 },
    { mimeType: 'application/pdf' }, { data: new Uint8Array([1]) }, { extractor: async () => 'unused' }, { signal: AbortSignal.abort() },
  ])('rejects invalid direct inputs before any write (%j)', change => {
    const { memory, runtime } = setup();
    expect(() => runtime.ingestText({ ...direct, ...change })).toThrow(); expect(memory.export().memories).toHaveLength(0);
  });
  it('keeps capture-disabled ingestion inert and rejects a concurrent extraction result after a sync revision', async () => {
    const { memory, runtime } = setup();
    expect(new MemoryRuntime(memory, { captureEnabled: false }).ingestText({} as never)).toEqual({ enabled: false, records: [] });
    await expect(runtime.ingest({ uri: direct.uri, mimeType: 'text/plain', data: Buffer.from('old'), trust: 'observed', extractor: async () => {
      runtime.ingestText({ ...direct, text: 'New synchronous revision.' }); return 'Late older extraction.';
    } })).rejects.toThrow('changed during extraction');
    expect(memory.export().memories.map(record => record.text)).toEqual(['New synchronous revision.']);
  });
});

describe('shared migration origin identities and privacy lifecycle', () => {
  it.each([
    { family: 'mnemosyne' as const, externalId: '7', collection: 'legacy' },
    { family: 'mem0' as const, externalId: 'memory-id' },
    { family: 'markdown' as const, externalId: 'notes/Ω.md' },
    { family: 'letta' as const, externalId: 'block-id' },
    { family: 'langgraph' as const, externalId: JSON.stringify([['owner', 'facts'], 'item-key']) },
    { family: 'graphiti' as const, externalId: JSON.stringify(['graph-group', 'edge-id']) },
    { family: 'hindsight' as const, externalId: 'unit-id' },
    { family: 'supermemory' as const, externalId: 'doc-id' },
  ])('matches the pre-bridge full migration hash for $family', fields => {
    const input = { ...origin, ...fields }, expected = createHash('sha256').update(JSON.stringify([input.family, input.sourceStore, input.family === 'mnemosyne' ? input.collection : '', input.sourceOwner, input.externalId])).digest('hex');
    expect(migrationOriginIdentity(input)).toBe(expected);
  });
  it('matches planner IDs including folded namespace/group and unchanged bulk-import behavior', () => {
    const cases: { artifact: MigrationArtifact; externalId: string }[] = [
      { artifact: artifacts[0], externalId: origin.externalId },
      { artifact: { name: 'langgraph.json', profile: 'langgraph-store-items', bytes: Buffer.from(JSON.stringify([{ namespace: ['facts'], key: 'item', value: { text: 'Stored fact.' } }])) }, externalId: JSON.stringify([['facts'], 'item']) },
      { artifact: { name: 'graphiti.json', profile: 'graphiti-edges', bytes: Buffer.from(JSON.stringify([{ uuid: 'edge', group_id: 'group', fact: 'Stored relation.' }])) }, externalId: JSON.stringify(['group', 'edge']) },
    ];
    for (const value of cases) {
      const planned = planMigration([value.artifact], options).records[0];
      expect(planned.identity).toBe(migrationOriginIdentity({ ...origin, family: planned.family, externalId: value.externalId }));
    }
  });
  it('registers only private hashed non-advisory controls and blocks a future full import', () => {
    const { memory, service } = setup();
    expect(isMigrationOriginForgotten(memory, origin)).toBe(false);
    const first = registerMigrationOriginForgotten(memory, origin);
    expect(registerMigrationOriginForgotten(memory, origin)).toEqual({ ...first, created: false });
    expect(isMigrationOriginForgotten(memory, origin)).toBe(true);
    const row = memory.get(first.recordId)!;
    expect(row).toMatchObject({ visibility: 'private', trust: 'untrusted', metadata: { advisory: false } });
    expect(memory.isEligible(row.id)).toBe(false);
    for (const secret of [origin.sourceStore, origin.sourceOwner, origin.externalId]) expect(row.text).not.toContain(secret);
    expect(() => service.applyMigration(request())).toThrow('E_FORGOTTEN');
  });
  it('recognizes full-migration forgetting while rollback still permits a later origin import', () => {
    const { memory, service } = setup(), applied = service.applyMigration(request());
    service.rollbackMigration('batch', applied.manifestRevision);
    expect(isMigrationOriginForgotten(memory, origin)).toBe(false);
    const again = service.applyMigration(request('second')); expect(again.counts.create).toBe(1);
    service.forgetMigratedSource(again.sources[0].identity);
    expect(isMigrationOriginForgotten(memory, origin)).toBe(true);
  });
  it.each(['bridge', 'full'] as const)('erases every existing origin copy through %s privacy-forget and does not bypass a prior tombstone', path => {
    const { memory, runtime, service } = setup(), applied = service.applyMigration(request());
    const first = runtime.ingestText(bridgeInput()).records[0], next = runtime.ingestText(bridgeInput('Changed bridge private fixture.', 'second')).records[0];
    const dependent = memory.store({ text: 'Derived private fixture.', source: { uri: 'fixture:dependent' }, dependencies: [next.id] });
    const unrelated = runtime.ingestText({ ...bridgeInput(), uri: 'bridge:unrelated-user-source' }).records[0];
    registerMigrationOriginForgotten(memory, origin);
    const result = path === 'bridge' ? forgetMigrationOrigin(memory, runtime, origin) : service.forgetMigratedSource(applied.sources[0].identity);
    expect(result.deletedCount).toBe(6);
    expect(memory.get(first.id)).toBeNull(); expect(memory.get(next.id)).toBeNull(); expect(memory.get(dependent.id)).toBeNull(); expect(memory.get(unrelated.id)).not.toBeNull();
    expect(memory.list({ includeUntrusted: true, metadata: { migrationType: 'binding' } }).items).toHaveLength(0);
    expect(() => runtime.ingestText(bridgeInput('New version.', 'third'))).toThrow('tombstone');
    expect(() => service.applyMigration(request('retry'))).toThrow('E_FORGOTTEN');
    expect(forgetMigrationOrigin(memory, runtime, origin).deletedCount).toBe(0);
  });
  it('recognizes direct runtime forgetting and prevents later bulk import', () => {
    const { memory, runtime, service } = setup(), source = runtime.ingestText(bridgeInput()).records[0];
    runtime.forgetSource(source.id);
    expect(isMigrationOriginForgotten(memory, origin)).toBe(true);
    expect(() => service.applyMigration(request())).toThrow('E_FORGOTTEN');
    expect(forgetMigrationOrigin(memory, runtime, origin)).toMatchObject({ forgotten: true, deletedCount: 0 });
  });
  it('recognizes direct runtime forgetting of a full-import capture and still erases an existing bridge copy', () => {
    const { memory, runtime, service } = setup(), applied = service.applyMigration(request());
    const source = memory.list({ includeUntrusted: true, metadata: { runtimeType: 'source', sessionId: `migration:${applied.sources[0].identity}` } }).items[0];
    const bridge = runtime.ingestText(bridgeInput()).records[0];
    runtime.forgetSource(source.id);
    expect(isMigrationOriginForgotten(memory, origin)).toBe(true);
    expect(() => service.applyMigration(request('retry'))).toThrow('E_FORGOTTEN');
    // A bridge consults this common state before staging any legacy result.
    expect(isMigrationOriginForgotten(memory, applied.sources[0].identity)).toBe(true);
    expect(forgetMigrationOrigin(memory, runtime, origin).deletedCount).toBe(1);
    expect(memory.get(bridge.id)).toBeNull();
    expect(memory.list({ includeUntrusted: true, metadata: { migrationType: 'tombstone' } }).items).toHaveLength(1);
  });
  it('can preemptively forget an unseen origin but keeps public migration E_NOT_FOUND for an unknown identity', () => {
    const { memory, runtime, service } = setup(), identity = migrationOriginIdentity(origin);
    expect(() => service.forgetMigratedSource(identity)).toThrow('E_NOT_FOUND');
    expect(forgetMigrationOrigin(memory, runtime, origin)).toEqual({ identity, forgotten: true, deletedCount: 0 });
    expect(isMigrationOriginForgotten(memory, identity)).toBe(true);
  });
  it('rolls back cross-path deletion and tombstones when any write fails', () => {
    const { memory, runtime, service } = setup(); service.applyMigration(request()); runtime.ingestText(bridgeInput());
    const before = memory.export(), original = memory.store.bind(memory);
    vi.spyOn(memory, 'store').mockImplementation(input => {
      if (input.metadata?.migrationType === 'tombstone') throw new Error('Synthetic disk failure.');
      return original(input);
    });
    expect(() => forgetMigrationOrigin(memory, runtime, origin)).toThrow('E_STATE');
    expect(memory.export()).toEqual(before);
  });
  it('scopes privacy identities to the destination owner and workspace through restart', () => {
    const path = disk(), a = setup(path);
    registerMigrationOriginForgotten(a.memory, origin); a.memory.close();
    const reopened = setup(path), otherAgent = setup(path, 'another-agent'), otherWorkspace = setup(path, 'agent', 'another-workspace');
    expect(isMigrationOriginForgotten(reopened.memory, origin)).toBe(true);
    expect(isMigrationOriginForgotten(otherAgent.memory, origin)).toBe(false); expect(isMigrationOriginForgotten(otherWorkspace.memory, origin)).toBe(false);
  });
  it('fails closed on ambiguous, changed or malformed source deletion controls', () => {
    const { memory } = setup(), identity = migrationOriginIdentity(origin), first = registerMigrationOriginForgotten(memory, origin);
    const data = tombstoneSchema.parse({ version: 1, type: 'tombstone', key: identity });
    memory.store({ text: JSON.stringify(data), trust: 'untrusted', source: { uri: controlUri('tombstone', identity) }, metadata: controlMetadata('tombstone', identity) });
    expect(() => isMigrationOriginForgotten(memory, origin)).toThrow('E_STATE');
    expect(() => registerMigrationOriginForgotten(memory, origin)).toThrow('E_STATE');
    const malformed = setup();
    malformed.memory.store({ text: '{invalid json', trust: 'untrusted', source: { uri: 'fixture:bad-control' }, metadata: controlMetadata('tombstone', identity) });
    expect(() => isMigrationOriginForgotten(malformed.memory, identity)).toThrow('E_STATE');
    const changed = setup(), tombstone = registerMigrationOriginForgotten(changed.memory, origin);
    changed.memory.correct(tombstone.recordId, { text: 'Changed deletion.', source: { uri: 'fixture:changed-control' }, reason: 'Test mutation.' });
    expect(() => isMigrationOriginForgotten(changed.memory, identity)).toThrow('E_STATE');
    expect(memory.get(first.recordId)).not.toBeNull();
  });
  it('enforces bounded scans and validates identifiers before touching a database', () => {
    const { memory } = setup(), identity = migrationOriginIdentity(origin), data = tombstoneSchema.parse({ version: 1, type: 'tombstone', key: identity });
    for (let index = 0; index < 2; index++) memory.store({ text: JSON.stringify(data), trust: 'untrusted', source: { uri: controlUri('tombstone', identity) }, metadata: controlMetadata('tombstone', identity) });
    expect(() => isMigrationOriginForgotten(memory, identity, { maxScanRecords: 1 })).toThrow('E_LIMIT');
    expect(() => migrationOriginIdentity({ ...origin, sourceOwner: '' })).toThrow('E_INPUT');
    expect(() => migrationOriginIdentity({ ...origin, family: 'mnemosyne' })).toThrow('collection');
    expect(() => migrationOriginIdentity({ ...origin, externalId: '\ud800' })).toThrow('E_INPUT');
    expect(() => isMigrationOriginForgotten(memory, 'not-a-digest')).toThrow('E_INPUT');
  });
});
