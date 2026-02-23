/**
 * Temporal Sequences -- detect "after A happens, B usually follows within N hours".
 *
 * Mines Qdrant episodic memories for temporal co-occurrence of entities.
 * PrefixSpan-inspired sequential pattern mining, zero external deps, zero LLM calls.
 *
 * Algorithm:
 *   1. Extract temporal events (episodic memories with eventTime, sorted chronologically)
 *   2. Build temporal pairs: events within maxWindow sharing entities
 *   3. Group similar pairs into sequences using trigram similarity
 *   4. Score by frequency -> TemporalSequence objects with confidence
 *   5. Persist to Qdrant private collection scope="temporal_sequence"
 *   6. Predict: given current event, find matching antecedent -> predict consequent
 *
 * Background job -- NOT in search hot path.
 */

import { createHash } from "node:crypto";
import { COLLECTIONS as DEFAULT_COLLECTIONS } from "../core/types.js";
import type { FalkorDBClient } from "./falkordb.js";

// ============================================================================
// Types
// ============================================================================

/** A detected temporal sequence */
export interface TemporalSequence {
  id: string;
  antecedent: string;       // event A (e.g., "deploy to production")
  consequent: string;       // event B (e.g., "rollback")
  avgDelayMs: number;       // average time between A and B
  medianDelayMs: number;
  occurrences: number;      // how many times observed
  confidence: number;       // occurrences / total_A_occurrences
  examples: Array<{
    antecedentId: string;
    consequentId: string;
    delayMs: number;
    timestamp: string;
  }>;
  firstSeen: string;
  lastSeen: string;
}

/** A pair of temporally-adjacent events */
export interface EventPair {
  eventA: TemporalEvent;
  eventB: TemporalEvent;
  delayMs: number;
}

/** A temporal event extracted from memory */
export interface TemporalEvent {
  id: string;
  text: string;
  timestamp: number;
  entities: string[];
}

/** Prediction result */
export interface SequencePrediction {
  sequence: TemporalSequence;
  matchScore: number;
  predictedDelay: string;   // human readable: "within 2 hours"
}

// ============================================================================
// Trigram Similarity
// ============================================================================

/** Extract character trigrams from text */
function trigrams(text: string): Set<string> {
  const s = text.toLowerCase().trim();
  const tris = new Set<string>();
  for (let i = 0; i <= s.length - 3; i++) {
    tris.add(s.slice(i, i + 3));
  }
  return tris;
}

/** Jaccard similarity on trigram sets */
export function trigramSimilarity(a: string, b: string): number {
  const triA = trigrams(a);
  const triB = trigrams(b);
  if (triA.size === 0 && triB.size === 0) return 1.0;
  if (triA.size === 0 || triB.size === 0) return 0;

  let intersection = 0;
  for (const t of triA) {
    if (triB.has(t)) intersection++;
  }
  const union = triA.size + triB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ============================================================================
// Entity Extraction (generic patterns)
// ============================================================================

function extractEntities(text: string): string[] {
  const entities: string[] = [];

  // IP addresses
  const ips = text.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g);
  if (ips) entities.push(...ips);

  // Technology names (common infrastructure and ML tools)
  const tech = text.match(
    /\b(Qdrant|Redis|MongoDB|FalkorDB|Docker|vLLM|llama\.?cpp|MLX|Tailscale|Nomic|Postgres|MySQL|Kafka|RabbitMQ|Elasticsearch|Nginx|Kubernetes|Prometheus|Grafana)\b/gi
  );
  if (tech) entities.push(...tech);

  // Port references
  const ports = text.match(/(?:port\s+|:)(\d{4,5})\b/g);
  if (ports) entities.push(...ports.map(p => `port_${p.replace(/\D/g, "")}`));

  // Additional: action verbs that form temporal patterns
  const actions = text.match(
    /\b(deploy|rollback|restart|configure|install|update|upgrade|migrate|backup|restore|fix|build|test|push|merge)\b/gi
  );
  if (actions) entities.push(...actions.map(a => a.toLowerCase()));

  return [...new Set(entities)];
}

