import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeModelFile } from '../embedding/model-file.js';
import { resolveModelCacheDir } from '../embedding/model-assets.js';

/**
 * The pinned CPU cross-encoder for reranking the fused candidate set.
 *
 * `ms-marco-MiniLM-L-6-v2` is int8-quantized ONNX: 6 layers, 384 hidden, a single
 * regression head, 512-token window over the query/passage PAIR. Artifacts are
 * pinned to one immutable commit and verified by digest, so a cache poisoned
 * upstream or on disk fails closed instead of silently changing how the engine
 * ranks what it believes.
 *
 * It shares `bert-base-uncased`'s WordPiece vocabulary with the bundled embedder —
 * the two `vocab.txt` files are byte-identical (sha256 07eced37…) — so reranking
 * reuses the tokenizer that was already proved byte-exact against the reference
 * implementation, and adds no second tokenizer to trust.
 *
 * Reranking never touches the network. The only network access in this file is
 * the explicit, opt-in setup-time fetch below.
 */
export const BUNDLED_RERANKER_MODEL = Object.freeze({
  repository: 'Xenova/ms-marco-MiniLM-L-6-v2',
  revision: 'a09144355adeed5f58c8ed011d209bf8ee5a1fec',
  license: 'Apache-2.0 (model weights: cross-encoder/ms-marco-MiniLM-L-6-v2, Apache-2.0)',
  maxTokens: 512,
  dtype: 'int8' as const,
  files: Object.freeze({
    weights: Object.freeze({ remote: 'onnx/model_quantized.onnx', local: 'model_quantized.onnx', bytes: 23_143_499, sha256: 'e9d8ebf845c413e981c175bfe49a3bfa9b3dcce2a3ba54875ee5df5a58639fbe' }),
    vocabulary: Object.freeze({ remote: 'vocab.txt', local: 'vocab.txt', bytes: 231_508, sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3' }),
  }),
});

/** Changing dtype, revision or window changes how candidates are ordered, so it changes this identity. */
export const BUNDLED_RERANKER_ID = `onnxruntime-node|${BUNDLED_RERANKER_MODEL.repository}@${BUNDLED_RERANKER_MODEL.revision}|`
  + `${BUNDLED_RERANKER_MODEL.dtype}|cross-encoder|${BUNDLED_RERANKER_MODEL.maxTokens}|pair-v1`;

export type BundledRerankerFile = keyof typeof BUNDLED_RERANKER_MODEL.files;

export function bundledRerankerDir(cacheDir?: string): string {
  return join(resolveModelCacheDir(cacheDir), `${BUNDLED_RERANKER_MODEL.repository.replace('/', '__')}@${BUNDLED_RERANKER_MODEL.revision}`);
}

export function bundledRerankerFilePath(file: BundledRerankerFile, cacheDir?: string): string {
  return join(bundledRerankerDir(cacheDir), BUNDLED_RERANKER_MODEL.files[file].local);
}

function digestOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface BundledRerankerStatus {
  directory: string;
  present: boolean;
  files: { file: BundledRerankerFile; path: string; present: boolean; bytes: number; expectedBytes: number }[];
}

/** Cheap presence/size check. It does not read 23 MB to hash the weights. */
export function bundledRerankerStatus(cacheDir?: string): BundledRerankerStatus {
  const directory = bundledRerankerDir(cacheDir);
  const files = (Object.keys(BUNDLED_RERANKER_MODEL.files) as BundledRerankerFile[]).map(file => {
    const path = join(directory, BUNDLED_RERANKER_MODEL.files[file].local);
    const present = existsSync(path) && statSync(path).isFile();
    return { file, path, present, bytes: present ? statSync(path).size : 0, expectedBytes: BUNDLED_RERANKER_MODEL.files[file].bytes };
  });
  return { directory, present: files.every(entry => entry.present && entry.bytes === entry.expectedBytes), files };
}

export function verifyBundledReranker(cacheDir?: string): void {
  const status = bundledRerankerStatus(cacheDir);
  for (const entry of status.files) {
    if (!entry.present) throw new Error(`Local reranker model file is missing: ${entry.path}. Run "npm run setup:reranker" once with network access.`);
    if (entry.bytes !== entry.expectedBytes) throw new Error(`Local reranker model file has an unexpected size: ${entry.path}`);
    const expected = BUNDLED_RERANKER_MODEL.files[entry.file].sha256;
    if (digestOf(entry.path) !== expected) throw new Error(`Local reranker model digest mismatch for ${entry.path}; refusing to load unverified weights`);
  }
}

/**
 * One-time setup download of the pinned artifacts. Reranking never calls this:
 * it exists so a build or install step can populate the cache once. Each file is
 * digest-verified, written to an unpredictable temporary name created
 * exclusively (see `writeModelFile`), then renamed into place, so an
 * interrupted download can never be mistaken for a valid cache entry.
 */
export async function fetchBundledReranker(options: { cacheDir?: string; signal?: AbortSignal; onProgress?: (message: string) => void } = {}): Promise<BundledRerankerStatus> {
  const directory = bundledRerankerDir(options.cacheDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const file of Object.keys(BUNDLED_RERANKER_MODEL.files) as BundledRerankerFile[]) {
    const spec = BUNDLED_RERANKER_MODEL.files[file];
    const target = join(directory, spec.local);
    if (existsSync(target) && statSync(target).size === spec.bytes && digestOf(target) === spec.sha256) { options.onProgress?.(`cached ${spec.local}`); continue; }
    const url = `https://huggingface.co/${BUNDLED_RERANKER_MODEL.repository}/resolve/${BUNDLED_RERANKER_MODEL.revision}/${spec.remote}`;
    options.onProgress?.(`downloading ${spec.local} (${spec.bytes} bytes)`);
    const response = await fetch(url, { redirect: 'follow', ...(options.signal ? { signal: options.signal } : {}) });
    if (!response.ok) throw new Error(`Local reranker model download failed with HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength !== spec.bytes) throw new Error(`Downloaded ${spec.local} has ${bytes.byteLength} bytes, expected ${spec.bytes}`);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== spec.sha256) throw new Error(`Downloaded ${spec.local} digest ${actual} does not match the pinned ${spec.sha256}`);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeModelFile(target, bytes);
    options.onProgress?.(`verified ${spec.local}`);
  }
  return bundledRerankerStatus(options.cacheDir);
}
