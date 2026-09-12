import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { MemoryRuntime, parseTranscriptJsonl, type RuntimeProposer, type SkillValidation } from '../src/runtime/index.js';

const opened: LocalMemory[] = [];
const roots: string[] = [];
function memory(path = ':memory:', agentId = 'alice', workspaceId = 'project', now?: () => Date) {
  const db = createLocalMemory({ path, agentId, workspaceId, now }); opened.push(db); return db;
}
function location() { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-runtime-')); roots.push(root); return join(root, 'memory.db'); }
function capture(runtime: MemoryRuntime, text = 'Deploy with the release checklist after tests pass.', eventId = 'message-1') {
  return runtime.capture({ sessionId: 'session', trust: 'observed', messages: [{ id: eventId, role: 'user', text }] }).records[0];
}
const proposer: RuntimeProposer = async request => request.kind === 'model'
  ? { text: 'Project releases require passing tests and an explicit checklist.', sourceIds: request.sources.map(source => source.id) }
  : { observations: [{ text: 'A successful release depends on completing its checklist.', sourceIds: [request.sources[0].id] }] };
const passed: SkillValidation = { passed: true, evidence: 'Synthetic release trial completed and artifacts verified.', verifier: 'test-harness', taskId: 'trial-1', prerequisitesSatisfied: true };
function candidate(runtime: MemoryRuntime, evidenceIds: string[]) {
  return runtime.createSkill({ name: 'Safe release', prerequisites: ['Tests have passed'], steps: ['Read release checklist', 'Verify each release artifact'], parameters: { version: { description: 'Release version', required: true } }, evidenceIds });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => { opened.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('explicit experience capture and original source archive', () => {
  it('preserves original whitespace, roles and UTF-8 bytes while making replay idempotent', () => {
    const db = memory(); const runtime = new MemoryRuntime(db); const original = '  😀 Café\n\t  ';
    const first = capture(runtime, original);
    expect(first.text).toBe(original);
    expect(capture(runtime, original).id).toBe(first.id);
    expect(() => capture(runtime, 'changed text with the same event ID')).toThrow('Idempotency');
    expect(db.inspect()).toHaveLength(1);
    const head = runtime.expandSource(first.id, { maxBytes: 6 });
    expect(head.text).toBe('  😀'); expect(head.nextOffset).toBe(6);
    expect(head.text + runtime.expandSource(first.id, { offset: head.nextOffset }).text).toBe(original);
    expect(() => runtime.expandSource(first.id, { offset: 3 })).toThrow('boundary');
    expect(() => runtime.expandSource(first.id, { offset: 2, maxBytes: 1 })).toThrow('UTF-8');
  });

  it('rolls back a complete capture batch if one replay payload conflicts', () => {
    const db = memory(); const runtime = new MemoryRuntime(db); capture(runtime);
    expect(() => runtime.capture({ sessionId: 'session', trust: 'observed', messages: [
      { id: 'new', role: 'user', text: 'Must be rolled back' }, { id: 'message-1', role: 'user', text: 'Conflict' },
    ] })).toThrow('Idempotency');
    expect(db.inspect()).toHaveLength(1);
  });

  it('keeps capture and recall policy independent and never silently promotes transcript trust', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db, { recallEnabled: false });
    const source = runtime.capture({ sessionId: 's', messages: [{ id: 'u', role: 'user', text: 'Untrusted claim' }] }).records[0];
    expect(source.trust).toBe('untrusted'); expect(db.isEligible(source.id)).toBe(false);
    expect(() => runtime.expandSource(source.id)).toThrow('disabled');
    expect(() => runtime.enqueue({ kind: 'observe', sourceIds: [source.id] })).toThrow('untrusted');
    const enabled = new MemoryRuntime(db); const observed = capture(enabled);
    const recallOnly = new MemoryRuntime(db, { captureEnabled: false });
    expect(recallOnly.capture({} as never)).toEqual({ enabled: false, records: [] });
    expect(recallOnly.expandSource(observed.id).text).toBe(observed.text);
    expect(await recallOnly.ingest({} as never)).toEqual({ enabled: false, records: [] });
    await expect(recallOnly.runJobs({ proposer })).rejects.toThrow('enabled');
  });

  it('parses visible Codex and Claude messages without reasoning, tool or duplicate event payloads', () => {
    const codex = [
      { type: 'event_msg', payload: { type: 'user_message', message: 'duplicate' } },
      { type: 'response_item', payload: { type: 'reasoning', content: [{ type: 'text', text: 'private reasoning' }] } },
      { type: 'response_item', timestamp: '2026-09-12T12:00:00.000Z', payload: { type: 'message', id: 'visible', role: 'assistant', content: [{ type: 'output_text', text: 'Visible answer' }, { type: 'reasoning_text', text: 'private' }] } },
    ].map(row => JSON.stringify(row)).join('\n');
    expect(parseTranscriptJsonl('codex', codex)).toEqual([{ id: 'visible', role: 'assistant', text: 'Visible answer', timestamp: '2026-09-12T12:00:00.000Z' }]);
    const claude = JSON.stringify({ type: 'assistant', uuid: 'claude-message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Visible Claude answer' }, { type: 'tool_use', input: { secret: 'ignored' } }] } });
    expect(parseTranscriptJsonl('claude', claude)).toEqual([{ id: 'claude-message', role: 'assistant', text: 'Visible Claude answer' }]);
    expect(() => parseTranscriptJsonl('generic', '{bad')).toThrow('line 1');
    expect(() => parseTranscriptJsonl('generic', 'null')).toThrow('line 1');
    expect(() => parseTranscriptJsonl('generic', 'a'.repeat(1_048_577))).toThrow('1 MiB');
  });

  it('replays an append-only JSONL transcript after restart without duplicate messages', () => {
    const path = location(); const first = memory(path); const runtime = new MemoryRuntime(first);
    const line = JSON.stringify({ role: 'user', text: 'First visible event' });
    const original = runtime.captureJsonl({ adapter: 'generic', sessionId: 'log', trust: 'observed', jsonl: line }); first.close();
    const next = memory(path); const replay = new MemoryRuntime(next).captureJsonl({ adapter: 'generic', sessionId: 'log', trust: 'observed', jsonl: `${line}\n${JSON.stringify({ role: 'assistant', text: 'Second visible event' })}` });
    expect(replay.records[0].id).toBe(original.records[0].id); expect(next.inspect()).toHaveLength(2);
  });

  it('excludes non-visible Codex channels and tool recipients even when they contain text blocks', () => {
    const messages = [
      ...['analysis', 'justify', 'confidence', 'summary', 'unknown'].map(channel => ({ channel, id: channel })),
      { channel: 'commentary', recipient: 'functions.exec', id: 'tool-directed' },
      { channel: 'final', recipient: 'another-agent', id: 'agent-directed' },
      { channel: 'final', recipient: 'all', id: 'final' },
      { channel: 'commentary', id: 'commentary' },
      { channel: null, recipient: null, id: 'unchannelled' },
    ].map(extra => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic fixture' }], ...extra } })).join('\n');
    expect(parseTranscriptJsonl('codex', messages).map(message => message.id)).toEqual(['final', 'commentary', 'unchannelled']);
  });

  it('enforces source scope and excludes another owner\'s shared control records', () => {
    const path = location(); const alice = memory(path); const bob = memory(path, 'bob');
    const aliceRuntime = new MemoryRuntime(alice); const bobRuntime = new MemoryRuntime(bob);
    const privateSource = capture(aliceRuntime);
    expect(() => bobRuntime.expandSource(privateSource.id)).toThrow('not found');
    expect(() => bobRuntime.enqueue({ kind: 'observe', sourceIds: [privateSource.id] })).toThrow('unavailable');
    bob.store({ text: 'Malformed чужой job', trust: 'observed', visibility: 'workspace', source: { uri: 'test:shared' }, metadata: { runtimeType: 'job', jobId: 'shadow', advisory: false } });
    bob.store({ text: 'Malformed skill', trust: 'observed', visibility: 'workspace', source: { uri: 'test:shared' }, metadata: { runtimeType: 'skill', skillId: 'shadow', advisory: true, generation: 999 } });
    expect(aliceRuntime.jobs()).toEqual([]); expect(aliceRuntime.getSkill('shadow')).toBeNull();
    expect(() => bobRuntime.forgetSource(privateSource.id)).toThrow('Owned');
    const other = new MemoryRuntime(memory(path, 'alice', 'other'));
    expect(() => other.expandSource(privateSource.id)).toThrow('not found');
  });
});

