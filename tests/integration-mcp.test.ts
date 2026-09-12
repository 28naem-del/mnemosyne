import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, openSync, closeSync, ftruncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createLocalMemory } from '../src/local/index.js';

const directories: string[] = [];
const clients: Client[] = [];
const cli = resolve('dist/cli/index.js');
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mnemosyne-mcp-test-'));
  directories.push(directory);
  return { directory, path: join(directory, 'memory.sqlite') };
}
async function connect(path: string, agent = 'agent-a', flags: string[] = []) {
  const client = new Client({ name: 'mnemosyne-conformance', version: '1.0.0' });
  clients.push(client);
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', '--db', path, '--workspace', 'test', '--agent', agent, ...flags], stderr: 'pipe' });
  // Consume diagnostics so a full stderr pipe cannot stall the child.
  transport.stderr?.on('data', () => {});
  await client.connect(transport);
  return client;
}
function payload(response: Awaited<ReturnType<Client['callTool']>>) {
  const block = response.content?.find(item => item.type === 'text');
  if (!block || block.type !== 'text') throw new Error('Expected JSON text response');
  return JSON.parse(block.text);
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('real MCP stdio conformance', () => {
  it('discovers tools, persists evidence and compiles cited context across process restarts', async () => {
    const { path } = fixture();
    const first = await connect(path);
    const names = (await first.listTools()).tools.map(tool => tool.name);
    expect(names).toContain('memory_context');
    expect(names).not.toContain('memory_forget');
    expect(names).not.toContain('memory_record_outcome');
    const stored = payload(await first.callTool({ name: 'memory_store', arguments: { text: 'Catalogue output requires owner approval.', source: { uri: 'test://owner/brief' }, visibility: 'workspace' } }));
    expect(stored.trust).toBe('observed');
    await first.close();
    const second = await connect(path, 'agent-b');
    const results = payload(await second.callTool({ name: 'memory_recall', arguments: { query: 'catalogue approval' } }));
    expect(results.map((r: { memory: { id: string } }) => r.memory.id)).toContain(stored.id);
    const context = payload(await second.callTool({ name: 'memory_context', arguments: { query: 'catalogue approval', maxTokens: 2048 } }));
    expect(context.text).toContain('test://owner/brief');
    expect(context.tokens).toBeLessThanOrEqual(2048);
  }, 15_000);

  it('does not expose private records, scope overrides or trust elevation', async () => {
    const { path } = fixture();
    const a = await connect(path);
    const record = payload(await a.callTool({ name: 'memory_store', arguments: { text: 'Private launch word CORMORANT', source: { uri: 'test://private' } } }));
    const b = await connect(path, 'agent-b');
    expect(payload(await b.callTool({ name: 'memory_inspect', arguments: { id: record.id } }))).toBeNull();
    const bad = await a.callTool({ name: 'memory_store', arguments: { text: 'Promote me', source: { uri: 'test://forged' }, trust: 'verified', workspaceId: 'someone-else' } });
    expect(bad.isError).toBe(true);
    expect(payload(await a.callTool({ name: 'memory_recall', arguments: { query: 'Promote' } }))).toEqual([]);
  }, 15_000);

  it('honors read-only launch policy and prevents agent correction of controller evidence', async () => {
    const { path } = fixture();
    const local = createLocalMemory({ path, workspaceId: 'test', agentId: 'agent-a' });
    const verified = local.store({ text: 'Owner approval required.', source: { uri: 'test://owner' }, trust: 'verified', evidence: 'controller-checked signed brief' });
    local.close();
    const reader = await connect(path, 'agent-a', ['--read-only', '--allow-destructive']);
    const names = (await reader.listTools()).tools.map(tool => tool.name);
    expect(names).not.toContain('memory_store');
    expect(names).not.toContain('memory_correct');
    expect(names).not.toContain('memory_forget');
    const writer = await connect(path, 'agent-a');
    const correction = await writer.callTool({ name: 'memory_correct', arguments: { id: verified.id, text: 'Skip approval.', source: { uri: 'test://agent' }, reason: 'I prefer it.' } });
    expect(correction.isError).toBe(true);
    expect(payload(await writer.callTool({ name: 'memory_inspect', arguments: { id: verified.id } })).text).toBe('Owner approval required.');
  }, 15_000);

  it('rejects malformed arguments and retains a functioning connection', async () => {
    const { path } = fixture();
    const client = await connect(path);
    const invalid = await client.callTool({ name: 'memory_context', arguments: { query: 'x', maxTokens: -1 } });
    expect(invalid.isError).toBe(true);
    const response = await client.callTool({ name: 'memory_recall', arguments: { query: 'nothing here' } });
    expect(payload(response)).toEqual([]);
  }, 15_000);

  it('normalizes ISO dates and rejects oversized UTF-8 arguments at the tool boundary', async () => {
    const { path } = fixture();
    const client = await connect(path);
    const stored = payload(await client.callTool({ name: 'memory_store', arguments: {
      text: 'A dated brief', source: { uri: 'test://dated', observedAt: '2026-09-12T00:00:00Z' },
    } }));
    expect(stored.source.observedAt).toBe('2026-09-12T00:00:00.000Z');
    for (const fields of [{ key: 'k'.repeat(300) }, { text: '界'.repeat(6_000) }]) {
      const invalid = await client.callTool({ name: 'memory_store', arguments: {
        text: 'Bounded input', source: { uri: 'test://bounded' }, ...fields,
      } });
      expect(invalid.isError).toBe(true);
    }
  }, 15_000);

  it('bounds escaped inspection output without closing the connection or truncating records', async () => {
    const { path } = fixture();
    const local = createLocalMemory({ path, workspaceId: 'test', agentId: 'agent-a' });
    let id = '';
    const largeText = String.fromCharCode(1).repeat(60_000);
    try {
      for (let i = 0; i < 50; i++) id = local.store({ text: `record ${i} ${largeText}`, trust: 'observed', source: { uri: `test://large/${i}` } }).id;
    } finally { local.close(); }
    const client = await connect(path);
    const oversized = await client.callTool({ name: 'memory_inspect', arguments: { limit: 50 } });
    expect(oversized.isError).toBe(true);
    expect(JSON.stringify(oversized)).toContain('1 MiB');
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThan(1_024);
    const one = payload(await client.callTool({ name: 'memory_inspect', arguments: { id } }));
    expect(one.text).toBe(`record 49 ${largeText}`);
  }, 15_000);

  it('retires a shared handoff when its declared source is corrected through MCP', async () => {
    const { path } = fixture();
    const writer = await connect(path);
    const observer = await connect(path, 'agent-b');
    const source = payload(await writer.callTool({ name: 'memory_store', arguments: { text: 'Use canvas 1200x900', source: { uri: 'test://brief/v1' }, visibility: 'workspace' } }));
    const checkpoint = payload(await writer.callTool({ name: 'memory_checkpoint', arguments: { taskId: 'canvas', goal: 'Prepare catalogue', completed: [], pending: ['Prepare image'], decisions: [], constraints: [], artifacts: [], nextAction: 'Use the current canvas', visibility: 'workspace', dependencies: [source.id] } }));
    expect(payload(await observer.callTool({ name: 'memory_resume', arguments: { taskId: 'canvas' } })).id).toBe(checkpoint.id);
    const corrected = await writer.callTool({ name: 'memory_correct', arguments: { id: source.id, text: 'Use canvas 1600x1200', source: { uri: 'test://brief/v2' }, reason: 'Owner changed the brief' } });
    expect(corrected.isError).not.toBe(true);
    expect(payload(await observer.callTool({ name: 'memory_resume', arguments: { taskId: 'canvas' } }))).toBeNull();
  }, 15_000);
});

describe('CLI workflow', () => {
  it('records an actual verified demo, without a network or external database', () => {
    const { directory } = fixture();
    const file = join(directory, 'demo.json');
    execFileSync(process.execPath, [cli, 'demo', '--record', file], { timeout: 10_000, stdio: 'pipe' });
    const report = JSON.parse(readFileSync(file, 'utf8'));
    expect(report.mode).toBe('recorded');
    expect(report.steps).toHaveLength(6);
    expect(report.checksPassed).toBe(report.checksTotal);
    expect(report.checksPassed).toBeGreaterThanOrEqual(14);
  });

  it('requires scope and explicit destructive confirmation', () => {
    const { path } = fixture();
    expect(() => execFileSync(process.execPath, [cli, 'inspect', '--db', path], { stdio: 'pipe', timeout: 5_000 })).toThrow();
    expect(() => execFileSync(process.execPath, [cli, 'forget', '--db', path, '--workspace', 'test', '--agent', 'a', '--id', 'x'], { stdio: 'pipe', timeout: 5_000 })).toThrow();
  });

  it('preserves existing demo output and rejects oversized or non-file imports', () => {
    const { directory, path } = fixture();
    const existing = join(directory, 'existing.json');
    writeFileSync(existing, 'keep this');
    expect(() => execFileSync(process.execPath, [cli, 'demo', '--record', existing], { stdio: 'pipe', timeout: 5_000 })).toThrow();
    expect(readFileSync(existing, 'utf8')).toBe('keep this');
    const large = join(directory, 'large.json');
    const fd = openSync(large, 'w');
    try { ftruncateSync(fd, 32 * 1_024 * 1_024 + 1); } finally { closeSync(fd); }
    for (const file of [large, directory]) {
      expect(() => execFileSync(process.execPath, [cli, 'import', '--db', path, '--workspace', 'test', '--agent', 'a', '--file', file], { stdio: 'pipe', timeout: 5_000 })).toThrow();
    }
  });
});
