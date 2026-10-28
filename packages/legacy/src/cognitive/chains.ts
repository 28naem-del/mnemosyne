/**
 * Flow of Thought / Reasoning Chains
 *
 * When recalling a memory that has linked_memories, follow links up to depth 2
 * to build reasoning chains: A -> because B -> therefore C
 *
 * This creates a "flow of thought" where related memories form logical chains,
 * giving the LLM richer context about why something is known and what follows from it.
 *
 * No LLM calls -- purely graph traversal over Qdrant linked_memories.
 */

import type { MemCell, MemCellSearchResult } from "../core/types.js";
import { DEFAULT_COLLECTIONS } from "../core/types.js";

export type ChainLink = {
  memory: MemCell;
  relation: string; // "leads_to" | "because" | "therefore" | "related_to"
};

export type ReasoningChain = {
  links: ChainLink[];
  formatted: string; // Human-readable chain
};

/**
 * Fetch a single point from Qdrant by ID, checking both shared and private collections.
 */
async function fetchMemory(
  qdrantUrl: string,
  memoryId: string,
  primaryCollection?: string,
): Promise<MemCell | null> {
  const collections = primaryCollection
    ? [primaryCollection, DEFAULT_COLLECTIONS.SHARED, DEFAULT_COLLECTIONS.PRIVATE]
    : [DEFAULT_COLLECTIONS.SHARED, DEFAULT_COLLECTIONS.PRIVATE];

  // Deduplicate
  const tried = new Set<string>();

  for (const collection of collections) {
    if (tried.has(collection)) continue;
    tried.add(collection);
    try {
      const res = await fetch(`${qdrantUrl}/collections/${collection}/points/${memoryId}`, {
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        result: { id: string; payload: Record<string, unknown> };
      };
      if (!data.result) continue;
      return payloadToMemCell(data.result.id, data.result.payload);
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Convert Qdrant payload to MemCell (lightweight version for chain traversal).
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
 * Infer relation label between two linked memories based on their types.
 */
function inferRelation(from: MemCell, to: MemCell): string {
  // Procedural -> "leads_to" (step follows step)
  if (from.memoryType === "procedural" || to.memoryType === "procedural") return "leads_to";
  // Core/semantic -> "because" (factual grounding)
  if (to.memoryType === "core" || to.memoryType === "semantic") return "because";
  // Episodic -> "therefore" (event leads to conclusion)
  if (from.memoryType === "episodic") return "therefore";
  return "related_to";
}

/**
 * Follow a memory's linked_memories chain up to maxDepth.
 * Returns the chain of memories and their relationships.
 *
 * A -> B -> C means: A links to B, B links to C.
 * We avoid cycles by tracking visited IDs.
 */
export async function followChain(
  qdrantUrl: string,
  memoryId: string,
  maxDepth: number = 2,
  collection?: string,
): Promise<ReasoningChain> {
  const visited = new Set<string>();
  const links: ChainLink[] = [];

  // Fetch the root memory
  const root = await fetchMemory(qdrantUrl, memoryId, collection);
  if (!root) return { links: [], formatted: "" };

  visited.add(root.id);
  links.push({ memory: root, relation: "origin" });

  // BFS traversal, depth-limited
  let frontier: MemCell[] = [root];

  for (let depth = 0; depth < maxDepth; depth++) {
    const nextFrontier: MemCell[] = [];

    for (const current of frontier) {
      if (!current.linkedMemories || current.linkedMemories.length === 0) continue;

      // Follow up to 3 links per node to keep chains manageable
      const linksToFollow = current.linkedMemories.slice(0, 3);

      for (const linkedId of linksToFollow) {
        if (visited.has(linkedId)) continue;
        visited.add(linkedId);

        const linked = await fetchMemory(qdrantUrl, linkedId, collection);
        if (!linked || linked.deleted) continue;

        const relation = inferRelation(current, linked);
        links.push({ memory: linked, relation });
        nextFrontier.push(linked);
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  // Format chain for display
  const formatted = formatChain(links);
  return { links, formatted };
}

/**
 * Format a reasoning chain for human-readable display.
 * "Memory A -> because Memory B -> therefore Memory C"
 */
function formatChain(links: ChainLink[]): string {
  if (links.length <= 1) return "";

  const parts: string[] = [];
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const text = link.memory.text.length > 80
      ? link.memory.text.slice(0, 80) + "..."
      : link.memory.text;

    if (i === 0) {
      parts.push(text);
    } else {
      parts.push(`${link.relation} -> ${text}`);
    }
  }

  return parts.join(" ");
}

/**
 * Enrich recall results with chain context.
 * For each result that has linked_memories, follow the chain and append context.
 */
export async function enrichWithChains(
  qdrantUrl: string,
  results: MemCellSearchResult[],
  maxDepth: number = 2,
): Promise<Array<MemCellSearchResult & { chain?: ReasoningChain }>> {
  const enriched: Array<MemCellSearchResult & { chain?: ReasoningChain }> = [];

  for (const r of results) {
    if (r.entry.linkedMemories && r.entry.linkedMemories.length > 0) {
      const collection = r.entry.classification === "private"
        ? DEFAULT_COLLECTIONS.PRIVATE
        : DEFAULT_COLLECTIONS.SHARED;
      const chain = await followChain(qdrantUrl, r.entry.id, maxDepth, collection);
      enriched.push({ ...r, chain: chain.links.length > 1 ? chain : undefined });
    } else {
      enriched.push(r);
    }
  }

  return enriched;
}

/**
 * Format chain context as an appendable string for memory_recall results.
 */
export function formatChainContext(
  chains: Array<{ memoryId: string; chain: ReasoningChain }>,
): string {
  if (chains.length === 0) return "";

  const lines = ["\n--- Reasoning Chains ---"];
  for (const { chain } of chains) {
    if (chain.formatted) {
      lines.push(chain.formatted);
    }
  }
  return lines.join("\n");
}
