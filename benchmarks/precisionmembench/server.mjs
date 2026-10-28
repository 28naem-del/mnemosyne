#!/usr/bin/env node
// PrecisionMemBench provider wrapper for the Mnemosyne kernel.
//
// Speaks the PMB universal wire protocol (DELETE /reset, POST /add,
// PUT /update, POST /search, GET /health) over the built `dist/local` kernel.
// One LocalMemory per PMB user_id; all share one SQLite file and are isolated
// only by the kernel's workspace scope (workspaceId = `pmb:<user_id>`), so the
// cross-user case exercises real kernel isolation, not separate databases.
//
// Knobs (environment):
//   PORT                          default 8089
//   MNEMOSYNE_PMB_RETRIEVAL       lexical | hybrid        (default lexical)
//   MNEMOSYNE_PMB_METADATA        protocol | extended     (default protocol)
//       protocol: trust only what the PMB protocol sends (beliefId, scope,
//                 and for the session adapter type/pinned/superseded_by).
//       extended: additionally honour type/superseded_by/resolved_at/created_at
//                 when present, by mapping them onto kernel supersession
//                 (correct()) and validity windows (validFrom/validUntil).
//                 Requires the disclosed harness patch that sends those keys.
//   MNEMOSYNE_PMB_CUTOFF          relative score floor in (0,1): drop results whose
//                                 score < CUTOFF * top score  (default: none)
//   MNEMOSYNE_PMB_MIN_SCORE       absolute score floor: drop results with score < MIN_SCORE
//   MNEMOSYNE_PMB_MIN_SIMILARITY  kernel minSimilarity (hybrid dense floor)
//   MNEMOSYNE_PMB_RERANK          1 to enable the bundled cross-encoder (hybrid)
//   MNEMOSYNE_PMB_DB              SQLite path (default: temp file)
//   MNEMOSYNE_PMB_LEXICAL_SCORING overlap | bm25 (kernel default when unset)
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kernelPath = resolve(here, '../../dist/local/index.js');
if (!existsSync(kernelPath)) { console.error(`kernel not built: ${kernelPath} (run npm run build)`); process.exit(2); }
const { createLocalMemory } = await import(kernelPath);

const PORT = Number(process.env.PORT ?? 8089);
const RETRIEVAL = process.env.MNEMOSYNE_PMB_RETRIEVAL ?? 'lexical';
const METADATA = process.env.MNEMOSYNE_PMB_METADATA ?? 'protocol';
const CUTOFF = process.env.MNEMOSYNE_PMB_CUTOFF ? Number(process.env.MNEMOSYNE_PMB_CUTOFF) : undefined;
const MIN_SCORE = process.env.MNEMOSYNE_PMB_MIN_SCORE ? Number(process.env.MNEMOSYNE_PMB_MIN_SCORE) : undefined;
const MIN_SIM = process.env.MNEMOSYNE_PMB_MIN_SIMILARITY ? Number(process.env.MNEMOSYNE_PMB_MIN_SIMILARITY) : undefined;
const RERANK = process.env.MNEMOSYNE_PMB_RERANK === '1';
const LEX = process.env.MNEMOSYNE_PMB_LEXICAL_SCORING;
if (!['lexical', 'hybrid'].includes(RETRIEVAL)) throw new Error(`bad MNEMOSYNE_PMB_RETRIEVAL ${RETRIEVAL}`);
if (!['protocol', 'extended'].includes(METADATA)) throw new Error(`bad MNEMOSYNE_PMB_METADATA ${METADATA}`);

const tmp = mkdtempSync(join(tmpdir(), 'mnemosyne-pmb-'));
const dbPath = process.env.MNEMOSYNE_PMB_DB ?? join(tmp, 'pmb.sqlite');

/** @type {Map<string, import('../../dist/local/index.js').LocalMemory>} */
let memories = new Map();
/** beliefId -> current kernel memory id (per user) */
let beliefIds = new Map();
/** superseded_by target beliefId -> [beliefId of the superseded records] not yet materialised */
let pending = new Map();
let counters = { add: 0, update: 0, search: 0, corrections: 0, windows: 0 };

