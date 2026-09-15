import type { MemoryRecord, MemoryReranker, SyncMemoryReranker } from '../types.js';

/**
 * Presents a synchronous reranker through the asynchronous `MemoryReranker`
 * interface that `recallHybrid` takes.
 *
 * The two paths exist for different reasons: `recall()` is synchronous and drives
 * the bundled model inline, while `recallHybrid` is the provider-agnostic path
 * where a reranker may be a remote service. This adapter lets one bundled model
 * serve both, which is what makes a benchmark of `recallHybrid` a measurement of
 * the configuration `recall()` actually ships.
 *
 * `MemoryReranker` requires scores in [0, 1]; a cross-encoder emits an unbounded
 * score. The logistic below is the same monotonic transform the synchronous path
 * applies, so both paths order identical candidates identically.
 */
export function asMemoryReranker(reranker: SyncMemoryReranker): MemoryReranker {
  return Object.freeze({
    rerank: async (query: string, candidates: readonly MemoryRecord[]): Promise<{ id: string; score: number }[]> => {
      if (!candidates.length) return [];
      const scores = reranker.rerankSync(query, candidates.map(candidate => candidate.text));
      if (!Array.isArray(scores) || scores.length !== candidates.length) throw new TypeError('Reranker must return one score per candidate');
      return candidates.map((candidate, index) => {
        const score = scores[index];
        if (typeof score !== 'number' || !Number.isFinite(score)) throw new TypeError('Reranker returned a non-finite score');
        return { id: candidate.id, score: 1 / (1 + Math.exp(-score)) };
      });
    },
  });
}
