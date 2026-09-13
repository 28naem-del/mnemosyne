import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { MemoryRuntime, type RuntimeProposer } from '../src/runtime/index.js';
import { MemoryMaintenance } from '../src/maintenance/index.js';
import { MemoryAgent, AgentOperationError, messagesFromAgentEvents } from '../src/agent/index.js';

const opened: LocalMemory[] = [], agents: MemoryAgent[] = [], roots: string[] = [];
const proposer: RuntimeProposer = async request => ({ observations: [{ text: `Evidence-supported observation: ${request.sources[0].text}`, sourceIds: [request.sources[0].id] }] });
function db(path = ':memory:', agentId = 'alice', now?: () => Date) { const value = createLocalMemory({ path, workspaceId: 'agent-fixture', agentId, now }); opened.push(value); return value; }
function agent(memory = db(), options: ConstructorParameters<typeof MemoryAgent>[1] = {}) { const value = new MemoryAgent(new MemoryRuntime(memory), { captureTrust: 'observed', ...options }); agents.push(value); return value; }
function path() { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-agent-')); roots.push(root); return join(root, 'memory.db'); }
function capture(value: MemoryAgent, text = 'Atlas deployment needs two reviewers.', id = 'one', visibility: 'private' | 'workspace' = 'private') {
  return value.afterTurn({ sessionId: 's', messages: [{ id, text, role: 'user' }], visibility });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
afterEach(async () => { await Promise.all(agents.splice(0).map(value => value.close())); opened.splice(0).forEach(value => value.close()); roots.splice(0).forEach(value => rmSync(value, { recursive: true, force: true })); });

describe('host lifecycle capture and context', () => {
  it('is useful without providers and scopes two clients through correction and forgetting', async () => {
    const file = path(), alice = agent(db(file)), bob = agent(db(file, 'bob'));
    const secret = capture(alice, 'Atlas private deployment location.', 'private').records[0];
    const shared = capture(alice, 'Atlas deployment needs two reviewers.', 'shared', 'workspace').records[0];
    const context = await bob.beforeTurn({ query: 'Atlas deployment', maxTokens: 8192 });
    expect(context.context.memoryIds).toContain(shared.id); expect(context.context.memoryIds).not.toContain(secret.id);
    expect(await alice.drain()).toMatchObject({ status: 'no-proposer', modelCalls: 0 });
    const action = bob.prepareAction({ name: 'deploy', args: { reviewers: 2 }, memoryIds: [shared.id], dependenciesComplete: true });
    const corrected = alice.runtime.memory.correct(shared.id, { text: 'Atlas deployment now requires three reviewers.', source: { uri: 'fixture:correction' }, reason: 'Updated policy' });
    const host = vi.fn(async () => 'sent');
    await expect(bob.executeAction(action, host)).rejects.toMatchObject({ code: 'action-rejected' }); expect(host).not.toHaveBeenCalled();
    expect((await bob.beforeTurn({ query: 'Atlas deployment', maxTokens: 8192 })).context.memoryIds).toContain(corrected.id);
    alice.forgetSource(corrected.id);
    expect((await bob.beforeTurn({ query: 'Atlas deployment', maxTokens: 8192 })).context.memoryIds).not.toContain(corrected.id);
    expect(() => capture(alice, 'Atlas deployment needs two reviewers.', 'shared', 'workspace')).toThrow('forgotten');
  });

  it('captures exact bytes and atomically schedules stable per-message jobs across growing replays', () => {
    const value = agent(); const text = '  Café 😀\n\tAtlas  ';
    const first = capture(value, text); const replay = value.afterTurn({ sessionId: 's', messages: [{ id: 'one', role: 'user', text }, { id: 'two', role: 'assistant', text: 'Visible output.' }] });
    expect(replay.records[0].id).toBe(first.records[0].id); expect(replay.records[0].text).toBe(text);
    expect(value.runtime.jobs()).toHaveLength(2); expect(replay.jobs[0].jobId).toBe(first.jobs[0].jobId);
    const before = value.runtime.memory.export();
    expect(() => value.afterTurn({ sessionId: 's', messages: [{ id: 'new', role: 'user', text: 'New text' }, { id: 'one', role: 'user', text: 'Conflicting replay' }] })).toThrow('Idempotency');
    expect(value.runtime.memory.export().memories).toEqual(before.memories);
  });

  it('defaults supplied content to untrusted and leaves it out of advisory context and model jobs', async () => {
    const value = new MemoryAgent(new MemoryRuntime(db())); agents.push(value);
    const result = capture(value); expect(result.scheduling).toBe('ineligible'); expect(result.jobs).toEqual([]);
    expect((await value.beforeTurn({ query: 'Atlas deployment' })).context.memoryIds).toEqual([]);
  });

  it.each(['capture', 'recall', 'read-only'])('honors %s restriction before callback or processing', async policy => {
    const runtime = new MemoryRuntime(db(), { captureEnabled: policy !== 'capture', recallEnabled: policy !== 'recall' });
    const builder = vi.fn(async () => ({ text: '', tokens: 0, tokenBudget: 4096, memoryIds: [], abstained: true }));
    const value = new MemoryAgent(runtime, { readOnly: policy === 'read-only', contextBuilder: builder, captureTrust: 'observed', proposer }); agents.push(value);
    const result = capture(value); expect(result.scheduling).toBe(policy === 'recall' ? 'recall-disabled' : 'disabled');
    expect(await value.drain()).toMatchObject({ status: 'disabled', modelCalls: 0 });
    if (policy === 'recall') { expect(await value.beforeTurn({ query: 'Atlas' })).toMatchObject({ enabled: false }); expect(builder).not.toHaveBeenCalled(); }
    else { const host = vi.fn(async () => 'Output'); await expect(value.runTurn({ input: 'Hello', query: 'Hello', sessionId: 's', turnId: 't' }, host)).rejects.toThrow(); expect(host).not.toHaveBeenCalled(); }
  });

  it('permits privacy erasure with capture and recall disabled, while read-only denies it', () => {
    const memory = db(), value = agent(memory), source = capture(value).records[0];
    const disabled = new MemoryAgent(new MemoryRuntime(memory, { captureEnabled: false, recallEnabled: false })); agents.push(disabled);
    const readOnly = agent(memory, { readOnly: true }); expect(() => readOnly.forgetSource(source.id)).toThrow('read-only');
    expect(disabled.forgetSource(source.id).deletedIds).toContain(source.id);
  });

  it('does not return custom context after its evidence changes during an await', async () => {
    const memory = db(), source = capture(agent(memory)).records[0]; const ready = deferred<void>(), finish = deferred<void>();
    const value = agent(memory, { contextBuilder: async () => { ready.resolve(); await finish.promise; return { text: source.text, tokens: 20, tokenBudget: 100, memoryIds: [source.id], abstained: false }; } });
    const pending = value.beforeTurn({ query: 'Atlas', maxTokens: 100 }); await ready.promise; value.forgetSource(source.id); finish.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'context-failed' });
  });
});

