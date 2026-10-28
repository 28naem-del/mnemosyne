import { afterEach, describe, expect, it, vi } from "vitest";
import { createMnemosyne, DEFAULT_COLLECTIONS } from "../src/index.js";
import { resolveConfig } from "../src/config.js";
import { BM25Index, bootstrapBM25Index, hybridSearch } from "../src/core/bm25.js";
import { EmbeddingsClient } from "../src/core/embeddings.js";
import { QdrantDB } from "../src/core/qdrant.js";
import { recall } from "../src/tools/recall.js";
import type { MemCell } from "../src/core/types.js";

const BASE = { vectorDbUrl: "http://qdrant.test", embeddingUrl: "http://embedding.test/api/embed", agentId: "alice" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

function cell(id = "memory-1", text = "server 192.168.1.42"): MemCell {
  return {
    id, text, memoryType: "semantic", classification: "public", agentId: "alice", scope: "public",
    urgency: "reference", domain: "knowledge", confidence: 0.7, confidenceTag: "grounded",
    priorityScore: 0.5, importance: 0.7, linkedMemories: [], accessTimes: [], accessCount: 0,
    eventTime: "", ingestedAt: "", createdAt: new Date().toISOString(), updatedAt: "", deleted: false,
  };
}

/** A strict in-process fake: unexpected URLs fail instead of reaching a service. */
function mockBackend(hook?: (path: string, init: RequestInit) => Response | Promise<Response> | undefined) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init = {}) => {
    const path = String(url);
    const overridden = hook?.(path, init);
    if (overridden) return overridden;
    if (path === BASE.embeddingUrl) return json({ embeddings: [[0.1, 0.2, 0.3]] });
    if (!path.startsWith(BASE.vectorDbUrl)) throw new Error(`Unexpected fake URL: ${path}`);
    if (path.endsWith("/points/scroll")) return json({ result: { points: [], next_page_offset: null } });
    if (path.endsWith("/points/search")) return json({ result: [] });
    if (init.method === "PUT" || init.method === "POST") return json({ result: { status: "completed" } });
    if (/\/collections\/[^/]+$/.test(path)) return json({ result: { config: { params: { vectors: { size: 3, distance: "Cosine" } } }, points_count: 0 } });
    throw new Error(`Unexpected fake operation: ${init.method ?? "GET"} ${path}`);
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe("legacy hybrid retrieval regressions", () => {
  it("preserves strong semantic relevance across BM25 fusion and reranking (#21)", async () => {
    const memory = cell();
    const index = new BM25Index();
    index.addDocument(memory.id, memory.text);
    const db = new QdrantDB(BASE.vectorDbUrl, "alice");
    vi.spyOn(db, "searchAll").mockResolvedValue([{ entry: memory, score: 0.94, source: "qdrant" }]);
    vi.spyOn(db, "updateAccessTime").mockResolvedValue();
    const embeddings = new EmbeddingsClient(BASE.embeddingUrl);
    vi.spyOn(embeddings, "embed").mockResolvedValue([1, 0, 0]);
    const hybrid = await hybridSearch(db, index, [1, 0, 0], "server", 5, 0.3);
    expect(hybrid[0].score).toBe(0.94);
    expect(hybrid[0].retrievalSignals?.rrfScore).toBeLessThan(0.04);
    const result = await recall({ db, embeddings, agentId: "alice", bm25Index: index, enableBM25: true, enableDecay: false }, "server");
    expect(result[0].score).toBeGreaterThan(0.5);
  });

  it("returns a keyword-only exact match even when vector retrieval missed it", async () => {
    const memory = cell();
    const index = new BM25Index();
    index.addDocument(memory.id, memory.text);
    const db = new QdrantDB(BASE.vectorDbUrl, "alice");
    vi.spyOn(db, "searchAll").mockResolvedValue([]);
    const hydrate = vi.spyOn(db, "getSearchCandidates").mockResolvedValue([memory]);
    const results = await hybridSearch(db, index, [1, 0, 0], "192.168.1.42", 5, 0.7, { domain: "technical" });
    expect(results[0].entry.id).toBe(memory.id);
    expect(results[0].score).toBe(1);
    expect(results[0].source).toBe("bm25");
    expect(results[0].retrievalSignals?.vectorSimilarity).toBeUndefined();
    expect(hydrate).toHaveBeenCalledWith([memory.id], { domain: "technical" });
  });

  it("passes filters through vector and lexical hydration while always constraining private agent scope", async () => {
    const fetch = mockBackend();
    const db = new QdrantDB(BASE.vectorDbUrl, "alice");
    await db.searchAll([1, 0, 0], 5, 0.3, { agent_id: "bob" });
    await db.getSearchCandidates(["memory-1"], { agent_id: "bob" });
    const privateCalls = fetch.mock.calls.filter(([url]) => String(url).includes("memory_private"));
    expect(privateCalls).toHaveLength(2);
    for (const [, init] of privateCalls) {
      const must = JSON.parse(String(init?.body)).filter.must;
      expect(must).toContainEqual({ key: "agent_id", match: { value: "alice" } });
      expect(must).toContainEqual({ key: "agent_id", match: { value: "bob" } });
    }
  });
});

describe("legacy BM25 startup regressions", () => {
  it("waits for keyword loading before resolving and exposes private-scoped readiness (#22)", async () => {
    let release!: (response: Response) => void;
    const blocked = new Promise<Response>(resolve => { release = resolve; });
    const fetch = mockBackend(path => path.includes("memory_shared/points/scroll") ? blocked : undefined);
    let resolved = false;
    const creating = createMnemosyne(BASE).then(memory => { resolved = true; return memory; });
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes("memory_shared/points/scroll"))).toBe(true));
    expect(resolved).toBe(false);
    release(json({ result: { points: [{ id: "memory-1", payload: { text: "server 192.168.1.42" } }], next_page_offset: null } }));
    const memory = await creating;
    expect(memory.bm25Status.ready).toBe(true);
    expect(memory.bm25Status.collections[0].loaded).toBe(1);
    const privateCall = fetch.mock.calls.find(([url]) => String(url).includes("memory_private/points/scroll"));
    expect(JSON.parse(String(privateCall?.[1]?.body)).filter.must).toContainEqual({ key: "agent_id", match: { value: "alice" } });
  });

  it("reports the configured scan limit even when a page contains no text", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ result: {
      points: [{ id: "a", payload: {} }, { id: "b", payload: { content: "legacy exact key" } }], next_page_offset: 0,
    } }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const index = new BM25Index();
    const status = await bootstrapBM25Index(BASE.vectorDbUrl, "shared", index, 2, 100, logger, { apiKey: "test-qdrant-key" });
    expect(status).toMatchObject({ loaded: 1, scanned: 2, truncated: true, nextOffset: 0 });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("api-key")).toBe("test-qdrant-key");
    expect(index.search("exact")[0].pointId).toBe("b");
  });

  it("rejects startup after a failed bootstrap instead of returning a partial ready index", async () => {
    mockBackend(path => path.endsWith("/points/scroll") ? json({ error: "unauthorized" }, 401) : undefined);
    await expect(createMnemosyne(BASE)).rejects.toThrow("HTTP 401");
  });

  it("rejects a non-advancing scroll cursor instead of looping forever", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ result: {
      points: [{ id: "same", payload: { text: "same memory" } }], next_page_offset: "same",
    } }));
    await expect(bootstrapBM25Index(BASE.vectorDbUrl, "shared", new BM25Index(), 10, 1)).rejects.toThrow("cursor did not advance");
  });
});

