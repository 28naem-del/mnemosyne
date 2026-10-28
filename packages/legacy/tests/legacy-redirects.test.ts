import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { qdrantRequest } from '../src/core/http.js';
import { EmbeddingsClient } from '../src/core/embeddings.js';

const servers: Server[] = [];
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected a loopback test server');
  return `http://127.0.0.1:${address.port}`;
}
function body(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let value = ''; request.setEncoding('utf8'); request.on('data', chunk => { value += chunk; }); request.on('end', () => resolve(value)); request.on('error', reject);
  });
}
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }))); });

describe('legacy backend redirect boundaries', () => {
  it.each([302, 307])('rejects Qdrant HTTP %i without forwarding credentials or memory bytes', async status => {
    let destinationCalls = 0, originalCalls = 0;
    const destination = await listen((request, response) => { destinationCalls++; request.resume(); response.end('{}'); });
    const original = await listen((request, response) => { originalCalls++; request.resume(); response.writeHead(status, { Location: `${destination}/other-origin` }); response.end(); });
    await expect(qdrantRequest(original, '/collections/test/points', { method: 'PUT', body: JSON.stringify({ synthetic: 'private-memory' }), redirect: 'follow' }, { apiKey: 'SYNTHETIC-SECRET', timeoutMs: 2000 })).rejects.toThrow();
    expect(originalCalls).toBe(1); expect(destinationCalls).toBe(0);
  });
  it.each([
    { status: 302, path: '/v1/embeddings' }, { status: 307, path: '/v1/embeddings' },
    { status: 302, path: '/api/embed' }, { status: 307, path: '/api/embed' },
  ])('rejects embedding $path HTTP $status without forwarding private prompts', async ({ status, path }) => {
    let destinationCalls = 0, originalCalls = 0;
    const destination = await listen((request, response) => { destinationCalls++; request.resume(); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ embedding: [1, 0] }] })); });
    const original = await listen((request, response) => { originalCalls++; request.resume(); response.writeHead(status, { Location: `${destination}/other-origin` }); response.end(); });
    const embeddings = new EmbeddingsClient(`${original}${path}`, 'synthetic-model', { apiKey: 'SYNTHETIC-SECRET', timeoutMs: 2000 });
    await expect(embeddings.embed('SYNTHETIC_PRIVATE_PROMPT')).rejects.toThrow();
    expect(originalCalls).toBe(1); expect(destinationCalls).toBe(0); expect(embeddings.dimensions).toBeUndefined();
  });
  it('still sends credentials and payloads directly to the explicitly selected endpoints', async () => {
    const receipts: Array<{ path?: string; body: string; key?: string; authorization?: string }> = [];
    const endpoint = await listen((request, response) => {
      void body(request).then(text => {
        receipts.push({ path: request.url, body: text, key: request.headers['api-key'] as string | undefined, authorization: request.headers.authorization });
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
      }, () => { response.writeHead(400); response.end(); });
    });
    const response = await qdrantRequest(endpoint, '/collections/test/points', { method: 'PUT', body: '{"synthetic":"memory"}' }, { apiKey: 'SYNTHETIC-QDRANT', timeoutMs: 2000 }); await response.body?.cancel();
    const embedding = await new EmbeddingsClient(`${endpoint}/v1/embeddings`, 'synthetic-model', { apiKey: 'SYNTHETIC-EMBEDDER', timeoutMs: 2000 }).embed('synthetic prompt');
    expect(embedding).toEqual([1, 0]); expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({ key: 'SYNTHETIC-QDRANT', body: '{"synthetic":"memory"}' });
    expect(receipts[1]).toMatchObject({ authorization: 'Bearer SYNTHETIC-EMBEDDER' }); expect(JSON.parse(receipts[1].body)).toMatchObject({ input: 'synthetic prompt', model: 'synthetic-model' });
  });
});
