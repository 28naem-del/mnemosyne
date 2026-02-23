/**
 * Multi-signal retrieval scoring.
 *
 * Instead of simple cosine similarity, combines 5 signals:
 *   1. Semantic similarity (cosine distance from embedding)
 *   2. Temporal recency (hours since last access/creation)
 *   3. Importance x confidence (how important + how reliable)
 *   4. Access frequency (how often this memory gets used)
 *   5. Type relevance (episodic for recent events, semantic for facts, etc.)
 *
 * The weights are context-dependent -- a "what happened yesterday" query
 * should weight recency heavily, while "what is the server IP" should weight
 * importance and confidence.
 */

import type { MemCell, MemoryType } from "../core/types.js";
import type { ExtendedIntent } from "./intent.js";

export type QueryIntent = "factual" | "temporal" | "procedural" | "preference" | "exploratory";

// ExtendedIntent from intent router is a superset -- accepted everywhere QueryIntent is
export type { ExtendedIntent } from "./intent.js";

// Context passed from caller for context-aware reranking
export type QueryContext = {
  queryTerms: string[];       // Key terms extracted from query (lowercased, >3 chars)
  queryDomain?: string;       // Detected domain of the query
  recentTopics?: string[];    // Topics from recent queries (ring buffer)
};

// Detect query intent from the query text
export function detectQueryIntent(query: string): QueryIntent {
  const lower = query.toLowerCase();

  // Temporal: asking about recent events
  if (/\b(yesterday|today|last\s+(week|session|time)|recent|latest|when|ago)\b/.test(lower)) {
    return "temporal";
  }
  // Procedural: asking how to do something
  if (/\b(how\s+(to|do|can)|step|procedure|install|setup|configure|deploy)\b/.test(lower)) {
    return "procedural";
  }
  // Preference: asking about likes/settings
  if (/\b(prefer|like|setting|config|choice|favorite|style)\b/.test(lower)) {
    return "preference";
  }
  // Factual: asking about a specific fact
  if (/\b(what\s+is|where\s+is|who\s+is|ip|port|address|name|version)\b/.test(lower)) {
    return "factual";
  }
  return "exploratory";
}

// Weights per intent -- each sums to 1.0
// Supports both original QueryIntent and ExtendedIntent (3 new: relational, diagnostic, comparative)
const INTENT_WEIGHTS: Record<QueryIntent | ExtendedIntent, {
  similarity: number;
  recency: number;
  importance: number;
  frequency: number;
  typeRelevance: number;
}> = {
  factual:     { similarity: 0.50, recency: 0.05, importance: 0.25, frequency: 0.10, typeRelevance: 0.10 },
  temporal:    { similarity: 0.30, recency: 0.35, importance: 0.10, frequency: 0.10, typeRelevance: 0.15 },
  procedural:  { similarity: 0.45, recency: 0.05, importance: 0.15, frequency: 0.20, typeRelevance: 0.15 },
  preference:  { similarity: 0.40, recency: 0.10, importance: 0.20, frequency: 0.10, typeRelevance: 0.20 },
  exploratory: { similarity: 0.40, recency: 0.15, importance: 0.20, frequency: 0.10, typeRelevance: 0.15 },
  relational:  { similarity: 0.30, recency: 0.05, importance: 0.20, frequency: 0.10, typeRelevance: 0.35 },
  diagnostic:  { similarity: 0.35, recency: 0.30, importance: 0.15, frequency: 0.05, typeRelevance: 0.15 },
  comparative: { similarity: 0.40, recency: 0.05, importance: 0.25, frequency: 0.10, typeRelevance: 0.20 },
};

// Which memory types are most relevant for each intent
const TYPE_RELEVANCE: Record<QueryIntent | ExtendedIntent, Record<MemoryType, number>> = {
  factual:     { semantic: 1.0, core: 0.9, procedural: 0.5, relationship: 0.7, preference: 0.3, profile: 0.5, episodic: 0.2 },
  temporal:    { episodic: 1.0, semantic: 0.3, core: 0.1, procedural: 0.2, relationship: 0.2, preference: 0.3, profile: 0.1 },
  procedural:  { procedural: 1.0, semantic: 0.5, core: 0.3, relationship: 0.2, preference: 0.1, profile: 0.1, episodic: 0.3 },
  preference:  { preference: 1.0, profile: 0.8, core: 0.5, semantic: 0.3, relationship: 0.2, procedural: 0.1, episodic: 0.4 },
  exploratory: { semantic: 0.8, episodic: 0.7, core: 0.6, procedural: 0.6, relationship: 0.6, preference: 0.5, profile: 0.5 },
  relational:  { relationship: 1.0, semantic: 0.6, core: 0.5, procedural: 0.3, preference: 0.2, profile: 0.4, episodic: 0.3 },
  diagnostic:  { episodic: 1.0, procedural: 0.8, semantic: 0.5, core: 0.3, relationship: 0.4, preference: 0.1, profile: 0.1 },
  comparative: { semantic: 1.0, core: 0.7, procedural: 0.5, relationship: 0.6, preference: 0.4, profile: 0.3, episodic: 0.3 },
};

