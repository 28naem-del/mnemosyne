/**
 * Auto Pattern Mining -- scan memory corpus for clusters, recurring themes,
 * co-occurrence correlations, and failure patterns.
 *
 * Algorithms:
 *   - Agglomerative clustering via vector cosine similarity (single-linkage)
 *   - Co-occurrence mining from graph database
 *   - TF-IDF based topic extraction (zero deps)
 *   - Recurring error detection via keyword + similarity grouping
 *
 * Runs as background job (cron-compatible). NOT in the search hot path.
 * Zero npm deps, zero LLM calls -- pure statistics and graph analysis.
 */

import { createHash } from "node:crypto";
import type { MemCell, MemoryType, Domain } from "../core/types.js";
import { DEFAULT_COLLECTIONS } from "../core/types.js";

// ============================================================================
// Types
// ============================================================================

/** Graph client interface for co-occurrence mining */
export interface GraphClient {
  query(cypher: string): Promise<unknown>;
}

/** A discovered pattern */
export interface Pattern {
  id: string;              // deterministic hash of pattern key
  type: PatternType;
  description: string;     // human-readable pattern description
  confidence: number;      // 0.0-1.0
  occurrences: number;     // how many times observed
  evidenceIds: string[];   // memory IDs supporting this pattern
  firstSeen: string;
  lastSeen: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

export type PatternType =
  | "co_occurrence"    // entities A and B frequently appear together
  | "sequence"         // A is often followed by B
  | "cluster"          // group of memories about similar topic
  | "recurring_error"  // same error appears multiple times
  | "correlation"      // when X happens, Y tends to follow
  | "anomaly";         // something unusual detected

/** Cluster of similar memories */
export interface MemoryCluster {
  centroidText: string;
  members: Array<{ id: string; text: string; score: number }>;
  size: number;
  avgSimilarity: number;
  dominantType: MemoryType;
  dominantDomain: Domain;
}

/** Co-occurring entity pair */
export interface CoOccurrence {
  entityA: string;
  entityB: string;
  count: number;
  memories: string[];
}

/** Mining job result */
export interface MiningReport {
  clusters: MemoryCluster[];
  coOccurrences: CoOccurrence[];
  patterns: Pattern[];
  totalMemoriesScanned: number;
  durationMs: number;
  timestamp: string;
}

// ============================================================================
// Vector Math
// ============================================================================

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function avgVector(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const avg = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) avg[i] += v[i];
  }
  for (let i = 0; i < dim; i++) avg[i] /= vectors.length;
  return avg;
}

// ============================================================================
// Deterministic Pattern ID
// ============================================================================

function patternId(type: PatternType, key: string): string {
  // Generate a deterministic UUID v4-like ID from the hash
  const hex = createHash("sha256").update(`${type}:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ============================================================================
// Qdrant Scroll (batch fetcher)
// ============================================================================

interface ScrollPoint {
  id: string;
  payload: Record<string, unknown>;
  vector?: number[];
}

async function scrollBatch(
  qdrantUrl: string,
  collection: string,
  limit: number,
  offset?: string | number | null,
): Promise<{ points: ScrollPoint[]; nextOffset: string | number | null }> {
  const body: Record<string, unknown> = {
    limit,
    filter: { must: [{ key: "deleted", match: { value: false } }] },
    with_payload: true,
    with_vector: true,
  };
  if (offset !== undefined && offset !== null) {
    body.offset = offset;
  }

  const res = await fetch(`${qdrantUrl}/collections/${collection}/points/scroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) return { points: [], nextOffset: null };
  const data = (await res.json()) as {
    result: { points: ScrollPoint[]; next_page_offset?: string | number | null };
  };
  return {
    points: data.result.points || [],
    nextOffset: data.result.next_page_offset ?? null,
  };
}

// ============================================================================
// TF-IDF Topic Extraction
// ============================================================================

// Common English stopwords
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor",
  "not", "only", "own", "same", "so", "than", "too", "very", "just",
  "because", "but", "and", "or", "if", "while", "that", "this", "these",
  "those", "what", "which", "who", "whom", "it", "its", "i", "me", "my",
  "we", "our", "you", "your", "he", "him", "his", "she", "her", "they",
  "them", "their", "about", "up", "don", "didn", "doesn", "isn", "wasn",
  "aren", "couldn", "wouldn", "shouldn", "won", "haven", "hasn", "hadn",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