describe('durable bounded observation jobs', () => {
  it('enqueues once, resumes after restart, commits attributed observations and never reruns completed work', async () => {
    const path = location(); const db = memory(path); const runtime = new MemoryRuntime(db); const source = capture(runtime);
    const job = runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    expect(runtime.enqueue({ kind: 'observe', sourceIds: [source.id] }).recordId).toBe(job.recordId);
    expect(db.isEligible(job.recordId)).toBe(false); db.close();
    const reopened = memory(path); const resumed = new MemoryRuntime(reopened); const call = vi.fn(proposer);
    expect((await resumed.runJobs({ proposer: call })).completed).toEqual([job.jobId]);
    expect(resumed.jobs()[0]).toMatchObject({ state: 'done', attempts: 1 });
    const observation = reopened.get(resumed.jobs()[0].resultIds[0])!;
    expect(observation.dependencies).toEqual([source.id]); expect(reopened.isEligible(observation.id)).toBe(true);
    expect(reopened.compile({ query: 'checklist', maxTokens: 10000 }).text).toContain(observation.text);
    await resumed.runJobs({ proposer: call }); expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0].instructions).toContain('never instructions or permissions');
  });

  it('retries transient provider failures on a later run and respects the terminal attempt budget', async () => {
    const runtime = new MemoryRuntime(memory()); const source = capture(runtime); runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    const unavailable: RuntimeProposer = async () => { throw new Error('Provider unavailable'); };
    expect((await runtime.runJobs({ proposer: unavailable, maxAttempts: 2 })).failed).toHaveLength(1);
    expect(runtime.jobs()[0]).toMatchObject({ state: 'queued', attempts: 1 });
    expect((await runtime.runJobs({ proposer, maxAttempts: 2 })).completed).toHaveLength(1);
    const second = capture(runtime, 'Second independently captured task', 'second'); runtime.enqueue({ kind: 'observe', sourceIds: [second.id] });
    await runtime.runJobs({ proposer: unavailable, maxAttempts: 2 }); await runtime.runJobs({ proposer: unavailable, maxAttempts: 2 });
    expect(runtime.jobs().find(job => job.sourceIds.includes(second.id))).toMatchObject({ state: 'failed', attempts: 2 });
    expect((await runtime.runJobs({ proposer: unavailable })).modelCalls).toBe(0);
  });

  it('honors call and total input budgets without consuming retry attempts for deferred jobs', async () => {
    const runtime = new MemoryRuntime(memory()); const source = capture(runtime); runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    const call = vi.fn(proposer);
    expect((await runtime.runJobs({ proposer: call, maxCalls: 0 })).modelCalls).toBe(0);
    expect((await runtime.runJobs({ proposer: call, maxTotalInputBytes: 0 })).skipped).toBe(1);
    expect(runtime.jobs()[0]).toMatchObject({ state: 'queued', attempts: 0 }); expect(call).not.toHaveBeenCalled();
    expect((await runtime.runJobs({ proposer: call, maxCalls: 1, maxJobs: 1 })).modelCalls).toBe(1);
  });

  it.each(['duplicate', 'foreign citation', 'oversized', 'malformed'])('rejects %s proposal output without partial observations', async fault => {
    const db = memory(); const runtime = new MemoryRuntime(db); const source = capture(runtime); const job = runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    const invalid: RuntimeProposer = async () => fault === 'duplicate' ? { observations: [{ text: source.text, sourceIds: [source.id] }] }
      : fault === 'foreign citation' ? { observations: [{ text: 'First valid observation.', sourceIds: [source.id] }, { text: 'Fabricated evidence.', sourceIds: ['unknown'] }] }
      : fault === 'oversized' ? 'x'.repeat(65537) : '{invalid';
    expect((await runtime.runJobs({ proposer: invalid, maxAttempts: 1 })).failed).toHaveLength(1);
    expect(runtime.jobs()[0].state).toBe('failed'); expect(db.list({ metadata: { runtimeType: 'observation' } }).items).toEqual([]);
    expect(db.isEligible(job.recordId)).toBe(false);
  });

  it('blocks a source correction before dispatch without spending a model call', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db); const source = capture(runtime); runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    db.correct(source.id, { text: 'Updated release process', source: { uri: 'test:correction' }, reason: 'Correction' });
    const call = vi.fn(proposer); const report = await runtime.runJobs({ proposer: call });
    expect(report.modelCalls).toBe(0); expect(report.failed).toHaveLength(1); expect(call).not.toHaveBeenCalled();
  });

  it('revalidates every source after a proposer await and atomically rejects changed evidence', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db); const source = capture(runtime); runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    const report = await runtime.runJobs({ proposer: async request => {
      db.correct(source.id, { text: 'New authoritative release procedure', source: { uri: 'test:correction' }, reason: 'Arrived during proposal' });
      return proposer(request);
    } });
    expect(report.failed).toHaveLength(1); expect(runtime.jobs()[0].state).toBe('failed');
    expect(db.list({ metadata: { runtimeType: 'observation' } }).items).toEqual([]);
  });

  it('prevents simultaneous workers from owning a live lease and recovers an expired lease', async () => {
    const path = location(); let ms = Date.parse('2026-09-12T12:00:00.000Z'); const now = () => new Date(ms);
    const db = memory(path, 'alice', 'project', now); const runtime = new MemoryRuntime(db, { now }); const source = capture(runtime); runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    const second = new MemoryRuntime(memory(path, 'alice', 'project', now), { now });
    const started = deferred<void>(); const finish = deferred<unknown>();
    const firstRun = runtime.runJobs({ timeoutMs: 1000, leaseMs: 2000, proposer: async () => { started.resolve(); return finish.promise; } });
    await started.promise;
    expect((await second.runJobs({ proposer })).modelCalls).toBe(0);
    ms += 2001;
    expect((await second.runJobs({ proposer })).completed).toHaveLength(1);
    finish.resolve({ observations: [{ text: 'Late first worker output.', sourceIds: [source.id] }] });
    expect((await firstRun).failed).toHaveLength(1);
    expect(second.jobs()[0]).toMatchObject({ state: 'done', attempts: 2 });
    expect(db.list({ metadata: { runtimeType: 'observation' } }).items.map(record => record.text)).not.toContain('Late first worker output.');
  });

  it('cancels and times out provider work without committing late results', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db); const source = capture(runtime); runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    let signal: AbortSignal | undefined; const late = deferred<unknown>();
    const timed = await runtime.runJobs({ timeoutMs: 10, proposer: async request => { signal = request.signal; return late.promise; } });
    expect(timed.failed[0].error).toContain('time budget'); expect(signal?.aborted).toBe(true);
    late.resolve({ observations: [{ text: 'Late observation', sourceIds: [source.id] }] }); await Promise.resolve();
    expect(db.list({ metadata: { runtimeType: 'observation' } }).items).toEqual([]);
    const controller = new AbortController(); controller.abort();
    await expect(runtime.runJobs({ proposer, signal: controller.signal })).rejects.toThrow('cancelled');
  });

  it('rejects malformed persisted job state and fails closed when inventory exceeds its scan bound', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db); const source = capture(runtime); const job = runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    const { recordId: _id, ...payload } = job;
    db.correct(job.recordId, { text: JSON.stringify({ ...payload, state: 'running' }), source: { uri: `runtime:job:${job.jobId}` }, reason: 'Controller tampering simulation' });
    expect(() => runtime.jobs()).toThrow('envelope');
    const clean = memory(); const normal = new MemoryRuntime(clean); const a = capture(normal); const b = capture(normal, 'Other source', 'b');
    normal.enqueue({ kind: 'observe', sourceIds: [a.id] }); normal.enqueue({ kind: 'observe', sourceIds: [b.id] });
    await expect(new MemoryRuntime(clean, { maxScanRecords: 1 }).runJobs({ proposer })).rejects.toThrow('scan budget');
  });
});

