import { afterEach, describe, expect, it, vi } from 'vitest';

// Wraps the real factory so a test can see the options the corpus runner hands the engine.
vi.mock('../src/local/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/local/index.js')>();
  return { ...actual, createLocalMemory: vi.fn(actual.createLocalMemory) };
});

import { createLocalMemory, LocalMemory, type MemoryEmbedder, type MemoryReranker } from '../src/local/index.js';
import { adaptLongMemEvalCorpus, runCorpusBenchmark } from '../src/evaluation/corpus-benchmark.js';
import { corpusEngineOptions, MATCHED_ENGINE_DEFAULTS, parseEngineOpts, resolveEngineConfig } from '../src/evaluation/engine-opts.js';
import { matchedBenchmark } from '../src/evaluation/matched-benchmark.js';

const provenance = { dataset: 'synthetic-test', revision: 'fixture-v1', license: 'MIT; synthetic fixtures only' };
const dataset = () => adaptLongMemEvalCorpus([{ question_id: 'q1', question_type: 'single-session-user', question: 'orchid water', question_date: '2023/05/20 (Sat) 12:00',
  haystack_session_ids: ['gold', 'other'], haystack_dates: ['2023/05/18 (Thu) 09:00', '2023/05/19 (Fri) 09:00'],
  haystack_sessions: [[{ role: 'user', content: 'The orchid needs water every Tuesday.' }], [{ role: 'assistant', content: 'Other topics: mountain weather.' }]],
  answer_session_ids: ['gold'], answer: 'Tuesday' }], provenance);
const embedder: MemoryEmbedder = { model: 'engine-opts-stub-v1', dimensions: 2, embed: async texts => texts.map(text => text.includes('orchid') ? [1, 0] : [0, 1]) };
const reranker: MemoryReranker = { rerank: async (_query, candidates) => candidates.map(record => ({ id: record.id, score: 0.5 })) };

afterEach(() => { vi.restoreAllMocks(); vi.mocked(createLocalMemory).mockClear(); });

describe('--engine-opts parsing', () => {
  it('treats an absent or empty value as {} and {} as exactly the old harness configuration', () => {
    expect(parseEngineOpts(undefined)).toEqual({});
    expect(parseEngineOpts('{}')).toEqual({});
    const config = resolveEngineConfig({});
    expect(config).toEqual({ memory: {}, hybrid: { rerankTopN: 50 }, embedder: { batchSize: 32 }, reranker: { batchSize: 32 } });
    expect(config).toEqual(JSON.parse(JSON.stringify(MATCHED_ENGINE_DEFAULTS)));
    // Nothing beyond the defaults reaches the corpus runner, so a default run passes it what it always did.
    expect(corpusEngineOptions(config)).toBeUndefined();
  });
  it('merges each section over the defaults and routes rerankTopN to the runner, not the engine block', () => {
    const opts = parseEngineOpts('{"memory":{"rrfK":20},"hybrid":{"rrfK":30,"fusionWeights":{"lexical":1.5,"dense":0.5},"rerankTopN":20,"maxCandidates":500},"embedder":{"threads":2},"reranker":{"batchSize":8,"threads":4}}');
    const config = resolveEngineConfig(opts);
    expect(config).toEqual({ memory: { rrfK: 20 }, hybrid: { rerankTopN: 20, rrfK: 30, fusionWeights: { lexical: 1.5, dense: 0.5 }, maxCandidates: 500 },
      embedder: { batchSize: 32, threads: 2 }, reranker: { batchSize: 8, threads: 4 } });
    expect(corpusEngineOptions(config)).toEqual({ memory: { rrfK: 20 }, hybrid: { rrfK: 30, fusionWeights: { lexical: 1.5, dense: 0.5 }, maxCandidates: 500 } });
  });
  it('refuses malformed JSON, unknown sections and out-of-range model or rerank settings', () => {
    expect(() => parseEngineOpts('nope')).toThrow('JSON object');
    expect(() => parseEngineOpts('[1]')).toThrow('JSON object');
    expect(() => parseEngineOpts('{"retrieval":{}}')).toThrow('unknown section');
    expect(() => parseEngineOpts('{"hybrid":5}')).toThrow('must be an object');
    expect(() => parseEngineOpts('{"reranker":{"cacheDir":"/tmp"}}')).toThrow('batchSize, threads');
    expect(() => parseEngineOpts('{"reranker":{"threads":0}}')).toThrow('reranker.threads');
    expect(() => parseEngineOpts('{"embedder":{"batchSize":65}}')).toThrow('embedder.batchSize');
    expect(() => parseEngineOpts('{"hybrid":{"rerankTopN":1001}}')).toThrow('hybrid.rerankTopN');
  });
  it('fails the CLI before any model or corpus work on a bad value', async () => {
    await expect(matchedBenchmark(['--systems', 'none', '--engine-opts', '{"bogus":{}}'])).rejects.toThrow('unknown section');
  });
});

