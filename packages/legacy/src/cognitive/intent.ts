/**
 * Intent-Aware Retrieval -- Intent Router
 *
 * Classifies query type via regex patterns (NO LLM, <5ms) and routes
 * to different search strategies with tuned vector/BM25/graph weights.
 *
 * ExtendedIntent is a superset of the original 5 QueryIntent types,
 * adding relational, diagnostic, and comparative intents.
 */

import type { MemoryType } from "../core/types.js";

// ========================================================================
// Types
// ========================================================================

/** Extended intent taxonomy (superset of original QueryIntent) */
export type ExtendedIntent =
  | "factual"        // what is X, where is Y, lookup
  | "temporal"       // when, recently, last week, history
  | "procedural"     // how to, steps, setup, configure
  | "preference"     // what do I prefer, settings, favorite
  | "exploratory"    // tell me about, general topic
  | "relational"     // how is X connected to Y, what uses X
  | "diagnostic"     // why did X fail, what went wrong, error
  | "comparative";   // difference between, X vs Y, compare

/** Strategy definition for each intent */
export interface SearchStrategy {
  intent: ExtendedIntent;
  vectorWeight: number;       // 0.0-1.0 -- weight of vector search in final score
  bm25Weight: number;         // 0.0-1.0 -- weight of BM25 in final score
  graphWeight: number;        // 0.0-1.0 -- weight of graph activation
  sortBy: "relevance" | "recency" | "importance";
  boostTypes: MemoryType[];   // memory types to boost (+0.15)
  penalizeTypes: MemoryType[];// memory types to penalize (-0.10)
  expandQuery: boolean;       // whether to run proactive expansion
  limit: number;              // override result limit
}

/** Routing result */
export interface RoutingResult {
  intent: ExtendedIntent;
  confidence: number;         // 0.0-1.0
  strategy: SearchStrategy;
  queryRewrite: string | null;// optional query rewrite for better embedding
}

// ========================================================================
// Minimum quality thresholds per intent -- results below these are filtered
// ========================================================================

export const INTENT_MIN_THRESHOLDS: Record<ExtendedIntent, number> = {
  factual:     0.40,
  temporal:    0.35,
  procedural:  0.40,
  preference:  0.35,
  exploratory: 0.30,
  relational:  0.35,
  diagnostic:  0.35,
  comparative: 0.35,
};

// ========================================================================
// Strategy Table
// ========================================================================

const STRATEGIES: Record<ExtendedIntent, SearchStrategy> = {
  factual: {
    intent: "factual",
    vectorWeight: 0.4, bm25Weight: 0.5, graphWeight: 0.1,
    sortBy: "relevance",
    boostTypes: ["semantic", "core"],
    penalizeTypes: ["episodic"],
    expandQuery: false, limit: 10,
  },
  temporal: {
    intent: "temporal",
    vectorWeight: 0.5, bm25Weight: 0.2, graphWeight: 0.3,
    sortBy: "recency",
    boostTypes: ["episodic"],
    penalizeTypes: [],
    expandQuery: false, limit: 15,
  },
  procedural: {
    intent: "procedural",
    vectorWeight: 0.5, bm25Weight: 0.3, graphWeight: 0.2,
    sortBy: "relevance",
    boostTypes: ["procedural"],
    penalizeTypes: ["preference", "profile"],
    expandQuery: false, limit: 8,
  },
  preference: {
    intent: "preference",
    vectorWeight: 0.6, bm25Weight: 0.3, graphWeight: 0.1,
    sortBy: "relevance",
    boostTypes: ["preference", "profile"],
    penalizeTypes: ["episodic"],
    expandQuery: false, limit: 8,
  },
  exploratory: {
    intent: "exploratory",
    vectorWeight: 0.4, bm25Weight: 0.2, graphWeight: 0.4,
    sortBy: "relevance",
    boostTypes: [],
    penalizeTypes: [],
    expandQuery: true, limit: 15,
  },
  relational: {
    intent: "relational",
    vectorWeight: 0.2, bm25Weight: 0.1, graphWeight: 0.7,
    sortBy: "relevance",
    boostTypes: ["relationship"],
    penalizeTypes: [],
    expandQuery: true, limit: 12,
  },
  diagnostic: {
    intent: "diagnostic",
    vectorWeight: 0.4, bm25Weight: 0.4, graphWeight: 0.2,
    sortBy: "recency",
    boostTypes: ["episodic", "procedural"],
    penalizeTypes: ["preference"],
    expandQuery: false, limit: 12,
  },
  comparative: {
    intent: "comparative",
    vectorWeight: 0.3, bm25Weight: 0.3, graphWeight: 0.4,
    sortBy: "relevance",
    boostTypes: ["semantic"],
    penalizeTypes: [],
    expandQuery: true, limit: 12,
  },
};

