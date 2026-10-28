/**
 * TOMA -- Theory of Mind for Agents
 *
 * Models what each agent knows by filtering memories by agent_id.
 * Enables queries like "what does AgentX know about Y?" and identifies
 * knowledge gaps between agents.
 *
 * Uses existing shared memory collection (filtered by agent_id) and
 * a profiles collection for cached profiles.
 *
 * No LLM calls -- purely search + aggregation.
 */

import type { MemCell, MemoryType } from "../core/types.js";
import { DEFAULT_COLLECTIONS } from "../core/types.js";

export type AgentKnowledge = {
  agentId: string;
  topic: string;
  memories: MemCell[];
  count: number;
};

export type KnowledgeGapResult = {
  agentA: string;
  agentB: string;
  topic: string;
  aKnowsThatBDoesnt: MemCell[];
  gapCount: number;
};

export type AgentProfileSummary = {
  agentId: string;
  totalMemories: number;
  topDomains: Array<{ domain: string; count: number }>;
  topTypes: Array<{ type: string; count: number }>;
  lastActive: string | null;
  avgConfidence: number;
};

/**
 * Agent registry: maps display names to agent IDs.
 * Users provide their own registry when initializing TOMA.
 */
export type AgentRegistry = Record<string, string>;

/**
 * Resolve an agent name from natural language to an agent_id
 * using a configurable agent registry.
 */
export function resolveAgentId(
  nameOrId: string,
  registry: AgentRegistry = {},
): string | null {
  const lower = nameOrId.toLowerCase().trim();
  // Direct match in registry
  if (registry[lower]) return registry[lower];
  // Check if it's already a known agent ID (value in registry)
  if (Object.values(registry).includes(lower)) return lower;
  // If no registry provided, return the input as-is if non-empty
  return lower || null;
}

/**
 * Detect if a query mentions another agent by name.
 * Returns the agent_id if found using the provided registry.
 */
export function detectAgentMention(
  query: string,
  registry: AgentRegistry = {},
): string | null {
  const lower = query.toLowerCase();

  // Check for "what does X know" pattern
  const knowsPattern = /what (?:does|do|did) (\w+) know/i;
  const match = lower.match(knowsPattern);
  if (match) {
    return resolveAgentId(match[1], registry);
  }

  // Check for "X's knowledge" or "X's memories" pattern
  const possessivePattern = /(\w+)'s (?:knowledge|memories|memory|info|data)/i;
  const possMatch = lower.match(possessivePattern);
  if (possMatch) {
    return resolveAgentId(possMatch[1], registry);
  }

  // Check for "ask X about" pattern
  const askPattern = /ask (\w+) about/i;
  const askMatch = lower.match(askPattern);
  if (askMatch) {
    return resolveAgentId(askMatch[1], registry);
  }

  // Check all registry names against the query text
  for (const [name, id] of Object.entries(registry)) {
    const regex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (regex.test(lower)) return id;
  }

  return null;
}

/**
 * Convert Qdrant payload to MemCell.
 */
function payloadToMemCell(id: string, p: Record<string, unknown>): MemCell {
  return {
    id,
    text: (p.text as string) || (p.content as string) || "",
    memoryType: (p.memory_type as MemCell["memoryType"]) || "semantic",
    classification: (p.classification as MemCell["classification"]) || "public",
    agentId: (p.agent_id as string) || "",
    userId: (p.user_id as string) || undefined,
    scope: (p.scope as MemCell["scope"]) || "public",
    urgency: (p.urgency as MemCell["urgency"]) || "reference",
    domain: (p.domain as MemCell["domain"]) || "knowledge",
    confidence: typeof p.confidence === "number" ? p.confidence : 0.7,
    confidenceTag: (p.confidence_tag as MemCell["confidenceTag"]) || "grounded",
    priorityScore: typeof p.priority_score === "number" ? p.priority_score : 0.5,
    importance: typeof p.importance === "number" ? p.importance : 0.5,
    linkedMemories: Array.isArray(p.linked_memories) ? p.linked_memories : [],
    accessTimes: Array.isArray(p.access_times) ? p.access_times : [],
    accessCount: typeof p.access_count === "number" ? p.access_count : 0,
    eventTime: (p.event_time as string) || "",
    ingestedAt: (p.ingested_at as string) || "",
    createdAt: (p.created_at as string) || "",
    updatedAt: (p.updated_at as string) || "",
    deleted: p.deleted === true,
    metadata: (p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata))
      ? (p.metadata as Record<string, unknown>) : {},
  };
}

