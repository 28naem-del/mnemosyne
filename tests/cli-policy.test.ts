import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createLocalMemory } from '../src/local/index.js';
import type { MigrationInspection } from '../src/migration/service.js';

const directories: string[] = [];
const cli = resolve('dist/cli/index.js');
const privateText = 'SYNTHETIC_CLI_POLICY_PRIVATE_EVIDENCE';
const mutations = [
  ['store'], ['correct'], ['import'], ['capture'], ['observe'], ['run-jobs'], ['index'],
  ['model', '--action', 'refresh'], ['skill', '--action', 'create'], ['skill', '--action', 'trial'], ['skill', '--action', 'retire'],
  ['branch', '--action', 'create'], ['branch', '--action', 'stage'], ['branch', '--action', 'merge'],
  ['entity', '--action', 'create'], ['entity', '--action', 'relate'],
  ['health', '--action', 'watch'], ['health', '--action', 'check'],
  ['migrate', '--action', 'apply'],
];
const erasures = [['forget'], ['migrate', '--action', 'rollback'], ['migrate', '--action', 'forget']];
const reads = [
  ['recall'], ['context'], ['inspect'], ['export'], ['jobs'], ['model'], ['model', '--action', 'get'], ['model', '--action', 'context'],
  ['skill', '--action', 'get'], ['branch', '--action', 'preview'], ['entity', '--action', 'resolve'], ['entity', '--action', 'traverse'],
  ['health'], ['health', '--action', 'scan'], ['health', '--action', 'recall'], ['migrate', '--action', 'inspect'], ['migrate', '--action', 'source'],
  ...mutations.filter(([command]) => command !== 'store' && command !== 'import'),
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-cli-policy-')); directories.push(root);
  return { root, db: join(root, 'memory.sqlite'), out: join(root, 'output.json'), missing: join(root, 'must-not-be-read.json') };
}
type Fixture = ReturnType<typeof fixture>;
const scope = (f: Fixture) => ['--db', f.db, '--workspace', 'policy-test', '--agent', 'controller'];
function invoke(args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, env: { ...process.env, MNEMOSYNE_TOKEN: '' } });
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); return result;
}
function denied(f: Fixture, route: string[], flag: string) {
  const result = invoke([...route, ...scope(f), flag, '--file', f.missing, '--provider-config', f.missing, '--out', f.out, '--record', f.out]);
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain(`disabled by ${flag}`);
  expect(result.stdout).toBe(''); expect(result.stderr).not.toContain(privateText);
  expect(existsSync(f.out)).toBe(false);
}
function seed(f: Fixture) {
  const memory = createLocalMemory({ path: f.db, workspaceId: 'policy-test', agentId: 'controller' });
  try { return memory.store({ text: privateText, source: { uri: 'test://policy/source' }, trust: 'observed' }).id; }
  finally { memory.close(); }
}
afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('CLI capability preflight', () => {
  it.each(mutations.map(route => ({ name: route.join(' '), route })))('denies $name writes before database creation and preserves an existing database', ({ route }) => {
    const f = fixture();
    for (const flag of ['--read-only', '--no-capture']) {
      denied(f, route, flag);
      expect(readdirSync(f.root)).toEqual([]);
    }
    seed(f);
    const before = readFileSync(f.db), files = readdirSync(f.root).sort();
    for (const flag of ['--read-only', '--no-capture']) {
      denied(f, route, flag);
      expect(readFileSync(f.db)).toEqual(before);
      expect(readdirSync(f.root).sort()).toEqual(files);
    }
  });

  it.each(reads.map(route => ({ name: route.join(' '), route })))('denies $name reads and source processing before provider/file access or SQLite creation', ({ route }) => {
    const f = fixture(); denied(f, route, '--no-recall'); expect(readdirSync(f.root)).toEqual([]);
  });

  it.each(erasures.map(route => ({ name: route.join(' '), route })))('denies $name erasure under read-only policy before opening SQLite', ({ route }) => {
    const f = fixture(); denied(f, route, '--read-only'); expect(readdirSync(f.root)).toEqual([]);
    seed(f); const before = readFileSync(f.db), files = readdirSync(f.root).sort();
    denied(f, route, '--read-only'); expect(readFileSync(f.db)).toEqual(before); expect(readdirSync(f.root).sort()).toEqual(files);
  });

  it.each([['inspect'], ['inspect', '--history'], ['export'], ['jobs'], ['branch', '--action', 'preview'], ['entity', '--action', 'resolve']].map(route => ({ name: route.join(' '), route })))('does not disclose existing evidence through $name with recall disabled', ({ route }) => {
    const f = fixture(); seed(f); const before = readFileSync(f.db);
    denied(f, route, '--no-recall'); expect(readFileSync(f.db)).toEqual(before);
  });

  it.each(['model', 'skill', 'branch', 'entity', 'health', 'migrate'])('fails closed for unknown %s actions, including inherited object names', command => {
    const f = fixture();
    for (const action of ['unknown', 'constructor', '__proto__']) {
      const result = invoke([command, '--action', action, ...scope(f)]);
      expect(result.status).toBe(1); expect(result.stderr).toContain('requires --action'); expect(result.stdout).toBe('');
      expect(readdirSync(f.root)).toEqual([]);
    }
  });

  it.each(['skill', 'branch', 'entity'])('requires an explicit %s action before opening SQLite', command => {
    const f = fixture(), result = invoke([command, ...scope(f)]);
    expect(result.status).toBe(1); expect(result.stderr).toContain('requires --action'); expect(readdirSync(f.root)).toEqual([]);
  });

  it('rejects unsupported commands, checkpoint routes and extraneous actions before opening SQLite', () => {
    const f = fixture();
    for (const route of [['checkpoint'], ['unknown'], ['constructor'], ['__proto__'], ['store', '--action', 'checkpoint'], ['mcp', '--action', 'unknown'], ['serve', '--action', 'unknown']]) {
      const result = invoke([...route, ...scope(f), '--read-only']);
      expect(result.status).toBe(1); expect(result.stderr).toMatch(/Unknown command|does not support --action/);
      expect(result.stdout).toBe(''); expect(readdirSync(f.root)).toEqual([]);
    }
  });

  it.each(['demo', 'learning-demo', 'evaluate'])('rejects restrictive policies for isolated %s work before producing output or reading a dataset', command => {
    const f = fixture();
    for (const flag of ['--read-only', '--no-capture', '--no-recall']) {
      denied(f, [command], flag); expect(readdirSync(f.root)).toEqual([]);
    }
  });

  it('retains migration preview policy validation before reading the supplied file', () => {
    const f = fixture();
    for (const flag of ['--read-only', '--no-capture', '--no-recall']) {
      const result = invoke(['migrate', '--file', f.missing, '--out', f.out, flag]);
      expect(result.status).toBe(1); expect(result.stderr).toContain('Unsupported option'); expect(result.stdout).toBe('');
      expect(readdirSync(f.root)).toEqual([]);
    }
  });

  it('allows write-only store/import and read-only recall/inspect/export', () => {
    const f = fixture();
    const stored = invoke(['store', ...scope(f), '--no-recall', '--text', privateText, '--source', 'test://policy/new']);
    expect(stored.status, stored.stderr).toBe(0); const id = (JSON.parse(stored.stdout) as { id: string }).id;
    for (const route of [['inspect', '--id', id], ['recall', '--query', privateText]]) {
      const result = invoke([...route, ...scope(f), '--read-only', '--no-capture']);
      expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain(privateText);
    }
    const exported = invoke(['export', ...scope(f), '--read-only', '--no-capture', '--out', f.out]);
    expect(exported.status, exported.stderr).toBe(0); expect(readFileSync(f.out, 'utf8')).toContain(privateText);
    const destination = fixture();
    const imported = invoke(['import', ...scope(destination), '--no-recall', '--file', f.out]);
    expect(imported.status, imported.stderr).toBe(0); expect(imported.stdout).not.toContain(privateText);
    const inspected = invoke(['inspect', ...scope(destination), '--read-only']);
    expect(inspected.status, inspected.stderr).toBe(0); expect(inspected.stdout).toContain(privateText);
  });

  it('allows confirmed captured-source erasure with capture and recall disabled, while still requiring confirmation and writable policy', () => {
    const f = fixture(), file = join(f.root, 'source.txt'); writeFileSync(file, privateText);
    const captured = invoke(['capture', ...scope(f), '--adapter', 'text', '--file', file]);
    expect(captured.status, captured.stderr).toBe(0);
    const id = (JSON.parse(captured.stdout) as { records: { id: string }[] }).records[0].id;
    const args = ['forget', ...scope(f), '--id', id, '--no-capture', '--no-recall'];
    const before = readFileSync(f.db);
    const unconfirmed = invoke(args); expect(unconfirmed.status).toBe(1); expect(unconfirmed.stderr).toContain('--confirm');
    const readOnly = invoke([...args, '--confirm', '--read-only']); expect(readOnly.status).toBe(1); expect(readOnly.stderr).toContain('disabled by --read-only');
    expect(readFileSync(f.db)).toEqual(before);
    const erased = invoke([...args, '--confirm']); expect(erased.status, erased.stderr).toBe(0);
    expect(JSON.parse(erased.stdout)).toMatchObject({ deletedIds: [id] }); expect(erased.stdout).not.toContain(privateText);
    const memory = createLocalMemory({ path: f.db, workspaceId: 'policy-test', agentId: 'controller' });
    try { expect(memory.get(id)).toBeNull(); expect(JSON.stringify(memory.export())).not.toContain(privateText); }
    finally { memory.close(); }
    const replay = invoke(['capture', ...scope(f), '--adapter', 'text', '--file', file]);
    expect(replay.status).toBe(1); expect(replay.stdout).not.toContain(privateText);
  });

  it.each(['rollback', 'forget'])('allows confirmed migration %s with capture and recall disabled, while still requiring confirmation and writable policy', action => {
    const f = fixture(), file = join(f.root, 'source.json'), batch = 'privacy-policy';
    writeFileSync(file, JSON.stringify([{ id: 'source', user_id: 'synthetic-owner', memory: privateText }]));
    const preview = invoke(['migrate', '--file', file, '--profile', 'mem0-array', '--source-store', 'synthetic-store', '--source-owner', 'synthetic-owner', '--workspace', 'policy-test', '--agent', 'controller', '--acknowledge-partial', '--out', f.out]);
    expect(preview.status, preview.stderr).toBe(0);
    const applied = invoke(['migrate', '--action', 'apply', ...scope(f), '--file', f.out, '--batch', batch, '--confirm']);
    expect(applied.status, applied.stderr).toBe(0);
    const report = JSON.parse(applied.stdout) as MigrationInspection;
    const args = ['migrate', '--action', action, ...scope(f), '--no-capture', '--no-recall', ...(action === 'rollback' ? ['--batch', batch, '--revision', report.manifestRevision] : ['--id', report.sources[0].identity])];
    const before = readFileSync(f.db);
    const unconfirmed = invoke(args); expect(unconfirmed.status).toBe(1); expect(unconfirmed.stderr).toContain('--confirm');
    const readOnly = invoke([...args, '--confirm', '--read-only']); expect(readOnly.status).toBe(1); expect(readOnly.stderr).toContain('disabled by --read-only');
    expect(readFileSync(f.db)).toEqual(before);
    const erased = invoke([...args, '--confirm']); expect(erased.status, erased.stderr).toBe(0); expect(erased.stdout).not.toContain(privateText);
    const inspected = invoke(['migrate', '--action', 'inspect', ...scope(f), '--batch', batch]);
    expect(inspected.status, inspected.stderr).toBe(0);
    const current = JSON.parse(inspected.stdout) as MigrationInspection;
    if (action === 'rollback') expect(current.state).toBe('rolled-back');
    else expect(current.sources).toMatchObject([{ identity: report.sources[0].identity, state: 'forgotten' }]);
    const memory = createLocalMemory({ path: f.db, workspaceId: 'policy-test', agentId: 'controller' });
    try { expect(JSON.stringify(memory.export())).not.toContain(privateText); }
    finally { memory.close(); }
  });

  it('keeps help and version available even with restrictive flags and an unknown route', () => {
    const f = fixture();
    for (const flag of ['--help', '--version']) {
      const result = invoke(['unknown', ...scope(f), '--read-only', '--no-capture', '--no-recall', flag]);
      expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).not.toBe(''); expect(readdirSync(f.root)).toEqual([]);
    }
  });
});

