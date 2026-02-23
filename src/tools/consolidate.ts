/**
 * consolidate — Run memory consolidation pipeline.
 *
 * Finds contradictions, merges near-duplicates, promotes popular
 * memories, and demotes stale ones.
 */

import { DEFAULT_COLLECTIONS } from "../core/types.js";
import {
  runConsolidation,
  type ConsolidationReport,
} from "../cognitive/consolidation.js";

export interface ConsolidateContext {
  qdrantUrl: string;
}

export interface ConsolidateOptions {
  collection?: string;
  batchSize?: number;
}

export async function consolidate(
  ctx: ConsolidateContext,
  options: ConsolidateOptions = {},
): Promise<ConsolidationReport> {
  return runConsolidation(
    ctx.qdrantUrl,
    options.collection || DEFAULT_COLLECTIONS.SHARED,
    options.batchSize || 200,
  );
}
