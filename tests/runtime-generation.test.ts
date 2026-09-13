import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalMemory, type LocalMemory, type MemoryRecord } from '../src/local/index.js';
import { MemoryRuntime, type RuntimeProposer } from '../src/runtime/index.js';
import { MemoryMaintenance } from '../src/maintenance/index.js';
import { AdaptiveContext } from '../src/context/index.js';

const opened: LocalMemory[] = [];
function fixture() {
  let clock = Date.parse('2026-09-14T00:00:00.000Z'); const now = () => new Date(clock);
  const memory = createLocalMemory({ path: ':memory:', workspaceId: 'generation', agentId: 'assistant', now }); opened.push(memory);
  const runtime = new MemoryRuntime(memory, { now }), maintenance = new MemoryMaintenance(runtime, { now }), context = new AdaptiveContext(runtime, { maintenance });
  let cursor = 0;
  const source = (text: string) => runtime.capture({ sessionId: 'session', trust: 'observed', messages: [{ id: String(cursor++), role: 'user', text }] }).records[0];
  const watch = (record: MemoryRecord) => maintenance.watchMemory({ memoryId: record.id, maxAgeMs: 1000 });
  const check = (record: MemoryRecord, status: 'confirmed' | 'changed' | 'unavailable' = 'confirmed') => maintenance.recordCheck({ memoryId: record.id, expectedStateHash: maintenance.assess(record.id).stateHash, observation: { status, evidence: 'Fixture inspection evidence.', verifier: 'fixture' } });
  return { memory, runtime, maintenance, context, source, watch, check, advance: (ms: number) => { clock += ms; } };
}
const proposer: RuntimeProposer = async request => request.kind === 'model'
  ? { text: 'Atlas model: validate exact input before publishing.', sourceIds: [request.sources[0].id] }
  : { observations: [{ text: 'Atlas observation: validate exact input before publishing.', sourceIds: [request.sources[0].id] }] };
function change(f: ReturnType<typeof fixture>, record: MemoryRecord, action: string) {
  if (action === 'success' || action === 'failure') f.memory.recordOutcome({ memoryId: record.id, success: action === 'success', evidence: 'Fixture outcome.', verifier: 'fixture', taskId: action });
  else if (action === 'check') { f.advance(1); f.check(record); }
  else if (action === 'forget') f.memory.forget(record.id);
  else f.memory.correct(record.id, { text: 'Atlas corrected source.', source: { uri: 'fixture:new' }, reason: 'New source evidence.' });
}
afterEach(() => { for (const memory of opened.splice(0)) memory.close(); });

