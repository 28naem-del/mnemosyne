/**
 * forget — Erase a scoped live memory by explicit ID.
 */

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
  if (!options.memoryId?.trim()) {
    throw new Error("Forget requires an explicit memory ID. Query-based erasure is disabled; recall and review candidates first.");
  }
  const ids: string[] = [];
  if (await ctx.db.deleteScopedPoint(options.memoryId, options.collection)) {
    ctx.bm25Index?.removeDocument(options.memoryId);
    ctx.embeddings.clearCache();
    ids.push(options.memoryId);
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