// ============================================================================
// Deterministic ID
// ============================================================================

function sequenceId(antecedent: string, consequent: string): string {
  const hex = createHash("sha256").update(`temporal:${antecedent}:${consequent}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ============================================================================
// Stats Helpers
// ============================================================================

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function humanDelay(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 1) return `within ${Math.round(ms / 60000)} minutes`;
  if (hours < 24) return `within ${Math.round(hours)} hours`;
  return `within ${Math.round(hours / 24)} days`;
}

// ============================================================================
// Qdrant Scroll
// ============================================================================

interface ScrollPoint {
  id: string;
  payload: Record<string, unknown>;
}

async function scrollBatch(
  qdrantUrl: string,
  collection: string,
  limit: number,
  offset?: string | number | null,
  filter?: Record<string, unknown>,
): Promise<{ points: ScrollPoint[]; nextOffset: string | number | null }> {
  const body: Record<string, unknown> = {
    limit,
    filter: filter || { must: [{ key: "deleted", match: { value: false } }] },
    with_payload: true,
    with_vector: false,
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
// Embed helper
// ============================================================================

async function embedText(embedUrl: string, text: string): Promise<number[]> {
  const res = await fetch(`${embedUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text }),
  });
  if (!res.ok) throw new Error(`Embed service failed: ${res.status}`);
  const data = (await res.json()) as { embedding?: number[]; data?: Array<{ embedding: number[] }> };
  return data.embedding || data.data?.[0]?.embedding || [];
}

// ============================================================================
// Step 1: Extract Temporal Events
// ============================================================================

/**
 * Extract temporal events from memory collection.
 * Filters to episodic memories with eventTime, sorted chronologically.
 */
export async function extractTemporalEvents(
  qdrantUrl: string,
  collection: string,
  batchSize = 500,
): Promise<TemporalEvent[]> {
  const events: TemporalEvent[] = [];
  let offset: string | number | null = null;

  const filter = {
    must: [
      { key: "deleted", match: { value: false } },
    ],
  };

  while (true) {
    const batch = await scrollBatch(qdrantUrl, collection, batchSize, offset, filter);
    if (batch.points.length === 0) break;

    for (const p of batch.points) {
      const text = (p.payload.text as string) || (p.payload.content as string) || "";
      if (!text) continue;

      // Parse timestamp: prefer event_time, fall back to created_at
      const eventTimeStr = (p.payload.event_time as string) || (p.payload.created_at as string) || "";
      if (!eventTimeStr) continue;

      const timestamp = new Date(eventTimeStr).getTime();
      if (isNaN(timestamp)) continue;

      const entities = extractEntities(text);
      if (entities.length === 0) continue;

      events.push({
        id: String(p.id),
        text: text.slice(0, 300),
        timestamp,
        entities,
      });
    }

    offset = batch.nextOffset;
    if (!offset) break;
    if (events.length >= 20_000) break; // Safety cap
  }

  // Sort chronologically
  events.sort((a, b) => a.timestamp - b.timestamp);
  return events;
}

// ============================================================================
// Step 2: Build Temporal Pairs
// ============================================================================

/**
 * Build temporal pairs: events within maxWindow of each other
 * that share at least one entity (same topic area).
 */
export function buildTemporalPairs(
  events: TemporalEvent[],
  maxWindowMs = 24 * 60 * 60 * 1000, // 24 hours
): EventPair[] {
  const pairs: EventPair[] = [];

  // Events already sorted by timestamp
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const delay = events[j].timestamp - events[i].timestamp;
      if (delay > maxWindowMs) break; // sorted, no more valid pairs
      if (delay < 60_000) continue;    // skip events < 1 minute apart (same batch)

      // Check entity overlap
      const setA = new Set(events[i].entities);
      let hasOverlap = false;
      for (const e of events[j].entities) {
        if (setA.has(e)) { hasOverlap = true; break; }
      }
      if (!hasOverlap) continue;

      pairs.push({
        eventA: events[i],
        eventB: events[j],
        delayMs: delay,
      });
    }
  }

  return pairs;
}

