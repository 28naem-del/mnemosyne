import { describe, it, expect, vi, beforeEach } from "vitest";
import { recall } from "../src/tools/recall.js";
import type { RecallContext } from "../src/tools/recall.js";
import type { MemCell, MemCellSearchResult } from "../src/core/types.js";

function makeCell(overrides: Partial<MemCell> = {}): MemCell {
  return {
    id: overrides.id ?? "mem-1",
    text: overrides.text ?? "test memory",
    memoryType: overrides.memoryType ?? "semantic",
    classification: "public",
    agentId: "test-agent",
    scope: "public",
    urgency: "reference",
    domain: "technical",
    confidence: 0.8,
    confidenceTag: "grounded",
    priorityScore: 0.5,
    importance: 0.7,
    linkedMemories: [],
    accessTimes: [Date.now()],
    accessCount: 3,
    eventTime: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deleted: false,
    ...overrides,
  };
}

function makeSearchResult(id: string, score: number, overrides: Partial<MemCell> = {}): MemCellSearchResult {
  return { entry: makeCell({ id, ...overrides }), score };
}

function createMockCtx(results: MemCellSearchResult[] = []): RecallContext {
  return {
    db: {
      searchAll: vi.fn().mockResolvedValue(results),
      search: vi.fn().mockResolvedValue(results),
      updateAccessTime: vi.fn().mockResolvedValue(true),
    } as any,
    embeddings: {
      embed: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
    } as any,
    agentId: "test-agent",
    enableDecay: false, // disable decay for predictable tests
  };
}

describe("recall", () => {
  it("returns empty array when no results found", async () => {
    const ctx = createMockCtx([]);
    const results = await recall(ctx, "nonexistent query");
    expect(results).toEqual([]);
  });

  it("generates embedding for the query", async () => {
    const ctx = createMockCtx([]);
    await recall(ctx, "what is the server IP");
    expect(ctx.embeddings.embed).toHaveBeenCalledWith("what is the server IP");
  });

  it("returns scored results from vector search", async () => {
    const mockResults = [
      makeSearchResult("a", 0.9, { text: "server IP is 10.0.0.1" }),
      makeSearchResult("b", 0.7, { text: "database runs on port 5432" }),
    ];
    const ctx = createMockCtx(mockResults);

    const results = await recall(ctx, "what is the server IP");
    expect(results.length).toBeGreaterThan(0);
  });

  it("respects the limit option", async () => {
    const mockResults = Array.from({ length: 20 }, (_, i) =>
      makeSearchResult(`mem-${i}`, 0.9 - i * 0.02, { text: `memory ${i}` }),
    );
    const ctx = createMockCtx(mockResults);

    const results = await recall(ctx, "test query", { limit: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("uses hybrid search when BM25 is enabled", async () => {
    const mockResults = [makeSearchResult("a", 0.9)];
    const ctx = createMockCtx(mockResults);
    ctx.enableBM25 = true;
    ctx.bm25Index = {
      search: vi.fn().mockReturnValue([{ pointId: "a", score: 2.0 }]),
    } as any;

    await recall(ctx, "server IP");

    // When BM25 is enabled, it should use hybridSearch which calls searchAll + bm25
    expect(ctx.db.searchAll).toHaveBeenCalled();
  });

  it("falls back to vector-only search without BM25", async () => {
    const mockResults = [makeSearchResult("a", 0.9)];
    const ctx = createMockCtx(mockResults);
    ctx.enableBM25 = false;

    await recall(ctx, "server IP");

    expect(ctx.db.searchAll).toHaveBeenCalled();
  });

  it("updates access times for returned results", async () => {
    const mockResults = [
      makeSearchResult("a", 0.9, { text: "important memory" }),
    ];
    const ctx = createMockCtx(mockResults);

    await recall(ctx, "important");

    expect(ctx.db.updateAccessTime).toHaveBeenCalled();
  });

  it("applies multi-signal scoring to rerank results", async () => {
    // Result with higher importance should beat raw similarity when intent is factual
    const mockResults = [
      makeSearchResult("low-imp", 0.85, {
        text: "what is the IP address of the main server",
        importance: 0.3,
        memoryType: "episodic",
      }),
      makeSearchResult("high-imp", 0.80, {
        text: "what is the server IP address 10.0.0.1",
        importance: 0.95,
        memoryType: "semantic",
      }),
    ];
    const ctx = createMockCtx(mockResults);

    const results = await recall(ctx, "what is the server IP");
    // Both should be returned, scored by multi-signal
    expect(results.length).toBe(2);
    // The high-importance semantic result should rank first for a factual query
    expect(results[0].entry.id).toBe("high-imp");
  });

  it("detects factual intent and boosts semantic memories", async () => {
    const mockResults = [
      makeSearchResult("episodic-1", 0.9, {
        text: "discussed the server IP yesterday",
        memoryType: "episodic",
        importance: 0.7,
      }),
      makeSearchResult("semantic-1", 0.88, {
        text: "the server IP is 10.0.0.1",
        memoryType: "semantic",
        importance: 0.7,
      }),
    ];
    const ctx = createMockCtx(mockResults);

    const results = await recall(ctx, "what is the server IP");
    // Semantic should be boosted for factual intent
    expect(results[0].entry.memoryType).toBe("semantic");
  });

  it("detects temporal intent and boosts episodic memories", async () => {
    const recentTime = Date.now();
    const mockResults = [
      makeSearchResult("semantic-1", 0.9, {
        text: "the server configuration is standard",
        memoryType: "semantic",
        accessTimes: [recentTime - 86400000], // 1 day ago
      }),
      makeSearchResult("episodic-1", 0.85, {
        text: "yesterday we changed the server config",
        memoryType: "episodic",
        accessTimes: [recentTime], // just now
      }),
    ];
    const ctx = createMockCtx(mockResults);

    const results = await recall(ctx, "what happened yesterday with the server");
    // Episodic should be boosted for temporal intent
    expect(results[0].entry.memoryType).toBe("episodic");
  });
});