describe('engine options reach the engine', () => {
  it('spreads memory options into createLocalMemory and hybrid options into every recallHybrid call', async () => {
    const recallHybrid = vi.spyOn(LocalMemory.prototype, 'recallHybrid');
    const engine = { memory: { rrfK: 37, minSimilarity: 0.1 }, hybrid: { rrfK: 23, fusionWeights: { lexical: 2, dense: 0.5 }, maxCandidates: 77 } };
    const report = await runCorpusBenchmark(dataset(), { embedder, reranker, rerankTopN: 9, includeHybridWithoutRerank: true, engine });
    const factory = vi.mocked(createLocalMemory);
    // The validation probe and the corpus engine both carry the overrides; identity and mode stay the runner's.
    expect(factory.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [options] of factory.mock.calls) expect(options).toMatchObject({ rrfK: 37, minSimilarity: 0.1, path: ':memory:', retrieval: 'lexical', workspaceId: 'corpus-evaluation' });
    expect(recallHybrid).toHaveBeenCalledTimes(2);
    for (const [, options] of recallHybrid.mock.calls) expect(options).toMatchObject({ rrfK: 23, fusionWeights: { lexical: 2, dense: 0.5 }, maxCandidates: 77 });
    expect(recallHybrid.mock.calls.some(([, options]) => options.rerankTopN === 9 && options.reranker)).toBe(true);
    expect(report.settings.engine).toBe(JSON.stringify(engine));
    expect(report.complete).toBe(true);
  });
  it('passes nothing new and records nothing new when no engine options are given', async () => {
    const recallHybrid = vi.spyOn(LocalMemory.prototype, 'recallHybrid');
    const report = await runCorpusBenchmark(dataset(), { embedder, reranker, rerankTopN: 9, includeHybridWithoutRerank: true });
    expect(report.settings).not.toHaveProperty('engine');
    const [options] = vi.mocked(createLocalMemory).mock.calls.at(-1)!;
    expect(Object.keys(options).sort()).toEqual(['agentId', 'now', 'path', 'retrieval', 'workspaceId']);
    for (const [, hybrid] of recallHybrid.mock.calls) { expect(hybrid).not.toHaveProperty('rrfK'); expect(hybrid).not.toHaveProperty('fusionWeights'); }
  });
  it('refuses keys that would change what a condition measures, and values the engine rejects, before any corpus loads', async () => {
    await expect(runCorpusBenchmark(dataset(), { engine: { memory: { retrieval: 'hybrid' } as never } })).rejects.toThrow('Engine memory options');
    await expect(runCorpusBenchmark(dataset(), { engine: { memory: { path: '/tmp/x' } as never } })).rejects.toThrow('Engine memory options');
    await expect(runCorpusBenchmark(dataset(), { engine: { memory: { rrfK: 5000 } } })).rejects.toThrow('Invalid engine memory options');
    await expect(runCorpusBenchmark(dataset(), { engine: { hybrid: { fusionWeights: { lexical: -1 } } } })).rejects.toThrow('fusionWeights.lexical');
    await expect(runCorpusBenchmark(dataset(), { engine: { hybrid: { rerankTopN: 5 } as never } })).rejects.toThrow('Engine hybrid options');
    await expect(runCorpusBenchmark(dataset(), { engine: { other: {} } as never })).rejects.toThrow('only "memory" and "hybrid"');
  });
});

describe('recallHybrid fusionWeights', () => {
  const source = { uri: 'test:fusion-weights' };
  // "alpha" is the lexical favourite (term frequency 3) and orthogonal to the
  // query vector; "beta" is the dense favourite and a weak lexical match.
  const vectors: MemoryEmbedder = { model: 'fusion-weights-v1', dimensions: 2, embed: async texts => texts.map(text => text === 'alpha' || text.includes('beta') ? [1, 0] : [0, 1]) };
  async function fixture() {
    const memory = createLocalMemory({ path: ':memory:', workspaceId: 'fusion', agentId: 'agent', retrieval: 'lexical' });
    const lexical = memory.store({ text: 'alpha alpha alpha', source, trust: 'observed' });
    const dense = memory.store({ text: 'alpha beta gamma delta epsilon zeta', source, trust: 'observed' });
    memory.store({ text: 'unrelated note', source, trust: 'observed' });
    await memory.indexEmbeddings({ embedder: vectors });
    return { memory, lexical: lexical.id, dense: dense.id };
  }
  it('is exactly the unweighted fusion at weights 1/1', async () => {
    const { memory } = await fixture();
    try {
      const plain = await memory.recallHybrid({ query: 'alpha', limit: 3 }, { embedder: vectors });
      const ones = await memory.recallHybrid({ query: 'alpha', limit: 3 }, { embedder: vectors, fusionWeights: { lexical: 1, dense: 1 } });
      expect(ones.map(hit => [hit.memory.id, hit.score])).toEqual(plain.map(hit => [hit.memory.id, hit.score]));
    } finally { memory.close(); }
  });
  it('lets a channel weight decide the head of the fused ranking', async () => {
    const { memory, lexical, dense } = await fixture();
    try {
      expect((await memory.recallHybrid({ query: 'alpha', limit: 3 }, { embedder: vectors, fusionWeights: { lexical: 1, dense: 0 } }))[0].memory.id).toBe(lexical);
      expect((await memory.recallHybrid({ query: 'alpha', limit: 3 }, { embedder: vectors, fusionWeights: { lexical: 0, dense: 1 } }))[0].memory.id).toBe(dense);
      await expect(memory.recallHybrid({ query: 'alpha' }, { embedder: vectors, fusionWeights: { lexical: Number.NaN } })).rejects.toThrow('fusionWeights.lexical');
      await expect(memory.recallHybrid({ query: 'alpha' }, { embedder: vectors, fusionWeights: { names: 1 } as never })).rejects.toThrow();
    } finally { memory.close(); }
  });
});
