#!/usr/bin/env node
// Runs one PrecisionMemBench configuration end to end, synchronously:
// start server.mjs as a child, wait for /health, run the ava eval(s) in the
// pinned clone with MEMORY_PROVIDER=mnemosyne RESEED=true, copy the JSON
// reports to reports/precisionmembench/<label>/, then stop the server.
//
//   node benchmarks/precisionmembench/run.mjs --label lexical-protocol \
//        --retrieval lexical --metadata protocol [--min-scores '{"reranker":0.3}'] [--named auto|true|false] [--no-fuzzy] [--rerank] [--session|--both]
//        [--extended-harness]   apply patches/pmb-extended-metadata.patch to the clone for this run (configuration B)
//
// No wrapper-side filter exists any more: --min-scores, --named and --no-fuzzy are
// KERNEL options (recall() evaluates them and the ledger records them), and
// run-summary.json states `wrapperFilter: "none"` and `recallKinds: null` (the
// server passes no kind predicate to recall()). The old --cutoff, --min-score
// and --min-sim post-filters are rejected.
//
// A run publishes only reports it produced itself. Every output is written to a
// staging directory and renamed onto reports/precisionmembench/<label>/ only
// after every eval left a fresh, parseable report and the server stayed up; the
// clone's own report file is deleted before each eval, so an old one can never be
// picked up. A failed run exits 1 and leaves the previous <label>/ untouched.
// run-summary.json carries a runId and an inputsHash (sha256 of the configuration,
// clone and kernel commits, and the wrapper files), and records the sha256 of
// every report it published under that runId. Exit codes: 0 every eval passed,
// 3 a fresh report recorded failing cases (every published configuration does),
// 1 the run failed and published nothing, 2 bad arguments or setup.
//
// MNEMOSYNE_PMB_CLONE and MNEMOSYNE_PMB_REPORTS override the clone and the
// reports root (used by the runner's own test).
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, copyFileSync, existsSync, writeFileSync, readFileSync, rmSync, renameSync, statSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const clone = resolve(process.env.MNEMOSYNE_PMB_CLONE ?? resolve(root, 'benchmarks/data/precisionmembench'));
const reportsRoot = resolve(process.env.MNEMOSYNE_PMB_REPORTS ?? resolve(root, 'reports/precisionmembench'));
const runId = randomUUID();
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);
const label = opt('label', 'run');
const retrieval = opt('retrieval', 'lexical');
const metadata = opt('metadata', 'protocol');
for (const removed of ['cutoff', 'min-score', 'min-sim']) {
  if (args.includes(`--${removed}`)) { console.error(`--${removed} was a wrapper-side filter and is no longer supported; use the kernel's --min-scores`); process.exit(2); }
}
const minScores = opt('min-scores');
const named = opt('named', 'auto');
const fuzzy = !flag('no-fuzzy');
const lexical = opt('lexical-scoring');
const port = Number(opt('port', '8089'));
const outDir = resolve(reportsRoot, label);
// Staged beside the destination so the final rename stays on one filesystem.
const stageDir = resolve(dirname(outDir), `.staging-${runId}`);
const fail = (message) => { console.error(`[run] FAILED, nothing published (previous ${outDir} left as it was): ${message}`); process.exit(1); };
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
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
if (!existsSync(resolve(clone, 'node_modules/.bin/ava'))) { console.error('clone deps missing: run init.sh'); process.exit(2); }
mkdirSync(stageDir, { recursive: true });
process.on('exit', () => rmSync(stageDir, { recursive: true, force: true }));
console.log(`[run] runId ${runId}`);

const env = { ...process.env, PORT: String(port), MNEMOSYNE_PMB_RETRIEVAL: retrieval, MNEMOSYNE_PMB_METADATA: metadata };
if (minScores) env.MNEMOSYNE_PMB_MIN_SCORES = minScores;
env.MNEMOSYNE_PMB_NAMED = named;
if (!fuzzy) env.MNEMOSYNE_PMB_FUZZY = '0';
if (lexical) env.MNEMOSYNE_PMB_LEXICAL_SCORING = lexical;
if (flag('rerank')) env.MNEMOSYNE_PMB_RERANK = '1';
delete env.OPENAI_API_KEY; delete env.ANTHROPIC_API_KEY; delete env.OPENROUTER_API_KEY;

const serverLog = resolve(stageDir, 'server.log');
const logFd = openSync(serverLog, 'w');
const server = spawn(process.execPath, [resolve(here, 'server.mjs')], { env, stdio: ['ignore', logFd, logFd] });
const stop = () => { if (!server.killed) server.kill('SIGTERM'); };
process.on('exit', stop);

const deadline = Date.now() + 120_000;
let health = null;
while (Date.now() < deadline) {
  try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) { health = await r.json(); break; } } catch {}
  if (server.exitCode !== null) fail(`server exited early (${server.exitCode}): ${readFileSync(serverLog, 'utf8').trim().split('\n').slice(-5).join(' | ')}`);
  await new Promise((r) => setTimeout(r, 250));
}
if (!health) { stop(); fail('server never became healthy'); }
console.log(`[run] server healthy: ${JSON.stringify(health)}`);

