import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { createLocalMemory, type LocalMemory, type MemoryRecord } from '../src/local/index.js';
import { MemoryRuntime } from '../src/runtime/index.js';
import { MemoryMaintenance } from '../src/maintenance/index.js';
import { MemoryProfiles, type ProfileProposer } from '../src/profiles/index.js';

const opened: LocalMemory[] = [], directories: string[] = [];
function fixture(path = ':memory:', agentId = 'alice', workspaceId = 'profile-fixture') {
  let time = Date.parse('2026-09-14T00:00:00.000Z'); const now = () => new Date(time);
  const memory = createLocalMemory({ path, agentId, workspaceId, now }); opened.push(memory);
  const runtime = new MemoryRuntime(memory, { now }), maintenance = new MemoryMaintenance(runtime, { now });
  const profiles = new MemoryProfiles(runtime, { maintenance });
  const definition = profiles.define({ key: 'preferences', version: '1', fields: { city: z.string().min(1).max(80) } });
  const store = (text = 'Synthetic client city: Dubai.', dependencies: string[] = [], visibility: 'private' | 'workspace' = 'private') => memory.store({ text, source: { uri: 'fixture:profile', revision: 'v1' }, trust: 'observed', dependencies, visibility });
  const check = (record: MemoryRecord, status: 'confirmed' | 'changed' | 'unavailable' = 'confirmed') => maintenance.recordCheck({ memoryId: record.id, expectedStateHash: maintenance.assess(record.id).stateHash, observation: { status, evidence: 'Synthetic source inspected.', verifier: 'fixture' } });
  const refresh = (sourceIds: string[], proposer: ProfileProposer = proposal) => profiles.refresh({ definition, sourceIds, proposer, proposerId: 'scripted-v1' });
  return { memory, runtime, maintenance, profiles, definition, store, check, refresh, advance: (ms: number) => { time += ms; } };
}
const proposal: ProfileProposer = async request => ({ fields: { city: { status: 'known', value: 'Dubai', sourceIds: [request.sources[0].id] } } });
function mutate(f: ReturnType<typeof fixture>, source: MemoryRecord, action: string) {
  if (action === 'forget') f.memory.forget(source.id);
  else if (action === 'correct') f.memory.correct(source.id, { text: 'Synthetic client moved to Berlin.', source: { uri: 'fixture:replacement' }, reason: 'Changed synthetic facts.' });
  else if (action === 'failure' || action === 'success') f.memory.recordOutcome({ memoryId: source.id, success: action === 'success', evidence: 'Synthetic task outcome.', verifier: 'fixture', taskId: action });
  else if (action === 'check') { f.maintenance.watchMemory({ memoryId: source.id, maxAgeMs: 1000 }); f.check(source); }
}
afterEach(() => { for (const memory of opened.splice(0)) memory.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('source-backed typed profiles', () => {
  it('handles short facts, cites each known field, retains uncited inputs, and reuses without another callback', async () => {
    const f = fixture(), a = f.store(), b = f.store('Synthetic client prefers tea.'), proposer = vi.fn(proposal);
    expect(f.profiles.get(f.definition)).toMatchObject({ status: 'unknown', fields: { city: { status: 'unknown' } } });
    const first = await f.refresh([a.id, b.id], proposer);
    expect(first).toMatchObject({ status: 'created', modelCalls: 1, profile: { status: 'ready', sourceIds: [a.id, b.id], fields: { city: { status: 'known', value: 'Dubai', sourceIds: [a.id] } } } });
    const record = f.memory.get(first.profile.recordId!)!;
    expect(record.dependencies).toEqual([a.id, b.id]); expect(record.visibility).toBe('private'); expect(record.trust).toBe('observed');
    expect(record.metadata.representation).toBe('structured'); expect(record.text.length).toBeGreaterThan(a.text.length + b.text.length);
    expect((await f.refresh([a.id, b.id], proposer))).toMatchObject({ status: 'reused', modelCalls: 0, inputBytes: 0 });
    expect(proposer).toHaveBeenCalledTimes(1);
    const before = f.memory.export(); expect(f.profiles.get(f.definition)).toEqual(first.profile); expect(f.memory.export()).toEqual(before);
    mutate(f, b, 'success'); expect(f.profiles.get(f.definition)).toMatchObject({ status: 'stale', fields: { city: { status: 'unknown' } }, sourceIds: [] });
  });
  it('preserves typed unknown and conflict states without choosing a winner', async () => {
    const f = fixture(), a = f.store('City: Dubai'), b = f.store('City: Berlin');
    const definition = f.profiles.define({ key: 'multi', version: '1', fields: { city: z.string(), timezone: z.enum(['UTC', 'Asia/Dubai']), preferences: z.object({ theme: z.enum(['light', 'dark']) }).strict() } });
    const result = await f.profiles.refresh({ definition, sourceIds: [a.id, b.id], proposerId: 'scripted', proposer: async () => ({ fields: { city: { status: 'conflict', candidates: [{ value: 'Dubai', sourceIds: [a.id] }, { value: 'Berlin', sourceIds: [b.id] }] }, timezone: { status: 'unknown' }, preferences: { status: 'known', value: { theme: 'dark' }, sourceIds: [a.id] } } }) });
    expect(result.profile.fields.city.status).toBe('conflict'); expect(result.profile.fields.timezone).toEqual({ status: 'unknown' });
    if (result.profile.fields.preferences.status === 'known') { const value: 'dark' | 'light' = result.profile.fields.preferences.value.theme; expect(value).toBe('dark'); }
    expect(Object.isFrozen(result.profile.fields)).toBe(true);
  });
  it('binds schema shape, explicit semantic version and proposer identity', async () => {
    const f = fixture(), source = f.store(); await f.refresh([source.id]);
    const nextVersion = f.profiles.define({ key: 'preferences', version: '2', fields: { city: z.string().min(1).max(80) } });
    const nextShape = f.profiles.define({ key: 'preferences', version: '1', fields: { city: z.number() } });
    expect(f.profiles.get(nextVersion).status).toBe('unknown'); expect(f.profiles.get(nextShape).status).toBe('unknown');
    const call = vi.fn(proposal);
    expect((await f.profiles.refresh({ definition: f.definition, sourceIds: [source.id], proposerId: 'changed-model-policy', proposer: call })).status).toBe('created');
    expect(call).toHaveBeenCalledTimes(1);
    expect(() => f.profiles.get({ ...f.definition })).toThrow('invalid-definition');
  });
  it('reopens a durable profile under the same explicit definition without a new model call', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemosyne-profiles-')); directories.push(directory); const path = join(directory, 'memory.sqlite');
    const first = fixture(path), source = first.store(), result = await first.refresh([source.id]); first.memory.close(); opened.splice(opened.indexOf(first.memory), 1);
    const reopened = fixture(path); expect(reopened.profiles.get(reopened.definition)).toEqual(result.profile);
    const call = vi.fn(proposal); expect((await reopened.refresh([source.id], call)).status).toBe('reused'); expect(call).not.toHaveBeenCalled();
  });
  it('keeps profiles private across two clients and workspaces while allowing explicit shared input', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemosyne-profile-scope-')); directories.push(directory); const path = join(directory, 'memory.sqlite');
    const alice = fixture(path), bob = fixture(path, 'bob'), other = fixture(path, 'alice', 'other');
    const privateSource = alice.store(), shared = alice.store('Shared synthetic city Dubai.', [], 'workspace');
    await alice.refresh([privateSource.id]); expect(bob.profiles.get(bob.definition).status).toBe('unknown');
    const call = vi.fn(proposal); await expect(bob.refresh([privateSource.id], call)).rejects.toThrow(); expect(call).not.toHaveBeenCalled();
    await bob.refresh([shared.id]); expect(bob.profiles.get(bob.definition).status).toBe('ready'); expect(other.profiles.get(other.definition).status).toBe('unknown');
    await expect(other.refresh([shared.id], call)).rejects.toThrow();
  });
  it.each(['forget', 'correct', 'failure', 'success', 'check'])('withholds every field after transitive source %s', async action => {
    const f = fixture(), leaf = f.store(), intermediate = f.store('Derived city note.', [leaf.id]); await f.refresh([intermediate.id]);
    mutate(f, leaf, action);
    const result = f.profiles.get(f.definition); expect(['unknown', 'stale']).toContain(result.status); expect(result.fields.city).toEqual({ status: 'unknown' }); expect(JSON.stringify(result)).not.toContain('Dubai');
  });
  it('does not resurrect a forgotten transcript or profile through capture replay and regeneration', async () => {
    const f = fixture(); const capture = { sessionId: 'client-1', trust: 'observed' as const, messages: [{ id: 'm1', role: 'user' as const, text: 'Synthetic city Dubai.' }] };
    const source = f.runtime.capture(capture).records[0]; const result = await f.refresh([source.id]);
    f.runtime.forgetSource(source.id);
    expect(f.memory.get(result.profile.recordId!)).toBeNull(); expect(() => f.runtime.capture(capture)).toThrow('tombstone');
    const call = vi.fn(proposal); await expect(f.refresh([source.id], call)).rejects.toThrow(); expect(call).not.toHaveBeenCalled(); expect(f.profiles.get(f.definition).status).toBe('unknown');
  });
  it('expires watched evidence and rejects a newly confirmed source until explicit regeneration', async () => {
    const f = fixture(), source = f.store(); f.maintenance.watchMemory({ memoryId: source.id, maxAgeMs: 1000 }); f.check(source); await f.refresh([source.id]);
    f.advance(1000); expect(f.profiles.get(f.definition).status).toBe('stale');
    f.check(source); expect(f.profiles.get(f.definition).status).toBe('stale');
    expect((await f.refresh([source.id])).status).toBe('created'); expect(f.profiles.get(f.definition).status).toBe('ready');
  });
  it('requires watched source closure when explicitly requested', async () => {
    const f = fixture(), source = f.store(), call = vi.fn(proposal);
    const input = { definition: f.definition, sourceIds: [source.id], proposer: call, proposerId: 'watched', requireWatched: true };
    await expect(f.profiles.refresh(input)).rejects.toThrow(); expect(call).not.toHaveBeenCalled();
    f.maintenance.watchMemory({ memoryId: source.id, maxAgeMs: 1000 }); f.check(source);
    expect((await f.profiles.refresh(input)).profile.status).toBe('ready'); expect(f.profiles.get(f.definition, { requireWatched: true }).status).toBe('ready');
    f.advance(1000); expect(f.profiles.get(f.definition, { requireWatched: true }).status).toBe('stale');
  });
  it.each(['forget', 'correct', 'failure', 'success', 'check'])('does not dispatch a proposer after source %s before its microtask', async action => {
    const f = fixture(), source = f.store(), call = vi.fn(proposal), pending = f.refresh([source.id], call); mutate(f, source, action);
    await expect(pending).rejects.toThrow(); expect(call).not.toHaveBeenCalled();
  });
  it('rejects mid-generation source changes without partial writes', async () => {
    const f = fixture(), source = f.store();
    await expect(f.refresh([source.id], async request => { mutate(f, source, 'success'); return proposal(request); })).rejects.toThrow();
    expect(f.memory.list({ metadata: { contextVersion: 'v1' } }).items).toHaveLength(0);
  });
  it.each(['missing-field', 'extra-field', 'wrong-type', 'bad-citation', 'duplicate-citation', 'empty-citations', 'unknown-extra', 'single-conflict', 'duplicate-conflict', 'extra-envelope', 'invalid-json'])('rejects %s output before persistence', async mode => {
    const f = fixture(), source = f.store(); const known = { status: 'known', value: 'Dubai', sourceIds: [source.id] }; let output: unknown = { fields: { city: known } };
    if (mode === 'missing-field') output = { fields: {} };
    if (mode === 'extra-field') output = { fields: { city: known, extra: { status: 'unknown' } } };
    if (mode === 'wrong-type') output = { fields: { city: { ...known, value: 5 } } };
    if (mode === 'bad-citation') output = { fields: { city: { ...known, sourceIds: ['foreign'] } } };
    if (mode === 'duplicate-citation') output = { fields: { city: { ...known, sourceIds: [source.id, source.id] } } };
    if (mode === 'empty-citations') output = { fields: { city: { ...known, sourceIds: [] } } };
    if (mode === 'unknown-extra') output = { fields: { city: { status: 'unknown', value: 'Dubai' } } };
    if (mode === 'single-conflict' || mode === 'duplicate-conflict') output = { fields: { city: { status: 'conflict', candidates: Array.from({ length: mode === 'single-conflict' ? 1 : 2 }, () => ({ value: 'Dubai', sourceIds: [source.id] })) } } };
    if (mode === 'extra-envelope') output = { fields: { city: known }, private: 'unwanted' };
    if (mode === 'invalid-json') output = '{ broken';
    await expect(f.refresh([source.id], async () => output)).rejects.toThrow(); expect(f.memory.list({ metadata: { contextVersion: 'v1' } }).items).toHaveLength(0);
  });
  it('rejects silent nested key stripping and coercion', async () => {
    const f = fixture(), source = f.store();
    const definition = f.profiles.define({ key: 'strict', version: '1', fields: { setting: z.object({ theme: z.string() }), count: z.coerce.number() } });
    for (const value of [{ setting: { theme: 'dark', secret: 'must not strip' }, count: 1 }, { setting: { theme: 'dark' }, count: '1' }]) {
      await expect(f.profiles.refresh({ definition, sourceIds: [source.id], proposerId: 'strict', proposer: async () => ({ fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, { status: 'known', value: item, sourceIds: [source.id] }])) }) })).rejects.toThrow();
    }
    expect(f.memory.list({ metadata: { contextVersion: 'v1' } }).items).toHaveLength(0);
  });
  it('bounds fields, schemas, source count, values, nested JSON and callback input/output', async () => {
    const f = fixture(), source = f.store(), call = vi.fn(proposal);
    expect(() => f.profiles.define({ key: 'too-many', version: '1', fields: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, z.string()])) })).toThrow('invalid-definition');
    expect(() => f.profiles.define({ key: 'schema', version: '1', fields: { city: z.string().describe('x'.repeat(18000)) } })).toThrow('invalid-definition');
    await expect(f.profiles.refresh({ definition: f.definition, sourceIds: Array.from({ length: 65 }, (_, i) => `s${i}`), proposerId: 'bounded', proposer: call })).rejects.toThrow('invalid-request');
    await expect(f.profiles.refresh({ definition: f.definition, sourceIds: [source.id], proposerId: 'bounded', proposer: call, maxInputBytes: 1 })).rejects.toThrow(); expect(call).not.toHaveBeenCalled();
    await expect(f.profiles.refresh({ definition: f.definition, sourceIds: [source.id], proposerId: 'bounded', proposer: proposal, maxOutputBytes: 50 })).rejects.toThrow();
    await expect(f.refresh([source.id], async () => 'x'.repeat(17000))).rejects.toThrow();
    const unconstrained = f.profiles.define({ key: 'bounded-values', version: '1', fields: { value: z.json() } });
    for (const value of ['x'.repeat(4097), { a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } }]) await expect(f.profiles.refresh({ definition: unconstrained, sourceIds: [source.id], proposerId: 'bounded', proposer: async () => ({ fields: { value: { status: 'known', value, sourceIds: [source.id] } } }) })).rejects.toThrow();
  });
  it('counts the complete profile/schema request delivered to the host', async () => {
    const f = fixture(), source = f.store(); let measured = 0;
    const result = await f.refresh([source.id], async request => { const { signal: _signal, ...serializable } = request; measured = Buffer.byteLength(JSON.stringify(serializable)); return proposal(request); });
    expect(result.inputBytes).toBe(measured); expect(measured).toBeGreaterThan(source.text.length);
  });
  it('honors independent capture/recall policy and does not synthesize with untrusted inputs', async () => {
    const f = fixture(), source = f.store(); await f.refresh([source.id]);
    for (const options of [{ captureEnabled: false }, { recallEnabled: false }]) {
      const profiles = new MemoryProfiles(new MemoryRuntime(f.memory, options)); const definition = profiles.define({ key: 'preferences', version: '1', fields: { city: z.string().min(1).max(80) } }); const call = vi.fn(proposal);
      expect(profiles.get(definition).status).toBe(options.recallEnabled === false ? 'disabled' : 'ready');
      await expect(profiles.refresh({ definition, sourceIds: [source.id], proposerId: 'x', proposer: call })).rejects.toThrow('policy-disabled'); expect(call).not.toHaveBeenCalled();
    }
    const untrusted = f.memory.store({ text: 'SECRET_UNTRUSTED', source: { uri: 'fixture:untrusted' } }), call = vi.fn(proposal);
    await expect(f.refresh([untrusted.id], call)).rejects.toThrow(); expect(call).not.toHaveBeenCalled();
  });
  it('cancels before dispatch, aborts a bounded proposer, and discards late results', async () => {
    const f = fixture(), source = f.store(), stop = new AbortController(); stop.abort(); const call = vi.fn(proposal);
    await expect(f.profiles.refresh({ definition: f.definition, sourceIds: [source.id], proposerId: 'cancelled', proposer: call, signal: stop.signal })).rejects.toThrow('cancelled'); expect(call).not.toHaveBeenCalled();
    let signal: AbortSignal | undefined, finish: ((value: unknown) => void) | undefined;
    await expect(f.profiles.refresh({ definition: f.definition, sourceIds: [source.id], proposerId: 'timeout', timeoutMs: 5, proposer: async request => { signal = request.signal; return new Promise(resolve => { finish = resolve; }); } })).rejects.toThrow();
    expect(signal?.aborted).toBe(true); finish?.({ fields: { city: { status: 'known', value: 'Dubai', sourceIds: [source.id] } } });
    await new Promise(resolve => setTimeout(resolve, 10)); expect(f.memory.list({ metadata: { contextVersion: 'v1' } }).items).toHaveLength(0);
  });
  it('keeps arbitrary callback and validation errors private', async () => {
    const f = fixture(), source = f.store();
    await expect(f.refresh([source.id], async () => { throw new Error('SECRET_PROVIDER_OUTPUT'); })).rejects.toThrow('private details omitted');
    const definition = f.profiles.define({ key: 'refinement', version: '1', fields: { city: z.string().refine(() => { throw new Error('SECRET_SCHEMA_OUTPUT'); }) } });
    await expect(f.profiles.refresh({ definition, sourceIds: [source.id], proposerId: 'private', proposer: proposal })).rejects.toThrow('private details omitted');
    expect(JSON.stringify(f.memory.export())).not.toContain('SECRET_');
  });
  it('revalidates evidence after a caller refinement runs during get', async () => {
    const f = fixture(), source = f.store(); let invalidate = false;
    const definition = f.profiles.define({ key: 'reentrant', version: '1', fields: { city: z.string().refine(() => { if (invalidate) mutate(f, source, 'success'); return true; }) } });
    await f.profiles.refresh({ definition, sourceIds: [source.id], proposerId: 'reentrant', proposer: proposal });
    invalidate = true; expect(f.profiles.get(definition).status).toBe('stale');
  });
  it('fails closed on a malformed persisted profile and never returns an older value', async () => {
    const f = fixture(), source = f.store(), original = await f.refresh([source.id]); const record = f.memory.get(original.profile.recordId!)!;
    const payload = JSON.parse(record.text); payload.fields.city.value = 123;
    f.memory.store({ text: JSON.stringify(payload), source: record.source, trust: record.trust, kind: record.kind, visibility: record.visibility, metadata: record.metadata, dependencies: record.dependencies });
    const read = f.profiles.get(f.definition); expect(read.status).toBe('stale'); expect(read.fields.city).toEqual({ status: 'unknown' });
  });
  it('uses the unique active revision after many replacements at an identical timestamp', async () => {
    const f = fixture(), source = f.store();
    for (let revision = 0; revision < 20; revision++) {
      const result = await f.profiles.refresh({ definition: f.definition, sourceIds: [source.id], proposerId: `revision-${revision}`, proposer: async () => ({ fields: { city: { status: 'known', value: `City ${revision}`, sourceIds: [source.id] } } }) });
      expect(f.profiles.get(f.definition)).toEqual(result.profile);
    }
  });
  it.each(['proposer', 'sources'])('supports A to B to A %s revisions without reviving a retired record', async mode => {
    const f = fixture(), a = f.store(), b = f.store('Additional city source Dubai.');
    const base = { definition: f.definition, sourceIds: [a.id], proposerId: 'A', proposer: proposal };
    const first = await f.profiles.refresh(base);
    await f.profiles.refresh(mode === 'proposer' ? { ...base, proposerId: 'B' } : { ...base, sourceIds: [a.id, b.id] });
    const restored = await f.profiles.refresh(base);
    expect(restored.profile.recordId).not.toBe(first.profile.recordId); expect(f.profiles.get(f.definition)).toEqual(restored.profile);
    expect((await f.profiles.refresh(base)).modelCalls).toBe(0);
  });
  it('coalesces identical concurrent commits while accounting for both dispatched callbacks', async () => {
    const f = fixture(), source = f.store(), call = vi.fn(proposal);
    const [a, b] = await Promise.all([f.refresh([source.id], call), f.refresh([source.id], call)]);
    expect(call).toHaveBeenCalledTimes(2); expect(a.modelCalls + b.modelCalls).toBe(2);
    expect(a.inputBytes).toBeGreaterThan(0); expect(b.inputBytes).toBeGreaterThan(0);
    expect(a.profile.recordId).toBe(b.profile.recordId); expect(f.profiles.get(f.definition)).toEqual(a.profile);
  });
  it('regenerates an earlier source set after the current profile becomes invalid', async () => {
    const f = fixture(), a = f.store(), b = f.store('Additional source.');
    const first = await f.refresh([a.id]); await f.refresh([a.id, b.id]);
    mutate(f, b, 'correct'); expect(f.profiles.get(f.definition).status).toBe('stale');
    const result = await f.refresh([a.id]);
    expect(result.profile.recordId).not.toBe(first.profile.recordId); expect(f.profiles.get(f.definition)).toEqual(result.profile);
    expect((await f.refresh([a.id])).modelCalls).toBe(0);
  });
  it('does not dispatch after schema metadata revokes evidence inside the adapter', async () => {
    const f = fixture(), source = f.store(); let reads = 0, revokeAt = Infinity;
    const schema = z.string().meta({ get description() { if (++reads === revokeAt) f.memory.forget(source.id); return 'Synthetic city field'; } });
    const definition = f.profiles.define({ key: 'adapter', version: '1', fields: { city: schema } });
    revokeAt = reads + 2; const call = vi.fn(proposal);
    await expect(f.profiles.refresh({ definition, sourceIds: [source.id], proposerId: 'adapter', proposer: call })).rejects.toThrow();
    expect(call).not.toHaveBeenCalled(); expect(f.memory.get(source.id)).toBeNull();
  });
  it.each(['direct', 'transitive'])('rejects %s self-profile input without replacing its current revision', async mode => {
    const f = fixture(), source = f.store(), first = await f.refresh([source.id]);
    const input = mode === 'direct' ? first.profile.recordId! : f.store('Derived profile note.', [first.profile.recordId!]).id;
    const call = vi.fn(proposal), count = f.memory.inspect().length;
    await expect(f.refresh([input], call)).rejects.toThrow('invalid-request');
    expect(call).not.toHaveBeenCalled(); expect(f.memory.inspect()).toHaveLength(count); expect(f.profiles.get(f.definition)).toEqual(first.profile);
  });
  it('accepts an intermediate from another profile definition with its full lineage', async () => {
    const f = fixture(), source = f.store(), first = await f.refresh([source.id]);
    const second = f.profiles.define({ key: 'other-profile', version: '1', fields: { city: z.string() } });
    const result = await f.profiles.refresh({ definition: second, sourceIds: [first.profile.recordId!], proposerId: 'other', proposer: proposal });
    expect(f.profiles.get(second)).toEqual(result.profile); expect(f.profiles.get(f.definition)).toEqual(first.profile);
    mutate(f, source, 'success'); expect(f.profiles.get(second).status).toBe('stale');
  });
});
