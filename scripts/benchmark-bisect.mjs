#!/usr/bin/env node
// Memory bisect (M1) on a 10k-record store built from real LoCoMo text.
//
//   node scripts/benchmark-bisect.mjs [--corpus FILE] [--tasks 20] [--k 10]
//                                     [--counts 1,5,20] [--seed v0] [--out report.json]
//                                     [--confirm off|outcome|minimal] [--exact]
//
// `--confirm minimal` re-executes one ablation per blamed record, so the report
// carries whether the blame set is minimal under the exact oracle and not only
// under the cached ranking. `--exact` promotes the exact oracle to the search
// itself. Both cost a full re-index per test; the defaults are what the
// published numbers were measured with, and the report says which was used.
//
// Builds the store once, then for each fault count N: copies the store, plants
// N competing claims per targeted question, and bisects each failure. Reports
// blame precision, blame recall and time-to-locate.
//
// Deterministic and $0: lexical retrieval only, no model anywhere in the loop,
// no network. Questions that still pass after injection are counted and
// reported, not dropped.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createLocalMemory } from '../dist/local/index.js';
import { bisect } from '../dist/local/bisect.js';
import { buildSeededStore, injectSeededFaults } from '../dist/evaluation/seeded-faults.js';

const { values } = parseArgs({
  options: {
    corpus: { type: 'string' }, tasks: { type: 'string' }, k: { type: 'string' },
    counts: { type: 'string' }, seed: { type: 'string' }, out: { type: 'string' },
    target: { type: 'string' }, keep: { type: 'boolean' },
    confirm: { type: 'string' }, exact: { type: 'boolean' },
  },
});

const CORPUS = resolve(values.corpus ?? 'benchmarks/data/locomo10.json');
const TASKS = Number(values.tasks ?? 20);
const K = Number(values.k ?? 10);
const COUNTS = (values.counts ?? '1,5,20').split(',').map(Number);
const SEED = values.seed ?? 'v0-bisect';
const TARGET = Number(values.target ?? 10_000);
const CONFIRM = values.confirm ?? 'outcome';
const EXACT = values.exact === true;
if (!['off', 'outcome', 'minimal'].includes(CONFIRM)) { process.stderr.write(`benchmark-bisect: --confirm must be off, outcome or minimal\n`); process.exit(2); }
const BISECT_OPTIONS = { confirm: CONFIRM, ...(EXACT ? { exact: true } : {}) };
const WORKSPACE = 'bisect-benchmark';
const AGENT = 'auditor';
const DAY = 86_400_000;

if (!existsSync(CORPUS)) { process.stderr.write(`benchmark-bisect: corpus not found at ${CORPUS}\n`); process.exit(2); }

const log = (line) => process.stdout.write(`${line}\n`);
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const percent = (value) => `${(value * 100).toFixed(1)}%`;
// A measurement that was not taken prints as `n/a`, never as a number. `0.0s`
// in a time-to-locate column reads as "located instantly", which is the most
// flattering possible reading of "nothing was measured".
const percentOrNa = (value) => (value === null || value === undefined ? 'n/a' : percent(value));
const secondsOrNa = (ms) => (ms === null || ms === undefined ? 'n/a' : seconds(ms));
const quantile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1) + 0.5))];
};

