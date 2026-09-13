import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory, type MemoryEmbedder } from '../src/local/index.js';
import { MemoryRuntime } from '../src/runtime/index.js';
import { startMemoryHttp, type MemoryPrincipal } from '../src/http/index.js';

const token = 'test-owner-'.padEnd(48, 'x');
const secondToken = 'test-reader-'.padEnd(48, 'y');
const source = { uri: 'test:http' };
const opened: LocalMemory[] = [];
const servers: Awaited<ReturnType<typeof startMemoryHttp>>[] = [];
const roots: string[] = [];
function memory(path = ':memory:', agentId = 'alice', workspaceId = 'test'): LocalMemory {
  const db = createLocalMemory({ path, agentId, workspaceId }); opened.push(db); return db;
}
async function serve(db: LocalMemory, options: Partial<MemoryPrincipal> = {}) {
  const server = await startMemoryHttp({ principals: [{ token, memory: db, ...options }] }); servers.push(server); return server;
}
async function post(url: string, operation: string, body: unknown, accessToken = token) {
  const response = await fetch(`${url}/v1/${operation}`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function raw(url: string, headers: Record<string, string>, chunks: string[] = [], method = 'POST') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url, { method, headers }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, body })); response.on('error', reject);
    }); req.on('error', reject); chunks.forEach(chunk => req.write(chunk)); req.end();
  });
}
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); opened.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('authenticated memory HTTP service', () => {
  it('carries both temporal coordinates and explicit lexical scoring into cited context', async () => {
    let day = 2;
    const at = (value: number) => `2026-01-${String(value).padStart(2, '0')}T00:00:00.000Z`;
    const db = createLocalMemory({ path: ':memory:', workspaceId: 'test', agentId: 'alice', now: () => new Date(at(day)) }); opened.push(db);
    const old = db.store({ text: 'Atlas quota is 10', source, trust: 'observed', validFrom: at(1) });
    day = 10; const next = db.correct(old.id, { text: 'Atlas quota is 20', source, reason: 'Late update', validFrom: at(5) });
    const { url } = await serve(db);
    const past = await post(url, 'context', { query: 'Atlas quota', maxTokens: 4096, asOf: at(6), knownAt: at(7), lexicalScoring: 'bm25' });
    expect(past.status).toBe(200); expect(past.body.items.map((item: { id: string }) => item.id)).toEqual([old.id]);
    expect(JSON.parse(past.body.text).temporal).toEqual({ asOf: at(6), knownAt: at(7) });
    const current = await post(url, 'context', { query: 'Atlas quota', maxTokens: 4096, asOf: at(6), knownAt: at(10), lexicalScoring: 'overlap' });
    expect(current.body.items.map((item: { id: string }) => item.id)).toEqual([next.id]);
  });
  it('serves an inert inspector shell but requires a bearer token for every data operation', async () => {
    const db = memory(); const { url } = await serve(db);
    const shell = await fetch(url); expect(shell.status).toBe(200); expect(shell.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(shell.headers.get('cache-control')).toBe('no-store'); expect(await shell.text()).toContain('live memory');
    expect((await fetch(`${url}/app.js`)).status).toBe(200);
    expect((await fetch(`${url}/v1/capabilities`)).status).toBe(401);
    expect((await post(url, 'store', { text: 'hidden', source }, 'wrong')).status).toBe(401);
    expect(db.inspect()).toEqual([]);
    const capabilities = await fetch(`${url}/v1/capabilities`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await capabilities.json()).toMatchObject({ workspaceId: 'test', agentId: 'alice', live: true, captureEnabled: true, recallEnabled: true });
  });

  it('enforces read-only and destructive permissions separately', async () => {
    const db = memory(); const record = db.store({ text: 'stable observed memory', source, trust: 'observed' });
    const { url } = await serve(db, { readOnly: true, allowDestructive: true });
    expect((await post(url, 'recall', { query: 'stable' })).body).toHaveLength(1);
    for (const [operation, body] of [['store', { text: 'new', source }], ['correct', { id: record.id, text: 'changed', source, reason: 'test' }], ['forget', { id: record.id }], ['capture', { sessionId: 's', adapter: 'generic', jsonl: '{}' }]]) {
      expect((await post(url, operation as string, body)).status).toBe(403);
    }
    const writer = await serve(db);
    expect((await post(writer.url, 'forget', { id: record.id })).status).toBe(403);
    expect(db.get(record.id)?.status).toBe('active');
  });

  it('blocks trust escalation and controller correction/deletion while allowing observed correction', async () => {
    const db = memory(); const { url } = await serve(db, { allowDestructive: true });
    for (const extra of [{ trust: 'verified' }, { metadata: { advisory: false } }, { kind: 'checkpoint' }, { workspaceId: 'other' }]) {
      expect((await post(url, 'store', { text: 'not evidence', source, ...extra })).status).toBe(400);
    }
    const verified = db.store({ text: 'verified source', source, trust: 'verified', evidence: 'Controller inspected the original source' });
    const internal = db.store({ text: 'controller state', source, trust: 'observed', metadata: { advisory: false } });
    for (const record of [verified, internal]) expect((await post(url, 'correct', { id: record.id, text: 'forged', source, reason: 'test' })).status).toBe(403);
    expect((await post(url, 'forget', { id: internal.id })).status).toBe(403);
    const stored = await post(url, 'store', { text: 'initial observation', source }); expect(stored.body.trust).toBe('observed');
    const fixed = await post(url, 'correct', { id: stored.body.id, text: 'corrected observation', source, reason: 'fresh evidence' });
    expect(fixed.status).toBe(200); expect(fixed.body.trust).toBe('observed'); expect(db.get(stored.body.id)?.status).toBe('superseded');
  });

  it('binds scope to credentials even when agents share one database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mnemosyne-http-')); roots.push(root); const path = join(root, 'memory.db');
    const alice = memory(path); const bob = memory(path, 'bob'); const other = memory(path, 'alice', 'other');
    const privateBob = bob.store({ text: 'orchid private', source, trust: 'observed' });
    const sharedBob = bob.store({ text: 'orchid shared', source, trust: 'observed', visibility: 'workspace' });
    other.store({ text: 'orchid other workspace', source, trust: 'observed', visibility: 'workspace' });
    const own = alice.store({ text: 'orchid own', source, trust: 'observed' });
    const server = await startMemoryHttp({ principals: [{ token, memory: alice, allowDestructive: true }, { token: secondToken, memory: bob }] }); servers.push(server);
    expect((await post(server.url, 'recall', { query: 'orchid' })).body.map((hit: { memory: { id: string } }) => hit.memory.id).sort()).toEqual([own.id, sharedBob.id].sort());
    expect((await post(server.url, 'recall', { query: 'orchid' }, secondToken)).body.map((hit: { memory: { id: string } }) => hit.memory.id).sort()).toEqual([privateBob.id, sharedBob.id].sort());
    expect((await post(server.url, 'inspect', { id: privateBob.id })).body).not.toMatchObject({ id: privateBob.id });
    expect((await post(server.url, 'correct', { id: sharedBob.id, text: 'take ownership', source, reason: 'test' })).status).toBe(400);
    expect((await post(server.url, 'forget', { id: sharedBob.id })).status).toBe(400);
    expect((await post(server.url, 'recall', { query: 'orchid', agentId: 'bob' })).status).toBe(400);
  });

  it('captures observed source evidence, expands UTF-8 safely and blocks replay after forgetting', async () => {
    const db = memory(); const { url } = await serve(db, { allowDestructive: true });
    const batch = { sessionId: 's', adapter: 'generic', jsonl: JSON.stringify({ id: 'm1', role: 'user', text: 'é remembered orchid' }) };
    const captured = await post(url, 'capture', batch); expect(captured.status).toBe(200); const record = captured.body.records[0]; expect(record.trust).toBe('observed');
    expect((await post(url, 'capture', batch)).body.records[0].id).toBe(record.id);
    expect((await post(url, 'source', { id: record.id, maxBytes: 2 })).body).toMatchObject({ text: 'é', nextOffset: 2 });
    expect((await post(url, 'source', { id: record.id, offset: 1 })).status).toBe(400);
    const derived = db.store({ text: 'derived orchid', source, trust: 'observed', dependencies: [record.id] });
    expect((await post(url, 'forget', { id: record.id })).body.deletedIds.sort()).toEqual([record.id, derived.id].sort());
    expect((await post(url, 'source', { id: record.id })).status).toBe(400);
    expect((await post(url, 'capture', batch)).body.error).toContain('tombstone');
    const tombstone = db.list({ includeUntrusted: true, metadata: { runtimeType: 'tombstone' } }).items[0];
    expect((await post(url, 'forget', { id: tombstone.id })).status).toBe(403);
  });

  it('respects capture and recall controls before invoking configured adapters', async () => {
    const db = memory(); let calls = 0;
    const runtime = new MemoryRuntime(db, { captureEnabled: false, recallEnabled: false });
    const { url } = await serve(db, { runtime, recall: async () => { calls++; return []; }, context: async input => { calls++; return db.compile(input); } });
    for (const [operation, body] of [['recall', { query: 'test' }], ['context', { query: 'test', maxTokens: 100 }], ['inspect', {}], ['source', { id: 'x' }], ['capture', { sessionId: 's', adapter: 'generic', jsonl: '{}' }]]) {
      expect((await post(url, operation as string, body)).status).toBe(403);
    }
    expect(calls).toBe(0);
  });

  it('uses the same configured semantic adapter for recall and context with citations', async () => {
    const db = memory(); const record = db.store({ text: 'automobile travel', source, trust: 'observed' });
    const embedder: MemoryEmbedder = { model: 'http-test', dimensions: 2, async embed(texts) { return texts.map(() => [1, 0]); } };
    await db.indexEmbeddings({ embedder });
    const { url } = await serve(db, { recall: input => db.recallHybrid(input, { embedder }), context: input => db.compileHybrid(input, { embedder }) });
    expect((await post(url, 'recall', { query: 'vehicle' })).body[0].memory.id).toBe(record.id);
    const packet = await post(url, 'context', { query: 'vehicle', maxTokens: 4096 });
    expect(packet.body.items[0].id).toBe(record.id); expect(packet.body.citations[0].uri).toBe(source.uri);
  });

  it('disables every HTTP capture mutation while retaining separately authorized forgetting', async () => {
    const db = memory(); const record = db.store({ text: 'Existing observed memory', source, trust: 'observed' });
    const runtime = new MemoryRuntime(db, { captureEnabled: false });
    const { url } = await serve(db, { runtime, allowDestructive: true });
    for (const [operation, body] of [
      ['store', { text: 'Blocked addition', source }],
      ['correct', { id: record.id, text: 'Blocked correction', source, reason: 'test' }],
      ['capture', { sessionId: 's', adapter: 'generic', jsonl: '{}' }],
      ['branch-create', { name: 'Blocked draft', baseIds: [record.id] }],
      ['branch-stage', { id: record.id, changes: [] }],
      ['branch-merge', { id: record.id }],
    ]) expect(await post(url, operation as string, body)).toMatchObject({ status: 403, body: { error: 'Runtime capture is disabled' } });
    expect(db.inspect()).toHaveLength(1); expect(db.get(record.id)?.status).toBe('active');
    expect((await post(url, 'recall', { query: 'Existing' })).body).toHaveLength(1);
    expect((await post(url, 'forget', { id: record.id })).status).toBe(200);
    expect(db.inspect()).toEqual([]);
  });

  it('rejects malformed JSON, unknown fields, compressed bodies and excessive payloads', async () => {
    const db = memory(); const { url } = await serve(db); const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    expect((await raw(`${url}/v1/store`, headers, ['{'])).status).toBe(400);
    expect((await raw(`${url}/v1/store`, { ...headers, 'Content-Type': 'text/plain' }, ['{}'])).status).toBe(415);
    expect((await raw(`${url}/v1/store`, { ...headers, 'Content-Encoding': 'gzip' }, ['{}'])).status).toBe(415);
    expect((await raw(`${url}/v1/store`, { ...headers, 'Content-Length': '1048577' })).status).toBe(413);
    const overflow = await raw(`${url}/v1/store`, headers, ['{"text":"', 'a'.repeat(1_048_576), '"}']); expect(overflow.status).toBe(413);
    expect((await post(url, 'store', { text: 'invalid source', source: { ...source, extra: true } })).status).toBe(400);
    expect((await post(url, 'missing', {})).status).toBe(404);
    expect(db.inspect()).toEqual([]);
  });

  it('rejects unrecognized Host and cross-origin requests before authentication', async () => {
    const { url } = await serve(memory()); const headers = { Authorization: `Bearer ${token}` };
    expect((await raw(`${url}/v1/capabilities`, { ...headers, Host: 'attacker.example' }, [], 'GET')).status).toBe(403);
    expect((await raw(`${url}/v1/capabilities`, { ...headers, Origin: 'https://attacker.example' }, [], 'GET')).status).toBe(403);
    expect((await raw(`${url}/v1/capabilities`, { ...headers, Origin: url }, [], 'GET')).status).toBe(200);
  });

  it('rechecks a revoked token after a delayed request body, before writing', async () => {
    const db = memory(); const server = await serve(db); const body = JSON.stringify({ text: 'must never commit', source });
    const response = new Promise<number>((resolve, reject) => {
      const req = request(`${server.url}/v1/store`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject); req.write(body.slice(0, 2));
      setTimeout(() => { server.revoke(token); req.end(body.slice(2)); }, 25);
    });
    expect(await response).toBe(401); expect(db.inspect()).toEqual([]); expect(server.revoke(token)).toBe(false);
  });

  it('rechecks revocation after a delayed semantic read and bounds serialized responses', async () => {
    const db = memory(); let release: (() => void) | undefined; let started: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { started = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
    const server = await serve(db, { recall: async () => { started!(); await wait; return []; } });
    const pending = post(server.url, 'recall', { query: 'test' }); await ready; server.revoke(token); release!(); expect((await pending).status).toBe(401);
    const record = db.store({ text: 'large result', source, trust: 'observed' }); const hit = db.recall({ query: 'large' })[0];
    const large = await serve(db, { recall: async () => [{ ...hit, memory: { ...record, text: 'x'.repeat(1_048_577) } }] });
    const bounded = await post(large.url, 'recall', { query: 'large' }); expect(bounded.status).toBe(413); expect(JSON.stringify(bounded.body).length).toBeLessThan(1000);
  });

  it('validates controller configuration and limits each principal independently', async () => {
    const db = memory(); await expect(startMemoryHttp({ host: '0.0.0.0', principals: [{ token, memory: db }] })).rejects.toThrow('allowRemote');
    await expect(startMemoryHttp({ principals: [{ token, memory: db }, { token, memory: db }] })).rejects.toThrow('Duplicate');
    await expect(startMemoryHttp({ principals: [{ token, memory: db, runtime: new MemoryRuntime(memory()) }] })).rejects.toThrow('principal memory');
    const server = await startMemoryHttp({ principals: [{ token, memory: db }, { token: secondToken, memory: db }], requestsPerMinute: 1 }); servers.push(server);
    expect((await post(server.url, 'inspect', {})).status).toBe(200); expect((await post(server.url, 'inspect', {})).status).toBe(429);
    expect((await post(server.url, 'inspect', {}, secondToken)).status).toBe(200);
  });
});
