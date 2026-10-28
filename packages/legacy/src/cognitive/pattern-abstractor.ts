/**
 * Pattern Abstraction -- take mined patterns and abstract them into
 * actionable lessons. A cluster of 5 similar "Redis timeout" memories becomes
 * a single lesson: "Redis frequently times out -- check connection
 * pool settings first."
 *
 * Bridges pattern mining and lesson extraction.
 *
 * Runs as background job -- NOT in the search hot path.
 * Zero npm deps, zero LLM calls -- pure statistics.
 */

import { createHash } from "node:crypto";
import type { LessonType } from "./lesson-extractor.js";
import type {
  Pattern,
  MemoryCluster,
  CoOccurrence,
} from "./pattern-miner.js";
import { DEFAULT_COLLECTIONS } from "../core/types.js";

// ============================================================================
// Types
// ============================================================================

/** An abstracted lesson derived from a pattern */
export interface AbstractedLesson {
  patternId: string;
  lessonText: string;
  lessonType: LessonType;
  confidence: number;
  supportingPatterns: string[];
  supportingMemories: string[];
  abstractionMethod: "cluster_summary" | "error_synthesis" | "cooccurrence_rule";
}

/** Abstraction config */
export interface AbstractionConfig {
  minClusterSize: number;
  minPatternConfidence: number;
  maxLessonsPerRun: number;
}

const DEFAULT_CONFIG: AbstractionConfig = {
  minClusterSize: 3,
  minPatternConfidence: 0.5,
  maxLessonsPerRun: 20,
};

// ============================================================================
// Stopwords + Tokenizer (shared with pattern-miner)
// ============================================================================

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor",
  "not", "only", "own", "same", "so", "than", "too", "very", "just",
  "because", "but", "and", "or", "if", "while", "that", "this", "these",
  "those", "what", "which", "who", "whom", "it", "its", "i", "me", "my",
  "we", "our", "you", "your", "he", "him", "his", "she", "her", "they",
  "them", "their", "about", "up", "don", "didn", "doesn", "isn", "wasn",
  "aren", "couldn", "wouldn", "shouldn", "won", "haven", "hasn", "hadn",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

// ============================================================================
// Common Significant Words
// ============================================================================

/**
 * Find words appearing in >= minFrequency fraction of the texts.
 * Returns them sorted by document frequency (desc).
 */
export function findCommonSignificantWords(
  texts: string[],
  minFrequency = 0.6,
): string[] {
  if (texts.length === 0) return [];

  const wordDocCount = new Map<string, number>();
  for (const text of texts) {
    const words = new Set(tokenize(text));
    for (const word of words) {
      wordDocCount.set(word, (wordDocCount.get(word) || 0) + 1);
    }
  }

  const threshold = texts.length * minFrequency;
  return [...wordDocCount.entries()]
    .filter(([, count]) => count >= threshold)
    .sort(([, a], [, b]) => b - a)
    .map(([word]) => word);
}

// ============================================================================
// Deterministic ID
// ============================================================================