// ============================================================================
// Step 3: Group into Sequences
// ============================================================================

/**
 * Group similar event pairs into sequences.
 * Uses trigram similarity (>threshold) between antecedents and between consequents.
 */
export function groupIntoSequences(
  pairs: EventPair[],
  similarityThreshold = 0.6,
): TemporalSequence[] {
  if (pairs.length === 0) return [];

  // Count total occurrences of each antecedent text (for confidence denominator)
  const antecedentCounts = new Map<string, number>();
  for (const pair of pairs) {
    const key = pair.eventA.text.slice(0, 200);
    antecedentCounts.set(key, (antecedentCounts.get(key) || 0) + 1);
  }

  // Greedy grouping
  const groups: EventPair[][] = [];

  for (const pair of pairs) {
    let matched = false;

    for (const group of groups) {
      const representative = group[0];
      const antSim = trigramSimilarity(pair.eventA.text, representative.eventA.text);
      const conSim = trigramSimilarity(pair.eventB.text, representative.eventB.text);

      if (antSim >= similarityThreshold && conSim >= similarityThreshold) {
        group.push(pair);
        matched = true;
        break;
      }
    }

    if (!matched) {
      groups.push([pair]);
    }
  }

  // Convert groups to TemporalSequence objects (need at least 2 occurrences)
  const sequences: TemporalSequence[] = [];

  for (const group of groups) {
    if (group.length < 2) continue;

    const delays = group.map(p => p.delayMs);
    const antecedent = group[0].eventA.text.slice(0, 200);
    const consequent = group[0].eventB.text.slice(0, 200);

    // Confidence: group size / total times we saw this antecedent pattern
    // Use the max antecedent count for any member as denominator
    let maxAntCount = 0;
    for (const pair of group) {
      const key = pair.eventA.text.slice(0, 200);
      const cnt = antecedentCounts.get(key) || 1;
      if (cnt > maxAntCount) maxAntCount = cnt;
    }
    const confidence = maxAntCount > 0 ? group.length / maxAntCount : 0;

    if (confidence < 0.3) continue; // Filter low-confidence sequences

    const timestamps = group.map(p => new Date(p.eventA.timestamp).toISOString()).sort();

    sequences.push({
      id: sequenceId(antecedent, consequent),
      antecedent,
      consequent,
      avgDelayMs: mean(delays),
      medianDelayMs: median(delays),
      occurrences: group.length,
      confidence: Math.min(confidence, 1.0),
      examples: group.slice(0, 5).map(p => ({
        antecedentId: p.eventA.id,
        consequentId: p.eventB.id,
        delayMs: p.delayMs,
        timestamp: new Date(p.eventA.timestamp).toISOString(),
      })),
      firstSeen: timestamps[0],
      lastSeen: timestamps[timestamps.length - 1],
    });
  }

  return sequences.sort((a, b) => b.confidence - a.confidence);
}

// ============================================================================
// Step 4: Persist Sequences
// ============================================================================

/**
 * Persist sequences to Qdrant.
 * Stored in private collection with scope="temporal_sequence".
 */
