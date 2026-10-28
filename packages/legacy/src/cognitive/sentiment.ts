/**
 * Sentiment and Frustration Tracking
 *
 * Detect user mood (frustration, satisfaction, confusion) from conversation
 * patterns. Adapt retrieval behavior: frustrated users get more precise
 * answers with fewer results.
 *
 * ZERO npm deps, ZERO LLM calls -- pure regex and heuristics.
 * Target: <10ms per message analysis.
 */

// -- Types --

export type Sentiment = "positive" | "neutral" | "negative" | "frustrated";

export interface SentimentSignal {
  sentiment: Sentiment;
  intensity: number;      // 0.0-1.0
  indicators: string[];   // matched patterns
}

/** Running frustration state (kept in memory per session) */
export interface FrustrationState {
  level: number;          // 0.0-1.0, decays over time
  consecutiveNegative: number;
  lastSignal: Sentiment;
  lastUpdated: number;    // ms timestamp
  history: Array<{ sentiment: Sentiment; timestamp: number }>;
}

/** Adaptation output: how to modify search behavior */
export interface SentimentAdaptation {
  resultLimit: number;    // fewer results when frustrated (5 vs 10)
  minScore: number;       // higher threshold when frustrated (0.5 vs 0.3)
  includeExplanation: boolean;  // explain why results are relevant
  urgencyBoost: number;   // boost critical memories when frustrated
}

// -- Pattern Definitions --

type PatternEntry = { re: RegExp; weight: number; label: string };

const POSITIVE_PATTERNS: PatternEntry[] = [
  { re: /\b(thank|thanks|great|perfect|awesome|excellent|works|solved|fixed)\b/i, weight: 0.7, label: "strong positive" },
  { re: /\b(good|nice|cool|ok|fine|helpful)\b/i, weight: 0.4, label: "mild positive" },
];

const POSITIVE_AMPLIFIERS: PatternEntry[] = [
  { re: /!+$/, weight: 0.1, label: "exclamation amplifier" },
];

const NEGATIVE_PATTERNS: PatternEntry[] = [
  { re: /\b(wrong|incorrect|broken|failed|doesn't work|can't)\b/i, weight: 0.5, label: "negative" },
  { re: /\bno\b|\bnot\b/i, weight: 0.5, label: "negation" },
  { re: /\b(frustrated|annoying|terrible|useless|stupid|waste)\b/i, weight: 0.9, label: "strong negative" },
  { re: /\b(ugh|argh|ffs|wtf|omg)\b/i, weight: 0.8, label: "expletive" },
  { re: /\b(again\??|still\??)\b/i, weight: 0.6, label: "repetition frustration" },
];

const FRUSTRATION_ESCALATORS: PatternEntry[] = [
  { re: /I (?:already|just) (?:told|said|asked)/i, weight: 0.9, label: "repeated instruction" },
  { re: /(?:same|exact) (?:error|problem|issue)/i, weight: 0.8, label: "same problem" },
  { re: /why (?:does|is) (?:this|it) (?:still|keep)/i, weight: 0.7, label: "persistent issue" },
  { re: /how many times/i, weight: 0.95, label: "exasperation" },
];

const FRUSTRATION_AMPLIFIERS: PatternEntry[] = [
  { re: /\?\?+/, weight: 0.2, label: "multi-question-mark" },
];

// -- Core Functions --

function sumMatches(text: string, patterns: PatternEntry[]): { score: number; indicators: string[] } {
  let score = 0;
  const indicators: string[] = [];
  for (const p of patterns) {
    if (p.re.test(text)) {
      score += p.weight;
      indicators.push(p.label);
    }
  }
  return { score, indicators };
}

/**
 * Analyze sentiment of a single message.
 * Pure lexicon + pattern matching, no LLM.
 */