function abstractionId(method: string, key: string): string {
  const hex = createHash("sha256").update(`abstraction:${method}:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ============================================================================
// Cluster Abstraction
// ============================================================================

/**
 * Abstract a cluster pattern into a lesson.
 * Takes cluster of similar memories, finds common theme,
 * extracts the most representative memory text + shared entities.
 */
export function abstractCluster(
  cluster: MemoryCluster,
  minSize = 3,
): AbstractedLesson | null {
  if (cluster.size < minSize) return null;

  // Find the most central memory (highest score = closest to centroid)
  const bestMember = [...cluster.members].sort((a, b) => b.score - a.score)[0];

  // Extract common words across cluster members
  const allTexts = cluster.members.map(m => m.text);
  const commonWords = findCommonSignificantWords(allTexts, 0.6);
  const topic = commonWords.slice(0, 5).join(", ");

  const lessonText = `[LESSON:cluster] Pattern found across ${cluster.size} memories about ${topic || cluster.dominantDomain}: ${bestMember.text.slice(0, 300)}`;

  const key = cluster.members.map(m => m.id).sort().join(",");

  return {
    patternId: abstractionId("cluster_summary", key),
    lessonText,
    lessonType: "learned",
    confidence: cluster.avgSimilarity,
    supportingPatterns: [],
    supportingMemories: cluster.members.map(m => m.id),
    abstractionMethod: "cluster_summary",
  };
}

// ============================================================================
// Recurring Error Abstraction
// ============================================================================

/**
 * Abstract recurring error pattern into a gotcha/anti-pattern lesson.
 * Takes error pattern with multiple occurrences, synthesizes a warning.
 */
export function abstractRecurringError(pattern: Pattern): AbstractedLesson | null {
  if (pattern.type !== "recurring_error") return null;
  if (pattern.occurrences < 2) return null;

  const lessonText = `[LESSON:gotcha] Recurring issue (${pattern.occurrences} occurrences): ${pattern.description}. Evidence: ${pattern.evidenceIds.length} memories.`;

  return {
    patternId: abstractionId("error_synthesis", pattern.id),
    lessonText,
    lessonType: "gotcha",
    confidence: Math.min(0.5 + pattern.occurrences * 0.1, 0.95),
    supportingPatterns: [pattern.id],
    supportingMemories: pattern.evidenceIds,
    abstractionMethod: "error_synthesis",
  };
}

// ============================================================================
// Co-occurrence Abstraction
// ============================================================================

/**
 * Abstract co-occurrence into a relational lesson.
 * "X and Y frequently appear together" -> "When working with X, also consider Y"
 */
export function abstractCoOccurrence(coOccurrence: CoOccurrence): AbstractedLesson | null {
  if (coOccurrence.count < 3) return null;

  const lessonText = `[LESSON:learned] When working with ${coOccurrence.entityA}, also consider ${coOccurrence.entityB} -- they co-occur in ${coOccurrence.count} memories.`;

  const key = `${coOccurrence.entityA}:${coOccurrence.entityB}`;

  return {
    patternId: abstractionId("cooccurrence_rule", key),
    lessonText,
    lessonType: "learned",
    confidence: Math.min(0.4 + coOccurrence.count * 0.08, 0.95),
    supportingPatterns: [],
    supportingMemories: coOccurrence.memories.slice(0, 20),
    abstractionMethod: "cooccurrence_rule",
  };
}

// ============================================================================
// Full Abstraction Pipeline
// ============================================================================

/**
 * Run full abstraction pipeline on mined patterns.
 * Filters out already-abstracted patterns (checks metadata.abstracted=true).
 */
export async function runAbstraction(
  patterns: Pattern[],
  clusters: MemoryCluster[],
  coOccurrences: CoOccurrence[],
  config?: Partial<AbstractionConfig>,
): Promise<AbstractedLesson[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const lessons: AbstractedLesson[] = [];

  // Already-abstracted pattern IDs (from metadata)
  const alreadyAbstracted = new Set(
    patterns
      .filter(p => (p.metadata as Record<string, unknown>)?.abstracted === true)
      .map(p => p.id),
  );

  // 1. Abstract clusters
  for (const cluster of clusters) {
    if (cluster.size < cfg.minClusterSize) continue;
    if (lessons.length >= cfg.maxLessonsPerRun) break;

    const lesson = abstractCluster(cluster, cfg.minClusterSize);
    if (lesson) lessons.push(lesson);
  }

  // 2. Abstract recurring errors
  for (const pattern of patterns) {
    if (pattern.type !== "recurring_error") continue;
    if (pattern.confidence < cfg.minPatternConfidence) continue;
    if (alreadyAbstracted.has(pattern.id)) continue;
    if (lessons.length >= cfg.maxLessonsPerRun) break;

    const lesson = abstractRecurringError(pattern);
    if (lesson) lessons.push(lesson);
  }

  // 3. Abstract co-occurrences
  for (const co of coOccurrences) {
    if (co.count < cfg.minClusterSize) continue;
    if (lessons.length >= cfg.maxLessonsPerRun) break;

    const lesson = abstractCoOccurrence(co);
    if (lesson) lessons.push(lesson);
  }

  return lessons;
}

// ============================================================================
// Persistence -- Store abstracted lessons as high-priority memories
// ============================================================================

async function embedText(embedUrl: string, text: string): Promise<number[]> {
  const res = await fetch(`${embedUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text }),
  });
  if (!res.ok) throw new Error(`Embed failed: ${res.status}`);
  const data = (await res.json()) as { embedding?: number[]; data?: Array<{ embedding: number[] }> };
  return data.embedding || data.data?.[0]?.embedding || [];
}

/**
 * Store abstracted lessons using the lesson storage format.
 * Stores as high-priority semantic memories with [LESSON] tags and
 * metadata.source = "pattern_abstraction".
 */
export async function storeAbstractedLessons(
  lessons: AbstractedLesson[],
  qdrantUrl: string,
  embedUrl: string,
  agentId: string,
): Promise<string[]> {
  const storedIds: string[] = [];

  for (const lesson of lessons) {
    try {
      const vector = await embedText(embedUrl, lesson.lessonText);
      if (vector.length === 0) continue;

      const now = new Date().toISOString();
      const pointId = lesson.patternId;

      const res = await fetch(
        `${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.SHARED}/points`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wait: true,
            points: [{
              id: pointId,
              vector,
              payload: {
                text: lesson.lessonText,
                agent_id: agentId,
                memory_type: "semantic",
                scope: "public",
                classification: "public",
                category: "fact",
                urgency: "important",
                domain: "knowledge",
                confidence: lesson.confidence,
                confidence_tag: "inferred",
                priority_score: 0.8,
                importance: 0.8,
                linked_memories: lesson.supportingMemories.slice(0, 10),
                access_times: [Date.now()],
                access_count: 0,
                event_time: now,
                ingested_at: now,
                created_at: now,
                updated_at: now,
                deleted: false,
                metadata: {
                  source: "pattern_abstraction",
                  lesson_type: lesson.lessonType,
                  abstraction_method: lesson.abstractionMethod,
                  supporting_patterns: lesson.supportingPatterns,
                  pattern_id: lesson.patternId,
                  abstracted: true,
                },
              },
            }],
          }),
        },
      );

      if (res.ok) storedIds.push(pointId);
    } catch {
      // Non-fatal: skip individual lesson save failures
    }
  }

  return storedIds;
}