/** Compute TF-IDF scores for a set of documents. Returns top N terms per doc. */
export function computeTfIdf(
  docs: Array<{ id: string; text: string }>,
  topN = 5,
): Map<string, Array<{ term: string; score: number }>> {
  const totalDocs = docs.length;
  if (totalDocs === 0) return new Map();

  // Document frequency: how many docs contain each term
  const df = new Map<string, number>();
  const docTokens = new Map<string, string[]>();

  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    docTokens.set(doc.id, tokens);
    const seen = new Set<string>();
    for (const t of tokens) {
      if (!seen.has(t)) {
        df.set(t, (df.get(t) || 0) + 1);
        seen.add(t);
      }
    }
  }

  // Compute TF-IDF per doc
  const result = new Map<string, Array<{ term: string; score: number }>>();

  for (const doc of docs) {
    const tokens = docTokens.get(doc.id)!;
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }

    const scores: Array<{ term: string; score: number }> = [];
    for (const [term, count] of tf) {
      const termDf = df.get(term) || 1;
      const idf = Math.log(totalDocs / termDf);
      const tfScore = count / tokens.length;
      scores.push({ term, score: tfScore * idf });
    }

    scores.sort((a, b) => b.score - a.score);
    result.set(doc.id, scores.slice(0, topN));
  }

  return result;
}

/** Extract corpus-level top terms using aggregate TF-IDF. */
export function extractCorpusTopics(
  docs: Array<{ id: string; text: string }>,
  topN = 20,
): Array<{ term: string; score: number; docCount: number }> {
  const totalDocs = docs.length;
  if (totalDocs === 0) return [];

  const df = new Map<string, number>();
  const globalTf = new Map<string, number>();

  for (const doc of docs) {
    const tokens = tokenize(doc.text);
    const seen = new Set<string>();
    for (const t of tokens) {
      globalTf.set(t, (globalTf.get(t) || 0) + 1);
      if (!seen.has(t)) {
        df.set(t, (df.get(t) || 0) + 1);
        seen.add(t);
      }
    }
  }

  const scores: Array<{ term: string; score: number; docCount: number }> = [];
  for (const [term, count] of globalTf) {
    const termDf = df.get(term) || 1;
    // Skip terms that appear in >80% of docs (too common) or <2 docs
    if (termDf > totalDocs * 0.8 || termDf < 2) continue;
    const idf = Math.log(totalDocs / termDf);
    scores.push({ term, score: count * idf, docCount: termDf });
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, topN);
}

// ============================================================================
// Similarity Matrix
// ============================================================================

/**
 * Build a similarity matrix for a batch of memories using their vectors.
 * O(n^2) comparison -- run on batches of <=500.
 */
export function buildSimilarityMatrix(
  memories: Array<{ id: string; text: string; vector: number[] }>,
): Map<string, Map<string, number>> {
  const matrix = new Map<string, Map<string, number>>();

  for (let i = 0; i < memories.length; i++) {
    const row = new Map<string, number>();
    for (let j = 0; j < memories.length; j++) {
      if (i === j) {
        row.set(memories[j].id, 1.0);
      } else if (j > i) {
        row.set(memories[j].id, cosineSimilarity(memories[i].vector, memories[j].vector));
      } else {
        // Symmetric: reuse previously computed value
        row.set(memories[j].id, matrix.get(memories[j].id)!.get(memories[i].id)!);
      }
    }
    matrix.set(memories[i].id, row);
  }

  return matrix;
}

// ============================================================================
// Agglomerative Clustering
// ============================================================================

interface ClusterState {
  members: Array<{ id: string; text: string; vector: number[]; memoryType: MemoryType; domain: Domain }>;
  centroid: number[];
}

/**
 * Agglomerative clustering: group memories by vector similarity.
 * Single-linkage with threshold (default 0.75).
 */
