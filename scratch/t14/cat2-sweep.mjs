// t14t15 lane copy of t1.4-temporal-routing/probes/cat2-sweep.mjs, repointed at
// this clone's own dist/. Measures the routing delta on ONE question category
// through the real benchmark code path (same ingestion, same embedder, same
// reranker as the full gate; only the question set is cut), which is far
// cheaper than scoring all 1986 questions when only the category matters.
import { readFileSync } from 'node:fs';
import { adaptLoCoMoCorpus, runCorpusBenchmark } from '../../dist/evaluation/corpus-benchmark.js';
import { createBundledEmbedder } from '../../dist/local/embedding/index.js';
import { asMemoryReranker, createBundledReranker } from '../../dist/local/reranking/index.js';

const category = process.argv[2] ?? 'locomo:2';
const convFilter = process.env.CONV_RANGE ? process.env.CONV_RANGE.split('-').map(Number) : null; // [start,end) ordinal filter, for tune/confirm split
const bytes = readFileSync('benchmarks/data/locomo10.json');
const full = adaptLoCoMoCorpus(JSON.parse(bytes.toString('utf8')), { dataset: 'locomo10', revision: 'x', license: 'CC BY-NC 4.0', sourceUrl: 'https://x', sourceSha256: '0'.repeat(64), sourceBytes: bytes.byteLength }, { onMalformedEvidence: 'skip' });
let dataset = full;
if (convFilter) {
  const [start, end] = convFilter;
  const corpora = full.corpora.slice(start, end);
  const ids = new Set(corpora.map(c => c.id));
  const qs = full.questions.filter(q => ids.has(q.corpusId) && q.category === category);
  const keep = new Set(qs.map(q => q.id));
  dataset = { ...full, corpora, questions: qs, labels: full.labels.filter(l => keep.has(l.questionId)) };
} else {
  const questions = full.questions.filter(q => q.category === category);
  const keep = new Set(questions.map(q => q.id));
  dataset = { ...full, questions, labels: full.labels.filter(l => keep.has(l.questionId)) };
}
const model = createBundledEmbedder({ batchSize: 32 });
const reranker = createBundledReranker({ batchSize: 32 });
const started = Date.now();
const report = await runCorpusBenchmark(dataset, {
  topK: 10, includeBm25: true, hybridLexicalScoring: 'bm25', temporalRouting: true,
  embedder: model.forPassages(), queryEmbedder: model.forQueries(),
  reranker: asMemoryReranker(reranker), rerankTopN: 50,
  maxEmbeddingCalls: 1_000_000, timeoutMs: 3_600_000,
});
model.close(); reranker.close();
const pct = (v) => v === null || v === undefined ? 'n/a' : (v * 100).toFixed(2);
const off = report.summaries.hybrid, on = report.summaries['hybrid-temporal'];
console.log(`${category}${convFilter ? ` (conv ${convFilter[0]}-${convFilter[1]-1})` : ' (all convs)'}: ${dataset.questions.length} questions, ${off.annotatedQuestions} annotated, ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log(`  routing off  recall@10=${pct(off.meanRecall)}  anyHit=${pct(off.anyHitRate)}  mrr=${off.mrr.toFixed(4)}`);
console.log(`  routing on   recall@10=${pct(on.meanRecall)}  anyHit=${pct(on.anyHitRate)}  mrr=${on.mrr.toFixed(4)}`);
console.log(`  DELTA recall@10 = ${((on.meanRecall - off.meanRecall) * 100).toFixed(2)} pts`);
if (process.env.DUMP) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.DUMP, JSON.stringify(report.attempts.filter(a => a.condition === 'hybrid' || a.condition === 'hybrid-temporal')));
}
