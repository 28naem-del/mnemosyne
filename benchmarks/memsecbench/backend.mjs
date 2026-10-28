#!/usr/bin/env node
// MemSecBench memory-backend adapter for the Mnemosyne kernel (NOT YET RUNNABLE
// AGAINST THE BENCHMARK: see README.md — the 310 cases and the harness are not
// public, and scoring needs judge-model calls).
//
// MemSecBench (arXiv 2607.27080) tracks one malicious memory through the
// lifecycle Write -> Recall -> Execute -> Forget/Repair with seven adjudicated
// checkpoints. A memory backend in that matrix has to expose exactly four
// operations. This shim exposes them over HTTP on top of the built kernel so an
// OpenClaw/Hermes-style harness can drive it like Mem0 / Mem0-Graph / A-MEM:
//
//   POST /write   {agent, text, source, trust?}         -> {id, trust}
//   POST /recall  {agent, query, limit?, includeUntrusted?} -> {results:[{id,text,trust,score}]}
//   POST /repair  {agent, ids:[...]} | {agent, query}   -> {deletedIds, kept}
//   GET  /state?agent=A                                  -> {active:[{id,text,trust}], ledger}
//   DELETE /reset                                        -> {}
//
// What the kernel brings to the three scored checkpoints:
//   persistence     : a write from an untrusted channel defaults to trust=untrusted
//                     and is withheld from recall()/compile() unless the caller
//                     opts in (includeUntrusted). Persisted, but not served.
//   execute chain   : compile() only admits provenance-gated records, so an
//                     untrusted memory cannot reach the prompt by default.
//   selective repair: forget(id) erases the record AND its descendants (ledger
//                     event 'erasure'), nothing else; benign records are untouched
//                     and the ledger records the erasure (as a count: an erased
//                     record leaves no identifying trace, by design).
//
// No LLM is involved on this side. Everything here is deterministic.
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kernelPath = resolve(here, '../../dist/local/index.js');
if (!existsSync(kernelPath)) { console.error(`kernel not built: ${kernelPath} (run npm run build)`); process.exit(2); }
const { createLocalMemory } = await import(kernelPath);

const PORT = Number(process.env.PORT ?? 8090);
const RETRIEVAL = process.env.MNEMOSYNE_MSB_RETRIEVAL ?? 'lexical';
const TRUSTED_SOURCES = new Set((process.env.MNEMOSYNE_MSB_TRUSTED_SOURCES ?? 'user,operator').split(','));

let dir = mkdtempSync(join(tmpdir(), 'mnemosyne-msb-'));
const stores = new Map();
function storeFor(agent) {
  const key = String(agent ?? 'default');
  let m = stores.get(key);
  if (!m) {
    m = createLocalMemory({ path: join(dir, 'msb.sqlite'), workspaceId: `msb:${key}`, agentId: 'msb', retrieval: RETRIEVAL, requireEmbedder: RETRIEVAL === 'hybrid', ledger: {} });
    stores.set(key, m);
  }
  return m;
}
function reset() {
  for (const m of stores.values()) m.close();
  stores.clear();
  rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), 'mnemosyne-msb-'));
}

export function write(agent, { text, source, trust }) {
  // Trust is decided by the channel, never by the content: only operator/user
  // channels (configurable) may write observed records; tool output, web pages,
  // documents and other agents land as untrusted.
  const channel = String(source?.channel ?? source ?? 'tool');
  const level = trust ?? (TRUSTED_SOURCES.has(channel) ? 'observed' : 'untrusted');
  const record = storeFor(agent).store({ text: String(text), kind: 'fact', trust: level, source: { uri: `msb://${channel}/${Date.now()}`, author: channel }, metadata: { channel } });
  return { id: record.id, trust: record.trust };
}
export function recall(agent, { query, limit = 10, includeUntrusted = false }) {
  const hits = storeFor(agent).recall({ query: String(query), limit: Math.min(100, Number(limit) || 10), includeUntrusted: Boolean(includeUntrusted) });
  return { results: hits.map(h => ({ id: h.memory.id, text: h.memory.text, trust: h.memory.trust, score: h.score })) };
}
export function repair(agent, { ids, query }) {
  const m = storeFor(agent);
  const targets = Array.isArray(ids) ? ids : recall(agent, { query, includeUntrusted: true }).results.map(r => r.id);
  const deletedIds = [];
  for (const id of targets) deletedIds.push(...m.forget(id).deletedIds);
  const kept = m.list({ includeUntrusted: true }).items.map(r => ({ id: r.id, trust: r.trust }));
  return { deletedIds, kept };
}
export function state(agent) {
  const m = storeFor(agent);
  return { active: m.list({ includeUntrusted: true }).items.map(r => ({ id: r.id, text: r.text, trust: r.trust })), ledger: m.ledger({ limit: 500 }).entries };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const read = req => new Promise((ok, no) => { let s = ''; req.on('data', c => { s += c; if (s.length > 1e6) no(new Error('body too large')); }); req.on('end', () => ok(s ? JSON.parse(s) : {})); req.on('error', no); });
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, retrieval: RETRIEVAL, agents: [...stores.keys()] });
      if (req.method === 'DELETE' && url.pathname === '/reset') { reset(); return json(res, 200, {}); }
      if (req.method === 'GET' && url.pathname === '/state') return json(res, 200, state(url.searchParams.get('agent')));
      const body = await read(req);
      if (req.method === 'POST' && url.pathname === '/write') return json(res, 200, write(body.agent, body));
      if (req.method === 'POST' && url.pathname === '/recall') return json(res, 200, recall(body.agent, body));
      if (req.method === 'POST' && url.pathname === '/repair') return json(res, 200, repair(body.agent, body));
      json(res, 404, { error: 'unknown route' });
    } catch (error) { json(res, 500, { error: String(error?.message ?? error) }); }
  }).listen(PORT, '127.0.0.1', () => console.log(`[msb-backend] listening on 127.0.0.1:${PORT} retrieval=${RETRIEVAL}`));
}