describe('complete runtime generation-state evidence', () => {
  it('emits reusable observations linked to every supplied input, even a non-cited input', async () => {
    const f = fixture(), first = f.source('Atlas first source.'), second = f.source('Atlas second source.');
    const job = f.runtime.enqueue({ kind: 'observe', sourceIds: [first.id, second.id] });
    expect((await f.runtime.runJobs({ proposer })).completed).toEqual([job.jobId]);
    const result = f.memory.get(f.runtime.jobs()[0].resultIds[0])!;
    expect(result.dependencies).toEqual([first.id, second.id]); expect(result.metadata.citedSourceIds).toEqual([first.id]);
    expect(result.metadata.generationStateVersion).toBe('v1'); expect(result.metadata.generationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const packet = await f.context.build({ query: 'Atlas observation', maxTokens: 3000 }); expect(packet.memoryIds).toContain(result.id);
    f.memory.forget(second.id); expect(f.memory.get(result.id)).toBeNull(); expect(f.context.validate(packet).valid).toBe(false);
    expect(f.runtime.jobs()).toEqual([]); expect(f.memory.get(first.id)).not.toBeNull();
  });
  it('keeps durable job identity unchanged across positive outcomes and source confirmation', async () => {
    const f = fixture(), source = f.source('Atlas first source.'); const job = f.runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    f.watch(source); f.check(source); change(f, source, 'success');
    const next = f.runtime.enqueue({ kind: 'observe', sourceIds: [source.id] }); expect(next.jobId).toBe(job.jobId); expect(next.fingerprint).toBe(job.fingerprint);
    const report = await f.runtime.runJobs({ proposer }); expect(report.completed).toEqual([job.jobId]);
    expect((await f.context.build({ query: 'Atlas observation', maxTokens: 3000 })).memoryIds).toContain(f.runtime.jobs()[0].resultIds[0]);
  });
  it.each(['success', 'check', 'correct', 'forget', 'failure'])('rejects a queued microtask dispatch after %s without calling a provider', async action => {
    const f = fixture(), source = f.source('Atlas source.'); f.watch(source); f.check(source); f.runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    const call = vi.fn(proposer), pending = f.runtime.runJobs({ proposer: call }); change(f, source, action);
    const report = await pending; expect(report.modelCalls).toBe(0); expect(call).not.toHaveBeenCalled(); expect(report.failed).toHaveLength(1);
  });
  it.each(['success', 'check', 'correct', 'forget', 'failure'])('rejects a result when its complete generation state changes by %s during await', async action => {
    const f = fixture(), source = f.source('Atlas source.'); f.watch(source); f.check(source); f.runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    const report = await f.runtime.runJobs({ proposer: async request => { change(f, source, action); return proposer(request); } });
    expect(report.modelCalls).toBe(1); expect(report.completed).toEqual([]); expect(report.failed).toHaveLength(1);
    expect(f.memory.list({ metadata: { runtimeType: 'observation' } }).items).toEqual([]);
  });
  it.each(['success', 'check'])('does not reuse a model across a %s-only change or collide with its earlier idempotency identity', async action => {
    const f = fixture(), source = f.source('Atlas source.'); f.watch(source); f.check(source);
    const call = vi.fn(proposer), input = { kind: 'model' as const, key: 'atlas', sourceIds: [source.id], proposer: call };
    const first = await f.runtime.refreshModel(input); expect(first.status).toBe('fresh');
    expect((await f.runtime.refreshModel(input)).modelCalls).toBe(0); change(f, source, action);
    expect(f.runtime.getModel('atlas').status).toBe('stale');
    const next = await f.runtime.refreshModel(input); expect(next.modelCalls).toBe(1); expect(next.record!.id).not.toBe(first.record!.id);
    expect(next.record!.metadata.fingerprint).toBe(first.record!.metadata.fingerprint);
    expect(next.record!.metadata.generationFingerprint).not.toBe(first.record!.metadata.generationFingerprint);
    expect(f.memory.isEligible(first.record!.id)).toBe(false);
    expect((await f.runtime.refreshModel(input)).modelCalls).toBe(0); expect(call).toHaveBeenCalledTimes(2);
    const packet = await f.context.build({ query: 'Atlas', maxTokens: 3000 }); expect(packet.memoryIds).toContain(next.record!.id); expect(packet.memoryIds).not.toContain(first.record!.id);
  });
  it('blocks watched stale or unavailable source dispatch without changing the stored assertion', async () => {
    const f = fixture(), source = f.source('Atlas source.'); f.watch(source); f.check(source); f.runtime.enqueue({ kind: 'observe', sourceIds: [source.id] }); f.advance(1000);
    const call = vi.fn(proposer); expect((await f.runtime.runJobs({ proposer: call })).modelCalls).toBe(0); expect(call).not.toHaveBeenCalled();
    expect(f.memory.get(source.id)?.text).toBe(source.text); f.check(source, 'unavailable');
    expect(() => f.runtime.enqueue({ kind: 'observe', sourceIds: [source.id] })).toThrow('freshness');
  });
  it('checks transitive source-check changes rather than only direct input state', async () => {
    const f = fixture(), source = f.source('Atlas leaf source.'); f.watch(source); f.check(source);
    const derived = f.memory.store({ text: 'Atlas intermediary reference.', source: { uri: 'fixture:derived' }, trust: 'observed', dependencies: [source.id] });
    f.runtime.enqueue({ kind: 'observe', sourceIds: [derived.id] });
    const report = await f.runtime.runJobs({ proposer: async request => { f.advance(1); f.check(source); return proposer(request); } });
    expect(report.failed).toHaveLength(1); expect(report.completed).toEqual([]);
  });
  it.each(['success', 'check'])('does not feed a stale generated observation to a new proposer after %s', async action => {
    const f = fixture(), source = f.source('Atlas leaf source.'); f.watch(source); f.check(source);
    f.runtime.enqueue({ kind: 'observe', sourceIds: [source.id] }); await f.runtime.runJobs({ proposer });
    const observation = f.memory.get(f.runtime.jobs()[0].resultIds[0])!;
    const first = await f.runtime.refreshModel({ kind: 'model', key: 'outer', sourceIds: [observation.id], proposer }); expect(first.status).toBe('fresh');
    change(f, source, action);
    expect(f.runtime.getModel('outer').status).toBe('stale');
    const call = vi.fn(proposer);
    await expect(f.runtime.refreshModel({ kind: 'model', key: 'outer-again', sourceIds: [observation.id], proposer: call })).rejects.toThrow('Generated source state changed');
    expect(call).not.toHaveBeenCalled();
  });
  it.each(['success', 'check'])('does not feed a stale adaptive projection to a runtime proposer after %s', async action => {
    const f = fixture(), source = f.source('Atlas leaf source. '.repeat(20)); f.watch(source); f.check(source);
    const projected = await f.context.refresh({ key: 'projection', sourceIds: [source.id], proposerId: 'fixture', proposer: async request => ({ text: 'Atlas compact projection.', sourceIds: request.sources.map(item => item.id) }) });
    const first = await f.runtime.refreshModel({ kind: 'model', key: 'projected-model', sourceIds: [projected.record.id], proposer }); expect(first.status).toBe('fresh');
    change(f, source, action); expect(f.runtime.getModel('projected-model').status).toBe('stale');
    const call = vi.fn(proposer);
    await expect(f.runtime.refreshModel({ kind: 'model', key: 'projection-again', sourceIds: [projected.record.id], proposer: call })).rejects.toThrow('Generated source state changed'); expect(call).not.toHaveBeenCalled();
  });
});