export async function saveSequences(
  qdrantUrl: string,
  embedUrl: string,
  agentId: string,
  sequences: TemporalSequence[],
): Promise<number> {
  let saved = 0;

  for (const seq of sequences) {
    try {
      const descText = `Temporal sequence: after "${seq.antecedent}" then "${seq.consequent}" ${humanDelay(seq.avgDelayMs)} (${seq.occurrences}x, ${(seq.confidence * 100).toFixed(0)}% confidence)`;
      const vector = await embedText(embedUrl, descText);
      if (vector.length === 0) continue;

      const res = await fetch(
        `${qdrantUrl}/collections/${DEFAULT_COLLECTIONS.PRIVATE}/points`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wait: true,
            points: [{
              id: seq.id,
              vector,
              payload: {
                text: descText,
                agent_id: agentId,
                memory_type: "semantic",
                scope: "temporal_sequence",
                classification: "private",
                category: "other",
                urgency: "reference",
                domain: "knowledge",
                confidence: seq.confidence,
                confidence_tag: "inferred",
                priority_score: 0.6,
                importance: seq.confidence,
                linked_memories: seq.examples.map(e => e.antecedentId).slice(0, 10),
                access_times: [Date.now()],
                access_count: 0,
                event_time: seq.firstSeen,
                ingested_at: new Date().toISOString(),
                created_at: seq.firstSeen,
                updated_at: new Date().toISOString(),
                deleted: false,
                metadata: {
                  source: "temporal_mining",
                  sequence_id: seq.id,
                  antecedent: seq.antecedent,
                  consequent: seq.consequent,
                  avg_delay_ms: seq.avgDelayMs,
                  median_delay_ms: seq.medianDelayMs,
                  occurrences: seq.occurrences,
                  examples: seq.examples,
                  first_seen: seq.firstSeen,
                  last_seen: seq.lastSeen,
                },
              },
            }],
          }),
        },
      );

      if (res.ok) saved++;
    } catch {
      // Non-fatal: skip individual save failures
    }
  }

  return saved;
}

// ============================================================================
// Step 5: Load Sequences
// ============================================================================

/**
 * Load previously-detected sequences.
 */
export async function loadSequences(
  qdrantUrl: string,
  agentId: string,
): Promise<TemporalSequence[]> {
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
              { key: "scope", match: { value: "temporal_sequence" } },
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
        antecedent: (meta.antecedent as string) || "",
        consequent: (meta.consequent as string) || "",
        avgDelayMs: (meta.avg_delay_ms as number) || 0,
        medianDelayMs: (meta.median_delay_ms as number) || 0,
        occurrences: (meta.occurrences as number) || 1,
        confidence: (p.payload.confidence as number) ?? 0.5,
        examples: (meta.examples as TemporalSequence["examples"]) || [],
        firstSeen: (meta.first_seen as string) || "",
        lastSeen: (meta.last_seen as string) || "",
      };
    });
  } catch {
    return [];
  }
}

// ============================================================================
// Step 6: Predict Consequent
// ============================================================================

/**
 * Given a current event, find sequences where it matches the antecedent.
 * Returns predictions: "B is likely to follow within N hours".
 */
export async function predictConsequent(
  qdrantUrl: string,
  embedUrl: string,
  agentId: string,
  currentEvent: string,
  minConfidence = 0.5,
): Promise<SequencePrediction[]> {
  const sequences = await loadSequences(qdrantUrl, agentId);
  if (sequences.length === 0) return [];

  const predictions: SequencePrediction[] = [];

  for (const seq of sequences) {
    if (seq.confidence < minConfidence) continue;

    const matchScore = trigramSimilarity(currentEvent, seq.antecedent);
    if (matchScore < 0.4) continue;

    predictions.push({
      sequence: seq,
      matchScore,
      predictedDelay: humanDelay(seq.medianDelayMs),
    });
  }

  return predictions.sort((a, b) => b.matchScore * b.sequence.confidence - a.matchScore * a.sequence.confidence);
}

// ============================================================================
// Graph Temporal Edge Mining (optional enrichment)
// ============================================================================

/**
 * Mine knowledge graph for temporal co-occurrence:
 * Entities that appear in memories close in time (via PRECEDES/FOLLOWS edges).
 */
