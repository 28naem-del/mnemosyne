/**
 * dream — Intensive overnight-style consolidation.
 *
 * Phases: aggressive dedup → merge episodic→semantic →
 * prune stale → strengthen popular → pattern mining.
 */

import {
  runDreamConsolidation,
  shouldRunDream as checkShouldRun,
  getLastDreamReport as getLastReport,
  formatDreamReport,
  type DreamReport,
  type DreamConfig,
} from "../cognitive/dream.js";

export interface DreamContext {
  qdrantUrl: string;
  agentId: string;
}

export async function dream(
  ctx: DreamContext,
  config?: Partial<DreamConfig>,
): Promise<DreamReport> {
  return runDreamConsolidation(ctx.qdrantUrl, ctx.agentId, config);
}

export async function shouldRunDream(ctx: DreamContext): Promise<boolean> {
  return checkShouldRun(ctx.qdrantUrl, ctx.agentId);
}

export async function lastDreamReport(ctx: DreamContext): Promise<DreamReport | null> {
  return getLastReport(ctx.qdrantUrl, ctx.agentId);
}

export { formatDreamReport };
