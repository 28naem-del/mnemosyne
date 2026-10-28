import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { MemoryRuntime, type RuntimeProposer } from '../src/runtime/index.js';

// Issue #37: slow local models (Ollama on CPU, large contexts) can need well
// over a minute per proposal. All waits below use fake time; no test sleeps.
const opened: LocalMemory[] = [];
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  opened.splice(0).forEach(db => db.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function queuedRuntime() {
  const db = createLocalMemory({ path: ':memory:', agentId: 'alice', workspaceId: 'project' }); opened.push(db);
  const runtime = new MemoryRuntime(db);
  const source = runtime.capture({ sessionId: 'session', trust: 'observed', messages: [{ id: 'message-1', role: 'user', text: 'Deploy with the release checklist after tests pass.' }] }).records[0];
  runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
  return { db, runtime, source };
}
/** A proposer that answers only after `delayMs` of (fake) time, like a slow local model. */
function slowProposer(delayMs: number, calls: { started: number }): RuntimeProposer {
  return request => new Promise(done => {
    calls.started++;
    setTimeout(() => done({ observations: [{ text: 'A release waits for its checklist.', sourceIds: [request.sources[0].id] }] }), delayMs);
  });
}

describe('runJobs timeouts for slow local models', () => {
  it('lets a proposer that answers after 90 s of fake time succeed when timeoutMs is 120 s', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-28T12:00:00.000Z') });
    const { db, runtime } = queuedRuntime(); const calls = { started: 0 };
    const run = runtime.runJobs({ timeoutMs: 120_000, proposer: slowProposer(90_000, calls) });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.started).toBe(1);
    // While the slow call is in flight the default lease (timeoutMs + 1 s) covers it.
    expect(Date.parse(runtime.jobs()[0].leaseUntil!) - Date.now()).toBe(121_000);
    await vi.advanceTimersByTimeAsync(90_000);
    const report = await run;
    expect(report.failed).toEqual([]); expect(report.completed).toHaveLength(1); expect(report.modelCalls).toBe(1);
    expect(runtime.jobs()[0].state).toBe('done');
    expect(db.list({ metadata: { runtimeType: 'observation' } }).items.map(record => record.text)).toContain('A release waits for its checklist.');
  });

  it('keeps the 30 s default and still enforces a raised timeout', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-28T12:00:00.000Z') });
    const byDefault = queuedRuntime(); const calls = { started: 0 };
    const defaultRun = byDefault.runtime.runJobs({ proposer: slowProposer(90_000, calls) });
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await defaultRun).failed[0].error).toBe('Runtime time budget exceeded.');
    const raised = queuedRuntime();
    const raisedRun = raised.runtime.runJobs({ timeoutMs: 120_000, proposer: slowProposer(150_000, calls) });
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await raisedRun).failed[0].error).toBe('Runtime time budget exceeded.');
    expect(raised.db.list({ metadata: { runtimeType: 'observation' } }).items).toEqual([]);
  });

  it('accepts timeouts up to 300 s, rejects larger ones, and requires lease > timeout up to 600 s', async () => {
    const { runtime } = queuedRuntime(); const proposer = slowProposer(0, { started: 0 });
    // 120 s was above the former 60 s ceiling ("from 10 to 60000"); it is now valid.
    await expect(runtime.runJobs({ timeoutMs: 120_000, maxCalls: 0, proposer })).resolves.toMatchObject({ modelCalls: 0 });
    await expect(runtime.runJobs({ timeoutMs: 300_000, leaseMs: 600_000, maxCalls: 0, proposer })).resolves.toMatchObject({ modelCalls: 0 });
    await expect(runtime.runJobs({ timeoutMs: 300_001, proposer })).rejects.toThrow('Runtime budget must be an integer from 10 to 300000.');
    await expect(runtime.runJobs({ timeoutMs: 120_000, leaseMs: 120_000, proposer })).rejects.toThrow('from 120001 to 600000');
    await expect(runtime.runJobs({ timeoutMs: 300_000, leaseMs: 600_001, proposer })).rejects.toThrow('from 300001 to 600000');
  });
});

function fixture() { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-timeouts-')); roots.push(root); return { root, db: join(root, 'memory.sqlite') }; }
function providerFile(root: string, extra: Record<string, unknown> = {}) {
  // Port 9 (discard) on loopback: none of these commands reach a model call.
  const file = join(root, `provider-${Object.keys(extra).join('-') || 'plain'}.json`);
  writeFileSync(file, JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1', model: 'never-called', ...extra })); return file;
}
function invoke(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve('dist/cli/index.js'), ...args], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI test deadline')); }, 15000);
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('error', e => { clearTimeout(timeout); reject(e); }); child.once('close', status => { clearTimeout(timeout); resolveResult({ status, stdout, stderr }); });
  });
}

describe('CLI timeout configuration', () => {
  it('passes a raised runJobs timeout and a provider timeoutMs through run-jobs', async () => {
    const f = fixture(); const scope = ['--db', f.db, '--workspace', 'fixture', '--agent', 'worker'];
    const ok = await invoke(['run-jobs', ...scope, '--provider-config', providerFile(f.root, { timeoutMs: 120000 }), '--json', '{"timeoutMs":120000,"maxCalls":0}']);
    expect(ok.status, ok.stderr).toBe(0); expect(JSON.parse(ok.stdout).modelCalls).toBe(0);
    const tooLong = await invoke(['run-jobs', ...scope, '--provider-config', providerFile(f.root), '--json', '{"timeoutMs":300001,"maxCalls":0}']);
    expect(tooLong.status).toBe(1); expect(tooLong.stderr).toContain('from 10 to 300000');
    const badProvider = await invoke(['run-jobs', ...scope, '--provider-config', providerFile(f.root, { timeoutMs: 300001 }), '--json', '{"maxCalls":0}']);
    expect(badProvider.status).toBe(1); expect(badProvider.stderr).toContain('apiKeyEnv and timeoutMs (1 to 300000 ms)');
  }, 30_000);

  it('rejects agent work timeouts above 300 s and leases that do not exceed the timeout', async () => {
    const f = fixture(); const provider = providerFile(f.root);
    for (const [json, message] of [['{"timeoutMs":300001}', ''], ['{"timeoutMs":120000,"leaseMs":120000}', 'Lease must exceed the proposer timeout.'], ['{"timeoutMs":120000,"leaseMs":600001}', '']]) {
      const result = await invoke(['agent', '--action', 'work', '--db', f.db, '--workspace', 'fixture', '--agent', 'worker', '--provider-config', provider, '--json', json]);
      expect(result.status, json).toBe(1); expect(result.stderr).toContain(message);
    }
  }, 30_000);
});
