/**
 * Shared Memory Blocks -- Letta-style working memory.
 *
 * Named blocks that ALL agents can read/write.
 * Stored in the shared collection with scope: "shared_block".
 * Blocks have: name, content, version, last_writer.
 *
 * Use cases:
 *   - system_status: which agents are online, current tasks, load
 *   - user_preferences: user preferences, evolving across all agents
 *   - active_projects: current work, deadlines, blockers
 */

import { DEFAULT_COLLECTIONS } from "../core/types.js";

export type SharedBlock = {
  name: string;
  content: string;
  version: number;
  lastWriter: string;
  updatedAt: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export class SharedBlockManager {
  private readonly qdrantUrl: string;
  private readonly collection: string;
  private readonly agentId: string;

  constructor(qdrantUrl: string, agentId: string) {
    this.qdrantUrl = qdrantUrl;
    this.collection = DEFAULT_COLLECTIONS.SHARED;
    this.agentId = agentId;
  }

  private async qdrantRequest(path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(`${this.qdrantUrl}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
  }

  /**
   * Get a shared block by name.
   * Uses Qdrant scroll with payload filter -- no vector needed.
   */
  async get(name: string): Promise<SharedBlock | null> {
    const res = await this.qdrantRequest(
      `/collections/${this.collection}/points/scroll`,
      {
        method: "POST",
        body: JSON.stringify({
          filter: {
            must: [
              { key: "scope", match: { value: "shared_block" } },
              { key: "block_name", match: { value: name } },
              { key: "deleted", match: { value: false } },
            ],
          },
          limit: 1,
          with_payload: true,
        }),
      },
    );

    if (!res.ok) return null;
    const data = (await res.json()) as {
      result: { points: Array<{ id: string; payload: Record<string, unknown> }> };
    };

    const points = data.result?.points;
    if (!points || points.length === 0) return null;

    const p = points[0].payload;
    return {
      name: (p.block_name as string) || name,
      content: (p.text as string) || "",
      version: (p.block_version as number) || 1,
      lastWriter: (p.last_writer as string) || "",
      updatedAt: (p.updated_at as string) || "",
      createdAt: (p.created_at as string) || "",
      metadata: (p.metadata as Record<string, unknown>) || {},
    };
  }

  /**
   * Set (create or update) a shared block.
   * Uses a deterministic ID based on block name to ensure upsert behavior.
   */
  async set(
    name: string,
    content: string,
    embedVector: number[],
    metadata?: Record<string, unknown>,
  ): Promise<SharedBlock> {
    // Check if block exists to get version
    const existing = await this.get(name);
    const version = existing ? existing.version + 1 : 1;
    const now = new Date().toISOString();

    // Use deterministic UUID-like ID derived from block name
    const id = await this.blockNameToId(name);

    const payload = {
      text: content,
      block_name: name,
      scope: "shared_block",
      block_version: version,
      last_writer: this.agentId,
      memory_type: "core",
      classification: "public",
      agent_id: this.agentId,
      urgency: "important",
      domain: "knowledge",
      confidence: 1.0,
      confidence_tag: "verified",
      priority_score: 0.9,
      importance: 0.9,
      linked_memories: [],
      access_times: [Date.now()],
      access_count: version,
      event_time: now,
      ingested_at: existing?.createdAt || now,
      created_at: existing?.createdAt || now,
      updated_at: now,
      deleted: false,
      category: "fact",
      metadata: { ...(metadata || {}), block_history_writer: this.agentId },
    };

    await this.qdrantRequest(`/collections/${this.collection}/points`, {
      method: "PUT",
      body: JSON.stringify({ wait: true, points: [{ id, vector: embedVector, payload }] }),
    });

    return {
      name,
      content,
      version,
      lastWriter: this.agentId,
      updatedAt: now,
      createdAt: existing?.createdAt || now,
      metadata: payload.metadata,
    };
  }

  /**
   * Delete a shared block by name (soft delete).
   */
  async delete(name: string): Promise<boolean> {
    const id = await this.blockNameToId(name);
    try {
      await this.qdrantRequest(`/collections/${this.collection}/points/payload`, {
        method: "POST",
        body: JSON.stringify({
          wait: true,
          points: [id],
          payload: { deleted: true, updated_at: new Date().toISOString() },
        }),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all shared blocks.
   */
  async list(): Promise<SharedBlock[]> {
    const res = await this.qdrantRequest(
      `/collections/${this.collection}/points/scroll`,
      {
        method: "POST",
        body: JSON.stringify({
          filter: {
            must: [
              { key: "scope", match: { value: "shared_block" } },
              { key: "deleted", match: { value: false } },
            ],
          },
          limit: 100,
          with_payload: true,
        }),
      },
    );

    if (!res.ok) return [];
    const data = (await res.json()) as {
      result: { points: Array<{ payload: Record<string, unknown> }> };
    };

    return (data.result?.points || []).map((pt) => {
      const p = pt.payload;
      return {
        name: (p.block_name as string) || "",
        content: (p.text as string) || "",
        version: (p.block_version as number) || 1,
        lastWriter: (p.last_writer as string) || "",
        updatedAt: (p.updated_at as string) || "",
        createdAt: (p.created_at as string) || "",
        metadata: (p.metadata as Record<string, unknown>) || {},
      };
    });
  }

  /**
   * Deterministic UUID from block name.
   * Uses a simple hash-to-UUID approach so same block name always maps to same point ID.
   */
  private async blockNameToId(name: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(`shared_block:${name}`);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = new Uint8Array(hashBuffer);
    // Format as UUID v4-like string
    const hex = Array.from(hashArray.slice(0, 16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }
}
