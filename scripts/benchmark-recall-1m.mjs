#!/usr/bin/env node
/**
 * T1.2 gate measurement: p95 of the default `recall()` call at 1M records,
 * warm, `indexMode:'hnsw'`, with REAL ONNX query embedding cost (not the
 * fixture-only cost `scripts/benchmark-ann-scale.mjs` measures).
 *
 * Written as a NEW script, not an edit of `benchmark-ann-scale.mjs`, so that
 * script's own baseline numbers stay directly comparable with t1.2b-fixes.
 *
 * Vectors must stay byte-identical to the ones already materialised in
 * `.benchmark-ann/store1m.sqlite` (built with `benchmark-ann-scale.mjs build`,
 * CLUSTERS=2000, DIMENSIONS=384, seed 20260914), or the dense channel would
 * compare apples to oranges against every REPORTED number in
 * findings/understand-t12.md. So the geometry/text generators below are a
 * byte-for-byte copy of that script's (same RNG, same seed, same constants).
 * The embedder is the "cost-faithful fixture": it pays a real ONNX forward
 * pass over the query text (the actual cost `recall()` incurs in production),
 * then DISCARDS that output and returns the deterministic fixture vector, so
 * the HNSW graph still sees exactly the vectors it was built from.
 *
 * Usage:
 *   node scripts/benchmark-recall-1m.mjs --store .benchmark-ann/store1m.sqlite \
 *     --config gate|retrieval|reranker-on|dense-derived|mixed \
 *     [--max-candidates 1000] [--n 1000] [--warmup 20] [--ledger on|off] \
 *     [--records 1000000] [--seed 4242]
 *
 * NEVER point --store at a path this script may mutate destructively: this
 * script only ever opens with `indexMode:'hnsw'` (never 'sqlite-vec' or
 * 'auto'), and only the `mixed` config writes at all, and it writes to a
 * throwaway `cp -c` clone, never the path given on the command line.
 */
import { createLocalMemory } from '../dist/local/index.js';
import { createBundledEmbedder } from '../dist/local/embedding/index.js';
import { existsSync, copyFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const at = argv.indexOf(`--${name}`); return at === -1 ? fallback : argv[at + 1]; };
const has = (name) => argv.includes(`--${name}`);

const RECORDS = Number(flag('records', 1_000_000));
const DIMENSIONS = Number(flag('dimensions', 384));
const CLUSTERS = Number(flag('clusters', 2000));
const STORE = flag('store', join(process.cwd(), '.benchmark-ann', 'store1m.sqlite'));
const CONFIG = flag('config', 'retrieval'); // gate | retrieval | reranker-on | dense-derived | mixed
const MAX_CANDIDATES = Number(flag('max-candidates', 1000));
const N = Number(flag('n', CONFIG === 'mixed' ? 30 : 1000));
const WARMUP = Number(flag('warmup', CONFIG === 'mixed' ? 5 : 20));
const LEDGER = flag('ledger', 'on') !== 'off'; // default: on, i.e. the shipped default
const SEED = Number(flag('seed', 4242));

if (!existsSync(STORE)) { console.error(`no store at ${STORE}; this script never builds one — see benchmark-ann-scale.mjs build`); process.exit(1); }

