import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adaptLongMemEvalCorpus, runCorpusBenchmark } from '../src/evaluation/corpus-benchmark.js';
import { assertMatchedSystemId, checkRetrievedIds, matchedConditionId, type MatchedChunk, type MatchedSession, type MatchedSystem } from '../src/evaluation/matched-types.js';
import { resolveCompetitorModule } from '../src/evaluation/matched-resolve.js';
import { asBenchmarkCondition, type MatchedConditionReport } from '../src/evaluation/matched-bridge.js';
import { createZepFactory, type ZepLikeClient, type ZepSearchResponse } from '../src/evaluation/matched-zep.js';

const provenance = { dataset: 'synthetic-test', revision: 'fixture-v1', license: 'MIT; synthetic fixtures only' };
const lme = (overrides: Record<string, unknown> = {}) => ({
  question_id: 'q1', question_type: 'single-session-user', question: 'orchid water', question_date: '2023/05/20 (Sat) 12:00',
  haystack_session_ids: ['answer_GOLD_SESSION', 'other'], haystack_dates: ['2023/05/18 (Thu) 09:00', '2023/05/19 (Fri) 09:00'],
  haystack_sessions: [[{ role: 'user', content: 'The orchid needs water every Tuesday.' }], [{ role: 'assistant', content: 'Other topics: mountain weather.' }]],
  answer_session_ids: ['answer_GOLD_SESSION'], answer: 'GOLD_ANSWER_SENTINEL', ...overrides });
const dataset = () => adaptLongMemEvalCorpus([lme()], provenance);

/** Records every byte the harness ever hands a competitor, for the leakage assertion. */
function spySystem(rank: (chunks: MatchedChunk[], query: string) => string[], seen: { chunks: MatchedChunk[]; queries: string[]; created: unknown[] }): MatchedSystem {
  return { id: 'spy', revision: '1', mode: 'spy@1, extraction=none, retrieval=scripted',
    async create(request): Promise<MatchedSession> {
      seen.created.push(request);
      let held: MatchedChunk[] = [];
      return {
        async ingest(chunks) { held = chunks; seen.chunks.push(...chunks); },
        async retrieve({ query, limit }) { seen.queries.push(query); return rank(held, query).slice(0, limit); },
        async close() { held = []; },
      };
    } };
}

