import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatedDescribe } from './env-gates.js';
import { connect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns';
import {
  BUNDLED_EMBEDDING_ID, BUNDLED_EMBEDDING_MODEL, bundledModelStatus, createBundledEmbedder,
  encodeWordPiece, basicTokenize, loadWordPieceVocabulary, LocalEmbeddingModelUnavailableError,
  type SyncMemoryEmbedder,
} from '../src/local/embedding/index.js';
import { readFileSync } from 'node:fs';
import { bundledModelFilePath } from '../src/local/embedding/model-assets.js';

const cached = bundledModelStatus().present;
/** The model cache is populated once by `npm run setup:embedder`. */
const withModel = gatedDescribe('model', cached);
const open: SyncMemoryEmbedder[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); open.splice(0).forEach(embedder => embedder.close()); });

describe('WordPiece tokenization', () => {
  const vocabulary = loadWordPieceVocabulary(cached ? readFileSync(bundledModelFilePath('vocabulary'), 'utf8') : '[PAD]\n[UNK]\n[CLS]\n[SEP]\nhello\nworld\n');

  it('lowercases, strips accents and splits on punctuation like the reference tokenizer', () => {
    expect(basicTokenize("Café — don't STOP.")).toEqual(['cafe', '—', 'don', "'", 't', 'stop', '.']);
  });

  it('isolates CJK characters into their own tokens', () => {
    expect(basicTokenize('ab 中文 cd')).toEqual(['ab', '中', '文', 'cd']);
  });

  it('treats ASCII symbols as punctuation but keeps digits attached', () => {
    expect(basicTokenize('sku1200-b')).toEqual(['sku1200', '-', 'b']);
  });

  it('wraps every sequence in [CLS] and [SEP]', () => {
    const { ids, truncated } = encodeWordPiece('hello world', vocabulary, 512);
    expect(ids[0]).toBe(vocabulary.cls);
    expect(ids[ids.length - 1]).toBe(vocabulary.sep);
    expect(truncated).toBe(false);
  });

  it('truncates to the model window and reports it rather than silently cutting', () => {
    const { ids, truncated } = encodeWordPiece('hello world '.repeat(500), vocabulary, 32);
    expect(ids).toHaveLength(32);
    expect(ids[31]).toBe(vocabulary.sep);
    expect(truncated).toBe(true);
  });

  it('maps a word longer than 100 characters to [UNK]', () => {
    const { ids } = encodeWordPiece('a'.repeat(101), vocabulary, 512);
    expect(ids).toEqual([vocabulary.cls, vocabulary.unk, vocabulary.sep]);
  });
});

withModel('WordPiece parity with the reference tokenizer', () => {
  it('reproduces HuggingFace token identifiers exactly for accents, CJK, emoji, symbols and overlong words', () => {
    const vocabulary = loadWordPieceVocabulary(readFileSync(bundledModelFilePath('vocabulary'), 'utf8'));
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/wordpiece-reference.json', import.meta.url), 'utf8')) as { cases: { text: string; ids: number[] }[] };
    expect(fixture.cases.length).toBeGreaterThanOrEqual(14);
    for (const item of fixture.cases) expect(encodeWordPiece(item.text, vocabulary, 512).ids, item.text.slice(0, 60)).toEqual(item.ids);
  });
});

withModel('bundled local ONNX embedder', () => {
  const embedder = (): SyncMemoryEmbedder => { const value = createBundledEmbedder(); open.push(value); return value; };

  it('returns one L2-normalized vector of the declared width per text', () => {
    const vectors = embedder().embedSync(['The deployment credentials live in the ops vault.', 'Melanie painted a sunrise.']);
    expect(vectors).toHaveLength(2);
    for (const vector of vectors) {
      expect(vector).toHaveLength(BUNDLED_EMBEDDING_MODEL.dimensions);
      expect(vector).toHaveLength(384);
      expect(vector.every(value => Number.isFinite(value))).toBe(true);
      expect(Math.hypot(...vector)).toBeCloseTo(1, 5);
    }
  });

  it('declares a model identity that pins repository, revision, dtype and pooling', () => {
    const value = embedder();
    expect(value.model).toBe(BUNDLED_EMBEDDING_ID);
    expect(value.model).toContain(BUNDLED_EMBEDDING_MODEL.revision);
    expect(value.model).toContain('int8');
    expect(value.dimensions).toBe(384);
  });

  it('is deterministic for the same text in the same process', () => {
    const value = embedder();
    expect(value.embedSync(['a stable sentence'])[0]).toEqual(value.embedSync(['a stable sentence'])[0]);
  });

  it('places a relevant passage nearer the query than an unrelated one', () => {
    const value = embedder();
    const [query] = value.embedSync(['Where are the deployment keys kept?'], 'query');
    const [relevant, unrelated] = value.embedSync([
      'The deployment credentials are stored in the vault under ops/prod.',
      'Melanie painted a sunrise over the harbour last summer.',
    ], 'passage');
    const cosine = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);
    expect(cosine(query, relevant)).toBeGreaterThan(cosine(query, unrelated));
    expect(cosine(query, relevant)).toBeGreaterThan(0.5);
  });

  it('applies the asymmetric query convention only to the query view, in one shared vector space', async () => {
    const value = embedder();
    const signal = new AbortController().signal;
    const asQuery = await value.forQueries().embed(['deployment keys'], { signal });
    const asPassage = await value.forPassages().embed(['deployment keys'], { signal });
    expect(value.forQueries().model).toBe(value.forPassages().model);
    expect(asQuery[0]).not.toEqual(asPassage[0]);
    expect(asQuery[0]).toEqual(value.embedSync(['deployment keys'], 'query')[0]);
  });

  it('loads and embeds with every JavaScript network entry point disabled', () => {
    // Proves the query path performs no JS-level network I/O. It cannot prove a
    // native library opened no socket; onnxruntime does not, and the weights are
    // read from a digest-verified local file.
    const blocked = () => { throw new Error('network access attempted'); };
    vi.stubGlobal('fetch', blocked);
    const netSpy = vi.spyOn({ connect }, 'connect').mockImplementation(blocked as never);
    const httpSpy = vi.spyOn({ httpRequest }, 'httpRequest').mockImplementation(blocked as never);
    const httpsSpy = vi.spyOn({ httpsRequest }, 'httpsRequest').mockImplementation(blocked as never);
    const dnsSpy = vi.spyOn({ lookup }, 'lookup').mockImplementation(blocked as never);
    const offline = createBundledEmbedder();
    open.push(offline);
    const vector = offline.embedSync(['offline retrieval must never reach the network'])[0];
    expect(vector).toHaveLength(384);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 5);
    for (const spy of [netSpy, httpSpy, httpsSpy, dnsSpy]) expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an absent cache with actionable guidance instead of downloading', () => {
    expect(() => createBundledEmbedder({ cacheDir: '/tmp/mnemosyne-absent-model-cache-t11' }))
      .toThrow(LocalEmbeddingModelUnavailableError);
    expect(() => createBundledEmbedder({ cacheDir: '/tmp/mnemosyne-absent-model-cache-t11' }))
      .toThrow(/setup:embedder/);
  });
});