export function clusterMemories(
  memories: Array<{ id: string; text: string; vector: number[]; memoryType: MemoryType; domain: Domain }>,
  threshold = 0.75,
): MemoryCluster[] {
  if (memories.length === 0) return [];

  // Initialize: each memory is its own cluster
  let clusters: ClusterState[] = memories.map(m => ({
    members: [m],
    centroid: [...m.vector],
  }));

  while (true) {
    let bestSim = 0;
    let bestI = -1;
    let bestJ = -1;

    // Find most similar pair (single linkage: max sim between any two members)
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        let maxSim = 0;
        for (const mi of clusters[i].members) {
          for (const mj of clusters[j].members) {
            const sim = cosineSimilarity(mi.vector, mj.vector);
            if (sim > maxSim) maxSim = sim;
          }
        }
        if (maxSim > bestSim) {
          bestSim = maxSim;
          bestI = i;
          bestJ = j;
        }
      }
    }

    if (bestSim < threshold || bestI < 0) break;

    // Merge bestI and bestJ
    const merged: ClusterState = {
      members: [...clusters[bestI].members, ...clusters[bestJ].members],
      centroid: avgVector([...clusters[bestI].members, ...clusters[bestJ].members].map(m => m.vector)),
    };
    clusters[bestI] = merged;
    clusters.splice(bestJ, 1);
  }

  // Filter: only return clusters with 3+ members
  return clusters
    .filter(c => c.members.length >= 3)
    .map(c => {
      // Find dominant type and domain
      const typeCounts = new Map<MemoryType, number>();
      const domainCounts = new Map<Domain, number>();
      for (const m of c.members) {
        typeCounts.set(m.memoryType, (typeCounts.get(m.memoryType) || 0) + 1);
        domainCounts.set(m.domain, (domainCounts.get(m.domain) || 0) + 1);
      }

      let dominantType: MemoryType = "semantic";
      let maxTypeCount = 0;
      for (const [t, cnt] of typeCounts) {
        if (cnt > maxTypeCount) { dominantType = t; maxTypeCount = cnt; }
      }

      let dominantDomain: Domain = "general";
      let maxDomainCount = 0;
      for (const [d, cnt] of domainCounts) {
        if (cnt > maxDomainCount) { dominantDomain = d; maxDomainCount = cnt; }
      }

      // Compute average pairwise similarity within cluster
      let totalSim = 0;
      let pairCount = 0;
      for (let i = 0; i < c.members.length; i++) {
        for (let j = i + 1; j < c.members.length; j++) {
          totalSim += cosineSimilarity(c.members[i].vector, c.members[j].vector);
          pairCount++;
        }
      }

      // Centroid text: pick the member closest to centroid
      let bestDist = -1;
      let centroidText = c.members[0].text;
      for (const m of c.members) {
        const sim = cosineSimilarity(m.vector, c.centroid);
        if (sim > bestDist) { bestDist = sim; centroidText = m.text; }
      }

      return {
        centroidText: centroidText.slice(0, 200),
        members: c.members.map(m => ({
          id: m.id,
          text: m.text.slice(0, 200),
          score: cosineSimilarity(m.vector, c.centroid),
        })),
        size: c.members.length,
        avgSimilarity: pairCount > 0 ? totalSim / pairCount : 1.0,
        dominantType,
        dominantDomain,
      };
    })
    .sort((a, b) => b.size - a.size);
}

// ============================================================================
// Co-occurrence Mining (Graph Database)
// ============================================================================

/**
 * Mine entity co-occurrences from a graph database.
 * Query: entities that share MENTIONS edges to 3+ common memories.
 */
export async function mineCoOccurrences(
  graphClient: GraphClient,
  minCount = 3,
): Promise<CoOccurrence[]> {
  try {
    const results = await graphClient.query(
      `MATCH (e1:Entity)<-[:MENTIONS]-(m:Entity {type: 'Memory'})-[:MENTIONS]->(e2:Entity)
       WHERE e1.name < e2.name AND e1.type <> 'Memory' AND e2.type <> 'Memory'
       WITH e1, e2, collect(m.name) AS memories, count(m) AS cnt
       WHERE cnt >= ${minCount}
       RETURN e1.name, e2.name, cnt, memories
       ORDER BY cnt DESC
       LIMIT 50`
    );

    const coOccurrences: CoOccurrence[] = [];

    if (Array.isArray(results) && results.length > 0) {
      const rows = Array.isArray(results[1]) ? results[1] : results;
      for (const row of rows) {
        if (!Array.isArray(row) || row.length < 4) continue;
        coOccurrences.push({
          entityA: String(row[0]),
          entityB: String(row[1]),
          count: Number(row[2]),
          memories: Array.isArray(row[3]) ? row[3].map(String) : [],
        });
      }
    }

    return coOccurrences;
  } catch {
    // Graph DB might not be available -- graceful degradation
    return [];
  }
}

