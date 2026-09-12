/**
 * Embeddings client with caching.
 * Supports OpenAI-compatible (/v1/embeddings) and Ollama (/api/embed) endpoints.
 */
export interface EmbeddingOptions {
  apiKey?: string;
  timeoutMs?: number;
  dimensions?: number;
}

export class EmbeddingsClient {
  private readonly embedUrl: string;
  private readonly model: string;
  private readonly isOllama: boolean;
  private cache = new Map<string, { vector: number[]; ts: number }>();
  private readonly cacheTTL = 300_000;
  private readonly maxCache = 512;
  private detectedDimensions?: number;
  private cacheGeneration = 0;

  constructor(embedUrl: string, model = "nomic-text-v1.5", private readonly options: EmbeddingOptions = {}) {
    this.embedUrl = embedUrl;
    this.model = model;
    this.isOllama = new URL(embedUrl).pathname.startsWith("/api/embed");
    this.detectedDimensions = options.dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const generation = this.cacheGeneration;
    const cached = this.cache.get(text);
    if (cached && Date.now() - cached.ts < this.cacheTTL) {
      return [...cached.vector];
    }

    const body = this.isOllama
      ? JSON.stringify({ model: this.model, input: text })
      : JSON.stringify({ input: text, model: this.model });

    const res = await fetch(this.embedUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      body,
    });
    if (!res.ok) {
      throw new Error(`Embedding failed: HTTP ${res.status}`);
    }

    const json = await res.json() as Record<string, unknown>;
    let vector: number[];

    if (Array.isArray((json as { data?: unknown }).data)) {
      // OpenAI format: { data: [{ embedding: [...] }] }
      const openaiData = json as { data: Array<{ embedding: number[] }> };
      vector = openaiData.data[0]?.embedding;
    } else if (Array.isArray((json as { embeddings?: unknown }).embeddings)) {
      // Ollama format: { embeddings: [[...]] }
      const ollamaData = json as { embeddings: number[][] };
      vector = ollamaData.embeddings[0];
    } else if (Array.isArray((json as { embedding?: unknown }).embedding)) {
      // Single embedding format: { embedding: [...] }
      vector = (json as { embedding: number[] }).embedding;
    } else {
      throw new Error("Unexpected embedding response format");
    }

    if (!Array.isArray(vector) || vector.length === 0 || !vector.every(v => typeof v === "number" && Number.isFinite(v))) {
      throw new Error("Embedding must be a non-empty array of finite numbers");
    }
    if (this.detectedDimensions !== undefined && vector.length !== this.detectedDimensions) {
      throw new Error(`Embedding dimension mismatch: expected ${this.detectedDimensions}, received ${vector.length}`);
    }
    this.detectedDimensions = vector.length;

    if (this.cache.size >= this.maxCache) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    if (generation === this.cacheGeneration) this.cache.set(text, { vector: [...vector], ts: Date.now() });

    return vector;
  }

  get dimensions(): number | undefined {
    return this.detectedDimensions;
  }

  clearCache(): void {
    this.cacheGeneration++;
    this.cache.clear();
  }
}