// Compute recency score (0-1): blends access-time recency with creation-time decay
function recencyScore(cell: MemCell, nowMs = Date.now()): number {
  // Access recency: most recent access time, or creation time
  const lastAccess = cell.accessTimes.length > 0
    ? Math.max(...cell.accessTimes)
    : new Date(cell.createdAt).getTime() || nowMs;

  const hoursSinceAccess = Math.max((nowMs - lastAccess) / 3_600_000, 0.001);
  // Exponential decay: 1 hour ago = 1.0, 24h = 0.5, 168h (1 week) = 0.1
  const accessRecency = Math.exp(-0.03 * hoursSinceAccess);

  // Creation-time decay: older memories decay slowly
  const createdMs = new Date(cell.createdAt).getTime() || nowMs;
  const hoursSinceCreation = Math.max((nowMs - createdMs) / 3_600_000, 0.001);
  const creationDecay = Math.exp(-0.005 * hoursSinceCreation);

  // Blend: 60% access recency, 40% creation decay
  return accessRecency * 0.6 + creationDecay * 0.4;
}

// Compute frequency score (0-1): more accesses = higher
function frequencyScore(cell: MemCell): number {
  const count = cell.accessCount || cell.accessTimes.length || 0;
  // Logarithmic: 0 access = 0, 1 = 0.5, 5 = 0.78, 20 = 0.95
  return count > 0 ? Math.min(1.0, Math.log(count + 1) / Math.log(25)) : 0;
}

// Compute importance-confidence composite (0-1)
function importanceScore(cell: MemCell): number {
  const importance = cell.importance ?? 0.7;
  const confidence = cell.confidence ?? 0.7;
  // Weighted: 60% importance, 40% confidence
  return importance * 0.6 + confidence * 0.4;
}

// Boost memories matching recently-discussed topics (+15%)
function recentTopicBoost(cell: MemCell, context?: QueryContext): number {
  if (!context?.recentTopics?.length) return 0;
  const textLower = cell.text.toLowerCase();
  const isRecent = context.recentTopics.some(topic => textLower.includes(topic.toLowerCase()));
  return isRecent ? 0.15 : 0;
}

// Boost memories matching query focus terms
function focusBoost(cell: MemCell, context?: QueryContext): number {
  if (!context?.queryTerms?.length) return 0;
  const textLower = cell.text.toLowerCase();
  const matchCount = context.queryTerms.filter(t => textLower.includes(t)).length;
  const ratio = matchCount / context.queryTerms.length;
  return ratio > 0 ? Math.min(0.15, ratio * 0.10) : 0;
}

/**
 * Configurable trust resolver type.
 * Accepts an agentId and returns a trust score 0.0-1.0.
 */
export type TrustResolver = (agentId: string) => number;

/** Default trust resolver: returns 0.7 for all agents */
const DEFAULT_TRUST: TrustResolver = () => 0.7;

// Source trust score using configurable trust resolver
function sourceTrustScore(cell: MemCell, trustResolver: TrustResolver): number {
  const agentId = cell.agentId?.toLowerCase() || "";
  if (agentId) return trustResolver(agentId);

  // Fallback by memory type
  if (cell.memoryType === "core") return 0.95;
  if (cell.memoryType === "semantic") return 0.7;
  if (cell.memoryType === "episodic") return 0.6;
  return 0.5;
}