// ============================================================================
// Recurring Error Detection
// ============================================================================

const ERROR_KEYWORDS = /\b(error|fail|failed|failure|crash|exception|timeout|refused|denied|broken|bug|issue|problem|wrong|fix|fixed)\b/i;

/**
 * Detect recurring errors: memories with domain="technical" containing
 * error/fail keywords, grouped by similarity.
 */
export function detectRecurringErrors(
  memories: Array<{ id: string; text: string; vector: number[]; domain: Domain }>,
): Pattern[] {
  // Filter to technical memories with error keywords
  const errorMems = memories.filter(
    m => (m.domain === "technical" || m.domain === "general") && ERROR_KEYWORDS.test(m.text),
  );

  if (errorMems.length < 2) return [];

  // Simple greedy clustering for error memories
  const errorClusters: Array<{ members: typeof errorMems }> = [];
  const assigned = new Set<string>();

  for (let i = 0; i < errorMems.length; i++) {
    if (assigned.has(errorMems[i].id)) continue;

    const cluster = [errorMems[i]];
    assigned.add(errorMems[i].id);

    for (let j = i + 1; j < errorMems.length; j++) {
      if (assigned.has(errorMems[j].id)) continue;
      const sim = cosineSimilarity(errorMems[i].vector, errorMems[j].vector);
      if (sim >= 0.7) {
        cluster.push(errorMems[j]);
        assigned.add(errorMems[j].id);
      }
    }

    if (cluster.length >= 2) {
      errorClusters.push({ members: cluster });
    }
  }

  return errorClusters.map(cluster => {
    // Extract common keywords for description
    const allTokens = cluster.members.flatMap(m => tokenize(m.text));
    const tokenCounts = new Map<string, number>();
    for (const t of allTokens) tokenCounts.set(t, (tokenCounts.get(t) || 0) + 1);
    const commonTerms = [...tokenCounts.entries()]
      .filter(([, c]) => c >= 2)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([t]) => t);

    const timestamps = cluster.members
      .map(m => (m as unknown as MemCell).createdAt || (m as unknown as MemCell).eventTime || "")
      .filter(Boolean)
      .sort();

    const key = commonTerms.join(",") + ":" + cluster.members.length;
    return {
      id: patternId("recurring_error", key),
      type: "recurring_error" as PatternType,
      description: `Recurring error pattern (${cluster.members.length}x): ${commonTerms.join(", ")}`,
      confidence: Math.min(0.95, 0.5 + cluster.members.length * 0.1),
      occurrences: cluster.members.length,
      evidenceIds: cluster.members.map(m => m.id),
      firstSeen: timestamps[0] || new Date().toISOString(),
      lastSeen: timestamps[timestamps.length - 1] || new Date().toISOString(),
      tags: ["error", ...commonTerms.slice(0, 3)],
      metadata: { commonTerms },
    };
  });
}

// ============================================================================
// Pattern Synthesis
// ============================================================================

/**
 * Convert clusters and co-occurrences into Pattern objects.
 */