describe('bounded single-flight background work', () => {
  it('persists jobs across close/reopen, processes captured evidence, and forget prevents resurrection', async () => {
    const file = path(), first = agent(db(file)); const source = capture(first).records[0]; await first.close(); first.runtime.memory.close();
    const second = agent(db(file), { proposer }); const handle = second.start({ maxCycles: 1, maxCalls: 1 });
    expect(await handle.done).toMatchObject({ cycles: 1, completed: 1, modelCalls: 1 });
    expect((await second.beforeTurn({ query: 'Atlas reviewers', maxTokens: 8192 })).context.text).toContain('Evidence-supported observation');
    second.forgetSource(source.id); expect(second.runtime.jobs()).toEqual([]);
    expect((await second.drain()).modelCalls).toBe(0); expect(() => capture(second)).toThrow('forgotten');
  });

  it('keeps manual and background drains single-flight and enforces total call budgets', async () => {
    const begin = deferred<void>(), end = deferred<void>(); let active = 0, peak = 0;
    const value = agent(db(), { proposer: async request => { active++; peak = Math.max(peak, active); begin.resolve(); await end.promise; active--; return proposer(request); }, jobBudgets: { maxCalls: 1 } });
    capture(value, 'Atlas one', 'one'); capture(value, 'Atlas two', 'two');
    const run = value.drain(); expect(value.drain()).toBe(run); expect(() => value.start()).toThrow('manual');
    await begin.promise; end.resolve(); await run; expect(peak).toBe(1);
    const handle = value.start({ maxCycles: 10, maxCalls: 1, intervalMs: 10 }); expect(value.start()).toBe(handle);
    expect(await handle.done).toMatchObject({ modelCalls: 1, reason: 'budget' });
    expect(value.runtime.jobs().filter(job => job.state === 'done')).toHaveLength(2);
  });

  it('ends idle loops within cycle and duration bounds and starts no provider in local mode', async () => {
    const local = agent(); expect(await local.start().done).toMatchObject({ reason: 'no-proposer', modelCalls: 0, cycles: 0 });
    const callback = vi.fn(proposer), value = agent(db(), { proposer: callback });
    expect(await value.start({ maxCycles: 3, intervalMs: 10 }).done).toMatchObject({ cycles: 3, modelCalls: 0, reason: 'completed' });
    expect(await value.start({ maxCycles: 100, intervalMs: 1000, maxDurationMs: 10 }).done).toMatchObject({ reason: 'cancelled' });
    expect(callback).not.toHaveBeenCalled();
  });

  it('cancels a running callback, ignores late output, and permits later recovery', async () => {
    const begin = deferred<void>(), late = deferred<unknown>(); let seenSignal: AbortSignal | undefined;
    const value = agent(db(), { proposer: async request => { seenSignal = request.signal; begin.resolve(); return late.promise; }, jobBudgets: { maxJobs: 1 } });
    const source = capture(value).records[0]; const handle = value.start(); await begin.promise;
    expect(await handle.stop()).toMatchObject({ reason: 'cancelled', completed: 0 }); expect(seenSignal?.aborted).toBe(true);
    late.resolve({ observations: [{ text: 'Late source observation', sourceIds: [source.id] }] }); await Promise.resolve();
    expect(value.runtime.memory.list({ metadata: { runtimeType: 'observation' } }).items).toEqual([]);
    const resumed = agent(value.runtime.memory, { proposer }); expect((await resumed.drain()).completed).toHaveLength(1);
  });

  it('close aborts manual drain without retaining provider error text', async () => {
    const begin = deferred<void>(); const value = agent(db(), { proposer: async request => { begin.resolve(); return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('PRIVATE_ERROR_TOKEN')), { once: true })); } });
    capture(value); const run = value.drain(); await begin.promise; await value.close(); await run;
    expect(JSON.stringify(value.runtime.memory.export())).not.toContain('PRIVATE_ERROR_TOKEN');
  });

  it('reclaims an expired durable lease after a crashed client without double-committing', async () => {
    const file = path(); let millis = Date.parse('2026-09-13T12:00:00.000Z'); const now = () => new Date(millis);
    const memory = db(file, 'alice', now), runtime = new MemoryRuntime(memory, { now }), begun = deferred<void>(), late = deferred<unknown>();
    const first = new MemoryAgent(runtime, { captureTrust: 'observed', proposer: async () => { begun.resolve(); return late.promise; }, jobBudgets: { timeoutMs: 1000, leaseMs: 1001 } }); agents.push(first);
    const source = capture(first).records[0]; const pending = first.drain(); await begun.promise; millis += 1002;
    const second = new MemoryAgent(new MemoryRuntime(db(file, 'alice', now), { now }), { proposer }); agents.push(second);
    expect((await second.drain()).completed).toHaveLength(1); late.resolve({ observations: [{ text: 'Obsolete late output', sourceIds: [source.id] }] }); await pending;
    expect(second.runtime.jobs()[0]).toMatchObject({ state: 'done', attempts: 2 });
    expect(second.runtime.memory.list({ metadata: { runtimeType: 'observation' } }).items).toHaveLength(1);
  });
});

