import type { SyncMemoryReranker } from '../types.js';
import { resolveModelCacheDir } from '../embedding/model-assets.js';
import { createBundledReranker, type BundledRerankerOptions } from './onnx-reranker.js';

/**
 * One bundled cross-encoder per cache directory per process, reference counted.
 *
 * Identical rationale to the shared embedder: the weights are 23 MB and loading
 * them costs real time, so a process that opens many LocalMemory instances must
 * not load many sessions. Failures are cached too, so a machine with no reranker
 * cache decides once instead of re-checking on every construction.
 */
interface Entry { reranker?: SyncMemoryReranker; failure?: Error; refs: number }
const entries = new Map<string, Entry>();

export function acquireSharedReranker(options: BundledRerankerOptions = {}): SyncMemoryReranker {
  const key = resolveModelCacheDir(options.cacheDir);
  let entry = entries.get(key);
  if (!entry) {
    entry = { refs: 0 };
    try { entry.reranker = createBundledReranker(options); }
    catch (error) { entry.failure = error instanceof Error ? error : new Error('Local reranker unavailable'); }
    entries.set(key, entry);
  }
  if (entry.failure) throw entry.failure;
  entry.refs++;
  return entry.reranker!;
}

export function releaseSharedReranker(reranker: SyncMemoryReranker): void {
  for (const entry of entries.values()) {
    if (entry.reranker !== reranker) continue;
    entry.refs--;
    // The session stays resident at zero references: reopening a memory is
    // common and reloading the weights for it is not.
    if (entry.refs < 0) entry.refs = 0;
    return;
  }
}

/** Test-only: drops every cached session and cached failure. */
export function resetSharedRerankers(): void {
  for (const entry of entries.values()) entry.reranker?.close();
  entries.clear();
}
