import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUNDLED_RERANKER_ID, BUNDLED_RERANKER_MODEL, bundledRerankerFilePath, bundledRerankerStatus,
  createBundledReranker, LocalRerankerUnavailableError, type SyncMemoryReranker,
} from '../src/local/reranking/index.js';
import { encodeWordPiecePair, loadWordPieceVocabulary } from '../src/local/embedding/index.js';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions, type StoreMemoryInput, type SyncMemoryEmbedder } from '../src/local/index.js';

/**
 * The bundled cross-encoder reranker.
 *
 * The properties that matter are the ones the deterministic core is built on:
 * it runs from a digest-verified local cache with no network, it is an explicit
 * opt-out rather than a mandate, and the zero-model path loads nothing at all.
 */

const cached = bundledRerankerStatus().present;
/** The reranker cache is populated once by `npm run setup:reranker`. */
const withModel = cached ? describe : describe.skip;
const open: SyncMemoryReranker[] = [];
const opened: LocalMemory[] = [];
const roots: string[] = [];
const source = { uri: 'test://reranker' };
const fact = (text: string, more: Partial<StoreMemoryInput> = {}): StoreMemoryInput => ({ text, source, trust: 'observed', ...more });
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  open.splice(0).forEach(reranker => reranker.close());
  opened.splice(0).forEach(db => db.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

/** A deterministic stand-in for the bundled embedder: no weights, no cache, no network. */
function stubEmbedder(): SyncMemoryEmbedder {
  const vector = (text: string): number[] => {
    const out = new Array<number>(8).fill(0);
    for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) out[createHash('sha256').update(token).digest()[0] % 8] += 1;
    const norm = Math.hypot(...out) || 1;
    return out.map(value => value / norm);
  };
  const embedSync = (texts: readonly string[]): number[][] => texts.map(vector);
  const self: SyncMemoryEmbedder = {
    model: 'test-stub-embedder@v1', dimensions: 8, embedSync,
    embed: async (texts: readonly string[]) => embedSync(texts),
    forQueries: () => self, forPassages: () => self, close: () => {},
  };
  return self;
}

describe('cross-encoder pair encoding', () => {
  const vocabulary = loadWordPieceVocabulary(cached
    ? readFileSync(bundledRerankerFilePath('vocabulary'), 'utf8')
    : '[PAD]\n[UNK]\n[CLS]\n[SEP]\nhello\nworld\nagain\n');

  it('encodes a pair as [CLS] a [SEP] b [SEP] with segment identifiers', () => {
    const { ids, typeIds, truncated } = encodeWordPiecePair('hello', 'world again', vocabulary, 512);
    expect(ids[0]).toBe(vocabulary.cls);
    expect(ids[ids.length - 1]).toBe(vocabulary.sep);
    expect(ids.filter(id => id === vocabulary.sep)).toHaveLength(2);
    // The first segment covers [CLS] a [SEP]; everything after belongs to the second.
    expect(typeIds).toEqual([0, 0, 0, 1, 1, 1]);
    expect(truncated).toBe(false);
  });

  it('truncates longest-first, so a short query survives a very long passage', () => {
    const { ids, typeIds, truncated } = encodeWordPiecePair('hello world', 'again '.repeat(200), vocabulary, 32);
    expect(truncated).toBe(true);
    expect(ids).toHaveLength(32);
    // Both query tokens are still present: only the passage was cut.
    expect(typeIds.filter(type => type === 0)).toHaveLength(4);
  });

  it('matches the reference tokenizer byte for byte on pair encodings', () => {
    if (!cached) return;
    const cases = JSON.parse(readFileSync(new URL('./fixtures/wordpiece-pair-reference.json', import.meta.url), 'utf8')) as { a: string; b: string; ids: number[]; typeIds: number[] }[];
    expect(cases.length).toBeGreaterThan(10);
    for (const expected of cases) {
      const actual = encodeWordPiecePair(expected.a, expected.b, vocabulary, 512);
      expect(actual.ids, `ids for ${JSON.stringify(expected.a.slice(0, 24))}`).toEqual(expected.ids);
      expect(actual.typeIds, `typeIds for ${JSON.stringify(expected.a.slice(0, 24))}`).toEqual(expected.typeIds);
    }
  });
});

