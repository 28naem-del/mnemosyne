import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalMemory, type LocalMemory, type MemoryRecord } from '../src/local/index.js';
import { MemoryRuntime } from '../src/runtime/index.js';
import { MemoryMaintenance, type MaintenanceOptions } from '../src/maintenance/index.js';

const opened: LocalMemory[] = [];
const confirmed = { status: 'confirmed' as const, evidence: 'Fixture source checked and claim confirmed', verifier: 'fixture-controller' };
function fixture(options: MaintenanceOptions = {}) {
  let time = Date.parse('2026-09-01T00:00:00.000Z'); const now = () => new Date(time);
  const memory = createLocalMemory({ path: ':memory:', workspaceId: 'fixture', agentId: 'alice', now }); opened.push(memory);
  const runtime = new MemoryRuntime(memory, { now }), maintenance = new MemoryMaintenance(runtime, { now, ...options });
  const store = (text = 'Use release preview', dependencies: string[] = []) => memory.store({ text, source: { uri: 'fixture://source', revision: 'r1' }, trust: 'observed', kind: 'observation', dependencies });
  const watch = (record: MemoryRecord, maxAgeMs = 1000, priority = 0) => maintenance.watchMemory({ memoryId: record.id, maxAgeMs, priority });
  const confirm = (record: MemoryRecord) => maintenance.recordCheck({ memoryId: record.id, expectedStateHash: maintenance.assess(record.id).stateHash, observation: confirmed });
  return { memory, runtime, maintenance, store, watch, confirm, now, advance: (ms: number) => { time += ms; } };
}
afterEach(() => { vi.useRealTimers(); for (const memory of opened.splice(0)) memory.close(); });

