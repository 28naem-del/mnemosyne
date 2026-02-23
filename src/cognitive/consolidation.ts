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
export async function applyConsolidationAction(
  qdrantUrl: string,
  collection: string,
  action: ConsolidationAction,
): Promise<boolean> {
  try {
    switch (action.type) {
      case "strengthen": {
        await fetch(`${qdrantUrl}/collections/${collection}/points/payload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wait: true,
            points: [action.id],
            payload: {
              importance: action.newImportance,
              updated_at: new Date().toISOString(),
            },
          }),
        });
        return true;
      }

      case "promote": {
        await fetch(`${qdrantUrl}/collections/${collection}/points/payload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wait: true,
            points: [action.id],
            payload: {
              memory_type: action.toType,
              updated_at: new Date().toISOString(),
              metadata: { promoted_from: action.fromType, promotion_reason: action.reason },
            },
          }),
        });
        return true;
      }

      case "archive": {
        await fetch(`${qdrantUrl}/collections/${collection}/points/payload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wait: true,
            points: [action.id],
            payload: {
              deleted: true,
              updated_at: new Date().toISOString(),
              metadata: { archived_reason: action.reason },
            },
          }),
        });
        return true;
      }

      case "flag_contradiction": {
        // Mark both memories as having a conflict
        for (const id of action.ids) {
          await fetch(`${qdrantUrl}/collections/${collection}/points/payload`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              wait: true,
              points: [id],
              payload: {
                metadata: {
                  has_contradiction: true,
                  contradiction_with: action.ids.find(i => i !== id),
                  contradiction_reason: action.reason,
                },
              },
            }),
          });
        }
        return true;
      }

      case "merge": {
        // Soft-delete source memories and note the merge
        for (const srcId of action.sourceIds) {
          await fetch(`${qdrantUrl}/collections/${collection}/points/payload`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              wait: true,
              points: [srcId],
              payload: {
                deleted: true,
                metadata: { merged_into: "consolidated", merge_reason: `Merged ${action.sourceIds.length} similar memories` },
              },
            }),
          });
        }
        // Note: the merged text should be stored as a new memory via the store pipeline
        // This just handles the cleanup of source memories
        return true;
      }

      default:
        return false;
    }
  } catch {
    return false;
  }
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
export async function findContradictions(
  qdrantUrl: string,
  collection: string = DEFAULT_COLLECTIONS.SHARED,
  batchSize: number = 200,
): Promise<{ flagged: number; pairs: Array<[string, string]> }> {
  const points = await scrollCollection(qdrantUrl, collection, batchSize);
  let flagged = 0;
  const pairs: Array<[string, string]> = [];

  // Compare pairs using vector similarity
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    if (!a.vector || !Array.isArray(a.vector)) continue;
    const textA = (a.payload.text as string) || "";

    for (let j = i + 1; j < points.length; j++) {
      const b = points[j];
      if (!b.vector || !Array.isArray(b.vector)) continue;
      const textB = (b.payload.text as string) || "";

      const sim = cosineSimilarity(a.vector as number[], b.vector as number[]);
      if (sim < 0.7 || sim > 0.92) continue; // Sweet spot: similar but not duplicates

      // Check for negation mismatch
      const negA = NEG_RE.test(textA);
      const negB = NEG_RE.test(textB);
      if (negA === negB) continue; // Both affirm or both negate -- not contradictory

      // Flag the lower-confidence one
      const confA = (a.payload.confidence as number) ?? 0.5;
      const confB = (b.payload.confidence as number) ?? 0.5;
      const lowerId = confA <= confB ? a.id : b.id;
      const higherId = confA <= confB ? b.id : a.id;

      const ok = await setPayload(qdrantUrl, collection, lowerId, {
        metadata: {
          ...((points.find(p => p.id === lowerId)?.payload.metadata as Record<string, unknown>) || {}),
          has_contradiction: true,
          contradiction_with: higherId,
          contradiction_flagged_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      });

      if (ok) {
        flagged++;
        pairs.push([lowerId, higherId]);
      }
    }
  }

  return { flagged, pairs };
}

/**
 * Merge near-duplicates.
 * Find pairs with >0.92 similarity. Keep the one with more access_count,
 * merge metadata, soft-delete the other.
 */
export async function mergeNearDuplicates(
  qdrantUrl: string,
  collection: string = DEFAULT_COLLECTIONS.SHARED,
  batchSize: number = 200,
): Promise<{ merged: number; deletedIds: string[] }> {
  const points = await scrollCollection(qdrantUrl, collection, batchSize);
  let merged = 0;
  const deletedIds: string[] = [];
  const alreadyDeleted = new Set<string>();

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    if (alreadyDeleted.has(a.id)) continue;
    if (!a.vector || !Array.isArray(a.vector)) continue;

    for (let j = i + 1; j < points.length; j++) {
      const b = points[j];
      if (alreadyDeleted.has(b.id)) continue;
      if (!b.vector || !Array.isArray(b.vector)) continue;

      const sim = cosineSimilarity(a.vector as number[], b.vector as number[]);
      if (sim < 0.92) continue;

      // Keep the one with more access_count
      const countA = (a.payload.access_count as number) || 0;
      const countB = (b.payload.access_count as number) || 0;
      const keeper = countA >= countB ? a : b;
      const loser = countA >= countB ? b : a;

      // Merge access counts and linked memories on the keeper
      const keeperMeta = (keeper.payload.metadata as Record<string, unknown>) || {};
      const loserMeta = (loser.payload.metadata as Record<string, unknown>) || {};
      const keeperLinks = (keeper.payload.linked_memories as string[]) || [];
      const loserLinks = (loser.payload.linked_memories as string[]) || [];
      const mergedLinks = [...new Set([...keeperLinks, ...loserLinks])];

      await setPayload(qdrantUrl, collection, keeper.id, {
        access_count: countA + countB,
        linked_memories: mergedLinks,
        metadata: {
          ...keeperMeta,
          ...loserMeta,
          merged_from: loser.id,
          merged_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      });

      // Soft-delete the loser
      await setPayload(qdrantUrl, collection, loser.id, {
        deleted: true,
        metadata: {
          ...loserMeta,
          merged_into: keeper.id,
          merged_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      });

      alreadyDeleted.add(loser.id);
      deletedIds.push(loser.id);
      merged++;
    }
  }

  return { merged, deletedIds };
}

/**
 * Promote popular memories.
 * Memories with access_count > 10 get promoted to memoryType "core".
 */
export async function promotePopular(
  qdrantUrl: string,
  collection: string = DEFAULT_COLLECTIONS.SHARED,
  batchSize: number = 200,
): Promise<{ promoted: number; ids: string[] }> {
  const points = await scrollCollection(qdrantUrl, collection, batchSize);
  let promoted = 0;
  const ids: string[] = [];

  for (const p of points) {
    const accessCount = (p.payload.access_count as number) || 0;
    const memoryType = (p.payload.memory_type as string) || "semantic";

    // Already core -- skip
    if (memoryType === "core") continue;
    if (accessCount <= 10) continue;

    const ok = await setPayload(qdrantUrl, collection, p.id, {
      memory_type: "core",
      metadata: {
        ...((p.payload.metadata as Record<string, unknown>) || {}),
        promoted_from: memoryType,
        promoted_by: "consolidation_popular",
        promoted_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    });

    if (ok) {
      promoted++;
      ids.push(p.id);
    }
  }

  return { promoted, ids };
}

/**
 * Demote stale memories.
 * Memories not accessed in 30+ days AND importance < 0.3 get priority_score halved.
 */
export async function demoteStale(
  qdrantUrl: string,
  collection: string = DEFAULT_COLLECTIONS.SHARED,
  batchSize: number = 200,
): Promise<{ demoted: number; ids: string[] }> {
  const points = await scrollCollection(qdrantUrl, collection, batchSize);
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 3_600_000;
  let demoted = 0;
  const ids: string[] = [];

  for (const p of points) {
    const memoryType = (p.payload.memory_type as string) || "semantic";
    // Never demote core or procedural
    if (memoryType === "core" || memoryType === "procedural") continue;

    const importance = (p.payload.importance as number) ?? 0.5;
    if (importance >= 0.3) continue;

    // Check last access time
    const accessTimes = (p.payload.access_times as number[]) || [];
    const lastAccess = accessTimes.length > 0
      ? Math.max(...accessTimes)
      : new Date((p.payload.created_at as string) || 0).getTime();

    if (now - lastAccess < thirtyDaysMs) continue;

    const currentPriority = (p.payload.priority_score as number) ?? 0.5;
    const newPriority = currentPriority / 2;

    const ok = await setPayload(qdrantUrl, collection, p.id, {
      priority_score: newPriority,
      metadata: {
        ...((p.payload.metadata as Record<string, unknown>) || {}),
        demoted_by: "consolidation_stale",
        demoted_at: new Date().toISOString(),
        previous_priority: currentPriority,
      },
      updated_at: new Date().toISOString(),
    });

    if (ok) {
      demoted++;
      ids.push(p.id);
    }
  }

  return { demoted, ids };
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
  qdrantUrl: string,
  collection: string = DEFAULT_COLLECTIONS.SHARED,
  batchSize: number = 200,
): Promise<ConsolidationReport> {
  const contradictions = await findContradictions(qdrantUrl, collection, batchSize);
  const duplicates = await mergeNearDuplicates(qdrantUrl, collection, batchSize);
  const popular = await promotePopular(qdrantUrl, collection, batchSize);
  const stale = await demoteStale(qdrantUrl, collection, batchSize);

  return {
    analyzed: batchSize,
    strengthened: 0,
    promoted: 0,
    archived: 0,
    contradictions: contradictions.flagged,
    merged: 0,
    nearDuplicatesMerged: duplicates.merged,
    popularPromoted: popular.promoted,
    staleDemoted: stale.demoted,
  };
}
