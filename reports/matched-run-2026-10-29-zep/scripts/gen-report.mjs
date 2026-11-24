// Builds summary.json + the tables for REPORT.md from the merged raw reports. Nothing typed by hand.
// Usage: node gen-report.mjs <outDir>  -> writes <outDir>/summary.json and <outDir>/tables.md
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const ROWS = [
  ['lexical', 'Mnemosyne zero-model overlap'], ['bm25', 'Mnemosyne zero-model BM25'],
  ['hybrid-norerank', 'Mnemosyne hybrid (dense+BM25 RRF)'], ['hybrid', 'Mnemosyne hybrid + rerank'],
  ['system:mem0-oss', 'Mem0 OSS (extraction off)'], ['system:zep', 'Zep Cloud (graph search, episodes)'],
];
const pct = v => v === null || v === undefined ? 'n/a' : (v * 100).toFixed(2);
const runs = [];
for (const k of [5, 10, 20]) {
  const file = join(dir, `locomo-k${k}.json`);
  if (!existsSync(file)) continue;
  const raw = readFileSync(file);
  const r = JSON.parse(raw);
  runs.push({ k, file: `locomo-k${k}.json`, sha256: createHash('sha256').update(raw).digest('hex'), bytes: raw.byteLength,
    questions: r.dataset.questions, corpora: r.dataset.corpora, annotated: r.summaries.bm25.annotatedQuestions, complete: r.complete,
    normalizedSha256: r.dataset.normalizedSha256, sourceSha256: r.dataset.sourceSha256, implementationSha256: r.runtime.implementationSha256,
    runtime: `${r.runtime.node} ${r.runtime.platform}`, durationSeconds: Number((r.durationMs / 1000).toFixed(1)), settings: r.settings,
    systems: (r.systems ?? []).map(s => ({ id: s.id, revision: s.revision, mode: s.mode, status: s.status, reason: s.reason ?? null, ingestSeconds: Number((s.ingestMilliseconds / 1000).toFixed(1)) })),
    rows: ROWS.map(([id, label]) => ({ id, label, s: r.summaries[id] ?? null })) });
}
writeFileSync(join(dir, 'summary.json'), JSON.stringify({ generatedFrom: dir, runs: runs.map(run => ({ ...run, rows: run.rows.map(x => ({ id: x.id, label: x.label,
  metrics: x.s && { recallAtK: x.s.meanRecall, anyHit: x.s.anyHitRate, allHit: x.s.allHitRate, mrr: x.s.mrr, p95RetrievalMs: x.s.p95RetrievalMs, questions: x.s.questions, completed: x.s.completed, errors: x.s.errors, annotatedQuestions: x.s.annotatedQuestions } })) })) }, null, 2) + '\n');

const out = [];
const get = (run, id) => run.rows.find(x => x.id === id).s;
out.push('| System | ' + runs.map(r => `recall@${r.k}`).join(' | ') + ' |', '|---|' + runs.map(() => '---:').join('|') + '|');
for (const [id, label] of ROWS) out.push(`| ${label} | ${runs.map(r => pct(get(r, id)?.meanRecall)).join(' | ')} |`);
for (const run of runs) {
  out.push('', `**K = ${run.k}${run.k === 10 ? ' (headline)' : ''}** — ${run.questions} questions, ${run.annotated} with positive evidence labels, complete=${run.complete}`, '',
    `| System | recall@${run.k} | anyHit | allHit | MRR | p95 retrieval | completed / errors |`, '|---|---:|---:|---:|---:|---:|---:|');
  for (const x of run.rows) out.push(x.s && x.s.meanRecall !== null
    ? `| ${x.label} | ${pct(x.s.meanRecall)} | ${pct(x.s.anyHitRate)} | ${pct(x.s.allHitRate)} | ${x.s.mrr.toFixed(4)} | ${Math.round(x.s.p95RetrievalMs)} ms | ${x.s.completed} / ${x.s.errors} |`
    : `| ${x.label} | not run | | | | | |`);
}
// Every head-to-head involving Zep, losses included, ordered by fixed roster, never by who won.
out.push('', '| Comparison | K | Zep | Other | Other system | Result |', '|---|---:|---:|---:|---|---|');
for (const run of runs) for (const [id, label] of [['hybrid', 'Mnemosyne hybrid + rerank'], ['hybrid-norerank', 'Mnemosyne hybrid, no rerank'], ['system:mem0-oss', 'Mem0 OSS (infer:false)'], ['bm25', 'Mnemosyne zero-model BM25']]) {
  const z = get(run, 'system:zep'), o = get(run, id);
  if (!z || z.meanRecall === null || !o) continue;
  for (const [metric, f, fmt, unit] of [['recall', s => s.meanRecall, v => (v * 100).toFixed(2), ''], ['MRR', s => s.mrr, v => v.toFixed(4), '']]) {
    const a = f(z), b = f(o), d = a - b;
    const res = Math.abs(d) < 1e-12 ? '**Tie**' : d > 0 ? `**Zep wins by ${fmt(Math.abs(d))}**` : `**${label.split(' (')[0]} wins by ${fmt(Math.abs(d))}**`;
    out.push(`| LoCoMo ${metric}@${run.k} | ${run.k} | ${fmt(a)} | ${fmt(b)} | ${label} | ${res} |`);
  }
}
out.push('', '| Raw file | bytes | SHA-256 |', '|---|---:|---|');
for (const f of readdirSync(dir).filter(n => /\.json(\.gz)?$/.test(n) && n !== 'summary.json').sort()) {
  const b = readFileSync(join(dir, f)); out.push(`| \`${f}\` | ${b.byteLength} | \`${createHash('sha256').update(b).digest('hex')}\` |`);
}
writeFileSync(join(dir, 'tables.md'), out.join('\n') + '\n');
console.log(out.join('\n'));