export function synthesizePatterns(
  clusters: MemoryCluster[],
  coOccurrences: CoOccurrence[],
  recurringErrors: Pattern[],
): Pattern[] {
  const patterns: Pattern[] = [...recurringErrors];
  const now = new Date().toISOString();

  // Cluster patterns
  for (const cluster of clusters) {
    const allText = cluster.members.map(m => m.text).join(" ");
    const tokens = tokenize(allText);
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
    const topTerms = [...freq.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([t]) => t);

    const key = topTerms.join(",") + ":" + cluster.size;
    patterns.push({
      id: patternId("cluster", key),
      type: "cluster",
      description: `Topic cluster (${cluster.size} memories, ${(cluster.avgSimilarity * 100).toFixed(0)}% avg similarity): ${topTerms.join(", ")}`,
      confidence: Math.min(0.95, cluster.avgSimilarity * (0.5 + cluster.size * 0.05)),
      occurrences: cluster.size,
      evidenceIds: cluster.members.map(m => m.id),
      firstSeen: now,
      lastSeen: now,
      tags: [cluster.dominantType, cluster.dominantDomain, ...topTerms.slice(0, 3)],
      metadata: {
        dominantType: cluster.dominantType,
        dominantDomain: cluster.dominantDomain,
        avgSimilarity: cluster.avgSimilarity,
        centroidText: cluster.centroidText,
      },
    });
  }

  // Co-occurrence patterns
  for (const co of coOccurrences) {
    const key = `${co.entityA}:${co.entityB}`;
    patterns.push({
      id: patternId("co_occurrence", key),
      type: "co_occurrence",
      description: `Entities "${co.entityA}" and "${co.entityB}" co-occur in ${co.count} memories`,
      confidence: Math.min(0.95, 0.4 + co.count * 0.08),
      occurrences: co.count,
      evidenceIds: co.memories.slice(0, 20),
      firstSeen: now,
      lastSeen: now,
      tags: [co.entityA, co.entityB],
      metadata: { entityA: co.entityA, entityB: co.entityB },
    });
  }

  return patterns.sort((a, b) => b.confidence - a.confidence);
}

// ============================================================================
// Pattern Persistence (Qdrant)
// ============================================================================

/**
 * Embed text via embeddings endpoint.
 */
async function embedText(embedUrl: string, text: string): Promise<number[]> {
  const res = await fetch(`${embedUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text }),
  });
  if (!res.ok) throw new Error(`Embed failed: ${res.status}`);
  const data = (await res.json()) as { embedding?: number[]; data?: Array<{ embedding: number[] }> };
  return data.embedding || data.data?.[0]?.embedding || [];
}

/**
 * Persist patterns to Qdrant (private memory, scope="pattern").
 */
export async function savePatterns(
  qdrantUrl: string,
  embedUrl: string,
  agentId: string,
  patterns: Pattern[],
): Promise<number> {
  let saved = 0;

  for (const pattern of patterns) {
    try {
      const vector = await embedText(embedUrl, pattern.description);
      if (vector.length === 0) continue;

      const res = await fetch(
        `${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.PRIVATE}/points`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wait: true,
            points: [{
              id: pattern.id,
              vector,
              payload: {
                text: pattern.description,
                agent_id: agentId,
                memory_type: "semantic",
                scope: "private",
                classification: "private",
                category: "other",
                urgency: "reference",
                domain: "knowledge",
                confidence: pattern.confidence,
                confidence_tag: "inferred",
                priority_score: 0.6,
                importance: pattern.confidence,
                linked_memories: pattern.evidenceIds.slice(0, 10),
                access_times: [Date.now()],
                access_count: 0,
                event_time: pattern.firstSeen,
                ingested_at: new Date().toISOString(),
                created_at: pattern.firstSeen,
                updated_at: new Date().toISOString(),
                deleted: false,
                metadata: {
                  source: "pattern_mining",
                  pattern_type: pattern.type,
                  pattern_id: pattern.id,
                  occurrences: pattern.occurrences,
                  tags: pattern.tags,
                  ...pattern.metadata,
                },
              },
            }],
          }),
        },
      );

      if (res.ok) saved++;
    } catch {
      // Non-fatal: skip individual pattern save failures
    }
  }

  return saved;
}

/**
 * Load previously-mined patterns.
 */
export async function loadPatterns(
  qdrantUrl: string,
  agentId: string,
): Promise<Pattern[]> {
  try {
    const res = await fetch(
      `${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.PRIVATE}/points/scroll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limit: 100,
          filter: {
            must: [
              { key: "agent_id", match: { value: agentId } },
              { key: "deleted", match: { value: false } },
              {
                key: "metadata.source",
                match: { value: "pattern_mining" },
              },
            ],
          },
          with_payload: true,
        }),
      },
    );

    if (!res.ok) return [];
    const data = (await res.json()) as {
      result: { points: Array<{ id: string; payload: Record<string, unknown> }> };
    };

    return (data.result.points || []).map(p => {
      const meta = (p.payload.metadata as Record<string, unknown>) || {};
      return {
        id: String(p.id),
        type: (meta.pattern_type as PatternType) || "cluster",
        description: (p.payload.text as string) || "",
        confidence: (p.payload.confidence as number) ?? 0.5,
        occurrences: (meta.occurrences as number) || 1,
        evidenceIds: (p.payload.linked_memories as string[]) || [],
        firstSeen: (p.payload.event_time as string) || "",
        lastSeen: (p.payload.updated_at as string) || "",
        tags: (meta.tags as string[]) || [],
        metadata: meta,
      };
    });
  } catch {
    return [];
  }
}

