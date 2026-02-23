/**
 * Dream Consolidation -- overnight batch job for full memory maintenance.
 *
 * Like sleep consolidation in the brain:
 *   Phase 1: Aggressive dedup (0.88 threshold vs normal 0.92)
 *   Phase 2: Merge related episodic -> semantic
 *   Phase 3: Prune stale + low-importance memories
 *   Phase 4: Strengthen frequently-used memories
 *   Phase 5: Run pattern mining on recent memories
 *   Phase 6: Generate consolidation report
 *
 * Designed to run periodically (cron) or on-demand.
 * Can take minutes -- NOT in the search hot path.
 * Zero npm deps, zero LLM calls -- purely algorithmic.
 */

import { DEFAULT_COLLECTIONS, type MemoryType, type UrgencyLevel } from "../core/types.js";
import { computeActivation } from "./decay.js";

// ============================================================================
// Types
// ============================================================================

/** The phases of dream consolidation (run in order) */
export type DreamPhase =
  | "dedup"       // aggressive dedup at 0.88 threshold
  | "merge"       // merge related episodic -> semantic
  | "prune"       // archive memories with activation < -4.0
  | "strengthen"  // boost memories with access_count > 5
  | "mine"        // run pattern mining
  | "abstract"    // run pattern abstraction
  | "complete";

/** Dream consolidation report */
export interface DreamReport {
  phase: DreamPhase;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  stats: {
    memoriesScanned: number;
    duplicatesMerged: number;
    staleArchived: number;
    contradictionsResolved: number;
    promoted: number;
    demoted: number;
    patternsDiscovered: number;
    lessonsAbstracted: number;
    spaceSavedBytes: number;
  };
  errors: string[];
}

/** Dream schedule config */
export interface DreamConfig {
  dedupThreshold: number;       // default 0.88
  staleThresholdDays: number;   // default 60
  minImportanceToKeep: number;  // default 0.2
  maxRunTimeMs: number;         // default 300_000 (5 minutes)
  batchSize: number;            // default 200
}

const DEFAULT_DREAM_CONFIG: DreamConfig = {
  dedupThreshold: 0.88,
  staleThresholdDays: 60,
  minImportanceToKeep: 0.2,
  maxRunTimeMs: 300_000,
  batchSize: 200,
};

// ============================================================================
// Internal helpers
// ============================================================================

interface ScrollPoint {
  id: string;
  payload: Record<string, unknown>;
  vector?: number[];
}