/**
 * Search shared memory collection filtered by agent_id for a specific topic.
 * Returns what a specific agent knows about a topic.
 */
export async function whatAgentKnows(
  qdrantUrl: string,
  embedUrl: string,
  agentId: string,
  topic: string,
  limit: number = 10,
): Promise<AgentKnowledge> {
  // Embed the topic
  const embedRes = await fetch(embedUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: topic }),
  });
  const embedData = (await embedRes.json()) as { data: Array<{ embedding: number[] }> };
  const vector = embedData.data[0].embedding;

  // Search with agent_id filter
  const searchRes = await fetch(
    `${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.SHARED}/points/search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector,
        limit,
        filter: {
          must: [
            { key: "deleted", match: { value: false } },
            { key: "agent_id", match: { value: agentId } },
          ],
        },
        with_payload: true,
      }),
    },
  );

  if (!searchRes.ok) return { agentId, topic, memories: [], count: 0 };

  const data = (await searchRes.json()) as {
    result: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
  };

  const memories = data.result
    .filter(r => r.score >= 0.3)
    .map(r => payloadToMemCell(r.id, r.payload));

  return { agentId, topic, memories, count: memories.length };
}

/**
 * Find what agentA knows that agentB doesn't about a topic.
 * Searches A's memories, then checks if B has similar content.
 */
export async function knowledgeGap(
  qdrantUrl: string,
  embedUrl: string,
  agentIdA: string,
  agentIdB: string,
  topic: string,
  limit: number = 10,
): Promise<KnowledgeGapResult> {
  // Get what A knows
  const aKnowledge = await whatAgentKnows(qdrantUrl, embedUrl, agentIdA, topic, limit);

  if (aKnowledge.count === 0) {
    return { agentA: agentIdA, agentB: agentIdB, topic, aKnowsThatBDoesnt: [], gapCount: 0 };
  }

  // For each of A's memories, check if B has something similar
  const gaps: MemCell[] = [];

  for (const mem of aKnowledge.memories) {
    // Embed A's memory text and search B's memories
    const embedRes = await fetch(embedUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: mem.text }),
    });
    const embedData = (await embedRes.json()) as { data: Array<{ embedding: number[] }> };
    const vector = embedData.data[0].embedding;

    const searchRes = await fetch(
      `${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.SHARED}/points/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vector,
          limit: 1,
          filter: {
            must: [
              { key: "deleted", match: { value: false } },
              { key: "agent_id", match: { value: agentIdB } },
            ],
          },
          with_payload: true,
        }),
      },
    );

    if (!searchRes.ok) {
      gaps.push(mem);
      continue;
    }

    const data = (await searchRes.json()) as {
      result: Array<{ id: string; score: number }>;
    };

    // If B has no similar memory (score < 0.7), it's a gap
    if (data.result.length === 0 || data.result[0].score < 0.7) {
      gaps.push(mem);
    }
  }

  return {
    agentA: agentIdA,
    agentB: agentIdB,
    topic,
    aKnowsThatBDoesnt: gaps,
    gapCount: gaps.length,
  };
}

/**
 * Build aggregate profile for an agent: memory count, top domains, last active.
 * Uses profiles collection for caching, falls back to live aggregation.
 */