describe('matched system contract', () => {
  it('rejects identities a system was never given, duplicates, and over-long result sets', () => {
    const known = new Set(['a', 'b']);
    expect(checkRetrievedIds(['b', 'a'], known, 10)).toEqual(['b', 'a']);
    expect(() => checkRetrievedIds(['c'], known, 10)).toThrow('unknown chunk identity');
    expect(() => checkRetrievedIds(['a', 'a'], known, 10)).toThrow('duplicate chunk identity');
    expect(() => checkRetrievedIds(['a', 'b'], known, 1)).toThrow('more hits than the requested limit');
    expect(() => checkRetrievedIds('a', known, 10)).toThrow('array of chunk identities');
  });

  it('keeps competitor condition keys in their own namespace', () => {
    expect(matchedConditionId('mem0-oss')).toBe('system:mem0-oss');
    expect(() => assertMatchedSystemId('Mem0 OSS')).toThrow('Invalid matched system id');
    expect(() => assertMatchedSystemId('mem0_oss')).toThrow('Invalid matched system id');
  });

  it('never shows a competitor an evidence label, a question identity or its own condition name', async () => {
    const seen = { chunks: [] as MatchedChunk[], queries: [] as string[], created: [] as unknown[] };
    const system = spySystem(chunks => chunks.map(chunk => chunk.id), seen);
    await runCorpusBenchmark(dataset(), { systems: [system], maxContextUnits: 262_144 });
    const exposed = JSON.stringify({ chunks: seen.chunks, queries: seen.queries, created: seen.created });
    expect(exposed).not.toContain('GOLD_ANSWER_SENTINEL');
    expect(exposed).not.toContain('answer_GOLD_SESSION');
    expect(exposed).not.toContain('session:');
    expect(exposed).not.toContain('answerab');
    expect(exposed).not.toContain('single-session-user');
    expect(exposed).not.toContain('system:spy');
    expect(exposed).not.toContain('q1');
    expect(seen.queries).toEqual(['orchid water']);
    // It does see exactly what every other system sees: chunk identity and text.
    expect(seen.chunks.map(chunk => chunk.text)).toEqual(['The orchid needs water every Tuesday.', 'Other topics: mountain weather.']);
  });

  it('scores a competitor with the identical scorer, so identical rankings give identical numbers', async () => {
    const seen = { chunks: [], queries: [], created: [] } as { chunks: MatchedChunk[]; queries: string[]; created: unknown[] };
    // Returns the gold chunk first, exactly as a perfect retriever would.
    const perfect = spySystem(chunks => chunks.filter(chunk => chunk.text.includes('orchid')).map(chunk => chunk.id), seen);
    const report = await runCorpusBenchmark(dataset(), { systems: [perfect], maxContextUnits: 262_144 });
    expect(report.summaries['system:spy']?.meanRecall).toBe(1);
    expect(report.summaries['system:spy']?.mrr).toBe(1);
    expect(report.summaries['system:spy']).toEqual(report.summaries['full-context']
      ? expect.objectContaining({ meanRecall: 1, anyHitRate: 1, allHitRate: 1 }) : expect.anything());
    expect(report.settings.matchedSystems).toBe('spy');
    expect(report.systems?.[0]).toMatchObject({ id: 'spy', condition: 'system:spy', status: 'scored', mode: 'spy@1, extraction=none, retrieval=scripted' });
  });

  it('reports a failed competitor as a reason and never as a score', async () => {
    const broken: MatchedSystem = { id: 'broken', revision: '1', mode: 'broken@1',
      create: () => Promise.resolve({ ingest: () => Promise.reject(new Error('BACKEND_UNREACHABLE')), retrieve: () => Promise.resolve([]), close: () => Promise.resolve() }) };
    const report = await runCorpusBenchmark(dataset(), { systems: [broken], maxContextUnits: 262_144 });
    expect(report.systems?.[0]).toMatchObject({ id: 'broken', status: 'ingest-failed' });
    expect(report.systems?.[0].reason).toContain('BACKEND_UNREACHABLE');
    expect(report.summaries['system:broken']?.meanRecall).toBeNull();
    expect(report.attempts.filter(attempt => attempt.condition === 'system:broken').every(attempt => attempt.status === 'system-error')).toBe(true);
    // Our own conditions still produced their numbers.
    expect(report.summaries.lexical?.meanRecall).toBe(1);
  });

  it('rejects a system that returns an identity it was never given', async () => {
    const liar: MatchedSystem = { id: 'liar', revision: '1', mode: 'liar@1',
      create: () => Promise.resolve({ ingest: () => Promise.resolve(), retrieve: () => Promise.resolve(['not-a-real-chunk']), close: () => Promise.resolve() }) };
    const report = await runCorpusBenchmark(dataset(), { systems: [liar], maxContextUnits: 262_144 });
    expect(report.attempts.filter(attempt => attempt.condition === 'system:liar').every(attempt => attempt.status === 'system-error')).toBe(true);
    expect(report.summaries['system:liar']?.meanRecall).toBeNull();
  });

  it('rejects a duplicate system id and a system with no declared mode', async () => {
    const one = spySystem(() => [], { chunks: [], queries: [], created: [] });
    await expect(runCorpusBenchmark(dataset(), { systems: [one, one] })).rejects.toThrow('Duplicate matched system id');
    await expect(runCorpusBenchmark(dataset(), { systems: [{ ...one, mode: '  ' }] })).rejects.toThrow('non-empty mode label');
  });

  it('measures the reranker as a within-run delta without changing what hybrid means', async () => {
    const plain = await runCorpusBenchmark(dataset(), { maxContextUnits: 262_144 });
    expect(plain.summaries['hybrid-norerank']).toBeUndefined();
    expect(plain.settings.hybridWithoutRerankCondition).toBe('disabled');
  });
});

