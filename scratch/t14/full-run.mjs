// t14t15 lane copy of t1.4-temporal-routing/probes/full-run.mjs, repointed at this
// clone's own dist/ and benchmarks/data/. One slice of conversations at a time;
// nothing is backgrounded.
import { readFileSync, writeFileSync } from 'node:fs';
import { adaptLoCoMoCorpus, runCorpusBenchmark } from '../../dist/evaluation/corpus-benchmark.js';
import { createBundledEmbedder } from '../../dist/local/embedding/index.js';
import { asMemoryReranker, createBundledReranker } from '../../dist/local/reranking/index.js';

const [start, end, out] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]];
const bytes = readFileSync('benchmarks/data/locomo10.json');
const full = adaptLoCoMoCorpus(JSON.parse(bytes.toString('utf8')), { dataset: 'locomo10', revision: 'snap-research/locomo main', license: 'CC BY-NC 4.0', sourceUrl: 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json', sourceSha256: '0'.repeat(64), sourceBytes: bytes.byteLength }, { onMalformedEvidence: 'skip' });
const corpora = full.corpora.slice(start, end);
const ids = new Set(corpora.map(c => c.id));
const questions = full.questions.filter(q => ids.has(q.corpusId));
const keep = new Set(questions.map(q => q.id));
const dataset = { ...full, corpora, questions, labels: full.labels.filter(l => keep.has(l.questionId)) };
const model = createBundledEmbedder({ batchSize: 32 });
const reranker = createBundledReranker({ batchSize: 32 });
const began = Date.now();
const report = await runCorpusBenchmark(dataset, {
  topK: 10, includeBm25: true, hybridLexicalScoring: 'bm25', temporalRouting: true, corpusIndexBase: start,
  embedder: model.forPassages(), queryEmbedder: model.forQueries(),
  reranker: asMemoryReranker(reranker), rerankTopN: 50,
  maxEmbeddingCalls: 1_000_000, timeoutMs: 3_600_000,
});
model.close(); reranker.close();
writeFileSync(out, JSON.stringify({ slice: [start, end], complete: report.complete, attempts: report.attempts, ingestion: report.ingestion }));
console.log(`corpora ${start}..${end - 1}: ${questions.length} questions, complete=${report.complete}, ${((Date.now() - began) / 1000).toFixed(0)}s -> ${out}`);
