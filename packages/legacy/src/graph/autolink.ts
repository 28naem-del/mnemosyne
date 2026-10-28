/**
 * A-MEM Zettelkasten auto-linking.
 * On every new memory, find top-5 similar existing memories
 * and create bidirectional links (similarity > threshold).
 */

import { qdrantRequest, type HttpOptions } from "../core/http.js";

export type AutoLinkResult = {
  linkedIds: string[];
  scores: number[];
};

export interface AutoLinkOptions extends HttpOptions {
  agentId?: string;
}

export async function findAutoLinks(
  qdrantUrl: string,
  collection: string,
  vector: number[],
  excludeId: string,
  threshold: number,
  limit = 5,
  options: AutoLinkOptions = {},
): Promise<AutoLinkResult> {
  const res = await qdrantRequest(qdrantUrl, `/collections/${encodeURIComponent(collection)}/points/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vector,
      limit: limit + 1, // +1 to account for self
      filter: {
        must: [
          { key: "deleted", match: { value: false } },
          ...(options.agentId ? [{ key: "agent_id", match: { value: options.agentId } }] : []),
        ],
        must_not: [{ has_id: [excludeId] }],
      },
      with_payload: true,
    }),
  }, options);

  if (!res.ok) return { linkedIds: [], scores: [] };

  const data = (await res.json()) as {
    result: Array<{ id: string; score: number }>;
  };

  const links = data.result
    .filter((r) => r.score >= threshold && r.id !== excludeId)
    .slice(0, limit);

  return {
    linkedIds: links.map((r) => r.id),
    scores: links.map((r) => r.score),
  };
}

// Update linked_memories arrays bidirectionally in Qdrant
export async function createBidirectionalLinks(
  qdrantUrl: string,
  collection: string,
  newId: string,
  linkedIds: string[],
  options: HttpOptions = {},
): Promise<void> {
  if (linkedIds.length === 0) return;

  // Add links to the new memory
  await qdrantRequest(qdrantUrl, `/collections/${encodeURIComponent(collection)}/points/payload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wait: true,
      points: [newId],
      payload: { linked_memories: linkedIds, updated_at: new Date().toISOString() },
    }),
  }, options);

  // Add back-links to each existing memory (append to their linked_memories)
  // Note: Qdrant doesn't support array append, so we read-then-write each
  for (const linkedId of linkedIds) {
    try {
      const getRes = await qdrantRequest(qdrantUrl,
        `/collections/${encodeURIComponent(collection)}/points/${encodeURIComponent(linkedId)}`, {}, options);
      if (!getRes.ok) continue;
      const getData = (await getRes.json()) as {
        result: { payload: { linked_memories?: string[] } };
      };
      const existing = getData.result.payload.linked_memories || [];
      if (!existing.includes(newId)) {
        existing.push(newId);
        await qdrantRequest(qdrantUrl, `/collections/${encodeURIComponent(collection)}/points/payload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            wait: true,
            points: [linkedId],
            payload: { linked_memories: existing },
          }),
        }, options);
      }
    } catch {
      // Non-fatal: back-link failure shouldn't block storage
    }
  }
}