describe('action-bound freshness and host turn dispatch', () => {
  it('freezes bound arguments, rejects action replay, and catches microtask revocation before dispatch', async () => {
    const value = agent(), source = capture(value).records[0], args = { reviewers: 2 };
    const action = value.prepareAction({ name: 'deploy', args, memoryIds: [source.id], dependenciesComplete: true }); args.reviewers = 0;
    const host = vi.fn(async request => request.args);
    expect(await value.executeAction(action, host)).toEqual({ reviewers: 2 });
    await expect(value.executeAction(action, host)).rejects.toMatchObject({ code: 'action-rejected' }); expect(host).toHaveBeenCalledTimes(1);
    const next = value.prepareAction({ name: 'deploy', args, memoryIds: [source.id], dependenciesComplete: true }); const blocked = value.executeAction(next, host);
    value.forgetSource(source.id); await expect(blocked).rejects.toMatchObject({ code: 'action-rejected' }); expect(host).toHaveBeenCalledTimes(1);
  });

  it('withholds stale watched evidence and expires a prepared action at the freshness boundary', async () => {
    let time = Date.parse('2026-09-13T12:00:00.000Z'); const now = () => new Date(time); const memory = db(':memory:', 'alice', now), runtime = new MemoryRuntime(memory, { now });
    const maintenance = new MemoryMaintenance(runtime, { now }); const value = new MemoryAgent(runtime, { maintenance, captureTrust: 'observed' }); agents.push(value);
    const source = capture(value).records[0]; const watch = maintenance.watchMemory({ memoryId: source.id, maxAgeMs: 100 });
    expect((await value.beforeTurn({ query: 'Atlas' })).context.memoryIds).not.toContain(source.id);
    maintenance.recordCheck({ memoryId: source.id, expectedStateHash: watch.stateHash, observation: { status: 'confirmed', evidence: 'Synthetic file checked.', verifier: 'fixture' } });
    const action = value.prepareAction({ name: 'deploy', args: {}, memoryIds: [source.id], dependenciesComplete: true, requireWatched: true }); time += 100;
    const host = vi.fn(async () => true); await expect(value.executeAction(action, host)).rejects.toMatchObject({ code: 'action-rejected' }); expect(host).not.toHaveBeenCalled();
  });

  it('runTurn calls host once, captures input/output, then durably blocks callback replay after reopening', async () => {
    const file = path(), value = agent(db(file)); const call = vi.fn(async () => '  Atlas visible output\n');
    const input = { query: 'Atlas', input: '  Atlas visible input\n', sessionId: 's', turnId: 't' };
    const result = await value.runTurn(input, call); expect(call).toHaveBeenCalledTimes(1);
    expect(result.after.records.map(record => record.text)).toEqual([input.input, '  Atlas visible output\n']); expect(result.after.jobs).toHaveLength(2);
    await value.close(); value.runtime.memory.close(); const resumed = agent(db(file));
    await expect(resumed.runTurn(input, call)).rejects.toMatchObject({ code: 'already-attempted' }); expect(call).toHaveBeenCalledTimes(1);
    resumed.forgetSource(result.after.records[0].id);
    await expect(resumed.runTurn(input, call)).rejects.toMatchObject({ code: 'already-attempted' }); expect(call).toHaveBeenCalledTimes(1);
  });

  it('never retries failed or cancelled host calls and does not persist raw errors', async () => {
    const value = agent(), host = vi.fn(async () => { throw new Error('PRIVATE_HOST_FAILURE'); });
    const input = { query: 'Atlas', input: 'Visible input', sessionId: 's', turnId: 'failure' };
    await expect(value.runTurn(input, host)).rejects.toMatchObject({ code: 'host-failed' });
    await expect(value.runTurn(input, host)).rejects.toMatchObject({ code: 'already-attempted' }); expect(host).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(value.runtime.memory.export())).not.toContain('PRIVATE_HOST_FAILURE');
    const signal = new AbortController(); signal.abort();
    await expect(value.runTurn({ ...input, turnId: 'cancelled', signal: signal.signal }, host)).rejects.toMatchObject({ code: 'cancelled' }); expect(host).toHaveBeenCalledTimes(1);
  });

  it('surfaces visible response for reconciliation when capture fails after the host completed', async () => {
    const value = agent(); const response = 'x'.repeat(65537);
    let error: unknown; try { await value.runTurn({ query: 'Atlas', input: 'Input', sessionId: 's', turnId: 't' }, async () => response); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AgentOperationError); expect(error).toMatchObject({ code: 'capture-failed', response });
    expect(value.runtime.memory.list({ metadata: { runtimeType: 'source' } }).items).toEqual([]);
    expect(JSON.stringify(value.runtime.memory.export())).not.toContain(response);
  });
});

