/**
 * store — Full-pipeline memory storage.
 *
 * Steps: classify security → embed → dedup → type classify →
 * priority score → store in Qdrant → auto-link → broadcast.
 */

import type { MemCell } from "../core/types.js";
import { DEFAULT_COLLECTIONS } from "../core/types.js";
import type { QdrantDB } from "../core/qdrant.js";
import type { EmbeddingsClient } from "../core/embeddings.js";
import type { BM25Index } from "../core/bm25.js";
import { classifyMemory } from "../core/security.js";
import { isDuplicate, shouldSemanticMerge, buildMergedPayload } from "../core/dedup.js";
import { classifyMemoryType, classifyUrgency, classifyDomain, computePriorityScore } from "../pipeline/classifier.js";
import type { StoreOptions } from "./types.js";

export interface StoreContext {
  db: QdrantDB;
  embeddings: EmbeddingsClient;
  agentId: string;
  bm25Index?: BM25Index;
  onBroadcast?: (msg: { memoryId: string; agentId: string; event: string }) => void;
}

export async function store(
  ctx: StoreContext,
  text: string,
  options: StoreOptions = {},
): Promise<MemCell> {
  // 1. Security classification
  const classification = options.classification || classifyMemory(text, { agentId: ctx.agentId });
  if (classification === "secret") {
    throw new Error("Cannot store SECRET-classified content. Handle secrets in-memory only.");
  }

  // 2. Generate embedding
  const vector = await ctx.embeddings.embed(text);

  // 3. Deduplication check
  const collection = classification === "private"
    ? DEFAULT_COLLECTIONS.PRIVATE
    : DEFAULT_COLLECTIONS.SHARED;
  const existing = await ctx.db.search(collection, vector, 1, 0.92);

  if (existing.length > 0 && isDuplicate(existing[0].score)) {
    const mergeType = options.memoryType || classifyMemoryType(text);
    const merge = shouldSemanticMerge(existing[0], text, mergeType);
    if (merge.shouldMerge) {
      const merged = buildMergedPayload(existing[0].entry, options.importance ?? 0.7, merge);
      // Soft-delete old, store new with merged metadata
      await ctx.db.softDelete(collection, merge.dropId);
      const cell = await ctx.db.store(text, vector, {
        ...options,
        agentId: ctx.agentId,
        classification,
        memoryType: mergeType as MemCell["memoryType"],
        importance: merged.importance,
        accessCount: merged.accessCount,
        linkedMemories: merged.linkedMemories,
        metadata: { ...options.metadata, ...merged.metadata },
      });

      ctx.bm25Index?.addDocument(cell.id, text);
      return cell;
    }
    // High similarity but different type — store as new
  }

  // 4. Classify memory type, urgency, domain
  const memoryType = options.memoryType || classifyMemoryType(text) as MemCell["memoryType"];
  const urgency = options.urgency || classifyUrgency(text);
  const domain = options.domain || classifyDomain(text);
  const priorityScore = computePriorityScore(urgency, domain);

  // 5. Store in Qdrant
  const cell = await ctx.db.store(text, vector, {
    agentId: ctx.agentId,
    userId: options.userId,
    classification,
    memoryType,
    urgency,
    domain,
    priorityScore,
    importance: options.importance ?? 0.7,
    metadata: options.metadata,
  });

  // 6. Update BM25 index
  ctx.bm25Index?.addDocument(cell.id, text);

  // 7. Broadcast notification
  ctx.onBroadcast?.({
    memoryId: cell.id,
    agentId: ctx.agentId,
    event: "new_memory",
  });

  return cell;
}
