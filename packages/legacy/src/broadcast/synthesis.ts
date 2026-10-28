/**
 * Cross-Agent Knowledge Synthesis -- multi-agent pattern discovery.
 *
 * Discovers knowledge patterns that span multiple agents:
 *   - Consensus: 2+ agents agree on the same fact (similarity > 0.85)
 *   - Contradictions: agents disagree on the same topic (negation mismatch)
 *   - Blind spots: entities known by only 1 agent
 *   - Complementary: agents cover different aspects of the same topic
 *   - Collective patterns: patterns only visible across agent boundaries
 *
 * Background job -- expected runtime: 60-180s on typical corpus.
 * Zero npm deps, zero LLM calls -- pure set intersection + statistics.
 */

import { createHash } from "node:crypto";
import type { MemCell } from "../core/types.js";
import { DEFAULT_COLLECTIONS } from "../core/types.js";
import type { FalkorDBClient } from "../graph/falkordb.js";

// ============================================================================
// Types
// ============================================================================

export type InsightType =
  | "consensus"           // multiple agents agree on same fact
  | "complementary"       // agents have complementary knowledge
  | "contradiction"       // agents disagree
  | "blind_spot"          // topic known by 1 agent, unknown to all others
  | "collective_pattern"; // pattern visible only across agents

/** A collective insight synthesized from multiple agents */
export interface CollectiveInsight {
  id: string;
  type: InsightType;
  description: string;
  confidence: number;
  contributingAgents: string[];     // agent IDs
  contributingMemories: string[];   // memory IDs
  createdAt: string;
}

/** Per-agent knowledge summary for synthesis */
export interface AgentKnowledgeSummary {
  agentId: string;
  topEntities: Array<{ entity: string; count: number }>;
  topDomains: Array<{ domain: string; count: number }>;
  totalMemories: number;
}

/** Synthesis report */
export interface SynthesisReport {
  insights: CollectiveInsight[];
  agentSummaries: AgentKnowledgeSummary[];
  totalMemoriesAnalyzed: number;
  durationMs: number;
  timestamp: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** Generate deterministic UUID v5-style from insight type + key. */
function insightId(type: InsightType, key: string): string {
  const hash = createHash("sha256").update(`collective-insight:${type}:${key}`).digest("hex");
  // Format as UUID: 8-4-4-4-12
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

const NEGATION_RE = /\b(not|no|never|don't|doesn't|isn't|wasn't|aren't|can't|cannot|shouldn't|won't)\b/i;

function hasNegation(text: string): boolean {
  return NEGATION_RE.test(text);
}

/** Word-overlap similarity (cheap, for pre-filtering). */
function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) if (wordsB.has(w)) overlap++;
  return overlap / Math.max(wordsA.size, wordsB.size);
}

/** Extract significant words from text for entity extraction. */
function extractEntities(text: string): string[] {
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const stops = new Set(["this", "that", "with", "from", "into", "also", "have", "been", "will", "when", "then",
    "than", "their", "there", "they", "what", "were", "your", "about", "which", "would", "could", "should",
    "does", "each", "some", "more", "make", "like", "just", "over", "such", "very", "only"]);
  return [...new Set(words.filter(w => !stops.has(w)))];
}

