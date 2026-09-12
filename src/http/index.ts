import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { ContextPacket, LocalMemory, RecallInput, RecallResult } from '../local/index.js';
import { MemoryRuntime } from '../runtime/index.js';
import { MemoryBranches } from '../branches/index.js';
import { MemoryRelations } from '../relations/index.js';
import { INSPECTOR_HTML, INSPECTOR_JS } from './inspector.js';

const MAX_BYTES = 1_048_576;
const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && !value.includes('\0') && Buffer.byteLength(value) <= max);
const id = text(160);
const source = z.object({ uri: text(2048), revision: text(512).optional(), author: text(512).optional(), observedAt: z.iso.datetime().transform(value => new Date(value).toISOString()).optional() }).strict();
const kind = z.enum(['fact', 'preference', 'decision', 'procedure', 'observation', 'checkpoint']);
const query = z.object({ query: text(4096), limit: z.number().int().min(1).max(100).optional(), includeUntrusted: z.boolean().optional(), kinds: z.array(kind).max(6).optional(), asOf: z.iso.datetime().optional(), knownAt: z.iso.datetime().optional() }).strict();
const store = z.object({ text: text(16000), source, kind: kind.exclude(['checkpoint']).optional(), key: text(256).optional(), visibility: z.enum(['private', 'workspace']).optional(), dependencies: z.array(id).max(64).optional(), idempotencyKey: text(256).optional() }).strict();
const correct = z.object({ id, text: text(16000), source, reason: text(4096) }).strict();

export interface MemoryPrincipal {
  token: string;
  memory: LocalMemory;
  readOnly?: boolean;
  allowDestructive?: boolean;
  /** Controller-configured adapter; HTTP callers cannot select providers or credentials. */
  recall?: (input: RecallInput) => Promise<RecallResult[]>;
  context?: (input: { query: string; maxTokens: number; taskId?: string }) => Promise<ContextPacket>;
  runtime?: MemoryRuntime;
}
export interface MemoryHttpOptions {
  principals: MemoryPrincipal[];
  host?: string;
  port?: number;
  allowRemote?: boolean;
  requestsPerMinute?: number;
}
class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json' || request.headers['content-encoding']) throw new ApiError(415, 'Send uncompressed application/json');
  const size = request.headers['content-length'];
  if (size && (!/^\d+$/.test(size) || Number(size) > MAX_BYTES)) throw new ApiError(413, 'Request exceeds 1 MiB');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BYTES) throw new ApiError(413, 'Request exceeds 1 MiB');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'Invalid JSON'); }
}

