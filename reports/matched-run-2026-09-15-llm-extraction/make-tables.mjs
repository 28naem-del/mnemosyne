#!/usr/bin/env node
// Regenerates every table in ../matched-run-2026-09-15-llm-extraction.md from the raw
// reports in this directory. The published tables are this script's output, pasted; run
// it to check that no number in the report was typed by hand.
//
//   node reports/matched-run-2026-09-15-llm-extraction/make-tables.mjs
//
// Reads the gzipped reports directly, so no gunzip step is needed.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(gunzipSync(readFileSync(join(here, name))).toString('utf8'));

const ROWS = [
  ['Mnemosyne zero-model overlap', 'lexical'],
  ['Mnemosyne zero-model BM25', 'bm25'],
  ['Mnemosyne hybrid (dense+BM25 RRF)', 'hybrid-norerank'],
  ['Mnemosyne hybrid + rerank', 'hybrid'],
  ['Mem0 OSS (extraction off)', 'system:mem0-oss'],
  ['Mem0 OSS, LLM extraction (infer:true)', 'system:mem0-oss-llm'],
];

const pct = (v) => (v * 100).toFixed(2);
const ms = (v) => `${v.toFixed(1)} ms`;
const secs = (v) => `${(v / 1000).toFixed(1)} s`;

// `source` is make-parts.mjs's own printed output for that part. Each part file holds a
// single conversation, so the harness re-indexes it as `conversation:0` in both reports;
// the source conversation index lives here and nowhere in the raw report.
const parts = [
  { label: 'A', file: 'locomo-partA-k10.json.gz', source: 'LoCoMo conversation 0, 10 of 19 sessions' },
  { label: 'B', file: 'locomo-partB-k10.json.gz', source: 'LoCoMo conversation 1, 11 of 19 sessions' },
];

const loaded = parts.map((part) => ({ ...part, report: load(part.file) }));

for (const { label, source, report } of loaded) {
  const ingest = new Map(report.systems.map((s) => [`system:${s.id}`, s.ingestMilliseconds]));
  const any = report.summaries.hybrid;
  const turns = report.ingestion.reduce((sum, i) => sum + i.turns, 0);
  console.log(`## Part ${label} — ${source}, ${turns} turns, ` +
    `${any.questions} questions (${any.annotatedQuestions} with positive evidence)`);
  console.log();
  console.log('| System | recall@10 | anyHit | allHit | MRR | p95 retrieval | ingest |');
  console.log('|---|---:|---:|---:|---:|---:|---:|');
  for (const [name, key] of ROWS) {
    const s = report.summaries[key];
    const ing = ingest.has(key) ? secs(ingest.get(key)) : '—';
    console.log(`| ${name} | ${pct(s.meanRecall)} | ${pct(s.anyHitRate)} | ${pct(s.allHitRate)} | ` +
      `${s.mrr.toFixed(4)} | ${ms(s.p95RetrievalMs)} | ${ing} |`);
  }
  console.log('| Zep / Graphiti | not run | not run | not run | not run | not run | not run |');
  console.log();
}

console.log('## Where we lose\n');
console.log('| Comparison | Part | Mem0 | Mnemosyne | Mnemosyne config compared | Result |');
console.log('|---|---|---:|---:|---|---|');
const compare = (metric, fmt, label, mem0Key, ourKey, ourName) => {
  for (const { label: part, report } of loaded) {
    const mem0 = report.summaries[mem0Key][metric];
    const ours = report.summaries[ourKey][metric];
    const delta = Math.abs(mem0 - ours);
    const who = mem0 > ours ? '**Mem0 wins' : ours > mem0 ? 'Mnemosyne wins' : 'Tie';
    const margin = who === 'Tie' ? '**Tie**' : `${who} by ${fmt(delta)}${mem0 > ours ? '**' : ''}`;
    console.log(`| ${label} | ${part} | ${fmt(mem0)} | ${fmt(ours)} | ${ourName} | ${margin} |`);
  }
};
compare('meanRecall', pct, 'recall@10 vs LLM extraction', 'system:mem0-oss-llm', 'hybrid-norerank', 'hybrid, no rerank');
compare('meanRecall', pct, 'recall@10 vs extraction off', 'system:mem0-oss', 'hybrid-norerank', 'hybrid, no rerank');
compare('meanRecall', pct, 'recall@10 vs LLM extraction', 'system:mem0-oss-llm', 'hybrid', 'hybrid **+ rerank**');
compare('meanRecall', pct, 'recall@10 vs extraction off', 'system:mem0-oss', 'hybrid', 'hybrid **+ rerank**');
compare('mrr', (v) => v.toFixed(4), 'MRR vs LLM extraction', 'system:mem0-oss-llm', 'hybrid', 'hybrid **+ rerank**');
console.log();

console.log('## Extraction on vs off, inside Mem0\n');
console.log('| Part | extraction off | LLM extraction | Delta | Ingest off | Ingest LLM | Slowdown |');
console.log('|---|---:|---:|---:|---:|---:|---:|');
for (const { label, report } of loaded) {
  const off = report.summaries['system:mem0-oss'];
  const llm = report.summaries['system:mem0-oss-llm'];
  const ing = new Map(report.systems.map((s) => [s.id, s.ingestMilliseconds]));
  const d = (llm.meanRecall - off.meanRecall) * 100;
  console.log(`| ${label} | ${pct(off.meanRecall)} | ${pct(llm.meanRecall)} | ${d >= 0 ? '+' : ''}${d.toFixed(2)} | ` +
    `${secs(ing.get('mem0-oss'))} | ${secs(ing.get('mem0-oss-llm'))} | ` +
    `${(ing.get('mem0-oss-llm') / ing.get('mem0-oss')).toFixed(0)}x |`);
}
console.log();

console.log('## Mode strings, exactly as the harness recorded them\n');
for (const { label, report } of loaded) {
  console.log(`Part ${label}:\n`);
  console.log('```');
  for (const s of report.systems) console.log(`${s.id}  ${s.mode}`);
  console.log('```\n');
}

console.log('## Corpus digests and generative call counts\n');
console.log('| Part | Normalized corpus SHA256 | Questions | generation | judge |');
console.log('|---|---|---:|---:|---:|');
for (const { label, report } of loaded) {
  console.log(`| ${label} | \`${report.dataset.normalizedSha256}\` | ` +
    `${report.summaries.hybrid.questions} | ${report.calls.generation} | ${report.calls.judge} |`);
}
console.log();
console.log('Per-chunk extraction rate:');
for (const { label, report } of loaded) {
  const chunks = report.ingestion.reduce((sum, i) => sum + i.chunks, 0);
  const llm = report.systems.find((s) => s.id === 'mem0-oss-llm').ingestMilliseconds;
  console.log(`  part ${label}: ${chunks} chunks, ${(llm / chunks / 1000).toFixed(2)} s/chunk`);
}