/** Qdrant scroll helper -- fetches all points in batches. */
async function scrollAll(
  qdrantUrl: string,
  collection: string,
  batchSize: number,
  filter?: Record<string, unknown>,
): Promise<Array<{ id: string; payload: Record<string, unknown>; vector?: number[] }>> {
  const points: Array<{ id: string; payload: Record<string, unknown>; vector?: number[] }> = [];
  let offset: string | null = null;

  for (let guard = 0; guard < 500; guard++) {
    const body: Record<string, unknown> = {
      limit: batchSize,
      with_payload: true,
      with_vector: true,
    };
    if (filter) body.filter = filter;
    if (offset) body.offset = offset;

    const res = await fetch(`${qdrantUrl}/collections/${collection}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) break;

    const data = (await res.json()) as {
      result: {
        points: Array<{ id: string; payload: Record<string, unknown>; vector?: number[] }>;
        next_page_offset: string | null;
      };
    };
    points.push(...data.result.points);
    offset = data.result.next_page_offset;
    if (!offset) break;
  }
  return points;
}

/** Embed text via embedding service. */
async function embed(embedUrl: string, text: string): Promise<number[]> {
  const res = await fetch(embedUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text-v1.5", input: text }),
  });
  if (!res.ok) throw new Error(`Embed failed: ${res.status}`);
  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

/** Qdrant vector search with filter. */
async function vectorSearch(
  qdrantUrl: string,
  collection: string,
  vector: number[],
  limit: number,
  minScore: number,
  filter?: Record<string, unknown>,
): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> {
  const body: Record<string, unknown> = { vector, limit, with_payload: true };
  const must: unknown[] = [{ key: "deleted", match: { value: false } }];
  if (filter) {
    for (const [key, value] of Object.entries(filter)) {
      must.push({ key, match: { value } });
    }
  }
  body.filter = { must };

  const res = await fetch(`${qdrantUrl}/collections/${collection}/points/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { result: Array<{ id: string; score: number; payload: Record<string, unknown> }> };
  return data.result.filter(r => r.score >= minScore);
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Build per-agent knowledge summaries by scrolling shared collection
 * and aggregating by agent_id.
 */
export async function buildAgentSummaries(
  qdrantUrl: string,
  batchSize = 200,
): Promise<AgentKnowledgeSummary[]> {
  const points = await scrollAll(qdrantUrl, DEFAULT_COLLECTIONS.SHARED, batchSize, {
    must: [{ key: "deleted", match: { value: false } }],
  });

  const agentData = new Map<string, {
    entities: Map<string, number>;
    domains: Map<string, number>;
    count: number;
  }>();

  for (const pt of points) {
    const agentId = (pt.payload.agent_id as string) || "unknown";
    if (!agentData.has(agentId)) {
      agentData.set(agentId, { entities: new Map(), domains: new Map(), count: 0 });
    }
    const ad = agentData.get(agentId)!;
    ad.count++;

    // Extract entities from text
    const text = (pt.payload.text as string) || "";
    for (const ent of extractEntities(text)) {
      ad.entities.set(ent, (ad.entities.get(ent) || 0) + 1);
    }

    // Count domains
    const domain = (pt.payload.domain as string) || "general";
    ad.domains.set(domain, (ad.domains.get(domain) || 0) + 1);
  }

  const summaries: AgentKnowledgeSummary[] = [];
  for (const [agentId, data] of agentData) {
    summaries.push({
      agentId,
      topEntities: [...data.entities.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([entity, count]) => ({ entity, count })),
      topDomains: [...data.domains.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([domain, count]) => ({ domain, count })),
      totalMemories: data.count,
    });
  }
  return summaries;
}

/**
 * Find consensus: memories from 2+ agents with similarity > 0.85.
 * Uses Qdrant scroll + cross-comparison via vector search.
 */
export async function findConsensus(
  qdrantUrl: string,
  embedUrl: string,
  batchSize = 200,
): Promise<CollectiveInsight[]> {
  const points = await scrollAll(qdrantUrl, DEFAULT_COLLECTIONS.SHARED, batchSize, {
    must: [{ key: "deleted", match: { value: false } }],
  });

  // Group by agent
  const byAgent = new Map<string, typeof points>();
  for (const pt of points) {
    const agentId = (pt.payload.agent_id as string) || "unknown";
    if (!byAgent.has(agentId)) byAgent.set(agentId, []);
    byAgent.get(agentId)!.push(pt);
  }

  const agents = [...byAgent.keys()];
  if (agents.length < 2) return [];

  const insights: CollectiveInsight[] = [];
  const seenPairs = new Set<string>();

  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const agentA = agents[i], agentB = agents[j];
      // Sample: compare up to 100 memories from agentA
      const sampleA = byAgent.get(agentA)!.slice(0, 100);

      for (const memA of sampleA) {
        const vecA = memA.vector;
        if (!vecA || vecA.length === 0) continue;

        const matches = await vectorSearch(qdrantUrl, DEFAULT_COLLECTIONS.SHARED, vecA, 3, 0.85, { agent_id: agentB });

        for (const match of matches) {
          const pairKey = [memA.id, match.id].sort().join("|");
          if (seenPairs.has(pairKey)) continue;
          seenPairs.add(pairKey);

          const textA = (memA.payload.text as string) || "";
          insights.push({
            id: insightId("consensus", pairKey),
            type: "consensus",
            description: `Both ${agentA} and ${agentB} agree: ${textA.slice(0, 200)}`,
            confidence: match.score,
            contributingAgents: [agentA, agentB],
            contributingMemories: [memA.id, match.id],
            createdAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  return insights;
}

/**
 * Find contradictions: memories from different agents with
 * similarity 0.70-0.92 and negation mismatch (one has negation, other doesn't).
 */
export async function findContradictions(
  qdrantUrl: string,
  embedUrl: string,
  batchSize = 200,
): Promise<CollectiveInsight[]> {
  const points = await scrollAll(qdrantUrl, DEFAULT_COLLECTIONS.SHARED, batchSize, {
    must: [{ key: "deleted", match: { value: false } }],
  });

  const byAgent = new Map<string, typeof points>();
  for (const pt of points) {
    const agentId = (pt.payload.agent_id as string) || "unknown";
    if (!byAgent.has(agentId)) byAgent.set(agentId, []);
    byAgent.get(agentId)!.push(pt);
  }

  const agents = [...byAgent.keys()];
  if (agents.length < 2) return [];

  const insights: CollectiveInsight[] = [];
  const seenPairs = new Set<string>();

  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const agentA = agents[i], agentB = agents[j];
      const sampleA = byAgent.get(agentA)!.slice(0, 100);

      for (const memA of sampleA) {
        const vecA = memA.vector;
        if (!vecA || vecA.length === 0) continue;

        // Search in the contradiction range: similar but not identical
        const matches = await vectorSearch(qdrantUrl, DEFAULT_COLLECTIONS.SHARED, vecA, 5, 0.70, { agent_id: agentB });

        for (const match of matches) {
          if (match.score >= 0.92) continue; // Too similar -- consensus, not contradiction

          const textA = (memA.payload.text as string) || "";
          const textB = (match.payload.text as string) || "";

          // Negation mismatch: one has negation, other doesn't
          const negA = hasNegation(textA);
          const negB = hasNegation(textB);
          if (negA === negB) continue; // Both positive or both negative -- not a contradiction

          const pairKey = [memA.id, match.id].sort().join("|");
          if (seenPairs.has(pairKey)) continue;
          seenPairs.add(pairKey);

          insights.push({
            id: insightId("contradiction", pairKey),
            type: "contradiction",
            description: `${agentA} says "${textA.slice(0, 100)}" but ${agentB} says "${textB.slice(0, 100)}"`,
            confidence: 1.0 - match.score, // Lower similarity = higher contradiction confidence
            contributingAgents: [agentA, agentB],
            contributingMemories: [memA.id, match.id],
            createdAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  return insights;
}

/**
 * Find blind spots: entities known by only 1 agent.
 * Uses FalkorDB if available, else falls back to text-based extraction.
 */
export async function findBlindSpots(
  falkordb: FalkorDBClient | null,
  agentSummaries: AgentKnowledgeSummary[],
): Promise<CollectiveInsight[]> {
  // Approach: find entities that appear in only 1 agent's top entities
  const entityAgents = new Map<string, Set<string>>();
  const entityCounts = new Map<string, number>();

  for (const summary of agentSummaries) {
    for (const { entity, count } of summary.topEntities) {
      if (!entityAgents.has(entity)) entityAgents.set(entity, new Set());
      entityAgents.get(entity)!.add(summary.agentId);
      entityCounts.set(entity, (entityCounts.get(entity) || 0) + count);
    }
  }

  // Also try FalkorDB if available
  if (falkordb) {
    try {
      const results = await falkordb.query(
        `MATCH (a:Entity)-[:CREATED_BY]-(m:Entity {type: 'Memory'})-[:MENTIONS]->(e:Entity)
         WITH e, collect(DISTINCT a.name) AS agents, count(m) AS memCount
         WHERE size(agents) = 1 AND memCount >= 3
         RETURN e.name, agents[0] AS onlyAgent, memCount
         ORDER BY memCount DESC
         LIMIT 20`
      );
      // Merge FalkorDB results
      if (Array.isArray(results)) {
        for (const row of results) {
          if (Array.isArray(row) && row.length >= 3) {
            const entity = String(row[0]);
            const agent = String(row[1]);
            entityAgents.set(entity, new Set([agent]));
            entityCounts.set(entity, Number(row[2]) || 3);
          }
        }
      }
    } catch {
      // FalkorDB unavailable -- proceed with text-based approach
    }
  }

  const insights: CollectiveInsight[] = [];
  for (const [entity, agents] of entityAgents) {
    // Only 1 agent knows this entity, and it appears 3+ times (significant)
    if (agents.size === 1 && (entityCounts.get(entity) || 0) >= 3) {
      const onlyAgent = [...agents][0];
      insights.push({
        id: insightId("blind_spot", `${entity}:${onlyAgent}`),
        type: "blind_spot",
        description: `Only ${onlyAgent} knows about "${entity}" (${entityCounts.get(entity)} mentions)`,
        confidence: Math.min(0.9, 0.5 + (entityCounts.get(entity) || 0) * 0.05),
        contributingAgents: [onlyAgent],
        contributingMemories: [],
        createdAt: new Date().toISOString(),
      });
    }
  }

  return insights
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 20);
}

/**
 * Find complementary knowledge: two agents cover different aspects
 * of the same entity/topic.
 */
export async function findComplementary(
  qdrantUrl: string,
  embedUrl: string,
  falkordb: FalkorDBClient | null,
  agentSummaries: AgentKnowledgeSummary[],
): Promise<CollectiveInsight[]> {
  // Find entities known by 2+ agents -- these are candidates for complementary knowledge
  const entityAgents = new Map<string, Set<string>>();
  for (const summary of agentSummaries) {
    for (const { entity } of summary.topEntities) {
      if (!entityAgents.has(entity)) entityAgents.set(entity, new Set());
      entityAgents.get(entity)!.add(summary.agentId);
    }
  }

  const insights: CollectiveInsight[] = [];
  const sharedEntities = [...entityAgents.entries()]
    .filter(([_, agents]) => agents.size >= 2)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 20); // Limit to top 20 shared entities

  for (const [entity, agents] of sharedEntities) {
    const agentList = [...agents];
    // For each pair of agents sharing an entity, check if they cover different domains
    for (let i = 0; i < agentList.length; i++) {
      for (let j = i + 1; j < agentList.length; j++) {
        const summaryA = agentSummaries.find(s => s.agentId === agentList[i]);
        const summaryB = agentSummaries.find(s => s.agentId === agentList[j]);
        if (!summaryA || !summaryB) continue;

        // Check domain divergence
        const domainsA = new Set(summaryA.topDomains.map(d => d.domain));
        const domainsB = new Set(summaryB.topDomains.map(d => d.domain));
        let sharedDomains = 0;
        for (const d of domainsA) if (domainsB.has(d)) sharedDomains++;

        const totalDomains = new Set([...domainsA, ...domainsB]).size;
        const divergence = totalDomains > 0 ? 1 - (sharedDomains / totalDomains) : 0;

        if (divergence > 0.3) {
          insights.push({
            id: insightId("complementary", `${entity}:${agentList[i]}:${agentList[j]}`),
            type: "complementary",
            description: `${agentList[i]} and ${agentList[j]} have complementary knowledge about "${entity}" (${(divergence * 100).toFixed(0)}% domain divergence)`,
            confidence: Math.min(0.9, 0.5 + divergence * 0.4),
            contributingAgents: [agentList[i], agentList[j]],
            contributingMemories: [],
            createdAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  return insights.slice(0, 20);
}

/**
 * Store insights to Qdrant as shared memories.
 * Stored in shared collection with scope="collective_insight".
 */
export async function storeInsights(
  qdrantUrl: string,
  embedUrl: string,
  insights: CollectiveInsight[],
): Promise<number> {
  if (insights.length === 0) return 0;

  let stored = 0;
  for (const insight of insights) {
    try {
      const vector = await embed(embedUrl, insight.description);
      const id = insight.id;
      const now = new Date().toISOString();

      const payload = {
        text: insight.description,
        agent_id: "collective",
        user_id: null,
        memory_type: "semantic",
        scope: "collective_insight",
        classification: "public",
        category: "fact",
        urgency: "reference",
        domain: "knowledge",
        confidence: insight.confidence,
        confidence_tag: insight.confidence >= 0.85 ? "verified" : "grounded",
        priority_score: 0.6,
        importance: 0.7 + (insight.contributingAgents.length - 1) * 0.05,
        linked_memories: insight.contributingMemories,
        access_times: [Date.now()],
        access_count: 0,
        event_time: now,
        ingested_at: now,
        created_at: now,
        updated_at: now,
        deleted: false,
        metadata: {
          source: "collective_synthesis",
          insight_type: insight.type,
          contributing_agents: insight.contributingAgents,
          contributing_memories: insight.contributingMemories,
          synthesized_from: insight.contributingAgents,
        },
      };

      await fetch(`${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.SHARED}/points`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wait: true, points: [{ id, vector, payload }] }),
      });
      stored++;
    } catch {
      // Non-fatal: skip individual insight on error
    }
  }
  return stored;
}

/**
 * Run full collective synthesis.
 * Background job -- expected runtime: 60-180 seconds.
 */
export async function runCollectiveSynthesis(
  qdrantUrl: string,
  embedUrl: string,
  falkordb: FalkorDBClient | null,
  batchSize = 200,
): Promise<SynthesisReport> {
  const start = Date.now();
  const allInsights: CollectiveInsight[] = [];

  // Step 1: Build agent summaries
  const agentSummaries = await buildAgentSummaries(qdrantUrl, batchSize);
  const totalMemoriesAnalyzed = agentSummaries.reduce((sum, s) => sum + s.totalMemories, 0);

  if (agentSummaries.length < 2) {
    return {
      insights: [],
      agentSummaries,
      totalMemoriesAnalyzed,
      durationMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    };
  }

  // Step 2: Find consensus (most valuable -- 2+ agents agreeing)
  try {
    const consensus = await findConsensus(qdrantUrl, embedUrl, batchSize);
    allInsights.push(...consensus);
  } catch {
    // Non-fatal
  }

  // Step 3: Find contradictions
  try {
    const contradictions = await findContradictions(qdrantUrl, embedUrl, batchSize);
    allInsights.push(...contradictions);
  } catch {
    // Non-fatal
  }

  // Step 4: Find blind spots
  try {
    const blindSpots = await findBlindSpots(falkordb, agentSummaries);
    allInsights.push(...blindSpots);
  } catch {
    // Non-fatal
  }

  // Step 5: Find complementary knowledge
  try {
    const complementary = await findComplementary(qdrantUrl, embedUrl, falkordb, agentSummaries);
    allInsights.push(...complementary);
  } catch {
    // Non-fatal
  }

  // Step 6: Store insights as collective_insight memories
  try {
    await storeInsights(qdrantUrl, embedUrl, allInsights);
  } catch {
    // Non-fatal: report still returned even if storage fails
  }

  return {
    insights: allInsights,
    agentSummaries,
    totalMemoriesAnalyzed,
    durationMs: Date.now() - start,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format synthesis report for display.
 */
export function formatSynthesisReport(report: SynthesisReport): string {
  const lines: string[] = [];
  lines.push(`=== Collective Knowledge Synthesis Report ===`);
  lines.push(`Analyzed: ${report.totalMemoriesAnalyzed} memories across ${report.agentSummaries.length} agents`);
  lines.push(`Duration: ${(report.durationMs / 1000).toFixed(1)}s`);
  lines.push(`Generated: ${report.timestamp}`);
  lines.push(``);

  // Agent summaries
  lines.push(`--- Agent Summaries ---`);
  for (const agent of report.agentSummaries) {
    const topEntities = agent.topEntities.slice(0, 5).map(e => e.entity).join(", ");
    const topDomains = agent.topDomains.slice(0, 3).map(d => d.domain).join(", ");
    lines.push(`  ${agent.agentId}: ${agent.totalMemories} memories | top entities: ${topEntities} | domains: ${topDomains}`);
  }
  lines.push(``);

  // Group insights by type
  const byType = new Map<InsightType, CollectiveInsight[]>();
  for (const insight of report.insights) {
    if (!byType.has(insight.type)) byType.set(insight.type, []);
    byType.get(insight.type)!.push(insight);
  }

  const labels: Record<InsightType, string> = {
    consensus: "Consensus (agents agree)",
    contradiction: "Contradictions (agents disagree)",
    blind_spot: "Blind Spots (single-agent knowledge)",
    complementary: "Complementary Knowledge",
    collective_pattern: "Collective Patterns",
  };

  for (const [type, label] of Object.entries(labels) as Array<[InsightType, string]>) {
    const items = byType.get(type) || [];
    if (items.length === 0) continue;
    lines.push(`--- ${label}: ${items.length} ---`);
    for (const item of items.slice(0, 10)) {
      const conf = `${(item.confidence * 100).toFixed(0)}%`;
      const agents = item.contributingAgents.join(", ");
      lines.push(`  [${conf}] (${agents}) ${item.description.slice(0, 200)}`);
    }
    lines.push(``);
  }

  if (report.insights.length === 0) {
    lines.push(`No cross-agent insights found. Need memories from 2+ different agents.`);
  } else {
    lines.push(`Total insights: ${report.insights.length}`);
  }

  return lines.join("\n");
}

/** Last report cache for "view" action */
let lastReport: SynthesisReport | null = null;

export function getLastReport(): SynthesisReport | null {
  return lastReport;
}

export function setLastReport(report: SynthesisReport): void {
  lastReport = report;
}