async function mineGraphTemporalPairs(
  falkordb: FalkorDBClient,
): Promise<EventPair[]> {
  try {
    // Query memories with event_time, sorted, that share entities
    const results = await falkordb.query(
      `MATCH (m1:Entity {type: 'Memory'})-[:MENTIONS]->(e:Entity)<-[:MENTIONS]-(m2:Entity {type: 'Memory'})
       WHERE m1.event_time IS NOT NULL AND m2.event_time IS NOT NULL
         AND m1.event_time < m2.event_time
         AND m1.name <> m2.name
       WITH m1, m2, collect(e.name) AS shared_entities
       WHERE size(shared_entities) > 0
       RETURN m1.name, m1.text, m1.event_time, m2.name, m2.text, m2.event_time, shared_entities
       ORDER BY m1.event_time
       LIMIT 500`
    );

    const pairs: EventPair[] = [];
    if (!Array.isArray(results) || results.length < 2) return pairs;

    const rows = Array.isArray(results[1]) ? results[1] : [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 7) continue;

      const tsA = new Date(String(row[2])).getTime();
      const tsB = new Date(String(row[5])).getTime();
      if (isNaN(tsA) || isNaN(tsB)) continue;

      const delay = tsB - tsA;
      if (delay < 60_000 || delay > 24 * 60 * 60 * 1000) continue;

      pairs.push({
        eventA: {
          id: String(row[0]),
          text: String(row[1] || ""),
          timestamp: tsA,
          entities: Array.isArray(row[6]) ? row[6].map(String) : [],
        },
        eventB: {
          id: String(row[3]),
          text: String(row[4] || ""),
          timestamp: tsB,
          entities: Array.isArray(row[6]) ? row[6].map(String) : [],
        },
        delayMs: delay,
      });
    }

    return pairs;
  } catch {
    return [];
  }
}

/**
 * Store discovered PRECEDES edges back to the knowledge graph.
 */
async function storeTemporalEdges(
  falkordb: FalkorDBClient,
  sequences: TemporalSequence[],
): Promise<void> {
  for (const seq of sequences.slice(0, 20)) {
    try {
      // Extract primary entities from antecedent and consequent
      const antEntities = extractEntities(seq.antecedent);
      const conEntities = extractEntities(seq.consequent);
      if (antEntities.length === 0 || conEntities.length === 0) continue;

      // Add PRECEDES edge between the primary entities
      await falkordb.addRelationship(
        antEntities[0],
        conEntities[0],
        "PRECEDES",
        {
          confidence: seq.confidence,
          window_hours: Math.round(seq.avgDelayMs / (60 * 60 * 1000)),
          occurrences: seq.occurrences,
        },
      );
    } catch {
      // Non-fatal
    }
  }
}

// ============================================================================
// Top-Level Mining Job
// ============================================================================

/**
 * Run full temporal sequence mining.
 * Background job -- can take seconds to minutes depending on corpus size.
 */
export async function runTemporalMining(
  qdrantUrl: string,
  embedUrl: string,
  falkordb: FalkorDBClient | null,
  agentId: string,
): Promise<{ sequences: TemporalSequence[]; totalEvents: number; durationMs: number }> {
  const startTime = Date.now();

  // Phase 1: Extract temporal events from Qdrant
  const events = await extractTemporalEvents(qdrantUrl, DEFAULT_COLLECTIONS.SHARED);

  if (events.length < 4) {
    return { sequences: [], totalEvents: events.length, durationMs: Date.now() - startTime };
  }

  // Phase 2: Build temporal pairs from Qdrant events
  let pairs = buildTemporalPairs(events);

  // Phase 3: Enrich with knowledge graph pairs (if available)
  if (falkordb) {
    try {
      const graphPairs = await mineGraphTemporalPairs(falkordb);
      pairs = [...pairs, ...graphPairs];
    } catch {
      // Graph may not be available -- continue with Qdrant pairs only
    }
  }

  if (pairs.length === 0) {
    return { sequences: [], totalEvents: events.length, durationMs: Date.now() - startTime };
  }

  // Phase 4: Group into sequences
  const sequences = groupIntoSequences(pairs);

  // Phase 5: Persist to Qdrant
  if (sequences.length > 0) {
    try {
      await saveSequences(qdrantUrl, embedUrl, agentId, sequences);
    } catch {
      // Non-fatal
    }
  }

  // Phase 6: Store PRECEDES edges in knowledge graph (if available)
  if (falkordb && sequences.length > 0) {
    try {
      await storeTemporalEdges(falkordb, sequences);
    } catch {
      // Non-fatal
    }
  }

  return {
    sequences,
    totalEvents: events.length,
    durationMs: Date.now() - startTime,
  };
}
