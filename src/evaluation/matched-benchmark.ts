import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createBundledEmbedder, type SyncMemoryEmbedder } from '../local/embedding/index.js';
import { asMemoryReranker, createBundledReranker, type SyncMemoryReranker } from '../local/reranking/index.js';
import { adaptLoCoMoCorpus, adaptLongMemEvalCorpus, runCorpusBenchmark } from './corpus-benchmark.js';
import type { BenchmarkConditionId, CorpusBenchmarkReport, CorpusDataset, CorpusSummary } from './corpus-types.js';
import { createMem0Factory } from './matched-mem0.js';
import { createZepFactory } from './matched-zep.js';
import { resolveCompetitorModule } from './matched-resolve.js';
import type { MatchedSystem, MatchedSystemFactory } from './matched-types.js';

/**
 * The matched run.
 *
 * One corpus, one chunking, one K, one packing budget, one evidence scorer, one
 * process — and several memory systems inside it. The entire point is that the
 * rows of the resulting table differ only in which passages came back, so the
 * table is a comparison rather than a collection of separately-reported numbers.
 *
 * Three rules this file exists to enforce:
 *
 * - **A vendor's self-reported number is never printed.** Every number here was
 *   produced by this process. A system that could not run prints
 *   `not run — <reason>` in the cell where its score would have been.
 * - **Losses are printed exactly like wins.** There is no filtering, ordering or
 *   formatting that depends on who won; rows are ordered by the fixed roster
 *   below, not by score.
 * - **Every row carries its mode.** A configuration that changes what a number
 *   means — an extraction path switched off, a substituted embedder — is in the
 *   row, not in a footnote.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const DATA = join(REPO, 'benchmarks', 'data');
const COMPETITORS = join(REPO, 'benchmarks', 'competitors');

const LOCOMO = {
  file: 'locomo10.json', label: 'LoCoMo (locomo10)',
  provenance: { dataset: 'locomo10', revision: 'snap-research/locomo main', license: 'CC BY-NC 4.0',
    sourceUrl: 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json' },
};
const LONGMEMEVAL = {
  file: 'longmemeval_s_cleaned.json', label: 'LongMemEval-S (cleaned)',
  provenance: { dataset: 'xiaowu0162/longmemeval-cleaned', revision: '98d7416c24c778c2fee6e6f3006e7a073259d48f', license: 'MIT per dataset card',
    sourceUrl: 'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json' },
};

/** The fixed row order of every published table. Deliberately not score order. */
const MNEMOSYNE_ROWS: { condition: BenchmarkConditionId; label: string }[] = [
  { condition: 'lexical', label: 'Mnemosyne zero-model overlap' },
  { condition: 'bm25', label: 'Mnemosyne zero-model BM25' },
  { condition: 'hybrid-norerank', label: 'Mnemosyne hybrid (dense+BM25 RRF)' },
  { condition: 'hybrid', label: 'Mnemosyne hybrid + rerank' },
];

interface SystemOutcome { id: string; factory: MatchedSystemFactory; system: MatchedSystem | null; reason?: string }

const percent = (value: number | null | undefined): string => value === null || value === undefined ? 'n/a' : (value * 100).toFixed(2);

function loadCorpus(kind: 'locomo' | 'longmemeval', file: string, questionLimit?: number): { dataset: CorpusDataset; sha256: string; bytes: number } {
  const raw = readFileSync(file);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const parsed = JSON.parse(raw.toString('utf8')) as unknown;
  const provenance = { ...(kind === 'locomo' ? LOCOMO : LONGMEMEVAL).provenance, sourceSha256: sha256, sourceBytes: raw.byteLength };
  if (kind === 'locomo') return { dataset: adaptLoCoMoCorpus(parsed, provenance, { onMalformedEvidence: 'skip' }), sha256, bytes: raw.byteLength };
  // The published cleaned release carries same-day history sessions that the
  // strict instant parser rejects, so the documented question-day policy is used
  // and named in the report. Nothing is repaired.
  const sliced = Array.isArray(parsed) && questionLimit !== undefined ? parsed.slice(0, questionLimit) : parsed;
  return { dataset: adaptLongMemEvalCorpus(sliced, provenance, { timestampPolicy: 'question-day' }), sha256, bytes: raw.byteLength };
}

