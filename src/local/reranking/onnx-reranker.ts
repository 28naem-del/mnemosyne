import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type { SyncMemoryReranker } from '../types.js';
import { countWordPieces, encodeWordPiecePair, loadWordPieceVocabulary, type WordPieceVocabulary } from '../embedding/wordpiece.js';
import { BUNDLED_RERANKER_ID, BUNDLED_RERANKER_MODEL, bundledRerankerFilePath, bundledRerankerStatus, verifyBundledReranker } from './model-assets.js';

/**
 * The bundled local reranker: int8 ONNX `ms-marco-MiniLM-L-6-v2` executed
 * in-process by `onnxruntime-node`, over the shared WordPiece tokenizer.
 *
 * It is SYNCHRONOUS, for the same reason the embedder is: the onnxruntime-node
 * native binding runs inference synchronously, and the package's public
 * `InferenceSession` only wraps that call in `setImmediate`. Driving the binding
 * directly keeps `LocalMemory.recall()` a synchronous function, so reranking can
 * be on by default without turning every caller of the kernel into an async one.
 *
 * A cross-encoder scores a query and a passage JOINTLY in one forward pass, so
 * unlike the bi-encoder there is nothing to cache per record: cost is one model
 * pass per candidate, per query. That is why only the head of the fused ranking
 * is rescored.
 *
 * No network access occurs here. Weights are read from a digest-verified local
 * cache; populating that cache is a separate, explicit setup step.
 */

export interface BundledRerankerOptions {
  /** Absolute model cache directory. Defaults to MNEMOSYNE_MODEL_CACHE, then the user cache directory. */
  cacheDir?: string;
  /** Pairs per inference call, 1–64. Larger batches pad to the longest member. */
  batchSize?: number;
  /** Verify the pinned SHA-256 of every artifact before loading. Defaults to true. */
  verifyDigest?: boolean;
  /** ONNX intra-op thread count. Left to onnxruntime when omitted. */
  threads?: number;
}

interface NativeSession {
  loadModel(modelPath: string, options: Record<string, unknown>): void;
  readonly inputMetadata: { name: string }[];
  readonly outputMetadata: { name: string }[];
  run(feeds: Record<string, unknown>, fetches: Record<string, unknown>, options: Record<string, unknown>): Record<string, { dims: number[]; data?: Float32Array; cpuData?: Float32Array }>;
  dispose(): void;
}
interface NativeBinding { binding: { InferenceSession: new () => NativeSession }; initOrt: () => void }
interface TensorModule { Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown }

export class LocalRerankerUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'LocalRerankerUnavailableError'; }
}

function loadRuntime(): { binding: NativeBinding; Tensor: TensorModule['Tensor'] } {
  const require = createRequire(import.meta.url);
  try {
    const binding = require('onnxruntime-node/dist/binding.js') as NativeBinding;
    const { Tensor } = require('onnxruntime-common') as TensorModule;
    binding.initOrt();
    return { binding, Tensor };
  } catch (cause) {
    throw new LocalRerankerUnavailableError(`onnxruntime-node is not loadable in this environment (${cause instanceof Error ? cause.message : 'unknown error'}). Construct the memory with rerank: false to keep the fused ranking.`);
  }
}

class BundledRerankerEngine {
  readonly model = BUNDLED_RERANKER_ID;
  readonly #session: NativeSession;
  readonly #Tensor: TensorModule['Tensor'];
  readonly #vocabulary: WordPieceVocabulary;
  readonly #outputName: string;
  readonly #batchSize: number;
  readonly #typeIds: boolean;
  #closed = false;

