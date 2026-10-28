/** Instance-scoped maintenance. Similarity never authorizes deleting a fact. */
import type { QdrantDB } from "../core/qdrant.js";

export interface MaintenanceAction {
  collection: string;
  id: string;
  kind: "strengthen" | "demote";
  payload: Record<string, unknown>;
}

export interface MaintenanceReport {
  dryRun: boolean;
  analyzed: number;
  truncated: boolean;
  applied: number;
  actions: MaintenanceAction[];
  reviewCandidates: Array<{ collection: string; ids: [string, string]; reason: string }>;
  strengthened: number;
  promoted: number;
  archived: number;
  contradictions: number;
  merged: number;
  nearDuplicatesMerged: number;
  popularPromoted: number;
  staleDemoted: number;
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
}

/** Scan a bounded snapshot before writing so dry-run never reaches a write path. */
export async function maintainMemory(
  db: QdrantDB,
  options: { dryRun?: boolean; batchSize?: number; collections?: readonly string[] } = {},
): Promise<MaintenanceReport> {
  const batchSize = options.batchSize ?? 200;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("Maintenance batchSize must be a positive integer");
  const allowed = [db.collections.shared, db.collections.private];
  const collections = options.collections ?? allowed;
  if (collections.some(collection => !allowed.includes(collection))) throw new Error("Maintenance collection is outside the configured instance scope");
  const now = Date.now();
  const actions: MaintenanceAction[] = [];
  const reviewCandidates: MaintenanceReport["reviewCandidates"] = [];
  let analyzed = 0;
  let truncated = false;

  for (const collection of [...new Set(collections)]) {
    const page = await db.scanCollection(collection, batchSize);
    analyzed += page.memories.length;
    truncated ||= page.truncated;
    for (const memory of page.memories) {
      let action: MaintenanceAction | undefined;
      const metadata = { ...memory.metadata, maintenance_at: new Date(now).toISOString() };
      if (memory.accessCount >= 5 && memory.importance < 0.9) {
        action = { collection, id: memory.id, kind: "strengthen", payload: {
          importance: Math.min(1, memory.importance + 0.1), metadata, updated_at: new Date(now).toISOString(),
        } };
      } else if (memory.memoryType !== "core" && memory.memoryType !== "procedural" && memory.importance < 0.3) {
        const lastAccess = memory.accessTimes.length ? Math.max(...memory.accessTimes) : Date.parse(memory.createdAt);
        if (Number.isFinite(lastAccess) && now - lastAccess > 30 * 86_400_000) {
          action = { collection, id: memory.id, kind: "demote", payload: {
            priority_score: memory.priorityScore / 2, metadata, updated_at: new Date(now).toISOString(),
          } };
        }
      }
      if (action) actions.push(action);
    }

    // These are review candidates, not proven contradictions or equivalences.
    const termSets = page.memories.map(memory => tokens(memory.text));
    for (let i = 0; i < page.memories.length; i++) {
      for (let j = i + 1; j < page.memories.length; j++) {
        const a = page.memories[i], b = page.memories[j];
        const overlap = [...termSets[i]].filter(term => termSets[j].has(term)).length;
        const union = new Set([...termSets[i], ...termSets[j]]).size;
        if (union === 0 || overlap / union < 0.6) continue;
        reviewCandidates.push({ collection, ids: [a.id, b.id], reason: a.text.trim() === b.text.trim()
          ? "Identical text; review provenance and metadata before any merge"
          : "Overlapping text may describe different facts; both memories are retained" });
      }
    }
  }

  let applied = 0;
  let strengthened = 0;
  let staleDemoted = 0;
  if (!options.dryRun) {
    for (const action of actions) {
      // Re-read to avoid overwriting concurrently changed metadata or reviving a
      // deleted record with a payload write. This is not a database transaction.
      const current = await db.getScopedPoint(action.id, action.collection);
      if (!current) continue;
      action.payload.metadata = { ...current.cell.metadata, maintenance_at: new Date(now).toISOString() };
      await db.updatePayload(action.collection, action.id, action.payload);
      applied++;
      if (action.kind === "strengthen") strengthened++;
      else staleDemoted++;
    }
  }

  return {
    dryRun: options.dryRun ?? false, analyzed, truncated, applied, actions, reviewCandidates,
    strengthened, staleDemoted,
    promoted: 0, archived: 0, contradictions: 0, merged: 0, nearDuplicatesMerged: 0, popularPromoted: 0,
  };
}