export function computeMultiSignalScore(
  cell: MemCell,
  semanticScore: number,
  intent: QueryIntent | ExtendedIntent,
  nowMs = Date.now(),
  context?: QueryContext,
  graphActivation?: number,
  boostTypes?: MemoryType[],
  penalizeTypes?: MemoryType[],
  trustResolver?: TrustResolver,
): number {
  const resolveTrust = trustResolver ?? DEFAULT_TRUST;

  // Defaults for old memories missing importance/urgency/domain
  const imp = cell.importance ?? 0.5;
  const urg = cell.urgency ?? "reference";
  const dom = cell.domain ?? "general";
  const conf = cell.confidence ?? 0.7;
  const times = cell.accessTimes ?? [];

  // Count how many of [importance, urgency, domain, accessTimes, confidence] are missing/default
  const missingCount = (
    (imp === 0.5 || imp === 0.7 ? 1 : 0) +
    (urg === "reference" ? 1 : 0) +
    (dom === "general" || dom === "knowledge" ? 1 : 0) +
    (times.length === 0 ? 1 : 0) +
    (conf === 0.7 ? 1 : 0)
  );

  // Source trust modifier (always applied, even for sparse metadata)
  const trust = sourceTrustScore(cell, resolveTrust);

  // Type boost/penalize from intent strategy
  let typeAdjust = 0;
  if (boostTypes?.includes(cell.memoryType)) typeAdjust += 0.10;
  if (penalizeTypes?.includes(cell.memoryType)) typeAdjust -= 0.08;

  // When more than 3 of 5 fields are missing/default, weight raw similarity at 90%
  // Apply 0.85 penalty for sparse metadata
  if (missingCount > 3) {
    const base = semanticScore * 0.90 + importanceScore(cell) * 0.10;
    const sparse = (base * trust + recentTopicBoost(cell, context) + focusBoost(cell, context)) * 0.85;
    return Math.min(1.0, sparse + typeAdjust);
  }

  const weights = INTENT_WEIGHTS[intent];
  const typeRel = TYPE_RELEVANCE[intent][cell.memoryType] ?? 0.5;

  const signals = {
    similarity: semanticScore,
    recency: recencyScore(cell, nowMs),
    importance: importanceScore(cell),
    frequency: frequencyScore(cell),
    typeRelevance: typeRel,
  };

  // When graph activation is provided, borrow 0.10 from typeRelevance
  const graphWeight = (graphActivation !== undefined && graphActivation > 0) ? 0.10 : 0;
  const adjustedTypeWeight = weights.typeRelevance - graphWeight;

  const baseScore = (
    signals.similarity * weights.similarity +
    signals.recency * weights.recency +
    signals.importance * weights.importance +
    signals.frequency * weights.frequency +
    signals.typeRelevance * adjustedTypeWeight +
    (graphActivation ?? 0) * graphWeight
  );

  // Apply source trust, recency topic boost, focus boost, and type adjust (clamped to [0, 1])
  return Math.min(1.0, baseScore * trust + recentTopicBoost(cell, context) + focusBoost(cell, context) + typeAdjust);
}

// Diversity reranking -- penalize near-duplicate results
// If 3+ results are >0.9 similar to each other, keep only the best and replace
// others with different-angle results from further down the ranking.
export function applyDiversityReranking(
  results: Array<{ score: number; entry: MemCell }>,
  topK: number,
): Array<{ score: number; entry: MemCell }> {
  if (results.length <= topK) return results;

  const selected: Array<{ score: number; entry: MemCell }> = [];
  const remaining = [...results];

  // Always pick the top result first
  selected.push(remaining.shift()!);

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];

      // Penalize if same memory type as already-selected (mild penalty)
      const sameTypeCount = selected.filter(
        s => s.entry.memoryType === candidate.entry.memoryType
      ).length;
      const diversityPenalty = sameTypeCount * 0.05;

      // Count how many selected results are >0.9 similar to this candidate
      let highSimCount = 0;
      let anyOverlap = false;
      for (const s of selected) {
        const sim = textSimilarity(s.entry.text, candidate.entry.text);
        if (sim > 0.9) highSimCount++;
        if (sim > 0.8) anyOverlap = true;
      }

      // Aggressive dedup -- if 3+ selected are >0.9 similar, heavy penalty
      const clusterPenalty = highSimCount >= 3 ? 0.40 : (highSimCount >= 2 ? 0.25 : 0);
      const overlapPenalty = anyOverlap ? 0.15 : 0;

      const adjustedScore = candidate.score - diversityPenalty - overlapPenalty - clusterPenalty;
      if (adjustedScore > bestScore) {
        bestScore = adjustedScore;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

// Simple Jaccard-like text similarity for diversity check
function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  return intersection / Math.max(wordsA.size, wordsB.size);
}
