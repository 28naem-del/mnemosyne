/**
 * L1/L2 Layer Cache for Memory OS.
 *
 * L1: In-memory Map cache (50 entries, 5-min TTL) for repeated queries.
 * L2: Redis cache (1-hour TTL) for cross-session hits.
 *
 * Cache invalidation: subscribes to Redis `memory:invalidate` channel
 * to evict stale entries when memories change.
 */

import type { MemCellSearchResult } from "../core/types.js";

// Serializable search result for cache storage
type CachedResult = {
  results: MemCellSearchResult[];
  cachedAt: number;
};

// ============================================================================
// L1: In-Memory Cache
// ============================================================================

const L1_MAX_ENTRIES = 50;
const L1_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class L1Cache {
  private store = new Map<string, CachedResult>();

  get(key: string): MemCellSearchResult[] | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > L1_TTL_MS) {
      this.store.delete(key);
      return null;
    }
    return entry.results;
  }

  set(key: string, results: MemCellSearchResult[]): void {
    // LRU eviction: remove oldest if at capacity
    if (this.store.size >= L1_MAX_ENTRIES && !this.store.has(key)) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { results, cachedAt: Date.now() });
  }

  invalidate(pattern?: string): void {
    if (!pattern) {
      this.store.clear();
      return;
    }
    // Invalidate entries whose keys contain the pattern
    for (const key of [...this.store.keys()]) {
      if (key.includes(pattern)) {
        this.store.delete(key);
      }
    }
  }

  get size(): number {
    return this.store.size;
  }
}

// ============================================================================
// L2: Redis Cache
// ============================================================================

const L2_TTL_SECONDS = 60 * 60; // 1 hour
const L2_PREFIX = "memcache:";

export class L2Cache {
  private redis: import("ioredis").default | null = null;
  private readonly redisUrl: string;
  private available = false;

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
  }

  async connect(): Promise<boolean> {
    try {
      const Redis = (await import("ioredis")).default;
      this.redis = new Redis(this.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        connectTimeout: 3000,
        retryStrategy: (times) => (times > 3 ? null : Math.min(times * 500, 2000)),
      });
      await this.redis.connect();
      this.available = true;
      return true;
    } catch {
      this.available = false;
      return false;
    }
  }

  async get(key: string): Promise<MemCellSearchResult[] | null> {
    if (!this.available || !this.redis) return null;
    try {
      const raw = await this.redis.get(`${L2_PREFIX}${key}`);
      if (!raw) return null;
      const cached = JSON.parse(raw) as CachedResult;
      return cached.results;
    } catch {
      return null;
    }
  }

  async set(key: string, results: MemCellSearchResult[]): Promise<void> {
    if (!this.available || !this.redis) return;
    try {
      const cached: CachedResult = { results, cachedAt: Date.now() };
      await this.redis.setex(`${L2_PREFIX}${key}`, L2_TTL_SECONDS, JSON.stringify(cached));
    } catch {
      // Non-fatal
    }
  }

  async invalidate(pattern?: string): Promise<void> {
    if (!this.available || !this.redis) return;
    try {
      if (!pattern) {
        // Scan and delete all cache keys
        let cursor = "0";
        do {
          const [next, keys] = await this.redis.scan(cursor, "MATCH", `${L2_PREFIX}*`, "COUNT", 100);
          cursor = next;
          if (keys.length > 0) {
            await this.redis.del(...keys);
          }
        } while (cursor !== "0");
      } else {
        // Scan for matching keys
        let cursor = "0";
        do {
          const [next, keys] = await this.redis.scan(cursor, "MATCH", `${L2_PREFIX}*${pattern}*`, "COUNT", 100);
          cursor = next;
          if (keys.length > 0) {
            await this.redis.del(...keys);
          }
        } while (cursor !== "0");
      }
    } catch {
      // Non-fatal
    }
  }

  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit().catch(() => {});
      this.redis = null;
      this.available = false;
    }
  }

  get isAvailable(): boolean {
    return this.available;
  }
}

// ============================================================================
// LayerCache: Unified L1 + L2 with cache invalidation
// ============================================================================

export class LayerCache {
  readonly l1: L1Cache;
  readonly l2: L2Cache;
  private invalidationSub: import("ioredis").default | null = null;
  private readonly redisUrl: string;

  constructor(redisUrl: string) {
    this.l1 = new L1Cache();
    this.l2 = new L2Cache(redisUrl);
    this.redisUrl = redisUrl;
  }

  /** Connect L2 Redis + subscribe to invalidation channel */
  async connect(): Promise<void> {
    // Connect L2 cache
    await this.l2.connect();

    // Subscribe to memory:invalidate for cache eviction
    try {
      const Redis = (await import("ioredis")).default;
      this.invalidationSub = new Redis(this.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: null,
        connectTimeout: 3000,
      });
      await this.invalidationSub.connect();
      await this.invalidationSub.subscribe("memory:invalidate");

      this.invalidationSub.on("message", (_channel: string, message: string) => {
        try {
          const data = JSON.parse(message) as { key?: string; memoryId?: string };
          // Invalidate both L1 and L2 -- broad flush since we can't map memoryId to query keys
          this.l1.invalidate();
          this.l2.invalidate().catch(() => {});
        } catch {
          // Malformed invalidation message
        }
      });
    } catch {
      // Non-fatal: cache invalidation subscription failed, caches will rely on TTL
    }
  }

  /** Normalize query string into a cache key */
  private cacheKey(query: string, limit: number, minScore: number): string {
    return `${query.toLowerCase().trim()}:${limit}:${minScore}`;
  }

  /** Look up query in L1, then L2. Returns null on miss. */
  async get(query: string, limit: number, minScore: number): Promise<MemCellSearchResult[] | null> {
    const key = this.cacheKey(query, limit, minScore);

    // L1 hit?
    const l1Hit = this.l1.get(key);
    if (l1Hit) return l1Hit;

    // L2 hit?
    const l2Hit = await this.l2.get(key);
    if (l2Hit) {
      // Promote to L1
      this.l1.set(key, l2Hit);
      return l2Hit;
    }

    return null;
  }

  /** Store results in both L1 and L2 */
  async set(query: string, limit: number, minScore: number, results: MemCellSearchResult[]): Promise<void> {
    const key = this.cacheKey(query, limit, minScore);
    this.l1.set(key, results);
    await this.l2.set(key, results);
  }

  /** Force invalidate all caches */
  async invalidateAll(): Promise<void> {
    this.l1.invalidate();
    await this.l2.invalidate();
  }

  async disconnect(): Promise<void> {
    if (this.invalidationSub) {
      await this.invalidationSub.unsubscribe().catch(() => {});
      await this.invalidationSub.quit().catch(() => {});
      this.invalidationSub = null;
    }
    await this.l2.disconnect();
  }
}
