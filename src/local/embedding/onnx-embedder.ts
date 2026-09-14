import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type { MemoryEmbedder, SyncMemoryEmbedder } from '../types.js';
import { BUNDLED_EMBEDDING_ID, BUNDLED_EMBEDDING_MODEL, bundledModelFilePath, bundledModelStatus, verifyBundledModel } from './model-assets.js';
import { encodeWordPiece, loadWordPieceVocabulary, type WordPieceVocabulary } from './wordpiece.js';

/**
 * The bundled local embedder: int8 ONNX `bge-small-en-v1.5` executed in-process
 * by `onnxruntime-node`, with a local WordPiece tokenizer.
 *
 * It is SYNCHRONOUS. The onnxruntime-node native binding runs inference
 * synchronously; the package's public `InferenceSession` only wraps that call in
 * `setImmediate`. Using the binding directly keeps `LocalMemory.recall()` a
 * synchronous function, so hybrid retrieval can be the default without turning
 * every caller of the kernel into an async one, and without a worker-thread
 * round trip on the query path.
 *
 * No network access occurs here. Weights are read from a digest-verified local
 * cache; populating that cache is a separate, explicit setup step.
 */
export type { SyncMemoryEmbedder } from '../types.js';

export type EmbeddingRole = 'query' | 'passage';

export interface BundledEmbedderOptions {
  /** Absolute model cache directory. Defaults to MNEMOSYNE_MODEL_CACHE, then the user cache directory. */
  cacheDir?: string;
  /** Default role for the async `embed` entry point. Defaults to `passage`. */
  role?: EmbeddingRole;
  /** Texts per inference call, 1–64. Larger batches pad to the longest member. */
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
interface NativeBinding {
  binding: { InferenceSession: new () => NativeSession };
  initOrt: () => void;
}
interface TensorModule { Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown }

export class LocalEmbeddingModelUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'LocalEmbeddingModelUnavailableError'; }
}

function loadRuntime(): { binding: NativeBinding; Tensor: TensorModule['Tensor'] } {
  const require = createRequire(import.meta.url);
  try {
    // The synchronous native session is reached through the package's own
    // loader module; the published entry point only adds an async wrapper.
    const binding = require('onnxruntime-node/dist/binding.js') as NativeBinding;
    const { Tensor } = require('onnxruntime-common') as TensorModule;
    binding.initOrt();
    return { binding, Tensor };
  } catch (cause) {
    throw new LocalEmbeddingModelUnavailableError(`onnxruntime-node is not loadable in this environment (${cause instanceof Error ? cause.message : 'unknown error'}). Use retrieval: 'lexical' for the zero-model deterministic path.`);
  }
}

class BundledEmbedderEngine {
  readonly model = BUNDLED_EMBEDDING_ID;
  readonly dimensions = BUNDLED_EMBEDDING_MODEL.dimensions;
  readonly #session: NativeSession;
  readonly #Tensor: TensorModule['Tensor'];
  readonly #vocabulary: WordPieceVocabulary;
  readonly #outputName: string;
  readonly #batchSize: number;
  readonly #role: EmbeddingRole;
  #closed = false;