// ========================================================================
// Intent Classification Patterns
// ========================================================================

/** Pattern set: array of regexes. Match count determines confidence. */
type PatternSet = { intent: ExtendedIntent; patterns: RegExp[] };

/**
 * Ordered most-specific-first. Each intent has multiple regex patterns.
 * More pattern matches = higher confidence.
 */
const PATTERN_SETS: PatternSet[] = [
  // Diagnostic -- very specific failure/error patterns (check first)
  {
    intent: "diagnostic",
    patterns: [
      /\bwhy\s+(?:did|does|is|was|were|are)\s+.+\s*(?:fail|crash|error|break|not\s+work|broken|down|drop|hang|timeout|disconnect|stop)/i,
      /\bwhat\s+went\s+wrong\b/i,
      /\b(?:debug|diagnose|troubleshoot)\b/i,
      /\berror\b.*\b(?:cause|reason|source|fix)\b/i,
      /\b(?:cause|reason)\b.*\berror\b/i,
      /\bnot\s+(?:working|responding|starting|connecting)\b/i,
    ],
  },
  // Comparative -- explicit comparison patterns
  {
    intent: "comparative",
    patterns: [
      /\b(?:difference|differ|compare|comparison)\s+between\b/i,
      /\bvs\.?\b|\bversus\b/i,
      /\bwhich\s+(?:is|should|would)\s+(?:be\s+)?(?:better|faster|preferred|best|more)\b/i,
      /\bcompare\b/i,
      /\b(?:pros?\s+(?:and|&)\s+cons?|trade.?offs?)\b/i,
    ],
  },
  // Relational -- entity relationship queries
  {
    intent: "relational",
    patterns: [
      /\bhow\s+(?:is|are)\s+.+\s*(?:connected|related|linked)\s+to\b/i,
      /\bwhat\s+(?:uses|depends\s+on|connects?\s+to|relates?\s+to)\b/i,
      /\brelationship\s+between\b/i,
      /\bconnected\s+to\b/i,
      /\bwhat\s+(?:does|do)\s+.+\s*(?:depend|rely)\s+on\b/i,
    ],
  },
  // Temporal -- time-based queries
  {
    intent: "temporal",
    patterns: [
      /\b(?:yesterday|today|last\s+(?:week|session|time|month|night|hour)|recent(?:ly)?|latest)\b/i,
      /\bwhen\s+(?:did|was|were|is)\b/i,
      /\b(?:\d+\s+)?(?:days?|weeks?|hours?|months?)\s+ago\b/i,
      /\bhistory\s+of\b/i,
      /\btimeline\b/i,
    ],
  },
  // Procedural -- how-to queries
  {
    intent: "procedural",
    patterns: [
      /\bhow\s+(?:to|do\s+(?:I|we|you)|can\s+(?:I|we|you))\b/i,
      /\bstep(?:s|\s+by\s+step)?\b/i,
      /\bprocedure\b/i,
      /\b(?:install|setup|set\s+up|configure|deploy|build|create|implement)\b/i,
      /\binstructions?\s+(?:for|to)\b/i,
    ],
  },
  // Preference -- user preference queries
  {
    intent: "preference",
    patterns: [
      /\b(?:I\s+)?prefer\b/i,
      /\b(?:I\s+)?(?:like|love|enjoy|hate|dislike)\b/i,
      /\b(?:my\s+)?(?:setting|config|configuration|choice|favorite|style)\b/i,
      /\bwhat\s+(?:do\s+)?I\s+(?:prefer|like|use|want)\b/i,
    ],
  },
  // Factual -- specific fact lookups
  {
    intent: "factual",
    patterns: [
      /\b(?:what|where|who)\s+is\b/i,
      /\b(?:ip|port|address|hostname|url|endpoint)\b/i,
      /\b(?:name|version|number|count|size|amount)\s+of\b/i,
      /\bhow\s+many\b/i,
      /\bwhat\s+(?:port|ip|address|version)\b/i,
    ],
  },
  // Exploratory is the default -- no patterns needed
];

