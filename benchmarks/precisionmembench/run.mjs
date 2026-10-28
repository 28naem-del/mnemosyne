#!/usr/bin/env node
// Runs one PrecisionMemBench configuration end to end, synchronously:
// start server.mjs as a child, wait for /health, run the ava eval(s) in the
// pinned clone with MEMORY_PROVIDER=mnemosyne RESEED=true, copy the JSON
// reports to reports/precisionmembench/<label>/, then stop the server.
//
//   node benchmarks/precisionmembench/run.mjs --label lexical-protocol \
//        --retrieval lexical --metadata protocol [--cutoff 0.3] [--min-score 3] [--min-sim 0.55] [--rerank] [--session|--both]
//        [--extended-harness]   apply patches/pmb-extended-metadata.patch to the clone for this run (configuration B)
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const clone = resolve(root, 'benchmarks/data/precisionmembench');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);
const label = opt('label', 'run');
const retrieval = opt('retrieval', 'lexical');
const metadata = opt('metadata', 'protocol');
const cutoff = opt('cutoff');
const minSim = opt('min-sim');
const minScore = opt('min-score');
const lexical = opt('lexical-scoring');
const port = Number(opt('port', '8089'));
const outDir = resolve(root, 'reports/precisionmembench', label);
const extendedHarness = flag('extended-harness');
const patchFile = resolve(here, 'patches/pmb-extended-metadata.patch');
const gitClone = (...a) => spawnSync('git', ['-C', clone, ...a], { encoding: 'utf8' });
if (extendedHarness) {
  // Configuration B: the clone's BaseAdapter forwards belief lifecycle fields during seeding.
  // Applied for this run only and reverted afterwards; recorded in run-summary.json.
  const applied = gitClone('apply', patchFile);
  if (applied.status !== 0) { console.error(`could not apply ${patchFile}: ${applied.stderr}`); process.exit(2); }
}
const revertHarness = () => { if (extendedHarness) gitClone('checkout', '--', 'src/adapters/baseAdapter.ts'); };
process.on('exit', revertHarness);
mkdirSync(outDir, { recursive: true });

if (!existsSync(resolve(clone, 'node_modules/.bin/ava'))) { console.error('clone deps missing: run init.sh'); process.exit(2); }

const env = { ...process.env, PORT: String(port), MNEMOSYNE_PMB_RETRIEVAL: retrieval, MNEMOSYNE_PMB_METADATA: metadata };
if (cutoff) env.MNEMOSYNE_PMB_CUTOFF = cutoff;
if (minSim) env.MNEMOSYNE_PMB_MIN_SIMILARITY = minSim;
if (minScore) env.MNEMOSYNE_PMB_MIN_SCORE = minScore;
if (lexical) env.MNEMOSYNE_PMB_LEXICAL_SCORING = lexical;
if (flag('rerank')) env.MNEMOSYNE_PMB_RERANK = '1';
delete env.OPENAI_API_KEY; delete env.ANTHROPIC_API_KEY; delete env.OPENROUTER_API_KEY;

const serverLog = resolve(outDir, 'server.log');
const logFd = (await import('node:fs')).openSync(serverLog, 'w');
const server = spawn(process.execPath, [resolve(here, 'server.mjs')], { env, stdio: ['ignore', logFd, logFd] });
const stop = () => { if (!server.killed) server.kill('SIGTERM'); };
process.on('exit', stop);

const deadline = Date.now() + 120_000;
let health = null;
while (Date.now() < deadline) {
  try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) { health = await r.json(); break; } } catch {}
  if (server.exitCode !== null) { console.error(`server exited early (${server.exitCode}); see ${serverLog}`); process.exit(1); }
  await new Promise((r) => setTimeout(r, 250));
}
if (!health) { console.error('server never became healthy'); stop(); process.exit(1); }
console.log(`[run] server healthy: ${JSON.stringify(health)}`);

const tests = flag('session') ? ['src/session-retrieval.external.eval.test.ts'] : flag('both') ? ['src/retrieval.external.eval.test.ts', 'src/session-retrieval.external.eval.test.ts'] : ['src/retrieval.external.eval.test.ts'];
const summary = { label, retrieval, metadata, extendedHarness, harnessPatch: extendedHarness ? 'benchmarks/precisionmembench/patches/pmb-extended-metadata.patch' : null, cutoff: cutoff ?? null, minSimilarity: minSim ?? null, minScore: minScore ?? null, rerank: flag('rerank'), lexicalScoring: lexical ?? null, benchmarkCommit: spawnSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), benchmarkDirty: spawnSync('git', ['-C', clone, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean), kernelCommit: spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), node: process.version, startedAt: new Date().toISOString(), runs: [] };

for (const test of tests) {
  const isSession = test.includes('session');
  const reportName = isSession ? 'session-retrieval-report-mnemosyne.json' : 'retrieval-report-mnemosyne.json';
  const avaEnv = { ...env, MEMORY_PROVIDER: 'mnemosyne', RESEED: 'true', MNEMOSYNE_URL: `http://127.0.0.1:${port}` };
  console.log(`[run] ava ${test}`);
  const started = Date.now();
  const res = spawnSync(resolve(clone, 'node_modules/.bin/ava'), [test, '--verbose'], { cwd: clone, env: avaEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const avaOut = (res.stdout ?? '') + (res.stderr ?? '');
  writeFileSync(resolve(outDir, isSession ? 'ava-session.txt' : 'ava-single-turn.txt'), avaOut);
  const src = resolve(clone, 'test-results', reportName);
  let report = null;
  if (existsSync(src)) { copyFileSync(src, resolve(outDir, reportName)); report = JSON.parse(readFileSync(src, 'utf8')); }
  const tail = avaOut.trim().split('\n').slice(-6).join('\n');
  console.log(`[run] ava exit ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)}s\n${tail}`);
  const healthAfter = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
  const agg = report?.retrieval ?? null;
  summary.runs.push({ test, avaExit: res.status, seconds: (Date.now() - started) / 1000, report: report ? reportName : null,
    scores: agg ? { passed: agg.totalPassed, cases: agg.totalCases, passRate: agg.passRate, meanPrecision: agg.meanPrecision, meanRecall: agg.meanRecall, activeRetrievalPasses: agg.activeRetrievalPasses, passTypes: agg.passTypes, p50LatencyMs: agg.p50LatencyMs } : null,
    serverCounters: healthAfter?.counters ?? null });
}
writeFileSync(resolve(outDir, 'run-summary.json'), JSON.stringify(summary, null, 2) + '\n');
stop();
console.log(`[run] wrote ${outDir}`);
process.exit(summary.runs.every((r) => r.avaExit === 0) ? 0 : 3);
