import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Run the complete adapter source/handler with only the HTTP listener, filesystem
// and kernel dependencies injected. No sockets, provider calls or built kernel.
async function handlerFor(file) {
  const path = join(root, file);
  const original = readFileSync(path, 'utf8');
  const source = original.replace(/^#![^\n]*\n/, '').replace(/^import .*;\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify(new URL('file://' + path).href))
    .replace('const { createLocalMemory } = await import(kernelPath);', '')
    .replace(/^export /gm, '');
  let handler;
  const logs = [];
  const createServer = fn => { handler = fn; return { listen() {} }; };
  const createLocalMemory = () => { throw new Error('PRIVATE provider failure /private/database.sqlite\n    at secret (/private/server.js:1:1)'); };
  const process = { env: {}, argv: ['node', path], on() {}, exit(code) { throw new Error('unexpected exit ' + code); } };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('createServer', 'createLocalMemory', 'existsSync', 'mkdtempSync', 'rmSync', 'tmpdir', 'dirname', 'join', 'resolve', 'fileURLToPath', 'process', 'console', source)(
    createServer, createLocalMemory, () => true, () => '/fixture', () => {}, () => '/fixture', dirname, join, resolve, fileURLToPath, process,
    { log() {}, error(...args) { logs.push(args.join(' ')); } });
  assert.equal(typeof handler, 'function');
  return { handler, logs };
}
async function request(handler, method, url, body) {
  const req = Object.assign(new EventEmitter(), { method, url });
  let status, headers, data;
  const res = { writeHead(code, values) { status = code; headers = values; }, end(value) { data = value; } };
  const pending = handler(req, res);
  if (body !== undefined) { req.emit('data', Buffer.from(body)); req.emit('end'); }
  await pending;
  return { status, headers, body: JSON.parse(data) };
}
for (const [file, route, payload] of [
  ['benchmarks/precisionmembench/server.mjs', '/add', { user_id: 'test', text: 'fixture' }],
  ['benchmarks/memsecbench/backend.mjs', '/write', { agent: 'test', text: 'fixture', source: 'user' }],
]) {
  test(file + ' returns a constant error without exception text or stack data', async () => {
    const { handler } = await handlerFor(file);
    const response = await request(handler, 'POST', route, JSON.stringify(payload));
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: 'internal server error' });
    assert.match(response.headers['content-type'], /application\/json/);
    assert.equal((await request(handler, 'GET', '/health')).status, 200);
  });
  test(file + ' catches malformed JSON and keeps errors generic', async () => {
    const { handler } = await handlerFor(file);
    assert.deepEqual((await request(handler, 'POST', route, '{PRIVATE invalid input')).body, { error: 'internal server error' });
  });
}
