/** Legacy URL-only mutation entry points are disabled; pass a scoped QdrantDB to safe maintenance. */
/**
 * Memory consolidation -- feedback loops for memory maintenance.
 *
 * Like human sleep consolidation:
 *   1. Merge: Similar episodic memories -> consolidated semantic memory
 *   2. Strengthen: Frequently-accessed memories get importance boost
 *   3. Prune: Contradictory memories get flagged for resolution
 *   4. Promote: Episodic memories that keep being relevant -> semantic
 *
 * Additional active consolidation functions:
 *   5. findContradictions() -- detect semantically similar but contradicting pairs
 *   6. mergeNearDuplicates() -- auto-merge >0.92 similarity pairs
 *   7. promotePopular() -- access_count > 10 -> memoryType "core"
 *   8. demoteStale() -- 30+ days idle + low importance -> halve priority_score
 *   9. runConsolidation() -- orchestrates all four in sequence
 *
 * Designed to run periodically (cron) or on-demand.
 * No LLM calls -- purely algorithmic.
 */

import type { MemCell, MemoryType } from "../core/types.js";
import { DEFAULT_COLLECTIONS } from "../core/types.js";
import type { QdrantDB } from "../core/qdrant.js";
import { maintainMemory } from "./maintenance.js";
import { rejectUnsafeLegacyOperation } from "./legacy-guard.js";

export type ConsolidationAction =
  | { type: "merge"; sourceIds: string[]; mergedText: string; newType: MemoryType }
  | { type: "strengthen"; id: string; newImportance: number; reason: string }
  | { type: "promote"; id: string; fromType: MemoryType; toType: MemoryType; reason: string }
  | { type: "flag_contradiction"; ids: [string, string]; reason: string }
  | { type: "archive"; id: string; reason: string };

// Identify memories that should be consolidated
export function analyzeForConsolidation(memories: MemCell[]): ConsolidationAction[] {
  const actions: ConsolidationAction[] = [];

  // 1. Strengthen: memories accessed 5+ times -> boost importance
  for (const m of memories) {
    if (m.accessCount >= 5 && m.importance < 0.9) {
      actions.push({
        type: "strengthen",
        id: m.id,
        newImportance: Math.min(1.0, m.importance + 0.1),
        reason: `accessed ${m.accessCount} times -- clearly valuable`,
      });
    }
  }

  // 2. Promote: episodic memories accessed 3+ times -> semantic (it's a fact now, not just an event)
  for (const m of memories) {
    if (m.memoryType === "episodic" && m.accessCount >= 3) {
      actions.push({
        type: "promote",
        id: m.id,
        fromType: "episodic",
        toType: "semantic",
        reason: `episodic accessed ${m.accessCount} times -- promote to semantic fact`,
      });
    }
  }

  // 3. Archive: old memories with zero access and low importance
  const now = Date.now();
  for (const m of memories) {
    if (m.memoryType === "core" || m.memoryType === "procedural") continue; // Never archive these
    const createdMs = new Date(m.createdAt).getTime();
    const ageHours = (now - createdMs) / 3_600_000;
    if (ageHours > 720 && m.accessCount <= 1 && m.importance < 0.5) { // 30+ days old, barely accessed
      actions.push({
        type: "archive",
        id: m.id,
        reason: `${(ageHours / 24).toFixed(0)} days old, ${m.accessCount} accesses, importance ${m.importance}`,
      });
    }
  }

  return actions;
}

// Find clusters of similar memories that could be merged
export function findMergeCandidates(
  memories: MemCell[],
  similarityPairs: Array<{ idA: string; idB: string; similarity: number }>,
): ConsolidationAction[] {
  const actions: ConsolidationAction[] = [];

  // Group highly similar episodic memories (>0.85 similarity)
  const clusters = new Map<string, Set<string>>();

  for (const pair of similarityPairs) {
    if (pair.similarity < 0.85) continue;

    const memA = memories.find(m => m.id === pair.idA);
    const memB = memories.find(m => m.id === pair.idB);
    if (!memA || !memB) continue;

    // Only merge episodics with episodics
    if (memA.memoryType !== "episodic" || memB.memoryType !== "episodic") continue;

    // Find or create cluster
    let clusterKey: string | undefined;
    for (const [key, members] of clusters) {
      if (members.has(pair.idA) || members.has(pair.idB)) {
        clusterKey = key;
        break;
      }
    }

    if (clusterKey) {
      clusters.get(clusterKey)!.add(pair.idA);
      clusters.get(clusterKey)!.add(pair.idB);
    } else {
      clusters.set(pair.idA, new Set([pair.idA, pair.idB]));
    }
  }

  // Generate merge actions for clusters of 3+
  for (const [, members] of clusters) {
    if (members.size < 3) continue;
    const memberMems = [...members]
      .map(id => memories.find(m => m.id === id))
      .filter((m): m is MemCell => m !== undefined);

    // Create merged text from the cluster
    const mergedText = `[Consolidated from ${memberMems.length} memories] ` +
      memberMems.map(m => m.text.slice(0, 100)).join(" | ");

    actions.push({
      type: "merge",
      sourceIds: [...members],
      mergedText: mergedText.slice(0, 500),
      newType: "semantic", // Episodics consolidate into semantics
    });
  }

  return actions;
}

