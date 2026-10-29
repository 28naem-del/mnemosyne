import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createBundledEmbedder, type SyncMemoryEmbedder } from '../local/embedding/index.js';
import { asMemoryReranker, createBundledReranker, type SyncMemoryReranker } from '../local/reranking/index.js';
import { adaptLoCoMoCorpus, adaptLongMemEvalCorpus, runCorpusBenchmark, summarizeAttempts } from './corpus-benchmark.js';
import type { BenchmarkConditionId, CorpusBenchmarkReport, CorpusDataset, CorpusSummary } from './corpus-types.js';
import { createMem0Factory } from './matched-mem0.js';
import { createZepFactory } from './matched-zep.js';
import { resolveCompetitorModule } from './matched-resolve.js';
import { filterSourceBySplit, loadSplit, parseSplitName, SPLIT_FILES, type LoadedSplit } from './splits.js';
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
const SPLITS = join(REPO, 'benchmarks', 'splits');

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

function loadCorpus(kind: 'locomo' | 'longmemeval', file: string, questionLimit?: number, stride = 1, split?: LoadedSplit): { dataset: CorpusDataset; sha256: string; bytes: number } {
  const raw = readFileSync(file);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  let parsed = JSON.parse(raw.toString('utf8')) as unknown;
  const provenance = { ...(kind === 'locomo' ? LOCOMO : LONGMEMEVAL).provenance, sourceSha256: sha256, sourceBytes: raw.byteLength };
  // A TUNE/HOLDOUT run keeps only the ids its committed split file lists, before
  // any stride or slice; a split drawn from different corpus bytes is refused.
  if (split) {
    if (split.sourceSha256 !== sha256) throw new Error(`Split file ${split.file} was drawn from corpus sha256 ${split.sourceSha256}, not ${sha256}.`);
    if (!Array.isArray(parsed)) throw new Error(`${file} is not an array.`);
    parsed = filterSourceBySplit(kind, parsed, split);
  }
  if (kind === 'locomo') return { dataset: adaptLoCoMoCorpus(parsed, provenance, { onMalformedEvidence: 'skip' }), sha256, bytes: raw.byteLength };
  // The published cleaned release carries same-day history sessions that the
  // strict instant parser rejects, so the documented question-day policy is used
  // and named in the report. Nothing is repaired.
  //
  // The published release is GROUPED BY QUESTION CATEGORY — the first 70 entries
  // are all single-session-user — so taking a prefix would produce a subset made
  // of one category and a number that says nothing about the benchmark. Striding
  // takes every Nth entry in source order instead, which is deterministic,
  // reproducible from the flag alone, and keeps each category in proportion.
  let entries = Array.isArray(parsed) ? parsed : parsed;
  if (Array.isArray(entries) && stride > 1) entries = entries.filter((_, index) => index % stride === 0);
  if (Array.isArray(entries) && questionLimit !== undefined) entries = entries.slice(0, questionLimit);
  return { dataset: adaptLongMemEvalCorpus(entries, provenance, { timestampPolicy: 'question-day' }), sha256, bytes: raw.byteLength };
}

/**
 * Takes the first N corpora and the first M of their questions, in source order.
 * A slice is a smaller experiment, not a different one: every system sees exactly
 * the same reduced corpus, and the counts printed with the table are the sliced
 * counts, so a bounded run is never reported as a full-dataset result.
 */
