/**
 * Preference Tracking -- Running user model from interactions.
 *
 * Tracks: communication style, tool preferences, topic interests,
 * time patterns, response format preferences.
 *
 * Zero npm deps, zero LLM calls -- pure pattern matching and counters.
 * Performance: <20ms for preference lookup (L1 in-memory cache).
 *
 * Storage:
 *   L1: In-memory Map (instant, per-process)
 *   L2: Redis key "user_model:<userId>:<agentId>" (cross-session)
 *   L3: Qdrant private memory scope=user_model (durable)
 */

import type { MemCell } from "../core/types.js";
import { DEFAULT_COLLECTIONS } from "../core/types.js";

// ============================================================================
// Types
// ============================================================================

export type PreferenceCategory =
  | "language"        // programming language preferences
  | "tool"            // tool/framework preferences
  | "style"           // coding style, formatting
  | "workflow"        // process preferences (TDD, PR flow)
  | "communication"   // how user likes responses (brief vs detailed)
  | "infra"           // infrastructure preferences (which server for what)
  | "general";        // catch-all

export interface Preference {
  key: string;            // normalized key, e.g. "language:typescript"
  category: PreferenceCategory;
  value: string;          // "prefers TypeScript over JavaScript"
  strength: number;       // 0.0-1.0, strengthened by repetition
  evidenceCount: number;
  firstSeen: string;      // ISO timestamp
  lastSeen: string;
  sources: string[];      // memory IDs that contributed
}

export interface UserModel {
  userId: string;
  agentId: string;
  preferences: Map<string, Preference>;
  updatedAt: string;
  version: number;
}

export interface PreferenceSignal {
  key: string;
  category: PreferenceCategory;
  value: string;
  isExplicit: boolean;    // "I prefer X" vs inferred from usage
}

// ============================================================================
// Constants
// ============================================================================

const EXPLICIT_POSITIVE_PATTERNS: RegExp[] = [
  /\bI\s+(?:prefer|like|love|always\s+use|want|enjoy)\s+(.+)/i,
  /\b(?:use|switch\s+to|go\s+with)\s+(\S+)\s+(?:instead|rather|over)/i,
  /\blet(?:'s| us)\s+use\s+(\S+)/i,
  /\bmy\s+(?:preferred|favorite)\s+(?:is\s+)?(\S+)/i,
];

const EXPLICIT_NEGATIVE_PATTERNS: RegExp[] = [
  /\b(?:don'?t|never)\s+(?:use|want|like|need)\s+(.+)/i,
  /\b(?:hate|avoid|stop\s+using)\s+(.+)/i,
];

const IMPLICIT_CATEGORIES: Record<string, string[]> = {
  language: [
    "typescript", "python", "javascript", "rust", "go", "java",
    "ruby", "swift", "kotlin", "c++", "php",
  ],
  tool: [
    "docker", "redis", "qdrant", "nginx", "pm2", "git", "npm",
    "pnpm", "yarn", "webpack", "vite", "esbuild", "bun", "deno",
    "postgres", "mongodb", "falkordb", "neo4j", "grafana", "prometheus",
  ],
  style: [
    "tabs", "spaces", "semicolons", "camelcase", "snake_case",
    "prettier", "eslint", "biome",
  ],
  workflow: [
    "tdd", "pr", "code review", "pair programming", "mob programming",
    "ci/cd", "trunk-based", "gitflow",
  ],
  infra: [
    "primary", "secondary", "staging", "production",
    "server", "cluster", "node", "instance",
  ],
  communication: [
    "concise", "detailed", "verbose", "brief", "technical",
    "step-by-step", "examples",
  ],
};

// Flatten for quick lookup: term -> category
const TERM_TO_CATEGORY = new Map<string, PreferenceCategory>();
for (const [cat, terms] of Object.entries(IMPLICIT_CATEGORIES)) {
  for (const term of terms) {
    TERM_TO_CATEGORY.set(term.toLowerCase(), cat as PreferenceCategory);
  }
}

// ============================================================================
// L1 In-Memory Cache
// ============================================================================

const modelCache = new Map<string, UserModel>();

function cacheKey(userId: string, agentId: string): string {
  return `${userId}:${agentId}`;
}

// ============================================================================
// Extraction
// ============================================================================

function normalizeKey(category: PreferenceCategory, value: string): string {
  return `${category}:${value.toLowerCase().replace(/[^a-z0-9_+#.-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "")}`;
}

function classifyPreferenceCategory(value: string): PreferenceCategory {
  const lower = value.toLowerCase();
  for (const [term, cat] of TERM_TO_CATEGORY) {
    if (lower.includes(term)) return cat;
  }
  return "general";
}

/**
 * Extract preference signals from user text.
 * Detects explicit ("I prefer", "always use", "I like") and
 * implicit (repeated tool mentions, consistent patterns) preferences.
 */
export function extractPreferenceSignals(text: string): PreferenceSignal[] {
  if (!text || text.length < 3) return [];
  const signals: PreferenceSignal[] = [];
  const seen = new Set<string>();

  // Explicit positive extraction
  for (const pattern of EXPLICIT_POSITIVE_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const value = match[1].trim().slice(0, 100);
      const category = classifyPreferenceCategory(value);
      const key = normalizeKey(category, value);
      if (!seen.has(key)) {
        seen.add(key);
        signals.push({ key, category, value: `prefers ${value}`, isExplicit: true });
      }
    }
  }

  // Explicit negative extraction
  for (const pattern of EXPLICIT_NEGATIVE_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const value = match[1].trim().slice(0, 100);
      const category = classifyPreferenceCategory(value);
      const key = normalizeKey(category, `avoid_${value}`);
      if (!seen.has(key)) {
        seen.add(key);
        signals.push({ key, category, value: `avoids ${value}`, isExplicit: true });
      }
    }
  }

  // Implicit: count mentions of known tools/languages
  const lower = text.toLowerCase();
  for (const [term, category] of TERM_TO_CATEGORY) {
    // Word boundary check to avoid false positives (e.g. "going" matching "go")
    const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (regex.test(lower)) {
      const key = normalizeKey(category, term);
      if (!seen.has(key)) {
        seen.add(key);
        signals.push({ key, category, value: `uses ${term}`, isExplicit: false });
      }
    }
  }

  return signals;
}