// ========================================================================
// Public API
// ========================================================================

/**
 * Classify query into extended intent.
 * Pure regex + keyword matching, no LLM.
 * Returns intent + confidence (multi-pattern match = higher confidence).
 * Performance: <5ms for any query.
 */
export function classifyExtendedIntent(query: string): {
  intent: ExtendedIntent;
  confidence: number;
} {
  let bestIntent: ExtendedIntent = "exploratory";
  let bestMatchCount = 0;
  let bestTotalPatterns = 1;

  for (const { intent, patterns } of PATTERN_SETS) {
    let matchCount = 0;
    for (const pat of patterns) {
      if (pat.test(query)) matchCount++;
    }
    if (matchCount > bestMatchCount) {
      bestMatchCount = matchCount;
      bestTotalPatterns = patterns.length;
      bestIntent = intent;
    }
  }

  // Confidence: ratio of matched patterns, with floor of 0.5 for any match
  const confidence = bestMatchCount === 0
    ? 0.3  // exploratory default
    : Math.min(1.0, 0.5 + (bestMatchCount / bestTotalPatterns) * 0.5);

  return { intent: bestIntent, confidence };
}

/**
 * Get the search strategy for an intent.
 * Deterministic lookup table.
 */
export function getStrategy(intent: ExtendedIntent): SearchStrategy {
  return STRATEGIES[intent];
}

/**
 * Rewrite query for better embedding match.
 * Pure string manipulation, no LLM.
 * Returns null if no rewrite is beneficial.
 */
export function rewriteForEmbedding(query: string, intent: ExtendedIntent): string | null {
  const lower = query.toLowerCase().trim();

  switch (intent) {
    case "factual": {
      // Strip question words and auxiliary verbs, keep nouns/entities
      const stripped = lower
        .replace(/^(?:what|where|who|which)\s+(?:(?:is|are|was|were|does|do)\s+)?/i, "")
        .replace(/\b(?:is|are|was|were|does|do|did|use[sd]?|have|has|had)\b/gi, "")
        .replace(/\?+$/, "")
        .replace(/\s+/g, " ")
        .trim();
      return stripped && stripped !== lower ? stripped : null;
    }
    case "temporal": {
      const core = lower
        .replace(/^when\s+(?:did|was|were|is|are)\s+(?:we\s+|I\s+|you\s+)?/i, "")
        .replace(/\b(?:last\s+(?:time|week|session)|yesterday|recently|ago)\b/gi, "")
        .replace(/\?+$/, "")
        .trim();
      return core ? `${core} timeline recent` : null;
    }
    case "diagnostic": {
      const core = lower
        .replace(/^why\s+(?:did|does|is|was|were|are)\s+(?:the\s+)?/i, "")
        .replace(/\b(?:fail|crash|break|not\s+work)\b/gi, "failure error")
        .replace(/\bwhat\s+went\s+wrong\s+(?:with\s+)?/i, "")
        .replace(/\?+$/, "")
        .trim();
      return core !== lower ? core : null;
    }
    case "procedural": {
      const core = lower
        .replace(/^how\s+(?:to|do\s+(?:I|we|you)|can\s+(?:I|we|you))\s+/i, "")
        .replace(/\?+$/, "")
        .trim();
      return core ? `${core} steps guide` : null;
    }
    default:
      return null;
  }
}

/**
 * Full routing pipeline: classify -> get strategy -> optional rewrite.
 */
export function routeQuery(query: string): RoutingResult {
  const { intent, confidence } = classifyExtendedIntent(query);
  const strategy = getStrategy(intent);
  const queryRewrite = rewriteForEmbedding(query, intent);

  return { intent, confidence, strategy, queryRewrite };
}
