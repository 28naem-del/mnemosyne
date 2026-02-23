/**
 * Deduplication engine.
 * Hash-based exact check + semantic similarity check.
 * Conflict detection for contradictions.
 * Smart semantic dedup: merge >0.92 similarity + same type.
 */

import { createHash } from "node:crypto";
import type { MemCell, MemCellSearchResult } from "./types.js";

// Stable content hash for idempotent storage
export function contentHash(text: string): string {
  return createHash("sha256").update(text.trim().toLowerCase()).digest("hex");
}

// Stable numeric ID from content (for Qdrant point ID compat)
export function stableNumericId(text: string): number {
  const hex = createHash("md5").update(text).digest("hex").slice(0, 16);
  // Use BigInt to handle large hex, then convert to safe integer range
  return Number(BigInt("0x" + hex) % BigInt(Number.MAX_SAFE_INTEGER));
}

// Check if two texts are semantically similar enough to be duplicates
export function isDuplicate(similarity: number, threshold = 0.92): boolean {
  return similarity >= threshold;
}

// Detect potential contradiction between two memory texts
// Returns true if the texts seem to conflict (high similarity but opposite sentiment)
export function detectConflict(
  existingText: string,
  newText: string,
  similarity: number,
): { isConflict: boolean; reason?: string } {
  // High similarity (0.70-0.92) but containing negation words = potential conflict
  if (similarity < 0.70 || similarity >= 0.92) {
    return { isConflict: false };
  }

  const negations = /\b(not|no|never|don't|doesn't|isn't|wasn't|aren't|won't|can't|shouldn't|hate|dislike|stop|remove|delete)\b/i;
  const existingHasNeg = negations.test(existingText);
  const newHasNeg = negations.test(newText);

  if (existingHasNeg !== newHasNeg) {
    return {
      isConflict: true,
      reason: `Potential contradiction: existing ${existingHasNeg ? "negates" : "affirms"}, new ${newHasNeg ? "negates" : "affirms"}`,
    };
  }

  return { isConflict: false };
}

/**
 * Semantic merge result.
 * When two memories have >0.92 similarity AND the same type, merge them:
 * keep the newer one, link to the older one.
 */
export type SemanticMergeResult = {
  shouldMerge: boolean;
  keepId: string;
  dropId: string;
  mergedMetadata?: Record<string, unknown>;
};

/**
 * Check if an existing memory should be merged with a new one.
 * Criteria: >0.92 similarity AND same memory_type.
 * Returns merge instructions: keep newer, absorb older's metadata.
 */
export function shouldSemanticMerge(
  existing: MemCellSearchResult,
  newText: string,
  newType: string,
): SemanticMergeResult {
  const noMerge = { shouldMerge: false, keepId: "", dropId: "" };

  if (existing.score < 0.92) return noMerge;
  if (existing.entry.memoryType !== newType) return noMerge;

  // Newer replaces older — keep the new one, link to old
  return {
    shouldMerge: true,
    keepId: "new", // Sentinel: caller will use new memory's ID
    dropId: existing.entry.id,
    mergedMetadata: {
      merged_from: existing.entry.id,
      merged_at: new Date().toISOString(),
      merged_old_text: existing.entry.text.slice(0, 200),
      merged_old_importance: existing.entry.importance,
      merged_old_access_count: existing.entry.accessCount,
    },
  };
}

/**
 * Merge metadata from old memory into the new one's payload.
 * Preserves the higher importance, combines access counts, links old ID.
 */
export function buildMergedPayload(
  existingEntry: MemCell,
  newImportance: number,
  mergeResult: SemanticMergeResult,
): {
  importance: number;
  accessCount: number;
  linkedMemories: string[];
  metadata: Record<string, unknown>;
} {
  return {
    importance: Math.max(existingEntry.importance, newImportance),
    accessCount: existingEntry.accessCount, // Carry forward
    linkedMemories: [
      ...existingEntry.linkedMemories,
      existingEntry.id, // Link to the old memory
    ],
    metadata: mergeResult.mergedMetadata || {},
  };
}