// --- byte-identical geometry/text generators, copied from benchmark-ann-scale.mjs ---
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; }; }
function gaussian(random) { let u = 0, v = 0; while (u === 0) u = random(); while (v === 0) v = random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function unit(random, dimensions) { const a = new Float64Array(dimensions); let n = 0; for (let i = 0; i < dimensions; i++) { a[i] = gaussian(random); n += a[i] * a[i]; } n = Math.sqrt(n); for (let i = 0; i < dimensions; i++) a[i] /= n; return a; }
const M = Math.sqrt(0.40), S = Math.sqrt(0.32), NOISE_COEF = Math.sqrt(0.28);
const geometry = rng(20260914);
const GLOBAL = unit(geometry, DIMENSIONS);
const CENTROIDS = Array.from({ length: CLUSTERS }, () => unit(geometry, DIMENSIONS));
function vectorFor(cluster, random) {
  const centroid = CENTROIDS[cluster % CLUSTERS];
  const noise = unit(random, DIMENSIONS);
  const out = new Array(DIMENSIONS); let norm = 0;
  for (let i = 0; i < DIMENSIONS; i++) { const x = M * GLOBAL[i] + S * centroid[i] + NOISE_COEF * noise[i]; out[i] = x; norm += x * x; }
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIMENSIONS; i++) out[i] /= norm;
  return out;
}
const VOCABULARY = Array.from({ length: 5000 }, (_, i) => `tok${i.toString(36)}`);
function textFor(index) {
  const cluster = index % CLUSTERS;
  const pick = rng(cluster + 1);
  const words = Array.from({ length: 4 }, () => VOCABULARY[(cluster * 7 + Math.floor(pick() * 400)) % VOCABULARY.length]);
  return `t${cluster} ${words.join(' ')} r${index}`;
}
function fixtureEncodeOne(text) {
  const match = /^t(\d+) .* r(\d+)$/.exec(text);
  if (!match) {
    const named = /^t(\d+)/.exec(text);
    const cluster = named ? Number(named[1]) : 0;
    return vectorFor(cluster, rng(cluster * 1_000_003 + 1));
  }
  const cluster = Number(match[1]), index = Number(match[2]);
  return vectorFor(cluster, rng(cluster * 1_000_003 + index + 1));
}

/** Pays the real ONNX forward pass (pre-registered as the mechanism under
 * test: query-embedding cost is scale-independent and missing from
 * benchmark-ann-scale.mjs's fixture-only numbers), then discards the output
 * and returns the deterministic fixture vector so the HNSW graph still sees
 * exactly what it was built from. Passage embedding (only exercised by the
 * `mixed` config's db.store() calls) is NOT cost-faithful — it just returns
 * the fixture vector directly — because the mixed config's purpose is to
 * show the write-invalidation cliff (corpus-stats + pending-vector drain),
 * not to add a second real-ONNX cost on top of it. */
function costFaithfulEmbedder(onnx) {
  const self = {
    model: 'ann-scale-fixture@v1+onnx-query-cost', dimensions: DIMENSIONS,
    embedSync: (texts, role) => {
      if (role === 'query') onnx.embedSync(texts, 'query'); // real cost, paid and discarded
      return texts.map(fixtureEncodeOne);
    },
    embed: async (texts, role) => self.embedSync(texts, role),
    forQueries: () => self, forPassages: () => self, close() { onnx.close?.(); },
  };
  return self;
}

const fmt = (n) => n.toFixed(2);
/** Nearest-rank percentile, not `sorted[floor(n*p)]` (benchmark-ann-scale.mjs's
 * formula, which is only safe at n>=20; this script's default n=1000 makes it
 * moot, but --n can be set small for a quick check). */
function nearestRank(sorted, p) { const rank = Math.max(1, Math.ceil(p * sorted.length)); return sorted[rank - 1]; }
/** A normal-approximation order-statistic CI for the p95 rank, per the dossier
 * (findings/understand-t12.md section 6, step 3): ranks around 0.95n +/-
 * 1.96*sqrt(n*0.95*0.05), reported as the sorted values at those rank bounds. */
function p95ConfidenceInterval(sorted) {
  const n = sorted.length, p = 0.95, se = Math.sqrt(n * p * (1 - p));
  const lo = Math.max(1, Math.round(n * p - 1.96 * se));
  const hi = Math.min(n, Math.round(n * p + 1.96 * se));
  return [sorted[lo - 1], sorted[hi - 1]];
}
function summarize(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = nearestRank(sorted, 0.95);
  const [ciLo, ciHi] = p95ConfidenceInterval(sorted);
  console.log(`  ${label}  n=${sorted.length}  p50=${fmt(nearestRank(sorted, 0.5))}ms  p95=${fmt(p95)}ms [CI ${fmt(ciLo)}-${fmt(ciHi)}]  p99=${fmt(nearestRank(sorted, 0.99))}ms  max=${fmt(sorted.at(-1))}ms`);
  return { p50: nearestRank(sorted, 0.5), p95, ciLo, ciHi, p99: nearestRank(sorted, 0.99), max: sorted.at(-1) };
}

function openEngine(storePath, embedder, overrides = {}) {
  const ledgerOn = overrides.ledger ?? LEDGER; // `ledger` is LedgerOptions|false, not a boolean — true is invalid
  return createLocalMemory({
    path: storePath, workspaceId: 'benchmark', agentId: 'bench', embedder,
    indexMode: 'hnsw', // NEVER 'sqlite-vec' or 'auto' against this fixture — see module header
    rerank: overrides.rerank ?? false,
    ...(ledgerOn ? {} : { ledger: false }),
    ...overrides.extra,
  });
}

