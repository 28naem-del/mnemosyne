/**
 * recall — Multi-signal memory retrieval.
 *
 * Combines: vector search, BM25 keyword search, intent routing,
 * ACT-R decay, preference boosting, and diversity reranking.
 */

import type { MemCellSearchResult } from "../core/types.js";
import { DEFAULT_COLLECTIONS } from "../core/types.js";
import type { QdrantDB } from "../core/qdrant.js";
import type { EmbeddingsClient } from "../core/embeddings.js";
import type { BM25Index } from "../core/bm25.js";
import { hybridSearch } from "../core/bm25.js";
import { computeActivation, getDecayStatus } from "../cognitive/decay.js";
import { routeQuery } from "../cognitive/intent.js";
import { computeMultiSignalScore, applyDiversityReranking } from "../cognitive/retrieval.js";
import type { RecallOptions } from "./types.js";

export interface RecallContext {
  db: QdrantDB;
  embeddings: EmbeddingsClient;
  agentId: string;
  bm25Index?: BM25Index;
  enableDecay?: boolean;
  enableBM25?: boolean;
  trustResolver?: (agentId: string) => number;
}

export async function recall(
  ctx: RecallContext,
  query: string,
  options: RecallOptions = {},
): Promise<MemCellSearchResult[]> {
  const limit = options.limit ?? 10;
  const minScore = options.minScore ?? 0.3;

  // 1. Route query to determine intent and strategy
  const { intent, strategy } = routeQuery(query);

  // 2. Generate embedding
  const vector = await ctx.embeddings.embed(query);

  // 3. Search (hybrid if BM25 enabled, otherwise vector-only)
  let results: MemCellSearchResult[];

  if (ctx.enableBM25 && ctx.bm25Index) {
    results = await hybridSearch(
      ctx.db,
      ctx.bm25Index,
      vector,
      query,
      limit * 3,
      minScore,
      options.filters,
    );
  } else {
    results = await ctx.db.searchAll(vector, limit * 3, minScore);
  }

  if (results.length === 0) return [];

  // 4. Apply ACT-R decay filter (remove "forgotten" memories)
  if (ctx.enableDecay !== false) {
    results = results.filter((r) => {
      const activation = computeActivation(
        r.entry.accessTimes,
        r.entry.urgency,
        r.entry.memoryType,
      );
      return getDecayStatus(activation) === "active";
    });
  }

  // 5. Multi-signal reranking
  const nowMs = Date.now();
  const scored = results.map((r) => ({
    ...r,
    score: computeMultiSignalScore(
      r.entry,
      r.score,
      intent,
      nowMs,
      undefined, // queryContext
      undefined, // graphActivation
      strategy.boostTypes,
      strategy.penalizeTypes,
    ),
  }));

  // 6. Sort by new score
  scored.sort((a, b) => b.score - a.score);

  // 7. Diversity reranking
  const diversified = applyDiversityReranking(scored, limit);

  // 8. Update access times (fire-and-forget)
  for (const r of diversified) {
    const collection = r.entry.classification === "private"
      ? DEFAULT_COLLECTIONS.PRIVATE
      : DEFAULT_COLLECTIONS.SHARED;
    ctx.db.updateAccessTime(collection, r.entry.id).catch(() => {});
  }

  return diversified.slice(0, limit);
}
