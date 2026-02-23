/**
 * Proactive Memory Surfacing -- "Last time you did X, Y broke"
 *
 * Gathers proactive suggestions before the agent acts:
 *   1. Lesson warnings -- vector search against stored lessons (anti_patterns, gotchas, fixes)
 *   2. Pattern predictions -- keyword match against mined patterns (recurring_error, sequence)
 *   3. Preference reminders -- check if current action conflicts with stated preferences
 *
 * Scoring: pattern confidence x recency x similarity to current context
 * Performance budget: <100ms total (vector search ~50ms, string matching ~5ms)
 *
 * Zero npm deps, zero LLM calls -- pure search + string matching.
 */

import type { MemCell, MemCellSearchResult } from "../core/types.js";
import { DEFAULT_COLLECTIONS } from "../core/types.js";
import type { Pattern } from "./pattern-miner.js";
import type { UserModel } from "./preferences.js";

// ============================================================================
// Types
// ============================================================================

export type SuggestionType =
  | "warning"          // "Last time you did X, Y went wrong"
  | "reminder"         // "Remember: you prefer X for this"
  | "prediction"       // "Based on patterns, Y usually follows X"
  | "recommendation";  // "Consider also: Z is related"

export type SuggestionPriority = "high" | "medium" | "low";

/** A proactive surfacing recommendation */
export interface ProactiveSuggestion {
  type: SuggestionType;
  priority: SuggestionPriority;
  text: string;             // human-readable suggestion
  evidence: string[];       // memory IDs supporting this
  source: "lesson" | "pattern" | "sequence" | "preference";
  score: number;            // combined relevance score 0.0-1.0
}

/** Proactive context for injection into agent prompt */
export interface ProactiveWarningContext {
  suggestions: ProactiveSuggestion[];
  formatted: string;        // ready-to-inject text block
}

// ============================================================================
// Priority Ordering
// ============================================================================

const PRIORITY_ORDER: Record<SuggestionPriority, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function compareSuggestions(a: ProactiveSuggestion, b: ProactiveSuggestion): number {
  const pDiff = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
  if (pDiff !== 0) return pDiff;
  return b.score - a.score;
}

// ============================================================================
// 1. Lesson Warnings (vector search)
// ============================================================================

/**
 * Search stored lessons for warnings relevant to the current prompt.
 * Uses Qdrant vector search on memories with metadata.source="lesson_extraction".
 * Budget: ~50ms.
 */