describe('fresh source-backed mental models', () => {
  it('caches a fresh model without another call and excludes it immediately when corrected or failed evidence changes', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db); const source = capture(runtime); const call = vi.fn(proposer);
    const first = await runtime.refreshModel({ kind: 'model', key: 'releases', sourceIds: [source.id], proposer: call });
    expect(first.status).toBe('fresh'); expect(first.modelCalls).toBe(1);
    expect((await runtime.refreshModel({ kind: 'model', key: 'releases', sourceIds: [source.id], proposer: call })).modelCalls).toBe(0);
    expect(call).toHaveBeenCalledTimes(1); expect(runtime.modelContext('releases').text).toContain(first.record!.text);
    db.recordOutcome({ memoryId: source.id, taskId: 'failure', success: false, evidence: 'Procedure failed in replay', verifier: 'test' });
    expect(runtime.getModel('releases')).toMatchObject({ status: 'stale', modelCalls: 0 });
    expect(runtime.getModel('releases').record).toBeUndefined(); expect(runtime.modelContext('releases').text).toBe('');
    expect(db.isEligible(first.record!.id)).toBe(false);
  });

  it('retires the former model before awaiting a changed source set and never compiles it after a failed refresh', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db); const first = capture(runtime); const second = capture(runtime, 'Second source about release verification', 'second');
    const old = await runtime.refreshModel({ kind: 'model', key: 'release', sourceIds: [first.id], proposer });
    await expect(runtime.refreshModel({ kind: 'model', key: 'release', sourceIds: [first.id, second.id], proposer: async () => {
      expect(db.isEligible(old.record!.id)).toBe(false); throw new Error('Provider failed');
    } })).rejects.toThrow('Provider failed');
    expect(runtime.getModel('release').status).toBe('stale'); expect(db.compile({ query: 'Project releases', maxTokens: 10000 }).items.map(item => item.id)).not.toContain(old.record!.id);
    const next = await runtime.refreshModel({ kind: 'model', key: 'release', sourceIds: [first.id, second.id], proposer });
    expect(next.status).toBe('fresh'); expect(next.record!.metadata.generation).toBe(2);
  });

  it('rebuilds a corrected source model with new dependencies and packs overview before detail within its byte budget', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db); const source = capture(runtime);
    await runtime.refreshModel({ kind: 'model', key: 'releases', sourceIds: [source.id], proposer });
    const corrected = db.correct(source.id, { text: 'The corrected release checklist includes rollback validation.', source: { uri: 'test:corrected' }, reason: 'Improved evidence' });
    expect(runtime.getModel('releases').status).toBe('stale');
    const overview = await runtime.refreshModel({ kind: 'model', key: 'releases', sourceIds: [corrected.id], proposer });
    await runtime.refreshModel({ kind: 'model', key: 'rollback', tier: 'detail', parentKey: 'releases', sourceIds: [corrected.id], proposer: async () => ({ text: 'Rollback validation belongs in each release checklist.', sourceIds: [corrected.id] }) });
    const all = runtime.modelContext('releases'); expect(all.citations).toHaveLength(2); expect(all.citations[0].id).toBe(overview.record!.id);
    const small = runtime.modelContext('releases', { maxBytes: Buffer.byteLength(`[${overview.record!.id}] releases\n${overview.record!.text}`) });
    expect(small.citations).toHaveLength(1); expect(small.excluded).toContain('rollback');
  });

  it('never labels a repeated failed model fresh and allows a revised proposal to form a new generation', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db); const source = capture(runtime);
    const first = await runtime.refreshModel({ kind: 'model', key: 'release', sourceIds: [source.id], proposer });
    db.recordOutcome({ memoryId: first.record!.id, success: false, evidence: 'Model omitted a verified release condition.', verifier: 'fixture', taskId: 'model-failure' });
    expect(runtime.getModel('release').status).toBe('stale');
    await expect(runtime.refreshModel({ kind: 'model', key: 'release', sourceIds: [source.id], proposer })).rejects.toThrow('repeats a failed model');
    const repaired = await runtime.refreshModel({ kind: 'model', key: 'release', sourceIds: [source.id], proposer: async () => ({ text: 'Revised model: inspect release conditions explicitly before proceeding.', sourceIds: [source.id] }) });
    expect(repaired.status).toBe('fresh'); expect(repaired.record!.id).not.toBe(first.record!.id); expect(db.isEligible(first.record!.id)).toBe(false);
  });

  it('commits only one advisory generation when concurrent model refreshes finish with different drafts', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db); const source = capture(runtime);
    const started = deferred<void>(); const finish = deferred<unknown>();
    const slower = runtime.refreshModel({ kind: 'model', key: 'race', sourceIds: [source.id], proposer: async () => { started.resolve(); return finish.promise; } });
    await started.promise;
    const first = await runtime.refreshModel({ kind: 'model', key: 'race', sourceIds: [source.id], proposer: async () => ({ text: 'First coherent project release model.', sourceIds: [source.id] }) });
    finish.resolve({ text: 'Competing project release model.', sourceIds: [source.id] });
    const second = await slower;
    expect(second.record!.id).toBe(first.record!.id);
    expect(db.list({ metadata: { runtimeType: 'model', modelKey: 'race' } }).items).toHaveLength(1);
    expect(db.compile({ query: 'project release model', maxTokens: 10000 }).text).not.toContain('Competing project');
  });

  it('rejects a source corrected while a mental model proposer is awaited', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db); const source = capture(runtime);
    await expect(runtime.refreshModel({ kind: 'model', key: 'project', sourceIds: [source.id], proposer: async request => {
      db.correct(source.id, { text: 'Correction during model refresh', source: { uri: 'test:corrected' }, reason: 'New information' }); return proposer(request);
    } })).rejects.toThrow('unavailable');
    expect(runtime.getModel('project').status).toBe('missing');
  });
});