const tests = flag('session') ? ['src/session-retrieval.external.eval.test.ts'] : flag('both') ? ['src/retrieval.external.eval.test.ts', 'src/session-retrieval.external.eval.test.ts'] : ['src/retrieval.external.eval.test.ts'];
const inputs = { label, retrieval, metadata, extendedHarness, minScores: minScores ?? null, named, fuzzy, lexicalScoring: lexical ?? null, rerank: flag('rerank'), tests,
  benchmarkCommit: spawnSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() ?? '',
  benchmarkDirty: (spawnSync('git', ['-C', clone, 'status', '--porcelain'], { encoding: 'utf8' }).stdout ?? '').trim().split('\n').filter(Boolean),
  kernelCommit: spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() ?? '',
  files: Object.fromEntries(['server.mjs', 'run.mjs', 'patches/pmb-register-provider.patch', 'patches/pmb-extended-metadata.patch'].map((file) => [file, sha256(readFileSync(resolve(here, file)))])) };
const inputsHash = sha256(JSON.stringify(inputs));
const summary = { runId, inputsHash, inputFiles: inputs.files, label, retrieval, metadata, extendedHarness, harnessPatch: extendedHarness ? 'benchmarks/precisionmembench/patches/pmb-extended-metadata.patch' : null, wrapperFilter: 'none', noWrapperFilter: true, recallKinds: null, kernel: { requireNamedMatch: named === 'auto' ? 'auto' : named === 'true', fuzzy, minScores: minScores ? JSON.parse(minScores) : null }, rerank: flag('rerank'), lexicalScoring: lexical ?? null, benchmarkCommit: inputs.benchmarkCommit, benchmarkDirty: inputs.benchmarkDirty, kernelCommit: inputs.kernelCommit, node: process.version, startedAt: new Date().toISOString(), runs: [] };

for (const test of tests) {
  const isSession = test.includes('session');
  const reportName = isSession ? 'session-retrieval-report-mnemosyne.json' : 'retrieval-report-mnemosyne.json';
  const avaEnv = { ...env, MEMORY_PROVIDER: 'mnemosyne', RESEED: 'true', MNEMOSYNE_URL: `http://127.0.0.1:${port}` };
  const src = resolve(clone, 'test-results', reportName);
  rmSync(src, { force: true });
  console.log(`[run] ava ${test}`);
  const started = Date.now();
  const res = spawnSync(resolve(clone, 'node_modules/.bin/ava'), [test, '--verbose'], { cwd: clone, env: avaEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const avaOut = (res.stdout ?? '') + (res.stderr ?? '');
  writeFileSync(resolve(stageDir, isSession ? 'ava-session.txt' : 'ava-single-turn.txt'), avaOut);
  const tail = avaOut.trim().split('\n').slice(-6).join('\n');
  console.log(`[run] ava exit ${res.status} in ${((Date.now() - started) / 1000).toFixed(1)}s\n${tail}`);
  // Only a report this eval wrote counts. The one from an earlier run was removed
  // before ava started, so a missing file means this eval produced none.
  if (!existsSync(src)) fail(`${test} wrote no ${reportName} (ava exit ${res.status}${res.error ? `, ${res.error.message}` : ''})`);
  if (statSync(src).mtimeMs < started - 1000) fail(`${src} predates this run`);
  const bytes = readFileSync(src);
  let report;
  try { report = JSON.parse(bytes.toString('utf8')); } catch (error) { fail(`${reportName} is not valid JSON: ${error.message}`); }
  const agg = report?.retrieval;
  if (!agg || typeof agg.totalPassed !== 'number' || typeof agg.totalCases !== 'number') fail(`${reportName} has no retrieval aggregate`);
  const healthAfter = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).catch(() => null);
  if (!healthAfter) fail(`the server stopped answering during ${test}; see the server log`);
  copyFileSync(src, resolve(stageDir, reportName));
  summary.runs.push({ test, avaExit: res.status, seconds: (Date.now() - started) / 1000, report: reportName, reportSha256: sha256(bytes), reportRunId: runId,
    scores: agg ? { passed: agg.totalPassed, cases: agg.totalCases, passRate: agg.passRate, meanPrecision: agg.meanPrecision, meanRecall: agg.meanRecall, activeRetrievalPasses: agg.activeRetrievalPasses, passTypes: agg.passTypes, p50LatencyMs: agg.p50LatencyMs } : null,
    serverCounters: healthAfter.counters ?? null });
}
stop();
writeFileSync(resolve(stageDir, 'run-summary.json'), JSON.stringify(summary, null, 2) + '\n');
// Publish: the previous directory is set aside, the staged one renamed into place,
// and only then is the old one removed.
const previous = existsSync(outDir) ? resolve(dirname(outDir), `.previous-${runId}`) : null;
if (previous) renameSync(outDir, previous);
renameSync(stageDir, outDir);
if (previous) rmSync(previous, { recursive: true, force: true });
console.log(`[run] wrote ${outDir} (runId ${runId}, inputsHash ${inputsHash})`);
process.exit(summary.runs.every((r) => r.avaExit === 0) ? 0 : 3);