async function main() {
  const onnx = createBundledEmbedder({ batchSize: 1 });
  const embedder = costFaithfulEmbedder(onnx);
  const random = rng(SEED);
  // Draw a distinct pool of indices for warm-up + measured queries, so the
  // "distinct from the warm-up ones" requirement is structural, not by luck.
  const pool = new Set();
  while (pool.size < WARMUP + N) pool.add(Math.floor(random() * RECORDS));
  const indices = [...pool];
  const warmupQueries = indices.slice(0, WARMUP).map(textFor);
  const measuredQueries = indices.slice(WARMUP, WARMUP + N).map(textFor);

  let storePath = STORE, cleanupDir;
  let rerank, extraLedgerOverride;
  if (CONFIG === 'gate') { rerank = false; }
  else if (CONFIG === 'retrieval') { rerank = false; }
  else if (CONFIG === 'reranker-on') { rerank = true; }
  else if (CONFIG === 'dense-derived') { rerank = false; }
  else if (CONFIG === 'mixed') {
    rerank = false;
    cleanupDir = mkdtempSync(join(tmpdir(), 'bm1m-mixed-'));
    storePath = join(cleanupDir, 'store.sqlite');
    mkdirSync(dirname(storePath), { recursive: true });
    for (const suffix of ['', '-hnsw', '-hnsw.meta.json']) copyFileSync(STORE + suffix, storePath + suffix);
    console.log(`mixed config: writing to a throwaway clone at ${storePath} (source store untouched)`);
  } else { console.error(`unknown --config ${CONFIG}`); process.exit(1); }

  console.log(`config=${CONFIG}  store=${storePath}  maxCandidates=${MAX_CANDIDATES}  rerank=${rerank}  ledger=${LEDGER}  n=${N}  warmup=${WARMUP}  records=${RECORDS}`);
  const db = openEngine(storePath, embedder, { rerank });

  // --- cold-start: the very first recall on this connection, reported separately ---
  const coldStart = performance.now();
  db.recall({ query: warmupQueries[0], limit: 10, maxCandidates: MAX_CANDIDATES });
  const coldMs = performance.now() - coldStart;
  console.log(`  cold-start (1st recall, HNSW load + pending-vector drain + corpusStats miss): ${fmt(coldMs)}ms`);

  for (const query of warmupQueries.slice(1)) db.recall({ query, limit: 10, maxCandidates: MAX_CANDIDATES });

  const samples = [];
  for (let i = 0; i < measuredQueries.length; i++) {
    const query = measuredQueries[i];
    if (CONFIG === 'mixed') db.store({ text: `mixed-write ${i} ${query}`, source: { uri: `benchmark://mixed/${i}` }, trust: 'observed', visibility: 'workspace' });
    const t = performance.now();
    db.recall({ query, limit: 10, maxCandidates: MAX_CANDIDATES });
    samples.push(performance.now() - t);
  }
  const hybrid = summarize('hybrid recall()  ', samples);

  let lexical;
  if (CONFIG === 'dense-derived') {
    const plain = openEngine(storePath, embedder, { extra: { retrieval: 'lexical' } });
    const lexSamples = [];
    plain.recall({ query: measuredQueries[0], limit: 10, maxCandidates: MAX_CANDIDATES });
    for (const query of measuredQueries) { const t = performance.now(); plain.recall({ query, limit: 10, maxCandidates: MAX_CANDIDATES }); lexSamples.push(performance.now() - t); }
    plain.close();
    lexical = summarize('lexical-only     ', lexSamples);
    console.log(`  dense channel p95 ~= ${fmt(hybrid.p95 - lexical.p95)}ms  — DERIVED, NOT A MEASUREMENT (two separately-sorted distributions; a 3.8x spread was observed historically). Use "node --cpu-prof" on the 'retrieval' config for a real per-function breakdown.`);
  }

  db.close();
  if (cleanupDir) { try { (await import('node:fs')).rmSync(cleanupDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
  embedder.close();
  console.log(`DONE config=${CONFIG}`);
}

main();