/** mulberry32: the task sample is a fixed function of the seed, not of run order. */
function random(seed) {
  let state = [...seed].reduce((hash, character) => Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0, 2_166_136_261);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bisect-bench-'));
const basePath = join(root, 'base.sqlite');
const report = { corpus: CORPUS, seed: SEED, k: K, target: TARGET, oracle: { confirm: CONFIRM, exact: EXACT }, startedAt: new Date().toISOString(), runs: [] };

try {
  // ---- 1. The store -------------------------------------------------------
  const buildStarted = performance.now();
  let base = createLocalMemory({ path: basePath, workspaceId: WORKSPACE, agentId: AGENT, retrieval: 'lexical', ledger: false });
  const built = buildSeededStore(base, JSON.parse(readFileSync(CORPUS, 'utf8')), { workspaceId: WORKSPACE, agentId: AGENT, target: TARGET });
  const buildMs = performance.now() - buildStarted;
  report.composition = built.composition;
  report.buildMs = buildMs;

  const cut = { asOf: new Date(Date.parse(built.newest) + DAY).toISOString(), knownAt: new Date(Date.parse(built.newest) + DAY).toISOString() };
  report.cut = cut;

  log(`store    : ${built.composition.total} records in ${seconds(buildMs)}`);
  log(`           turns ${built.composition.turns} · observations ${built.composition.observations} · session summaries ${built.composition.sessionSummaries} · event summaries ${built.composition.eventSummaries} · sentence splits ${built.composition.sentences}`);
  log(`cut point: asOf ${cut.asOf}  knownAt ${cut.knownAt}`);
  log(`questions: ${built.questions.length} with resolvable evidence`);

  // ---- 2. Only questions that pass BEFORE injection can be targeted --------
  // Scanned in a seeded shuffle and stopped as soon as enough pass, so the
  // sample is neither the first N questions in file order nor a function of how
  // long the scan was willing to run.
  const pick = random(SEED);
  const shuffled = [...built.questions].sort((a, b) => (a.id < b.id ? -1 : 1))
    .map(question => ({ question, order: pick() })).sort((a, b) => a.order - b.order).map(entry => entry.question);
  const passing = [];
  const baselineStarted = performance.now();
  let scanned = 0;
  for (const question of shuffled) {
    scanned++;
    const hits = base.recall({ query: question.query, limit: K, ...cut }).map(hit => hit.memory.id);
    if (question.gold.some(id => hits.includes(id))) passing.push(question);
    if (passing.length >= TASKS) break;
  }
  log(`baseline : ${passing.length} of the first ${scanned} questions scanned pass at k=${K} (${seconds(performance.now() - baselineStarted)}); ${built.questions.length} have resolvable evidence`);
  report.baseline = { passing: passing.length, scanned, total: built.questions.length };
  base.close();

  const targeted = passing.slice(0, TASKS);
  log(`targeted : ${targeted.length} questions (seed ${SEED})\n`);
  report.targeted = targeted.map(question => question.id);

  // ---- 3. One run per fault count ----------------------------------------
  for (const count of COUNTS) {
    const path = join(root, `poisoned-${count}.sqlite`);
    copyFileSync(basePath, path);
    const memory = createLocalMemory({ path, workspaceId: WORKSPACE, agentId: AGENT, retrieval: 'lexical', ledger: false });
    const injected = new Map();
    for (const question of targeted) {
      const faults = injectSeededFaults(memory, question, { count, seed: SEED, workspaceId: WORKSPACE, agentId: AGENT, validFrom: built.newest });
      injected.set(question.id, faults.map(fault => fault.id));
    }
    const everyFault = new Set([...injected.values()].flat());

    const rows = [];
    let displaced = 0;
    for (const question of targeted) {
      const hits = memory.recall({ query: question.query, limit: K, ...cut }).map(hit => hit.memory.id);
      if (question.gold.some(id => hits.includes(id))) { rows.push({ id: question.id, displaced: false }); continue; }
      displaced++;
      const task = { id: question.id, query: question.query, k: K, gold: question.gold, ...cut };
      const started = performance.now();
      const result = bisect(memory, task, BISECT_OPTIONS);
      const elapsedMs = performance.now() - started;
      const mine = injected.get(question.id) ?? [];
      const hitFaults = result.blame.filter(id => everyFault.has(id));
      rows.push({
        id: question.id, displaced: true, elapsedMs,
        outcome: result.outcome, reason: result.reason, blame: result.blame.length,
        precision: result.blame.length ? hitFaults.length / result.blame.length : null,
        recall: mine.length ? result.blame.filter(id => mine.includes(id)).length / mine.length : null,
        goldRank: result.goldRank, universe: result.universe, tests: result.tests, widenings: result.widenings,
        minimalUnique: result.minimalUnique, exactConfirmed: result.exactConfirmed,
        exactMinimal: result.exactMinimal, stateSha256: result.stateSha256,
      });
      process.stdout.write(`  N=${count} ${question.id.padEnd(12)} ${result.outcome.padEnd(9)} blame ${String(result.blame.length).padStart(2)} of ${String(result.universe).padStart(3)}  ${seconds(elapsedMs).padStart(6)}  ${result.exactConfirmed ? 'confirmed' : 'UNCONFIRMED'}\n`);
    }
    memory.close();
    if (!values.keep) rmSync(path, { force: true });

    const bisected = rows.filter(row => row.displaced && row.outcome === 'blamed');
    const precisions = bisected.map(row => row.precision).filter(value => value !== null);
    const recalls = bisected.map(row => row.recall).filter(value => value !== null);
    const times = rows.filter(row => row.displaced).map(row => row.elapsedMs);
    const unique = bisected.filter(row => row.minimalUnique === true);
    const uniquePrecisions = unique.map(row => row.precision).filter(value => value !== null);
    // Oracle B refused the set. The row is not scored — an unverified blame set
    // has no business in a precision average — but it is counted and printed,
    // because "the cheap oracle was wrong here" is a result about the method.
    const unconfirmed = rows.filter(row => row.displaced && row.outcome === 'unconfirmed');
    const exactMinimals = bisected.map(row => row.exactMinimal).filter(value => value !== null);
    const mean = (list) => (list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null);

    const summary = {
      faults: count,
      targeted: targeted.length,
      displaced,
      notDisplaced: targeted.length - displaced,
      bisected: bisected.length,
      unfixable: rows.filter(row => row.displaced && row.outcome === 'unfixable').length,
      unconfirmed: unconfirmed.length,
      blamePrecision: mean(precisions),
      blameRecall: mean(recalls),
      blamePrecisionUnique: mean(uniquePrecisions),
      uniqueShare: bisected.length ? unique.length / bisected.length : null,
      exactConfirmedShare: bisected.length ? bisected.filter(row => row.exactConfirmed === true).length / bisected.length : null,
      exactMinimalShare: exactMinimals.length ? exactMinimals.filter(value => value === true).length / exactMinimals.length : null,
      medianTimeToLocateMs: quantile(times, 0.5),
      p95TimeToLocateMs: quantile(times, 0.95),
      meanTestsPerBisect: mean(bisected.map(row => row.tests)),
      meanUniverse: mean(bisected.map(row => row.universe)),
      rows,
    };
    report.runs.push(summary);
    log(`  N=${count}: precision ${percentOrNa(summary.blamePrecision)} · recall ${percentOrNa(summary.blameRecall)} · median ${secondsOrNa(summary.medianTimeToLocateMs)} · p95 ${secondsOrNa(summary.p95TimeToLocateMs)} · displaced ${displaced}/${targeted.length}${summary.unconfirmed ? ` · UNCONFIRMED ${summary.unconfirmed}` : ''}${summary.exactMinimalShare === null ? '' : ` · exact-minimal ${percent(summary.exactMinimalShare)}`}\n`);
  }

  // ---- 4. The gate --------------------------------------------------------
  log('');
  // The column headed "unique blame (oracle A)" is precision restricted to the
  // rows where the cached-rank swap scan found no equally small alternative. It
  // is a statement about that oracle's ranking, not a re-executed uniqueness
  // proof, and it is named so nobody has to guess which.
  log('| N | displaced | bisected | unconfirmed | blame precision | blame recall | unique blame (oracle A) | median TTL | p95 TTL | exact-confirmed | exact-minimal |');
  log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const run of report.runs) {
    log(`| ${run.faults} | ${run.displaced}/${run.targeted} | ${run.bisected} | ${run.unconfirmed} | ${percentOrNa(run.blamePrecision)} | ${percentOrNa(run.blameRecall)} | ${percentOrNa(run.blamePrecisionUnique)} | ${secondsOrNa(run.medianTimeToLocateMs)} | ${secondsOrNa(run.p95TimeToLocateMs)} | ${percentOrNa(run.exactConfirmedShare)} | ${percentOrNa(run.exactMinimalShare)} |`);
  }

  // A run where injection displaced nothing has no measurement in it. It is
  // reported as such — it is a real result about the regime — but it cannot
  // pass or fail a gate about the quality of a blame set.
  const measured = report.runs.filter(run => run.bisected > 0);
  const unmeasured = report.runs.filter(run => run.bisected === 0).map(run => run.faults);
  const precisionGate = measured.length > 0 && measured.every(run => (run.blamePrecision ?? 0) >= 0.9);
  const timeGate = measured.length > 0 && measured.every(run => (run.medianTimeToLocateMs ?? Infinity) < 60_000);
  report.gates = {
    precision: { threshold: 0.9, pass: precisionGate },
    medianTimeToLocate: { thresholdMs: 60_000, pass: timeGate },
    measuredCounts: measured.map(run => run.faults), unmeasuredCounts: unmeasured,
  };
  log('');
  if (unmeasured.length) log(`no measurement at N = ${unmeasured.join(', ')}: injection displaced nothing at k=${K}, so there was no failure to bisect`);
  const refused = report.runs.reduce((sum, run) => sum + run.unconfirmed, 0);
  if (refused) log(`unconfirmed  : ${refused} blame set(s) the exact oracle would not stand behind — excluded from precision, listed in the report`);
  log(`oracle       : search ${EXACT ? 'exact re-execution' : 'cached-rank ablation'}, confirmation ${CONFIRM}`);
  log(`gate blame precision >= 90%    : ${precisionGate ? 'PASS' : 'MISS'}${measured.length ? ` (over N = ${measured.map(run => run.faults).join(', ')})` : ' — nothing measured'}`);
  log(`gate median time-to-locate<60s : ${timeGate ? 'PASS' : 'MISS'}${measured.length ? '' : ' — nothing measured'}`);

  report.finishedAt = new Date().toISOString();
  if (values.out) { writeFileSync(resolve(values.out), `${JSON.stringify(report, null, 2)}\n`); log(`report   : ${resolve(values.out)}`); }
  process.exitCode = precisionGate && timeGate ? 0 : 1;
} finally {
  if (!values.keep) rmSync(root, { recursive: true, force: true });
}
