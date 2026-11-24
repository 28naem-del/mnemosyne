// Re-derives every recall, anyHit, allHit and MRR value in summary.json from the per-question
// attempt records in the committed .json.gz files (never from a stored summary), then prints the
// three-row publication table from the same records. Exits 1 on any mismatch.
// Usage: node reports/matched-run-2026-10-29-zep/verify.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const summary = JSON.parse(readFileSync(join(HERE, 'summary.json'), 'utf8'));
const derived = {};
let checked = 0, mismatches = 0;
for (const run of summary.runs) {
  const report = JSON.parse(gunzipSync(readFileSync(join(HERE, `${run.file}.gz`))).toString('utf8'));
  const pool = {};
  for (const a of report.attempts) {
    const c = (pool[a.condition] ??= { recall: 0, rr: 0, any: 0, all: 0, n: 0, q: 0 });
    c.q++;
    if (a.status !== 'completed' || !a.retrieval?.annotated) continue;
    c.n++; c.recall += a.retrieval.recall; c.rr += a.retrieval.reciprocalRank;
    c.any += a.retrieval.anyHit ? 1 : 0; c.all += a.retrieval.allHit ? 1 : 0;
  }
  for (const row of run.rows) {
    const c = pool[row.id];
    const mine = { recallAtK: c.recall / c.n, anyHit: c.any / c.n, allHit: c.all / c.n, mrr: c.rr / c.n };
    for (const [metric, value] of Object.entries(mine)) {
      checked++;
      if (Math.abs(value - row.metrics[metric]) >= 1e-9) { mismatches++; console.log(`MISMATCH K=${run.k} ${row.id} ${metric}: summary ${row.metrics[metric]} vs attempts ${value}`); }
    }
    if (c.q !== run.questions || c.n !== run.annotated) { mismatches++; console.log(`MISMATCH K=${run.k} ${row.id}: ${c.q} questions / ${c.n} labelled`); }
    (derived[row.id] ??= {})[run.k] = mine.recallAtK;
  }
}
console.log(`values checked=${checked} mismatches=${mismatches}`);
console.log('| LoCoMo retrieval recall | @5 | @10 | @20 |\n|---|---:|---:|---:|');
for (const [id, label] of [['hybrid', 'Mnemosyne (hybrid + rerank)'], ['system:mem0-oss', 'Mem0 OSS'], ['system:zep', 'Zep Cloud']]) {
  console.log(`| ${label} | ${[5, 10, 20].map(k => (derived[id][k] * 100).toFixed(1)).join(' | ')} |`);
}
process.exit(mismatches ? 1 : 0);
