/**
 * Qdrant vector database client with multi-collection scoped operations.
 *
 * Supports shared, private, profile, and skill collections.
 * All operations use the MemCell type as the atomic unit of memory.
 */

import { randomUUID } from "node:crypto";
import type { MemCell, MemCellSearchResult, Classification } from "./types.js";
import { DEFAULT_COLLECTIONS } from "./types.js";
import { qdrantRequest, QdrantHttpError, type HttpOptions } from "./http.js";

export class QdrantDB {
  private readonly baseUrl: string;
  private readonly agentId: string;
  readonly collections: Readonly<{
    shared: string;
    private: string;
    profiles: string;
    skills: string;
  }>;

  constructor(qdrantUrl: string, agentId: string, collections?: {
    shared?: string;
    private?: string;
    profiles?: string;
    skills?: string;
  }, private readonly httpOptions: HttpOptions = {}) {
    this.baseUrl = qdrantUrl;
    this.agentId = agentId;
    this.collections = Object.freeze({
      shared: collections?.shared ?? DEFAULT_COLLECTIONS.SHARED,
      private: collections?.private ?? DEFAULT_COLLECTIONS.PRIVATE,
      profiles: collections?.profiles ?? DEFAULT_COLLECTIONS.PROFILES,
      skills: collections?.skills ?? DEFAULT_COLLECTIONS.SKILLS,
    });
  }

