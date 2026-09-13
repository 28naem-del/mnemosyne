import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { MemoryRuntime } from '../src/runtime/index.js';
import { MemoryBridge, MemoryBridgeError, type LegacyMemoryMatch, type MemoryBridgeOptions } from '../src/bridge/index.js';
import { MemoryMaintenance } from '../src/maintenance/index.js';
import { MemoryAgent } from '../src/agent/index.js';
import { migrationOriginIdentity, registerMigrationOriginForgotten } from '../src/migration/origins.js';

const opened: LocalMemory[] = [], roots: string[] = [];
const one = { id: 'region', revision: 'v1', text: 'Atlas deployment region is Dubai.' };
function database(path = ':memory:', agentId = 'host') { const memory = createLocalMemory({ path, workspaceId: 'bridge-fixture', agentId }); opened.push(memory); return memory; }
function file() { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bridge-')); roots.push(root); return join(root, 'memory.db'); }
function fixture(options: Omit<MemoryBridgeOptions, 'adapter'> = {}, memory = database()) {
  let matches: LegacyMemoryMatch[] = [{ ...one }];
  const search = vi.fn(async () => matches);
  const adapter = { id: 'fixture-v1', family: 'mem0' as const, sourceStore: 'old-store', sourceOwner: 'owner', search };
  const runtime = new MemoryRuntime(memory);
  const bridge = new MemoryBridge(runtime, { adapter, trust: 'observed', promotion: { assistAfter: 1, preferAfter: 2 }, ...options });
  return { memory, runtime, bridge, adapter, search, set: (next: LegacyMemoryMatch[]) => { matches = next; } };
}
const query = { query: 'Atlas deployment', maxTokens: 8192 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
afterEach(() => { opened.splice(0).forEach(memory => { try { memory.close(); } catch {} }); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('gradual legacy coexistence', () => {
  it('does no work at construction and stages exact private sources without touching the old backend', async () => {
    const value = fixture(); const update = vi.fn(), erase = vi.fn(); Object.assign(value.adapter, { update, delete: erase });
    expect(value.search).not.toHaveBeenCalled(); expect(value.memory.export().memories).toEqual([]);
    value.set([{ ...one, text: '  Café 😀\n\tAtlas deployment  ' }]);
    const result = await value.bridge.recall(query), source = value.memory.get(result.items[0].memoryId)!;
    expect(source.text).toBe('  Café 😀\n\tAtlas deployment  '); expect(source.visibility).toBe('private'); expect(source.metadata.runtimeType).toBe('source');
    expect(JSON.parse(result.context.text).memories[0]).toMatchObject({ memoryId: source.id, uri: source.source.uri, text: source.text, route: 'legacy' });
    expect(result.context.tokens).toBe(Buffer.byteLength(result.context.text)); expect(() => value.bridge.validate(result.context)).not.toThrow();
    expect(update).not.toHaveBeenCalled(); expect(erase).not.toHaveBeenCalled(); expect(value.search).toHaveBeenCalledTimes(1);
  });

  it('promotes only successful paired local retrieval and keeps every-query reconciliation', async () => {
    const value = fixture();
    const cold = await value.bridge.recall(query); expect(cold.coverage.localMatches).toBe(0); expect(cold.status.phase).toBe('shadow');
    const warm = await value.bridge.recall(query); expect(warm.coverage.localMatches).toBe(1); expect(warm.status.phase).toBe('assist');
    const third = await value.bridge.recall(query); expect(third.items[0].route).toBe('mnemosyne'); expect(third.status.phase).toBe('prefer-mnemosyne');
    const fourth = await value.bridge.recall(query); expect(fourth.importedRevisions).toBe(0); expect(fourth.items[0].memoryId).toBe(cold.items[0].memoryId);
    expect(value.search).toHaveBeenCalledTimes(4); expect(fourth.status).toMatchObject({ totalLegacyCoverage: 'unknown', legacyReconciliation: 'every-query', legacyDisconnected: false, legacyWrites: 0 });
  });

  it('does not call a copied legacy result a local hit when actual lexical recall misses', async () => {
    const value = fixture(); value.set([{ id: 'semantic-match', revision: 'v1', text: 'Remote shipping jurisdiction is AE.' }]);
    for (let index = 0; index < 4; index++) {
      const result = await value.bridge.recall(query);
      expect(result.coverage.localMatches).toBe(0); expect(result.items[0].route).toBe('legacy'); expect(result.status.phase).toBe('shadow');
      expect(result.context.text).toContain('Remote shipping jurisdiction');
    }
  });

  it('retains all missing old results and demotes on incomplete paired coverage', async () => {
    const value = fixture(); for (let index = 0; index < 3; index++) await value.bridge.recall(query);
    value.set([{ ...one }, { id: 'new', revision: 'r1', text: 'Emergency contact is Noor.' }]);
    const result = await value.bridge.recall(query);
    expect(result.context.memoryIds).toHaveLength(2); expect(result.context.text).toContain('Emergency contact');
    expect(result.items.find(item => value.memory.get(item.memoryId)!.text.includes('Emergency'))!.route).toBe('legacy');
    expect(result.status.phase).toBe('shadow'); expect(result.coverage.fraction).toBe(0.5);
  });

  it('does not interpret an empty search as deletion or migration completion', async () => {
    const value = fixture(); const first = await value.bridge.recall(query); value.set([]);
    const result = await value.bridge.recall(query); expect(result.context.abstained).toBe(true); expect(result.status.phase).toBe('shadow');
    expect(value.memory.get(first.items[0].memoryId)!.text).toBe(one.text); expect(result.status.totalLegacyCoverage).toBe('unknown');
  });

  it('corrects changed source revisions and invalidates dependent advice; A-B-A is a fresh generation', async () => {
    const value = fixture(); const first = await value.bridge.recall(query); const id = first.items[0].memoryId;
    const derived = value.memory.store({ text: 'Deploy to Dubai.', trust: 'observed', dependencies: [id], source: { uri: 'fixture:derived' } });
    value.set([{ ...one, revision: 'v2', text: 'Atlas deployment region is Paris.' }]);
    const second = await value.bridge.recall(query); expect(second.items[0].memoryId).not.toBe(id); expect(second.context.text).toContain('Paris');
    expect(value.memory.get(derived.id)!.status).toBe('invalidated'); expect(() => value.bridge.validate(first.context)).toThrow();
    value.set([{ ...one }]); const third = await value.bridge.recall(query);
    expect(third.items[0].memoryId).not.toBe(id); expect(value.memory.get(id)!.status).toBe('superseded');
    expect(value.memory.isEligible(derived.id)).toBe(false); expect(third.context.text).toContain('Dubai');
  });

  it('rejects opaque revision equality conflicts without losing the original', async () => {
    const value = fixture(); const first = await value.bridge.recall(query); value.set([{ ...one, text: 'Secret forged replacement.' }]);
    await expect(value.bridge.recall(query)).rejects.toMatchObject({ code: 'source-conflict', legacyFallback: [] });
    expect(value.memory.get(first.items[0].memoryId)!.text).toBe(one.text);
  });

  it('keeps adoption and source identity across reopen', async () => {
    const path = file(), first = fixture({}, database(path)); for (let index = 0; index < 3; index++) await first.bridge.recall(query);
    const previous = first.bridge.status(); first.memory.close();
    const second = fixture({}, database(path)); expect(second.bridge.status()).toEqual(previous);
    const result = await second.bridge.recall(query); expect(result.items[0].route).toBe('mnemosyne'); expect(result.importedRevisions).toBe(0);
  });

  it('scopes private sources and promotion state to the selected agent', async () => {
    const path = file(), alice = fixture({}, database(path, 'alice')), bob = fixture({}, database(path, 'bob'));
    await alice.bridge.recall(query); expect(bob.memory.recall({ query: query.query })).toEqual([]);
    expect(bob.bridge.status().knownSourceIdentities).toBe(0); expect((await bob.bridge.recall(query)).importedRevisions).toBe(1);
  });

  it('defaults to untrusted searchable originals with no advisory context or promotion', async () => {
    const value = fixture({ trust: 'untrusted' }); const result = await value.bridge.recall(query);
    expect(result.context).toMatchObject({ text: '', memoryIds: [], abstained: true }); expect(result.excluded[0].reason).toBe('untrusted');
    expect(value.memory.get(result.items[0].memoryId)!.trust).toBe('untrusted'); expect(value.memory.recall({ query: query.query, includeUntrusted: true })).toHaveLength(1);
    expect((await value.bridge.recall(query)).status.phase).toBe('shadow');
  });

  it('rolls back routing immediately without erasing either system and can restart gradual adoption', async () => {
    const value = fixture(); for (let index = 0; index < 3; index++) await value.bridge.recall(query);
    const packet = await value.bridge.recall(query); const sources = packet.context.memoryIds;
    expect(value.bridge.setMode('legacy')).toMatchObject({ mode: 'legacy', phase: 'shadow' });
    expect(() => value.bridge.validate(packet.context)).toThrow();
    for (let index = 0; index < 3; index++) expect((await value.bridge.recall(query)).items.every(item => item.route === 'legacy')).toBe(true);
    expect(sources.every(id => value.memory.get(id))).toBe(true); value.bridge.setMode('auto');
    expect((await value.bridge.recall(query)).status.phase).toBe('assist');
  });
});

describe('privacy, races and bounded failure', () => {
  it('forgets the complete source generation history and blocks replay', async () => {
    const value = fixture(); const first = await value.bridge.recall(query);
    value.set([{ ...one, revision: 'v2', text: 'Atlas deployment region is Paris.' }]); const second = await value.bridge.recall(query);
    expect(value.bridge.forget(one.id).deletedCount).toBeGreaterThan(0);
    expect(value.memory.get(first.items[0].memoryId)).toBeNull(); expect(value.memory.get(second.items[0].memoryId)).toBeNull();
    const result = await value.bridge.recall(query); expect(result.items).toEqual([]); expect(result.excluded[0].reason).toBe('forgotten');
    expect(result.context.abstained).toBe(true); expect(() => value.bridge.validate(second.context)).toThrow();
  });

  it('recognizes direct runtime privacy erasure and shared full migration tombstones', async () => {
    const value = fixture(); const first = await value.bridge.recall(query); value.runtime.forgetSource(first.items[0].memoryId);
    expect((await value.bridge.recall(query)).excluded[0].reason).toBe('forgotten');
    const other = fixture(); registerMigrationOriginForgotten(other.memory, { family: 'mem0', sourceStore: 'old-store', sourceOwner: 'owner', externalId: one.id });
    expect((await other.bridge.recall(query)).context.memoryIds).toEqual([]);
  });

  it.each(['capture', 'recall', 'readOnly'])('rejects %s policy before external search', async flag => {
    const memory = database(), runtime = new MemoryRuntime(memory, { captureEnabled: flag !== 'capture', recallEnabled: flag !== 'recall' });
    const search = vi.fn(async () => [one]); const bridge = new MemoryBridge(runtime, { adapter: { id: 'v1', family: 'mem0', sourceStore: 'old', sourceOwner: 'owner', search }, policy: () => ({ readOnly: flag === 'readOnly' }) });
    await expect(bridge.recall(query)).rejects.toMatchObject({ code: 'policy' }); expect(search).not.toHaveBeenCalled();
  });

  it('allows privacy erasure with capture and recall disabled', async () => {
    const value = fixture(); await value.bridge.recall(query);
    const disabled = new MemoryBridge(new MemoryRuntime(value.memory, { captureEnabled: false, recallEnabled: false }), { adapter: value.adapter, trust: 'observed', promotion: { assistAfter: 1, preferAfter: 2 } });
    expect(disabled.forget(one.id).forgotten).toBe(true);
  });

  it('ignores timed-out callbacks, demotes and never persists provider error text', async () => {
    const value = fixture({ budgets: { timeoutMs: 15 } }); const ready = deferred<void>(), finish = deferred<LegacyMemoryMatch[]>();
    value.search.mockImplementationOnce(async () => { ready.resolve(); return finish.promise; });
    const pending = value.bridge.recall(query); await ready.promise;
    await expect(pending).rejects.toMatchObject({ code: 'timeout', legacyFallback: [] });
    finish.resolve([one]); await Promise.resolve(); await Promise.resolve();
    expect(value.memory.list({ metadata: { runtimeType: 'source' }, includeUntrusted: true }).items).toEqual([]);
    expect(value.bridge.status()).toMatchObject({ failures: 1, phase: 'shadow' });
    value.search.mockRejectedValueOnce(new Error('private provider secret')); await expect(value.bridge.recall(query)).rejects.toMatchObject({ code: 'legacy-unavailable' });
    expect(JSON.stringify(value.memory.export())).not.toContain('private provider secret');
  });

  it('rejects stale out-of-order responses across instances sharing the database', async () => {
    const path = file(), first = fixture({}, database(path)), second = fixture({}, database(path)); const start = deferred<void>(), finish = deferred<LegacyMemoryMatch[]>();
    first.search.mockImplementationOnce(async () => { start.resolve(); return finish.promise; });
    const old = first.bridge.recall(query); await start.promise;
    second.set([{ ...one, revision: 'v2', text: 'Atlas deployment region is Paris.' }]); const newer = await second.bridge.recall(query);
    finish.resolve([one]); await expect(old).rejects.toMatchObject({ code: 'superseded' });
    expect(second.memory.get(newer.items[0].memoryId)!.text).toContain('Paris'); expect(() => second.bridge.validate(newer.context)).not.toThrow();
  });

  it('rejects a late result after explicit rollback', async () => {
    const value = fixture(); const start = deferred<void>(), finish = deferred<LegacyMemoryMatch[]>();
    value.search.mockImplementationOnce(async () => { start.resolve(); return finish.promise; });
    const pending = value.bridge.recall(query); await start.promise; value.bridge.setMode('legacy'); finish.resolve([one]);
    await expect(pending).rejects.toMatchObject({ code: 'superseded' }); expect(value.bridge.status().mode).toBe('legacy');
    expect(value.memory.list({ metadata: { runtimeType: 'source' }, includeUntrusted: true }).items).toEqual([]);
  });

  it('rejects source edits during legacy search instead of overwriting the local correction', async () => {
    const value = fixture(); const first = await value.bridge.recall(query), start = deferred<void>(), finish = deferred<LegacyMemoryMatch[]>();
    value.search.mockImplementationOnce(async () => { start.resolve(); return finish.promise; });
    const pending = value.bridge.recall(query); await start.promise;
    const corrected = value.memory.correct(first.items[0].memoryId, { text: 'Local user correction.', source: { uri: 'fixture:corrected' }, reason: 'Host correction' });
    finish.resolve([one]); await expect(pending).rejects.toMatchObject({ code: 'source-conflict' }); expect(value.memory.get(corrected.id)!.status).toBe('active');
  });

  it('does not resurrect a forgotten result that was already in flight', async () => {
    const value = fixture(); const start = deferred<void>(), finish = deferred<LegacyMemoryMatch[]>();
    value.search.mockImplementationOnce(async () => { start.resolve(); return finish.promise; });
    const pending = value.bridge.recall(query); await start.promise; value.bridge.forget(one.id); finish.resolve([one]);
    await expect(pending).rejects.toMatchObject({ code: 'superseded', legacyFallback: [] });
  });

  it('fails explicitly rather than silently omitting matches under the full-envelope budget', async () => {
    const value = fixture(); let error: MemoryBridgeError | undefined;
    try { await value.bridge.recall({ ...query, maxTokens: 20 }); } catch (caught) { error = caught as MemoryBridgeError; }
    expect(error).toBeInstanceOf(MemoryBridgeError); expect(error!.code).toBe('budget'); expect(error!.legacyFallback).toEqual([one]);
    expect(value.memory.list({ metadata: { runtimeType: 'source' }, includeUntrusted: true }).items[0].text).toBe(one.text);
    expect(value.bridge.status().phase).toBe('shadow');
  });

  it('validates both bytes and a custom full-envelope tokenizer without rolling back callback erasure', async () => {
    let erase = false; let value: ReturnType<typeof fixture>;
    value = fixture({ tokenizerId: 'fixture-v1', tokenCounter: text => { if (erase) value.bridge.forget(one.id); return text.length; } });
    const first = await value.bridge.recall(query); erase = true;
    await expect(value.bridge.recall(query)).rejects.toMatchObject({ code: 'superseded' });
    expect(value.memory.get(first.items[0].memoryId)).toBeNull();
  });

  it('rejects foreign/tampered packets and changed outcomes/freshness before host dispatch', async () => {
    const value = fixture(), result = await value.bridge.recall(query), other = fixture();
    expect(() => other.bridge.validate(result.context)).toThrow(); expect(() => value.bridge.validate({ ...result.context })).toThrow();
    result.context.text += 'malicious extra'; expect(() => value.bridge.validate(result.context)).toThrow();
    const fresh = await value.bridge.recall(query);
    value.memory.recordOutcome({ memoryId: fresh.context.memoryIds[0], success: false, evidence: 'Incorrect jurisdiction', verifier: 'fixture', taskId: 'task' });
    expect(() => value.bridge.validate(fresh.context)).toThrow();
  });

  it('enforces source watch expiry and a separate reconciled packet lifetime', async () => {
    const value = fixture({ budgets: { packetLifetimeMs: 1 } });
    let monotonicTime = 1000;
    const monotonicClock = vi.spyOn(performance, 'now').mockImplementation(() => monotonicTime);
    try {
      const packet = await value.bridge.recall(query);
      expect(() => value.bridge.validate(packet.context)).not.toThrow();
      monotonicTime += 1;
      expect(() => value.bridge.validate(packet.context)).toThrow(MemoryBridgeError);
    } finally { monotonicClock.mockRestore(); }
    let clock = new Date('2030-01-01T00:00:00.000Z'); const memory = createLocalMemory({ path: ':memory:', workspaceId: 'bridge-fixture', agentId: 'host', now: () => clock }); opened.push(memory);
    const runtime = new MemoryRuntime(memory), maintenance = new MemoryMaintenance(runtime, { now: () => clock });
    const bridge = new MemoryBridge(runtime, { adapter: value.adapter, trust: 'observed', maintenance });
    const first = await bridge.recall(query), id = first.context.memoryIds[0];
    const watched = maintenance.watchMemory({ memoryId: id, maxAgeMs: 10 }); maintenance.recordCheck({ memoryId: id, expectedStateHash: watched.stateHash, observation: { status: 'confirmed', evidence: 'Fixture source checked', verifier: 'fixture' } });
    const current = await bridge.recall({ ...query, requireWatched: true }); clock = new Date(clock.getTime() + 11);
    expect(() => bridge.validate(current.context)).toThrow(); await expect(bridge.recall(query)).rejects.toMatchObject({ code: 'stale-context' });
  });

  it('integrates with MemoryAgent through an instance-bound validated context provider', async () => {
    const value = fixture(), agent = new MemoryAgent(value.runtime, { contextProvider: value.bridge.contextProvider });
    try { const before = await agent.beforeTurn(query); expect(before.context.text).toContain(one.text);
      const host = vi.fn(async () => 'Visible host response.');
      const response = await agent.runTurn({ ...query, input: 'Which region?', sessionId: 's', turnId: '1' }, host);
      expect(response.response).toBe('Visible host response.'); expect(host).toHaveBeenCalledOnce();
    } finally { await agent.close(); }
  });

  it('does not persist query or source text in adoption/control rows', async () => {
    const value = fixture(); await value.bridge.recall({ query: 'Private query material 831', maxTokens: 8192 });
    const controls = value.memory.list({ includeUntrusted: true, metadata: { runtimeType: 'bridge-control' } }).items;
    expect(controls.length).toBeGreaterThan(0); expect(JSON.stringify(controls)).not.toContain(one.text); expect(JSON.stringify(controls)).not.toContain('Private query material');
  });

  it('requires stable full-migration-compatible identity and refuses hidden scope changes', async () => {
    const value = fixture(); const first = await value.bridge.recall(query);
    expect(first.items[0].identity).toBe(migrationOriginIdentity({ family: 'mem0', sourceStore: 'old-store', sourceOwner: 'owner', externalId: one.id }));
    const changed = new MemoryBridge(value.runtime, { adapter: { ...value.adapter, id: 'different-config' }, trust: 'observed', promotion: { assistAfter: 1, preferAfter: 2 } });
    await expect(changed.recall(query)).rejects.toMatchObject({ code: 'state' });
  });

  it('requires a collection exactly for the legacy Mnemosyne family', () => {
    const value = fixture();
    expect(() => new MemoryBridge(value.runtime, { adapter: { ...value.adapter, collection: 'A' } })).toThrow();
    expect(() => new MemoryBridge(value.runtime, { adapter: { ...value.adapter, family: 'mnemosyne' } })).toThrow();
    expect(() => new MemoryBridge(value.runtime, { adapter: { ...value.adapter, family: 'mnemosyne', collection: 'memory' } })).not.toThrow();
    expect(value.search).not.toHaveBeenCalled();
  });

  it('observes asynchronous policy and tokenizer rejection without a host unhandled rejection', async () => {
    const value = fixture({ policy: (async () => { throw new Error('private policy output'); }) as unknown as NonNullable<MemoryBridgeOptions['policy']> });
    await expect(value.bridge.recall(query)).rejects.toMatchObject({ code: 'policy' });
    const tokenizer = fixture({ tokenizerId: 'invalid-async', tokenCounter: (async () => { throw new Error('private counter output'); }) as unknown as (text: string) => number });
    await expect(tokenizer.bridge.recall(query)).rejects.toMatchObject({ code: 'budget' });
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it.each(['rollback', 'abort', 'policy', 'source-edit'])('withholds fallback after %s during a tokenizer that also throws', async event => {
    const abort = new AbortController(); let readOnly = false, interfere = false; let value: ReturnType<typeof fixture>;
    value = fixture({ tokenizerId: `throw-${event}`, policy: () => ({ readOnly }), tokenCounter: text => {
      if (interfere) {
        if (event === 'rollback') value.bridge.setMode('legacy');
        if (event === 'abort') abort.abort();
        if (event === 'policy') readOnly = true;
        if (event === 'source-edit') {
          const source = value.memory.list({ metadata: { runtimeType: 'source' }, includeUntrusted: true }).items[0];
          value.memory.correct(source.id, { text: 'Locally corrected.', source: { uri: 'fixture:local' }, reason: 'Explicit host correction' });
        }
        throw new Error('private tokenizer failure');
      }
      return Buffer.byteLength(text);
    } });
    await value.bridge.recall(query); interfere = true;
    await expect(value.bridge.recall({ ...query, signal: abort.signal })).rejects.toMatchObject({ code: 'budget', legacyFallback: [] });
  });

  it('records copied revisions durably even if context budgeting fails afterward', async () => {
    const value = fixture(); await expect(value.bridge.recall({ ...query, maxTokens: 5 })).rejects.toMatchObject({ code: 'budget' });
    expect(value.bridge.status().importedRevisions).toBe(1);
    const replay = await value.bridge.recall(query); expect(replay.importedRevisions).toBe(0); expect(replay.status.importedRevisions).toBe(1);
  });

  it('does not grow past the bounded control inventory or leave a partial source import', async () => {
    const value = fixture({ budgets: { maxScanRecords: 1 } });
    await expect(value.bridge.recall(query)).rejects.toMatchObject({ code: 'budget', legacyFallback: [one] });
    expect(value.bridge.status().knownSourceIdentities).toBe(0);
    expect(value.memory.list({ includeUntrusted: true, metadata: { runtimeType: 'source' } }).items).toEqual([]);
    value.set([]); expect((await value.bridge.recall(query)).context.abstained).toBe(true);
  });

  it('uses a monotonic context lifetime despite a backward wall-clock adjustment', async () => {
    let monotonicTime = 1000;
    const monotonicClock = vi.spyOn(performance, 'now').mockImplementation(() => monotonicTime);
    const wallClock = vi.spyOn(Date, 'now');
    try {
      const value = fixture({ budgets: { packetLifetimeMs: 3 } }), packet = await value.bridge.recall(query);
      wallClock.mockReturnValue(0);
      monotonicTime += 2;
      expect(() => value.bridge.validate(packet.context)).not.toThrow();
      monotonicTime += 1;
      expect(() => value.bridge.validate(packet.context)).toThrow(MemoryBridgeError);
    } finally { wallClock.mockRestore(); monotonicClock.mockRestore(); }
  });

  it('merges private native originals without changing paired legacy coverage', async () => {
    const value = fixture(); const native = value.runtime.capture({ sessionId: 'new-agent-session', trust: 'observed', messages: [{ id: '1', role: 'user', text: 'Atlas deployment requires a canary stage.' }] }).records[0];
    const first = await value.bridge.recall(query);
    expect(first.context.memoryIds).toContain(native.id); expect(first.nativeMemoryIds).toEqual([native.id]); expect(first.coverage).toMatchObject({ legacyMatches: 1, localMatches: 0, eligibleMatches: 1 });
    const rendered = JSON.parse(first.context.text).memories; expect(rendered.find((item: { memoryId: string }) => item.memoryId === native.id).route).toBe('native');
    const replacement = value.memory.correct(native.id, { text: 'Atlas deployment now requires two canary stages.', source: { uri: 'fixture:native-update' }, reason: 'New procedure' });
    expect(() => value.bridge.validate(first.context)).toThrow();
    const fresh = await value.bridge.recall(query); expect(fresh.nativeMemoryIds).toContain(replacement.id); expect(fresh.nativeMemoryIds).not.toContain(native.id);
  });

  it('excludes unconfirmed bridge copies, migration sources and foreign native sources from the native merge', async () => {
    const path = file(), value = fixture({}, database(path)), foreign = database(path, 'foreign');
    const first = await value.bridge.recall(query); value.set([]);
    const migrationRaw = value.runtime.capture({ sessionId: 'migration:old-data', trust: 'observed', messages: [{ id: 'raw', role: 'tool', text: 'Atlas deployment stale migration value.' }] }).records[0];
    const foreignSource = foreign.store({ text: 'Atlas deployment foreign instruction.', trust: 'observed', visibility: 'workspace', source: { uri: 'fixture:foreign' } });
    const unknownBridge = value.runtime.ingestText({ uri: `bridge:${'a'.repeat(64)}`, text: 'Atlas deployment unconfirmed old source.', mimeType: 'text/plain', revision: 'old', trust: 'observed' }).records[0];
    const result = await value.bridge.recall(query);
    expect(result.context.memoryIds).not.toContain(first.items[0].memoryId); expect(result.context.memoryIds).not.toContain(migrationRaw.id);
    expect(result.context.memoryIds).not.toContain(foreignSource.id); expect(result.context.memoryIds).not.toContain(unknownBridge.id); expect(result.context.abstained).toBe(true);
  });

  it('invalidates the pending context when a native source changes during legacy search', async () => {
    const value = fixture(); const native = value.runtime.capture({ sessionId: 'native', trust: 'observed', messages: [{ id: '1', role: 'user', text: 'Atlas deployment original native preference.' }] }).records[0];
    const start = deferred<void>(), finish = deferred<LegacyMemoryMatch[]>(); value.search.mockImplementationOnce(async () => { start.resolve(); return finish.promise; });
    const pending = value.bridge.recall(query); await start.promise;
    value.memory.correct(native.id, { text: 'Atlas deployment new native preference.', source: { uri: 'fixture:changed' }, reason: 'Changed during query' });
    finish.resolve([one]); await expect(pending).rejects.toMatchObject({ code: 'stale-context', legacyFallback: [] });
  });

  it('does not turn a corrected bridge or imported source into an unconfirmed native memory', async () => {
    const value = fixture(); value.set([]);
    const bridgeSource = value.runtime.ingestText({ uri: `bridge:${'b'.repeat(64)}`, text: 'Atlas deployment old backend record.', mimeType: 'text/plain', revision: '1', trust: 'observed' }).records[0];
    const imported = value.runtime.capture({ sessionId: 'migration:other-import', trust: 'observed', messages: [{ id: 'raw', role: 'tool', text: 'Atlas deployment full migration record.' }] }).records[0];
    const disguisedBridge = value.memory.correct(bridgeSource.id, { text: 'Atlas deployment disguised bridge correction.', source: { uri: 'fixture:ordinary' }, metadata: {}, reason: 'Host edit' });
    const disguisedImport = value.memory.correct(imported.id, { text: 'Atlas deployment disguised import correction.', source: { uri: 'fixture:ordinary' }, metadata: {}, reason: 'Host edit' });
    const result = await value.bridge.recall(query);
    expect(result.nativeMemoryIds).not.toContain(disguisedBridge.id); expect(result.nativeMemoryIds).not.toContain(disguisedImport.id); expect(result.context.abstained).toBe(true);
  });
});
