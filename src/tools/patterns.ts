/**
 * patterns — Auto pattern mining and abstraction.
 *
 * Discovers: co-occurrences, clusters, recurring errors,
 * sequences, correlations, anomalies.
 */

import {
  runPatternMining,
  loadPatterns,
  type MiningReport,
  type Pattern,
  type GraphClient,
} from "../cognitive/pattern-miner.js";

export interface PatternContext {
  qdrantUrl: string;
  embedUrl: string;
  agentId: string;
  graphClient?: GraphClient | null;
}

export interface PatternOptions {
  batchSize?: number;
}

export async function patterns(
  ctx: PatternContext,
  options: PatternOptions = {},
): Promise<MiningReport> {
  return runPatternMining(
    ctx.qdrantUrl,
    ctx.embedUrl,
    ctx.graphClient ?? null,
    ctx.agentId,
    options.batchSize || 200,
  );
}

export async function getStoredPatterns(
  ctx: PatternContext,
): Promise<Pattern[]> {
  return loadPatterns(ctx.qdrantUrl, ctx.agentId);
}