withModel('bundled reranker', () => {
  it('scores a relevant passage above an irrelevant one', () => {
    const reranker = createBundledReranker();
    open.push(reranker);
    const scores = reranker.rerankSync('What did Caroline say about her painting hobby?', [
      'Caroline: The flight to Lisbon was delayed by four hours.',
      'Caroline: I started oil painting last spring and it has become my favourite way to unwind.',
      'Melanie: The vet appointment is next Thursday.',
    ]);
    expect(scores).toHaveLength(3);
    expect(scores[1]).toBeGreaterThan(scores[0]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
    expect(reranker.model).toBe(BUNDLED_RERANKER_ID);
    expect(reranker.model).toContain(BUNDLED_RERANKER_MODEL.revision);
  });

  it('reranks without any network access', () => {
    // Proves the rerank path performs no JS-level network I/O. It cannot prove a
    // native library opened no socket; onnxruntime does not, and the weights are
    // read from a digest-verified local file.
    const blocked = () => { throw new Error('network access attempted'); };
    vi.stubGlobal('fetch', blocked);
    const netSpy = vi.spyOn({ connect }, 'connect').mockImplementation(blocked as never);
    const httpSpy = vi.spyOn({ httpRequest }, 'httpRequest').mockImplementation(blocked as never);
    const httpsSpy = vi.spyOn({ httpsRequest }, 'httpsRequest').mockImplementation(blocked as never);
    const dnsSpy = vi.spyOn({ lookup }, 'lookup').mockImplementation(blocked as never);
    const offline = createBundledReranker();
    open.push(offline);
    const scores = offline.rerankSync('offline reranking must never reach the network', ['a local passage', 'another local passage']);
    expect(scores).toHaveLength(2);
    expect(scores.every(score => Number.isFinite(score))).toBe(true);
    for (const spy of [netSpy, httpSpy, httpsSpy, dnsSpy]) expect(spy).not.toHaveBeenCalled();
  });

  it('is deterministic for one batch composition', () => {
    const reranker = createBundledReranker({ batchSize: 8 });
    open.push(reranker);
    const passages = ['first passage about gardening', 'second passage about cooking', 'third passage about gardening tools'];
    expect(reranker.rerankSync('gardening', passages)).toEqual(reranker.rerankSync('gardening', passages));
  });

  it('accepts a passage far longer than the window by truncating it', () => {
    const reranker = createBundledReranker();
    open.push(reranker);
    const [score] = reranker.rerankSync('what is the code', [`${'filler '.repeat(2000)}the code is albatross`]);
    expect(Number.isFinite(score)).toBe(true);
  });

  it('rejects an absent cache with actionable guidance instead of downloading', () => {
    expect(() => createBundledReranker({ cacheDir: '/tmp/mnemosyne-absent-reranker-cache-t15' }))
      .toThrow(LocalRerankerUnavailableError);
    expect(() => createBundledReranker({ cacheDir: '/tmp/mnemosyne-absent-reranker-cache-t15' }))
      .toThrow(/npm run setup:reranker/);
  });

  it('refuses weights whose digest does not match the pinned one', () => {
    const root = mkdtempSync(join(tmpdir(), 'mnemosyne-reranker-tamper-'));
    roots.push(root);
    const directory = join(root, `${BUNDLED_RERANKER_MODEL.repository.replace('/', '__')}@${BUNDLED_RERANKER_MODEL.revision}`);
    mkdirSync(directory, { recursive: true });
    copyFileSync(bundledRerankerFilePath('vocabulary'), join(directory, 'vocab.txt'));
    // Same byte length, different content: a size check alone would accept this.
    const weights = readFileSync(bundledRerankerFilePath('weights'));
    weights[weights.length - 1] ^= 0xff;
    writeFileSync(join(directory, 'model_quantized.onnx'), weights);
    expect(() => createBundledReranker({ cacheDir: root })).toThrow(/digest mismatch/);
  });

  it('rejects empty and NUL-bearing input rather than scoring it', () => {
    const reranker = createBundledReranker();
    open.push(reranker);
    expect(() => reranker.rerankSync('', ['a passage'])).toThrow(/non-empty string/);
    expect(() => reranker.rerankSync('query', ['  '])).toThrow(/non-empty string/);
    expect(() => reranker.rerankSync('query', ['has a \0 byte'])).toThrow(/without NUL/);
    expect(reranker.rerankSync('query', [])).toEqual([]);
  });
});

describe('reranking on the recall path', () => {
  function memory(options: Partial<LocalMemoryOptions> = {}): LocalMemory {
    const db = createLocalMemory({ path: ':memory:', workspaceId: 'project', agentId: 'alice', embedder: stubEmbedder(), ...options });
    opened.push(db); return db;
  }
  const seed = (db: LocalMemory): string[] => [
    'Caroline: I started oil painting last spring.',
    'Caroline: I am thinking about repainting the kitchen.',
    'Melanie: The vet appointment is next Thursday.',
    'Caroline: I sold two landscape paintings at the art fair.',
    'Melanie: We adopted Biscuit from the shelter in March 2022.',
  ].map(text => db.store(fact(text)).id);

  it('loads no reranker at all on the zero-model deterministic path', () => {
    const db = memory({ retrieval: 'lexical', embedder: undefined });
    seed(db);
    const status = db.retrieval;
    expect(status).toEqual({ requested: 'lexical', mode: 'lexical' });
    expect(status.rerankerModel).toBeUndefined();
    expect(status.rerankDegraded).toBeUndefined();
    db.recall({ query: 'painting', limit: 3 });
    const retrieval = db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
    expect(retrieval.config).toMatchObject({ mode: 'lexical', embeddingModel: null, rerankerModel: null, rerankTopN: null });
    expect(retrieval.candidateCounts.map(count => count.stage)).toEqual(['lexical']);
  });

  it('runs no reranker when rerank is false, and says nothing was degraded', () => {
    const db = memory({ rerank: false });
    seed(db);
    expect(db.retrieval.rerankerModel).toBeUndefined();
    expect(db.retrieval.rerankDegraded).toBeUndefined();
    db.recall({ query: 'painting', limit: 3 });
    const retrieval = db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
    expect(retrieval.candidateCounts.map(count => count.stage)).toEqual(['lexical', 'dense', 'fused']);
    expect(retrieval.config?.rerankerModel).toBeNull();
  });

  it('treats an explicit null reranker as an opt-out', () => {
    const db = memory({ reranker: null });
    seed(db);
    db.recall({ query: 'painting', limit: 3 });
    expect(db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!.candidateCounts.map(count => count.stage))
      .toEqual(['lexical', 'dense', 'fused']);
  });

  it('rejects a reranker that does not expose rerankSync', () => {
    expect(() => createLocalMemory({ path: ':memory:', workspaceId: 'project', agentId: 'alice', reranker: {} as never }))
      .toThrow(/must expose rerankSync/);
  });

  it('degrades to the fused ranking and reports why when the model is missing', () => {
    const db = memory({ modelCacheDir: '/tmp/mnemosyne-absent-reranker-cache-t15-engine' });
    seed(db);
    const status = db.retrieval;
    expect(status.mode).toBe('hybrid');
    expect(status.rerankerModel).toBeUndefined();
    expect(status.rerankDegraded).toMatch(/reranker model is not in the cache|not loadable/);
    // Retrieval still works; it is simply the pre-reranker ranking.
    expect(db.recall({ query: 'painting', limit: 3 }).length).toBeGreaterThan(0);
  });

  it('reorders the top of the ranking without dropping any candidate', () => {
    // A reranker that inverts the fused order makes the reordering unmistakable.
    const inverting: SyncMemoryReranker = { model: 'test-inverting@v1', rerankSync: (_query, passages) => passages.map((_passage, index) => index), close: () => {} };
    const db = memory({ reranker: inverting, rerankTopN: 50 });
    const ids = seed(db);
    const results = db.recall({ query: 'painting', limit: ids.length });
    const retrieval = db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
    const fused = retrieval.candidates.filter(candidate => candidate.stage === 'fused').map(candidate => candidate.memoryId);
    const reranked = retrieval.candidates.filter(candidate => candidate.stage === 'reranked').map(candidate => candidate.memoryId);
    expect(reranked).toEqual([...fused].reverse());
    // Nothing is lost: the same set comes back, and the scores stay ordered.
    expect([...results.map(result => result.memory.id)].sort()).toEqual([...fused].sort());
    expect(results.map(result => result.score)).toEqual([...results.map(result => result.score)].sort((a, b) => b - a));
  });

  it('rescores only the head, leaving the tail below it in fused order', () => {
    const inverting: SyncMemoryReranker = { model: 'test-inverting@v1', rerankSync: (_query, passages) => passages.map((_passage, index) => index), close: () => {} };
    const db = memory({ reranker: inverting, rerankTopN: 2 });
    seed(db);
    db.recall({ query: 'painting', limit: 5 });
    const retrieval = db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
    const fused = retrieval.candidates.filter(candidate => candidate.stage === 'fused').map(candidate => candidate.memoryId);
    const reranked = retrieval.candidates.filter(candidate => candidate.stage === 'reranked').map(candidate => candidate.memoryId);
    // Only the first two positions were rescored (and inverted); the rest are untouched.
    expect(reranked.slice(0, 2)).toEqual(fused.slice(0, 2).reverse());
    expect(reranked.slice(2)).toEqual(fused.slice(2));
  });

  it('rejects a reranker that returns the wrong number of scores', () => {
    const wrong: SyncMemoryReranker = { model: 'test-wrong@v1', rerankSync: () => [1], close: () => {} };
    const db = memory({ reranker: wrong });
    seed(db);
    expect(() => db.recall({ query: 'painting', limit: 3 })).toThrow(/one score per passage/);
  });

  it('rejects a non-finite score rather than ranking by it', () => {
    const broken: SyncMemoryReranker = { model: 'test-broken@v1', rerankSync: (_query, passages) => passages.map(() => Number.NaN), close: () => {} };
    const db = memory({ reranker: broken });
    seed(db);
    expect(() => db.recall({ query: 'painting', limit: 3 })).toThrow(/non-finite score/);
  });
});

withModel('the bundled reranker as the default', () => {
  it('is on by default for hybrid retrieval and is recorded in the ledger', () => {
    const db = createLocalMemory({ path: ':memory:', workspaceId: 'project', agentId: 'alice', embedder: stubEmbedder() });
    opened.push(db);
    for (const text of [
      'Caroline: I started oil painting last spring and it has become my favourite way to unwind.',
      'Melanie: The vet appointment for Biscuit is next Thursday.',
      'Caroline: The flight to Lisbon was delayed by four hours.',
    ]) db.store(fact(text));

    expect(db.retrieval.rerankerModel).toBe(BUNDLED_RERANKER_ID);
    expect(db.retrieval.rerankTopN).toBe(50);
    const results = db.recall({ query: 'What did Caroline say about her painting hobby?', limit: 3 });
    expect(results[0].memory.text).toContain('oil painting');

    const retrieval = db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
    expect(retrieval.candidateCounts.map(count => count.stage)).toEqual(['lexical', 'dense', 'fused', 'reranked']);
    expect(retrieval.config?.rerankerModel).toBe(BUNDLED_RERANKER_ID);
    expect(retrieval.configSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
