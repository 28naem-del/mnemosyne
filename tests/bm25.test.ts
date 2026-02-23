import { describe, it, expect, beforeEach } from "vitest";
import { BM25Index, reciprocalRankFusion } from "../src/core/bm25.js";
import type { MemCellSearchResult, MemCell } from "../src/core/types.js";

function makeCell(overrides: Partial<MemCell> = {}): MemCell {
  return {
    id: overrides.id ?? "cell-1",
    text: overrides.text ?? "test memory",
    memoryType: "semantic",
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
    accessCount: 1,
    eventTime: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deleted: false,
    ...overrides,
  };
}

describe("BM25Index", () => {
  let index: BM25Index;

  beforeEach(() => {
    index = new BM25Index();
  });

  describe("tokenize", () => {
    it("lowercases and splits on whitespace", () => {
      const tokens = index.tokenize("Hello World Test");
      expect(tokens).toEqual(["hello", "world", "test"]);
    });

    it("preserves IP addresses", () => {
      const tokens = index.tokenize("Server IP is 192.168.1.1");
      expect(tokens).toContain("192.168.1.1");
    });

    it("preserves version numbers", () => {
      const tokens = index.tokenize("Node v22.1.0 release");
      expect(tokens).toContain("v22.1.0");
    });

    it("preserves port numbers in host:port format", () => {
      const tokens = index.tokenize("Qdrant runs at localhost:6333");
      expect(tokens).toContain("localhost:6333");
    });

    it("strips surrounding punctuation", () => {
      const tokens = index.tokenize("(hello) [world]");
      expect(tokens).toContain("hello");
      expect(tokens).toContain("world");
    });

    it("returns empty array for empty input", () => {
      expect(index.tokenize("")).toEqual([]);
      expect(index.tokenize("   ")).toEqual([]);
    });
  });

  describe("addDocument / search", () => {
    it("indexes and retrieves a single document", () => {
      index.addDocument("doc-1", "the server IP is 192.168.1.1");
      const results = index.search("server IP", 10);
      expect(results.length).toBe(1);
      expect(results[0].pointId).toBe("doc-1");
      expect(results[0].score).toBeGreaterThan(0);
    });

    it("ranks exact matches higher than partial matches", () => {
      index.addDocument("doc-1", "the server IP is 192.168.1.1");
      index.addDocument("doc-2", "the server is running fine");
      index.addDocument("doc-3", "IP address lookup service");

      const results = index.search("server IP", 10);
      // doc-1 should rank first (has both "server" and "ip")
      expect(results[0].pointId).toBe("doc-1");
    });

    it("returns empty for no-match queries", () => {
      index.addDocument("doc-1", "hello world");
      const results = index.search("xyz123", 10);
      expect(results).toEqual([]);
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 20; i++) {
        index.addDocument(`doc-${i}`, `document number ${i} about servers`);
      }
      const results = index.search("servers", 5);
      expect(results.length).toBe(5);
    });

    it("returns empty for empty index", () => {
      const results = index.search("anything", 10);
      expect(results).toEqual([]);
    });

    it("returns empty for empty query", () => {
      index.addDocument("doc-1", "hello world");
      const results = index.search("", 10);
      expect(results).toEqual([]);
    });
  });

  describe("removeDocument", () => {
    it("removes a document from the index", () => {
      index.addDocument("doc-1", "the server IP");
      index.addDocument("doc-2", "the database server");

      index.removeDocument("doc-1");

      const results = index.search("server", 10);
      expect(results.length).toBe(1);
      expect(results[0].pointId).toBe("doc-2");
    });

    it("handles removing non-existent document gracefully", () => {
      expect(() => index.removeDocument("nonexistent")).not.toThrow();
    });
  });

  describe("addDocument idempotency", () => {
    it("replaces document on re-add", () => {
      index.addDocument("doc-1", "old content about cats");
      index.addDocument("doc-1", "new content about dogs");

      expect(index.search("cats", 10)).toEqual([]);
      expect(index.search("dogs", 10).length).toBe(1);
      expect(index.stats().docCount).toBe(1);
    });
  });

  describe("bulkLoad", () => {
    it("loads multiple documents at once", () => {
      index.bulkLoad([
        { id: "a", text: "alpha server" },
        { id: "b", text: "beta database" },
        { id: "c", text: "gamma server database" },
      ]);

      expect(index.stats().docCount).toBe(3);
      const results = index.search("server", 10);
      expect(results.length).toBe(2); // a and c
    });
  });

  describe("stats", () => {
    it("returns correct counts", () => {
      index.addDocument("doc-1", "hello world");
      index.addDocument("doc-2", "hello there");

      const stats = index.stats();
      expect(stats.docCount).toBe(2);
      expect(stats.termCount).toBeGreaterThan(0);
      expect(stats.avgDocLen).toBe(2); // 2 tokens each
    });

    it("returns zeros for empty index", () => {
      const stats = index.stats();
      expect(stats.docCount).toBe(0);
      expect(stats.termCount).toBe(0);
      expect(stats.avgDocLen).toBe(0);
    });
  });
});

describe("reciprocalRankFusion", () => {
  it("merges vector and BM25 results", () => {
    const vectorResults: MemCellSearchResult[] = [
      { entry: makeCell({ id: "a" }), score: 0.9 },
      { entry: makeCell({ id: "b" }), score: 0.8 },
    ];
    const bm25Results = [
      { pointId: "b", score: 2.5 },
      { pointId: "c", score: 1.0 },
    ];

    const fused = reciprocalRankFusion(vectorResults, bm25Results);

    // "b" appears in both lists so should have highest fused score
    expect(fused[0].pointId).toBe("b");
    expect(fused[0].fusedScore).toBeGreaterThan(fused[1].fusedScore);
  });

  it("includes vector-only results", () => {
    const vectorResults: MemCellSearchResult[] = [
      { entry: makeCell({ id: "a" }), score: 0.9 },
    ];
    const bm25Results = [{ pointId: "b", score: 1.0 }];

    const fused = reciprocalRankFusion(vectorResults, bm25Results);
    // "a" is vector-only, "b" is BM25-only (no entry), so only "a" returned
    expect(fused.length).toBe(1);
    expect(fused[0].pointId).toBe("a");
  });

  it("returns empty for empty inputs", () => {
    const fused = reciprocalRankFusion([], []);
    expect(fused).toEqual([]);
  });

  it("tracks rank positions correctly", () => {
    const vectorResults: MemCellSearchResult[] = [
      { entry: makeCell({ id: "a" }), score: 0.9 },
      { entry: makeCell({ id: "b" }), score: 0.7 },
    ];
    const bm25Results = [
      { pointId: "a", score: 3.0 },
      { pointId: "b", score: 1.0 },
    ];

    const fused = reciprocalRankFusion(vectorResults, bm25Results);
    const itemA = fused.find((f) => f.pointId === "a")!;
    expect(itemA.vectorRank).toBe(1);
    expect(itemA.bm25Rank).toBe(1);
  });
});