function sliceCorpus(dataset: CorpusDataset, maxCorpora?: number, maxQuestions?: number, offset = 0): CorpusDataset {
  const from = dataset.corpora.slice(offset);
  const corpora = maxCorpora !== undefined ? from.slice(0, maxCorpora) : from;
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

/**
 * Combines the parts of a run that was split across invocations.
 *
 * A split run is only a split run if every part was the same experiment, so the
 * merge refuses parts whose settings block, corpus digest, embedding identity or
 * system roster differ in any way. Summaries are recomputed by the harness's own
 * `summarizeAttempts`, never by a second implementation here.
 */
function mergeParts(files: string[]): CorpusBenchmarkReport {
  const parts = files.map(file => JSON.parse(readFileSync(file, 'utf8')) as CorpusBenchmarkReport & { matched?: unknown });
  if (!parts.length) throw new Error('No part files to merge.');
  // `corpusIndexBase` is the partition coordinate, not an experimental setting:
  // it is required to differ between parts, and its entire purpose is to make the
  // partitioned run mint the same chunk identities as an unpartitioned one. Every
  // other setting must match exactly.
  const key = (report: CorpusBenchmarkReport) => JSON.stringify({
    settings: { ...report.settings, corpusIndexBase: 'partition-coordinate' }, source: report.dataset.sourceSha256, adapter: report.dataset.adapter,
    embedding: report.embedding ?? null, systems: (report.systems ?? []).map(system => [system.id, system.revision, system.mode]),
    implementation: report.runtime.implementationSha256, protocol: report.protocol,
    split: (report as { matched?: { split?: unknown } }).matched?.split ?? null });
  const reference = key(parts[0]);
  for (const [index, part] of parts.entries()) {
    if (key(part) !== reference) throw new Error(`Part ${files[index]} did not run the same experiment as ${files[0]}; merging it would compare different settings under one heading.`);
  }
  const seen = new Set<string>();
  const attempts = parts.flatMap(part => part.attempts);
  for (const attempt of attempts) {
    const identity = `${attempt.condition} ${attempt.questionId}`;
    if (seen.has(identity)) throw new Error(`Question ${attempt.questionId} appears twice for condition ${attempt.condition}; the parts overlap.`);
    seen.add(identity);
  }
  const conditions = [...new Set(attempts.map(attempt => attempt.condition))];
  const merged: CorpusBenchmarkReport = {
    ...parts[0],
    dataset: { ...parts[0].dataset, questions: attempts.length / Math.max(1, conditions.length), corpora: parts.reduce((sum, part) => sum + part.dataset.corpora, 0) },
    ingestion: parts.flatMap(part => part.ingestion),
    attempts,
    summaries: Object.fromEntries(conditions.map(condition => [condition, summarizeAttempts(attempts.filter(attempt => attempt.condition === condition))])),
    ...(parts[0].systems ? { systems: parts[0].systems.map(system => ({ ...system,
      ingestMilliseconds: parts.reduce((sum, part) => sum + (part.systems?.find(entry => entry.id === system.id)?.ingestMilliseconds ?? 0), 0),
      status: parts.some(part => part.systems?.find(entry => entry.id === system.id)?.status === 'ingest-failed') ? 'ingest-failed' as const : system.status,
      reason: parts.flatMap(part => { const found = part.systems?.find(entry => entry.id === system.id)?.reason; return found ? [found] : []; })[0] })) } : {}),
    complete: parts.every(part => part.complete),
    durationMs: parts.reduce((sum, part) => sum + part.durationMs, 0),
    limitations: [...parts[0].limitations, `Merged from ${parts.length} part runs whose settings, corpus digest, embedding identity, system roster and implementation digest were verified identical before combining.`],
  };
  return merged;
}

export async function matchedBenchmark(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    corpus: { type: 'string' }, systems: { type: 'string' }, 'top-k': { type: 'string' },
    'max-corpora': { type: 'string' }, 'max-questions': { type: 'string' }, out: { type: 'string' },
    'corpus-offset': { type: 'string' }, merge: { type: 'string' }, stride: { type: 'string' }, 'max-context-units': { type: 'string' },
    'mem0-extraction': { type: 'string' }, 'no-rerank': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, split: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log(`node dist/evaluation/matched-benchmark.js [options]

  --corpus locomo|longmemeval|both   corpora to score (default locomo)
  --systems mem0-oss,zep|none        competitors to include (default: all resolvable)
  --top-k N                          K, identical for every system (default 10)
  --max-corpora N                    score only the first N conversations/haystacks
  --corpus-offset N                  start at corpus N, for splitting a long run into parts
  --stride N                         score every Nth question (LongMemEval-S is grouped by
                                     category, so a prefix subset would be one category)
  --max-questions N                  bound the question count
  --split tune|holdout|all           keep only the ids listed in benchmarks/splits/<corpus>.json
                                     (LoCoMo by conversation, LongMemEval-S by question; seed
                                     20261029; see benchmarks/PROTOCOL-2026-10.md). all = every
                                     question (default). Applied before --stride/--max-*.
  --max-context-units N              packing budget per question in UTF-8 bytes (default 8192);
                                     a budget that holds all K hits records the full ranked list
  --out DIR                          write one raw JSON report per corpus
  --merge DIR                        combine the part files in DIR into one report
  --mem0-extraction off|llm          Mem0 write path. off = no LLM, free, offline (default)
  --no-rerank                        drop our reranked condition from the table
  --dry-run                          tiny slice, for proving the wiring

Every system runs in one process on one chunk set with one packing budget and one
scorer. Competitor SDKs are installed separately: npm run benchmark:matched:install`);
    return;
  }
  const corpus = values.corpus ?? 'locomo';
  if (!['locomo', 'longmemeval', 'both'].includes(corpus)) throw new Error('--corpus must be locomo, longmemeval or both');
  const splitName = parseSplitName(values.split);
  const splitTag = splitName === 'all' ? '' : `-${splitName}`;
  const topKForMerge = Number(values['top-k'] ?? 10);
  if (values.merge !== undefined) {
    const dir = resolve(values.merge);
    const strideForMerge = values.stride !== undefined ? Number(values.stride) : 1;
    const mergeTag = strideForMerge > 1 ? `${corpus}${splitTag}-stride${strideForMerge}-k${topKForMerge}` : `${corpus}${splitTag}-k${topKForMerge}`;
    const prefix = `${mergeTag}-part`;
    const files = readdirSync(dir).filter(name => name.startsWith(prefix) && name.endsWith('.json')).sort().map(name => join(dir, name));
    if (!files.length) throw new Error(`No ${prefix}*.json part files in ${dir}.`);
    const merged = mergeParts(files);
    const target = join(dir, `${mergeTag}.json`);
    writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    console.log(`merged ${files.length} parts -> ${target}`);
    console.log(`${merged.dataset.questions} questions, ${merged.dataset.corpora} corpora, complete=${merged.complete}`);
    const outcomes: SystemOutcome[] = (merged.systems ?? []).map(system => ({ id: system.id, factory: { id: system.id, describe: () => '', resolve: () => Promise.resolve({ available: false, reason: system.reason ?? '' }) },
      system: system.status === 'scored' ? { id: system.id, revision: system.revision, mode: system.mode, create: () => Promise.reject(new Error('merged report')) } : null, ...(system.reason ? { reason: system.reason } : {}) }));
    for (const line of printTable(merged, outcomes, topKForMerge)) console.log(line);
    return;
  }
  const extraction = (values['mem0-extraction'] ?? 'off') as 'off' | 'llm';
  if (!['off', 'llm'].includes(extraction)) throw new Error('--mem0-extraction must be off or llm');
  if (extraction === 'llm') throw new Error('--mem0-extraction llm needs an explicit LLM configuration and a spend decision; it is not wired to any key by this command.');
  const dry = values['dry-run'] === true;
  const topK = Number(values['top-k'] ?? 10);
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > 100) throw new Error('--top-k must be between 1 and 100');
  const maxCorpora = values['max-corpora'] !== undefined ? Number(values['max-corpora']) : dry ? 2 : undefined;
  const corpusOffset = values['corpus-offset'] !== undefined ? Number(values['corpus-offset']) : 0;
  if (!Number.isSafeInteger(corpusOffset) || corpusOffset < 0) throw new Error('--corpus-offset must be a non-negative integer');
  const stride = values.stride !== undefined ? Number(values.stride) : 1;
  if (!Number.isSafeInteger(stride) || stride < 1 || stride > 1000) throw new Error('--stride must be between 1 and 1000');
  const maxQuestions = values['max-questions'] !== undefined ? Number(values['max-questions']) : dry ? 20 : undefined;
  const maxContextUnits = values['max-context-units'] !== undefined ? Number(values['max-context-units']) : undefined;
  if (maxContextUnits !== undefined && (!Number.isSafeInteger(maxContextUnits) || maxContextUnits < 1 || maxContextUnits > 16_777_216)) throw new Error('--max-context-units must be between 1 and 16777216');
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
    // LongMemEval gives every question its own haystack, so a bounded run must
    // stop building corpora at the end of its own window rather than at the start
    // of it — otherwise an offset run would slice away everything it needs.
    const split = splitName === 'all' ? undefined : loadSplit(join(SPLITS, SPLIT_FILES[kind]), splitName);
    const { dataset, sha256, bytes } = loadCorpus(kind, file, maxCorpora === undefined ? undefined : corpusOffset + maxCorpora, stride, split);
    // Slicing happens here, deterministically and in source order, rather than
    // through the runner's `maxQuestions` — which is an upper bound that rejects
    // an oversized corpus, not a sampler. The slice is recorded in the report so
    // a partial run can never be mistaken for a full one.
    const scoped = sliceCorpus(dataset, maxCorpora, maxQuestions, corpusOffset);
    const started = Date.now();
    const report = await runCorpusBenchmark(scoped, {
      topK, includeBm25: true, hybridLexicalScoring: 'bm25', includeHybridWithoutRerank: true,
      ...(maxContextUnits !== undefined ? { maxContextUnits } : {}),
      ...(embedder ? { embedder: embedder.forPassages(), queryEmbedder: embedder.forQueries() } : {}),
      ...(reranker ? { reranker: asMemoryReranker(reranker), rerankTopN: 50 } : {}),
      ...(systems.length ? { systems } : {}),
      maxEmbeddingCalls: 1_000_000, maxEmbeddingInputBytes: 2_147_483_647, timeoutMs: 3_600_000, systemIngestTimeoutMs: 3_600_000,
      // Keeps a split run's chunk identities equal to an unsplit run's.
      corpusIndexBase: corpusOffset,
    });

    console.log(`\n=== MATCHED RUN — ${spec.label}${split ? ` [split ${split.name}: ${split.ids.size} ${kind === 'locomo' ? 'conversations' : 'questions'}, seed ${split.seed}]` : ''}${stride > 1 ? ` [every ${stride}th question, source order]` : ''} ===`);
    if (split) console.log(`split file ${split.file} sha256 ${split.sha256}`);
    console.log(`${report.dataset.questions} questions, ${report.dataset.corpora} corpora, ${report.summaries.bm25?.annotatedQuestions ?? 0} with positive evidence labels`);
    console.log(`corpus sha256 ${sha256} (${bytes} bytes)  normalized ${report.dataset.normalizedSha256}`);
    console.log(`runtime ${report.runtime.node} ${report.runtime.platform}  elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`identical for every row: K=${topK}  maxContextUnits=${report.settings.maxContextUnits} (${report.settings.accountingId})  chunkBytes=${report.settings.chunkBytes}  envelope=corpus-v1`);
    console.log(`reader/judge: none — this is retrieval coverage, not answer accuracy (calls: generation=${report.calls.generation}, judge=${report.calls.judge})`);
    for (const line of printTable(report, outcomes, topK)) console.log(line);
    for (const system of report.systems ?? []) console.log(`  ingest ${system.id}: ${(system.ingestMilliseconds / 1000).toFixed(1)}s${system.reason ? ` — ${system.reason}` : ''}`);
    for (const notice of report.notices) console.log(`note: ${notice}`);

    if (outDir) {
      // A partial run is written as a part file, never as the whole-run name.
      const partial = corpusOffset > 0 || maxCorpora !== undefined;
      const tag = stride > 1 ? `${kind}${splitTag}-stride${stride}-k${topK}` : `${kind}${splitTag}-k${topK}`;
      const target = join(outDir, partial ? `${tag}-part${String(corpusOffset).padStart(3, '0')}.json` : `${tag}.json`);
      writeFileSync(target, `${JSON.stringify({ ...report, matched: { requested, split: split ? { name: split.name, file: relative(REPO, split.file), sha256: split.sha256, seed: split.seed, ids: split.ids.size } : { name: 'all' }, outcomes: outcomes.map(outcome => ({ id: outcome.id, available: outcome.system !== null, mode: outcome.system?.mode ?? null, reason: outcome.reason ?? null, describes: outcome.factory.describe() })) } }, null, 2)}\n`, { mode: 0o600 });
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
