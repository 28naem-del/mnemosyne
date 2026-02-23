/**
 * Confidence tags -- Source transparency for every memory result.
 *
 * Tags:
 *   verified   -- Retrieved from verified memory, confidence > 0.85
 *   grounded   -- Supported by retrieved documents, confidence 0.60-0.85
 *   inferred   -- Model inference, confidence 0.40-0.60
 *   uncertain  -- Low confidence or disagreement, < 0.40
 *
 * Score = 0.50 x retrieval_grounding + 0.30 x agent_agreement + 0.20 x source_trust
 */

import type { ConfidenceTag } from "../core/types.js";

export function computeConfidence(
  retrievalScore: number,
  agentAgreement: number,  // 0-1, fraction of agents that agree
  sourceTrust: number,     // 0-1, trust level of the source
): { score: number; tag: ConfidenceTag } {
  const score = 0.50 * retrievalScore + 0.30 * agentAgreement + 0.20 * sourceTrust;

  let tag: ConfidenceTag;
  if (score >= 0.85) tag = "verified";
  else if (score >= 0.60) tag = "grounded";
  else if (score >= 0.40) tag = "inferred";
  else tag = "uncertain";

  return { score: Math.min(1.0, Math.max(0.0, score)), tag };
}

export function confidenceLabel(tag: ConfidenceTag): string {
  switch (tag) {
    case "verified": return "VERIFIED";
    case "grounded": return "GROUNDED";
    case "inferred": return "INFERRED";
    case "uncertain": return "UNCERTAIN";
  }
}
