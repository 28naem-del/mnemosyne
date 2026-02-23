import { describe, it, expect, vi, beforeEach } from "vitest";
import { store } from "../src/tools/store.js";
import type { StoreContext } from "../src/tools/store.js";
import type { MemCell } from "../src/core/types.js";

function makeMemCell(overrides: Partial<MemCell> = {}): MemCell {
  return {
    id: "mem-1",
    text: "test memory text",
    memoryType: "semantic",
    classification: "public",
    agentId: "test-agent",
    scope: "public",
    urgency: "reference",
    domain: "knowledge",
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

function createMockCtx(): StoreContext {
  return {
    db: {
      store: vi.fn().mockResolvedValue(makeMemCell()),
      search: vi.fn().mockResolvedValue([]),
      searchAll: vi.fn().mockResolvedValue([]),
      softDelete: vi.fn().mockResolvedValue(true),
      updateAccessTime: vi.fn().mockResolvedValue(true),
    } as any,
    embeddings: {
      embed: vi.fn().mockResolvedValue(new Array(768).fill(0.1)),
    } as any,
    agentId: "test-agent",
  };
}

describe("store", () => {
  let ctx: StoreContext;

  beforeEach(() => {
    ctx = createMockCtx();
  });

  it("stores a simple text memory", async () => {
    const cell = await store(ctx, "The server IP is 192.168.1.1");

    expect(ctx.embeddings.embed).toHaveBeenCalledWith("The server IP is 192.168.1.1");
    expect(ctx.db.store).toHaveBeenCalled();
    expect(cell).toBeDefined();
    expect(cell.id).toBe("mem-1");
  });

  it("generates embedding before storing", async () => {
    await store(ctx, "some fact");

    expect(ctx.embeddings.embed).toHaveBeenCalledBefore(ctx.db.store as any);
  });

  it("checks for duplicates via vector search", async () => {
    await store(ctx, "new memory");

    // search is called on the collection with the embedding vector
    expect(ctx.db.search).toHaveBeenCalled();
    const searchCall = (ctx.db.search as any).mock.calls[0];
    expect(searchCall[2]).toBe(1); // limit=1
    expect(searchCall[3]).toBe(0.92); // threshold=0.92
  });

  it("rejects SECRET-classified content", async () => {
    await expect(
      store(ctx, "my password is hunter2", { classification: "secret" }),
    ).rejects.toThrow("Cannot store SECRET-classified content");

    expect(ctx.db.store).not.toHaveBeenCalled();
  });

  it("classifies memory type automatically", async () => {
    await store(ctx, "Step 1: install Docker. Step 2: run the container");

    const storeCall = (ctx.db.store as any).mock.calls[0];
    const payload = storeCall[2]; // options arg
    expect(payload.memoryType).toBe("procedural");
  });

  it("classifies urgency automatically", async () => {
    await store(ctx, "URGENT: the server is down and crashing");

    const storeCall = (ctx.db.store as any).mock.calls[0];
    const payload = storeCall[2];
    expect(payload.urgency).toBe("critical");
  });

  it("classifies domain automatically", async () => {
    await store(ctx, "Deploy the Docker container to the server");

    const storeCall = (ctx.db.store as any).mock.calls[0];
    const payload = storeCall[2];
    expect(payload.domain).toBe("technical");
  });

  it("respects explicit memoryType override", async () => {
    await store(ctx, "some text", { memoryType: "core" });

    const storeCall = (ctx.db.store as any).mock.calls[0];
    expect(storeCall[2].memoryType).toBe("core");
  });

  it("respects explicit urgency override", async () => {
    await store(ctx, "some text", { urgency: "critical" });

    const storeCall = (ctx.db.store as any).mock.calls[0];
    expect(storeCall[2].urgency).toBe("critical");
  });

  it("uses default importance of 0.7", async () => {
    await store(ctx, "some fact");

    const storeCall = (ctx.db.store as any).mock.calls[0];
    expect(storeCall[2].importance).toBe(0.7);
  });

  it("respects explicit importance", async () => {
    await store(ctx, "critical fact", { importance: 0.95 });

    const storeCall = (ctx.db.store as any).mock.calls[0];
    expect(storeCall[2].importance).toBe(0.95);
  });

  it("updates BM25 index when provided", async () => {
    const bm25Index = { addDocument: vi.fn() };
    ctx.bm25Index = bm25Index as any;

    const cell = await store(ctx, "indexed text");

    expect(bm25Index.addDocument).toHaveBeenCalledWith(cell.id, "indexed text");
  });

  it("fires broadcast callback when provided", async () => {
    const onBroadcast = vi.fn();
    ctx.onBroadcast = onBroadcast;

    const cell = await store(ctx, "broadcast test");

    expect(onBroadcast).toHaveBeenCalledWith({
      memoryId: cell.id,
      agentId: "test-agent",
      event: "new_memory",
    });
  });

  it("stores private classification in private collection", async () => {
    await store(ctx, "private soul data", { classification: "private" });

    const searchCall = (ctx.db.search as any).mock.calls[0];
    expect(searchCall[0]).toBe("memory_private");
  });

  it("passes metadata to db.store", async () => {
    await store(ctx, "tagged memory", {
      metadata: { source: "test", version: 2 },
    });

    const storeCall = (ctx.db.store as any).mock.calls[0];
    expect(storeCall[2].metadata).toEqual({ source: "test", version: 2 });
  });
});