/**
 * Takes the first N corpora and the first M of their questions, in source order.
 * A slice is a smaller experiment, not a different one: every system sees exactly
 * the same reduced corpus, and the counts printed with the table are the sliced
 * counts, so a bounded run is never reported as a full-dataset result.
 */
function sliceCorpus(dataset: CorpusDataset, maxCorpora?: number, maxQuestions?: number): CorpusDataset {
  const corpora = maxCorpora !== undefined ? dataset.corpora.slice(0, maxCorpora) : dataset.corpora;
  const ids = new Set(corpora.map(corpus => corpus.id));
  let questions = dataset.questions.filter(question => ids.has(question.corpusId));
  if (maxQuestions !== undefined) questions = questions.slice(0, maxQuestions);
  const kept = new Set(questions.map(question => question.id));
  // A corpus left with no questions would still be ingested and embedded for
  // nothing, and would inflate every system's ingestion time.
  const used = new Set(questions.map(question => question.corpusId));
  return { ...dataset, corpora: corpora.filter(corpus => used.has(corpus.id)), questions,
    labels: dataset.labels.filter(label => kept.has(label.questionId)) };
}

async function resolveSystems(requested: string[], embedder: SyncMemoryEmbedder | undefined, extraction: 'off' | 'llm', signal: AbortSignal): Promise<SystemOutcome[]> {
  const mem0Module = resolveCompetitorModule(COMPETITORS, 'mem0ai', './oss');
  const factories: MatchedSystemFactory[] = [
    createMem0Factory({
      ...(embedder ? { embedder: embedder.forPassages(), queryEmbedder: embedder.forQueries() } : {}),
      extraction,
      ...(mem0Module.resolved ? { moduleSpecifier: mem0Module.url, versionSpecifier: join(mem0Module.directory, 'package.json') } : {}),
      ...(mem0Module.resolved ? {} : { moduleSpecifier: `__unresolved__${mem0Module.reason}` }),
    }),
    createZepFactory({ baseDir: COMPETITORS }),
  ];
  const outcomes: SystemOutcome[] = [];
  for (const factory of factories) {
    if (requested.length && !requested.includes(factory.id)) continue;
    // A resolution wall must never abort the run: every other system, and every
    // one of our own conditions, still has to be measured and published.
    if (factory.id === 'mem0-oss' && !mem0Module.resolved) { outcomes.push({ id: factory.id, factory, system: null, reason: mem0Module.reason }); continue; }
    let resolution;
    try { resolution = await factory.resolve({ seed: 0, signal }); }
    catch (error) { outcomes.push({ id: factory.id, factory, system: null, reason: error instanceof Error ? error.message : 'resolution threw' }); continue; }
    outcomes.push(resolution.available ? { id: factory.id, factory, system: resolution.system } : { id: factory.id, factory, system: null, reason: resolution.reason });
  }
  return outcomes;
}

function printTable(report: CorpusBenchmarkReport, outcomes: SystemOutcome[], topK: number): string[] {
  const lines: string[] = [];
  const row = (label: string, mode: string, summary: CorpusSummary | undefined, note?: string): void => {
    if (!summary || summary.meanRecall === null) { lines.push(`  ${label.padEnd(34)} not run — ${note ?? 'no scored attempts'}`); return; }
    lines.push(`  ${label.padEnd(34)} recall@${topK}=${percent(summary.meanRecall).padStart(6)}  anyHit=${percent(summary.anyHitRate).padStart(6)}`
      + `  allHit=${percent(summary.allHitRate).padStart(6)}  mrr=${(summary.mrr ?? 0).toFixed(4)}  p95=${(summary.p95RetrievalMs ?? 0).toFixed(1)}ms`
      + `  [${mode}]`);
  };
  for (const entry of MNEMOSYNE_ROWS) row(entry.label, mnemosyneMode(report, entry.condition), report.summaries[entry.condition]);
  for (const outcome of outcomes) {
    const declared = report.systems?.find(system => system.id === outcome.id);
    if (!outcome.system) { lines.push(`  ${outcome.id.padEnd(34)} not run — ${outcome.reason ?? 'unavailable'}`); continue; }
    if (declared?.status === 'ingest-failed') { lines.push(`  ${outcome.id.padEnd(34)} not run — ${declared.reason ?? 'ingestion failed'}`); continue; }
    row(outcome.id, outcome.system.mode, report.summaries[`system:${outcome.id}`], declared?.reason);
  }
  return lines;
}

