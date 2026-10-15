import { readFileSync } from 'node:fs';
import { summarizeAttempts } from '../../dist/evaluation/corpus-benchmark.js';
const slices = process.argv.slice(2);
if (!slices.length) { console.error('usage: node full-merge.mjs <part1.json> [part2.json ...]'); process.exit(2); }
const attempts = slices.flatMap(f => JSON.parse(readFileSync(f, 'utf8')).attempts);
const pct = v => v === null || v === undefined ? '   n/a' : (v * 100).toFixed(2).padStart(6);
const conditions = [...new Set(attempts.map(a => a.condition))];
console.log(`merged ${attempts.length} attempts over ${new Set(attempts.map(a => a.questionId)).size} questions`);
for (const c of conditions) {
  const s = summarizeAttempts(attempts.filter(a => a.condition === c));
  console.log(`  ${c.padEnd(16)} recall@10=${pct(s.meanRecall)}  anyHit=${pct(s.anyHitRate)}  allHit=${pct(s.allHitRate)}  mrr=${(s.mrr ?? 0).toFixed(4)}  annotated=${s.annotatedQuestions}`);
}
const cat = (c, k) => summarizeAttempts(attempts.filter(a => a.condition === c && a.category === k));
console.log('per-category recall@10, routing off -> on');
for (const k of [...new Set(attempts.map(a => a.category))].sort()) {
  const off = cat('hybrid', k), on = cat('hybrid-temporal', k);
  const d = off.meanRecall === null || on.meanRecall === null ? null : (on.meanRecall - off.meanRecall) * 100;
  console.log(`  ${k.padEnd(10)} [${String(off.annotatedQuestions).padStart(4)}]  ${pct(off.meanRecall)} -> ${pct(on.meanRecall)}  ${d === null ? 'n/a' : (d >= 0 ? '+' : '') + d.toFixed(2)}`);
}
// Overall-floor condition the harness does not print (BRIEF requires overall recall@10 >= 73.07, and
// the ORIGINAL build-brief gate: overall must not drop more than 0.5 pts vs baseline 73.57).
const overallOff = summarizeAttempts(attempts.filter(a => a.condition === 'hybrid'));
const overallOn = summarizeAttempts(attempts.filter(a => a.condition === 'hybrid-temporal'));
const floor = 73.07;
const overallOnPct = (overallOn.meanRecall ?? 0) * 100;
const overallOffPct = (overallOff.meanRecall ?? 0) * 100;
console.log(`OVERALL FLOOR CHECK: hybrid-temporal recall@10 = ${overallOnPct.toFixed(2)} (floor ${floor}, baseline-0.5=${(73.57-0.5).toFixed(2)}) -> ${overallOnPct >= floor ? 'PASS' : 'FAIL'} (job-brief floor), drop-vs-baseline ${(overallOffPct - overallOnPct).toFixed(2)}pts -> ${(overallOffPct - overallOnPct) <= 0.5 ? 'PASS' : 'FAIL'} (build-brief -0.5 floor)`);
