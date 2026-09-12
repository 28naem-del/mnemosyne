import { afterEach, describe, expect, it, vi } from "vitest";
import * as root from "../src/index.js";
import * as cognitive from "../src/cognitive/index.js";
import * as tools from "../src/tools/index.js";
import { BM25Index, hybridSearch } from "../src/core/bm25.js";
import { QdrantDB } from "../src/core/qdrant.js";
import type { MemCell } from "../src/core/types.js";

const CFG = {
  vectorDbUrl: "http://review-qdrant.test", embeddingUrl: "http://review-embed.test", agentId: "alice",
  collections: { shared: "review_shared", private: "review_private" }, qdrantApiKey: "test-key",
  enableBM25: false, enableAutoLink: false, enableDecay: false, enableSentimentTracking: false,
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const privateMemory = (id: string, agentId = "alice") => ({ id, payload: {
  text: `${agentId} private memory`, deleted: false, classification: "private", scope: "private", agent_id: agentId,
  memory_type: "semantic", access_count: 6, importance: 0.7, metadata: { provenance: id },
} });
function fakeStore() {
  const privatePoints = new Map([['alice', privateMemory('alice')], ['bob', privateMemory('bob', 'bob')]]);
  const writes: string[] = [];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init = {}) => {
    if (String(url) === CFG.embeddingUrl) return response({ embedding: [1, 0, 0] });
    const parsed = new URL(String(url));
    if (parsed.origin !== CFG.vectorDbUrl) throw new Error("Unexpected fake origin");
    expect(new Headers(init.headers).get("api-key")).toBe("test-key");
    const collection = parsed.pathname.split("/")[2];
    const operation = parsed.pathname.split("/")[4];
    const points = collection === "review_private" ? privatePoints : new Map();
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (!parsed.pathname.includes("/points")) return response({ result: { config: { params: { vectors: { size: 3, distance: "Cosine" } } } } });
    if (operation === "scroll" || operation === "search") {
      const allowed = [...points.values()].filter(point => (body.filter?.must ?? []).every((filter: any) =>
        filter.has_id ? filter.has_id.includes(point.id) : point.payload[filter.key as keyof typeof point.payload] === filter.match.value));
      return operation === "scroll" ? response({ result: { points: allowed, next_page_offset: null } })
        : response({ result: allowed.map(point => ({ ...point, score: 0.9 })) });
    }
    if (operation === "delete") {
      writes.push(parsed.pathname);
      body.points.forEach((id: string) => points.delete(id));
      return response({ result: { status: "completed" } });
    }
    if (operation === "payload") {
      writes.push(parsed.pathname);
      for (const id of body.points) if (points.has(id)) Object.assign(points.get(id)!.payload, body.payload);
      return response({ result: { status: "completed" } });
    }
    return points.has(operation) ? response({ result: points.get(operation) }) : response({}, 404);
  });
  return { privatePoints, writes, fetch };
}
afterEach(() => vi.restoreAllMocks());

