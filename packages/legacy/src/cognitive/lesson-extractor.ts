/**
 * Auto Lesson Extraction
 *
 * Detects corrections, fixes, gotchas, learned facts, and anti-patterns
 * from conversation pairs and standalone messages. Stores them as
 * high-priority semantic memories with [LESSON] tags.
 *
 * Zero LLM calls -- pure regex pattern matching.
 */

import { randomUUID } from "node:crypto";
import type { MemCell, MemCellSearchResult } from "../core/types.js";
import { DEFAULT_COLLECTIONS } from "../core/types.js";

// -- Types --

export type LessonType =
  | "correction"     // "no, it's X not Y"
  | "fix"            // "the fix was to..."
  | "gotcha"         // "watch out for..." / "make sure to..."
  | "learned"        // "I learned that..." / "turns out..."
  | "anti_pattern";  // "don't do X because Y"

export interface Lesson {
  id: string;
  type: LessonType;
  wrongAssumption: string;    // what was wrong
  correction: string;         // what is correct
  context: string;            // surrounding context
  confidence: number;
  sourceMemoryId?: string;    // memory that was corrected (if identifiable)
}

export interface LessonExtractionResult {
  lessons: Lesson[];
  shouldStore: boolean;
}

// -- Detection Patterns --

type LessonPattern = RegExp | ((text: string) => string[] | null);

