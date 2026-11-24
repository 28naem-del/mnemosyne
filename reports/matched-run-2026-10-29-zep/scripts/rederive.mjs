// Independent re-derivation: recomputes published values straight from the raw per-conversation
// part JSONs (attempt records only, ignoring every stored summary), then compares with summary.json.
// Usage: node rederive.mjs <partsDir> <summary.json>
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [dir, summaryPath] = process.argv.slice(2);
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
const pool = {}; // k -> condition -> {recall[], rr[], any, all, n, q}
for (const f of readdirSync(dir).filter(n => /^locomo-k\d+-part\d+\.json$/.test(n)).sort()) {
  const k = Number(f.match(/-k(\d+)-/)[1]);
  const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  for (const a of r.attempts) {
    const c = ((pool[k] ??= {})[a.condition] ??= { recall: 0, rr: 0, any: 0, all: 0, n: 0, q: 0 });
    c.q++;
    if (a.status !== 'completed' || !a.retrieval?.annotated) continue;
    c.n++; c.recall += a.retrieval.recall; c.rr += a.retrieval.reciprocalRank;
    c.any += a.retrieval.anyHit ? 1 : 0; c.all += a.retrieval.allHit ? 1 : 0;
  }
}
const picks = [
  [10, 'system:zep', 'recallAtK'], [10, 'hybrid', 'recallAtK'], [10, 'system:mem0-oss', 'recallAtK'], [10, 'hybrid-norerank', 'recallAtK'],
  [5, 'system:zep', 'recallAtK'], [5, 'hybrid', 'recallAtK'], [20, 'system:zep', 'recallAtK'], [20, 'hybrid', 'recallAtK'],
  [10, 'system:zep', 'mrr'], [20, 'system:mem0-oss', 'anyHit'],
];
let mismatches = 0;
console.log('| # | K | condition | metric | published (summary.json) | re-derived from parts | match |');
console.log('|---:|---:|---|---|---:|---:|---|');
picks.forEach(([k, cond, metric], i) => {
  const run = summary.runs.find(r => r.k === k);
  const pub = run.rows.find(x => x.id === cond).metrics[metric];
  const c = pool[k][cond];
  const mine = { recallAtK: c.recall / c.n, mrr: c.rr / c.n, anyHit: c.any / c.n, allHit: c.all / c.n }[metric];
  const ok = Math.abs(pub - mine) < 1e-9;
  if (!ok) mismatches++;
  console.log(`| ${i + 1} | ${k} | ${cond} | ${metric} | ${pub.toFixed(6)} | ${mine.toFixed(6)} (n=${c.n}/${c.q}) | ${ok ? 'match' : 'MISMATCH'} |`);
});
console.log(`\nmismatches=${mismatches}`);
process.exit(mismatches ? 1 : 0);