describe('evidence-based source freshness', () => {
  it('starts unchecked and never treats creation or retrieval as confirmation', () => {
    const f = fixture(), source = f.store();
    expect(f.maintenance.assess(source.id).status).toBe('unwatched');
    expect(f.watch(source).status).toBe('needs-check');
    const before = f.memory.export();
    expect(f.maintenance.scan().items[0].status).toBe('needs-check');
    expect(f.maintenance.recall({ query: 'release' }).items).toEqual([]);
    expect(f.memory.export()).toEqual(before);
    expect(f.memory.get(source.id)).toEqual(source);
  });

  it('ages from the last evidenced confirmation and blocks stale dependent advice', () => {
    const f = fixture(), source = f.store(), derived = f.store('Release plan depends on source', [source.id]); f.watch(source);
    expect(f.confirm(source).status).toBe('fresh'); f.advance(999);
    expect(f.maintenance.recall({ query: 'release' }).items.map(item => item.memory.id)).toContain(derived.id);
    f.advance(1); expect(f.maintenance.assess(source.id).status).toBe('stale');
    expect(f.maintenance.recall({ query: 'release' }).items).toEqual([]);
    expect(f.memory.get(source.id)).toEqual(source); // age is not factual falsity
    expect(f.confirm(source).status).toBe('fresh');
    expect(f.maintenance.recall({ query: 'release' }).items.map(item => item.memory.id)).toContain(derived.id);
  });

  it('keeps changed or unavailable sources out of maintained recall without rewriting them', () => {
    const f = fixture(), source = f.store(); f.watch(source); f.confirm(source);
    const firstConfirmation = f.maintenance.assess(source.id).lastConfirmedAt; f.advance(10);
    const changed = f.maintenance.recordCheck({ memoryId: source.id, expectedStateHash: f.maintenance.assess(source.id).stateHash, observation: { status: 'changed', evidence: 'Source revision differs; claim needs review', verifier: 'fixture', sourceRevision: 'r2' } });
    expect(changed.status).toBe('source-changed'); expect(changed.lastConfirmedAt).toBe(firstConfirmation);
    expect(f.maintenance.recall({ query: 'release' }).items).toEqual([]); expect(f.memory.get(source.id)).toEqual(source);
    const unavailable = f.maintenance.recordCheck({ memoryId: source.id, expectedStateHash: changed.stateHash, observation: { status: 'unavailable', evidence: 'Source could not be checked', verifier: 'fixture' } });
    expect(unavailable.status).toBe('unavailable'); expect(unavailable.lastConfirmedAt).toBe(firstConfirmation);
  });

  it('rejects stale check results after another check or correction', () => {
    const f = fixture(), source = f.store(); const initial = f.watch(source); f.confirm(source);
    expect(() => f.maintenance.recordCheck({ memoryId: source.id, expectedStateHash: initial.stateHash, observation: confirmed })).toThrow('stale');
    const pending = f.maintenance.assess(source.id);
    const replacement = f.memory.correct(source.id, { text: 'Use updated preview', source: { uri: 'fixture://new-evidence' }, reason: 'New source' });
    expect(() => f.maintenance.recordCheck({ memoryId: source.id, expectedStateHash: pending.stateHash, observation: confirmed })).toThrow();
    expect(f.maintenance.assess(source.id).status).toBe('ineligible');
    expect(f.maintenance.assess(replacement.id).status).toBe('unwatched');
  });

  it('forgetting the source removes every watch/check revision and its evidence', () => {
    const f = fixture(), source = f.store(); f.watch(source); f.confirm(source); f.advance(5); f.confirm(source);
    expect(JSON.stringify(f.memory.export())).toContain(confirmed.evidence);
    f.memory.forget(source.id);
    expect(f.memory.export().memories).toEqual([]); expect(f.maintenance.scan().items).toEqual([]);
  });

  it('never promotes untrusted imports or bypasses failed outcomes', async () => {
    const f = fixture(), raw = f.memory.store({ text: 'untrusted release', source: { uri: 'fixture://import' } }); f.watch(raw);
    expect(f.maintenance.assess(raw.id).status).toBe('ineligible');
    expect(() => f.confirm(raw)).toThrow('ineligible');
    const probe = vi.fn(async () => confirmed); expect((await f.maintenance.probeDue({ probe })).attempted).toBe(0); expect(probe).not.toHaveBeenCalled();
    const source = f.store(); f.watch(source); f.confirm(source);
    f.memory.recordOutcome({ memoryId: source.id, taskId: 'failed', success: false, evidence: 'failed fixture', verifier: 'controller' });
    expect(f.maintenance.assess(source.id).status).toBe('ineligible'); expect(f.memory.get(raw.id)?.trust).toBe('untrusted');
  });

  it('requires explicit evidence, valid policy bounds and coherent clocks', () => {
    const f = fixture(), source = f.store();
    expect(() => f.watch(source, 0)).toThrow(); expect(() => f.watch(source, Infinity)).toThrow();
    const state = f.watch(source);
    expect(() => f.maintenance.recordCheck({ memoryId: source.id, expectedStateHash: state.stateHash, observation: { ...confirmed, evidence: '' } })).toThrow();
    expect(f.watch(source).watchId).toBe(state.watchId);
    expect(() => f.watch(source, 2)).toThrow('another policy');
    f.advance(1); f.confirm(source); f.advance(-1); expect(f.maintenance.assess(source.id).status).toBe('clock-skew');
  });

  it('honors independent capture/recall controls and rejects malformed controls', () => {
    const f = fixture(), source = f.store();
    const readOnly = new MemoryMaintenance(new MemoryRuntime(f.memory, { captureEnabled: false }));
    expect(readOnly.assess(source.id).status).toBe('unwatched'); expect(() => readOnly.watchMemory({ memoryId: source.id, maxAgeMs: 10 })).toThrow('capture');
    const disabled = new MemoryMaintenance(new MemoryRuntime(f.memory, { recallEnabled: false })); expect(() => disabled.scan()).toThrow('recall');
    f.memory.store({ text: 'spoofed control', source: { uri: 'fixture://invalid-control' }, metadata: { mnemosyneMaintenance: 'v1', advisory: false, runtimeType: 'maintenance-watch' } });
    expect(() => f.maintenance.scan()).toThrow();
  });

  it('fails closed at inventory bounds and rolls back an over-budget check', () => {
    const f = fixture({ maxScanRecords: 1 }), source = f.store(); f.watch(source);
    expect(() => f.confirm(source)).toThrow('scan budget');
    expect(f.memory.export().memories).toHaveLength(2); expect(f.maintenance.assess(source.id).status).toBe('needs-check');
  });
});

