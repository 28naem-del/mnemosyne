import { test } from "vitest";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { createMnemosyne } from "../src/index.js";
import type { MnemosyneConfig } from "../src/config.js";
import { LayerCache, L2Cache } from "../src/cache/layer-cache.js";

const base: MnemosyneConfig = {
  vectorDbUrl: "http://qdrant.namespace.test:6333",
  embeddingUrl: "http://embed.namespace.test/v1/embeddings", agentId: "alice",
  qdrantApiKey: "synthetic-qdrant-key", embeddingApiKey: "synthetic-embedding-key",
  redisUrl: "redis://synthetic-user:synthetic-password@cache.namespace.test:6379/0",
  enableBM25: false, enableAutoLink: false, enableDecay: false,
  enableSentimentTracking: false, enableGraph: false, enableBroadcast: false,
};
const store = new Map<string, string>();

// Exercise the actual factory's namespace and L2 wire key, not a reimplemented
// namespace helper. Inject only transport dependencies; no Redis/provider calls.
async function cacheFor(overrides: Partial<MnemosyneConfig> = {}, reverseFields = false) {
  let cfg: MnemosyneConfig = { ...base, ...overrides };
  if (reverseFields) cfg = Object.fromEntries(Object.entries(cfg).reverse()) as MnemosyneConfig;
  const caches: L2Cache[] = [];
  const fetch = globalThis.fetch, connect = LayerCache.prototype.connect;
  globalThis.fetch = async url => {
    if (String(url) === cfg.embeddingUrl) return new Response(JSON.stringify({ embedding: [1, 0, 0] }));
    if (new URL(String(url)).pathname.startsWith("/collections/")) return new Response(JSON.stringify({ result: { config: { params: { vectors: { size: 3, distance: "Cosine" } } } } }));
    throw new Error("unexpected synthetic transport request");
  };
  LayerCache.prototype.connect = async function () { caches.push(this.l2); };
  try {
    const memory = await createMnemosyne(cfg);
    assert.equal(caches.length, 1);
    const cache = caches[0];
    let key = "", ttl = 0;
    const injected = cache as unknown as { available: boolean; redis: unknown };
    injected.available = true;
    injected.redis = {
      async setex(wireKey: string, seconds: number, value: string) { key = wireKey; ttl = seconds; store.set(wireKey, value); },
      async get(wireKey: string) { return store.get(wireKey) ?? null; },
    };
    await cache.set("probe", []);
    assert.equal(ttl, 3600);
    const expected = createHash("sha256").update(JSON.stringify(memory.config)).digest("hex");
    assert.equal(key, "memcache:" + expected + ":probe");
    return { cache, namespace: key.slice("memcache:".length, -":probe".length) };
  } finally {
    globalThis.fetch = fetch;
    LayerCache.prototype.connect = connect;
  }
}

test("resolved config cache namespace is stable across instances and input field order", async () => {
  const first = await cacheFor(), second = await cacheFor();
  const reordered = await cacheFor({}, true);
  assert.equal(first.namespace, second.namespace);
  assert.equal(first.namespace, reordered.namespace);
  assert.match(first.namespace, /^[a-f0-9]{64}$/);
});

test("credentials, agents, provider endpoints and Redis credential URLs isolate namespaces", async () => {
  const original = await cacheFor();
  const variants: Partial<MnemosyneConfig>[] = [
    { qdrantApiKey: "rotated-synthetic-qdrant" }, { embeddingApiKey: "rotated-synthetic-embedding" },
    { agentId: "bob" }, { vectorDbUrl: "http://qdrant.other.test:6333" },
    { embeddingUrl: "http://embed.other.test/v1/embeddings" }, { embeddingModel: "other-fixture-model" },
    { redisUrl: "redis://synthetic-user:rotated-password@cache.namespace.test:6379/0" },
    { redisUrl: "redis://synthetic-user:synthetic-password@cache.other.test:6379/0" },
    { collections: { private: "other-private" } },
  ];
  const namespaces = new Set([original.namespace]);
  for (const variant of variants) {
    const result = await cacheFor(variant);
    assert.ok(!namespaces.has(result.namespace), "different authorization/config context must not reuse cache namespace");
    namespaces.add(result.namespace);
  }
});

test("rotation does not read the old namespace, while an unchanged restart can reuse it", async () => {
  store.clear();
  const old = await cacheFor();
  await old.cache.set("rotation-query", []);
  const rotated = await cacheFor({ qdrantApiKey: "rotated-synthetic-qdrant" });
  assert.equal(await rotated.cache.get("rotation-query"), null);
  const restarted = await cacheFor();
  assert.deepEqual(await restarted.cache.get("rotation-query"), []);
  assert.deepEqual(await old.cache.get("rotation-query"), []);
});
