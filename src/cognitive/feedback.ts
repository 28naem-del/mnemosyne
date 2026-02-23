/**
 * Self-Improving Retrieval
 *
 * Tracks which recalled memories were actually useful in the conversation.
 * Uses positive/negative feedback signals to adjust importance, confidence,
 * and compute usefulness ratios. Memories that consistently prove useful
 * get promoted; memories that get corrected get flagged for review.
 *
 * All updates via Qdrant set_payload API (no re-inserts).
 * No LLM calls -- purely algorithmic.
 */

import type { MemCell, MemCellSearchResult } from "../core/types.js";

export type FeedbackSignal = "positive" | "negative" | "neutral";

export type FeedbackResult = {
  memoryId: string;
  signal: FeedbackSignal;
  importanceDelta: number;
  confidenceDelta: number;
  newImportance: number;
  newConfidence: number;
  usefulnessRatio: number;
  promoted: boolean;
  flaggedForReview: boolean;
};

/**
 * Detect feedback signal from the user's response text.
 * Positive: thanks, correct, yes, exactly, perfect, good, right, helpful
 * Negative: no, wrong, incorrect, actually, not true, that's wrong, correction
 * Neutral: everything else
 */
export function detectFeedbackSignal(userResponse: string): FeedbackSignal {
  const lower = userResponse.toLowerCase().trim();

  const positivePatterns = [
    /\b(thanks|thank you|correct|exactly|perfect|great|good|right|yes|helpful|that's right|spot on|nice)\b/,
    /\b(makes sense|that works|got it|understood|useful)\b/,
    /^(yes|yep|yeah|yup|correct|right|exactly)\b/,
  ];

  const negativePatterns = [
    /\b(no|wrong|incorrect|actually|not true|that's wrong|correction|false|mistake|nope)\b/,
    /\b(that's not|that isn't|it's not|it isn't|you're wrong)\b/,
    /\b(outdated|old info|no longer|changed|updated since|not anymore)\b/,
  ];

  for (const p of negativePatterns) {
    if (p.test(lower)) return "negative";
  }
  for (const p of positivePatterns) {
    if (p.test(lower)) return "positive";
  }
  return "neutral";
}

/**
 * Compute feedback adjustments for a recalled memory based on user response.
 */
export function computeFeedback(
  memory: MemCell,
  signal: FeedbackSignal,
): FeedbackResult {
  const hitCount = (memory.metadata?.hit_count as number) || memory.accessCount || 1;
  const usefulCount = (memory.metadata?.useful_count as number) || 0;

  let importanceDelta = 0;
  let confidenceDelta = 0;
  let newUsefulCount = usefulCount;
  let flaggedForReview = (memory.metadata?.needs_review as boolean) || false;

  switch (signal) {
    case "positive":
      importanceDelta = 0.1;
      newUsefulCount = usefulCount + 1;
      flaggedForReview = false; // Clear review flag on positive signal
      break;
    case "negative":
      confidenceDelta = -0.1;
      flaggedForReview = true;
      break;
    case "neutral":
      // No change
      break;
  }

  const newImportance = Math.min(1.0, Math.max(0.0, memory.importance + importanceDelta));
  const newConfidence = Math.min(1.0, Math.max(0.1, memory.confidence + confidenceDelta));
  const newHitCount = hitCount + 1;
  const usefulnessRatio = newHitCount > 0 ? newUsefulCount / newHitCount : 0;

  // Promote if usefulness ratio > 0.7 and enough data points
  const promoted = usefulnessRatio > 0.7 && newHitCount >= 3;

  return {
    memoryId: memory.id,
    signal,
    importanceDelta,
    confidenceDelta,
    newImportance,
    newConfidence,
    usefulnessRatio,
    promoted,
    flaggedForReview,
  };
}

/**
 * Build Qdrant set_payload body for a feedback result.
 * Returns the payload fields to update.
 */
export function buildFeedbackPayload(
  feedback: FeedbackResult,
  existingMetadata: Record<string, unknown> = {},
): Record<string, unknown> {
  const hitCount = ((existingMetadata.hit_count as number) || 0) + 1;
  const usefulCount = feedback.signal === "positive"
    ? ((existingMetadata.useful_count as number) || 0) + 1
    : ((existingMetadata.useful_count as number) || 0);

  const metadata: Record<string, unknown> = {
    ...existingMetadata,
    hit_count: hitCount,
    useful_count: usefulCount,
    usefulness_ratio: hitCount > 0 ? usefulCount / hitCount : 0,
    needs_review: feedback.flaggedForReview,
    last_feedback: feedback.signal,
    last_feedback_at: new Date().toISOString(),
  };

  const payload: Record<string, unknown> = {
    importance: feedback.newImportance,
    confidence: feedback.newConfidence,
    metadata,
    updated_at: new Date().toISOString(),
  };

  // Promote to core if consistently useful
  if (feedback.promoted) {
    payload.memory_type = "core";
    metadata.promoted_by = "memory_feedback";
    metadata.promoted_at = new Date().toISOString();
  }

  return payload;
}

/**
 * Apply feedback to a memory in Qdrant via set_payload.
 * Does NOT re-insert -- only updates payload fields.
 */
export async function applyFeedback(
  qdrantUrl: string,
  collection: string,
  memoryId: string,
  feedback: FeedbackResult,
  existingMetadata: Record<string, unknown> = {},
): Promise<boolean> {
  try {
    const payload = buildFeedbackPayload(feedback, existingMetadata);

    const res = await fetch(
      `${qdrantUrl}/collections/${collection}/points/payload`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wait: true,
          points: [memoryId],
          payload,
        }),
      },
    );

    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Detect which recalled memories the user actually referenced in their response.
 * A memory is "referenced" if the user's response contains significant overlapping
 * phrases from the memory text (3+ word sequences).
 *
 * Algorithmic only -- no LLM calls.
 */
export function detectReferencedMemories(
  recalledMemories: MemCellSearchResult[],
  userResponse: string,
): Set<string> {
  const referencedIds = new Set<string>();
  const responseLower = userResponse.toLowerCase();
  const responseWords = responseLower.split(/\s+/).filter(w => w.length > 2);

  for (const recalled of recalledMemories) {
    const memWords = recalled.entry.text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (memWords.length < 3) continue;

    // Check for 3-gram overlap (3 consecutive words from memory appearing in response)
    let referenced = false;
    for (let i = 0; i <= memWords.length - 3; i++) {
      const trigram = memWords.slice(i, i + 3).join(" ");
      if (responseLower.includes(trigram)) {
        referenced = true;
        break;
      }
    }

    // Also check if user quoted specific unique terms from memory
    // (proper nouns, long technical terms, identifiers)
    if (!referenced) {
      const uniqueTerms = memWords.filter(w =>
        /^[A-Z]/.test(recalled.entry.text.split(/\s+/).find(orig => orig.toLowerCase() === w) || "") ||
        w.length > 8
      );
      const matchCount = uniqueTerms.filter(t => responseWords.includes(t)).length;
      if (matchCount >= 2) referenced = true;
    }

    if (referenced) {
      referencedIds.add(recalled.entry.id);
    }
  }

  return referencedIds;
}

/**
 * Compute reference-aware feedback for recalled memories.
 * - Referenced memories: importance +0.05, useful_count++
 * - Unreferenced memories (after 5+ recalls with no references): importance -0.02
 * - Applies on top of standard positive/negative signal feedback
 */
export function computeReferenceFeedback(
  memory: MemCell,
  wasReferenced: boolean,
): { importanceDelta: number; metadata: Record<string, unknown> } {
  const recallCount = (memory.metadata?.recall_count as number) || 0;
  const refCount = (memory.metadata?.reference_count as number) || 0;

  const newRecallCount = recallCount + 1;
  const newRefCount = wasReferenced ? refCount + 1 : refCount;
  const referenceRatio = newRecallCount > 0 ? newRefCount / newRecallCount : 0;

  let importanceDelta = 0;
  if (wasReferenced) {
    importanceDelta = 0.05;
  } else if (newRecallCount >= 5 && referenceRatio < 0.2) {
    // Penalize memories that are recalled 5+ times but almost never referenced
    importanceDelta = -0.02;
  }

  return {
    importanceDelta,
    metadata: {
      recall_count: newRecallCount,
      reference_count: newRefCount,
      reference_ratio: referenceRatio,
      last_recall_at: new Date().toISOString(),
    },
  };
}

/**
 * Process feedback for a batch of recalled memories after a user response.
 * Enhanced with reference tracking: tracks which memories the user
 * actually references, boosting referenced ones and penalizing ignored ones.
 *
 * This is the main entry point -- call after each recall+response cycle.
 */
export async function memoryFeedback(
  qdrantUrl: string,
  collection: string,
  recalledMemories: MemCellSearchResult[],
  userResponse: string,
): Promise<FeedbackResult[]> {
  const signal = detectFeedbackSignal(userResponse);

  // Detect which memories were actually referenced in the response
  const referencedIds = detectReferencedMemories(recalledMemories, userResponse);

  const results: FeedbackResult[] = [];

  for (const recalled of recalledMemories) {
    const wasReferenced = referencedIds.has(recalled.entry.id);
    const refFeedback = computeReferenceFeedback(recalled.entry, wasReferenced);

    // For neutral signal, only apply reference-based adjustments
    if (signal === "neutral") {
      if (refFeedback.importanceDelta !== 0 || wasReferenced) {
        // Apply reference tracking even on neutral signal
        const newImportance = Math.min(1.0, Math.max(0.0, recalled.entry.importance + refFeedback.importanceDelta));
        const existingMeta = recalled.entry.metadata || {};
        const payload: Record<string, unknown> = {
          importance: newImportance,
          metadata: { ...existingMeta, ...refFeedback.metadata },
          updated_at: new Date().toISOString(),
        };
        try {
          await fetch(`${qdrantUrl}/collections/${collection}/points/payload`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ wait: true, points: [recalled.entry.id], payload }),
          });
        } catch { /* non-fatal */ }
      }
      continue;
    }

    // Standard signal-based feedback
    const feedback = computeFeedback(recalled.entry, signal);

    // Combine signal feedback with reference feedback
    feedback.newImportance = Math.min(1.0, Math.max(0.0, feedback.newImportance + refFeedback.importanceDelta));

    const applied = await applyFeedback(
      qdrantUrl,
      collection,
      recalled.entry.id,
      feedback,
      { ...(recalled.entry.metadata || {}), ...refFeedback.metadata },
    );

    if (applied) {
      results.push(feedback);
    }
  }

  return results;
}
