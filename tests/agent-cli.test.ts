import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory } from '../src/local/index.js';

const roots: string[] = [], servers: Server[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-agent-cli-')); roots.push(root); return { root, db: join(root, 'memory.sqlite') }; }
function invoke(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve('dist/cli/index.js'), ...args], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI test deadline')); }, 15000);
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('error', e => { clearTimeout(timeout); reject(e); }); child.once('close', status => { clearTimeout(timeout); resolveResult({ status, stdout, stderr }); });
  });
}
async function provider(root: string) {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', b => { body += b; }); req.once('end', () => {
      const data = JSON.parse(body); bodies.push(data);
      const system = data.messages[0].content as string;
      const content = system.startsWith('Answer the question') ? JSON.stringify({ answer: 'unknown', action: 'abstain', citations: [] }) : 'The orchid is violet.';
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test address');
  const file = join(root, 'provider.json'); writeFileSync(file, JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'loopback-fixture', revision: '1' }));
  return { file, bodies };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.close(() => r()); s.closeAllConnections(); })));
  roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true }));
});

describe('new user command-line workflows with synthetic local data', () => {
  it('rejects ignored settings and capability violations before creating a database', async () => {
    const f = fixture(); const p = await provider(f.root);
    for (const args of [
      ['work', '--json', '{"maxCalls":65}'], ['work', '--json', '{"intervalMs":10}'],
      ['work', '--json', '{"leaseMs":10,"timeoutMs":10}'], ['context', '--query', 'orchid', '--share'],
      ['turn', '--read-only'], ['work', '--no-capture'],
    ]) {
      const result = await invoke(['agent', '--db', f.db, '--workspace', 'fixture', '--agent', 'reader', '--action', args[0], '--provider-config', p.file, ...args.slice(1)]);
      expect(result.status).toBe(1); expect(existsSync(f.db)).toBe(false);
    }
    expect(p.bodies).toEqual([]);
  });

  it('keeps single-drain budgets distinct from aggregate background budgets', async () => {
    const f = fixture(); const p = await provider(f.root);
    for (const flags of [ ['--json', '{"maxCalls":0,"maxTotalInputBytes":0}'], ['--watch', '--json', '{"maxCalls":1000,"maxTotalInputBytes":5000000,"maxCycles":1}'] ]) {
      const result = await invoke(['agent', '--action', 'work', '--db', f.db, '--workspace', 'fixture', '--agent', 'reader', '--provider-config', p.file, ...flags]);
      expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).modelCalls).toBe(0);
    }
    expect(p.bodies).toEqual([]);
  });

  it('captures shared completed SDK events and denies duplicate external turn dispatch', async () => {
    const f = fixture(); const p = await provider(f.root); const file = join(f.root, 'events.json');
    writeFileSync(file, JSON.stringify([{ type: 'thread.started', thread_id: 'session' }, { type: 'item.completed', item: { type: 'agent_message', id: 'message', text: 'The orchid is violet.' } }]));
    const scope = ['--db', f.db, '--workspace', 'fixture', '--agent', 'first'];
    const captured = await invoke(['agent', ...scope, '--action', 'capture-events', '--adapter', 'codex', '--session', 'session', '--file', file, '--share', '--trust', 'observed']);
    expect(captured.status, captured.stderr).toBe(0);
    const other = createLocalMemory({ path: f.db, workspaceId: 'fixture', agentId: 'other' });
    try { expect(other.recall({ query: 'orchid' })).toHaveLength(1); } finally { other.close(); }
    const turn = ['agent', ...scope, '--action', 'turn', '--session', 'session', '--key', 'turn', '--text', 'Orchid color?', '--provider-config', p.file];
    const result = await invoke(turn); expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).response).toContain('violet');
    const duplicate = await invoke(turn); expect(duplicate.status).toBe(1); expect(p.bodies).toHaveLength(1);
  });

  it('runs all four matched benchmark conditions and refuses output collisions before reader calls', async () => {
    const f = fixture(); const p = await provider(f.root); const file = join(f.root, 'dataset.json'), out = join(f.root, 'report.json');
    writeFileSync(file, JSON.stringify({ protocol: 'mnemosyne-agent-benchmark-v1', name: 'cli fixture', revision: '1', split: 'development', episodes: [{ id: 'e', category: 'abstain', events: [{ operation: 'task', id: 'q', query: 'Unknown orchid?', answers: ['unknown'], action: 'abstain', evidenceKeys: [] }] }] }));
    const args = ['benchmark-agent', '--file', file, '--provider-config', p.file, '--out', out, '--json', '{"trials":1}'];
    const result = await invoke(args); expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(readFileSync(out, 'utf8')); expect(report.readerCalls).toBe(4); expect(report.conditions).toHaveLength(4); expect(existsSync(f.db)).toBe(false);
    expect((await invoke(args)).status).toBe(1); expect(p.bodies).toHaveLength(4);
  });

  it('backs up, verifies and restores through the packaged worker without overwriting existing data', async () => {
    const f = fixture(); const memory = createLocalMemory({ path: f.db, workspaceId: 'fixture', agentId: 'first' });
    memory.store({ text: 'The orchid is violet.', trust: 'observed', source: { uri: 'fixture:orchid' } }); memory.close();
    const backup = join(f.root, 'snapshot.mnemo-backup'), target = join(f.root, 'restored.sqlite');
    for (const args of [ ['backup', '--db', f.db, '--out', backup], ['verify', '--file', backup], ['restore', '--file', backup, '--out', target] ]) {
      const result = await invoke(['operations', '--action', ...args]); expect(result.status, result.stderr).toBe(0);
    }
    const restored = createLocalMemory({ path: target, workspaceId: 'fixture', agentId: 'first' });
    try { expect(restored.recall({ query: 'orchid' })).toHaveLength(1); } finally { restored.close(); }
    expect((await invoke(['operations', '--action', 'restore', '--file', backup, '--out', target])).status).toBe(1);
    expect((await invoke(['operations', '--file', backup, '--workspace', 'first'])).status).toBe(1);
  });
});
