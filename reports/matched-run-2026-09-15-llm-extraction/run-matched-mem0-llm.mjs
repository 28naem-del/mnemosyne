// The authorized paid competitor rerun.
//
// The shipped CLI refuses `--mem0-extraction llm` on purpose
// (`src/evaluation/matched-benchmark.ts:254`: "needs an explicit LLM configuration
// and a spend decision; it is not wired to any key by this command"). That guard is
// about the COMMAND, not the adapter: `createMem0Factory` takes an explicit
// `llm: { provider, config, label }` and the harness scores it like any other system.
// This runner supplies exactly that configuration — the authorized provider, the
// authorized model, the authorized key, read from the process env and never printed —
// and otherwise reproduces the CLI's run options verbatim so the rows stay comparable:
// same topK, same chunkBytes, same packing budget, same scorer, one process.
//
// Both Mem0 configurations run side by side on the identical chunk set, so the cost
// of extraction is measured rather than inferred.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  file: { type: 'string' }, out: { type: 'string' }, 'top-k': { type: 'string' },
  dist: { type: 'string' }, competitors: { type: 'string' }, model: { type: 'string' }, label: { type: 'string' },
} });
const DIST = resolve(values.dist ?? 'dist');
const COMPETITORS = resolve(values.competitors ?? 'benchmarks/competitors');
const topK = Number(values['top-k'] ?? 10);
const MODEL = values.model ?? 'openai/gpt-4o-mini';
const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('OPENROUTER_API_KEY not in env'); process.exit(2); }

const { adaptLoCoMoCorpus, runCorpusBenchmark } = await import(join(DIST, 'evaluation/corpus-benchmark.js'));
const { createMem0Factory } = await import(join(DIST, 'evaluation/matched-mem0.js'));
const { createZepFactory } = await import(join(DIST, 'evaluation/matched-zep.js'));
const { resolveCompetitorModule } = await import(join(DIST, 'evaluation/matched-resolve.js'));
const { createBundledEmbedder } = await import(join(DIST, 'local/embedding/index.js'));
const { asMemoryReranker, createBundledReranker } = await import(join(DIST, 'local/reranking/index.js'));

const file = resolve(values.file);
if (!existsSync(file)) { console.error(`corpus absent at ${file}`); process.exit(3); }
const raw = readFileSync(file);
const sha256 = createHash('sha256').update(raw).digest('hex');
const dataset = adaptLoCoMoCorpus(JSON.parse(raw.toString('utf8')), {
  dataset: 'locomo10', revision: 'snap-research/locomo main', license: 'CC BY-NC 4.0',
  sourceUrl: 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json',
  sourceSha256: sha256, sourceBytes: raw.byteLength,
}, { onMalformedEvidence: 'skip' });

const embedder = createBundledEmbedder({ batchSize: 32 });
const reranker = createBundledReranker({ batchSize: 32 });
const mem0Module = resolveCompetitorModule(COMPETITORS, 'mem0ai', './oss');
if (!mem0Module.resolved) { console.error(`mem0ai unresolved: ${mem0Module.reason}`); process.exit(4); }
const moduleOptions = { moduleSpecifier: mem0Module.url, versionSpecifier: join(mem0Module.directory, 'package.json') };
const injected = { embedder: embedder.forPassages(), queryEmbedder: embedder.forQueries() };

const controller = new AbortController();
const outcomes = [];
const off = await createMem0Factory({ ...injected, ...moduleOptions }).resolve({ seed: 0, signal: controller.signal });
outcomes.push({ id: 'mem0-oss', ...off });
const llm = await createMem0Factory({ ...injected, ...moduleOptions, extraction: 'llm',
  llm: { provider: 'openai', config: { apiKey: key, baseURL: 'https://openrouter.ai/api/v1', model: MODEL }, label: values.label ?? `openrouter/${MODEL}` },
}).resolve({ seed: 0, signal: controller.signal });
// Same adapter, different configuration, so it needs its own condition key. The
// mode string it prints still names the extraction path, as the harness requires.
outcomes.push({ id: 'mem0-oss-llm', ...(llm.available ? { available: true, system: { ...llm.system, id: 'mem0-oss-llm' } } : llm) });
const zepFactory = createZepFactory({ baseDir: COMPETITORS });
outcomes.push({ id: zepFactory.id, ...(await zepFactory.resolve({ seed: 0, signal: controller.signal })) });

