#!/usr/bin/env node
/**
 * Dense-retrieval latency against store size, for the index modes in
 * `src/local/vector/`.
 *
 * Run in phases so a long build is not repeated:
 *   node scripts/benchmark-ann-scale.mjs build   --records 1000000
 *   node scripts/benchmark-ann-scale.mjs measure --mode exact
 *   node scripts/benchmark-ann-scale.mjs measure --mode sqlite-vec
 *   node scripts/benchmark-ann-scale.mjs measure --mode hnsw
 *
 * ON THE SYNTHETIC CORPUS. Uniform-random vectors are the WORST CASE for a
 * graph index and describe no real corpus: in 384 dimensions random points are
 * all near-equidistant, so there is no structure for a graph walk to follow and
 * measured recall collapses to noise. Real sentence embeddings are strongly
 * anisotropic — everything shares a common direction, which is why unrelated
 * text still scores ~0.4 — and they cluster by topic.
 *
 * So vectors here are generated as normalize(m*global + s*centroid + n*noise),
 * with the coefficients solved so that unrelated records land near cosine 0.40
 * and same-topic records near 0.72 — the distribution T1.1 measured for the
 * bundled bge-small model (true match 0.689-0.772, unrelated 0.335-0.525).
 * The achieved distribution is measured and printed on every run, so the
 * fixture is checkable rather than merely asserted.
 *
 * Latency is reported for the FULL synchronous recall() a caller actually
 * makes, and for a lexical-only recall on the same store, so the dense channel's
 * share is visible rather than inferred.
 */
import { createLocalMemory } from '../dist/local/index.js';
import { mkdirSync, existsSync, statSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const argv = process.argv.slice(2);
const phase = argv[0] ?? 'build';
const flag = (name, fallback) => { const at = argv.indexOf(`--${name}`); return at === -1 ? fallback : argv[at + 1]; };
const RECORDS = Number(flag('records', 1_000_000));
const QUERIES = Number(flag('queries', 200));
const DIMENSIONS = Number(flag('dimensions', 384));
const CLUSTERS = Number(flag('clusters', 2000));
const MODE = flag('mode', 'exact');
const STORE = flag('store', join(process.cwd(), '.benchmark-ann', `store-${RECORDS}-${DIMENSIONS}.sqlite`));
const MAX_CANDIDATES = Number(flag('max-candidates', 1000));

/** Deterministic, so a rebuilt store is the same store. */
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; }; }
function gaussian(random) { let u = 0, v = 0; while (u === 0) u = random(); while (v === 0) v = random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function unit(random, dimensions) { const a = new Float64Array(dimensions); let n = 0; for (let i = 0; i < dimensions; i++) { a[i] = gaussian(random); n += a[i] * a[i]; } n = Math.sqrt(n); for (let i = 0; i < dimensions; i++) a[i] /= n; return a; }

// unrelated ~0.40, same-topic ~0.72  =>  m^2=0.40, s^2=0.32, n^2=0.28
const M = Math.sqrt(0.40), S = Math.sqrt(0.32), N = Math.sqrt(0.28);
const geometry = rng(20260914);
const GLOBAL = unit(geometry, DIMENSIONS);
const CENTROIDS = Array.from({ length: CLUSTERS }, () => unit(geometry, DIMENSIONS));

function vectorFor(cluster, random) {
  const centroid = CENTROIDS[cluster % CLUSTERS];
  // All three components are UNIT vectors, so the coefficients actually set the
  // mix. Raw gaussians would carry a norm of sqrt(DIMENSIONS) and swamp the
  // other two, which collapses every cosine to ~0 — the uniform-random case
  // this fixture exists to avoid.
  const noise = unit(random, DIMENSIONS);
  const out = new Array(DIMENSIONS); let norm = 0;
  for (let i = 0; i < DIMENSIONS; i++) { const x = M * GLOBAL[i] + S * centroid[i] + N * noise[i]; out[i] = x; norm += x * x; }
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIMENSIONS; i++) out[i] /= norm;
  return out;
}

/**
 * Texts carry their cluster and index explicitly, so the fixture vector and the
 * stored text always agree, and they draw from a 5,000-word vocabulary rather
 * than a handful. Vocabulary size is not a detail: with twenty words every BM25
 * posting list contains nearly every document, the lexical channel degenerates
 * into a full scan, and it swamps the dense latency this benchmark exists to
 * measure.
 */