describe('documented supplied SDK event adapters', () => {
  it('captures only completed Codex agent messages and rejects a foreign thread envelope', () => {
    const value = agent();
    const result = value.afterEvents({ adapter: 'codex', sessionId: 'thread', events: [
      { type: 'thread.started', thread_id: 'thread' }, { type: 'item.updated', item: { id: 'a', type: 'agent_message', text: 'partial' } },
      { type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'PRIVATE_REASONING' } },
      { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: '  Final visible answer\n' } },
      { type: 'item.completed', item: { id: 'tool', type: 'mcp_tool_call', arguments: { secret: 'PRIVATE_TOOL' } } },
    ] });
    expect(result.records.map(record => record.text)).toEqual(['  Final visible answer\n']);
    expect(() => value.afterEvents({ adapter: 'codex', sessionId: 'thread', events: [{ type: 'thread.started', thread_id: 'other' }] })).toThrow('session scope');
    expect(JSON.stringify(value.runtime.memory.export())).not.toContain('PRIVATE_');
  });

  it('requires stable Claude message IDs and scope while ignoring reasoning, synthetic and subagent content', () => {
    const events = [
      { type: 'assistant', uuid: 'one', session_id: 'session', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: '  Hello ' }, { type: 'thinking', thinking: 'PRIVATE' }, { type: 'text', text: 'world\n' }] } },
      { type: 'user', uuid: 'tool', session_id: 'session', message: { role: 'user', content: [{ type: 'tool_result', content: 'PRIVATE' }] } },
      { type: 'user', uuid: 'synthetic', session_id: 'session', isSynthetic: true, message: { content: 'PRIVATE' } },
      { type: 'assistant', uuid: 'child', session_id: 'session', parent_tool_use_id: 'tool', message: { content: 'PRIVATE' } },
      { type: 'result', result: 'Duplicate answer', session_id: 'session' },
    ];
    expect(messagesFromAgentEvents({ adapter: 'claude', sessionId: 'session', events })).toEqual([{ id: 'one', role: 'assistant', text: '  Hello world\n' }]);
    expect(() => messagesFromAgentEvents({ adapter: 'claude', sessionId: 'session', events: [{ type: 'user', session_id: 'session', message: { content: 'No ID' } }] })).toThrow('stable IDs');
  });
});