const systems = outcomes.flatMap(outcome => outcome.available ? [outcome.system] : []);
const started = Date.now();
const report = await runCorpusBenchmark(dataset, {
  topK, includeBm25: true, hybridLexicalScoring: 'bm25', includeHybridWithoutRerank: true,
  embedder: embedder.forPassages(), queryEmbedder: embedder.forQueries(),
  reranker: asMemoryReranker(reranker), rerankTopN: 50,
  systems, maxEmbeddingCalls: 1_000_000, maxEmbeddingInputBytes: 2_147_483_647,
  timeoutMs: 3_600_000, systemIngestTimeoutMs: 3_600_000,
});
embedder.close(); reranker.close();

const percent = (value) => value === null || value === undefined ? 'n/a' : (value * 100).toFixed(2);
const row = (label, mode, summary) => {
  if (!summary || summary.meanRecall === null) { console.log(`  ${label.padEnd(34)} not run — no scored attempts`); return; }
  console.log(`  ${label.padEnd(34)} recall@${topK}=${percent(summary.meanRecall).padStart(6)}  anyHit=${percent(summary.anyHitRate).padStart(6)}`
    + `  allHit=${percent(summary.allHitRate).padStart(6)}  mrr=${(summary.mrr ?? 0).toFixed(4)}  p95=${(summary.p95RetrievalMs ?? 0).toFixed(1)}ms  [${mode}]`);
};
console.log(`\n=== MATCHED RUN (paid rerun) — LoCoMo (locomo10) slice ===`);
console.log(`${report.dataset.questions} questions, ${report.dataset.corpora} corpora, ${report.summaries.bm25?.annotatedQuestions ?? 0} with positive evidence labels`);
console.log(`corpus sha256 ${sha256} (${raw.byteLength} bytes)  normalized ${report.dataset.normalizedSha256}`);
console.log(`runtime ${report.runtime.node} ${report.runtime.platform}  elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`identical for every row: K=${topK}  maxContextUnits=${report.settings.maxContextUnits} (${report.settings.accountingId})  chunkBytes=${report.settings.chunkBytes}`);
console.log(`reader/judge: none — retrieval coverage, not answer accuracy (calls: generation=${report.calls.generation}, judge=${report.calls.judge})`);
for (const entry of [['lexical', 'Mnemosyne zero-model overlap'], ['bm25', 'Mnemosyne zero-model BM25'],
  ['hybrid-norerank', 'Mnemosyne hybrid (dense+BM25 RRF)'], ['hybrid', 'Mnemosyne hybrid + rerank']]) {
  row(entry[1], entry[0], report.summaries[entry[0]]);
}
for (const outcome of outcomes) {
  if (!outcome.available) { console.log(`  ${outcome.id.padEnd(34)} not run — ${outcome.reason}`); continue; }
  const declared = report.systems?.find(system => system.id === outcome.system.id);
  if (declared?.status === 'ingest-failed') { console.log(`  ${outcome.system.id.padEnd(34)} not run — ${declared.reason}`); continue; }
  row(outcome.system.id, outcome.system.mode, report.summaries[`system:${outcome.system.id}`]);
}
for (const system of report.systems ?? []) console.log(`  ingest ${system.id}: ${(system.ingestMilliseconds / 1000).toFixed(1)}s${system.reason ? ` — ${system.reason}` : ''}`);
for (const notice of report.notices) console.log(`note: ${notice}`);
if (values.out) {
  mkdirSync(resolve(values.out, '..'), { recursive: true, mode: 0o700 });
  // The key lives only in the adapter's closure; the report carries mode strings, never configuration.
  writeFileSync(resolve(values.out), `${JSON.stringify({ ...report, matched: { outcomes: outcomes.map(outcome => ({ id: outcome.id, available: Boolean(outcome.available), mode: outcome.system?.mode ?? null, reason: outcome.reason ?? null })) } }, null, 2)}\n`, { mode: 0o600 });
  console.log(`raw report -> ${resolve(values.out)}`);
}