describe('action-bound memory read sets', () => {
  it('binds action and contents to the producing service instance', () => {
    const f = fixture(), source = f.store();
    const ticket = f.maintenance.createReadSet({ memoryIds: [source.id], actionKey: 'publish-preview', dependenciesComplete: true });
    expect(f.maintenance.validateReadSet(ticket, 'publish-preview')).toEqual({ valid: true });
    expect(f.maintenance.validateReadSet(ticket, 'delete-preview').valid).toBe(false);
    expect(f.maintenance.validateReadSet({ ...ticket, expiresAt: '2099-01-01T00:00:00.000Z' }, 'publish-preview').valid).toBe(false);
    expect(f.maintenance.validateReadSet({ ...ticket, records: [] }, 'publish-preview').valid).toBe(false);
    expect(new MemoryMaintenance(f.runtime, { now: f.now }).validateReadSet(ticket, 'publish-preview').valid).toBe(false);
  });

  it('checks exact transitive dependencies but leaves unrelated work independent', () => {
    const f = fixture(), source = f.store(), plan = f.store('Release plan', [source.id]);
    const ticket = f.maintenance.createReadSet({ memoryIds: [plan.id], actionKey: 'release', dependenciesComplete: true });
    expect(ticket.records).toHaveLength(2); f.store('unrelated new note');
    expect(f.maintenance.validateReadSet(ticket, 'release').valid).toBe(true);
    f.memory.correct(source.id, { text: 'New release policy', source: { uri: 'fixture://updated' }, reason: 'Source changed' });
    expect(f.maintenance.validateReadSet(ticket, 'release')).toEqual({ valid: false, reason: 'dependencies-changed' });
  });

  it('invalidates read sets on outcomes, new watches and fresh confirmations', () => {
    const f = fixture(), source = f.store();
    const ticket = () => f.maintenance.createReadSet({ memoryIds: [source.id], actionKey: 'release', dependenciesComplete: true });
    const first = ticket(); f.memory.recordOutcome({ memoryId: source.id, taskId: 'used', success: true, evidence: 'later result', verifier: 'fixture' });
    expect(f.maintenance.validateReadSet(first, 'release').valid).toBe(false);
    const second = ticket(); f.watch(source); expect(f.maintenance.validateReadSet(second, 'release').valid).toBe(false);
    f.confirm(source); const third = ticket(); f.advance(1); f.confirm(source); expect(f.maintenance.validateReadSet(third, 'release').valid).toBe(false);
  });

  it('expires at the earlier ticket deadline or watched source deadline', () => {
    const f = fixture(), source = f.store(); f.watch(source, 20); f.confirm(source);
    const ticket = f.maintenance.createReadSet({ memoryIds: [source.id], actionKey: 'release', dependenciesComplete: true, lifetimeMs: 1000 });
    f.advance(19); expect(f.maintenance.validateReadSet(ticket, 'release').valid).toBe(true);
    f.advance(1); expect(f.maintenance.validateReadSet(ticket, 'release')).toEqual({ valid: false, reason: 'expired' });
  });

  it('invalidates freshness and read sets when their watch or check evidence fails', () => {
    const f = fixture(), source = f.store(); f.watch(source); f.confirm(source);
    const ticket = () => f.maintenance.createReadSet({ memoryIds: [source.id], actionKey: 'release', dependenciesComplete: true });
    const first = ticket();
    const check = f.memory.list({ includeUntrusted: true, metadata: { runtimeType: 'maintenance-check' } }).items[0];
    f.memory.recordOutcome({ memoryId: check.id, taskId: 'check-failed', success: false, evidence: 'confirmation evidence disproved', verifier: 'fixture' });
    expect(f.maintenance.assess(source.id).status).toBe('needs-check'); expect(f.maintenance.validateReadSet(first, 'release').valid).toBe(false);
    f.confirm(source); const second = ticket();
    const watchId = f.maintenance.assess(source.id).watchId!;
    f.memory.recordOutcome({ memoryId: watchId, taskId: 'policy-failed', success: false, evidence: 'freshness policy rejected', verifier: 'fixture' });
    expect(f.maintenance.assess(source.id).status).toBe('ineligible'); expect(f.maintenance.validateReadSet(second, 'release').valid).toBe(false);
  });

  it('requires caller-declared dependency completeness and can require every source to be watched', () => {
    const f = fixture(), source = f.store();
    expect(() => f.maintenance.createReadSet({ memoryIds: [source.id], actionKey: 'release', dependenciesComplete: false } as never)).toThrow();
    expect(() => f.maintenance.createReadSet({ memoryIds: [source.id], actionKey: 'release', dependenciesComplete: true, requireWatched: true })).toThrow('dependencies');
    f.watch(source); expect(() => f.maintenance.createReadSet({ memoryIds: [source.id], actionKey: 'release', dependenciesComplete: true })).toThrow('dependencies');
    f.confirm(source); expect(f.maintenance.createReadSet({ memoryIds: [source.id], actionKey: 'release', dependenciesComplete: true, requireWatched: true })).toHaveProperty('signature');
  });

  it('does not revive an expired ticket when the wall clock moves backwards after expiry', () => {
    const f = fixture(), source = f.store(); f.watch(source, 20); f.confirm(source);
    const ticket = f.maintenance.createReadSet({ memoryIds: [source.id], actionKey: 'release', dependenciesComplete: true });
    f.advance(20); expect(f.maintenance.validateReadSet(ticket, 'release').valid).toBe(false); expect(f.maintenance.assess(source.id).status).toBe('stale');
    f.advance(-10); expect(f.maintenance.validateReadSet(ticket, 'release').valid).toBe(false); expect(f.maintenance.assess(source.id).status).toBe('clock-skew');
    expect(() => f.confirm(source)).toThrow('clock');
  });

  it('rejects an untrusted control-shaped record as a freshness confirmation', () => {
    const f = fixture(), source = f.store(); const watch = f.watch(source);
    f.memory.store({ text: 'Source freshness check', source: { uri: 'maintenance:check' }, kind: 'observation', dependencies: [source.id, watch.watchId!], metadata: {
      mnemosyneMaintenance: 'v1', runtimeType: 'maintenance-check', advisory: false, memoryId: source.id, watchId: watch.watchId!, checkedAt: f.now().toISOString(), lastConfirmedAt: f.now().toISOString(), targetFingerprint: f.memory.getRecordFingerprint(source.id)!, ...confirmed,
    } });
    expect(() => f.maintenance.assess(source.id)).toThrow('Invalid');
    expect(() => f.maintenance.createReadSet({ memoryIds: [source.id], actionKey: 'release', dependenciesComplete: true })).toThrow('Invalid');
  });

  it('cannot validate forgotten records or carry a ticket backwards through time', () => {
    const f = fixture(), source = f.store();
    const ticket = f.maintenance.createReadSet({ memoryIds: [source.id], actionKey: 'release', dependenciesComplete: true });
    f.advance(-1); expect(f.maintenance.validateReadSet(ticket, 'release').valid).toBe(false); f.advance(1);
    f.memory.forget(source.id); expect(f.maintenance.validateReadSet(ticket, 'release')).toEqual({ valid: false, reason: 'unavailable' });
  });
});

