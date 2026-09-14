import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { adaptLoCoMoCorpus, runCorpusBenchmark, type CorpusCondition } from './corpus-benchmark.js';
import { createBundledEmbedder, type SyncMemoryEmbedder } from '../local/embedding/index.js';
import { asMemoryReranker, createBundledReranker, type SyncMemoryReranker } from '../local/reranking/index.js';

/**
 * LoCoMo retrieval evaluation of the local engine.
 *
 * Reports mean recall@10 for the zero-model lexical baselines and for hybrid
 * retrieval with the bundled local embedder, in one harness, on one corpus, so
 * the three numbers are comparable. The corpus is externally licensed and is not
 * redistributed by this package; `npm run benchmark:fetch` retrieves it.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = resolve(HERE, '..', '..', 'benchmarks', 'data', 'locomo10.json');

export async function locomoBenchmark(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    file: { type: 'string' }, out: { type: 'string' }, 'top-k': { type: 'string' },
    'min-recall': { type: 'string' }, 'max-questions': { type: 'string' }, lexical: { type: 'boolean' }, help: { type: 'boolean' },
    'no-rerank': { type: 'boolean' }, 'rerank-top-n': { type: 'string' },
  } });
  if (values.help) {
    console.log('node dist/evaluation/locomo-benchmark.js [--file CORPUS.json] [--out REPORT.json] [--top-k 10] [--min-recall 70] [--max-questions N] [--lexical] [--no-rerank] [--rerank-top-n 50]\n'
      + 'Defaults to benchmarks/data/locomo10.json, or $MNEMOSYNE_LOCOMO_PATH. --lexical skips both models and reports the zero-model baselines only.\n'
      + '--no-rerank measures the fused ranking without the cross-encoder, which is the T1.1 configuration.');
    return;
  }
  const file = resolve(values.file ?? process.env.MNEMOSYNE_LOCOMO_PATH ?? DEFAULT_CORPUS);
  if (!existsSync(file)) {
    console.error(`LoCoMo corpus not found at ${file}.\nRun "npm run benchmark:fetch" once with network access, or pass --file.\n`
      + 'The corpus is CC BY-NC 4.0 and is not redistributed by this package.');
    process.exitCode = 1; return;
  }
  const topK = Number(values['top-k'] ?? 10);
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > 100) throw new Error('--top-k must be between 1 and 100');
  const bytes = readFileSync(file);
  const dataset = adaptLoCoMoCorpus(JSON.parse(bytes.toString('utf8')) as unknown, {
    dataset: 'locomo10', revision: 'snap-research/locomo main', license: 'CC BY-NC 4.0',
    sourceUrl: 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json',
    sourceSha256: createHash('sha256').update(bytes).digest('hex'), sourceBytes: bytes.byteLength,
  // The published corpus contains a handful of unresolvable evidence identifiers.
  // They are dropped individually and counted in the report notices, never repaired.
  }, { onMalformedEvidence: 'skip' });

  let model: SyncMemoryEmbedder | undefined;
  if (!values.lexical) {
    try { model = createBundledEmbedder({ batchSize: 32 }); }
    catch (error) {
      console.error(`${error instanceof Error ? error.message : 'Local embedder unavailable'}\nReporting the zero-model baselines only.`);
    }
  }
  // The reranker applies to the hybrid condition only. Without it this run
  // measures exactly the pre-reranker configuration, which is what makes the two
  // numbers comparable.
  let reranker: SyncMemoryReranker | undefined;
  if (model && !values['no-rerank']) {
    try { reranker = createBundledReranker({ batchSize: 32 }); }
    catch (error) {
      console.error(`${error instanceof Error ? error.message : 'Local reranker unavailable'}\nReporting the fused ranking without reranking.`);
    }
  }
  const rerankTopN = Number(values['rerank-top-n'] ?? 50);
  if (!Number.isSafeInteger(rerankTopN) || rerankTopN < 1 || rerankTopN > 1000) throw new Error('--rerank-top-n must be between 1 and 1000');
  const started = Date.now();
  const report = await runCorpusBenchmark(dataset, {
    topK, includeBm25: true, hybridLexicalScoring: 'bm25',
    ...(values['max-questions'] ? { maxQuestions: Number(values['max-questions']) } : {}),
    // bge-v1.5 is trained with an asymmetric query convention, so queries and
    // passages are embedded differently into the same vector space.
    ...(model ? { embedder: model.forPassages(), queryEmbedder: model.forQueries() } : {}),
    ...(reranker ? { reranker: asMemoryReranker(reranker), rerankTopN } : {}),
    maxEmbeddingCalls: 1_000_000, timeoutMs: 3_600_000,
  });
  model?.close();
  reranker?.close();

  const percent = (value: number | null): string => value === null ? 'n/a' : (value * 100).toFixed(2);
  const line = (name: CorpusCondition, label: string): string => {
    const summary = report.summaries[name];
    if (!summary) return `  ${label.padEnd(30)} not run`;
    return `  ${label.padEnd(30)} recall@${topK}=${percent(summary.meanRecall).padStart(6)}  anyHit=${percent(summary.anyHitRate).padStart(6)}`
      + `  allHit=${percent(summary.allHitRate).padStart(6)}  mrr=${(summary.mrr ?? 0).toFixed(4)}  p95=${(summary.p95RetrievalMs ?? 0).toFixed(1)}ms`;
  };
  console.log(`LoCoMo retrieval evaluation — ${report.dataset.questions} questions, ${report.dataset.corpora} conversations, `
    + `${report.summaries.bm25?.annotatedQuestions ?? 0} with positive evidence labels`);
  console.log(`corpus sha256 ${report.dataset.sourceSha256}  normalized ${report.dataset.normalizedSha256}`);
  console.log(`runtime ${report.runtime.node} ${report.runtime.platform}  elapsed ${((Date.now() - started) / 1000).toFixed(1)}s  complete=${report.complete}`);
  if (report.embedding) console.log(`embedder ${report.embedding.model} (${report.embedding.dimensions}d, asymmetric=${report.embedding.asymmetric})`);
  console.log(`reranker ${reranker ? `${reranker.model} (top-${rerankTopN})` : 'disabled'}`);
  console.log(line('lexical', 'zero-model overlap'));
  console.log(line('bm25', 'zero-model BM25'));
  console.log(line('hybrid', reranker ? 'hybrid dense + BM25 + rerank' : 'hybrid dense + BM25 (RRF)'));
  for (const notice of report.notices) console.log(`note: ${notice}`);
  if (values.out) { writeFileSync(resolve(values.out), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); console.log(`report written to ${resolve(values.out)}`); }

  if (!report.complete) { console.error('Evaluation did not complete every attempt.'); process.exitCode = 1; return; }
  if (values['min-recall'] !== undefined) {
    const floor = Number(values['min-recall']);
    if (!Number.isFinite(floor) || floor < 0 || floor > 100) throw new Error('--min-recall must be between 0 and 100');
    const achieved = (report.summaries.hybrid ?? report.summaries.bm25)?.meanRecall;
    const scored = achieved === null || achieved === undefined ? 0 : achieved * 100;
    if (scored < floor) { console.error(`FAIL: mean recall@${topK} ${scored.toFixed(2)} is below the required ${floor}.`); process.exitCode = 1; return; }
    console.log(`PASS: mean recall@${topK} ${scored.toFixed(2)} meets the required ${floor}.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void locomoBenchmark().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'LoCoMo evaluation failed.'); process.exitCode = 1; });
}
