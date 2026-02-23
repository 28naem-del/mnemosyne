/**
 * Qdrant vector database client with multi-collection scoped operations.
 *
 * Supports shared, private, profile, and skill collections.
 * All operations use the MemCell type as the atomic unit of memory.
 */

import { randomUUID } from "node:crypto";
import type { MemCell, MemCellSearchResult, Classification } from "./types.js";
import { DEFAULT_COLLECTIONS } from "./types.js";

export class QdrantDB {
  private readonly baseUrl: string;
  private readonly agentId: string;

  constructor(qdrantUrl: string, agentId: string) {
    this.baseUrl = qdrantUrl;
    this.agentId = agentId;
  }

  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Qdrant ${options.method || "GET"} ${path}: ${res.status} ${body}`);
    }
    return res;
  }

  /** Determine which collection to use based on classification. */
  private collectionFor(classification: Classification): string {
    switch (classification) {
      case "private": return DEFAULT_COLLECTIONS.PRIVATE;
      case "public": return DEFAULT_COLLECTIONS.SHARED;
      case "secret": throw new Error("SECRET memories must never be stored in Qdrant");
    }
  }

  /** Store a memory in Qdrant. */
  async store(
    text: string,
    vector: number[],
    cell: Partial<MemCell>,
  ): Promise<MemCell> {
    const id = cell.id || randomUUID();
    const now = new Date().toISOString();
    const classification = cell.classification || "public";
    const collection = this.collectionFor(classification);

    const payload = {
      text,
      agent_id: cell.agentId || this.agentId,
      user_id: cell.userId || null,
      memory_type: cell.memoryType || "semantic",
      scope: cell.scope || (classification === "private" ? "private" : "public"),
      classification,
      urgency: cell.urgency || "reference",
      domain: cell.domain || "knowledge",
      confidence: cell.confidence ?? 0.7,
      confidence_tag: cell.confidenceTag || "grounded",
      priority_score: cell.priorityScore ?? 0.5,
      importance: cell.importance ?? 0.7,
      linked_memories: cell.linkedMemories || [],
      access_times: cell.accessTimes || [Date.now()],
      access_count: cell.accessCount || 0,
      event_time: cell.eventTime || now,
      ingested_at: cell.ingestedAt || now,
      created_at: cell.createdAt || now,
      updated_at: now,
      deleted: false,
      metadata: cell.metadata || {},
    };

    await this.request(`/collections/${collection}/points`, {
      method: "PUT",
      body: JSON.stringify({ wait: true, points: [{ id, vector, payload }] }),
    });

    return {
      id,
      text,
      memoryType: payload.memory_type as MemCell["memoryType"],
      classification: payload.classification as Classification,
      agentId: payload.agent_id,
      userId: payload.user_id || undefined,
      scope: payload.scope as MemCell["scope"],
      urgency: payload.urgency as MemCell["urgency"],
      domain: payload.domain as MemCell["domain"],
      confidence: payload.confidence,
      confidenceTag: payload.confidence_tag as MemCell["confidenceTag"],
      priorityScore: payload.priority_score,
      importance: payload.importance,
      linkedMemories: payload.linked_memories,
      accessTimes: payload.access_times,
      accessCount: payload.access_count,
      eventTime: payload.event_time,
      ingestedAt: payload.ingested_at,
      createdAt: payload.created_at,
      updatedAt: payload.updated_at,
      deleted: false,
      metadata: payload.metadata,
    };
  }

  /** Search a specific collection for similar memories. */
  async search(
    collection: string,
    vector: number[],
    limit = 5,
    minScore = 0.3,
    filters?: Record<string, unknown>,
  ): Promise<MemCellSearchResult[]> {
    const must: unknown[] = [{ key: "deleted", match: { value: false } }];

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        must.push({ key, match: { value } });
      }
    }

    if (collection === DEFAULT_COLLECTIONS.PRIVATE && !filters?.agent_id) {
      must.push({ key: "agent_id", match: { value: this.agentId } });
    }

    const res = await this.request(`/collections/${collection}/points/search`, {
      method: "POST",
      body: JSON.stringify({
        vector,
        limit,
        filter: { must },
        with_payload: true,
      }),
    });

    const data = (await res.json()) as {
      result: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
    };

    return data.result
      .filter((r) => r.score >= minScore)
      .map((r) => ({
        entry: this.payloadToMemCell(r.id, r.payload),
        score: r.score,
        source: "qdrant" as const,
      }));
  }

  /** Search across both shared and private collections. */
  async searchAll(
    vector: number[],
    limit = 5,
    minScore = 0.3,
  ): Promise<MemCellSearchResult[]> {
    const [shared, priv] = await Promise.all([
      this.search(DEFAULT_COLLECTIONS.SHARED, vector, limit, minScore),
      this.search(DEFAULT_COLLECTIONS.PRIVATE, vector, limit, minScore),
    ]);

    return [...shared, ...priv]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Soft-delete a point by setting deleted=true. */
  async softDelete(collection: string, id: string): Promise<void> {
    await this.request(`/collections/${collection}/points/payload`, {
      method: "POST",
      body: JSON.stringify({
        wait: true,
        points: [id],
        payload: { deleted: true, updated_at: new Date().toISOString() },
      }),
    });
  }

  /** Record a new access timestamp and increment the access counter. */
  async updateAccessTime(collection: string, id: string): Promise<void> {
    try {
      const res = await this.request(`/collections/${collection}/points/${id}`);
      const data = (await res.json()) as { result: { payload: Record<string, unknown> } };
      const times = (data.result.payload.access_times as number[]) || [];
      times.push(Date.now());
      const count = ((data.result.payload.access_count as number) || 0) + 1;

      await this.request(`/collections/${collection}/points/payload`, {
        method: "POST",
        body: JSON.stringify({
          wait: true,
          points: [id],
          payload: { access_times: times, access_count: count },
        }),
      });
    } catch {
      // Non-fatal
    }
  }

  /** Return the total number of points in a collection. */
  async count(collection: string): Promise<number> {
    const res = await this.request(`/collections/${collection}`);
    const data = (await res.json()) as { result: { points_count: number } };
    return data.result.points_count;
  }

  /** Retrieve a single point by ID, or null if not found. */
  async getPoint(collection: string, id: string): Promise<MemCell | null> {
    try {
      const res = await this.request(`/collections/${collection}/points/${id}`);
      const data = (await res.json()) as { result: { id: string; payload: Record<string, unknown> } };
      return this.payloadToMemCell(data.result.id, data.result.payload);
    } catch {
      return null;
    }
  }

  /** Convert a Qdrant payload to a typed MemCell with safe defaults. */
  private payloadToMemCell(id: string, p: Record<string, unknown>): MemCell {
    return {
      id,
      text: (p.text as string) || (p.content as string) || "",
      memoryType: (p.memory_type as MemCell["memoryType"]) || "semantic",
      classification: (p.classification as Classification) || "public",
      agentId: (p.agent_id as string) || this.agentId,
      userId: (p.user_id as string) || undefined,
      scope: (p.scope as MemCell["scope"]) || "public",
      urgency: (p.urgency as MemCell["urgency"]) || "reference",
      domain: (p.domain as MemCell["domain"]) || "general",
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
}