describe('verified skill lifecycle and outcome attribution', () => {
  it('keeps a candidate non-advisory, activates after an explicit trial and retires immediately on failure', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db); const source = capture(runtime); const skill = candidate(runtime, [source.id]);
    expect(skill.state).toBe('candidate'); expect(db.isEligible(skill.recordId)).toBe(false);
    const active = await runtime.trialSkill({ id: skill.id, validation: passed });
    expect(active.state).toBe('active'); expect(db.isEligible(active.recordId)).toBe(true);
    expect(db.get(active.recordId)!.dependencies).toEqual([source.id]); expect(db.get(active.recordId)!.dependencies).not.toContain(skill.recordId);
    expect(db.getOutcomeSummary(active.recordId)).toEqual({ successes: 1, failures: 0 });
    expect((await runtime.trialSkill({ id: skill.id, validation: passed })).recordId).toBe(active.recordId);
    const failed = await runtime.trialSkill({ id: skill.id, validation: { ...passed, passed: false, taskId: 'trial-2', evidence: 'A failed artifact could not be verified.' } });
    expect(failed.state).toBe('retired'); expect(db.isEligible(active.recordId)).toBe(false); expect(db.isEligible(failed.recordId)).toBe(false);
    expect(runtime.getSkill(skill.id)?.state).toBe('retired');
  });

  it('does not activate when prerequisites fail and rejects conflicting trial identity', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db); const source = capture(runtime); const skill = candidate(runtime, [source.id]);
    expect((await runtime.trialSkill({ id: skill.id, validation: { ...passed, prerequisitesSatisfied: false } })).state).toBe('retired');
    const different = runtime.createSkill({ ...skill.definition, name: 'Other release' });
    await runtime.trialSkill({ id: different.id, validation: passed });
    await expect(runtime.trialSkill({ id: different.id, validation: { ...passed, passed: false } })).rejects.toThrow('identity payload conflict');
    expect(runtime.getSkill(different.id)?.state).toBe('active');
  });

  it('rechecks evidence and competing skill updates after an asynchronous verifier returns', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db); const source = capture(runtime); const skill = candidate(runtime, [source.id]);
    await expect(runtime.trialSkill({ id: skill.id, verifier: async () => {
      db.correct(source.id, { text: 'Revised checklist', source: { uri: 'test:correction' }, reason: 'Changed during trial' }); return passed;
    } })).rejects.toThrow('changed during trial');
    expect(runtime.getSkill(skill.id)?.state).toBe('retired');
    const newSource = capture(runtime, 'Another accepted process', 'new'); const fresh = candidate(runtime, [newSource.id]);
    await expect(runtime.trialSkill({ id: fresh.id, verifier: async () => {
      runtime.retireSkill(fresh.id, 'Controller retired the candidate while trial ran'); return passed;
    } })).rejects.toThrow('changed during trial');
    expect(runtime.getSkill(fresh.id)?.state).toBe('retired');
  });

  it('persists trials across restart and ignores an active state without verified outcome evidence', async () => {
    const path = location(); const db = memory(path); const runtime = new MemoryRuntime(db); const source = capture(runtime); const skill = candidate(runtime, [source.id]);
    const active = await runtime.trialSkill({ id: skill.id, validation: passed }); db.close();
    const reopened = memory(path); const resumed = new MemoryRuntime(reopened);
    expect(resumed.getSkill(skill.id)).toMatchObject({ state: 'active', recordId: active.recordId, trials: [passed] });
    const record = reopened.get(active.recordId)!;
    reopened.correct(active.recordId, { text: record.text, source: record.source, reason: 'Control payload copied without validating the new generation' });
    expect(resumed.getSkill(skill.id)).toBeNull();
  });

  it('credits only explicitly used memories, remains idempotent, and retires a failed used skill without a runner', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db); const source = capture(runtime); const unused = capture(runtime, 'Other unused relevant release observation.', 'unused');
    const skill = candidate(runtime, [source.id]); const active = await runtime.trialSkill({ id: skill.id, validation: passed });
    const traceInput = { taskId: 'release-task', query: 'release', retrievedIds: [active.recordId, unused.id], usedIds: [active.recordId], outcome: { success: false, evidence: 'The used skill failed the release acceptance test.', verifier: 'controller-test' } };
    const trace = runtime.recordTrace(traceInput);
    expect(db.isEligible(trace.id)).toBe(false); expect(db.getOutcomeSummary(unused.id)).toEqual({ successes: 0, failures: 0 });
    expect(db.getOutcomeSummary(active.recordId)).toEqual({ successes: 1, failures: 1 });
    expect(runtime.getSkill(skill.id)?.state).toBe('retired'); expect(db.isEligible(active.recordId)).toBe(false);
    expect(() => runtime.recordTrace({ ...traceInput, taskId: 'invalid', usedIds: [source.id] })).toThrow('members');
    expect(() => runtime.recordTrace(traceInput)).not.toThrow();
  });

  it('rolls back trace and all outcome writes when a used memory belongs to another owner', () => {
    const path = location(); const db = memory(path); const runtime = new MemoryRuntime(db); const own = capture(runtime);
    const shared = memory(path, 'bob').store({ text: 'Shared release evidence', trust: 'observed', visibility: 'workspace', source: { uri: 'test:shared' } });
    expect(() => runtime.recordTrace({ taskId: 'bad-owner', query: 'release', retrievedIds: [own.id, shared.id], usedIds: [own.id, shared.id], outcome: { success: true, evidence: 'Controller trial', verifier: 'test' } })).toThrow('mutable');
    expect(db.getOutcomeSummary(own.id)).toEqual({ successes: 0, failures: 0 }); expect(db.list({ metadata: { runtimeType: 'trace' }, includeUntrusted: true }).items).toEqual([]);
  });
});

