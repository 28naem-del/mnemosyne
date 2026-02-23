import { describe, it, expect } from "vitest";
import { resolveConfig } from "../src/config.js";

const VALID_BASE = {
  vectorDbUrl: "http://localhost:6333",
  embeddingUrl: "http://localhost:11434/api/embed",
  agentId: "test-agent",
};

describe("resolveConfig", () => {
  it("resolves with minimal required fields", () => {
    const cfg = resolveConfig(VALID_BASE);
    expect(cfg.vectorDbUrl).toBe("http://localhost:6333");
    expect(cfg.embeddingUrl).toBe("http://localhost:11434/api/embed");
    expect(cfg.agentId).toBe("test-agent");
  });

  it("sets smart defaults for optional fields", () => {
    const cfg = resolveConfig(VALID_BASE);
    expect(cfg.embeddingModel).toBe("nomic-text-v1.5");
    expect(cfg.autoCapture).toBe(true);
    expect(cfg.autoRecall).toBe(true);
    expect(cfg.captureMaxChars).toBe(500);
    expect(cfg.enableDecay).toBe(true);
    expect(cfg.enableBM25).toBe(true);
    expect(cfg.enableBroadcast).toBe(false);
    expect(cfg.enableGraph).toBe(false);
    expect(cfg.dreamIntervalHours).toBe(12);
  });

  it("uses default collection names", () => {
    const cfg = resolveConfig(VALID_BASE);
    expect(cfg.sharedCollection).toBe("memory_shared");
    expect(cfg.privateCollection).toBe("memory_private");
    expect(cfg.profilesCollection).toBe("agent_profiles");
    expect(cfg.skillsCollection).toBe("skill_library");
  });

  it("accepts custom collection names", () => {
    const cfg = resolveConfig({
      ...VALID_BASE,
      collections: {
        shared: "my_shared",
        private: "my_private",
        profiles: "my_profiles",
        skills: "my_skills",
      },
    });
    expect(cfg.sharedCollection).toBe("my_shared");
    expect(cfg.privateCollection).toBe("my_private");
    expect(cfg.profilesCollection).toBe("my_profiles");
    expect(cfg.skillsCollection).toBe("my_skills");
  });

  it("overrides defaults when values are provided", () => {
    const cfg = resolveConfig({
      ...VALID_BASE,
      embeddingModel: "text-embedding-3-small",
      autoCapture: false,
      enableBM25: false,
      dreamIntervalHours: 24,
    });
    expect(cfg.embeddingModel).toBe("text-embedding-3-small");
    expect(cfg.autoCapture).toBe(false);
    expect(cfg.enableBM25).toBe(false);
    expect(cfg.dreamIntervalHours).toBe(24);
  });

  it("throws when vectorDbUrl is missing", () => {
    expect(() =>
      resolveConfig({ vectorDbUrl: "", embeddingUrl: "http://x", agentId: "a" }),
    ).toThrow("vectorDbUrl is required");
  });

  it("throws when embeddingUrl is missing", () => {
    expect(() =>
      resolveConfig({ vectorDbUrl: "http://x", embeddingUrl: "", agentId: "a" }),
    ).toThrow("embeddingUrl is required");
  });

  it("throws when agentId is missing", () => {
    expect(() =>
      resolveConfig({ vectorDbUrl: "http://x", embeddingUrl: "http://x", agentId: "" }),
    ).toThrow("agentId is required");
  });

  it("throws for invalid vectorDbUrl", () => {
    expect(() =>
      resolveConfig({ ...VALID_BASE, vectorDbUrl: "not-a-url" }),
    ).toThrow("vectorDbUrl must be a valid URL");
  });

  it("throws for invalid embeddingUrl", () => {
    expect(() =>
      resolveConfig({ ...VALID_BASE, embeddingUrl: "bad" }),
    ).toThrow("embeddingUrl must be a valid URL");
  });

  it("validates optional URLs when provided", () => {
    expect(() =>
      resolveConfig({ ...VALID_BASE, extractionUrl: "nope" }),
    ).toThrow("extractionUrl must be a valid URL");

    expect(() =>
      resolveConfig({ ...VALID_BASE, graphUrl: "nope" }),
    ).toThrow("graphUrl must be a valid URL");

    expect(() =>
      resolveConfig({ ...VALID_BASE, redisUrl: "nope" }),
    ).toThrow("redisUrl must be a valid URL");
  });

  it("throws when autoLinkThreshold is out of range", () => {
    expect(() =>
      resolveConfig({ ...VALID_BASE, autoLinkThreshold: 0.1 }),
    ).toThrow("autoLinkThreshold must be between 0.3 and 0.99");
    expect(() =>
      resolveConfig({ ...VALID_BASE, autoLinkThreshold: 1.0 }),
    ).toThrow("autoLinkThreshold must be between 0.3 and 0.99");
  });

  it("throws when captureMaxChars is out of range", () => {
    expect(() =>
      resolveConfig({ ...VALID_BASE, captureMaxChars: 50 }),
    ).toThrow("captureMaxChars must be between 100 and 10000");
    expect(() =>
      resolveConfig({ ...VALID_BASE, captureMaxChars: 20000 }),
    ).toThrow("captureMaxChars must be between 100 and 10000");
  });

  it("accepts valid autoLinkThreshold at boundaries", () => {
    expect(resolveConfig({ ...VALID_BASE, autoLinkThreshold: 0.3 }).autoLinkThreshold).toBe(0.3);
    expect(resolveConfig({ ...VALID_BASE, autoLinkThreshold: 0.99 }).autoLinkThreshold).toBe(0.99);
  });

  it("accepts valid captureMaxChars at boundaries", () => {
    expect(resolveConfig({ ...VALID_BASE, captureMaxChars: 100 }).captureMaxChars).toBe(100);
    expect(resolveConfig({ ...VALID_BASE, captureMaxChars: 10000 }).captureMaxChars).toBe(10000);
  });
});