const VOCABULARY = Array.from({ length: 5000 }, (_, i) => `tok${i.toString(36)}`);
function textFor(index) {
  const cluster = index % CLUSTERS;
  const pick = rng(cluster + 1);
  // Eight tokens from a per-cluster slice, so same-topic records share wording.
  const words = Array.from({ length: 8 }, () => VOCABULARY[(cluster * 7 + Math.floor(pick() * 400)) % VOCABULARY.length]);
  return `t${cluster} ${words.join(' ')} r${index}`;
}

/** The embedder is the fixture: it reads the cluster and index back out of the
 *  text, so a record's stored vector is exactly the one the geometry defines. */
function fixtureEmbedder() {
  const encode = (text) => {
    const match = /^t(\d+) .* r(\d+)$/.exec(text);
    if (!match) { // a free-text query: place it in the cluster named by its first token
      const named = /^t(\d+)/.exec(text);
      const cluster = named ? Number(named[1]) : 0;
      return vectorFor(cluster, rng(cluster * 1_000_003 + 1));
    }
    const cluster = Number(match[1]), index = Number(match[2]);
    return vectorFor(cluster, rng(cluster * 1_000_003 + index + 1));
  };
  const self = { model: 'ann-scale-fixture@v1', dimensions: DIMENSIONS, embedSync: (texts) => texts.map(encode), embed: async (texts) => texts.map(encode), forQueries: () => self, forPassages: () => self, close() {} };
  return self;
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const fmt = (n) => n.toFixed(1);
function sizeOf(path) { let total = 0; for (const suffix of ['', '-wal', '-shm', '-hnsw', '-hnsw.meta.json']) { try { total += statSync(path + suffix).size; } catch { /* absent */ } } return total; }

function open(mode) {
  return createLocalMemory({ path: STORE, workspaceId: 'benchmark', agentId: 'bench', embedder: fixtureEmbedder(), rerank: false, ledger: false, indexMode: mode });
}

if (phase === 'build') {
  // Storing and vector-materialising are separate phases so each finishes inside
  // a normal foreground run at a million records.
  mkdirSync(dirname(STORE), { recursive: true });
  // `--offset` appends, so a large store can be built across several runs.
  const OFFSET = Number(flag('offset', 0));
  if (OFFSET === 0) for (const suffix of ['', '-wal', '-shm', '-hnsw', '-hnsw.meta.json']) { try { rmSync(STORE + suffix); } catch { /* absent */ } }
  console.log(`building ${RECORDS} records x ${DIMENSIONS}d, ${CLUSTERS} clusters from offset ${OFFSET} -> ${STORE}`);
  const db = open('exact');
  const t = performance.now();
  for (let index = OFFSET; index < RECORDS; index++) {
    db.store({ text: textFor(index), source: { uri: `benchmark://ann/${index}` }, trust: 'observed', visibility: 'workspace' });
    if (index && index % 100_000 === 0) process.stderr.write(`  stored ${index} @ ${fmt((index - OFFSET) / ((performance.now() - t) / 1000))}/s\r`);
  }
  console.log(`stored ${RECORDS - OFFSET} records (offset ${OFFSET}) in ${fmt((performance.now() - t) / 1000)}s`);
  db.close();
  console.log(`store size after records only: ${(sizeOf(STORE) / 1e9).toFixed(2)} GB`);
} else if (phase === 'index') {
  // The read path is what writes vectors, so one recall materialises the lot.
  const db = open(MODE);
  const t = performance.now();
  db.recall({ query: textFor(0), limit: 10, maxCandidates: MAX_CANDIDATES });
  console.log(`mode=${MODE} embedded+indexed on first recall: ${fmt((performance.now() - t) / 1000)}s  index=${JSON.stringify(db.retrieval.index)}`);
  db.close();
  console.log(`store size: ${(sizeOf(STORE) / 1e9).toFixed(2)} GB`);
} else if (phase === 'geometry') {
  const random = rng(5);
  const sample = Array.from({ length: 400 }, (_, i) => vectorFor(i, rng(i + 1)));
  const cos = (a, b) => { let s = 0; for (let i = 0; i < DIMENSIONS; i++) s += a[i] * b[i]; return s; };
  const same = [], cross = [];
  for (let i = 0; i < 200; i++) { same.push(cos(vectorFor(i, rng(i + 1)), vectorFor(i + CLUSTERS, rng(i + 7)))); cross.push(cos(sample[i], sample[i + 200])); }
  same.sort((a, b) => a - b); cross.sort((a, b) => a - b);
  console.log(`same-topic  cosine  p05=${same[10].toFixed(3)} median=${same[100].toFixed(3)} p95=${same[189].toFixed(3)}   (bge-small measured 0.689-0.772)`);
  console.log(`unrelated   cosine  p05=${cross[10].toFixed(3)} median=${cross[100].toFixed(3)} p95=${cross[189].toFixed(3)}   (bge-small measured 0.335-0.525)`);
} else if (phase === 'measure') {
  if (!existsSync(STORE)) { console.error(`no store at ${STORE}; run the build phase first`); process.exit(1); }
  const db = open(MODE);
  const random = rng(4242);
  const queries = Array.from({ length: QUERIES }, () => textFor(Math.floor(random() * RECORDS)));
  db.recall({ query: queries[0], limit: 10, maxCandidates: MAX_CANDIDATES });  // resolve the index, warm the caches
  const status = db.retrieval;
  console.log(`mode=${MODE}  reported=${JSON.stringify(status.index)}  records=${RECORDS}  maxCandidates=${MAX_CANDIDATES}`);
  const hybrid = [], lexical = [];
  for (const query of queries) { const t = performance.now(); db.recall({ query, limit: 10, maxCandidates: MAX_CANDIDATES }); hybrid.push(performance.now() - t); }
  db.close();
  const plain = createLocalMemory({ path: STORE, workspaceId: 'benchmark', agentId: 'bench', retrieval: 'lexical', ledger: false });
  for (const query of queries) { const t = performance.now(); plain.recall({ query, limit: 10, maxCandidates: MAX_CANDIDATES }); lexical.push(performance.now() - t); }
  plain.close();
  hybrid.sort((a, b) => a - b); lexical.sort((a, b) => a - b);
  console.log(`  hybrid recall()   p50=${fmt(percentile(hybrid, 0.5))}ms  p95=${fmt(percentile(hybrid, 0.95))}ms  p99=${fmt(percentile(hybrid, 0.99))}ms  max=${fmt(hybrid.at(-1))}ms`);
  console.log(`  lexical-only      p50=${fmt(percentile(lexical, 0.5))}ms  p95=${fmt(percentile(lexical, 0.95))}ms   (the BM25 channel's share of the above)`);
  console.log(`  dense channel     p95 ~= ${fmt(percentile(hybrid, 0.95) - percentile(lexical, 0.95))}ms  (hybrid p95 minus lexical p95)`);
  console.log(`  store on disk     ${(sizeOf(STORE) / 1e9).toFixed(2)} GB`);
} else if (phase === 'agreement') {
  // What the index costs in recall, measured against the exact scan on the very
  // same store rather than against a synthetic ground truth.
  if (!existsSync(STORE)) { console.error(`no store at ${STORE}`); process.exit(1); }
  const random = rng(99);
  const queries = Array.from({ length: Number(flag('queries', 100)) }, () => textFor(Math.floor(random() * RECORDS)));
  const truth = [];
  const exact = open('exact');
  for (const query of queries) truth.push(exact.recall({ query, limit: 10, maxCandidates: MAX_CANDIDATES }).map(hit => hit.memory.id));
  exact.close();
  const db = open(MODE);
  let hit = 0, total = 0, identical = 0;
  queries.forEach((query, index) => {
    const got = new Set(db.recall({ query, limit: 10, maxCandidates: MAX_CANDIDATES }).map(hit => hit.memory.id));
    const want = truth[index];
    hit += want.filter(id => got.has(id)).length; total += want.length;
    if (want.length === got.size && want.every(id => got.has(id))) identical++;
  });
  db.close();
  console.log(`mode=${MODE}  recall@10 vs the exact scan = ${(100 * hit / total).toFixed(2)}%   top-10 sets identical on ${identical}/${queries.length} queries`);
} else { console.error(`unknown phase ${phase}`); process.exit(1); }
