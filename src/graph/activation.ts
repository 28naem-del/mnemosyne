/**
 * Spreading Activation -- graph-based memory retrieval boost.
 *
 * When a user asks about an entity, activation spreads through the knowledge graph:
 *   Entity (1.0) -> Related_A (0.5) -> Related_B (0.25)
 *
 * This surfaces memories linked to related entities, weighted by graph distance.
 * Zero LLM calls. Performance target: <100ms for 3-hop traversal.
 */

import type { FalkorDBClient } from "./falkordb.js";

// ---- Types ------------------------------------------------------------------

/** A node activated during spread */
export interface ActivatedNode {
  entity: string;
  activation: number;  // 0.0 - 1.0, decays with distance
  depth: number;
  path: string[];      // entity chain from source
}

/** Memory retrieved via graph activation */
export interface GraphMemory {
  memoryId: string;
  text: string;
  activationScore: number;
  sourceEntity: string;
  depth: number;
}

/** Configuration for spreading activation */
export interface SpreadConfig {
  maxDepth: number;      // default 2
  decayFactor: number;   // default 0.5 (halve activation per hop)
  minActivation: number; // default 0.1 (stop spreading below this)
  maxNodes: number;      // default 30 (cap total activated nodes)
  fanOut: number;        // default 10 (max neighbors per node)
}

const DEFAULT_CONFIG: SpreadConfig = {
  maxDepth: 2,
  decayFactor: 0.5,
  minActivation: 0.1,
  maxNodes: 30,
  fanOut: 10,
};

// ---- Entity Extraction ------------------------------------------------------

/**
 * Extract seed entities from query text.
 * Uses regex patterns for IP addresses, technology names, and ports.
 */
export function extractSeedEntities(query: string): string[] {
  const entities: string[] = [];

  // IP addresses
  const ips = query.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g);
  if (ips) entities.push(...ips);

  // Technology names (common infrastructure and ML tools)
  const tech = query.match(
    /\b(Qdrant|Redis|MongoDB|FalkorDB|Docker|vLLM|llama\.?cpp|MLX|Tailscale|Nomic|Postgres|MySQL|Kafka|RabbitMQ|Elasticsearch|Nginx|Kubernetes|Prometheus|Grafana)\b/gi
  );
  if (tech) entities.push(...tech);

  // Port references
  const ports = query.match(/(?:port\s+|:)(\d{4,5})\b/g);
  if (ports) entities.push(...ports.map(p => `port_${p.replace(/\D/g, "")}`));

  return [...new Set(entities)];
}

// ---- Spreading Activation ---------------------------------------------------

/**
 * Spread activation from seed entities through the knowledge graph.
 * BFS with exponential decay. Returns activated nodes sorted by activation.
 *
 * Algorithm:
 *   1. Initialize seed entities with activation = 1.0
 *   2. BFS: for each node, query the graph for neighbors
 *   3. Neighbor activation = parent.activation * decayFactor
 *   4. If neighbor already activated, keep max(existing, new)
 *   5. Stop when depth > maxDepth or activation < minActivation
 *   6. Return all activated nodes sorted by activation descending
 */
export async function spreadActivation(
  falkordb: FalkorDBClient,
  seeds: string[],
  config?: Partial<SpreadConfig>,
): Promise<ActivatedNode[]> {
  if (seeds.length === 0) return [];

  const cfg: SpreadConfig = { ...DEFAULT_CONFIG, ...config };
  const activated = new Map<string, ActivatedNode>();
  const queue: string[] = [];

  // Initialize seeds at activation = 1.0
  for (const entity of seeds) {
    activated.set(entity, { entity, activation: 1.0, depth: 0, path: [entity] });
    queue.push(entity);
  }

  // BFS with decay
  while (queue.length > 0 && activated.size < cfg.maxNodes) {
    const current = queue.shift()!;
    const currentNode = activated.get(current)!;

    if (currentNode.depth >= cfg.maxDepth) continue;

    // Query graph for 1-hop neighbors
    const neighbors = await getNeighbors(falkordb, current, cfg.fanOut);

    for (const neighbor of neighbors) {
      if (activated.size >= cfg.maxNodes) break;

      const newActivation = currentNode.activation * cfg.decayFactor;
      if (newActivation < cfg.minActivation) continue;

      const existing = activated.get(neighbor);
      if (existing) {
        // Already visited -- keep max activation, don't re-queue
        if (newActivation > existing.activation) {
          existing.activation = newActivation;
        }
      } else {
        activated.set(neighbor, {
          entity: neighbor,
          activation: newActivation,
          depth: currentNode.depth + 1,
          path: [...currentNode.path, neighbor],
        });
        queue.push(neighbor);
      }
    }
  }

  // Sort by activation descending
  return [...activated.values()].sort((a, b) => b.activation - a.activation);
}

