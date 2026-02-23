/**
 * Redis pub/sub publisher for cross-agent memory broadcast.
 * Channels: memory:public, memory:private:<agent_id>, memory:invalidate,
 *           memory:conflict, memory:critical
 */

import type { BroadcastMessage } from "../core/types.js";

// Redis channels for memory broadcast
export const CHANNELS = {
  PUBLIC: "memory:public",
  PRIVATE: (agentId: string) => `memory:private:${agentId}`,
  INVALIDATE: "memory:invalidate",
  CONFLICT: "memory:conflict",
  CRITICAL: "memory:critical",
  AGENT_STATUS: "agent:status",
} as const;

export class MemoryPublisher {
  private redis: import("ioredis").default | null = null;
  private readonly redisUrl: string;

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
  }

  async connect(): Promise<void> {
    if (this.redis) return;
    const Redis = (await import("ioredis")).default;
    this.redis = new (Redis as any)(this.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
    }) as import("ioredis").default;
    await this.redis!.connect();
  }

  async publish(msg: BroadcastMessage): Promise<number> {
    if (!this.redis) return 0;

    const payload = JSON.stringify(msg);
    let subscribers = 0;

    try {
      if (msg.scope === "public") {
        subscribers += await this.redis.publish(CHANNELS.PUBLIC, payload);
      } else {
        subscribers += await this.redis.publish(CHANNELS.PRIVATE(msg.agentId), payload);
      }

      // High-priority memories also go to critical channel
      if (msg.memoryType === "core" || msg.memoryType === "profile") {
        await this.redis.publish(CHANNELS.CRITICAL, payload);
      }

      // Always publish invalidation for cache eviction
      if (msg.event === "new_memory") {
        await this.redis.publish(CHANNELS.INVALIDATE, JSON.stringify({
          key: `${msg.agentId}:${msg.memoryType}`,
          memoryId: msg.memoryId,
          timestamp: msg.timestamp,
        }));
      }
    } catch {
      // Non-fatal: broadcast failure shouldn't block memory storage
    }

    return subscribers;
  }

  async publishConflict(
    existingId: string,
    newId: string,
    reason: string,
  ): Promise<void> {
    if (!this.redis) return;
    await this.redis.publish(CHANNELS.CONFLICT, JSON.stringify({
      existingId,
      newId,
      reason,
      timestamp: new Date().toISOString(),
    }));
  }

  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }
  }
}