export async function findWarningLessons(
  qdrantUrl: string,
  promptVector: number[],
  minScore = 0.55,
): Promise<ProactiveSuggestion[]> {
  try {
    const res = await fetch(
      `${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.SHARED}/points/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vector: promptVector,
          limit: 5,
          score_threshold: minScore,
          filter: {
            must: [
              { key: "deleted", match: { value: false } },
              { key: "metadata.source", match: { value: "lesson_extraction" } },
            ],
          },
          with_payload: true,
        }),
        signal: AbortSignal.timeout(80),
      },
    );

    if (!res.ok) return [];

    const data = (await res.json()) as {
      result: Array<{
        id: string;
        score: number;
        payload: Record<string, unknown>;
      }>;
    };

    return (data.result || [])
      .filter(r => r.score >= minScore)
      .map(r => {
        const meta = (r.payload.metadata as Record<string, unknown>) || {};
        const lessonType = (meta.lesson_type as string) || "";
        const isAntiPattern = lessonType === "anti_pattern" || lessonType === "gotcha";
        const recencyWeight = computeRecencyWeight(r.payload.created_at as string | undefined);

        return {
          type: (isAntiPattern ? "warning" : "reminder") as SuggestionType,
          priority: (r.score >= 0.75 ? "high" : r.score >= 0.6 ? "medium" : "low") as SuggestionPriority,
          text: (r.payload.text as string) || "",
          evidence: [String(r.id)],
          source: "lesson" as const,
          score: r.score * recencyWeight,
        };
      });
  } catch {
    // Timeout or network error -- graceful degradation
    return [];
  }
}

// ============================================================================
// 2. Pattern Predictions (keyword matching against mined patterns)
// ============================================================================

/**
 * Check if user prompt matches any mined patterns (recurring errors, sequences).
 * Pure string matching -- no network calls. Budget: ~5ms.
 */
export function findPatternPredictions(
  userPrompt: string,
  patterns: Pattern[],
): ProactiveSuggestion[] {
  if (!patterns.length || !userPrompt) return [];

  const suggestions: ProactiveSuggestion[] = [];
  const promptLower = userPrompt.toLowerCase();
  const promptWords = new Set(
    promptLower.split(/\W+/).filter(w => w.length > 3),
  );

  for (const pattern of patterns) {
    // Only surface recurring_error, sequence, and correlation patterns as predictions
    if (
      pattern.type !== "recurring_error" &&
      pattern.type !== "sequence" &&
      pattern.type !== "correlation"
    ) {
      continue;
    }

    // Extract significant words from pattern description
    const descWords = pattern.description
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 3);

    if (descWords.length === 0) continue;

    // Count keyword overlap
    const matchCount = descWords.filter(w => promptWords.has(w)).length;
    const matchRatio = matchCount / descWords.length;

    // Require at least 2 matches OR 40% overlap
    if (matchCount < 2 && matchRatio < 0.4) continue;

    const recencyWeight = computeRecencyWeight(pattern.lastSeen);
    const score = pattern.confidence * matchRatio * recencyWeight;

    const typeLabel = pattern.type === "recurring_error" ? "warning" : "prediction";
    const priority = score >= 0.6 ? "high" : score >= 0.35 ? "medium" : "low";

    suggestions.push({
      type: typeLabel as SuggestionType,
      priority: priority as SuggestionPriority,
      text: pattern.type === "recurring_error"
        ? `Warning: ${pattern.description} -- this error pattern has occurred ${pattern.occurrences} times before`
        : `Pattern: ${pattern.description} (${pattern.occurrences} occurrences, ${Math.round(pattern.confidence * 100)}% confidence)`,
      evidence: pattern.evidenceIds.slice(0, 5),
      source: "pattern" as const,
      score,
    });
  }

  return suggestions;
}

// ============================================================================
// 3. Preference Reminders
// ============================================================================

/**
 * Check if user prompt suggests an action that conflicts with stated preferences.
 * Pure computation. Budget: ~2ms.
 */
export function findPreferenceReminders(
  userPrompt: string,
  model: UserModel | null,
): ProactiveSuggestion[] {
  if (!model || !model.preferences || model.preferences.size === 0) return [];

  const suggestions: ProactiveSuggestion[] = [];
  const promptLower = userPrompt.toLowerCase();

  for (const [, pref] of model.preferences) {
    if (pref.strength < 0.4) continue; // Weak preferences not worth surfacing

    // Check for preference-relevant keywords in prompt
    const prefKeywords = pref.value
      .toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 3);

    const prefKey = pref.key.toLowerCase().split(/[:/]/).filter(w => w.length > 2);
    const allKeywords = [...new Set([...prefKeywords, ...prefKey])];
    if (allKeywords.length === 0) continue;

    const matchCount = allKeywords.filter(w => promptLower.includes(w)).length;
    if (matchCount < 1) continue;

    // Check for conflict indicators: user doing opposite of preference
    const conflictPairs: Array<[string, string]> = [
      ["typescript", "javascript"],
      ["python", "javascript"],
      ["vim", "vscode"],
      ["docker", "bare metal"],
      ["redis", "memcached"],
      ["postgres", "mysql"],
      ["concise", "verbose"],
      ["brief", "detailed"],
    ];

    let isConflict = false;
    const prefKeyLower = pref.key.toLowerCase();
    for (const [a, b] of conflictPairs) {
      const prefersA = prefKeyLower.includes(a);
      const prefersB = prefKeyLower.includes(b);

      if (prefersA && promptLower.includes(b) && !promptLower.includes(a)) {
        isConflict = true;
        break;
      }
      if (prefersB && promptLower.includes(a) && !promptLower.includes(b)) {
        isConflict = true;
        break;
      }
    }

    // Only surface as reminder if there's a conflict or strong relevance
    if (!isConflict && matchCount < 2) continue;

    suggestions.push({
      type: isConflict ? "warning" : "reminder",
      priority: isConflict ? "medium" : "low",
      text: isConflict
        ? `Note: Your preference is "${pref.value}" (strength: ${Math.round(pref.strength * 100)}%, seen ${pref.evidenceCount} times)`
        : `Reminder: ${pref.value}`,
      evidence: pref.sources.slice(0, 3),
      source: "preference" as const,
      score: pref.strength * (isConflict ? 0.8 : 0.5),
    });
  }

  return suggestions;
}

// ============================================================================
// Format & Combine
// ============================================================================

/**
 * Format suggestions into injectable context.
 * High-priority warnings go first. Max 3 suggestions.
 */
export function formatWarningContext(
  suggestions: ProactiveSuggestion[],
): ProactiveWarningContext {
  if (suggestions.length === 0) {
    return { suggestions: [], formatted: "" };
  }

  // Sort by priority then score, take top 3
  const sorted = [...suggestions].sort(compareSuggestions).slice(0, 3);

  const lines: string[] = ["--- Proactive Warnings ---"];

  for (const s of sorted) {
    const icon = s.type === "warning" ? "[!]"
      : s.type === "prediction" ? "[~]"
      : s.type === "reminder" ? "[i]"
      : "[+]";
    lines.push(`${icon} ${s.text}`);
  }

  return {
    suggestions: sorted,
    formatted: lines.join("\n"),
  };
}

// ============================================================================
// Main Gatherer
// ============================================================================

/**
 * Gather all proactive suggestions for a user prompt.
 * Runs lesson search (async) + pattern matching + preference check (sync).
 * Total budget: <100ms.
 */
export async function gatherProactiveWarnings(
  userPrompt: string,
  qdrantUrl: string,
  promptVector: number[],
  patterns: Pattern[],
  userModel: UserModel | null,
  frustrationLevel: number,
): Promise<ProactiveWarningContext> {
  const suggestions: ProactiveSuggestion[] = [];

  // 1. Lesson warnings (async, ~50ms budget)
  const lessonWarnings = await findWarningLessons(qdrantUrl, promptVector);
  suggestions.push(...lessonWarnings);

  // 2. Pattern predictions (sync, ~5ms)
  const predictions = findPatternPredictions(userPrompt, patterns);
  suggestions.push(...predictions);

  // 3. Preference reminders (sync, ~2ms)
  const reminders = findPreferenceReminders(userPrompt, userModel);
  suggestions.push(...reminders);

  // 4. Frustration adaptation: at high frustration, only show high-priority
  if (frustrationLevel >= 0.5) {
    const highOnly = suggestions.filter(s => s.priority === "high");
    return formatWarningContext(highOnly);
  }

  return formatWarningContext(suggestions);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compute a recency weight: recent items get a boost, old items are discounted.
 * Returns 0.5-1.0 based on age.
 */
function computeRecencyWeight(isoDate: string | undefined): number {
  if (!isoDate) return 0.7; // Unknown date -> neutral weight
  const ageMs = Date.now() - new Date(isoDate).getTime();
  if (isNaN(ageMs) || ageMs < 0) return 0.7;

  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // Within 1 day: 1.0, within 7 days: 0.9, within 30 days: 0.75, older: 0.5
  if (ageDays <= 1) return 1.0;
  if (ageDays <= 7) return 0.9;
  if (ageDays <= 30) return 0.75;
  if (ageDays <= 90) return 0.6;
  return 0.5;
}
