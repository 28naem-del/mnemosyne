import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SharedBlockManager } from "../src/broadcast/shared-blocks.js";
import { applyCorroboration } from "../src/broadcast/cross-agent.js";
import { storeInsights } from "../src/broadcast/synthesis.js";
import { SkillLibrary } from "../src/cognitive/skills.js";
import { QdrantHttpError } from "../src/core/http.js";

/**
 * Qdrant answers a failed write with an HTTP status, not a dropped connection.
 * A helper that only awaited the request reported a write that never happened.
 * These run against a real local HTTP server: reads and embeddings succeed,
 * and every Qdrant write (PUT /points, POST /points/payload) returns `writeStatus`.
 */

let server: Server;
let base = "";
let writeStatus = 500;
const writes: string[] = [];

beforeEach(async () => {
  writes.length = 0;
  writeStatus = 500;
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const url = request.url ?? "";
      const reply = (status: number, value: unknown) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
      if (url.startsWith("/embed")) return reply(200, { embedding: [0.1, 0.2, 0.3], data: [{ embedding: [0.1, 0.2, 0.3] }] });
      if (url.endsWith("/points/scroll")) return reply(200, { result: { points: [], next_page_offset: null } });
      if (request.method === "GET" && /\/points\/[^/]+$/.test(url)) return reply(200, { result: { id: "m1", payload: { metadata: {}, execution_count: 2 } } });
      if ((request.method === "PUT" && url.endsWith("/points")) || (request.method === "POST" && url.endsWith("/points/payload"))) {
        writes.push(`${request.method} ${url}`);
        return reply(writeStatus, writeStatus < 300 ? { result: { status: "completed" } } : { status: { error: "service unavailable" } });
      }
      return reply(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

const insight = { id: "00000000-0000-4000-8000-000000000001", type: "consensus", description: "Both agents agree the cache warms at startup.", contributingAgents: ["a", "b"], contributingMemories: ["m1", "m2"], confidence: 0.8 } as never;

describe("legacy Qdrant writes report HTTP failures", () => {
  it("SharedBlockManager.set rejects and delete returns false when the write fails", async () => {
    const blocks = new SharedBlockManager(base, "alice");
    await expect(blocks.set("policy", "Deploys need two approvals.", [0.1, 0.2, 0.3])).rejects.toBeInstanceOf(QdrantHttpError);
    await expect(blocks.delete("policy")).resolves.toBe(false);
    expect(writes).toHaveLength(2);
  });

  it("applyCorroboration returns false when the payload update fails", async () => {
    const applied = await applyCorroboration(base, "memory_shared", { type: "corroborate", memoryId: "m1", byAgent: "bob", newConfidence: 0.9, newTag: "verified" } as never);
    expect(applied).toBe(false);
    expect(writes).toHaveLength(1);
  });

  it("storeInsights does not count an insight whose write failed", async () => {
    await expect(storeInsights(base, `${base}/embed`, [insight])).resolves.toBe(0);
    expect(writes).toHaveLength(1);
  });

  it("SkillLibrary.store and incrementExecution reject when the write fails", async () => {
    const skills = new SkillLibrary(base);
    const procedure = { id: "00000000-0000-4000-8000-000000000002", title: "Warm the cache", triggerPhrases: ["warm cache"], prerequisites: [], steps: [], outcome: "Cache is warm.", verified: false, executionCount: 0, createdBy: "alice", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } as never;
    await expect(skills.store(procedure, [0.1, 0.2, 0.3])).rejects.toThrow(/HTTP 500/);
    await expect(skills.incrementExecution("m1")).rejects.toThrow(/HTTP 500/);
  });

  it("the error names the method, path and status and nothing from the response body", async () => {
    const blocks = new SharedBlockManager(base, "alice");
    const error = await blocks.set("policy", "Deploys need two approvals.", [0.1, 0.2, 0.3]).catch((caught: unknown) => caught as Error);
    expect(error.message).toMatch(/^Qdrant PUT \/collections\/[^ ]+\/points: HTTP 500$/);
    expect(error.message).not.toContain("service unavailable");
  });

  it("the same calls still report success when the server accepts the write", async () => {
    writeStatus = 200;
    const blocks = new SharedBlockManager(base, "alice");
    await expect(blocks.set("policy", "Deploys need two approvals.", [0.1, 0.2, 0.3])).resolves.toMatchObject({ name: "policy", version: 1 });
    await expect(blocks.delete("policy")).resolves.toBe(true);
    await expect(applyCorroboration(base, "memory_shared", { type: "corroborate", memoryId: "m1", byAgent: "bob", newConfidence: 0.9, newTag: "verified" } as never)).resolves.toBe(true);
    await expect(storeInsights(base, `${base}/embed`, [insight])).resolves.toBe(1);
    const skills = new SkillLibrary(base);
    await expect(skills.incrementExecution("m1")).resolves.toBeUndefined();
  });
});