/** Authenticated HTTP and live inspector. Memory ownership is fixed at launch. */
export async function startMemoryHttp(options: MemoryHttpOptions): Promise<{ url: string; close(): Promise<void>; revoke(token: string): boolean }> {
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host) && !options.allowRemote) throw new Error('Remote binding requires allowRemote');
  if (!Array.isArray(options.principals) || !options.principals.length || options.principals.length > 100) throw new Error('Configure 1–100 principals');
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  const rate = options.requestsPerMinute ?? 240;
  if (!Number.isInteger(rate) || rate < 1 || rate > 10000) throw new Error('Invalid request rate');
  const keys = new Set<string>();
  const principals = options.principals.map(principal => {
    if (typeof principal.token !== 'string' || Buffer.byteLength(principal.token) < 32 || principal.token.length > 4096 || /\s/.test(principal.token)) throw new Error('Use a unique token of at least 32 bytes without whitespace');
    if (keys.has(principal.token)) throw new Error('Duplicate principal token');
    if (principal.runtime && principal.runtime.memory !== principal.memory) throw new Error('Runtime must use the principal memory instance');
    keys.add(principal.token);
    return { ...principal, hash: createHash('sha256').update(principal.token).digest(), active: true, count: 0, window: 0,
      runtime: principal.runtime ?? new MemoryRuntime(principal.memory) };
  });
  const authenticate = (request: IncomingMessage) => {
    const authorization = request.headers.authorization ?? '';
    const value = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const hash = createHash('sha256').update(value).digest();
    let selected: typeof principals[number] | undefined;
    for (const principal of principals) if (timingSafeEqual(hash, principal.hash) && principal.active) selected = principal;
    if (!selected) throw new ApiError(401, 'Authentication required');
    return selected;
  };
  let origin = '';
  let totalWindow = 0, totalCount = 0;
  const send = (response: ServerResponse, status: number, value: unknown) => {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > MAX_BYTES) {
      response.writeHead(413, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Operation completed but response exceeds 1 MiB. Request a smaller result; do not blindly retry a mutation.' }));
    } else { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(json); }
  };
  const server = createServer({ maxHeaderSize: 16384 }, (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    void (async () => {
      const minute = Math.floor(Date.now() / 60_000);
      if (totalWindow !== minute) { totalWindow = minute; totalCount = 0; }
      if (++totalCount > Math.max(1000, rate * principals.length * 2)) throw new ApiError(429, 'Server request budget exceeded');
      if (`http://${request.headers.host}` !== origin || (request.headers.origin && request.headers.origin !== origin)) throw new ApiError(403, 'Unexpected request origin');
      if (request.method === 'GET' && (request.url === '/' || request.url === '/app.js')) {
        response.writeHead(200, { 'Content-Type': request.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' });
        response.end(request.url === '/' ? INSPECTOR_HTML : INSPECTOR_JS); return;
      }
      const principal = authenticate(request);
      if (principal.window !== minute) { principal.window = minute; principal.count = 0; }
      if (++principal.count > rate) throw new ApiError(429, 'Principal request budget exceeded');
      const memory = principal.memory;
      if (request.method === 'GET' && request.url === '/v1/capabilities') {
        send(response, 200, { workspaceId: memory.workspaceId, agentId: memory.agentId, readOnly: !!principal.readOnly,
          allowDestructive: !!principal.allowDestructive && !principal.readOnly, retrieval: principal.recall ? 'configured hybrid adapter' : 'lexical',
          contextRetrieval: principal.context ? 'configured hybrid adapter' : 'lexical', ...principal.runtime.capabilities(), live: true }); return;
      }
      if (request.method !== 'POST') throw new ApiError(405, 'Use POST');
      const body = await readJson(request);
      if (authenticate(request) !== principal) throw new ApiError(401, 'Principal changed');
      const operation = request.url?.match(/^\/v1\/([a-z-]+)$/)?.[1];
      const reads = ['recall', 'context', 'inspect', 'source', 'model', 'skill', 'branch-preview', 'entity-resolve', 'traverse'];
      if (!operation) throw new ApiError(404, 'Unknown operation');
      if (principal.readOnly && !reads.includes(operation)) throw new ApiError(403, 'Read-only principal');
      if (reads.includes(operation) && !principal.runtime.recallEnabled) throw new ApiError(403, 'Runtime recall is disabled');
      if (['store', 'correct', 'capture', 'branch-create', 'branch-stage', 'branch-merge'].includes(operation) && !principal.runtime.captureEnabled) throw new ApiError(403, 'Runtime capture is disabled');
      let result: unknown;
      switch (operation) {
        case 'recall': { const input = query.parse(body); result = principal.recall ? await principal.recall(input) : memory.recall(input); break; }
        case 'context': {
          const input = z.object({ query: text(4096), maxTokens: z.number().int().min(64).max(32768), taskId: id.optional() }).strict().parse(body);
          result = principal.context ? await principal.context(input) : memory.compile(input); break;
        }
        case 'inspect': {
          const input = z.object({ id: id.optional(), limit: z.number().int().min(1).max(100).optional(), cursor: text(4096).optional(), includeInactive: z.boolean().optional() }).strict().parse(body);
          result = input.id ? memory.get(input.id) ?? null : memory.list({ limit: input.limit ?? 20, cursor: input.cursor, includeInactive: input.includeInactive, includeUntrusted: true }); break;
        }
        case 'store': result = memory.store({ ...store.parse(body), trust: 'observed' }); break;
        case 'correct': {
          const { id: target, ...input } = correct.parse(body);
          const record = memory.get(target);
          if (record?.trust === 'verified' || record?.metadata.advisory === false || ['skill', 'model'].includes(String(record?.metadata.runtimeType))) throw new ApiError(403, 'Controller evidence and runtime artifacts require their controller interface');
          result = memory.correct(target, input); break;
        }
        case 'forget': {
          if (!principal.allowDestructive) throw new ApiError(403, 'Destructive operations disabled');
          const input = z.object({ id }).strict().parse(body);
          const record = memory.get(input.id);
          if (record?.metadata.advisory === false) throw new ApiError(403, 'Internal state requires its controller interface');
          result = record?.metadata.runtimeType === 'source' ? principal.runtime.forgetSource(input.id) : memory.forget(input.id); break;
        }
        case 'source': { const input = z.object({ id, offset: z.number().int().nonnegative().optional(), maxBytes: z.number().int().min(1).max(65536).optional() }).strict().parse(body); result = principal.runtime.expandSource(input.id, { offset: input.offset, maxBytes: input.maxBytes }); break; }
        case 'capture': {
          if (!principal.runtime.captureEnabled) throw new ApiError(403, 'Runtime capture is disabled');
          const input = z.object({ sessionId: id, adapter: z.enum(['generic', 'codex', 'claude']), jsonl: text(500_000) }).strict().parse(body);
          // The authorized host witnessed these messages; their claims remain fallible.
          result = principal.runtime.captureJsonl({ ...input, trust: 'observed' }); break;
        }
        case 'model': result = principal.runtime.getModel(z.object({ key: id }).strict().parse(body).key); break;
        case 'skill': result = principal.runtime.getSkill(z.object({ id }).strict().parse(body).id); break;
        case 'branch-create': result = new MemoryBranches(memory).create(z.object({ name: id, baseIds: z.array(id).max(64) }).strict().parse(body)); break;
        case 'branch-preview': result = new MemoryBranches(memory).preview(z.object({ id }).strict().parse(body).id); break;
        case 'branch-stage': {
          const input = z.object({ id, changes: z.array(z.discriminatedUnion('operation', [z.object({ operation: z.literal('add'), input: store }).strict(), correct.extend({ operation: z.literal('correct') }).strict()])).max(32) }).strict().parse(body);
          result = new MemoryBranches(memory).stage(input.id, input.changes.map(change => change.operation === 'add' ? { ...change, input: { ...change.input, trust: 'observed' } } : change)); break;
        }
        case 'branch-merge': result = new MemoryBranches(memory).merge(z.object({ id }).strict().parse(body).id); break;
        case 'entity-resolve': { const input = z.object({ name: text(256), type: id.optional() }).strict().parse(body); result = new MemoryRelations(memory).resolve(input.name, input.type); break; }
        case 'traverse': result = new MemoryRelations(memory).traverse(z.object({ entityId: id, maxDepth: z.number().int().min(1).max(4).optional(), maxNodes: z.number().int().min(1).max(200).optional(), predicates: z.array(id).max(32).optional(), direction: z.enum(['in', 'out', 'both']).optional(), asOf: z.iso.datetime().optional() }).strict().parse(body)); break;
        default: throw new ApiError(404, 'Unknown operation');
      }
      if (authenticate(request) !== principal) throw new ApiError(401, 'Principal revoked');
      send(response, 200, result);
    })().catch(error => {
      if (!response.headersSent) { response.setHeader('Connection', 'close'); send(response, error instanceof ApiError ? error.status : 400,
        { error: error instanceof z.ZodError ? 'Invalid operation input' : error instanceof Error ? error.message.slice(0, 2048) : 'Operation failed' }); }
      else response.end();
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.timeout = 15_000;
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 100;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Unable to bind HTTP server'); }
  origin = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  return { url: origin, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }),
    revoke: token => { const hash = createHash('sha256').update(token).digest(); let revoked = false;
      for (const principal of principals) if (timingSafeEqual(hash, principal.hash)) { revoked ||= principal.active; principal.active = false; } return revoked; } };
}
