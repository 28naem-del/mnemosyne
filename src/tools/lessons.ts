/**
 * lessons — Auto lesson extraction.
 *
 * Detects corrections, fixes, gotchas, discoveries, and anti-patterns
 * from memory content and stores them as reusable lessons.
 */

import {
  detectStandaloneLessons,
  storeLessons as persistLessons,
  listLessons as getAllLessons,
  findRelevantLessons as searchLessons,
  type LessonExtractionResult,
} from "../cognitive/lesson-extractor.js";
import type { MemCellSearchResult } from "../core/types.js";

export interface LessonContext {
  qdrantUrl: string;
  embedUrl: string;
  agentId: string;
}

export async function lessons(
  ctx: LessonContext,
  text: string,
): Promise<LessonExtractionResult> {
  const detected = detectStandaloneLessons(text);
  if (detected.lessons.length > 0) {
    await persistLessons(detected.lessons, ctx.qdrantUrl, ctx.embedUrl, ctx.agentId);
  }
  return detected;
}

export async function listAllLessons(
  ctx: LessonContext,
): Promise<MemCellSearchResult[]> {
  return getAllLessons(ctx.qdrantUrl);
}

export async function findLessons(
  ctx: LessonContext,
  queryVector: number[],
  limit?: number,
): Promise<MemCellSearchResult[]> {
  return searchLessons(ctx.qdrantUrl, queryVector, limit);
}
