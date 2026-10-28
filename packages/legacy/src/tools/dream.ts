/**
 * dream — Compatibility entry point for scoped, nondestructive maintenance.
 * URL-only legacy calls reject; supply a configured QdrantDB.
 */

import {
  runDreamConsolidation,
  shouldRunDream as checkShouldRun,
  getLastDreamReport as getLastReport,
  formatDreamReport,
  type DreamReport,
  type DreamConfig,
} from "../cognitive/dream.js";
import type { QdrantDB } from "../core/qdrant.js";

export interface DreamContext {
  qdrantUrl: string;
  agentId: string;
  db?: QdrantDB;
}

export async function dream(
  ctx: DreamContext,
  config?: Partial<DreamConfig>,
): Promise<DreamReport> {
  return runDreamConsolidation(ctx.db ?? ctx.qdrantUrl, ctx.agentId, config);
}

export async function shouldRunDream(ctx: DreamContext): Promise<boolean> {
  return checkShouldRun(ctx.qdrantUrl, ctx.agentId);
}

export async function lastDreamReport(ctx: DreamContext): Promise<DreamReport | null> {
  return getLastReport(ctx.qdrantUrl, ctx.agentId);
}

export { formatDreamReport };