describe('bounded explicit source probes', () => {
  it('checks only due sources in controller-selected priority order without automatic work', async () => {
    const f = fixture(), a = f.store('A'), b = f.store('B'); f.watch(a, 1000, 1); f.watch(b, 1000, 10);
    const seen: string[] = [];
    const report = await f.maintenance.probeDue({ maxChecks: 1, probe: async ({ memory }) => { seen.push(memory.id); return confirmed; } });
    expect(seen).toEqual([b.id]); expect(report).toMatchObject({ attempted: 1, confirmed: 1, deferred: 1 });
    await f.maintenance.probeDue({ probe: async () => confirmed });
    const probe = vi.fn(async () => confirmed); expect((await f.maintenance.probeDue({ probe })).attempted).toBe(0); expect(probe).not.toHaveBeenCalled();
  });

  it('rejects a late callback after newer evidence was recorded', async () => {
    const f = fixture(), source = f.store(); f.watch(source);
    const report = await f.maintenance.probeDue({ probe: async () => {
      f.maintenance.recordCheck({ memoryId: source.id, expectedStateHash: f.maintenance.assess(source.id).stateHash, observation: { ...confirmed, status: 'changed' } });
      return confirmed;
    } });
    expect(report.failed).toBe(1); expect(f.maintenance.assess(source.id).status).toBe('source-changed');
  });

  it('binds asynchronous probe results to the original target and revision despite callback object edits', async () => {
    const f = fixture(), source = f.store(), other = f.store('Other release source'); f.watch(source, 1000, 1); f.watch(other);
    const report = await f.maintenance.probeDue({ maxChecks: 1, probe: async ({ memory, freshness }) => {
      const newer = f.maintenance.recordCheck({ memoryId: source.id, expectedStateHash: freshness.stateHash, observation: { ...confirmed, status: 'changed' } });
      freshness.stateHash = newer.stateHash; memory.id = other.id;
      freshness.stateHash = f.maintenance.assess(other.id).stateHash;
      return confirmed;
    } });
    expect(report.failed).toBe(1); expect(f.maintenance.assess(source.id).status).toBe('source-changed');
    expect(f.maintenance.assess(other.id).status).toBe('needs-check');
  });

  it('shares one deadline across probes and aborts outstanding work with no late commit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const f = fixture(), a = f.store('A'), b = f.store('B'); f.watch(a, 1000, 2); f.watch(b, 1000, 1);
    let enterFirst!: () => void, enterSecond!: () => void, resolveLate!: (value: typeof confirmed) => void, lateSignal: AbortSignal | undefined;
    const first = new Promise<void>(resolve => { enterFirst = resolve; }), second = new Promise<void>(resolve => { enterSecond = resolve; });
    const pending = f.maintenance.probeDue({ timeoutMs: 50, probe: async ({ memory }, { signal }) => {
      if (memory.id === a.id) { enterFirst(); await new Promise(resolve => setTimeout(resolve, 40)); return confirmed; }
      lateSignal = signal; enterSecond(); return new Promise(resolve => { resolveLate = resolve; });
    } });
    await first; await vi.advanceTimersByTimeAsync(40); await second;
    await vi.advanceTimersByTimeAsync(9); expect(lateSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(lateSignal?.aborted).toBe(true);
    expect(await pending).toMatchObject({ attempted: 2, confirmed: 1, failed: 1 });
    resolveLate(confirmed); await Promise.resolve(); expect(f.maintenance.assess(b.id).status).toBe('needs-check'); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a pending callback and does not leak provider errors into memory', async () => {
    const f = fixture(), source = f.store(); f.watch(source); const controller = new AbortController(); let signal: AbortSignal | undefined;
    const report = await f.maintenance.probeDue({ signal: controller.signal, probe: async (_request, options) => { signal = options.signal; controller.abort(); return confirmed; } });
    expect(report.failed).toBe(1); expect(signal?.aborted).toBe(true); expect(f.maintenance.assess(source.id).status).toBe('needs-check');
    const failed = await f.maintenance.probeDue({ probe: async () => { throw new Error('secret-fixture-diagnostic'); } });
    expect(failed.failed).toBe(1); expect(JSON.stringify(f.memory.export())).not.toContain('secret-fixture-diagnostic');
  });

  it('does not start a probe canceled before its invocation microtask', async () => {
    const f = fixture(), source = f.store(); f.watch(source); const controller = new AbortController(), probe = vi.fn(async () => confirmed);
    const pending = f.maintenance.probeDue({ signal: controller.signal, probe }); controller.abort();
    expect((await pending).failed).toBe(1); expect(probe).not.toHaveBeenCalled();
  });

  it('includes the synchronous scan in the operation deadline', async () => {
    const f = fixture(), source = f.store(); f.watch(source); let clock = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const original = f.maintenance.scan.bind(f.maintenance);
    const scan = vi.spyOn(f.maintenance, 'scan').mockImplementation(() => { const result = original(); clock += 100; return result; });
    try {
      const probe = vi.fn(async () => confirmed), result = await f.maintenance.probeDue({ timeoutMs: 10, probe });
      expect(probe).not.toHaveBeenCalled(); expect(result).toMatchObject({ attempted: 0, deferred: 1 });
    } finally { scan.mockRestore(); now.mockRestore(); }
  });
});
