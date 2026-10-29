import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { writeModelFile } from './model-file.js';

/**
 * The pinned CPU embedding model for the default hybrid recall path.
 *
 * `bge-small-en-v1.5` is int8-quantized ONNX: 384 dimensions, CLS pooling, L2
 * normalization, 512-token window. Artifacts are pinned to one immutable commit
 * and verified by digest, so a cache poisoned upstream or on disk fails closed
 * instead of silently changing what the engine believes.
 *
 * Retrieval never touches the network. The only network access in this file is
 * the explicit, opt-in setup-time fetch below.
 */
export const BUNDLED_EMBEDDING_MODEL = Object.freeze({
  repository: 'Xenova/bge-small-en-v1.5',
  revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
  license: 'MIT (model weights: BAAI/bge-small-en-v1.5, MIT)',
  dimensions: 384,
  maxTokens: 512,
  pooling: 'cls' as const,
  normalization: 'l2' as const,
  dtype: 'int8' as const,
  /** bge-v1.5 is trained to score short queries against passages with this prefix. */
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  files: Object.freeze({
    weights: Object.freeze({ remote: 'onnx/model_quantized.onnx', local: 'model_quantized.onnx', bytes: 34_014_426, sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4' }),
    vocabulary: Object.freeze({ remote: 'vocab.txt', local: 'vocab.txt', bytes: 231_508, sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3' }),
  }),
});

/** Changing pooling, dtype, revision or prefix changes stored vector semantics, so it changes this identity. */
export const BUNDLED_EMBEDDING_ID = `onnxruntime-node|${BUNDLED_EMBEDDING_MODEL.repository}@${BUNDLED_EMBEDDING_MODEL.revision}|`
  + `${BUNDLED_EMBEDDING_MODEL.dtype}|${BUNDLED_EMBEDDING_MODEL.pooling}|${BUNDLED_EMBEDDING_MODEL.normalization}|${BUNDLED_EMBEDDING_MODEL.maxTokens}|bge-query-prefix-v1`;

export type BundledModelFile = keyof typeof BUNDLED_EMBEDDING_MODEL.files;

/** `cacheDir` wins, then MNEMOSYNE_MODEL_CACHE, then the XDG/user cache directory. */
export function resolveModelCacheDir(cacheDir?: string): string {
  if (cacheDir !== undefined) {
    if (typeof cacheDir !== 'string' || !cacheDir.trim() || cacheDir.includes('\0') || !isAbsolute(cacheDir)) throw new TypeError('cacheDir must be an absolute path');
    return resolve(cacheDir);
  }
  const configured = process.env.MNEMOSYNE_MODEL_CACHE;
  if (configured && isAbsolute(configured) && !configured.includes('\0')) return resolve(configured);
  const base = process.env.XDG_CACHE_HOME && isAbsolute(process.env.XDG_CACHE_HOME) ? process.env.XDG_CACHE_HOME : join(homedir(), '.cache');
  return join(base, 'mnemosyne', 'models');
}

export function bundledModelDir(cacheDir?: string): string {
  return join(resolveModelCacheDir(cacheDir), `${BUNDLED_EMBEDDING_MODEL.repository.replace('/', '__')}@${BUNDLED_EMBEDDING_MODEL.revision}`);
}

export function bundledModelFilePath(file: BundledModelFile, cacheDir?: string): string {
  return join(bundledModelDir(cacheDir), BUNDLED_EMBEDDING_MODEL.files[file].local);
}

function digestOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface BundledModelStatus {
  directory: string;
  present: boolean;
  files: { file: BundledModelFile; path: string; present: boolean; bytes: number; expectedBytes: number }[];
}

/** Cheap presence/size check. It does not read 34 MB to hash the weights. */
export function bundledModelStatus(cacheDir?: string): BundledModelStatus {
  const directory = bundledModelDir(cacheDir);
  const files = (Object.keys(BUNDLED_EMBEDDING_MODEL.files) as BundledModelFile[]).map(file => {
    const path = join(directory, BUNDLED_EMBEDDING_MODEL.files[file].local);
    const present = existsSync(path) && statSync(path).isFile();
    return { file, path, present, bytes: present ? statSync(path).size : 0, expectedBytes: BUNDLED_EMBEDDING_MODEL.files[file].bytes };
  });
  return { directory, present: files.every(entry => entry.present && entry.bytes === entry.expectedBytes), files };
}

export function verifyBundledModel(cacheDir?: string): void {
  const status = bundledModelStatus(cacheDir);
  for (const entry of status.files) {
    if (!entry.present) throw new Error(`Local embedding model file is missing: ${entry.path}. Run "npm run setup:embedder" once with network access.`);
    if (entry.bytes !== entry.expectedBytes) throw new Error(`Local embedding model file has an unexpected size: ${entry.path}`);
    const expected = BUNDLED_EMBEDDING_MODEL.files[entry.file].sha256;
    const actual = digestOf(entry.path);
    if (actual !== expected) throw new Error(`Local embedding model digest mismatch for ${entry.path}; refusing to load unverified weights`);
  }
}

/**
 * One-time setup download of the pinned artifacts. Retrieval never calls this:
 * it exists so a build or install step can populate the cache once. Each file is
 * digest-verified, written to an unpredictable temporary name created
 * exclusively (see `writeModelFile`), then renamed into place, so an
 * interrupted download can never be mistaken for a valid cache entry.
 */
export async function fetchBundledModel(options: { cacheDir?: string; signal?: AbortSignal; onProgress?: (message: string) => void } = {}): Promise<BundledModelStatus> {
  const directory = bundledModelDir(options.cacheDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const file of Object.keys(BUNDLED_EMBEDDING_MODEL.files) as BundledModelFile[]) {
    const spec = BUNDLED_EMBEDDING_MODEL.files[file];
    const target = join(directory, spec.local);
    if (existsSync(target) && statSync(target).size === spec.bytes && digestOf(target) === spec.sha256) { options.onProgress?.(`cached ${spec.local}`); continue; }
    const url = `https://huggingface.co/${BUNDLED_EMBEDDING_MODEL.repository}/resolve/${BUNDLED_EMBEDDING_MODEL.revision}/${spec.remote}`;
    options.onProgress?.(`downloading ${spec.local} (${spec.bytes} bytes)`);
    const response = await fetch(url, { redirect: 'follow', ...(options.signal ? { signal: options.signal } : {}) });
    if (!response.ok) throw new Error(`Local embedding model download failed with HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength !== spec.bytes) throw new Error(`Downloaded ${spec.local} has ${bytes.byteLength} bytes, expected ${spec.bytes}`);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== spec.sha256) throw new Error(`Downloaded ${spec.local} digest ${actual} does not match the pinned ${spec.sha256}`);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeModelFile(target, bytes);
    options.onProgress?.(`verified ${spec.local}`);
  }
  return bundledModelStatus(options.cacheDir);
}
