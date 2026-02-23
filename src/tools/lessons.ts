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
  type Lesson,
  type LessonExtractionResult,
} from "../cognitive/lesson-extractor.js";

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
    await persistLessons(ctx.qdrantUrl, ctx.embedUrl, detected.lessons, ctx.agentId);
  }
  return detected;
}

export async function listAllLessons(
  ctx: LessonContext,
): Promise<Lesson[]> {
  return getAllLessons(ctx.qdrantUrl, ctx.agentId);
}

export async function findLessons(
  ctx: LessonContext,
  query: string,
  limit?: number,
): Promise<Lesson[]> {
  return searchLessons(ctx.qdrantUrl, ctx.embedUrl, query, ctx.agentId, limit);
}
