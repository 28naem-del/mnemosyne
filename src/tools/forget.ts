/**
 * forget — Soft-delete memories by query or ID.
 */

import { DEFAULT_COLLECTIONS } from "../core/types.js";
import type { QdrantDB } from "../core/qdrant.js";
import type { EmbeddingsClient } from "../core/embeddings.js";
import type { BM25Index } from "../core/bm25.js";
import type { ForgetOptions } from "./types.js";

export interface ForgetContext {
  db: QdrantDB;
  embeddings: EmbeddingsClient;
  agentId: string;
  bm25Index?: BM25Index;
  onBroadcast?: (msg: { memoryId: string; agentId: string; event: string }) => void;
}

export interface ForgetResult {
  deleted: number;
  ids: string[];
}

export async function forget(
  ctx: ForgetContext,
  options: ForgetOptions,
): Promise<ForgetResult> {
  const ids: string[] = [];

  if (options.memoryId) {
    // Direct ID deletion
    const collection = options.collection || DEFAULT_COLLECTIONS.SHARED;
    await ctx.db.softDelete(collection, options.memoryId);
    ctx.bm25Index?.removeDocument(options.memoryId);
    ids.push(options.memoryId);
  } else if (options.query) {
    // Query-based deletion: find similar memories and soft-delete them
    const vector = await ctx.embeddings.embed(options.query);
    const results = await ctx.db.searchAll(vector, 5, 0.7);

    for (const r of results) {
      const collection = r.entry.classification === "private"
        ? DEFAULT_COLLECTIONS.PRIVATE
        : DEFAULT_COLLECTIONS.SHARED;
      await ctx.db.softDelete(collection, r.entry.id);
      ctx.bm25Index?.removeDocument(r.entry.id);
      ids.push(r.entry.id);
    }
  }

  // Broadcast invalidation
  for (const id of ids) {
    ctx.onBroadcast?.({
      memoryId: id,
      agentId: ctx.agentId,
      event: "invalidate",
    });
  }

  return { deleted: ids.length, ids };
}
