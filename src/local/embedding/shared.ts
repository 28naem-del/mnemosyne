import type { SyncMemoryEmbedder } from '../types.js';
import { createBundledEmbedder, type BundledEmbedderOptions } from './onnx-embedder.js';
import { resolveModelCacheDir } from './model-assets.js';

/**
 * One bundled model per cache directory per process, reference counted.
 *
 * The weights are 34 MB and loading them costs a few hundred milliseconds, so a
 * process that opens many LocalMemory instances must not load many sessions.
 * Failures are cached too: on a machine with no model cache, the first attempt
 * decides for every later instance instead of re-checking on every construction.
 */
interface Entry { embedder?: SyncMemoryEmbedder; failure?: Error; refs: number }
const entries = new Map<string, Entry>();

export function acquireSharedEmbedder(options: BundledEmbedderOptions = {}): SyncMemoryEmbedder {
  const key = resolveModelCacheDir(options.cacheDir);
  let entry = entries.get(key);
  if (!entry) {
    entry = { refs: 0 };
    try { entry.embedder = createBundledEmbedder(options); }
    catch (error) { entry.failure = error instanceof Error ? error : new Error('Local embedder unavailable'); }
    entries.set(key, entry);
  }
  if (entry.failure) throw entry.failure;
  entry.refs++;
  return entry.embedder!;
}

export function releaseSharedEmbedder(embedder: SyncMemoryEmbedder): void {
  for (const [key, entry] of entries) {
    if (entry.embedder !== embedder) continue;
    entry.refs--;
    // The session stays resident at zero references: reopening a memory is
    // common and reloading 34 MB of weights for it is not.
    if (entry.refs < 0) entry.refs = 0;
    void key;
    return;
  }
}

/** Test-only: drops every cached session and cached failure. */
export function resetSharedEmbedders(): void {
  for (const entry of entries.values()) entry.embedder?.close();
  entries.clear();
}
