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
//   MNEMOSYNE_PMB_MIN_SCORES      JSON for the KERNEL's `minScores` option, e.g.
//                                 '{"reranker":0.3}' (default: none). Evaluated by
//                                 recall() and recorded in the ledger's retrieval.config.
//   MNEMOSYNE_PMB_NAMED           kernel requireNamedMatch: auto | true | false (default auto)
//   MNEMOSYNE_PMB_FUZZY           0 to turn the kernel's fuzzy expansion off (default on)
//
// No wrapper-side filter: the result list returned to the harness is exactly the
// list recall() returned, mapped record -> beliefId. Translation only:
//   - the /add body's `aliases` plus the canonical name become `metadata.names`;
//   - a /search `scope` (string or array) becomes the kernel metadata predicate
//     `metadata: { scope: [...] }`, evaluated in recall()'s SQL;
//   - `limit` is passed through.
// The earlier CUTOFF / MIN_SCORE / MIN_SIMILARITY post-filters are gone.
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
const MIN_SCORES = process.env.MNEMOSYNE_PMB_MIN_SCORES ? JSON.parse(process.env.MNEMOSYNE_PMB_MIN_SCORES) : undefined;
const NAMED = { auto: 'auto', true: true, false: false }[process.env.MNEMOSYNE_PMB_NAMED ?? 'auto'];
const FUZZY = process.env.MNEMOSYNE_PMB_FUZZY !== '0';
const RERANK = process.env.MNEMOSYNE_PMB_RERANK === '1';
const LEX = process.env.MNEMOSYNE_PMB_LEXICAL_SCORING;
if (!['lexical', 'hybrid'].includes(RETRIEVAL)) throw new Error(`bad MNEMOSYNE_PMB_RETRIEVAL ${RETRIEVAL}`);
if (!['protocol', 'extended'].includes(METADATA)) throw new Error(`bad MNEMOSYNE_PMB_METADATA ${METADATA}`);
if (NAMED === undefined) throw new Error(`bad MNEMOSYNE_PMB_NAMED ${process.env.MNEMOSYNE_PMB_NAMED}`);
for (const removed of ['MNEMOSYNE_PMB_CUTOFF', 'MNEMOSYNE_PMB_MIN_SCORE', 'MNEMOSYNE_PMB_MIN_SIMILARITY']) {
  if (process.env[removed] !== undefined) throw new Error(`${removed} was a wrapper-side filter and is no longer supported; use the kernel's MNEMOSYNE_PMB_MIN_SCORES`);
}

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
      requireNamedMatch: NAMED,
      fuzzy: FUZZY,
      ...(MIN_SCORES === undefined ? {} : { minScores: MIN_SCORES }),
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

/** The canonical name is the first word of the belief text the harness builds
 * (`canonical_name aliases content why`); canonical names carry no spaces. The
 * session adapter's mid-session /add sends no alias list, so such a belief
 * declares its canonical name alone. */
function namesFor(text, aliases) {
  const canonical = text.trim().split(/\s+/)[0];
  return [...new Set([canonical, ...(Array.isArray(aliases) ? aliases : [])].filter((name) => typeof name === 'string' && name.trim()))];
}

function payloadFor(text, meta, names) {
  const extended = METADATA === 'extended';
  const type = typeof meta.type === 'string' ? meta.type : undefined;
  const scope = typeof meta.scope === 'string' ? meta.scope : Array.isArray(meta.scope) ? meta.scope[0] : 'unscoped';
  const metadata = { beliefId: String(meta.beliefId), scope };
  if (type) metadata.type = type;
  if (typeof meta.pinned === 'boolean') metadata.pinned = meta.pinned;
  if (meta.superseded_by) metadata.superseded_by = String(meta.superseded_by);
  if (names?.length) metadata.names = names;
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

function addBelief(userId, text, meta, aliases) {
  const m = memoryFor(userId);
  const beliefId = String(meta.beliefId);
  const payload = payloadFor(text, meta, namesFor(text, aliases));
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
  // /update carries no alias list. The harness rebuilds the text as
  // `canonical old-aliases added-aliases content why`, so the added aliases are
  // exactly the span between the old name prefix and the old remainder. The span
  // is joined by spaces, so each of its words becomes a name.
  const previous = m.get(current);
  const oldNames = Array.isArray(previous?.metadata?.names) ? previous.metadata.names : undefined;
  let names = oldNames;
  if (oldNames) {
    const prefix = oldNames.join(' '), rest = previous.text.slice(prefix.length);
    if (previous.text.startsWith(prefix) && text.startsWith(prefix) && text.endsWith(rest) && text.length >= prefix.length + rest.length) {
      const added = text.slice(prefix.length, text.length - rest.length).trim().split(/\s+/).filter(Boolean);
      names = [...new Set([...oldNames, ...added])];
    }
  }
  const payload = payloadFor(text, meta, names);
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
  const scopes = scope === undefined ? null : (Array.isArray(scope) ? scope : [scope]).map(String);
  // Every exclusion below is made inside recall(): scope is a kernel metadata
  // predicate, names/floors/fuzzy are kernel options. No `kinds` predicate is
  // passed, because the harness /search never asks to drop a kind; a kind policy
  // would be a wrapper-side filter. The list is returned as recall() produced it.
  const hits = m.recall({
    query: query.slice(0, 4096), limit,
    ...(scopes?.length ? { metadata: { scope: scopes } } : {}),
    ...(LEX ? { lexicalScoring: LEX } : {}),
  });
  if (!hits.length) counters.abstained = (counters.abstained ?? 0) + 1;
  return hits.map((hit) => ({ id: hit.memory.metadata?.beliefId, memory: hit.memory.text, score: hit.score, kernel_id: hit.memory.id }));
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
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, retrieval: RETRIEVAL, metadata: METADATA, wrapperFilter: 'none', requireNamedMatch: NAMED, fuzzy: FUZZY, minScores: MIN_SCORES ?? null, rerank: RERANK, lexicalScoring: LEX ?? 'default', users: [...memories.keys()], counters });
    if (req.method === 'DELETE' && url.pathname === '/reset') { resetAll(); return send(res, 200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/wait') return send(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/add') {
      const body = await readJson(req);
      const r = addBelief(String(body.user_id), String(body.text ?? ''), body.metadata ?? {}, body.aliases);
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
  console.log(`[pmb-server] listening on http://127.0.0.1:${PORT} retrieval=${RETRIEVAL} metadata=${METADATA} wrapperFilter=none requireNamedMatch=${NAMED} fuzzy=${FUZZY} minScores=${MIN_SCORES ? JSON.stringify(MIN_SCORES) : 'none'} rerank=${RERANK} db=${dbPath}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { resetAll(); rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(0); });
