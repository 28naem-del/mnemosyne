import { afterEach, describe, expect, it, vi } from "vitest";
import { createMnemosyne, FalkorDBClient } from "../src/index.js";
import { store } from "../src/tools/store.js";
import { EmbeddingsClient } from "../src/core/embeddings.js";
import { L2Cache } from "../src/cache/layer-cache.js";
import { shouldSemanticMerge, buildMergedPayload } from "../src/core/dedup.js";

const BASE = {
  vectorDbUrl: "http://qdrant.test", embeddingUrl: "http://embedding.test/api/embed", agentId: "alice",
  collections: { shared: "custom_shared", private: "custom_private", profiles: "custom_profiles", skills: "custom_skills" },
  qdrantApiKey: "test-key", enableAutoLink: false, enableDecay: false, enableSentimentTracking: false,
};
type Point = { id: string; payload: Record<string, unknown>; vector?: number[] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const point = (id: string, text: string, payload: Record<string, unknown> = {}): Point => ({ id, vector: [1, 0, 0], payload: {
  text, deleted: false, memory_type: "semantic", classification: "public", scope: "public", agent_id: "alice",
  access_count: 6, importance: 0.7, metadata: { provenance: id }, created_at: new Date().toISOString(), ...payload,
} });

function backend(initial: Record<string, Point[]>) {
  const rows = new Map(Object.entries(initial).map(([collection, points]) => [collection, new Map(points.map(p => [p.id, structuredClone(p)]))]));
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init = {}) => {
    if (String(url) === BASE.embeddingUrl) return json({ embeddings: [[1, 0, 0]] });
    const parsed = new URL(String(url));
    if (parsed.origin !== BASE.vectorDbUrl) throw new Error("Unexpected fake origin");
    expect(new Headers(init.headers).get("api-key")).toBe(BASE.qdrantApiKey);
    const [, , collection, , operation] = parsed.pathname.split("/");
    const records = rows.get(collection) ?? new Map<string, Point>();
    rows.set(collection, records);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (parsed.pathname === `/collections/${collection}`) return json({ result: { config: { params: { vectors: { size: 3, distance: "Cosine" } } }, points_count: records.size } });
    if (operation === "scroll" || operation === "search") {
      const matches = [...records.values()].filter(p => (body.filter?.must ?? []).every((filter: any) =>
        filter.has_id ? filter.has_id.includes(p.id) : p.payload[filter.key] === filter.match.value));
      return operation === "scroll"
        ? json({ result: { points: matches.slice(0, body.limit), next_page_offset: matches.length > body.limit ? matches[body.limit].id : null } })
        : json({ result: matches.slice(0, body.limit).map(p => ({ ...p, score: 0.98 })) });
    }
    if (operation === "delete") {
      expect(parsed.searchParams.get("wait")).toBe("true");
      for (const id of body.points) records.delete(id);
      return json({ result: { status: "completed" } });
    }
    if (operation === "payload") {
      for (const id of body.points) {
        const record = records.get(id);
        if (record) Object.assign(record.payload, body.payload);
      }
      return json({ result: { status: "completed" } });
    }
    if (!operation && init.method === "PUT") {
      for (const record of body.points) records.set(record.id, record);
      return json({ result: { status: "completed" } });
    }
    if (operation && !init.method) {
      const record = records.get(operation);
      return record ? json({ result: record }) : json({}, 404);
    }
    throw new Error(`Unexpected fake route ${init.method ?? "GET"} ${parsed.pathname}`);
  });
  return { rows, fetch };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("scoped legacy maintenance", () => {
  it("returns actionable dry-run results with zero writes, preserving all source metadata and facts", async () => {
    const { rows, fetch } = backend({ custom_shared: [point("a", "server port is 3000"), point("b", "server port is 4000")] });
    const memory = await createMnemosyne(BASE);
    const before = JSON.stringify([...rows.entries()].map(([name, records]) => [name, [...records.values()]]));
    fetch.mockClear();
    const result: any = await memory.consolidate({ dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.actions).toHaveLength(2);
    expect(result.reviewCandidates).toHaveLength(1);
    expect(result.applied).toBe(0);
    expect(fetch.mock.calls.every(([url]) => String(url).endsWith("/points/scroll"))).toBe(true);
    expect(JSON.stringify([...rows.entries()].map(([name, records]) => [name, [...records.values()]]))).toBe(before);
  });

  it("uses authenticated instance collections for live maintenance and retains similar memories", async () => {
    const { rows } = backend({
      custom_shared: [point("a", "server port is 3000"), point("b", "server port is 4000")],
      custom_private: [point("mine", "private preference", { classification: "private" }), point("other", "other preference", { agent_id: "bob", classification: "private" })],
    });
    const memory = await createMnemosyne(BASE);
    const result: any = await memory.consolidate();
    expect(result.applied).toBe(3);
    expect(rows.get("custom_shared")?.size).toBe(2);
    expect(rows.get("custom_shared")?.get("a")?.payload.metadata).toMatchObject({ provenance: "a" });
    expect(rows.get("custom_private")?.get("mine")?.payload.importance).toBeCloseTo(0.8);
    expect(rows.get("custom_private")?.get("other")?.payload.importance).toBe(0.7);
    expect(result.nearDuplicatesMerged).toBe(0);
  });

  it("routes dream through scoped maintenance without raw pattern-mining or synthetic embeddings", async () => {
    const { rows, fetch } = backend({ custom_shared: [point("a", "fact"), point("b", "changed fact")] });
    const memory = await createMnemosyne({ ...BASE, embeddingModel: "custom-three-dimensional" });
    fetch.mockClear();
    const report: any = await memory.dream();
    expect(report.phase).toBe("complete");
    expect(report.stats.memoriesScanned).toBe(2);
    expect(report.stats.duplicatesMerged).toBe(0);
    expect(report.stats.patternsDiscovered).toBe(0);
    expect(rows.get("custom_shared")?.size).toBe(2);
    expect(fetch.mock.calls.every(([url]) => String(url).startsWith(BASE.vectorDbUrl))).toBe(true);
  });

  it("reports a bounded maintenance snapshot instead of silently claiming full coverage", async () => {
    backend({ custom_shared: Array.from({ length: 201 }, (_, i) => point(String(i), `fact ${i}`, { access_count: 0 })) });
    const memory = await createMnemosyne({ ...BASE, enableBM25: false });
    const report: any = await memory.consolidate({ dryRun: true });
    expect(report.analyzed).toBe(200);
    expect(report.truncated).toBe(true);
  });

  it("writes feedback to the original private collection and preserves metadata", async () => {
    const { rows } = backend({ custom_private: [point("private", "personal preference", { classification: "private", scope: "private" })] });
    const memory = await createMnemosyne(BASE);
    const recalled = await memory.recall("personal preference");
    expect(recalled[0].entry.id).toBe("private");
    await memory.feedback("yes that was helpful");
    expect(rows.get("custom_private")?.get("private")?.payload.metadata).toMatchObject({ provenance: "private", last_feedback: "positive" });
    expect(rows.get("custom_shared")?.size).toBe(0);
  });
});

describe("legacy retention and forgetting", () => {
  it("stores changed facts and metadata independently despite almost identical embeddings", async () => {
    const { rows } = backend({ custom_shared: [point("original", "server port is 3000")] });
    const memory = await createMnemosyne(BASE);
    const id = await memory.store("server port is 4000", { metadata: { source: "new-report" } });
    expect(id).toEqual(expect.any(String));
    expect(rows.get("custom_shared")?.get("original")?.payload.deleted).toBe(false);
    expect(rows.get("custom_shared")?.get(id!)?.payload.metadata).toEqual({ source: "new-report" });
    const sameTextNewMetadata = await memory.store("server port is 3000", { metadata: { source: "second-author" } });
    expect(sameTextNewMetadata).toEqual(expect.any(String));
    expect(rows.get("custom_shared")?.size).toBe(3);
    // The tools subpath follows the same preservation rule.
    await store({ db: memory.db, embeddings: memory.embeddings, agentId: "alice" }, "server port is 5000");
    expect(rows.get("custom_shared")?.size).toBe(4);
  });

  it("removes a private point from the live collection, BM25, embeddings, recall cache and feedback state", async () => {
    const { rows, fetch } = backend({ custom_private: [point("private", "private exact-key", { classification: "private", scope: "private" })] });
    const memory = await createMnemosyne(BASE);
    expect((await memory.recall("exact-key"))[0].entry.id).toBe("private");
    expect(await memory.forget("private")).toBe(true);
    expect(rows.get("custom_private")?.has("private")).toBe(false);
    fetch.mockClear();
    expect(await memory.recall("exact-key")).toEqual([]);
    expect(fetch.mock.calls.some(([url]) => String(url) === BASE.embeddingUrl)).toBe(true);
    expect(await memory.feedback("helpful")).toEqual([]);
    expect(await memory.forget("private")).toBe(false);
  });

  it("does not erase another agent's private memory by known ID", async () => {
    const { rows } = backend({ custom_private: [point("other", "bob private", { agent_id: "bob", classification: "private" })] });
    const memory = await createMnemosyne(BASE);
    expect(await memory.forget("other")).toBe(false);
    expect(rows.get("custom_private")?.has("other")).toBe(true);
  });

  it("fails before forget side effects when graph replica erasure is unsupported", async () => {
    vi.spyOn(FalkorDBClient.prototype, "connect").mockResolvedValue();
    const { rows, fetch } = backend({ custom_shared: [point("a", "fact")] });
    const memory = await createMnemosyne({ ...BASE, enableGraph: true, graphUrl: "redis://graph.test" });
    fetch.mockClear();
    await expect(memory.forget("a")).rejects.toThrow("no deletion was attempted");
    expect(fetch).not.toHaveBeenCalled();
    expect(rows.get("custom_shared")?.has("a")).toBe(true);
  });

  it("does not repopulate an embedding cache from an in-flight request after clearing", async () => {
    let release!: (response: Response) => void;
    const delayed = new Promise<Response>(resolve => { release = resolve; });
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(delayed).mockResolvedValue(json({ embedding: [1, 0, 0] }));
    const embeddings = new EmbeddingsClient(BASE.embeddingUrl);
    const pending = embeddings.embed("forgotten text");
    embeddings.clearCache();
    release(json({ embedding: [1, 0, 0] }));
    await pending;
    await embeddings.embed("forgotten text");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses separate Redis keys for distinct instance namespaces", async () => {
    const redis = { setex: vi.fn().mockResolvedValue("OK") };
    const first = new L2Cache("redis://fake", "alice");
    const second = new L2Cache("redis://fake", "bob");
    Object.assign(first, { redis, available: true });
    Object.assign(second, { redis, available: true });
    await first.set("same-query", []);
    await second.set("same-query", []);
    expect(redis.setex.mock.calls[0][0]).not.toBe(redis.setex.mock.calls[1][0]);
  });

  it("propagates strict Redis erasure failures instead of claiming cached text was cleared", async () => {
    const cache = new L2Cache("redis://fake", "alice");
    Object.assign(cache, { available: true, redis: { scan: vi.fn().mockRejectedValue(new Error("Redis unavailable")) } });
    await expect(cache.invalidate(undefined, true)).rejects.toThrow("Redis unavailable");
  });

  it("filters an in-flight stale recall after forgetting has completed", async () => {
    backend({ custom_shared: [point("a", "exact-key")] });
    const memory = await createMnemosyne(BASE);
    const staleResults = await memory.recall("exact-key");
    let release!: (results: typeof staleResults) => void;
    const blocked = new Promise<typeof staleResults>(resolve => { release = resolve; });
    const search = vi.spyOn(memory.db, "searchAll").mockReturnValueOnce(blocked);
    const pending = memory.recall("different-query");
    await vi.waitFor(() => expect(search).toHaveBeenCalled());
    expect(await memory.forget("a")).toBe(true);
    release(staleResults);
    expect(await pending).toEqual([]);
    expect(await memory.feedback("helpful")).toEqual([]);
  });

  it("preserves metadata in the low-level merge helper and refuses to equate changed facts", async () => {
    backend({ custom_shared: [point("a", "server port is 3000")] });
    const memory = await createMnemosyne(BASE);
    const existing = (await memory.recall("server"))[0];
    expect(shouldSemanticMerge(existing, "server port is 4000", "semantic").shouldMerge).toBe(false);
    const merge = shouldSemanticMerge(existing, existing.entry.text, "semantic");
    expect(buildMergedPayload(existing.entry, 0.8, merge).metadata).toMatchObject({ provenance: "a", merged_from: "a" });
  });
});