export function analyzeSentiment(text: string): SentimentSignal {
  if (!text || text.length < 2) {
    return { sentiment: "neutral", intensity: 0.3, indicators: [] };
  }

  const pos = sumMatches(text, POSITIVE_PATTERNS);
  const posAmp = sumMatches(text, POSITIVE_AMPLIFIERS);
  const posScore = pos.score + posAmp.score;
  const posIndicators = [...pos.indicators, ...posAmp.indicators];

  const neg = sumMatches(text, NEGATIVE_PATTERNS);
  const negScore = neg.score;

  const frust = sumMatches(text, FRUSTRATION_ESCALATORS);
  const frustAmp = sumMatches(text, FRUSTRATION_AMPLIFIERS);
  const frustScore = frust.score + frustAmp.score;
  const frustIndicators = [...frust.indicators, ...frustAmp.indicators];

  // Frustrated takes priority if strong enough
  if (frustScore > 0.5) {
    return {
      sentiment: "frustrated",
      intensity: Math.min(frustScore, 1.0),
      indicators: frustIndicators,
    };
  }

  // Negative if clearly negative
  if (negScore > posScore + 0.2) {
    return {
      sentiment: "negative",
      intensity: Math.min(negScore, 1.0),
      indicators: neg.indicators,
    };
  }

  // Positive if clearly positive
  if (posScore > negScore + 0.2) {
    return {
      sentiment: "positive",
      intensity: Math.min(posScore, 1.0),
      indicators: posIndicators,
    };
  }

  return { sentiment: "neutral", intensity: 0.3, indicators: [] };
}

/**
 * Create empty frustration state for new session.
 */
export function newFrustrationState(): FrustrationState {
  return {
    level: 0,
    consecutiveNegative: 0,
    lastSignal: "neutral",
    lastUpdated: Date.now(),
    history: [],
  };
}

/**
 * Update running frustration state.
 * Frustration increases on consecutive negatives, decays with time.
 */
export function updateFrustration(
  state: FrustrationState,
  signal: SentimentSignal,
  nowMs?: number,
): FrustrationState {
  const now = nowMs ?? Date.now();

  // Clone to avoid mutation
  const s: FrustrationState = {
    level: state.level,
    consecutiveNegative: state.consecutiveNegative,
    lastSignal: state.lastSignal,
    lastUpdated: state.lastUpdated,
    history: [...state.history],
  };

  // Time decay: reduce frustration by 0.1 per 5 minutes of silence
  const elapsed = (now - s.lastUpdated) / (5 * 60 * 1000);
  s.level = Math.max(0, s.level - 0.1 * elapsed);

  if (signal.sentiment === "frustrated") {
    s.level = Math.min(1.0, s.level + 0.3);
    s.consecutiveNegative++;
  } else if (signal.sentiment === "negative") {
    s.level = Math.min(1.0, s.level + 0.15);
    s.consecutiveNegative++;
  } else if (signal.sentiment === "positive") {
    s.level = Math.max(0, s.level - 0.2);
    s.consecutiveNegative = 0;
  } else {
    // neutral
    s.consecutiveNegative = 0;
  }

  // Escalation: consecutive negatives compound
  if (s.consecutiveNegative >= 3) {
    s.level = Math.min(1.0, s.level + 0.1 * (s.consecutiveNegative - 2));
  }

  s.lastSignal = signal.sentiment;
  s.lastUpdated = now;
  s.history.push({ sentiment: signal.sentiment, timestamp: now });

  // Keep last 20 entries
  if (s.history.length > 20) {
    s.history.shift();
  }

  return s;
}

/**
 * Compute search adaptations based on frustration level.
 */
export function computeAdaptation(state: FrustrationState): SentimentAdaptation {
  if (state.level >= 0.7) {
    return { resultLimit: 5, minScore: 0.5, includeExplanation: true, urgencyBoost: 0.2 };
  }
  if (state.level >= 0.4) {
    return { resultLimit: 8, minScore: 0.4, includeExplanation: false, urgencyBoost: 0.1 };
  }
  return { resultLimit: 10, minScore: 0.3, includeExplanation: false, urgencyBoost: 0.0 };
}

/**
 * Format frustration context for debugging/display.
 */
export function formatFrustrationContext(state: FrustrationState): string {
  const levelPct = (state.level * 100).toFixed(0);
  const trend = state.history.length >= 3
    ? (() => {
        const recent = state.history.slice(-3);
        const negCount = recent.filter(h => h.sentiment === "negative" || h.sentiment === "frustrated").length;
        if (negCount >= 2) return "declining";
        const posCount = recent.filter(h => h.sentiment === "positive").length;
        if (posCount >= 2) return "improving";
        return "stable";
      })()
    : "stable";

  return `[Sentiment] level=${levelPct}% last=${state.lastSignal} consecutive_neg=${state.consecutiveNegative} trend=${trend}`;
}