async function scrollBatch(
  qdrantUrl: string,
  collection: string,
  limit: number,
  offset?: string | number | null,
): Promise<{ points: ScrollPoint[]; nextOffset: string | number | null }> {
  const body: Record<string, unknown> = {
    limit,
    filter: { must: [{ key: "deleted", match: { value: false } }] },
    with_payload: true,
    with_vector: true,
  };
  if (offset !== undefined && offset !== null) {
    body.offset = offset;
  }

  const res = await fetch(`${qdrantUrl}/collections/${collection}/points/scroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) return { points: [], nextOffset: null };
  const data = (await res.json()) as {
    result: { points: ScrollPoint[]; next_page_offset?: string | number | null };
  };
  return {
    points: data.result.points || [],
    nextOffset: data.result.next_page_offset ?? null,
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

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

// ============================================================================
// Phase 1: Aggressive Dedup
// ============================================================================

/**
 * Scroll collection in batches, compare within each batch.
 * Threshold 0.88 (lower than real-time 0.92 for more merges).
 */
export async function dreamDedup(
  qdrantUrl: string,
  collection: string,
  config: DreamConfig,
): Promise<{ merged: number; deletedIds: string[] }> {
  let merged = 0;
  const deletedIds: string[] = [];
  const alreadyDeleted = new Set<string>();
  let offset: string | number | null = null;
  const startTime = Date.now();

  while (true) {
    const batch = await scrollBatch(qdrantUrl, collection, config.batchSize, offset);
    if (batch.points.length === 0) break;

    // Compare all pairs within batch
    for (let i = 0; i < batch.points.length; i++) {
      const a = batch.points[i];
      if (alreadyDeleted.has(a.id)) continue;
      if (!a.vector || !Array.isArray(a.vector)) continue;

      for (let j = i + 1; j < batch.points.length; j++) {
        const b = batch.points[j];
        if (alreadyDeleted.has(b.id)) continue;
        if (!b.vector || !Array.isArray(b.vector)) continue;

        const sim = cosineSimilarity(a.vector as number[], b.vector as number[]);
        if (sim < config.dedupThreshold) continue;

        // Keep the one with more access_count
        const countA = (a.payload.access_count as number) || 0;
        const countB = (b.payload.access_count as number) || 0;
        const keeper = countA >= countB ? a : b;
        const loser = countA >= countB ? b : a;

        const keeperCount = (keeper.payload.access_count as number) || 0;
        const loserCount = (loser.payload.access_count as number) || 0;
        const keeperTimes = (keeper.payload.access_times as number[]) || [];
        const loserTimes = (loser.payload.access_times as number[]) || [];
        const keeperLinks = (keeper.payload.linked_memories as string[]) || [];
        const loserLinks = (loser.payload.linked_memories as string[]) || [];
        const keeperImportance = (keeper.payload.importance as number) ?? 0.5;
        const loserImportance = (loser.payload.importance as number) ?? 0.5;

        // Merge metadata on keeper
        await setPayload(qdrantUrl, collection, keeper.id, {
          access_count: keeperCount + loserCount,
          access_times: [...keeperTimes, ...loserTimes],
          linked_memories: [...new Set([...keeperLinks, ...loserLinks])],
          importance: Math.max(keeperImportance, loserImportance),
          metadata: {
            ...((keeper.payload.metadata as Record<string, unknown>) || {}),
            dream_merged_from: loser.id,
            dream_merged_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        });

        // Soft-delete loser
        await setPayload(qdrantUrl, collection, loser.id, {
          deleted: true,
          metadata: {
            ...((loser.payload.metadata as Record<string, unknown>) || {}),
            dream_merged_into: keeper.id,
            dream_merged_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        });

        alreadyDeleted.add(loser.id);
        deletedIds.push(loser.id);
        merged++;
      }
    }

    offset = batch.nextOffset;
    if (!offset) break;
    if (Date.now() - startTime > config.maxRunTimeMs) break;
  }

  return { merged, deletedIds };
}

// ============================================================================
// Phase 2: Merge episodic -> semantic
// ============================================================================

/**
 * Find episodic memories about same topic (similarity > 0.80),
 * merge into single semantic memory preserving all access_times.
 */
export async function dreamMerge(
  qdrantUrl: string,
  collection: string,
  config: DreamConfig,
): Promise<{ merged: number }> {
  let merged = 0;
  const alreadyMerged = new Set<string>();
  let offset: string | number | null = null;
  const startTime = Date.now();

  while (true) {
    const batch = await scrollBatch(qdrantUrl, collection, config.batchSize, offset);
    if (batch.points.length === 0) break;

    // Filter to episodic memories only
    const episodics = batch.points.filter(
      p => (p.payload.memory_type as string) === "episodic" && !alreadyMerged.has(p.id),
    );

    // Group similar episodics (>0.80)
    for (let i = 0; i < episodics.length; i++) {
      const a = episodics[i];
      if (alreadyMerged.has(a.id)) continue;
      if (!a.vector || !Array.isArray(a.vector)) continue;

      const group = [a];

      for (let j = i + 1; j < episodics.length; j++) {
        const b = episodics[j];
        if (alreadyMerged.has(b.id)) continue;
        if (!b.vector || !Array.isArray(b.vector)) continue;

        const sim = cosineSimilarity(a.vector as number[], b.vector as number[]);
        if (sim >= 0.80) {
          group.push(b);
        }
      }

      // Need at least 2 to merge
      if (group.length < 2) continue;

      // Pick the one with the highest access_count as the keeper
      group.sort((x, y) =>
        ((y.payload.access_count as number) || 0) - ((x.payload.access_count as number) || 0),
      );
      const keeper = group[0];
      const losers = group.slice(1);

      // Merge all access_times and links into keeper
      let mergedTimes = (keeper.payload.access_times as number[]) || [];
      let mergedLinks = (keeper.payload.linked_memories as string[]) || [];
      let totalCount = (keeper.payload.access_count as number) || 0;
      let maxImportance = (keeper.payload.importance as number) ?? 0.5;

      for (const loser of losers) {
        mergedTimes = [...mergedTimes, ...((loser.payload.access_times as number[]) || [])];
        mergedLinks = [...mergedLinks, ...((loser.payload.linked_memories as string[]) || [])];
        totalCount += (loser.payload.access_count as number) || 0;
        maxImportance = Math.max(maxImportance, (loser.payload.importance as number) ?? 0.5);
      }

      // Promote keeper to semantic
      await setPayload(qdrantUrl, collection, keeper.id, {
        memory_type: "semantic",
        access_count: totalCount,
        access_times: mergedTimes,
        linked_memories: [...new Set(mergedLinks)],
        importance: maxImportance,
        metadata: {
          ...((keeper.payload.metadata as Record<string, unknown>) || {}),
          dream_promoted_from: "episodic",
          dream_promoted_at: new Date().toISOString(),
          dream_merged_count: losers.length,
        },
        updated_at: new Date().toISOString(),
      });

      // Soft-delete losers
      for (const loser of losers) {
        await setPayload(qdrantUrl, collection, loser.id, {
          deleted: true,
          metadata: {
            ...((loser.payload.metadata as Record<string, unknown>) || {}),
            dream_merged_into: keeper.id,
            dream_merged_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        });
        alreadyMerged.add(loser.id);
      }
      alreadyMerged.add(keeper.id);
      merged += losers.length;
    }

    offset = batch.nextOffset;
    if (!offset) break;
    if (Date.now() - startTime > config.maxRunTimeMs) break;
  }

  return { merged };
}

// ============================================================================
// Phase 3: Prune stale memories
// ============================================================================

/**
 * Archive (soft-delete) memories with:
 *   - activation < -4.0 AND
 *   - importance < minImportanceToKeep AND
 *   - memoryType not in [core, procedural]
 */
export async function dreamPrune(
  qdrantUrl: string,
  collection: string,
  config: DreamConfig,
): Promise<{ archived: number }> {
  let archived = 0;
  const nowMs = Date.now();
  let offset: string | number | null = null;
  const startTime = Date.now();

  while (true) {
    const batch = await scrollBatch(qdrantUrl, collection, config.batchSize, offset);
    if (batch.points.length === 0) break;

    for (const p of batch.points) {
      const memoryType = (p.payload.memory_type as string) || "semantic";
      if (memoryType === "core" || memoryType === "procedural") continue;

      const importance = (p.payload.importance as number) ?? 0.5;
      if (importance >= config.minImportanceToKeep) continue;

      const accessTimes = (p.payload.access_times as number[]) || [];
      const urgency = (p.payload.urgency as UrgencyLevel) || "reference";
      const createdAtStr = (p.payload.created_at as string) || "";
      const createdAtMs = createdAtStr ? new Date(createdAtStr).getTime() : undefined;

      const activation = computeActivation(
        accessTimes,
        urgency,
        memoryType as MemoryType,
        nowMs,
        createdAtMs,
      );

      if (activation < -4.0) {
        const ok = await setPayload(qdrantUrl, collection, p.id, {
          deleted: true,
          metadata: {
            ...((p.payload.metadata as Record<string, unknown>) || {}),
            dream_archived: true,
            dream_archived_at: new Date().toISOString(),
            dream_archive_reason: `activation=${activation.toFixed(2)}, importance=${importance}`,
          },
          updated_at: new Date().toISOString(),
        });
        if (ok) archived++;
      }
    }

    offset = batch.nextOffset;
    if (!offset) break;
    if (Date.now() - startTime > config.maxRunTimeMs) break;
  }

  return { archived };
}

// ============================================================================
// Phase 4: Strengthen frequently-used memories
// ============================================================================

/**
 * Memories with access_count > 5 get importance += 0.1 (cap 1.0).
 * Memories with usefulness_ratio > 0.5 get confidence += 0.05.
 */
export async function dreamStrengthen(
  qdrantUrl: string,
  collection: string,
  config: DreamConfig,
): Promise<{ strengthened: number }> {
  let strengthened = 0;
  let offset: string | number | null = null;
  const startTime = Date.now();

  while (true) {
    const batch = await scrollBatch(qdrantUrl, collection, config.batchSize, offset);
    if (batch.points.length === 0) break;

    for (const p of batch.points) {
      const accessCount = (p.payload.access_count as number) || 0;
      const importance = (p.payload.importance as number) ?? 0.5;
      const confidence = (p.payload.confidence as number) ?? 0.7;
      const meta = (p.payload.metadata as Record<string, unknown>) || {};
      const usefulnessRatio = (meta.usefulness_ratio as number) ?? 0;

      let newImportance = importance;
      let newConfidence = confidence;
      let changed = false;

      if (accessCount > 5 && importance < 1.0) {
        newImportance = Math.min(1.0, importance + 0.1);
        changed = true;
      }

      if (usefulnessRatio > 0.5 && confidence < 1.0) {
        newConfidence = Math.min(1.0, confidence + 0.05);
        changed = true;
      }

      if (changed) {
        const ok = await setPayload(qdrantUrl, collection, p.id, {
          importance: newImportance,
          confidence: newConfidence,
          metadata: {
            ...meta,
            dream_strengthened_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        });
        if (ok) strengthened++;
      }
    }

    offset = batch.nextOffset;
    if (!offset) break;
    if (Date.now() - startTime > config.maxRunTimeMs) break;
  }

  return { strengthened };
}

// ============================================================================
// Dream History: shouldRunDream
// ============================================================================

const DREAM_META_KEY = "dream_last_run";

/**
 * Check if dream should run (last run > 12 hours ago).
 * Stores last run timestamp in a special Qdrant point.
 */
export async function shouldRunDream(
  qdrantUrl: string,
  agentId: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.PRIVATE}/points/scroll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limit: 1,
          filter: {
            must: [
              { key: "agent_id", match: { value: agentId } },
              { key: "deleted", match: { value: false } },
              { key: "metadata.source", match: { value: DREAM_META_KEY } },
            ],
          },
          with_payload: true,
        }),
      },
    );

    if (!res.ok) return true; // If can't check, allow running
    const data = (await res.json()) as {
      result: { points: Array<{ payload: Record<string, unknown> }> };
    };

    const points = data.result.points || [];
    if (points.length === 0) return true; // Never run before

    const lastRunStr = (points[0].payload.updated_at as string) || "";
    if (!lastRunStr) return true;

    const lastRunMs = new Date(lastRunStr).getTime();
    const hoursSince = (Date.now() - lastRunMs) / 3_600_000;
    return hoursSince >= 12;
  } catch {
    return true; // On error, allow running
  }
}

/**
 * Record that a dream run completed.
 */
async function recordDreamRun(
  qdrantUrl: string,
  agentId: string,
  report: DreamReport,
): Promise<void> {
  try {
    // Use a deterministic ID so we always overwrite the same point
    const id = `dream-meta-${agentId}`;

    // Create a zero vector (we don't need embedding for this metadata point)
    const zeroVector = new Array(768).fill(0);
    zeroVector[0] = 0.001; // Avoid all-zero

    await fetch(`${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.PRIVATE}/points`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wait: true,
        points: [{
          id,
          vector: zeroVector,
          payload: {
            text: `Dream consolidation report: ${report.stats.memoriesScanned} scanned, ${report.stats.duplicatesMerged} deduped, ${report.stats.staleArchived} pruned`,
            agent_id: agentId,
            memory_type: "semantic",
            scope: "private",
            classification: "private",
            category: "other",
            urgency: "background",
            domain: "knowledge",
            confidence: 1.0,
            confidence_tag: "grounded",
            priority_score: 0.1,
            importance: 0.1,
            linked_memories: [],
            access_times: [Date.now()],
            access_count: 0,
            event_time: report.startedAt,
            ingested_at: new Date().toISOString(),
            created_at: report.startedAt,
            updated_at: report.completedAt,
            deleted: false,
            metadata: {
              source: DREAM_META_KEY,
              report: {
                phase: report.phase,
                durationMs: report.durationMs,
                stats: report.stats,
                errors: report.errors.slice(0, 10),
              },
            },
          },
        }],
      }),
    });
  } catch {
    // Non-fatal: recording failure doesn't affect dream results
  }
}

/**
 * Get the last dream report, if any.
 */
export async function getLastDreamReport(
  qdrantUrl: string,
  agentId: string,
): Promise<DreamReport | null> {
  try {
    const res = await fetch(
      `${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.PRIVATE}/points/scroll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limit: 1,
          filter: {
            must: [
              { key: "agent_id", match: { value: agentId } },
              { key: "deleted", match: { value: false } },
              { key: "metadata.source", match: { value: DREAM_META_KEY } },
            ],
          },
          with_payload: true,
        }),
      },
    );

    if (!res.ok) return null;
    const data = (await res.json()) as {
      result: { points: Array<{ payload: Record<string, unknown> }> };
    };

    const points = data.result.points || [];
    if (points.length === 0) return null;

    const meta = (points[0].payload.metadata as Record<string, unknown>) || {};
    const reportData = meta.report as Record<string, unknown> | undefined;
    if (!reportData) return null;

    return {
      phase: (reportData.phase as DreamPhase) || "complete",
      startedAt: (points[0].payload.created_at as string) || "",
      completedAt: (points[0].payload.updated_at as string) || "",
      durationMs: (reportData.durationMs as number) || 0,
      stats: (reportData.stats as DreamReport["stats"]) || {
        memoriesScanned: 0,
        duplicatesMerged: 0,
        staleArchived: 0,
        contradictionsResolved: 0,
        promoted: 0,
        demoted: 0,
        patternsDiscovered: 0,
        lessonsAbstracted: 0,
        spaceSavedBytes: 0,
      },
      errors: (reportData.errors as string[]) || [],
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Full Dream Consolidation Cycle
// ============================================================================

/**
 * Run full dream consolidation cycle.
 * Phases run sequentially. Respects maxRunTimeMs -- aborts if exceeded.
 * Designed to be called via cron or scheduled job.
 */
export async function runDreamConsolidation(
  qdrantUrl: string,
  agentId: string,
  userConfig?: Partial<DreamConfig>,
): Promise<DreamReport> {
  const config: DreamConfig = { ...DEFAULT_DREAM_CONFIG, ...userConfig };
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const errors: string[] = [];
  const collection = DEFAULT_COLLECTIONS.SHARED;

  const stats: DreamReport["stats"] = {
    memoriesScanned: 0,
    duplicatesMerged: 0,
    staleArchived: 0,
    contradictionsResolved: 0,
    promoted: 0,
    demoted: 0,
    patternsDiscovered: 0,
    lessonsAbstracted: 0,
    spaceSavedBytes: 0,
  };

  // Count total memories for reporting
  try {
    const countRes = await fetch(`${qdrantUrl}/collections/${collection}`);
    if (countRes.ok) {
      const countData = (await countRes.json()) as { result: { points_count: number } };
      stats.memoriesScanned = countData.result.points_count;
    }
  } catch { /* non-fatal */ }

  // Phase 1: Aggressive dedup
  if (Date.now() - startTime < config.maxRunTimeMs) {
    try {
      const dedupResult = await dreamDedup(qdrantUrl, collection, config);
      stats.duplicatesMerged = dedupResult.merged;
    } catch (err) {
      errors.push(`dedup: ${String(err)}`);
    }
  }

  // Phase 2: Merge episodic -> semantic
  if (Date.now() - startTime < config.maxRunTimeMs) {
    try {
      const mergeResult = await dreamMerge(qdrantUrl, collection, config);
      stats.promoted = mergeResult.merged;
    } catch (err) {
      errors.push(`merge: ${String(err)}`);
    }
  }

  // Phase 3: Prune stale
  if (Date.now() - startTime < config.maxRunTimeMs) {
    try {
      const pruneResult = await dreamPrune(qdrantUrl, collection, config);
      stats.staleArchived = pruneResult.archived;
    } catch (err) {
      errors.push(`prune: ${String(err)}`);
    }
  }

  // Phase 4: Strengthen
  if (Date.now() - startTime < config.maxRunTimeMs) {
    try {
      const strengthenResult = await dreamStrengthen(qdrantUrl, collection, config);
      stats.demoted = 0;
      stats.lessonsAbstracted = strengthenResult.strengthened;
    } catch (err) {
      errors.push(`strengthen: ${String(err)}`);
    }
  }

  // Phase 5: Pattern mining (optional -- skip if time is running out)
  if (Date.now() - startTime < config.maxRunTimeMs - 60_000) {
    try {
      // Dynamic import to avoid circular dependency
      const { runPatternMining } = await import("./pattern-miner.js");
      const miningReport = await runPatternMining(qdrantUrl, "", null, agentId, config.batchSize);
      stats.patternsDiscovered = miningReport.patterns.length;
    } catch (err) {
      errors.push(`mine: ${String(err)}`);
    }
  }

  const completedAt = new Date().toISOString();
  const report: DreamReport = {
    phase: "complete",
    startedAt,
    completedAt,
    durationMs: Date.now() - startTime,
    stats,
    errors,
  };

  // Record the dream run for shouldRunDream checks
  await recordDreamRun(qdrantUrl, agentId, report);

  return report;
}

// ============================================================================
// Convenience: format report for display
// ============================================================================

export function formatDreamReport(report: DreamReport): string {
  const lines = [
    `Dream Consolidation Report (${(report.durationMs / 1000).toFixed(1)}s):`,
    `  Memories scanned: ${report.stats.memoriesScanned}`,
    `  Duplicates merged: ${report.stats.duplicatesMerged}`,
    `  Episodic -> semantic: ${report.stats.promoted}`,
    `  Stale archived: ${report.stats.staleArchived}`,
    `  Strengthened: ${report.stats.lessonsAbstracted}`,
    `  Patterns discovered: ${report.stats.patternsDiscovered}`,
    `  Started: ${report.startedAt}`,
    `  Completed: ${report.completedAt}`,
  ];
  if (report.errors.length > 0) {
    lines.push(`  Errors: ${report.errors.join("; ")}`);
  }
  return lines.join("\n");
}
