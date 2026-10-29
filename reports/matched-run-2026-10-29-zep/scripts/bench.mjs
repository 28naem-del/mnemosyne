// Phase 2: the matched pass for one conversation at K=5, 10, 20, with exactly the
// runCorpusBenchmark options src/evaluation/matched-benchmark.ts uses, Mnemosyne's four
// conditions + Mem0 OSS (infer:false) + Zep in one loop. Zep runs through the repository's
// unmodified adapter on a replay client: graph.add never reaches Zep (the episodes were
// loaded in phase 1), every search is a live Zep call, and the adapter's own processed-wait
// still runs against the live API.
// Usage: node bench.mjs <kind> <corpusOffset> <outDir> [stride]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { COMPETITORS, DIST, KEY_ENV, ZEP_VERSION, loadCorpus, realClient, recordingClient, sliceCorpus, SPECS } from './lib.mjs';

const [kind, offsetArg, outArg, strideArg] = process.argv.slice(2);
const offset = Number(offsetArg), outDir = resolve(outArg), stride = Number(strideArg ?? 1);
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const ev = p => import(join(DIST, p));
const { createBundledEmbedder } = await ev('local/embedding/index.js');
const { asMemoryReranker, createBundledReranker } = await ev('local/reranking/index.js');
const { runCorpusBenchmark } = await ev('evaluation/corpus-benchmark.js');
const { createMem0Factory } = await ev('evaluation/matched-mem0.js');
const { createZepFactory } = await ev('evaluation/matched-zep.js');
const { resolveCompetitorModule } = await ev('evaluation/matched-resolve.js');

const embedder = createBundledEmbedder({ batchSize: 32 });
const reranker = createBundledReranker({ batchSize: 32 });
const signal = new AbortController().signal;

const mem0Module = resolveCompetitorModule(COMPETITORS, 'mem0ai', './oss');
if (!mem0Module.resolved) throw new Error(mem0Module.reason);
const mem0Factory = createMem0Factory({ embedder: embedder.forPassages(), queryEmbedder: embedder.forQueries(), extraction: 'off',
  moduleSpecifier: mem0Module.url, versionSpecifier: join(mem0Module.directory, 'package.json') });
const mem0 = await mem0Factory.resolve({ seed: 0, signal });
if (!mem0.available) throw new Error(mem0.reason);

const stats = { added: 0, replayed: 0, credits: 0, calls: {} };
const zepFactory = createZepFactory({ baseDir: COMPETITORS, client: recordingClient(realClient(), 'replay', stats), ingestSettleMs: 3_000_000 });
const zepRes = await zepFactory.resolve({ seed: 0, signal });
if (!zepRes.available) throw new Error(zepRes.reason);
// The adapter labels an injected client 'stub'; this is the real SDK, so say so, and say how ingestion was shared.
const ZEP_MODE = zepRes.system.mode.replace('zep-cloud@stub', `zep-cloud@${ZEP_VERSION}`)
  + ', ingest=graph.add once per conversation (phase 1), episodes reused by the K=5/10/20 passes (replay client, 0 extra graph.add), account=free'
  + (process.env.ZEP_SORT_BY_SCORE === '1' ? ', DIAGNOSTIC: search response re-sorted by Zep episode score desc before ranking (not the repository adapter behaviour)' : '');
const zep = { ...zepRes.system, revision: ZEP_VERSION, mode: ZEP_MODE,
  // Keep the user alive between K passes; cleanup.mjs deletes it through the SDK.
  async create(request) { const s = await zepRes.system.create(request); return { ...s, close: async () => {} }; } };

const { dataset, sha256, bytes } = await loadCorpus(kind, kind === 'longmemeval' ? offset + 1 : undefined, stride);
const scoped = sliceCorpus(dataset, 1, undefined, offset);
for (const topK of [5, 10, 20]) {
  const started = Date.now();
  const report = await runCorpusBenchmark(scoped, {
    topK, includeBm25: true, hybridLexicalScoring: 'bm25', includeHybridWithoutRerank: true,
    embedder: embedder.forPassages(), queryEmbedder: embedder.forQueries(),
    reranker: asMemoryReranker(reranker), rerankTopN: 50,
    systems: [mem0.system, zep],
    maxEmbeddingCalls: 1_000_000, maxEmbeddingInputBytes: 2_147_483_647, timeoutMs: 3_600_000, systemIngestTimeoutMs: 3_600_000,
    corpusIndexBase: offset,
  });
  const tag = stride > 1 ? `${kind}-stride${stride}-k${topK}` : `${kind}-k${topK}`;
  const target = join(outDir, `${tag}-part${String(offset).padStart(3, '0')}.json`);
  const outcomes = [mem0Factory, zepFactory].map((f, i) => ({ id: f.id, available: true, mode: [mem0.system, zep][i].mode, reason: null, describes: f.describe() }));
  writeFileSync(target, `${JSON.stringify({ ...report, matched: { requested: ['mem0-oss', 'zep'], outcomes, zepRun: { keyEnv: KEY_ENV, replayStats: { ...stats } } } }, null, 2)}\n`, { mode: 0o600 });
  const s = report.summaries;
  const line = c => s[c] ? `${(s[c].meanRecall * 100).toFixed(2)}/${(s[c].mrr ?? 0).toFixed(4)}` : 'n/a';
  console.log(`${SPECS[kind].label} part${offset} K=${topK} q=${report.dataset.questions} complete=${report.complete} ${((Date.now() - started) / 1000).toFixed(0)}s`
    + ` hybrid+rerank=${line('hybrid')} hybrid=${line('hybrid-norerank')} mem0=${line('system:mem0-oss')} zep=${line('system:zep')}`
    + ` systems=${JSON.stringify((report.systems ?? []).map(x => [x.id, x.status, x.reason ?? '']))} -> ${target}`);
}
embedder.close(); reranker.close();
const net = (stats.searchNetMs ?? []).slice().sort((a, b) => a - b); console.log('STATS', JSON.stringify({ ...stats, searchNetMs: undefined, searchNetP50: net[Math.floor(net.length * 0.5)], searchNetP95: net[Math.floor(net.length * 0.95)], searches: net.length }));