// ============================================================================
// Full Mining Job
// ============================================================================

/**
 * Parse a Qdrant scroll point into a typed memory record for mining.
 */
function pointToMiningRecord(p: ScrollPoint): {
  id: string;
  text: string;
  vector: number[];
  memoryType: MemoryType;
  domain: Domain;
} | null {
  const text = (p.payload.text as string) || (p.payload.content as string) || "";
  const vector = p.vector;
  if (!text || !vector || !Array.isArray(vector) || vector.length === 0) return null;

  return {
    id: String(p.id),
    text,
    vector: vector as number[],
    memoryType: (p.payload.memory_type as MemoryType) || "semantic",
    domain: (p.payload.domain as Domain) || "general",
  };
}

/**
 * Top-level: run full mining job.
 * Scrolls Qdrant in batches, clusters, mines co-occurrences, synthesizes.
 * Background job -- expected runtime: 30-120 seconds on 13,000 memories.
 */
export async function runPatternMining(
  qdrantUrl: string,
  embedUrl: string,
  graphClient: GraphClient | null,
  agentId: string,
  batchSize = 500,
): Promise<MiningReport> {
  const startTime = Date.now();
  const allRecords: Array<{
    id: string;
    text: string;
    vector: number[];
    memoryType: MemoryType;
    domain: Domain;
  }> = [];

  // Phase 1: Scroll all memories in batches
  let offset: string | number | null = null;

  while (true) {
    const batch = await scrollBatch(qdrantUrl, DEFAULT_COLLECTIONS.SHARED, batchSize, offset);
    if (batch.points.length === 0) break;

    for (const p of batch.points) {
      const rec = pointToMiningRecord(p);
      if (rec) allRecords.push(rec);
    }

    offset = batch.nextOffset;
    if (!offset) break;

    // Safety: don't process more than 20,000 memories
    if (allRecords.length >= 20_000) break;
  }

  if (allRecords.length === 0) {
    return {
      clusters: [],
      coOccurrences: [],
      patterns: [],
      totalMemoriesScanned: 0,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  }

  // Phase 2: Cluster memories in batches of 500 (O(n^2) per batch)
  const allClusters: MemoryCluster[] = [];
  for (let i = 0; i < allRecords.length; i += batchSize) {
    const batch = allRecords.slice(i, i + batchSize);
    const batchClusters = clusterMemories(batch);
    allClusters.push(...batchClusters);
  }

  // Phase 3: Mine co-occurrences from graph (if available)
  let coOccurrences: CoOccurrence[] = [];
  if (graphClient) {
    coOccurrences = await mineCoOccurrences(graphClient);
  }

  // Phase 4: Detect recurring errors
  const recurringErrors = detectRecurringErrors(allRecords);

  // Phase 5: Synthesize all into Pattern objects
  const patterns = synthesizePatterns(allClusters, coOccurrences, recurringErrors);

  // Phase 6: Persist patterns to Qdrant
  if (patterns.length > 0) {
    try {
      await savePatterns(qdrantUrl, embedUrl, agentId, patterns);
    } catch {
      // Non-fatal: mining succeeded even if persistence failed
    }
  }

  return {
    clusters: allClusters,
    coOccurrences,
    patterns,
    totalMemoriesScanned: allRecords.length,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  };
}
