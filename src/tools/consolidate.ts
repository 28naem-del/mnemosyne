/**
 * consolidate — Run scoped, nondestructive maintenance or preview its changes.
 * URL-only legacy calls reject; supply a configured QdrantDB.
 */

import type { QdrantDB } from "../core/qdrant.js";
import {
  runConsolidation,
  type ConsolidationReport,
} from "../cognitive/consolidation.js";

export interface ConsolidateContext {
  /** @deprecated Supply db; URL-only maintenance is disabled. */
  qdrantUrl?: string;
  db?: QdrantDB;
}

export interface ConsolidateOptions {
  collection?: string;
  batchSize?: number;
  dryRun?: boolean;
}

export async function consolidate(
  ctx: ConsolidateContext,
  options: ConsolidateOptions = {},
): Promise<ConsolidationReport> {
  return runConsolidation(
    ctx.db ?? ctx.qdrantUrl ?? "",
    options.collection,
    options.batchSize || 200,
    { dryRun: options.dryRun },
  );
}