// ---- Memory Collection ------------------------------------------------------

/**
 * Given activated entities, find memories that mention them.
 * Queries the graph for MENTIONS relationships from memories to entities.
 * Memory's activation = max activation among its mentioned entities.
 */
export async function collectActivatedMemories(
  falkordb: FalkorDBClient,
  activatedNodes: ActivatedNode[],
  limit: number,
): Promise<GraphMemory[]> {
  if (activatedNodes.length === 0) return [];

  const memoryScores = new Map<string, GraphMemory>();

  for (const node of activatedNodes) {
    const memories = await queryMemoriesForEntity(falkordb, node.entity);

    for (const mem of memories) {
      const existing = memoryScores.get(mem.memoryId);
      if (!existing || node.activation > existing.activationScore) {
        memoryScores.set(mem.memoryId, {
          memoryId: mem.memoryId,
          text: mem.text,
          activationScore: node.activation,
          sourceEntity: node.entity,
          depth: node.depth,
        });
      }
    }
  }

  return [...memoryScores.values()]
    .sort((a, b) => b.activationScore - a.activationScore)
    .slice(0, limit);
}

// ---- Top-Level Pipeline -----------------------------------------------------

/**
 * Top-level: run full spreading activation pipeline.
 * extract seeds -> spread -> collect memories -> return sorted.
 */
export async function activationSearch(
  falkordb: FalkorDBClient,
  query: string,
  limit = 10,
  config?: Partial<SpreadConfig>,
): Promise<GraphMemory[]> {
  const seeds = extractSeedEntities(query);
  if (seeds.length === 0) return [];

  const activatedNodes = await spreadActivation(falkordb, seeds, config);
  return collectActivatedMemories(falkordb, activatedNodes, limit);
}

// ---- Internal Helpers -------------------------------------------------------

/**
 * Query the graph for 1-hop neighbors of an entity.
 * Returns entity names only (strings).
 */
async function getNeighbors(
  falkordb: FalkorDBClient,
  entityName: string,
  maxNeighbors: number,
): Promise<string[]> {
  try {
    const result = await falkordb.query(
      `MATCH (e:Entity {name: '${escape(entityName)}'})-[r]-(neighbor:Entity)
       WHERE neighbor.type <> 'Memory'
       RETURN neighbor.name
       LIMIT ${maxNeighbors}`
    );

    // FalkorDB returns [[header], [[row1], [row2], ...], [stats]]
    if (!Array.isArray(result) || result.length < 2) return [];
    const rows = result[1];
    if (!Array.isArray(rows)) return [];

    const names: string[] = [];
    for (const row of rows) {
      if (Array.isArray(row) && typeof row[0] === "string") {
        names.push(row[0]);
      }
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * Query the graph for memories that MENTION an entity.
 * Returns {memoryId, text} pairs.
 */
async function queryMemoriesForEntity(
  falkordb: FalkorDBClient,
  entityName: string,
): Promise<Array<{ memoryId: string; text: string }>> {
  try {
    const result = await falkordb.query(
      `MATCH (m:Entity {type: 'Memory'})-[:MENTIONS]->(e:Entity {name: '${escape(entityName)}'})
       RETURN m.name, m.text
       LIMIT 20`
    );

    if (!Array.isArray(result) || result.length < 2) return [];
    const rows = result[1];
    if (!Array.isArray(rows)) return [];

    const memories: Array<{ memoryId: string; text: string }> = [];
    for (const row of rows) {
      if (Array.isArray(row) && typeof row[0] === "string") {
        memories.push({
          memoryId: row[0],
          text: typeof row[1] === "string" ? row[1] : "",
        });
      }
    }
    return memories;
  } catch {
    return [];
  }
}

function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
