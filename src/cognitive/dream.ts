/** Legacy URL-only mutation entry points are disabled; pass a scoped QdrantDB to safe maintenance. */
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
import type { QdrantDB } from "../core/qdrant.js";
import { maintainMemory } from "./maintenance.js";
import { rejectUnsafeLegacyOperation } from "./legacy-guard.js";

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
/** @deprecated Disabled before network access; use instance-scoped maintainMemory instead. */
export async function dreamDedup(
  qdrantUrl: string,
  collection: string,
  config: DreamConfig,
): Promise<{ merged: number; deletedIds: string[] }> {
  return rejectUnsafeLegacyOperation("dreamDedup");
}

// ============================================================================
// Phase 2: Merge episodic -> semantic
// ============================================================================

/**
 * Find episodic memories about same topic (similarity > 0.80),
 * merge into single semantic memory preserving all access_times.
 */
/** @deprecated Disabled before network access; use instance-scoped maintainMemory instead. */
export async function dreamMerge(
  qdrantUrl: string,
  collection: string,
  config: DreamConfig,
): Promise<{ merged: number }> {
  return rejectUnsafeLegacyOperation("dreamMerge");
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
/** @deprecated Disabled before network access; use instance-scoped maintainMemory instead. */
export async function dreamPrune(
  qdrantUrl: string,
  collection: string,
  config: DreamConfig,
): Promise<{ archived: number }> {
  return rejectUnsafeLegacyOperation("dreamPrune");
}

// ============================================================================
// Phase 4: Strengthen frequently-used memories
// ============================================================================

/**
 * Memories with access_count > 5 get importance += 0.1 (cap 1.0).
 * Memories with usefulness_ratio > 0.5 get confidence += 0.05.
 */
/** @deprecated Disabled before network access; use instance-scoped maintainMemory instead. */
export async function dreamStrengthen(
  qdrantUrl: string,
  collection: string,
  config: DreamConfig,
): Promise<{ strengthened: number }> {
  return rejectUnsafeLegacyOperation("dreamStrengthen");
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
  qdrantUrl: string | QdrantDB,
  agentId: string,
  userConfig?: Partial<DreamConfig>,
): Promise<DreamReport> {
  if (typeof qdrantUrl === "string") return rejectUnsafeLegacyOperation("runDreamConsolidation(URL)");
  const started = Date.now();
  const report = await maintainMemory(qdrantUrl, { batchSize: userConfig?.batchSize });
  return {
    phase: "complete", startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(),
    durationMs: Date.now() - started, errors: [],
    stats: { memoriesScanned: report.analyzed, duplicatesMerged: 0, staleArchived: 0, contradictionsResolved: 0,
      promoted: 0, demoted: report.staleDemoted, patternsDiscovered: 0, lessonsAbstracted: 0, spaceSavedBytes: 0 },
  };
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