function mnemosyneMode(report: CorpusBenchmarkReport, condition: BenchmarkConditionId): string {
  const model = report.embedding ? `${report.embedding.model.split('|')[1] ?? report.embedding.model} (${report.embedding.dimensions}d)` : 'no embedder';
  if (condition === 'lexical') return 'zero-model, token overlap, no model of any kind';
  if (condition === 'bm25') return 'zero-model, BM25, no model of any kind';
  if (condition === 'hybrid-norerank') return `hybrid dense+BM25 RRF, embedder=${model}, reranker=off`;
  return `hybrid dense+BM25 RRF + cross-encoder, embedder=${model}, reranker=${report.settings.reranker === 'enabled' ? `on(top-${report.settings.rerankTopN})` : 'off'}`;
}

export async function matchedBenchmark(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    corpus: { type: 'string' }, systems: { type: 'string' }, 'top-k': { type: 'string' },
    'max-corpora': { type: 'string' }, 'max-questions': { type: 'string' }, out: { type: 'string' },
    'mem0-extraction': { type: 'string' }, 'no-rerank': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log(`node dist/evaluation/matched-benchmark.js [options]

  --corpus locomo|longmemeval|both   corpora to score (default locomo)
  --systems mem0-oss,zep|none        competitors to include (default: all resolvable)
  --top-k N                          K, identical for every system (default 10)
  --max-corpora N                    score only the first N conversations/haystacks
  --max-questions N                  bound the question count
  --out DIR                          write one raw JSON report per corpus
  --mem0-extraction off|llm          Mem0 write path. off = no LLM, free, offline (default)
  --no-rerank                        drop our reranked condition from the table
  --dry-run                          tiny slice, for proving the wiring

Every system runs in one process on one chunk set with one packing budget and one
scorer. Competitor SDKs are installed separately: npm run benchmark:matched:install`);
    return;
  }
  const corpus = values.corpus ?? 'locomo';
  if (!['locomo', 'longmemeval', 'both'].includes(corpus)) throw new Error('--corpus must be locomo, longmemeval or both');
  const extraction = (values['mem0-extraction'] ?? 'off') as 'off' | 'llm';
  if (!['off', 'llm'].includes(extraction)) throw new Error('--mem0-extraction must be off or llm');
  if (extraction === 'llm') throw new Error('--mem0-extraction llm needs an explicit LLM configuration and a spend decision; it is not wired to any key by this command.');
  const dry = values['dry-run'] === true;
  const topK = Number(values['top-k'] ?? 10);
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > 100) throw new Error('--top-k must be between 1 and 100');
  const maxCorpora = values['max-corpora'] !== undefined ? Number(values['max-corpora']) : dry ? 2 : undefined;
  const maxQuestions = values['max-questions'] !== undefined ? Number(values['max-questions']) : dry ? 20 : undefined;
  const requested = (values.systems ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  const noSystems = requested.length === 1 && requested[0] === 'none';

  let embedder: SyncMemoryEmbedder | undefined, reranker: SyncMemoryReranker | undefined;
  try { embedder = createBundledEmbedder({ batchSize: 32 }); }
  catch (error) { console.error(`${error instanceof Error ? error.message : 'Local embedder unavailable'}\nRun "npm run setup:embedder". Reporting zero-model rows only.`); }
  if (embedder && !values['no-rerank']) {
    try { reranker = createBundledReranker({ batchSize: 32 }); }
    catch (error) { console.error(`${error instanceof Error ? error.message : 'Local reranker unavailable'}\nRun "npm run setup:reranker". Reporting the fused ranking only.`); }
  }

  const controller = new AbortController();
  const outcomes = noSystems ? [] : await resolveSystems(requested.filter(id => id !== 'none'), embedder, extraction, controller.signal);
  const systems = outcomes.flatMap(outcome => outcome.system ? [outcome.system] : []);

  const chosen: ('locomo' | 'longmemeval')[] = corpus === 'both' ? ['locomo', 'longmemeval'] : [corpus as 'locomo' | 'longmemeval'];
  const outDir = values.out ? resolve(values.out) : undefined;
  if (outDir) mkdirSync(outDir, { recursive: true, mode: 0o700 });
  let failed = false;

  for (const kind of chosen) {
    const spec = kind === 'locomo' ? LOCOMO : LONGMEMEVAL;
    const file = join(DATA, spec.file);
    if (!existsSync(file)) {
      console.log(`\n${spec.label}: not run — corpus absent at ${file}. Fetch it with "npm run benchmark:fetch -- --corpus ${kind}".`);
      console.log(`  source ${spec.provenance.sourceUrl}\n  license ${spec.provenance.license}. It is not redistributed by this package.`);
      failed = true; continue;
    }
    const { dataset, sha256, bytes } = loadCorpus(kind, file, maxCorpora);
    // Slicing happens here, deterministically and in source order, rather than
    // through the runner's `maxQuestions` — which is an upper bound that rejects
    // an oversized corpus, not a sampler. The slice is recorded in the report so
    // a partial run can never be mistaken for a full one.
    const scoped = sliceCorpus(dataset, maxCorpora, maxQuestions);
    const started = Date.now();
    const report = await runCorpusBenchmark(scoped, {
      topK, includeBm25: true, hybridLexicalScoring: 'bm25', includeHybridWithoutRerank: true,
      ...(embedder ? { embedder: embedder.forPassages(), queryEmbedder: embedder.forQueries() } : {}),
      ...(reranker ? { reranker: asMemoryReranker(reranker), rerankTopN: 50 } : {}),
      ...(systems.length ? { systems } : {}),
      maxEmbeddingCalls: 1_000_000, maxEmbeddingInputBytes: 2_147_483_647, timeoutMs: 3_600_000, systemIngestTimeoutMs: 3_600_000,
    });

    console.log(`\n=== MATCHED RUN — ${spec.label} ===`);
    console.log(`${report.dataset.questions} questions, ${report.dataset.corpora} corpora, ${report.summaries.bm25?.annotatedQuestions ?? 0} with positive evidence labels`);
    console.log(`corpus sha256 ${sha256} (${bytes} bytes)  normalized ${report.dataset.normalizedSha256}`);
    console.log(`runtime ${report.runtime.node} ${report.runtime.platform}  elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`identical for every row: K=${topK}  maxContextUnits=${report.settings.maxContextUnits} (${report.settings.accountingId})  chunkBytes=${report.settings.chunkBytes}  envelope=corpus-v1`);
    console.log(`reader/judge: none — this is retrieval coverage, not answer accuracy (calls: generation=${report.calls.generation}, judge=${report.calls.judge})`);
    for (const line of printTable(report, outcomes, topK)) console.log(line);
    for (const system of report.systems ?? []) console.log(`  ingest ${system.id}: ${(system.ingestMilliseconds / 1000).toFixed(1)}s${system.reason ? ` — ${system.reason}` : ''}`);
    for (const notice of report.notices) console.log(`note: ${notice}`);

    if (outDir) {
      const target = join(outDir, `${kind}-k${topK}.json`);
      writeFileSync(target, `${JSON.stringify({ ...report, matched: { requested, outcomes: outcomes.map(outcome => ({ id: outcome.id, available: outcome.system !== null, mode: outcome.system?.mode ?? null, reason: outcome.reason ?? null, describes: outcome.factory.describe() })) } }, null, 2)}\n`, { mode: 0o600 });
      console.log(`raw report -> ${target}`);
    }
    // Our own conditions must be complete for the run to mean anything; a
    // competitor that could not run is a reported outcome, not a broken run.
    const ours = report.attempts.filter(attempt => !attempt.condition.startsWith('system:'));
    if (!ours.every(attempt => attempt.status === 'completed' || attempt.status === 'context-overflow')) { console.error(`${spec.label}: our own conditions did not complete every attempt.`); failed = true; }
  }

  embedder?.close();
  reranker?.close();
  for (const outcome of outcomes) if (!outcome.system) console.error(`system ${outcome.id}: not run — ${outcome.reason ?? 'unavailable'}`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void matchedBenchmark().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Matched run failed.'); process.exitCode = 1; });
}