  constructor(options: BundledRerankerOptions) {
    const batchSize = options.batchSize ?? 16;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 64) throw new TypeError('batchSize must be between 1 and 64');
    if (options.threads !== undefined && (!Number.isSafeInteger(options.threads) || options.threads < 1 || options.threads > 64)) throw new TypeError('threads must be between 1 and 64');
    this.#batchSize = batchSize;
    const status = bundledRerankerStatus(options.cacheDir);
    if (!status.present) {
      throw new LocalRerankerUnavailableError(`The pinned local reranker model is not in the cache at ${status.directory}. `
        + 'Run "npm run setup:reranker" once with network access, or construct the memory with rerank: false to keep the fused ranking.');
    }
    if (options.verifyDigest !== false) verifyBundledReranker(options.cacheDir);
    this.#vocabulary = loadWordPieceVocabulary(readFileSync(bundledRerankerFilePath('vocabulary', options.cacheDir), 'utf8'));
    const runtime = loadRuntime();
    this.#Tensor = runtime.Tensor;
    this.#session = new runtime.binding.binding.InferenceSession();
    this.#session.loadModel(bundledRerankerFilePath('weights', options.cacheDir), {
      ...(options.threads === undefined ? {} : { intraOpNumThreads: options.threads }),
      graphOptimizationLevel: 'all', executionMode: 'sequential',
    });
    this.#typeIds = this.#session.inputMetadata.some(entry => entry.name === 'token_type_ids');
    const outputs = this.#session.outputMetadata.map(entry => entry.name);
    const logits = outputs.find(name => name === 'logits');
    if (!logits) throw new Error(`The pinned reranker does not expose logits (found: ${outputs.join(', ')})`);
    this.#outputName = logits;
  }

  #assertOpen(): void { if (this.#closed) throw new Error('Local reranker is closed'); }

  /** Exact, because it runs the same `pieces()` path `encodeWordPiecePair` runs. */
  countTokens(text: string): number {
    this.#assertOpen();
    return countWordPieces(text, this.#vocabulary);
  }

  rerankSync(query: string, passages: readonly string[]): number[] {
    this.#assertOpen();
    if (typeof query !== 'string' || !query.trim() || query.includes('\0')) throw new TypeError('Rerank query must be a non-empty string without NUL');
    if (!Array.isArray(passages)) throw new TypeError('rerankSync requires an array of passages');
    for (const passage of passages) {
      if (typeof passage !== 'string' || !passage.trim() || passage.includes('\0')) throw new TypeError('Rerank passage must be a non-empty string without NUL');
      if (Buffer.byteLength(passage) > 65_536) throw new TypeError('Rerank passage exceeds 65536 bytes');
    }
    if (!passages.length) return [];
    const scores: number[] = [];
    for (let offset = 0; offset < passages.length; offset += this.#batchSize) scores.push(...this.#runBatch(query, passages.slice(offset, offset + this.#batchSize)));
    return scores;
  }

  #runBatch(query: string, passages: readonly string[]): number[] {
    const encoded = passages.map(passage => encodeWordPiecePair(query, passage, this.#vocabulary, BUNDLED_RERANKER_MODEL.maxTokens));
    const rows = encoded.length, columns = Math.max(...encoded.map(entry => entry.ids.length));
    const ids = new BigInt64Array(rows * columns), mask = new BigInt64Array(rows * columns), types = new BigInt64Array(rows * columns);
    // Remaining positions stay at the pad identifier with a zero attention mask.
    for (let row = 0; row < rows; row++) for (let column = 0; column < encoded[row].ids.length; column++) {
      ids[row * columns + column] = BigInt(encoded[row].ids[column]);
      mask[row * columns + column] = 1n;
      types[row * columns + column] = BigInt(encoded[row].typeIds[column]);
    }
    const feeds: Record<string, unknown> = {
      input_ids: new this.#Tensor('int64', ids, [rows, columns]),
      attention_mask: new this.#Tensor('int64', mask, [rows, columns]),
    };
    if (this.#typeIds) feeds.token_type_ids = new this.#Tensor('int64', types, [rows, columns]);
    const output = this.#session.run(feeds, { [this.#outputName]: null }, {})[this.#outputName];
    const data = output.data ?? output.cpuData;
    if (!data) throw new Error('The local reranker returned no logits');
    // A single regression head: one relevance score per pair, on the model's own scale.
    const width = output.dims.length > 1 ? output.dims[output.dims.length - 1] : 1;
    if (width !== 1) throw new Error(`The local reranker returned ${width} logits per pair, expected 1`);
    const scores: number[] = [];
    for (let row = 0; row < rows; row++) {
      const score = Number(data[row]);
      if (!Number.isFinite(score)) throw new Error('The local reranker produced a non-finite score');
      scores.push(score);
    }
    return scores;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#session.dispose();
  }
}

/**
 * Loads the pinned int8 cross-encoder from the verified local cache. Never downloads.
 *
 * Returns a frozen plain object rather than a class instance, for the same reason
 * the embedder does: the kernel's adapter validation only accepts plain objects,
 * so an adapter cannot smuggle prototype behaviour into the retrieval path.
 */
export function createBundledReranker(options: BundledRerankerOptions = {}): SyncMemoryReranker {
  const engine = new BundledRerankerEngine(options);
  return Object.freeze({
    model: engine.model,
    rerankSync: (query: string, passages: readonly string[]) => engine.rerankSync(query, passages),
    close: () => engine.close(),
  });
}