  /** Create a collection if it doesn't already exist. */
  async ensureCollection(name: string, vectorSize: number = 768): Promise<void> {
    if (!Number.isSafeInteger(vectorSize) || vectorSize <= 0) throw new Error("vectorSize must be a positive integer");
    const path = `/collections/${encodeURIComponent(name)}`;
    const res = await qdrantRequest(this.baseUrl, path, {}, this.httpOptions, [404]);
    if (res.status === 404) {
      await this.request(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vectors: { size: vectorSize, distance: "Cosine" } }),
      });
      return;
    }
    const data = await res.json() as { result?: { config?: { params?: { vectors?: { size?: number; distance?: string } } } } };
    const vectors = data.result?.config?.params?.vectors;
    if (!vectors || vectors.size !== vectorSize || vectors.distance !== "Cosine") {
      throw new Error(`Collection ${name} must use an unnamed Cosine vector with ${vectorSize} dimensions; use a separate collection or migrate existing data`);
    }
  }

  async request(path: string, options: RequestInit = {}): Promise<Response> {
    return qdrantRequest(this.baseUrl, path, options, this.httpOptions);
  }

  /** Determine which collection to use based on classification. */
  private collectionFor(classification: Classification): string {
    switch (classification) {
      case "private": return this.collections.private;
      case "public": return this.collections.shared;
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
      category: cell.category,
    };

    await this.request(`/collections/${encodeURIComponent(collection)}/points`, {
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
      category: payload.category,
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

    if (collection === this.collections.private) {
      must.push({ key: "agent_id", match: { value: this.agentId } });
    }

    const res = await this.request(`/collections/${encodeURIComponent(collection)}/points/search`, {
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
    filters?: Record<string, unknown>,
  ): Promise<MemCellSearchResult[]> {
    const [shared, priv] = await Promise.all([
      this.search(this.collections.shared, vector, limit, minScore, filters),
      this.search(this.collections.private, vector, limit, minScore, filters),
    ]);

    return [...shared, ...priv]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Hydrate keyword-only candidates with the same scope and deletion filters as vector search. */
  async getSearchCandidates(ids: string[], filters?: Record<string, unknown>): Promise<MemCell[]> {
    if (ids.length === 0) return [];
    const pages = await Promise.all([this.collections.shared, this.collections.private].map(async collection => {
      const must: unknown[] = [
        { has_id: ids },
        { key: "deleted", match: { value: false } },
        ...Object.entries(filters ?? {}).map(([key, value]) => ({ key, match: { value } })),
      ];
      if (collection === this.collections.private) must.push({ key: "agent_id", match: { value: this.agentId } });
      const response = await this.request(`/collections/${encodeURIComponent(collection)}/points/scroll`, {
        method: "POST",
        body: JSON.stringify({ limit: ids.length, filter: { must }, with_payload: true, with_vector: false }),
      });
      const data = await response.json() as { result: { points: Array<{ id: string; payload: Record<string, unknown> }> } };
      return data.result.points.map(point => this.payloadToMemCell(String(point.id), point.payload));
    }));
    return pages.flat();
  }

  async updatePayload(collection: string, id: string, payload: Record<string, unknown>): Promise<void> {
    await this.request(`/collections/${encodeURIComponent(collection)}/points/payload?wait=true`, {
      method: "POST",
      body: JSON.stringify({ wait: true, points: [id], payload }),
    });
  }

  /** Delete the point from the current live collection, not historical backups. */
  async deletePoint(collection: string, id: string): Promise<void> {
    await this.request(`/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
      method: "POST",
      body: JSON.stringify({ points: [id] }),
    });
  }

  /** Resolve only live memories readable by this configured agent. */
  async getScopedPoint(id: string, collection?: string, options: { includeDeleted?: boolean } = {}): Promise<{ collection: string; cell: MemCell } | null> {
    const allowed = [this.collections.shared, this.collections.private];
    if (collection !== undefined && !allowed.includes(collection)) {
      throw new Error("Collection is outside this memory instance's configured scope");
    }
    const found: Array<{ collection: string; cell: MemCell }> = [];
    for (const name of collection === undefined ? [...new Set(allowed)] : [collection]) {
      const cell = await this.getPoint(name, id);
      if (!cell || (cell.deleted && !options.includeDeleted) || cell.classification === "secret") continue;
      if ((name === this.collections.private || cell.classification === "private") && cell.agentId !== this.agentId) continue;
      found.push({ collection: name, cell });
    }
    if (found.length > 1) throw new Error("Memory ID is ambiguous across collections; specify its configured collection");
    return found[0] ?? null;
  }

  async deleteScopedPoint(id: string, collection?: string): Promise<boolean> {
    const scoped = await this.getScopedPoint(id, collection, { includeDeleted: true });
    if (!scoped) return false;
    await this.deletePoint(scoped.collection, id);
    return true;
  }

  async scanCollection(collection: string, limit: number): Promise<{ memories: MemCell[]; truncated: boolean }> {
    const must: unknown[] = [{ key: "deleted", match: { value: false } }];
    if (collection === this.collections.private) must.push({ key: "agent_id", match: { value: this.agentId } });
    const response = await this.request(`/collections/${encodeURIComponent(collection)}/points/scroll`, {
      method: "POST",
      body: JSON.stringify({ limit, filter: { must }, with_payload: true, with_vector: false }),
    });
    const data = await response.json() as { result: { points: Array<{ id: string; payload: Record<string, unknown> }>; next_page_offset?: string | number | null } };
    return {
      memories: data.result.points.map(point => this.payloadToMemCell(String(point.id), point.payload)),
      truncated: data.result.next_page_offset !== undefined && data.result.next_page_offset !== null,
    };
  }

  /** Soft-delete a point by setting deleted=true. */
  async softDelete(collection: string, id: string): Promise<void> {
    await this.request(`/collections/${encodeURIComponent(collection)}/points/payload`, {
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
      const res = await this.request(`/collections/${encodeURIComponent(collection)}/points/${encodeURIComponent(id)}`);
      const data = (await res.json()) as { result: { payload: Record<string, unknown> } };
      const times = (data.result.payload.access_times as number[]) || [];
      times.push(Date.now());
      const count = ((data.result.payload.access_count as number) || 0) + 1;

      await this.request(`/collections/${encodeURIComponent(collection)}/points/payload`, {
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
    const res = await this.request(`/collections/${encodeURIComponent(collection)}`);
    const data = (await res.json()) as { result: { points_count: number } };
    return data.result.points_count;
  }

  /** Retrieve a single point by ID, or null if not found. */
  async getPoint(collection: string, id: string): Promise<MemCell | null> {
    try {
      const res = await this.request(`/collections/${encodeURIComponent(collection)}/points/${encodeURIComponent(id)}`);
      const data = (await res.json()) as { result: { id: string; payload: Record<string, unknown> } };
      return this.payloadToMemCell(data.result.id, data.result.payload);
    } catch (error) {
      if (error instanceof QdrantHttpError && error.status === 404) return null;
      throw error;
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
      category: typeof p.category === "string" ? p.category : undefined,
      metadata: (p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata))
        ? (p.metadata as Record<string, unknown>) : {},
    };
  }
}