describe('competitor module resolution', () => {
  it('reports a missing competitor as an install instruction, not a crash', () => {
    const base = mkdtempSync(join(tmpdir(), 'matched-resolve-'));
    try {
      const missing = resolveCompetitorModule(base, 'mem0ai', './oss');
      expect(missing.resolved).toBe(false);
      if (!missing.resolved) expect(missing.reason).toContain('benchmark:matched:install');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('honours an installed package\'s own exports map', () => {
    const base = mkdtempSync(join(tmpdir(), 'matched-resolve-'));
    try {
      const pkg = join(base, 'node_modules', 'fake-sdk');
      mkdirSync(join(pkg, 'dist'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'fake-sdk', version: '9.9.9', exports: { './oss': { require: './dist/oss.cjs', import: './dist/oss.mjs' } } }));
      writeFileSync(join(pkg, 'dist', 'oss.mjs'), 'export const Memory = class {};\n');
      const found = resolveCompetitorModule(base, 'fake-sdk', './oss');
      expect(found.resolved).toBe(true);
      if (found.resolved) { expect(found.version).toBe('9.9.9'); expect(found.url.endsWith('/dist/oss.mjs')).toBe(true); }
      const absent = resolveCompetitorModule(base, 'fake-sdk', './nope');
      expect(absent.resolved).toBe(false);
      if (!absent.resolved) expect(absent.reason).toContain('no ESM entry point');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('refuses an entry point that escapes its own package directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'matched-resolve-'));
    try {
      const pkg = join(base, 'node_modules', 'escapee');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(base, 'outside.mjs'), 'export const x = 1;\n');
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'escapee', version: '1.0.0', exports: { '.': '../../outside.mjs' } }));
      const found = resolveCompetitorModule(base, 'escapee', '.');
      expect(found.resolved).toBe(false);
      if (!found.resolved) expect(found.reason).toContain('outside its own package directory');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe('the agent-benchmark bridge', () => {
  const collectingSystem = (withForget: boolean, log: string[]): MatchedSystem => ({
    id: 'bridged', revision: '2', mode: 'bridged@2',
    async create(): Promise<MatchedSession> {
      const held = new Map<string, MatchedChunk>();
      const session: MatchedSession = {
        async ingest(chunks) { for (const chunk of chunks) { held.set(chunk.id, chunk); log.push(`ingest:${chunk.id}`); } },
        async retrieve({ limit }) { return [...held.keys()].reverse().slice(0, limit); },
        async close() { held.clear(); log.push('close'); },
      };
      if (withForget) session.forget = async ids => { for (const id of ids) { held.delete(id); log.push(`forget:${id}`); } };
      return session;
    },
  });

  it('carries remember, correct and forget through a system that can delete', async () => {
    const log: string[] = [];
    let report: MatchedConditionReport | undefined;
    const condition = asBenchmarkCondition(collectingSystem(true, log), { onClose: value => { report = value; } });
    expect(condition.id).toBe('system:bridged');
    const signal = new AbortController().signal;
    const session = await condition.create({ seed: 1, maxContextUnits: 4096, signal });
    await session.apply({ operation: 'remember', key: 'k1', text: 'beagle named Pepper' }, signal);
    await session.apply({ operation: 'remember', key: 'k2', text: 'marathon in October' }, signal);
    await session.apply({ operation: 'correct', key: 'k1', text: 'beagle named Biscuit' }, signal);
    const corrected = await session.context({ query: 'dog', maxContextUnits: 4096, signal });
    expect(corrected.text).toContain('Biscuit');
    expect(corrected.text).not.toContain('Pepper');
    await session.apply({ operation: 'forget', key: 'k2' }, signal);
    const after = await session.context({ query: 'running', maxContextUnits: 4096, signal });
    expect(after.text).not.toContain('marathon');
    expect(after.sourceKeys).toEqual(['k1']);
    await session.close();
    expect(log).toContain('forget:k1#1');
    expect(log).toContain('forget:k2#1');
    expect(report?.unsupported).toEqual([]);
  });

  it('counts, rather than simulates, a deletion a system cannot perform', async () => {
    const log: string[] = [];
    let report: MatchedConditionReport | undefined;
    const condition = asBenchmarkCondition(collectingSystem(false, log), { onClose: value => { report = value; } });
    const signal = new AbortController().signal;
    const session = await condition.create({ seed: 1, maxContextUnits: 4096, signal });
    await session.apply({ operation: 'remember', key: 'k1', text: 'beagle named Pepper' }, signal);
    await session.apply({ operation: 'forget', key: 'k1' }, signal);
    const after = await session.context({ query: 'dog', maxContextUnits: 4096, signal });
    // The record is still inside the system; it is excluded from context and the
    // divergence is reported rather than being scored as a successful deletion.
    expect(after.text).toBe('');
    await session.close();
    expect(log.some(entry => entry.startsWith('forget:'))).toBe(false);
    expect(report?.unsupported).toEqual([{ operation: 'forget', count: 1 }]);
  });
});

describe('the Zep adapter', () => {
  const stub = (): { client: ZepLikeClient; added: string[]; deleted: string[] } => {
    const store: { id: string; text: string }[] = [], added: string[] = [], deleted: string[] = [];
    return { added, deleted, client: {
      user: { add: async ({ userId }) => { added.push(userId); }, delete: async userId => { deleted.push(userId); } },
      graph: {
        add: async ({ data, sourceDescription }) => { store.push({ id: sourceDescription ?? '', text: data }); },
        search: async ({ query, limit }): Promise<ZepSearchResponse> => ({
          episodes: store.filter(entry => entry.text.toLowerCase().includes(query.toLowerCase())).slice(0, limit).map(entry => ({ content: entry.text, sourceDescription: entry.id })) }),
      },
    } };
  };

  it('is blocked with an exact requirement when no key is provisioned', async () => {
    const base = mkdtempSync(join(tmpdir(), 'matched-zep-'));
    try {
      const resolution = await createZepFactory({ baseDir: base, apiKeyEnv: 'MATCHED_TEST_ZEP_KEY_ABSENT' }).resolve({ seed: 0, signal: new AbortController().signal });
      expect(resolution.available).toBe(false);
      if (!resolution.available) {
        expect(resolution.reason).toContain('@getzep/zep-cloud is not installed');
        expect(resolution.reason).toContain('ZEP_API_KEY');
        expect(resolution.reason).toContain('discontinued');
      }
      expect(createZepFactory({ baseDir: base }).describe()).toContain('BLOCKED');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('ingests, retrieves and tears down against a client implementing the same surface', async () => {
    const { client, added, deleted } = stub();
    const resolution = await createZepFactory({ baseDir: tmpdir(), client }).resolve({ seed: 0, signal: new AbortController().signal });
    expect(resolution.available).toBe(true);
    if (!resolution.available) return;
    expect(resolution.system.mode).toContain('extraction=graphiti');
    const signal = new AbortController().signal;
    const session = await resolution.system.create({ corpusId: 'c0', seed: 3, signal });
    await session.ingest([
      { id: 'chunk-a', text: 'The orchid needs water every Tuesday.', speaker: 'Mel' },
      { id: 'chunk-b', text: 'Mountain weather is unrelated.' },
    ], { signal });
    expect(added).toEqual(['matched-c0-3']);
    expect(await session.retrieve({ query: 'orchid', limit: 5, signal })).toEqual(['chunk-a']);
    expect(await session.retrieve({ query: 'nothing here', limit: 5, signal })).toEqual([]);
    await session.close();
    expect(deleted).toEqual(['matched-c0-3']);
  });
});

describe('the Mem0 OSS adapter', () => {
  /**
   * A stand-in for `mem0ai/oss`, written to disk because the adapter loads its
   * SDK by absolute URL. It records the configuration it was handed on a named
   * global, which is the only channel a separately-loaded module shares with the
   * test.
   */
  interface Captured { config?: Record<string, any>; adds: any[]; searches: any[]; deleted: string[] }
  const fakeModuleUrl = (channel: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'matched-mem0-fake-'));
    const file = join(dir, 'fake-oss.mjs');
    writeFileSync(file, `const seen = globalThis[${JSON.stringify(channel)}];
let counter = 0;
const rows = [];
export class Memory {
  constructor(config) { seen.config = config; }
  async add(text, config) {
    seen.adds.push({ text, config });
    const id = 'm' + (++counter);
    rows.push({ id, text, metadata: config.metadata });
    return { results: [{ id, memory: text, metadata: config.metadata }] };
  }
  async search(query, config) {
    seen.searches.push({ query, config });
    const hits = rows.filter(row => row.text.toLowerCase().includes(query.toLowerCase())).slice(0, config.topK);
    return { results: hits.map(row => ({ id: row.id, memory: row.text, metadata: row.metadata })) };
  }
  async delete(id) { seen.deleted.push(id); const at = rows.findIndex(row => row.id === id); if (at >= 0) rows.splice(at, 1); return {}; }
}
`);
    return file;
  };

  it('drives the OSS client offline: no LLM, no telemetry, no history, isolated store', async () => {
    const channel = '__matchedMem0Captured';
    const captured: Captured = { adds: [], searches: [], deleted: [] };
    (globalThis as Record<string, unknown>)[channel] = captured;
    const dir = mkdtempSync(join(tmpdir(), 'matched-mem0-data-'));
    const url = fakeModuleUrl(channel);
    const previous = process.env.MEM0_TELEMETRY;
    delete process.env.MEM0_TELEMETRY;
    try {
      const { createMem0Factory } = await import('../src/evaluation/matched-mem0.js');
      const embedder = { model: 'test-embedder@1', dimensions: 8, embed: (texts: string[]) => Promise.resolve(texts.map(() => Array.from({ length: 8 }, () => 0.5))) };
      const factory = createMem0Factory({ embedder, moduleSpecifier: url, versionSpecifier: url, dataDir: dir });
      const resolution = await factory.resolve({ seed: 0, signal: new AbortController().signal });
      expect(resolution.available).toBe(true);
      if (!resolution.available) return;
      expect(resolution.system.mode).toContain('extraction=off(infer:false)');
      expect(resolution.system.mode).toContain('embedder=injected:test-embedder@1');
      expect(resolution.system.mode).toContain('telemetry=disabled');

      const signal = new AbortController().signal;
      const session = await resolution.system.create({ corpusId: 'c0', seed: 1, signal });
      expect(process.env.MEM0_TELEMETRY).toBe('false');
      expect(captured.config?.disableHistory).toBe(true);
      expect(captured.config?.vectorStore.provider).toBe('memory');
      // Mem0's "memory" store is a SQLite file that otherwise defaults to a shared
      // path in the home directory, so two corpora would see each other's passages.
      expect(String(captured.config?.vectorStore.config.dbPath).startsWith(dir)).toBe(true);
      expect(captured.config?.llm.provider).toBe('langchain');
      expect(() => (captured.config?.llm.config.model as { invoke(): never }).invoke()).toThrow('The run is void');

      await session.ingest([
        { id: 'chunk-a', text: 'The orchid needs water every Tuesday.', speaker: 'Mel' },
        { id: 'chunk-b', text: 'Mountain weather is unrelated.' },
      ], { signal });
      expect(captured.adds.every(entry => entry.config.infer === false)).toBe(true);
      expect(captured.adds[0].text).toBe('Mel: The orchid needs water every Tuesday.');
      expect(captured.adds[0].config.metadata.matched_chunk_id).toBe('chunk-a');
      expect(await session.retrieve({ query: 'orchid', limit: 5, signal })).toEqual(['chunk-a']);
      expect(captured.searches[0].config.filters.user_id).toBe('matched-c0');
      await session.forget!(['chunk-a'], { signal });
      expect(captured.deleted).toEqual(['m1']);
      expect(await session.retrieve({ query: 'orchid', limit: 5, signal })).toEqual([]);
      await session.close();
      expect(existsSync(String(captured.config?.vectorStore.config.dbPath))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.MEM0_TELEMETRY; else process.env.MEM0_TELEMETRY = previous;
      delete (globalThis as Record<string, unknown>)[channel];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an absent SDK as an install instruction rather than failing the run', async () => {
    const { createMem0Factory } = await import('../src/evaluation/matched-mem0.js');
    const embedder = { model: 'test-embedder@1', dimensions: 8, embed: () => Promise.resolve([]) };
    const resolution = await createMem0Factory({ embedder, moduleSpecifier: '/definitely/not/installed/mem0.mjs' }).resolve({ seed: 0, signal: new AbortController().signal });
    expect(resolution.available).toBe(false);
    if (!resolution.available) expect(resolution.reason).toContain('mem0ai is not installed');
  });

  it('refuses an extraction:llm configuration with no explicit LLM', () => {
    expect(() => createZepFactory({ baseDir: tmpdir() }).id).not.toThrow();
    return import('../src/evaluation/matched-mem0.js').then(({ createMem0Factory }) => {
      expect(() => createMem0Factory({ extraction: 'llm' })).toThrow('requires an explicit llm configuration');
    });
  });
});
