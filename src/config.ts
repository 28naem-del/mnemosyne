/**
 * Configuration for Mnemosyne Memory OS.
 */

import { DEFAULT_COLLECTIONS } from "./core/types.js";

export type MnemosyneConfig = {
  // Required
  vectorDbUrl: string;
  embeddingUrl: string;
  agentId: string;

  // Embedding model
  embeddingModel?: string;

  // Auto behavior
  autoCapture?: boolean;
  autoRecall?: boolean;
  captureMaxChars?: number;

  // Pipeline
  extractionUrl?: string;
  enableExtraction?: boolean;

  // Knowledge Graph (requires FalkorDB / Redis Graph)
  graphUrl?: string;
  enableGraph?: boolean;
  enableAutoLink?: boolean;
  autoLinkThreshold?: number;

  // Cognitive features
  enableDecay?: boolean;
  enablePriorityScoring?: boolean;
  enableConfidenceTags?: boolean;
  enableBM25?: boolean;
  spreadActivationDepth?: number;
  spreadActivationDecay?: number;
  enablePreferenceTracking?: boolean;
  enableSentimentTracking?: boolean;
  enableLessonExtraction?: boolean;
  enableTemporalMining?: boolean;
  enableProactiveWarnings?: boolean;
  enableDreamConsolidation?: boolean;
  dreamIntervalHours?: number;

  // Multi-agent (requires Redis)
  redisUrl?: string;
  enableBroadcast?: boolean;
  enableCollectiveSynthesis?: boolean;

  // Collection names (customizable)
  collections?: {
    shared?: string;
    private?: string;
    profiles?: string;
    skills?: string;
  };
};

export type ResolvedConfig = Required<
  Pick<MnemosyneConfig, "vectorDbUrl" | "embeddingUrl" | "agentId">
> & {
  embeddingModel: string;
  autoCapture: boolean;
  autoRecall: boolean;
  captureMaxChars: number;
  extractionUrl: string;
  enableExtraction: boolean;
  graphUrl: string;
  enableGraph: boolean;
  enableAutoLink: boolean;
  autoLinkThreshold: number;
  enableDecay: boolean;
  enablePriorityScoring: boolean;
  enableConfidenceTags: boolean;
  enableBM25: boolean;
  spreadActivationDepth: number;
  spreadActivationDecay: number;
  enablePreferenceTracking: boolean;
  enableSentimentTracking: boolean;
  enableLessonExtraction: boolean;
  enableTemporalMining: boolean;
  enableProactiveWarnings: boolean;
  enableDreamConsolidation: boolean;
  dreamIntervalHours: number;
  redisUrl: string;
  enableBroadcast: boolean;
  enableCollectiveSynthesis: boolean;
  sharedCollection: string;
  privateCollection: string;
  profilesCollection: string;
  skillsCollection: string;
};

function validateUrl(url: string, field: string): void {
  try {
    new URL(url);
  } catch {
    throw new Error(`${field} must be a valid URL, got: "${url}"`);
  }
}

export function resolveConfig(cfg: MnemosyneConfig): ResolvedConfig {
  if (!cfg.vectorDbUrl) throw new Error("vectorDbUrl is required");
  if (!cfg.embeddingUrl) throw new Error("embeddingUrl is required");
  if (!cfg.agentId) throw new Error("agentId is required");

  validateUrl(cfg.vectorDbUrl, "vectorDbUrl");
  validateUrl(cfg.embeddingUrl, "embeddingUrl");
  if (cfg.extractionUrl) validateUrl(cfg.extractionUrl, "extractionUrl");
  if (cfg.graphUrl) validateUrl(cfg.graphUrl, "graphUrl");
  if (cfg.redisUrl) validateUrl(cfg.redisUrl, "redisUrl");

  const autoLinkThreshold = cfg.autoLinkThreshold ?? 0.70;
  if (autoLinkThreshold < 0.3 || autoLinkThreshold > 0.99) {
    throw new Error("autoLinkThreshold must be between 0.3 and 0.99");
  }

  const captureMaxChars = cfg.captureMaxChars ?? 500;
  if (captureMaxChars < 100 || captureMaxChars > 10_000) {
    throw new Error("captureMaxChars must be between 100 and 10000");
  }

  return {
    vectorDbUrl: cfg.vectorDbUrl,
    embeddingUrl: cfg.embeddingUrl,
    agentId: cfg.agentId,
    embeddingModel: cfg.embeddingModel ?? "nomic-text-v1.5",
    autoCapture: cfg.autoCapture ?? true,
    autoRecall: cfg.autoRecall ?? true,
    captureMaxChars,
    extractionUrl: cfg.extractionUrl ?? "",
    enableExtraction: cfg.enableExtraction ?? false,
    graphUrl: cfg.graphUrl ?? "",
    enableGraph: cfg.enableGraph ?? false,
    enableAutoLink: cfg.enableAutoLink ?? true,
    autoLinkThreshold,
    enableDecay: cfg.enableDecay ?? true,
    enablePriorityScoring: cfg.enablePriorityScoring ?? true,
    enableConfidenceTags: cfg.enableConfidenceTags ?? true,
    enableBM25: cfg.enableBM25 ?? true,
    spreadActivationDepth: cfg.spreadActivationDepth ?? 2,
    spreadActivationDecay: cfg.spreadActivationDecay ?? 0.5,
    enablePreferenceTracking: cfg.enablePreferenceTracking ?? true,
    enableSentimentTracking: cfg.enableSentimentTracking ?? true,
    enableLessonExtraction: cfg.enableLessonExtraction ?? true,
    enableTemporalMining: cfg.enableTemporalMining ?? true,
    enableProactiveWarnings: cfg.enableProactiveWarnings ?? true,
    enableDreamConsolidation: cfg.enableDreamConsolidation ?? true,
    dreamIntervalHours: cfg.dreamIntervalHours ?? 12,
    redisUrl: cfg.redisUrl ?? "",
    enableBroadcast: cfg.enableBroadcast ?? false,
    enableCollectiveSynthesis: cfg.enableCollectiveSynthesis ?? false,
    sharedCollection: cfg.collections?.shared ?? DEFAULT_COLLECTIONS.SHARED,
    privateCollection: cfg.collections?.private ?? DEFAULT_COLLECTIONS.PRIVATE,
    profilesCollection: cfg.collections?.profiles ?? DEFAULT_COLLECTIONS.PROFILES,
    skillsCollection: cfg.collections?.skills ?? DEFAULT_COLLECTIONS.SKILLS,
  };
}

export const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