describe('document ingestion and durable source forgetting', () => {
  it('preserves direct text and extracted text with attributable MIME/source metadata', async () => {
    const runtime = new MemoryRuntime(memory()); const direct = await runtime.ingest({ uri: 'file:manual.md', mimeType: 'text/markdown', text: '  # Guide\n  ', trust: 'observed' });
    expect(direct.records[0].text).toBe('  # Guide\n  ');
    expect((await runtime.ingest({ uri: 'file:manual.md', mimeType: 'text/markdown', text: '  # Guide\n  ', trust: 'observed' })).records[0].id).toBe(direct.records[0].id);
    const document = await runtime.ingest({ uri: 'file:scan.pdf', mimeType: 'application/pdf', data: new Uint8Array([1, 2, 3]), extractor: async request => {
      expect(request.signal.aborted).toBe(false); expect(request.mimeType).toBe('application/pdf'); return 'Extracted visible document text.';
    } });
    expect(document.records[0]).toMatchObject({ trust: 'untrusted', metadata: { mimeType: 'application/pdf', extraction: 'caller-supplied' }, source: { uri: 'file:scan.pdf' } });
    await expect(runtime.ingest({ uri: 'file:scan.pdf', mimeType: 'application/pdf', text: 'pretend extraction' })).rejects.toThrow('extractor');
    await expect(runtime.ingest({ uri: 'file:scan.pdf', mimeType: 'application/pdf', data: new Uint8Array([1]) })).rejects.toThrow('extractor');
    await expect(runtime.ingest({ uri: 'file:scan.pdf', mimeType: 'application/pdf', data: new Uint8Array([1]), maxOutputBytes: 1, extractor: async () => 'too long' })).rejects.toThrow('Original text');
  });

  it('forgets source, corrections and derived text while retaining only a hashed replay tombstone through restart', async () => {
    const path = location(); const db = memory(path); const runtime = new MemoryRuntime(db); const source = capture(runtime);
    runtime.enqueue({ kind: 'observe', sourceIds: [source.id] }); await runtime.runJobs({ proposer });
    const observationId = runtime.jobs()[0].resultIds[0];
    const corrected = db.correct(source.id, { text: 'Corrected secret release evidence', source: { uri: 'test:corrected' }, reason: 'Revision' });
    const deleted = runtime.forgetSource(corrected.id);
    expect(deleted.deletedIds).toEqual(expect.arrayContaining([source.id, corrected.id, observationId]));
    expect(db.get(source.id)).toBeNull(); expect(db.get(observationId)).toBeNull();
    const tombstones = db.list({ metadata: { runtimeType: 'tombstone' }, includeUntrusted: true }).items;
    expect(tombstones).toHaveLength(1); expect(tombstones[0].text).not.toContain('secret'); expect(tombstones[0].metadata.ingestKey).toBeUndefined();
    expect(db.isEligible(tombstones[0].id)).toBe(false); expect(runtime.forgetSource(corrected.id)).toEqual({ deletedIds: [] });
    db.close(); const reopened = new MemoryRuntime(memory(path));
    expect(() => capture(reopened)).toThrow('tombstone');
    expect(capture(reopened, 'New legitimate event after forgetting', 'new')).toBeDefined();
  });

  it('supersedes document revisions, invalidates derived text, and blocks every revision after logical-source forgetting', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db);
    const input = { uri: 'file:changing.md', mimeType: 'text/markdown', trust: 'observed' as const };
    const first = (await runtime.ingest({ ...input, revision: 'v1', text: 'First release checklist.' })).records[0];
    const model = await runtime.refreshModel({ kind: 'model', key: 'document', sourceIds: [first.id], proposer });
    const next = (await runtime.ingest({ ...input, revision: 'v2', text: 'Updated release checklist.' })).records[0];
    expect(next.supersedes).toBe(first.id); expect(db.get(first.id)?.status).toBe('superseded');
    expect(db.isEligible(model.record!.id)).toBe(false); expect(runtime.getModel('document').status).toBe('stale');
    expect((await runtime.ingest({ ...input, revision: 'v2', text: 'Updated release checklist.' })).records[0].id).toBe(next.id);
    const restored = (await runtime.ingest({ ...input, revision: 'v1', text: 'First release checklist.' })).records[0];
    expect(restored.status).toBe('active'); expect(restored.supersedes).toBe(next.id); expect(restored.id).not.toBe(first.id);
    expect((await runtime.ingest({ ...input, revision: 'v1', text: 'First release checklist.' })).records[0].id).toBe(restored.id);
    expect(db.isEligible(model.record!.id)).toBe(false);
    await expect(runtime.ingest({ ...input, revision: 'v3', trust: 'untrusted', text: 'Untrusted replacement.' })).rejects.toThrow('trust classification');
    runtime.forgetSource(next.id);
    for (const revision of ['v1', 'v2', 'v3']) await expect(runtime.ingest({ ...input, revision, text: 'Must not return after forgetting.' })).rejects.toThrow('tombstone');
    expect(db.get(first.id)).toBeNull(); expect(db.get(next.id)).toBeNull();
  });

  it('restores historical document bytes as a new current revision and invalidates the intervening lesson', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db);
    const input = { uri: 'file:reverted.md', mimeType: 'text/markdown', trust: 'observed' as const };
    const first = (await runtime.ingest({ ...input, text: 'Approval is absent.' })).records[0];
    const second = (await runtime.ingest({ ...input, text: 'Approval is present.' })).records[0];
    const lesson = db.store({ text: 'Release may proceed after approval.', source: { uri: 'test:approval-lesson' }, dependencies: [second.id], trust: 'observed' });
    const restored = (await runtime.ingest({ ...input, text: 'Approval is absent.' })).records[0];
    expect(restored).toMatchObject({ status: 'active', supersedes: second.id, text: first.text });
    expect(restored.id).not.toBe(first.id); expect(db.isEligible(lesson.id)).toBe(false);
    expect((await runtime.ingest({ ...input, text: first.text })).records[0].id).toBe(restored.id);
    expect(db.recall({ query: 'Approval' }).map(item => item.memory.id)).toEqual([restored.id]);
  });

  it('rejects an older extraction completing after a newer document revision', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db);
    const input = { uri: 'file:concurrent.pdf', mimeType: 'application/pdf', trust: 'observed' as const };
    const oldInput = { ...input, data: new Uint8Array([1]) };
    await expect(runtime.ingest({ ...oldInput, extractor: async () => {
      await runtime.ingest({ ...input, data: new Uint8Array([2]), extractor: async () => 'New release requirements.' });
      return 'Old release requirements.';
    } })).rejects.toThrow('changed during extraction');
    expect(db.recall({ query: 'release' }).map(item => item.memory.text)).toEqual(['New release requirements.']);
  });

  it('freezes document identity and input bytes across extraction callbacks', async () => {
    const runtime = new MemoryRuntime(memory()); const bytes = new Uint8Array([1, 2, 3]);
    const input = { uri: 'file:original.pdf', mimeType: 'application/pdf', data: bytes, extractor: async () => {
      input.uri = 'file:mutated.pdf'; bytes[0] = 9; return 'Extracted document';
    } };
    const result = await runtime.ingest(input);
    expect(result.records[0].source.uri).toBe('file:original.pdf');
    expect((await runtime.ingest({ uri: 'file:original.pdf', mimeType: 'application/pdf', data: new Uint8Array([1, 2, 3]), extractor: async () => 'Extracted document' })).records[0].id).toBe(result.records[0].id);
  });

  it('rejects delayed observation and document extraction results when their source identity is forgotten during await', async () => {
    const db = memory(); const runtime = new MemoryRuntime(db); const source = capture(runtime); runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    const report = await runtime.runJobs({ proposer: async request => { runtime.forgetSource(source.id); return proposer(request); } });
    expect(report.failed).toHaveLength(1); expect(db.list({ metadata: { runtimeType: 'observation' } }).items).toEqual([]);
    const input = { uri: 'file:scan.pdf', mimeType: 'application/pdf', data: new Uint8Array([1, 2]) };
    const original = await runtime.ingest({ ...input, extractor: async () => 'Original extraction' });
    await expect(runtime.ingest({ ...input, extractor: async () => { runtime.forgetSource(original.records[0].id); return 'Late extraction'; } })).rejects.toThrow('tombstone');
    expect(db.get(original.records[0].id)).toBeNull();
  });
});
