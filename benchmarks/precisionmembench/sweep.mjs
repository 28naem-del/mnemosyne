#!/usr/bin/env node
// Runs a small grid of wrapper configurations (single-turn eval only) and prints
// one table row per configuration from each run's retrieval-report JSON.
// Usage: node benchmarks/precisionmembench/sweep.mjs sweep-name 'label|args' 'label|args' ...
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const [sweepName, ...specs] = process.argv.slice(2);
const rows = [];
for (const spec of specs) {
  const [label, argstr] = spec.split('|');
  const args = argstr.trim().split(/\s+/).filter(Boolean);
  const res = spawnSync(process.execPath, [resolve(here, 'run.mjs'), '--label', `${sweepName}/${label}`, ...args], { cwd: root, encoding: 'utf8', env: process.env });
  const rep = resolve(root, 'reports/precisionmembench', sweepName, label, 'retrieval-report-mnemosyne.json');
  if (!existsSync(rep)) { rows.push({ label, error: 'no report', tail: (res.stdout + res.stderr).slice(-400) }); continue; }
  const r = JSON.parse(readFileSync(rep, 'utf8')).retrieval;
  rows.push({ label, args: argstr.trim(), passed: r.totalPassed, cases: r.totalCases, passRate: r.passRate, precision: r.meanPrecision, recall: r.meanRecall, active: r.activeRetrievalPasses, structural: r.passTypes.structural, trivial: r.passTypes.triviallyEmpty, p50ms: r.p50LatencyMs });
}
mkdirSync(resolve(root, 'reports/precisionmembench', sweepName), { recursive: true });
writeFileSync(resolve(root, 'reports/precisionmembench', sweepName, 'sweep.json'), JSON.stringify(rows, null, 2) + '\n');
console.log('label | args | passed/cases | passRate | precision | recall | active | structural | trivial | p50ms');
for (const r of rows) console.log(r.error ? `${r.label} | ERROR ${r.error} ${r.tail}` : `${r.label} | ${r.args} | ${r.passed}/${r.cases} | ${r.passRate} | ${r.precision} | ${r.recall} | ${r.active} | ${r.structural} | ${r.trivial} | ${r.p50ms}`);
