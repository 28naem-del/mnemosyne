/**
 * Redis pub/sub subscriber for receiving cross-agent memory updates.
 * Listens to memory:public and memory:private:<own_agent_id>.
 */

import { CHANNELS } from "./publisher.js";
import type { BroadcastMessage } from "../core/types.js";

export type MessageHandler = (msg: BroadcastMessage) => void | Promise<void>;

export class MemorySubscriber {
  private redis: import("ioredis").default | null = null;
  private readonly redisUrl: string;
  private readonly agentId: string;
  private handlers: MessageHandler[] = [];

  constructor(redisUrl: string, agentId: string) {
    this.redisUrl = redisUrl;
    this.agentId = agentId;
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    const Redis = (await import("ioredis")).default;
    this.redis = new (Redis as any)(this.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: null, // Subscriber should keep retrying
      connectTimeout: 5000,
    }) as import("ioredis").default;
    await this.redis!.connect();

    const channels = [
      CHANNELS.PUBLIC,
      CHANNELS.PRIVATE(this.agentId),
      CHANNELS.CRITICAL,
      CHANNELS.INVALIDATE,
    ];

    await this.redis!.subscribe(...channels);

    this.redis!.on("message", async (_channel: string, message: string) => {
      try {
        const parsed = JSON.parse(message) as BroadcastMessage;
        for (const handler of this.handlers) {
          await handler(parsed);
        }
      } catch {
        // Ignore malformed messages
      }
    });
  }

  async stop(): Promise<void> {
    if (this.redis) {
      await this.redis.unsubscribe();
      await this.redis.quit();
      this.redis = null;
    }
  }
}