describe('CLI server capability configuration', () => {
  it('starts MCP with combined restrictive flags and enforces them per request', async () => {
    const f = fixture(), id = seed(f);
    const client = new Client({ name: 'cli-policy-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', ...scope(f), '--read-only', '--no-capture', '--no-recall'], stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).not.toContain('memory_store'); expect(names).not.toContain('memory_correct'); expect(names).not.toContain('memory_forget');
      const result = await client.callTool({ name: 'memory_inspect', arguments: { id } });
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain(privateText);
    } finally { await client.close(); }
  }, 15000);

  it('starts HTTP with combined restrictive flags and enforces them per request', async () => {
    const f = fixture(), id = seed(f), token = 'synthetic-cli-policy-token-00000000000000';
    const tokenFile = join(f.root, 'token'); writeFileSync(tokenFile, token, { mode: 0o600 });
    const child = spawn(process.execPath, [cli, 'serve', ...scope(f), '--port', '0', '--token-file', tokenFile, '--read-only', '--no-capture', '--no-recall'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics += String(chunk); });
    try {
      const url = await new Promise<string>((accept, reject) => {
        const timer = setTimeout(() => reject(new Error('CLI HTTP startup timed out')), 5000);
        let output = '';
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error(`CLI HTTP exited during startup: ${diagnostics}`)); });
        child.stdout.on('data', chunk => {
          output += String(chunk);
          try { const report = JSON.parse(output) as { url: string }; clearTimeout(timer); accept(report.url); }
          catch { /* Wait for the complete JSON startup report. */ }
        });
      });
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const capabilities = await fetch(`${url}/v1/capabilities`, { headers, signal: AbortSignal.timeout(3000) });
      expect(capabilities.status).toBe(200);
      expect(await capabilities.json()).toMatchObject({ readOnly: true, captureEnabled: false, recallEnabled: false });
      const read = await fetch(`${url}/v1/inspect`, { method: 'POST', headers, body: JSON.stringify({ id }), signal: AbortSignal.timeout(3000) });
      expect(read.status).toBe(403); expect(await read.text()).not.toContain(privateText);
      const write = await fetch(`${url}/v1/store`, { method: 'POST', headers, body: JSON.stringify({ text: 'blocked', source: { uri: 'test://blocked' } }), signal: AbortSignal.timeout(3000) });
      expect(write.status).toBe(403); await write.text();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed;
      }
    }
  }, 15000);
});