  constructor(options: BundledEmbedderOptions) {
    const batchSize = options.batchSize ?? 16;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 64) throw new TypeError('batchSize must be between 1 and 64');
    if (options.threads !== undefined && (!Number.isSafeInteger(options.threads) || options.threads < 1 || options.threads > 64)) throw new TypeError('threads must be between 1 and 64');
    if (options.role !== undefined && options.role !== 'query' && options.role !== 'passage') throw new TypeError("role must be 'query' or 'passage'");
    this.#batchSize = batchSize;
    this.#role = options.role ?? 'passage';
    const status = bundledModelStatus(options.cacheDir);
    if (!status.present) {
      throw new LocalEmbeddingModelUnavailableError(`The pinned local embedding model is not in the cache at ${status.directory}. `
        + 'Run "npm run setup:embedder" once with network access, or construct the memory with retrieval: \'lexical\' for the zero-model deterministic path.');
    }
    if (options.verifyDigest !== false) verifyBundledModel(options.cacheDir);
    this.#vocabulary = loadWordPieceVocabulary(readFileSync(bundledModelFilePath('vocabulary', options.cacheDir), 'utf8'));
    const runtime = loadRuntime();
    this.#Tensor = runtime.Tensor;
    this.#session = new runtime.binding.binding.InferenceSession();
    this.#session.loadModel(bundledModelFilePath('weights', options.cacheDir), {
      ...(options.threads === undefined ? {} : { intraOpNumThreads: options.threads }),
      graphOptimizationLevel: 'all', executionMode: 'sequential',
    });
    const outputs = this.#session.outputMetadata.map(entry => entry.name);
    const hidden = outputs.find(name => name === 'last_hidden_state');
    if (!hidden) throw new Error(`The pinned model does not expose last_hidden_state (found: ${outputs.join(', ')})`);
    this.#outputName = hidden;
  }

  #assertOpen(): void { if (this.#closed) throw new Error('Local embedder is closed'); }

  #prepare(texts: readonly string[], role: EmbeddingRole): string[] {
    if (!Array.isArray(texts)) throw new TypeError('embed requires an array of texts');
    return texts.map(text => {
      if (typeof text !== 'string' || !text.trim() || text.includes('\0')) throw new TypeError('Embedding text must be a non-empty string without NUL');
      if (Buffer.byteLength(text) > 65_536) throw new TypeError('Embedding text exceeds 65536 bytes');
      return role === 'query' ? `${BUNDLED_EMBEDDING_MODEL.queryPrefix}${text}` : text;
    });
  }

  embedSync(texts: readonly string[], role: EmbeddingRole | undefined = this.#role): number[][] {
    role = role ?? this.#role;
    this.#assertOpen();
    if (role !== 'query' && role !== 'passage') throw new TypeError("role must be 'query' or 'passage'");
    const prepared = this.#prepare(texts, role);
    if (!prepared.length) return [];
    const vectors: number[][] = [];
    for (let offset = 0; offset < prepared.length; offset += this.#batchSize) vectors.push(...this.#runBatch(prepared.slice(offset, offset + this.#batchSize)));
    return vectors;
  }

  #runBatch(texts: string[]): number[][] {
    const encoded = texts.map(text => encodeWordPiece(text, this.#vocabulary, BUNDLED_EMBEDDING_MODEL.maxTokens).ids);
    const rows = encoded.length, columns = Math.max(...encoded.map(ids => ids.length));
    const ids = new BigInt64Array(rows * columns), mask = new BigInt64Array(rows * columns), types = new BigInt64Array(rows * columns);
    // Remaining positions stay at the pad identifier with a zero attention mask.
    for (let row = 0; row < rows; row++) for (let column = 0; column < encoded[row].length; column++) {
      ids[row * columns + column] = BigInt(encoded[row][column]);
      mask[row * columns + column] = 1n;
    }
    const output = this.#session.run({
      input_ids: new this.#Tensor('int64', ids, [rows, columns]),
      attention_mask: new this.#Tensor('int64', mask, [rows, columns]),
      token_type_ids: new this.#Tensor('int64', types, [rows, columns]),
    }, { [this.#outputName]: null }, {})[this.#outputName];
    const data = output.data ?? output.cpuData;
    if (!data) throw new Error('The local embedding model returned no hidden state');
    const dimensions = output.dims[2];
    if (dimensions !== this.dimensions) throw new Error(`The local embedding model returned ${dimensions} dimensions, expected ${this.dimensions}`);
    const vectors: number[][] = [];
    for (let row = 0; row < rows; row++) {
      // CLS pooling: bge-v1.5 sentence embeddings are the first token's state.
      const start = row * columns * dimensions;
      const vector = Array.from(data.subarray(start, start + dimensions), value => Number(value));
      let norm = 0;
      for (const value of vector) norm += value * value;
      norm = Math.sqrt(norm);
      if (!Number.isFinite(norm) || norm === 0) throw new Error('The local embedding model produced a degenerate vector');
      vectors.push(vector.map(value => value / norm));
    }
    return vectors;
  }

  async embed(texts: readonly string[], options: { signal: AbortSignal }): Promise<number[][]> {
    options?.signal?.throwIfAborted();
    return this.embedSync(texts, this.#role);
  }

  #view(role: EmbeddingRole): MemoryEmbedder {
    return Object.freeze({ model: this.model, dimensions: this.dimensions,
      embed: async (texts: readonly string[], options: { signal: AbortSignal }): Promise<number[][]> => { options?.signal?.throwIfAborted(); return this.embedSync(texts, role); } });
  }

  forQueries(): MemoryEmbedder { return this.#view('query'); }
  forPassages(): MemoryEmbedder { return this.#view('passage'); }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#session.dispose();
  }
}

/**
 * Loads the pinned int8 model from the verified local cache. Never downloads.
 *
 * Returns a frozen plain object rather than a class instance: the kernel's
 * adapter validation only accepts plain objects, so that an adapter cannot
 * smuggle prototype behaviour into the retrieval path.
 */
export function createBundledEmbedder(options: BundledEmbedderOptions = {}): SyncMemoryEmbedder {
  const engine = new BundledEmbedderEngine(options);
  return Object.freeze({
    model: engine.model,
    dimensions: engine.dimensions,
    embedSync: (texts: readonly string[], role?: EmbeddingRole) => engine.embedSync(texts, role),
    embed: (texts: readonly string[], call: { signal: AbortSignal }) => engine.embed(texts, call),
    forQueries: () => engine.forQueries(),
    forPassages: () => engine.forPassages(),
    close: () => engine.close(),
  });
}
