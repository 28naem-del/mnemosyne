/**
 * Core type definitions for Mnemosyne Memory OS.
 * 7-type memory taxonomy, urgency levels, domains,
 * confidence tags, and the MemCell atomic unit.
 */

export const MEMORY_TYPES = [
  "episodic",
  "semantic",
  "preference",
  "relationship",
  "procedural",
  "profile",
  "core",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];


export const URGENCY_LEVELS = ["critical", "important", "reference", "background"] as const;
export type UrgencyLevel = (typeof URGENCY_LEVELS)[number];

export const DOMAINS = ["technical", "personal", "project", "knowledge", "general"] as const;
export type Domain = (typeof DOMAINS)[number];

export const CONFIDENCE_TAGS = ["verified", "grounded", "inferred", "uncertain"] as const;
export type ConfidenceTag = (typeof CONFIDENCE_TAGS)[number];

export const CLASSIFICATIONS = ["public", "private", "secret"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const DEFAULT_COLLECTIONS = {
  SHARED: "memory_shared",
  PRIVATE: "memory_private",
  PROFILES: "agent_profiles",
  SKILLS: "skill_library",
} as const;

export type MemCell = {
  id: string;
  text: string;
  memoryType: MemoryType;
  classification: Classification;
  agentId: string;
  userId?: string;
  scope: "public" | "private";
  urgency: UrgencyLevel;
  domain: Domain;
  confidence: number;
  confidenceTag: ConfidenceTag;
  priorityScore: number;
  importance: number;
  linkedMemories: string[];
  accessTimes: number[];
  accessCount: number;
  eventTime: string;
  ingestedAt: string;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
  category?: string;
  metadata?: Record<string, unknown>;
};

export type MemCellSearchResult = {
  entry: MemCell;
  score: number;
  source?: "qdrant" | "graph" | "amem_link" | "graph_activation";
};

export type BroadcastMessage = {
  memoryId: string;
  agentId: string;
  memoryType: MemoryType;
  scope: "public" | "private";
  textPreview: string;
  event: "new_memory" | "conflict_resolved" | "critical" | "invalidate";
  linkedCount: number;
  timestamp: string;
};

export type Procedure = {
  id: string;
  title: string;
  triggerPhrases: string[];
  prerequisites: string[];
  steps: Array<{ seq: number; cmd: string; note: string }>;
  outcome: string;
  verified: boolean;
  executionCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export const DECAY_RATES: Record<UrgencyLevel, { d: number; beta: number }> = {
  critical:   { d: 0.3, beta: 2.0 },
  important:  { d: 0.5, beta: 1.0 },
  reference:  { d: 0.6, beta: 0.0 },
  background: { d: 0.8, beta: -1.0 },
};

export const SOURCE_TRUST: Record<string, number> = {
  owner_direct: 1.0,
  core: 0.95,
  semantic: 0.85,
  primary_agent: 0.80,
  secondary_agent: 0.75,
  episodic: 0.60,
};