// Scan candidate prefixes/separators once. Repeated "not" or whitespace cannot
// cause the matcher to reconsider every possible split of the same suffix.
function matchContrastCorrection(text: string): string[] | null {
  const separators = [...text.matchAll(/(?:it'?s|but|it is|rather)(?=\s+.)/gi)];
  if (separators.length === 0) return null;
  const breaks = [...text.matchAll(/[\r\n\u2028\u2029]/g)].map(match => match.index);
  const bridges = new Map<number, number>();
  const lowerBound = (length: number, before: (i: number) => boolean) => {
    let lo = 0, hi = length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (before(mid)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (const prefix of text.matchAll(/not\s+/gi)) {
    const start = prefix.index + prefix[0].length;
    const firstBreak = breaks[lowerBound(breaks.length, i => breaks[i] < start)];
    let limit = text.length;
    if (firstBreak !== undefined) {
      if (!bridges.has(firstBreak)) {
        const whitespace = /\s*/y;
        whitespace.lastIndex = firstBreak;
        whitespace.exec(text);
        bridges.set(firstBreak, whitespace.lastIndex);
      }
      limit = bridges.get(firstBreak)!;
    }
    // Greedy prefix whitespace is tried before giving any of it back to the
    // required nonempty assumption. Binary search avoids rescanning suffixes.
    let candidate = separators[lowerBound(separators.length, i => separators[i].index <= start)];
    if (!candidate || candidate.index > limit) {
      candidate = separators[lowerBound(separators.length, i => separators[i].index < start)];
      const canGiveBack = /[^\r\n\u2028\u2029]/.test(prefix[0].slice(4));
      if (!candidate || candidate.index !== start || !canGiveBack) continue;
    }
    const rest = /^\s+(.+)/.exec(text.slice(candidate.index + candidate[0].length))!;
    return [candidate[0], "", rest[1]];
  }
  return null;
}

// Match a fixed failure phrase first, then inspect its preceding whitespace
// once. The previous wildcard/whitespace pair was cubic on the same payloads.
function matchFailureLesson(text: string): string[] | null {
  for (const phrase of text.matchAll(/(?:doesn't|does not|won't|will not) work/gi)) {
    let end = phrase.index;
    while (end > 0 && /\s/.test(text[end - 1])) end--;
    if (end === phrase.index) continue;
    let start = end;
    while (start > 0 && !/[\r\n\u2028\u2029]/.test(text[start - 1])) start--;
    const reason = /^\s*(?:because\s+(.+))?/.exec(text.slice(phrase.index + phrase[0].length))?.[1] ?? "";
    if (start < end) return [phrase[0], text.slice(start, end), reason];
    // Preserve the old match for whitespace-only assumptions (one character in
    // group 1, with at least one following whitespace character).
    for (let i = 0; i + 1 < phrase.index; i++) {
      if (!/[\r\n\u2028\u2029]/.test(text[i])) return [phrase[0], text[i], reason];
    }
  }
  return null;
}

function matchLesson(text: string, pattern: LessonPattern): string[] | null {
  return typeof pattern === "function" ? pattern(text) : text.match(pattern);
}

const CORRECTION_PATTERNS: LessonPattern[] = [
  /(?:no|nope|wrong|incorrect|actually),?\s*(?:it'?s|it is|that's|that is|the (?:correct|right|actual) (?:one|answer|value) is)\s+(.+)/i,
  matchContrastCorrection,
  /(?:should|must) be\s+(.+)/i,
  /(?:you|I think you) meant?\s+(.+)/i,
];

const FIX_PATTERNS: RegExp[] = [
  /(?:the )?fix (?:was|is) (?:to )?\s*(.+)/i,
  /(?:solved|fixed|resolved) (?:by|with|using)\s+(.+)/i,
  /(?:the )?solution (?:was|is)\s+(.+)/i,
  /I (?:fixed|solved|resolved) (?:it|this|that) (?:by|with)\s+(.+)/i,
];

const GOTCHA_PATTERNS: RegExp[] = [
  /(?:watch out|be careful|careful|beware|heads up|note that|remember that|make sure)\s+(.+)/i,
  /(?:don't|do not|never) forget (?:to )?\s*(.+)/i,
];

const LEARNED_PATTERNS: RegExp[] = [
  /(?:I learned|turns out|it turns out|TIL|found out)\s+(?:that )?\s*(.+)/i,
  /(?:the )?(?:trick|key|secret) (?:is|was)\s+(.+)/i,
];

const ANTI_PATTERN_PATTERNS: LessonPattern[] = [
  /(?:don't|do not|never|avoid)\s+(.+?)(?:\s+because\s+(.+))?$/i,
  matchFailureLesson,
];

// All pattern groups with their lesson types
const PATTERN_GROUPS: Array<[LessonPattern[], LessonType]> = [
  [CORRECTION_PATTERNS, "correction"],
  [FIX_PATTERNS, "fix"],
  [GOTCHA_PATTERNS, "gotcha"],
  [LEARNED_PATTERNS, "learned"],
  [ANTI_PATTERN_PATTERNS, "anti_pattern"],
];

// -- Detection Functions --

/**
 * Scan a message pair (bot response + user reply) for correction patterns.
 * The user reply correcting the bot response is the primary signal.
 */
export function detectLessons(
  botMessage: string,
  userReply: string,
): LessonExtractionResult {
  const lessons: Lesson[] = [];

  // Check correction patterns first (user reply contradicts bot)
  for (const pattern of CORRECTION_PATTERNS) {
    const match = matchLesson(userReply, pattern);
    if (match) {
      const wrongPart = botMessage.slice(0, 200);
      lessons.push({
        id: randomUUID(),
        type: "correction",
        wrongAssumption: wrongPart,
        correction: (match[2] || match[1]).trim(),
        context: userReply.slice(0, 300),
        confidence: 0.8,
      });
    }
  }

  // Check fix/gotcha/learned/anti_pattern patterns in user reply
  for (const [patterns, type] of PATTERN_GROUPS) {
    if (type === "correction") continue; // Already handled above
    for (const pattern of patterns) {
      const match = matchLesson(userReply, pattern);
      if (match) {
        lessons.push({
          id: randomUUID(),
          type,
          wrongAssumption: type === "anti_pattern" && match[2] ? match[1].trim() : "",
          correction: (match[2] || match[1]).trim(),
          context: userReply.slice(0, 300),
          confidence: 0.7,
        });
      }
    }
  }

  return { lessons: dedup(lessons), shouldStore: lessons.length > 0 };
}

/**
 * Detect single-message lessons (user shares learned info).
 */
export function detectStandaloneLessons(
  userMessage: string,
): LessonExtractionResult {
  const lessons: Lesson[] = [];

  for (const [patterns, type] of PATTERN_GROUPS) {
    for (const pattern of patterns) {
      const match = matchLesson(userMessage, pattern);
      if (match) {
        lessons.push({
          id: randomUUID(),
          type,
          wrongAssumption: type === "anti_pattern" && match[2] ? match[1].trim() : "",
          correction: (match[2] || match[1]).trim(),
          context: userMessage.slice(0, 300),
          confidence: type === "correction" ? 0.8 : 0.7,
        });
      }
    }
  }

  return { lessons: dedup(lessons), shouldStore: lessons.length > 0 };
}

/**
 * Store extracted lessons as memories with type="semantic", urgency="important".
 * Prefix text with "[LESSON]" tag for easy filtering.
 */
export async function storeLessons(
  lessons: Lesson[],
  qdrantUrl: string,
  embedUrl: string,
  agentId: string,
): Promise<string[]> {
  const storedIds: string[] = [];

  for (const lesson of lessons) {
    const text = formatLessonText(lesson);
    const vector = await embed(embedUrl, text);

    const now = new Date().toISOString();
    const payload: Record<string, unknown> = {
      text,
      agent_id: agentId,
      memory_type: "semantic",
      scope: "public",
      classification: "public",
      category: "fact",
      urgency: "important",
      domain: "knowledge",
      confidence: lesson.confidence,
      confidence_tag: "grounded",
      priority_score: 0.8,
      importance: 0.8,
      linked_memories: [],
      access_times: [Date.now()],
      access_count: 0,
      event_time: now,
      ingested_at: now,
      created_at: now,
      updated_at: now,
      deleted: false,
      metadata: {
        source: "lesson_extraction",
        lesson_type: lesson.type,
        wrong_assumption: lesson.wrongAssumption,
        confidence: lesson.confidence,
        scope: "lesson",
      },
    };

    try {
      const res = await fetch(
        `${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.SHARED}/points`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wait: true,
            points: [{ id: lesson.id, vector, payload }],
          }),
        },
      );

      if (res.ok) {
        storedIds.push(lesson.id);
      }
    } catch {
      // Non-fatal -- continue with next lesson
    }
  }

  return storedIds;
}

/**
 * Check if a query might trigger a known lesson.
 * Searches memories tagged as lessons for relevant warnings.
 */
export async function findRelevantLessons(
  qdrantUrl: string,
  queryVector: number[],
  limit = 5,
): Promise<MemCellSearchResult[]> {
  try {
    const res = await fetch(
      `${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.SHARED}/points/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vector: queryVector,
          limit,
          filter: {
            must: [
              { key: "deleted", match: { value: false } },
              {
                key: "metadata.source",
                match: { value: "lesson_extraction" },
              },
            ],
          },
          with_payload: true,
        }),
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

    return data.result
      .filter((r) => r.score >= 0.3)
      .map((r) => ({
        entry: payloadToMemCell(r.id, r.payload),
        score: r.score,
        source: "qdrant" as const,
      }));
  } catch {
    return [];
  }
}

/**
 * List all stored lessons.
 */
export async function listLessons(
  qdrantUrl: string,
  limit = 20,
): Promise<MemCellSearchResult[]> {
  try {
    const res = await fetch(
      `${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.SHARED}/points/scroll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limit,
          filter: {
            must: [
              { key: "deleted", match: { value: false } },
              {
                key: "metadata.source",
                match: { value: "lesson_extraction" },
              },
            ],
          },
          with_payload: true,
        }),
      },
    );

    if (!res.ok) return [];

    const data = (await res.json()) as {
      result: {
        points: Array<{
          id: string;
          payload: Record<string, unknown>;
        }>;
      };
    };

    return data.result.points.map((p) => ({
      entry: payloadToMemCell(p.id, p.payload),
      score: 1.0,
      source: "qdrant" as const,
    }));
  } catch {
    return [];
  }
}

// -- Internal Helpers --

function formatLessonText(lesson: Lesson): string {
  const context = lesson.context.slice(0, 300);
  return `[LESSON:${lesson.type}] ${lesson.correction} (context: ${context})`;
}

function dedup(lessons: Lesson[]): Lesson[] {
  const seen = new Set<string>();
  return lessons.filter((l) => {
    const key = l.correction.toLowerCase().trim().slice(0, 100);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function embed(embedUrl: string, text: string): Promise<number[]> {
  const res = await fetch(embedUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text }),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status}`);
  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

function payloadToMemCell(
  id: string,
  p: Record<string, unknown>,
): MemCell {
  return {
    id,
    text: (p.text as string) || "",
    memoryType: (p.memory_type as MemCell["memoryType"]) || "semantic",
    classification: (p.classification as MemCell["classification"]) || "public",
    agentId: (p.agent_id as string) || "",
    userId: (p.user_id as string) || undefined,
    scope: (p.scope as MemCell["scope"]) || "public",
    urgency: (p.urgency as MemCell["urgency"]) || "reference",
    domain: (p.domain as MemCell["domain"]) || "general",
    confidence: typeof p.confidence === "number" ? p.confidence : 0.7,
    confidenceTag: (p.confidence_tag as MemCell["confidenceTag"]) || "grounded",
    priorityScore: typeof p.priority_score === "number" ? p.priority_score : 0.5,
    importance: typeof p.importance === "number" ? p.importance : 0.5,
    linkedMemories: Array.isArray(p.linked_memories) ? p.linked_memories : [],
    accessTimes: Array.isArray(p.access_times) ? p.access_times : [],
    accessCount: typeof p.access_count === "number" ? p.access_count : 0,
    eventTime: (p.event_time as string) || "",
    ingestedAt: (p.ingested_at as string) || "",
    createdAt: (p.created_at as string) || "",
    updatedAt: (p.updated_at as string) || "",
    deleted: p.deleted === true,
    category: (p.category as MemCell["category"]) || "other",
    metadata:
      p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata)
        ? (p.metadata as Record<string, unknown>)
        : {},
  };
}