describe("independent review regressions", () => {
  it("refuses query erasure before network access and retains every point", async () => {
    const { privatePoints, fetch } = fakeStore();
    const memory = await root.createMnemosyne(CFG);
    fetch.mockClear();
    await expect(memory.forget({ query: "alpha beta gamma delta epsilon" })).rejects.toThrow("explicit memory ID");
    expect(fetch).not.toHaveBeenCalled();
    expect(privatePoints.size).toBe(2);
  });

  it("filters weak lexical-only relevance against minScore", async () => {
    const db = new QdrantDB(CFG.vectorDbUrl, "alice");
    const index = new BM25Index();
    index.addDocument("weak", "alpha unrelated record");
    vi.spyOn(db, "searchAll").mockResolvedValue([]);
    vi.spyOn(db, "getSearchCandidates").mockResolvedValue([{ id: "weak", text: "alpha unrelated record" } as MemCell]);
    expect(await hybridSearch(db, index, [1, 0, 0], "alpha beta gamma delta epsilon", 5, 0.7)).toEqual([]);
    expect((await hybridSearch(db, index, [1, 0, 0], "alpha", 5, 0.7))[0].score).toBe(1);
  });

  it("treats graph text as untrusted candidates and preserves live private ownership", async () => {
    fakeStore();
    vi.spyOn(root.FalkorDBClient.prototype, "connect").mockResolvedValue();
    vi.spyOn(root.FalkorDBClient.prototype, "query").mockImplementation(async cypher => cypher.includes("RETURN m.name")
      ? [[], [["bob", "BOB SECRET FROM GRAPH"], ["alice", "forged public graph text"], ["missing", "stale graph text"]], []]
      : [[], [], []]);
    const memory = await root.createMnemosyne({ ...CFG, enableGraph: true, graphUrl: "redis://graph.test" });
    vi.spyOn(memory.db, "searchAll").mockResolvedValue([]);
    const recalled = await memory.recall("Redis");
    expect(recalled).toHaveLength(1);
    expect(recalled[0].entry).toMatchObject({ id: "alice", text: "alice private memory", agentId: "alice", classification: "private", scope: "private" });
    expect(JSON.stringify(recalled)).not.toContain("GRAPH");
    expect(JSON.stringify(recalled)).not.toContain("forged");
  });

  it("tools forget rejects arbitrary collections and another agent's private ID, then erases its own live point", async () => {
    const { privatePoints, fetch } = fakeStore();
    const memory = await root.createMnemosyne(CFG);
    const ctx = { db: memory.db, embeddings: memory.embeddings, agentId: "bob" };
    fetch.mockClear();
    await expect(tools.forget(ctx, { memoryId: "bob", collection: "arbitrary_collection" })).rejects.toThrow("outside");
    expect(fetch).not.toHaveBeenCalled();
    expect(await tools.forget(ctx, { memoryId: "bob", collection: "review_private" })).toEqual({ deleted: 0, ids: [] });
    expect(privatePoints.has("bob")).toBe(true);
    expect(await tools.forget(ctx, { memoryId: "alice", collection: "review_private" })).toEqual({ deleted: 1, ids: ["alice"] });
    expect(privatePoints.has("alice")).toBe(false);
    await expect(tools.forget(ctx, { query: "private" })).rejects.toThrow("explicit memory ID");
  });

  it("revalidates A's cached text after B deletes the live point without Redis", async () => {
    fakeStore();
    const a = await root.createMnemosyne(CFG);
    const b = await root.createMnemosyne(CFG);
    expect((await a.recall("private"))[0].entry.id).toBe("alice");
    expect(await b.forget("alice")).toBe(true);
    expect(await a.recall("private")).toEqual([]);
    expect(await a.feedback("helpful")).toEqual([]);
  });

  it("explicit erasure also removes an old soft-deleted point's stored text", async () => {
    const { privatePoints } = fakeStore();
    privatePoints.get("alice")!.payload.deleted = true;
    const memory = await root.createMnemosyne(CFG);
    expect(await memory.forget("alice")).toBe(true);
    expect(privatePoints.has("alice")).toBe(false);
  });

  it("rejects cached retrieval on live verification failure and removes stale recall state", async () => {
    fakeStore();
    const a = await root.createMnemosyne(CFG);
    await a.recall("private");
    vi.spyOn(a.db, "getScopedPoint").mockRejectedValueOnce(new Error("live scope check unavailable"));
    await expect(a.recall("private")).rejects.toThrow("live scope check unavailable");
    expect(await a.feedback("helpful")).toEqual([]);
  });

  it("refreshes cached ownership and text from the live record instead of relabeling stale content", async () => {
    const { privatePoints } = fakeStore();
    const a = await root.createMnemosyne(CFG);
    await a.recall("private");
    privatePoints.get("alice")!.payload.text = "updated live text";
    expect((await a.recall("private"))[0].entry.text).toBe("updated live text");
    privatePoints.get("alice")!.payload.agent_id = "bob";
    expect(await a.recall("private")).toEqual([]);
  });

  it("fails closed across root, cognitive and tools legacy URL-only mutation APIs", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Must not fetch"));
    const attempts = [
      () => root.runConsolidation("http://unsafe.test"),
      () => root.runDreamConsolidation("http://unsafe.test", "alice"),
      () => root.runPatternMining("http://unsafe.test", "http://embedding.test", null, "alice"),
      () => cognitive.mergeNearDuplicates("http://unsafe.test"),
      () => cognitive.findContradictions("http://unsafe.test"),
      () => cognitive.applyConsolidationAction("http://unsafe.test", "shared", { type: "archive", id: "a", reason: "test" }),
      () => cognitive.dreamDedup("http://unsafe.test", "shared", {} as cognitive.DreamConfig),
      () => cognitive.dreamMerge("http://unsafe.test", "shared", {} as cognitive.DreamConfig),
      () => cognitive.dreamPrune("http://unsafe.test", "shared", {} as cognitive.DreamConfig),
      () => cognitive.savePatterns("http://unsafe.test", "http://embedding.test", "alice", []),
      () => tools.consolidate({ qdrantUrl: "http://unsafe.test" }),
      () => tools.dream({ qdrantUrl: "http://unsafe.test", agentId: "alice" }),
      () => tools.patterns({ qdrantUrl: "http://unsafe.test", embedUrl: "http://embedding.test", agentId: "alice" }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow("No network access or mutation was attempted");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("supports explicit scoped database maintenance from public root and tools exports", async () => {
    const { writes } = fakeStore();
    const memory = await root.createMnemosyne(CFG);
    const rootPreview: any = await root.runConsolidation(memory.db, undefined, 200, { dryRun: true });
    expect(rootPreview.dryRun).toBe(true);
    const toolsPreview: any = await tools.consolidate({ db: memory.db }, { dryRun: true, collection: "review_private" });
    expect(toolsPreview.analyzed).toBe(1);
    expect(writes).toEqual([]);
    await expect(tools.consolidate({ db: memory.db }, { collection: "outside", dryRun: false })).rejects.toThrow("outside");
    expect(writes).toEqual([]);
    const dream = await root.runDreamConsolidation(memory.db, "not-the-authority");
    expect(dream.stats.memoriesScanned).toBe(1);
    expect(writes.every(path => path.includes("review_private"))).toBe(true);
  });

  it("exposes the v2 local and reflection APIs at the package root", () => {
    expect(root.LocalMemory).toBeTypeOf("function");
    expect(root.createLocalMemory).toBeTypeOf("function");
    expect(root.reflect).toBeTypeOf("function");
    expect(root.commitVerifiedLesson).toBeTypeOf("function");
  });
});