describe("legacy transport and provider regressions", () => {
  it("authenticates collection checks, collection creation, writes and queries", async () => {
    const fetch = mockBackend((path, init) => path.endsWith("/collections/memory_shared") && !init.method ? json({}, 404) : undefined);
    const db = new QdrantDB(BASE.vectorDbUrl, "alice", undefined, { apiKey: "test-key", timeoutMs: 20 });
    await db.ensureCollection("memory_shared", 3);
    await db.store("memory", [1, 0, 0], {});
    await db.searchAll([1, 0, 0]);
    for (const [, init] of fetch.mock.calls) {
      expect(new Headers(init?.headers).get("api-key")).toBe("test-key");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("rejects unauthorized collection checks and failed updates, keeping response secrets out of errors", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ echoedKey: "secret-credential" }, 401));
    const db = new QdrantDB(BASE.vectorDbUrl, "alice");
    await expect(db.ensureCollection("shared", 3)).rejects.toThrow("HTTP 401");
    await expect(db.updatePayload("shared", "a", {})).rejects.not.toThrow("secret-credential");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("only returns null for missing points, not backend outages", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json({}, 503));
    const db = new QdrantDB(BASE.vectorDbUrl, "alice");
    expect(await db.getPoint("shared", "missing")).toBeNull();
    await expect(db.getPoint("shared", "exists")).rejects.toThrow("HTTP 503");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("detects actual embedding dimensions for new collections and preserves the selected model", async () => {
    const fetch = mockBackend((path, init) => /\/collections\/[^/]+$/.test(path) && !init.method ? json({}, 404) : undefined);
    const memory = await createMnemosyne({ ...BASE, embeddingModel: "my-custom-model", embeddingApiKey: "provider-test-key", enableBM25: false });
    expect(memory.embeddings.dimensions).toBe(3);
    const embeddingCall = fetch.mock.calls.find(([url]) => String(url) === BASE.embeddingUrl)!;
    expect(JSON.parse(String(embeddingCall[1]?.body)).model).toBe("my-custom-model");
    expect(new Headers(embeddingCall[1]?.headers).get("Authorization")).toBe("Bearer provider-test-key");
    const creations = fetch.mock.calls.filter(([url, init]) => /\/collections\/[^/]+$/.test(String(url)) && init?.method === "PUT");
    expect(creations).toHaveLength(4);
    for (const [, init] of creations) expect(JSON.parse(String(init?.body)).vectors.size).toBe(3);
  });

  it("rejects incompatible existing collections without writing or deleting them", async () => {
    const fetch = mockBackend((path, init) => /\/collections\/[^/]+$/.test(path) && !init.method ? json({ result: { config: { params: { vectors: { size: 768, distance: "Cosine" } } } } }) : undefined);
    await expect(createMnemosyne({ ...BASE, enableBM25: false })).rejects.toThrow("3 dimensions");
    expect(fetch.mock.calls.filter(([url, init]) => String(url).startsWith(BASE.vectorDbUrl) && init?.method)).toHaveLength(0);
  });

  it("rejects malformed, empty and drifting embeddings, with cache copies immune to caller mutation", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch.mockResolvedValueOnce(json({ data: [] })).mockResolvedValueOnce(json({ embeddings: [[]] }))
      .mockResolvedValueOnce(json({ embedding: [1, 2, 3] })).mockResolvedValueOnce(json({ embedding: [1, 2] }));
    const embeddings = new EmbeddingsClient(BASE.embeddingUrl, "custom");
    await expect(embeddings.embed("empty-data")).rejects.toThrow("non-empty array");
    await expect(embeddings.embed("empty-vector")).rejects.toThrow("non-empty array");
    const vector = await embeddings.embed("cached");
    vector[0] = 999;
    expect(await embeddings.embed("cached")).toEqual([1, 2, 3]);
    await expect(embeddings.embed("drift")).rejects.toThrow("dimension mismatch");
  });

  it("aborts stalled Qdrant and embedding requests", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const db = new QdrantDB(BASE.vectorDbUrl, "alice", undefined, { timeoutMs: 10 });
    const embeddings = new EmbeddingsClient(BASE.embeddingUrl, "custom", { timeoutMs: 10 });
    await expect(db.count("shared")).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(embeddings.embed("query")).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("legacy instance compatibility", () => {
  it("does not change default collection names or another instance's operations", async () => {
    const before = { ...DEFAULT_COLLECTIONS };
    const fetch = mockBackend();
    const first = await createMnemosyne({ ...BASE, enableBM25: false, enableAutoLink: false, collectionName: "first_shared" });
    const second = await createMnemosyne({ ...BASE, enableBM25: false, enableAutoLink: false, collectionName: "second_shared" });
    expect(DEFAULT_COLLECTIONS).toEqual(before);
    expect(resolveConfig(BASE).sharedCollection).toBe(before.SHARED);
    await first.search("first");
    await second.search("second");
    expect(fetch.mock.calls.some(([url]) => String(url).includes("first_shared/points/search"))).toBe(true);
    expect(fetch.mock.calls.some(([url]) => String(url).includes("second_shared/points/search"))).toBe(true);
  });

  it("accepts both quickstart string and object inputs and reports rejected updates", async () => {
    mockBackend((path, init) => path.endsWith("/points/payload") && init.method === "POST" ? json({}, 403) : undefined);
    const memory = await createMnemosyne({ ...BASE, enableBM25: false, enableAutoLink: false });
    expect(await memory.store("User prefers dark mode")).toEqual(expect.any(String));
    expect(await memory.store({ text: "User likes compact views", importance: 0.8 })).toEqual(expect.any(String));
    expect(await memory.recall("preferences")).toEqual([]);
    expect(await memory.recall({ query: "preferences", minScore: 0.7 })).toEqual([]);
    expect(await memory.update("missing", { importance: 0.9 })).toBe(false);
  });

  it.each([0, -1, NaN, Infinity, 1.5])("rejects invalid operational limits (%s)", value => {
    for (const field of ["embeddingDimensions", "requestTimeoutMs", "bm25MaxDocs", "bm25BatchSize"]) {
      expect(() => resolveConfig({ ...BASE, [field]: value })).toThrow("positive safe integer");
    }
  });
});