// ============================================================================
// Model Management
// ============================================================================

function createEmptyModel(userId: string, agentId: string): UserModel {
  return {
    userId,
    agentId,
    preferences: new Map(),
    updatedAt: new Date().toISOString(),
    version: 0,
  };
}

/**
 * Load user model from L1 cache -> Redis (L2) -> Qdrant (persistent).
 * Creates empty model if none found.
 */
export async function loadUserModel(
  qdrantUrl: string,
  redisUrl: string,
  userId: string,
  agentId: string,
): Promise<UserModel> {
  const ck = cacheKey(userId, agentId);

  // L1: in-memory (instant)
  const cached = modelCache.get(ck);
  if (cached) return cached;

  // L2: Redis
  try {
    const Redis = (await import("ioredis")).default;
    const redis = new (Redis as any)(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 3000,
      enableReadyCheck: false,
    }) as import("ioredis").default;
    await redis.connect();
    const raw = await redis.get(`user_model:${userId}:${agentId}`);
    await redis.quit();

    if (raw) {
      const parsed = JSON.parse(raw) as SerializedUserModel;
      const model = deserializeModel(parsed);
      modelCache.set(ck, model);
      return model;
    }
  } catch {
    // Redis unavailable -- fall through to Qdrant
  }

  // L3: Qdrant -- search for scope=user_model
  try {
    const res = await fetch(`${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.PRIVATE}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filter: {
          must: [
            { key: "scope", match: { value: "user_model" } },
            { key: "agent_id", match: { value: agentId } },
            { key: "user_id", match: { value: userId } },
          ],
        },
        limit: 1,
        with_payload: true,
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { result: { points: Array<{ payload: Record<string, unknown> }> } };
      if (data.result.points.length > 0) {
        const payload = data.result.points[0].payload;
        if (payload.user_model && typeof payload.user_model === "string") {
          const parsed = JSON.parse(payload.user_model) as SerializedUserModel;
          const model = deserializeModel(parsed);
          modelCache.set(ck, model);
          return model;
        }
      }
    }
  } catch {
    // Qdrant unavailable -- return empty
  }

  // No stored model -- create fresh
  const empty = createEmptyModel(userId, agentId);
  modelCache.set(ck, empty);
  return empty;
}

/**
 * Update user model with new signals.
 * - New preference: add with strength 0.3 (explicit) or 0.15 (implicit)
 * - Existing preference: strength += 0.1, cap at 1.0
 * - Contradicting preference: reduce old strength by 0.2, add new at 0.3
 */
export function updateModel(
  model: UserModel,
  signals: PreferenceSignal[],
  sourceId?: string,
): UserModel {
  if (signals.length === 0) return model;

  const now = new Date().toISOString();

  for (const signal of signals) {
    const existing = model.preferences.get(signal.key);

    if (existing) {
      // Strengthen existing preference
      existing.strength = Math.min(1.0, existing.strength + 0.1);
      existing.evidenceCount += 1;
      existing.lastSeen = now;
      if (sourceId && !existing.sources.includes(sourceId)) {
        existing.sources.push(sourceId);
        if (existing.sources.length > 20) existing.sources.shift();
      }
    } else {
      // Check for contradictions: same category, opposite direction
      // e.g. "language:typescript" (prefers) vs "language:avoid_typescript" (avoids)
      const isAvoid = signal.key.includes(":avoid_");
      const baseTerm = isAvoid
        ? signal.key.replace(":avoid_", ":")
        : signal.key;

      let contradicted = false;
      for (const [existKey, existPref] of model.preferences) {
        if (existKey === signal.key) continue;
        if (existPref.category !== signal.category) continue;

        // Check if it's a contradiction
        const existIsAvoid = existKey.includes(":avoid_");
        const existBase = existIsAvoid
          ? existKey.replace(":avoid_", ":")
          : existKey;

        // Fuzzy contradiction match: one base key starts with the other
        const isContradiction = isAvoid !== existIsAvoid && (
          baseTerm === existBase ||
          baseTerm.startsWith(existBase) ||
          existBase.startsWith(baseTerm)
        );
        if (isContradiction) {
          // Direct contradiction -- weaken old
          existPref.strength = Math.max(0, existPref.strength - 0.2);
          contradicted = true;
        }
      }

      // Add new preference
      const initStrength = signal.isExplicit ? 0.3 : 0.15;
      model.preferences.set(signal.key, {
        key: signal.key,
        category: signal.category,
        value: signal.value,
        strength: contradicted ? 0.3 : initStrength,
        evidenceCount: 1,
        firstSeen: now,
        lastSeen: now,
        sources: sourceId ? [sourceId] : [],
      });
    }
  }

  model.updatedAt = now;
  model.version += 1;

  // Update L1 cache
  modelCache.set(cacheKey(model.userId, model.agentId), model);

  return model;
}

// ============================================================================
// Persistence
// ============================================================================

type SerializedUserModel = {
  userId: string;
  agentId: string;
  preferences: Array<[string, Preference]>;
  updatedAt: string;
  version: number;
};

function serializeModel(model: UserModel): SerializedUserModel {
  return {
    userId: model.userId,
    agentId: model.agentId,
    preferences: [...model.preferences.entries()],
    updatedAt: model.updatedAt,
    version: model.version,
  };
}

function deserializeModel(data: SerializedUserModel): UserModel {
  return {
    userId: data.userId,
    agentId: data.agentId,
    preferences: new Map(data.preferences),
    updatedAt: data.updatedAt,
    version: data.version,
  };
}

/**
 * Persist model to Redis (fast) and Qdrant (durable).
 * Redis key: "user_model:<userId>:<agentId>"
 * Qdrant: scope=user_model in private memory
 */
export async function saveUserModel(
  qdrantUrl: string,
  redisUrl: string,
  model: UserModel,
  vector: number[],
): Promise<void> {
  const serialized = JSON.stringify(serializeModel(model));

  // Redis (fast, non-fatal)
  try {
    const Redis = (await import("ioredis")).default;
    const redis = new (Redis as any)(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 3000,
      enableReadyCheck: false,
    }) as import("ioredis").default;
    await redis.connect();
    // 24h TTL -- model gets rebuilt from Qdrant if Redis expires
    await redis.setex(`user_model:${model.userId}:${model.agentId}`, 86400, serialized);
    await redis.quit();
  } catch {
    // Redis unavailable -- Qdrant is the durable fallback
  }

  // Qdrant (durable, non-fatal)
  try {
    const pointId = `user_model_${model.userId}_${model.agentId}`.replace(/[^a-z0-9_-]/gi, "_");

    // Use a deterministic UUID derived from the point ID
    const id = uuidFromString(pointId);

    await fetch(`${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.PRIVATE}/points`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wait: true,
        points: [{
          id,
          vector,
          payload: {
            text: `User model for ${model.userId}`,
            scope: "user_model",
            agent_id: model.agentId,
            user_id: model.userId,
            memory_type: "profile",
            classification: "private",
            user_model: serialized,
            deleted: false,
            updated_at: model.updatedAt,
            created_at: model.updatedAt,
            version: model.version,
            preference_count: model.preferences.size,
          },
        }],
      }),
    });
  } catch {
    // Qdrant unavailable
  }
}

/** Deterministic UUID v5-like from a string (no crypto dep needed) */
function uuidFromString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, "0");
  // Produce a valid UUID format
  return `${hex.slice(0, 8)}-${hex.slice(0, 4)}-4${hex.slice(1, 4)}-8${hex.slice(0, 3)}-${hex.padEnd(12, "0").slice(0, 12)}`;
}

// ============================================================================
// Preference Boost for Search
// ============================================================================

/**
 * Extract key terms from a preference value string.
 * "prefers TypeScript" -> ["typescript"]
 * "uses docker and redis" -> ["docker", "redis"]
 */
function extractKeyTerms(value: string): string[] {
  const lower = value.toLowerCase();
  const terms: string[] = [];
  // Use word boundary matching for known terms (avoids "pr" matching inside "prefers")
  for (const [term] of TERM_TO_CATEGORY) {
    const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (regex.test(lower)) terms.push(term);
  }
  // Also extract any word >3 chars that isn't a stop word
  const stopWords = new Set(["prefers", "uses", "avoids", "likes", "with", "over", "instead", "rather", "always", "never", "that", "this", "from", "into"]);
  for (const word of lower.split(/\s+/)) {
    if (word.length > 3 && !stopWords.has(word) && !terms.includes(word)) {
      terms.push(word);
    }
  }
  return terms;
}

/**
 * Get preference-based boost for a search result.
 * If the memory aligns with a strong preference (>0.4), boost score.
 * Returns multiplier: 1.0 (no effect) to 1.15 (strong preference match).
 */
export function preferenceBoost(
  memory: MemCell,
  model: UserModel,
): number {
  if (model.preferences.size === 0) return 1.0;

  let boost = 1.0;
  const memText = memory.text.toLowerCase();

  for (const pref of model.preferences.values()) {
    if (pref.strength < 0.4) continue;

    const prefTerms = extractKeyTerms(pref.value);
    const matchCount = prefTerms.filter((term) => {
      const regex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      return regex.test(memText);
    }).length;

    if (matchCount >= 1) {
      // Scale boost by preference strength
      boost = Math.max(boost, 1.0 + 0.15 * pref.strength);
    }
  }

  return Math.min(boost, 1.15); // cap at 15% boost
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format user model as readable context block.
 */
export function formatUserModel(model: UserModel): string {
  if (model.preferences.size === 0) {
    return "No preferences tracked yet.";
  }

  const lines: string[] = [
    `User Model (v${model.version}, updated ${model.updatedAt})`,
    `Preferences: ${model.preferences.size}`,
    "",
  ];

  // Group by category
  const byCategory = new Map<PreferenceCategory, Preference[]>();
  for (const pref of model.preferences.values()) {
    const list = byCategory.get(pref.category) || [];
    list.push(pref);
    byCategory.set(pref.category, list);
  }

  // Sort categories, show strongest first within each
  const categoryOrder: PreferenceCategory[] = [
    "language", "tool", "style", "workflow",
    "communication", "infra", "general",
  ];

  for (const cat of categoryOrder) {
    const prefs = byCategory.get(cat);
    if (!prefs || prefs.length === 0) continue;

    lines.push(`[${cat}]`);
    const sorted = prefs.sort((a, b) => b.strength - a.strength);
    for (const p of sorted) {
      const bar = strengthBar(p.strength);
      lines.push(`  ${bar} ${p.value} (x${p.evidenceCount})`);
    }
  }

  return lines.join("\n");
}

function strengthBar(strength: number): string {
  const filled = Math.round(strength * 5);
  return "#".repeat(filled) + "-".repeat(5 - filled);
}

// ============================================================================
// Reset
// ============================================================================

/**
 * Reset user model -- clears in-memory, Redis, and Qdrant.
 */
export async function resetUserModel(
  qdrantUrl: string,
  redisUrl: string,
  userId: string,
  agentId: string,
): Promise<void> {
  const ck = cacheKey(userId, agentId);
  modelCache.delete(ck);

  // Clear Redis
  try {
    const Redis = (await import("ioredis")).default;
    const redis = new (Redis as any)(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      commandTimeout: 3000,
      enableReadyCheck: false,
    }) as import("ioredis").default;
    await redis.connect();
    await redis.del(`user_model:${userId}:${agentId}`);
    await redis.quit();
  } catch {
    // Non-fatal
  }

  // Soft-delete in Qdrant
  try {
    const id = uuidFromString(`user_model_${userId}_${agentId}`.replace(/[^a-z0-9_-]/gi, "_"));
    await fetch(`${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.PRIVATE}/points/payload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wait: true,
        points: [id],
        payload: { deleted: true, updated_at: new Date().toISOString() },
      }),
    });
  } catch {
    // Non-fatal
  }
}

/**
 * Get the L1-cached model without async IO (for perf-critical paths).
 * Returns null if not yet loaded.
 */
export function getCachedModel(userId: string, agentId: string): UserModel | null {
  return modelCache.get(cacheKey(userId, agentId)) || null;
}