export async function agentProfile(
  qdrantUrl: string,
  agentId: string,
): Promise<AgentProfileSummary> {
  // Scroll the agent's memories from shared collection
  const res = await fetch(
    `${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.SHARED}/points/scroll`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        limit: 500,
        filter: {
          must: [
            { key: "deleted", match: { value: false } },
            { key: "agent_id", match: { value: agentId } },
          ],
        },
        with_payload: true,
      }),
    },
  );

  if (!res.ok) {
    return {
      agentId,
      totalMemories: 0,
      topDomains: [],
      topTypes: [],
      lastActive: null,
      avgConfidence: 0,
    };
  }

  const data = (await res.json()) as {
    result: { points: Array<{ id: string; payload: Record<string, unknown> }> };
  };

  const points = data.result.points || [];
  if (points.length === 0) {
    return {
      agentId,
      totalMemories: 0,
      topDomains: [],
      topTypes: [],
      lastActive: null,
      avgConfidence: 0,
    };
  }

  // Aggregate domains
  const domainCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  let totalConfidence = 0;
  let latestUpdate = "";

  for (const p of points) {
    const domain = (p.payload.domain as string) || "knowledge";
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);

    const mType = (p.payload.memory_type as string) || "semantic";
    typeCounts.set(mType, (typeCounts.get(mType) || 0) + 1);

    totalConfidence += typeof p.payload.confidence === "number" ? p.payload.confidence : 0.5;

    const updated = (p.payload.updated_at as string) || (p.payload.created_at as string) || "";
    if (updated > latestUpdate) latestUpdate = updated;
  }

  const topDomains = [...domainCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([domain, count]) => ({ domain, count }));

  const topTypes = [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));

  const profile: AgentProfileSummary = {
    agentId,
    totalMemories: points.length,
    topDomains,
    topTypes,
    lastActive: latestUpdate || null,
    avgConfidence: points.length > 0 ? totalConfidence / points.length : 0,
  };

  // Cache profile in profiles collection
  await cacheAgentProfile(qdrantUrl, profile).catch(() => {});

  return profile;
}

/**
 * Cache an agent profile in the profiles collection.
 */
async function cacheAgentProfile(
  qdrantUrl: string,
  profile: AgentProfileSummary,
): Promise<void> {
  // Create a deterministic ID from agent_id
  const id = profile.agentId;

  // We need a vector -- use a simple placeholder since the profiles collection
  // may have a required vector. This profile is retrieved by payload filter, not vector search.
  const vector = new Array(768).fill(0);

  await fetch(`${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.PROFILES}/points`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wait: true,
      points: [{
        id: deterministicUuid(id),
        vector,
        payload: {
          agent_id: profile.agentId,
          total_memories: profile.totalMemories,
          top_domains: profile.topDomains,
          top_types: profile.topTypes,
          last_active: profile.lastActive,
          avg_confidence: profile.avgConfidence,
          cached_at: new Date().toISOString(),
        },
      }],
    }),
  });
}

/**
 * Generate a deterministic UUID-like string from input.
 * Uses a simple hash to ensure the same agentId always maps to the same point ID.
 */
function deterministicUuid(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  // Qdrant accepts string or integer IDs; use a padded hex string
  const hex = Math.abs(hash).toString(16).padStart(8, "0");
  return `${hex}-0000-0000-0000-${hex}${hex}`.slice(0, 36);
}

/**
 * Format TOMA results for display in memory_recall output.
 */
export function formatAgentKnowledge(knowledge: AgentKnowledge): string {
  if (knowledge.count === 0) {
    return `${knowledge.agentId} has no memories about "${knowledge.topic}"`;
  }

  const lines = [`${knowledge.agentId} knows ${knowledge.count} things about "${knowledge.topic}":`];
  for (const mem of knowledge.memories.slice(0, 5)) {
    lines.push(`  - [${mem.memoryType}] ${mem.text.slice(0, 100)}`);
  }
  return lines.join("\n");
}

/**
 * Format knowledge gap results.
 */
export function formatKnowledgeGap(gap: KnowledgeGapResult): string {
  if (gap.gapCount === 0) {
    return `${gap.agentB} knows everything ${gap.agentA} knows about "${gap.topic}"`;
  }

  const lines = [`${gap.agentA} knows ${gap.gapCount} things about "${gap.topic}" that ${gap.agentB} doesn't:`];
  for (const mem of gap.aKnowsThatBDoesnt.slice(0, 5)) {
    lines.push(`  - ${mem.text.slice(0, 100)}`);
  }
  return lines.join("\n");
}

/**
 * Format agent profile summary.
 */
export function formatAgentProfile(profile: AgentProfileSummary): string {
  const lines = [
    `Agent: ${profile.agentId}`,
    `Total memories: ${profile.totalMemories}`,
    `Avg confidence: ${(profile.avgConfidence * 100).toFixed(0)}%`,
    `Last active: ${profile.lastActive || "unknown"}`,
  ];
  if (profile.topDomains.length > 0) {
    lines.push(`Top domains: ${profile.topDomains.map(d => `${d.domain}(${d.count})`).join(", ")}`);
  }
  if (profile.topTypes.length > 0) {
    lines.push(`Top types: ${profile.topTypes.map(t => `${t.type}(${t.count})`).join(", ")}`);
  }
  return lines.join("\n");
}