// Apply a single consolidation action to Qdrant
/** @deprecated Disabled before network access; use instance-scoped maintainMemory instead. */
export async function applyConsolidationAction(
  qdrantUrl: string,
  collection: string,
  action: ConsolidationAction,
): Promise<boolean> {
  return rejectUnsafeLegacyOperation("applyConsolidationAction");
}

// Statistics for consolidation reporting
export type ConsolidationReport = {
  analyzed: number;
  strengthened: number;
  promoted: number;
  archived: number;
  contradictions: number;
  merged: number;
  nearDuplicatesMerged: number;
  popularPromoted: number;
  staleDemoted: number;
};

// ============================================================================
// Active Consolidation Functions
// ============================================================================

const NEG_RE = /\b(not|no|never|don't|doesn't|isn't|wasn't|can't|won't|removed|deleted|deprecated|disabled|stopped)\b/i;

/**
 * Fetch points from a Qdrant collection via scroll API.
 * Returns payloads with IDs.
 */
async function scrollCollection(
  qdrantUrl: string,
  collection: string,
  limit: number,
  filters?: Record<string, unknown>,
): Promise<Array<{ id: string; payload: Record<string, unknown>; vector?: number[] }>> {
  const must: unknown[] = [{ key: "deleted", match: { value: false } }];
  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      must.push({ key, match: { value } });
    }
  }

  const res = await fetch(`${qdrantUrl}/collections/${collection}/points/scroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      limit,
      filter: { must },
      with_payload: true,
      with_vector: true,
    }),
  });

  if (!res.ok) return [];
  const data = (await res.json()) as {
    result: { points: Array<{ id: string; payload: Record<string, unknown>; vector?: number[] }> };
  };
  return data.result.points || [];
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

/**
 * Set payload on a Qdrant point.
 */
async function setPayload(
  qdrantUrl: string,
  collection: string,
  pointId: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${qdrantUrl}/collections/${collection}/points/payload`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wait: true, points: [pointId], payload }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Find contradictions.
 * Search pairs where text is semantically similar (>0.7) but content contradicts.
 * Flag the lower-confidence one with contradiction_with: [other_id].
 */
/** @deprecated Disabled before network access; use instance-scoped maintainMemory instead. */
export async function findContradictions(
  qdrantUrl: string,
  collection: string = DEFAULT_COLLECTIONS.SHARED,
  batchSize: number = 200,
): Promise<{ flagged: number; pairs: Array<[string, string]> }> {
  return rejectUnsafeLegacyOperation("findContradictions");
}

/**
 * Merge near-duplicates.
 * Find pairs with >0.92 similarity. Keep the one with more access_count,
 * merge metadata, soft-delete the other.
 */
/** @deprecated Disabled before network access; use instance-scoped maintainMemory instead. */
export async function mergeNearDuplicates(
  qdrantUrl: string,
  collection: string = DEFAULT_COLLECTIONS.SHARED,
  batchSize: number = 200,
): Promise<{ merged: number; deletedIds: string[] }> {
  return rejectUnsafeLegacyOperation("mergeNearDuplicates");
}

/**
 * Promote popular memories.
 * Memories with access_count > 10 get promoted to memoryType "core".
 */
/** @deprecated Disabled before network access; use instance-scoped maintainMemory instead. */
export async function promotePopular(
  qdrantUrl: string,
  collection: string = DEFAULT_COLLECTIONS.SHARED,
  batchSize: number = 200,
): Promise<{ promoted: number; ids: string[] }> {
  return rejectUnsafeLegacyOperation("promotePopular");
}

/**
 * Demote stale memories.
 * Memories not accessed in 30+ days AND importance < 0.3 get priority_score halved.
 */
/** @deprecated Disabled before network access; use instance-scoped maintainMemory instead. */
export async function demoteStale(
  qdrantUrl: string,
  collection: string = DEFAULT_COLLECTIONS.SHARED,
  batchSize: number = 200,
): Promise<{ demoted: number; ids: string[] }> {
  return rejectUnsafeLegacyOperation("demoteStale");
}

/**
 * Run full consolidation pipeline.
 * Executes all four operations in order:
 *   1. findContradictions
 *   2. mergeNearDuplicates
 *   3. promotePopular
 *   4. demoteStale
 */
export async function runConsolidation(
  qdrantUrl: string | QdrantDB,
  collection?: string,
  batchSize: number = 200,
  options: { dryRun?: boolean } = {},
): Promise<ConsolidationReport> {
  if (typeof qdrantUrl === "string") return rejectUnsafeLegacyOperation("runConsolidation(URL)");
  return maintainMemory(qdrantUrl, { batchSize, collections: collection ? [collection] : undefined, dryRun: options.dryRun });
}
