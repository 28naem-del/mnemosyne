import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { MemoryRuntime } from '../src/runtime/index.js';
import { LocalSourceConnector, readLocalText } from '../src/connectors/index.js';

const roots: string[] = []; const opened: LocalMemory[] = []; const children: ChildProcess[] = [];
const exec = promisify(execFile); const cli = resolve('dist/cli/index.js');
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mnemosyne-connector-')); roots.push(directory);
  const path = join(directory, 'memory.db');
  return { directory, path, file: join(directory, 'source.jsonl'), scope: ['--db', path, '--workspace', 'test', '--agent', 'controller'] };
}
function runtime(path: string) { const db = createLocalMemory({ path, workspaceId: 'test', agentId: 'controller' }); opened.push(db); return new MemoryRuntime(db); }
async function run(scope: string[], command: string, args: string[] = [], env: Record<string, string> = {}) {
  const output = await exec(process.execPath, [cli, command, ...scope, ...args], { timeout: 10000, maxBuffer: 2_097_152, env: { ...process.env, MNEMOSYNE_TOKEN: '', ...env } });
  return JSON.parse(output.stdout);
}
afterEach(async () => {
  children.splice(0).forEach(child => { if (child.exitCode === null) child.kill('SIGKILL'); });
  opened.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

describe('explicit regular-file source sync', () => {
  it('accepts bounded UTF-8 regular files while rejecting symlinks, directories and invalid byte sequences', () => {
    const { directory, file } = fixture(); writeFileSync(file, '\uFEFF  Original UTF-8 😀\n');
    expect(readLocalText(file)).toBe('\uFEFF  Original UTF-8 😀\n');
    expect(() => readLocalText(file, 1)).toThrow('byte limit');
    expect(() => readLocalText(directory)).toThrow('regular');
    const link = join(directory, 'link'); symlinkSync(file, link); expect(() => readLocalText(link)).toThrow();
    writeFileSync(file, Buffer.from([0xff, 0xfe])); expect(() => readLocalText(file)).toThrow();
  });

  it('syncs append-only JSONL across batches and restart without duplicates and defers a partial final row', async () => {
    const { file, path } = fixture(); const records = Array.from({ length: 300 }, (_, index) => JSON.stringify({ role: 'user', text: `Visible release event ${index}` }));
    writeFileSync(file, `${records.join('\n')}\n{"role":"user","text":`);
    const firstRuntime = runtime(path); const connector = new LocalSourceConnector(firstRuntime, { path: file, format: 'generic', trust: 'observed' });
    const first = await connector.sync(); expect(first.records).toHaveLength(300); expect(first.records[299].metadata.cursor).toMatch(/^300:/);
    expect((await connector.sync()).changed).toBe(false);
    appendFileSync(file, '"Completed append"}\n');
    const second = await new LocalSourceConnector(runtime(path), { path: file, format: 'generic', trust: 'observed' }).sync();
    expect(second.records).toHaveLength(301); expect(second.records[0].id).toBe(first.records[0].id);
    expect(firstRuntime.memory.list({ limit: 1000 }).items).toHaveLength(301);
  });

  it('rolls back all new JSONL events when a later event changes the payload of an existing ID', async () => {
    const { file, path } = fixture(); const store = runtime(path);
    writeFileSync(file, `${JSON.stringify({ id: 'old', role: 'user', text: 'Original event' })}\n`);
    const connector = new LocalSourceConnector(store, { path: file, format: 'generic', trust: 'observed' }); await connector.sync();
    writeFileSync(file, `${JSON.stringify({ id: 'new', role: 'user', text: 'Must roll back' })}\n${JSON.stringify({ id: 'old', role: 'user', text: 'Changed event' })}\n`);
    await expect(connector.sync()).rejects.toThrow('Idempotency'); expect(store.memory.list().items).toHaveLength(1);
  });

  it('updates documents through source supersession and honors logical-source tombstones on connector restart', async () => {
    const { file, path } = fixture(); writeFileSync(file, 'First source document.'); const store = runtime(path);
    const connector = new LocalSourceConnector(store, { path: file, format: 'text', trust: 'observed' });
    const first = (await connector.sync()).records[0]; writeFileSync(file, 'Updated source document.');
    const next = (await connector.sync()).records[0]; expect(next.supersedes).toBe(first.id);
    store.forgetSource(next.id); writeFileSync(file, 'First source document.');
    await expect(new LocalSourceConnector(runtime(path), { path: file, format: 'text', trust: 'observed' }).sync()).rejects.toThrow('tombstone');
  });

  it('runs only an explicit watch loop and cancels cleanly without further file reads', async () => {
    const { file, path } = fixture(); writeFileSync(file, 'Watch fixture');
    const connector = new LocalSourceConnector(runtime(path), { path: file, format: 'text' }); const control = new AbortController();
    const iterator = connector.watch({ signal: control.signal, intervalMs: 100 });
    expect((await iterator.next()).value).toMatchObject({ changed: true });
    control.abort(); rmSync(file); expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });
});

describe('runtime CLI entry points', () => {
  it('captures a supplied file, reports jobs, and requires explicit provider configuration before proposing', async () => {
    const { file, scope } = fixture(); writeFileSync(file, `${JSON.stringify({ id: 'u1', role: 'user', text: 'Releases need verified checklists.' })}\n`);
    const captured = await run(scope, 'capture', ['--file', file, '--adapter', 'generic', '--trust', 'observed']);
    const job = await run(scope, 'observe', ['--json', JSON.stringify({ sourceIds: [captured.records[0].id] })]);
    expect(job.state).toBe('queued'); expect((await run(scope, 'jobs'))[0].jobId).toBe(job.jobId);
    await expect(run(scope, 'run-jobs')).rejects.toThrow('--provider-config');
    expect((await run(scope, 'jobs'))[0].attempts).toBe(0);
  });

  it('uses only an explicit local provider and named environment key for observation, model and hybrid indexing', async () => {
    const { directory, scope } = fixture(); let calls = 0; const auth: string[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()); calls++; auth.push(request.headers.authorization ?? '');
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/v1/embeddings') response.end(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index, embedding: [1, 0] })) }));
        else {
          const supplied = JSON.parse(body.messages[1].content); const sourceIds = supplied.sources.map((source: { id: string }) => source.id);
          const value = supplied.key ? { text: 'Release model derived from the explicit test source.', sourceIds } : { observations: [{ text: 'Release acceptance requires a completed evidence checklist.', sourceIds }] };
          response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
        }
      })().catch(() => { response.statusCode = 500; response.end(); });
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    try {
      const port = (server.address() as { port: number }).port; const config = join(directory, 'provider.json');
      writeFileSync(config, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fixture-model', dimensions: 2, revision: 'test-v1', apiKeyEnv: 'MNEMOSYNE_TEST_KEY' }));
      const source = await run(scope, 'store', ['--text', 'Release checklist source', '--source', 'test:cli']);
      await run(scope, 'observe', ['--json', JSON.stringify({ sourceIds: [source.id] })]);
      const flags = ['--provider-config', config]; const env = { MNEMOSYNE_TEST_KEY: 'fixture-key-do-not-print' };
      expect((await run(scope, 'run-jobs', flags, env)).completed).toHaveLength(1);
      expect((await run(scope, 'model', [...flags, '--action', 'refresh', '--key', 'release', '--json', JSON.stringify({ sourceIds: [source.id] })], env)).status).toBe('fresh');
      const before = calls; expect((await run(scope, 'model', ['--key', 'release'])).status).toBe('fresh'); expect(calls).toBe(before);
      expect((await run(scope, 'index', flags, env)).indexed).toBeGreaterThan(0);
      expect((await run(scope, 'context', [...flags, '--query', 'release checklist'], env)).text).toContain('Release');
      expect(auth.every(value => value === 'Bearer fixture-key-do-not-print')).toBe(true);
      writeFileSync(config, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'fixture', apiKey: 'inline-secret' }));
      await expect(run(scope, 'run-jobs', flags)).rejects.toThrow('Invalid provider configuration'); expect(calls).toBeGreaterThan(0);
    } finally { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
  });

  it('exposes structured skill, branch and entity commands without implicitly running models', async () => {
    const { scope } = fixture(); const source = await run(scope, 'store', ['--text', 'Verified release evidence', '--source', 'test:cli']);
    const skill = await run(scope, 'skill', ['--action', 'create', '--json', JSON.stringify({ name: 'Verify release', prerequisites: ['Artifact exists'], steps: ['Validate artifact'], parameters: {}, evidenceIds: [source.id] })]);
    expect(skill.state).toBe('candidate');
    const active = await run(scope, 'skill', ['--action', 'trial', '--json', JSON.stringify({ id: skill.id, validation: { passed: true, evidence: 'Fixture trial result', verifier: 'fixture', taskId: 'trial', prerequisitesSatisfied: true } })]);
    expect(active.state).toBe('active');
    const branch = await run(scope, 'branch', ['--action', 'create', '--json', JSON.stringify({ name: 'Release improvement', baseIds: [source.id] })]);
    const staged = await run(scope, 'branch', ['--action', 'stage', '--json', JSON.stringify({ id: branch.id, changes: [{ operation: 'add', input: { text: 'Inspect release artifacts.', source: { uri: 'test:branch' }, trust: 'observed', dependencies: [source.id] } }] })]);
    expect((await run(scope, 'branch', ['--action', 'preview', '--id', staged.id])).canMerge).toBe(true);
    expect((await run(scope, 'branch', ['--action', 'merge', '--id', staged.id])).memories).toHaveLength(1);
    const entity = await run(scope, 'entity', ['--action', 'create', '--json', JSON.stringify({ name: 'Release Project', type: 'project', aliases: ['release'], source: { uri: 'test:entity' }, evidenceIds: [source.id] })]);
    expect((await run(scope, 'entity', ['--action', 'resolve', '--json', JSON.stringify({ name: 'release' })])).matches[0].id).toBe(entity.id);
  });

  it('serves authenticated loopback HTTP without printing tokens and closes on SIGTERM', async () => {
    const { directory, scope } = fixture(); const token = 'fixture-token-'.repeat(4); const tokenFile = join(directory, 'token'); writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    const child = spawn(process.execPath, [cli, 'serve', ...scope, '--port', '0', '--token-file', tokenFile], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MNEMOSYNE_TOKEN: '' } }); children.push(child);
    let stdout = '', stderr = '';
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    const ready = await new Promise<{ url: string }>((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI server start timeout: ${stderr}`)), 5000);
      child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI server exited ${code}: ${stderr}`)); });
      child.stdout!.on('data', chunk => { stdout += String(chunk); try { const data = JSON.parse(stdout); clearTimeout(timer); done(data); } catch { /* Wait for the complete JSON record. */ } });
    });
    expect(ready.url).toMatch(/^http:\/\/127\.0\.0\.1:/); expect(stdout + stderr).not.toContain(token);
    expect((await fetch(`${ready.url}/v1/capabilities`)).status).toBe(401);
    const authorized = await fetch(`${ready.url}/v1/capabilities`, { headers: { Authorization: `Bearer ${token}` } });
    expect(authorized.status).toBe(200); expect(await authorized.json()).toMatchObject({ workspaceId: 'test', agentId: 'controller' });
    const exited = new Promise<number | null>(done => child.once('exit', code => done(code))); child.kill('SIGTERM'); expect(await exited).toBe(0);
  });

  it('runs the isolated learning demo without requiring a scope or external credentials', async () => {
    const report = await run([], 'learning-demo');
    expect(report.passed).toBe(true); expect(report.externalModelCalls).toBe(0); expect(report.scriptedProposerCalls).toBeGreaterThan(0);
  });
});