function memoryFor(userId, create = true) {
  let m = memories.get(userId);
  if (!m && create) {
    m = createLocalMemory({
      path: dbPath,
      workspaceId: `pmb:${userId}`,
      agentId: 'pmb',
      retrieval: RETRIEVAL,
      requireEmbedder: RETRIEVAL === 'hybrid',
      rerank: RERANK,
      ...(MIN_SIM === undefined ? {} : { minSimilarity: MIN_SIM }),
      ledger: {},
    });
    memories.set(userId, m);
  }
  return m;
}

function resetAll() {
  for (const m of memories.values()) { try { m.close(); } catch {} }
  memories = new Map(); beliefIds = new Map(); pending = new Map();
  counters = { add: 0, update: 0, search: 0, corrections: 0, windows: 0 };
  for (const suffix of ['', '-wal', '-shm']) { try { rmSync(dbPath + suffix, { force: true }); } catch {} }
}

const KIND = { preference: 'preference', decision: 'decision', entity: 'fact', relation: 'fact', open_question: 'observation' };
const key = (userId, beliefId) => `${userId}\u0000${beliefId}`;

function iso(value) {
  if (typeof value !== 'string') return undefined;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

function payloadFor(text, meta) {
  const extended = METADATA === 'extended';
  const type = typeof meta.type === 'string' ? meta.type : undefined;
  const scope = typeof meta.scope === 'string' ? meta.scope : Array.isArray(meta.scope) ? meta.scope[0] : 'unscoped';
  const metadata = { beliefId: String(meta.beliefId), scope };
  if (type) metadata.type = type;
  if (typeof meta.pinned === 'boolean') metadata.pinned = meta.pinned;
  if (meta.superseded_by) metadata.superseded_by = String(meta.superseded_by);
  const payload = {
    text,
    kind: (type && KIND[type]) || 'fact',
    source: { uri: `pmb://belief/${meta.beliefId}` },
    trust: 'observed',
    metadata,
  };
  if (extended && type === 'open_question') {
    // A resolved open question stops being current knowledge at resolved_at.
    const from = iso(meta.created_at), until = iso(meta.resolved_at);
    if (from && until && until > from) { payload.validFrom = from; payload.validUntil = until; counters.windows++; }
  }
  return payload;
}

function addBelief(userId, text, meta) {
  const m = memoryFor(userId);
  const beliefId = String(meta.beliefId);
  const payload = payloadFor(text, meta);
  const extended = METADATA === 'extended';
  let record;
  const waiting = extended ? pending.get(key(userId, beliefId)) : undefined;
  if (waiting && waiting.length > 0) {
    // This belief supersedes already-stored ones: materialise it as a kernel correction
    // of the first, then fold the remaining chain members into the same successor.
    const [first, ...rest] = waiting;
    const { kind: _k, trust: _t, source, text: t, metadata, validFrom, validUntil } = payload;
    record = m.correct(beliefIds.get(key(userId, first)), { text: t, source, reason: `PMB belief ${first} superseded_by ${beliefId}`, metadata, ...(validFrom ? { validFrom } : {}), ...(validUntil ? { validUntil } : {}) });
    counters.corrections++;
    for (const other of rest) {
      const dup = m.correct(beliefIds.get(key(userId, other)), { text: t, source, reason: `PMB belief ${other} superseded_by ${beliefId}`, metadata });
      counters.corrections++;
      beliefIds.set(key(userId, other), dup.id);
    }
    pending.delete(key(userId, beliefId));
  } else {
    record = m.store(payload);
  }
  beliefIds.set(key(userId, beliefId), record.id);
  if (extended && meta.superseded_by) {
    const successor = String(meta.superseded_by);
    const successorId = beliefIds.get(key(userId, successor));
    if (successorId) {
      // Successor already exists: supersede this record in place with the successor's text.
      const succ = m.get(successorId);
      const fixed = m.correct(record.id, { text: succ.text, source: succ.source, reason: `PMB belief ${beliefId} superseded_by ${successor}`, metadata: succ.metadata });
      counters.corrections++;
      beliefIds.set(key(userId, beliefId), fixed.id);
    } else {
      const list = pending.get(key(userId, successor)) ?? [];
      list.push(beliefId);
      pending.set(key(userId, successor), list);
    }
  }
  counters.add++;
  return record;
}

function updateBelief(userId, beliefId, text, meta) {
  const m = memoryFor(userId);
  const current = beliefIds.get(key(userId, String(beliefId)));
  if (!current) return addBelief(userId, text, meta);
  const payload = payloadFor(text, meta);
  const record = m.correct(current, { text: payload.text, source: payload.source, reason: 'PMB belief updated (aliases added)', metadata: payload.metadata });
  beliefIds.set(key(userId, String(beliefId)), record.id);
  counters.update++;
  return record;
}

function search(userId, query, limit, scope) {
  counters.search++;
  if (typeof query !== 'string' || !query.trim()) return [];
  const m = memoryFor(userId, false);
  if (!m) return [];
  const scopes = scope === undefined ? null : new Set(Array.isArray(scope) ? scope : [scope]);
  const hits = m.recall({ query: query.slice(0, 4096), limit: 100, ...(LEX ? { lexicalScoring: LEX } : {}) });
  const seen = new Set();
  const out = [];
  const inScope = hits.filter((hit) => {
    const md = hit.memory.metadata ?? {};
    if (scopes && !scopes.has(md.scope)) return false;
    if (METADATA === 'extended' && md.type === 'open_question') return false; // type routing: OQs are not facts
    return true;
  });
  const top = inScope[0]?.score ?? 0;
  for (const hit of inScope) {
    const md = hit.memory.metadata ?? {};
    if (MIN_SCORE !== undefined && hit.score < MIN_SCORE) break;
    if (CUTOFF !== undefined && top > 0 && hit.score < CUTOFF * top) break;
    const beliefId = md.beliefId;
    if (!beliefId || seen.has(beliefId)) continue;
    seen.add(beliefId);
    out.push({ id: beliefId, memory: hit.memory.text, score: hit.score, kernel_id: hit.memory.id });
    if (out.length >= limit) break;
  }
  return out;
}

function readJson(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolvePromise(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, retrieval: RETRIEVAL, metadata: METADATA, cutoff: CUTOFF ?? null, minScore: MIN_SCORE ?? null, minSimilarity: MIN_SIM ?? null, rerank: RERANK, lexicalScoring: LEX ?? 'default', users: [...memories.keys()], counters });
    if (req.method === 'DELETE' && url.pathname === '/reset') { resetAll(); return send(res, 200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/wait') return send(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/add') {
      const body = await readJson(req);
      const r = addBelief(String(body.user_id), String(body.text ?? ''), body.metadata ?? {});
      return send(res, 200, { id: r.id, beliefId: r.metadata.beliefId });
    }
    if (req.method === 'PUT' && url.pathname === '/update') {
      const body = await readJson(req);
      const r = updateBelief(String(body.user_id), String(body.beliefId), String(body.text ?? ''), body.metadata ?? {});
      return send(res, 200, { id: r.id, beliefId: r.metadata.beliefId });
    }
    if (req.method === 'POST' && url.pathname === '/search') {
      const body = await readJson(req);
      const limit = Math.max(1, Math.min(100, Number(body.limit ?? 20) || 20));
      return send(res, 200, { results: search(String(body.user_id), body.query, limit, body.scope) });
    }
    if (req.method === 'GET' && url.pathname === '/ledger') {
      // Debug aid: full export of one user's store (not used by the harness).
      const m = memoryFor(url.searchParams.get('user_id') ?? 'test-user', false);
      return send(res, 200, m ? m.export() : {});
    }
    return send(res, 404, { error: 'not found' });
  } catch (error) {
    console.error(`[pmb-server] ${req.method} ${url.pathname}: ${error?.stack ?? error}`);
    return send(res, 500, { error: String(error?.message ?? error) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[pmb-server] listening on http://127.0.0.1:${PORT} retrieval=${RETRIEVAL} metadata=${METADATA} cutoff=${CUTOFF ?? 'none'} minScore=${MIN_SCORE ?? 'none'} minSimilarity=${MIN_SIM ?? 'none'} rerank=${RERANK} db=${dbPath}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { resetAll(); rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(0); });
