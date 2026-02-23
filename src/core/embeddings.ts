/**
 * Embeddings client with caching.
 * Supports OpenAI-compatible (/v1/embeddings) and Ollama (/api/embed) endpoints.
 */
export class EmbeddingsClient {
  private readonly embedUrl: string;
  private readonly model: string;
  private readonly isOllama: boolean;
  private cache = new Map<string, { vector: number[]; ts: number }>();
  private readonly cacheTTL = 300_000;
  private readonly maxCache = 512;

  constructor(embedUrl: string, model = "nomic-text-v1.5") {
    this.embedUrl = embedUrl;
    this.model = model;
    this.isOllama = embedUrl.includes("/api/embed");
  }

  async embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text);
    if (cached && Date.now() - cached.ts < this.cacheTTL) {
      return cached.vector;
    }

    const body = this.isOllama
      ? JSON.stringify({ model: this.model, input: text })
      : JSON.stringify({ input: text, model: this.model });

    const res = await fetch(this.embedUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) {
      throw new Error(`Embedding failed: ${res.status} ${await res.text()}`);
    }

    const json = await res.json() as Record<string, unknown>;
    let vector: number[];

    if (Array.isArray((json as { data?: unknown }).data)) {
      // OpenAI format: { data: [{ embedding: [...] }] }
      const openaiData = json as { data: Array<{ embedding: number[] }> };
      vector = openaiData.data[0].embedding;
    } else if (Array.isArray((json as { embeddings?: unknown }).embeddings)) {
      // Ollama format: { embeddings: [[...]] }
      const ollamaData = json as { embeddings: number[][] };
      vector = ollamaData.embeddings[0];
    } else if (Array.isArray((json as { embedding?: unknown }).embedding)) {
      // Single embedding format: { embedding: [...] }
      vector = (json as { embedding: number[] }).embedding;
    } else {
      throw new Error(`Unexpected embedding response format: ${JSON.stringify(json).slice(0, 200)}`);
    }

    if (this.cache.size >= this.maxCache) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    this.cache.set(text, { vector, ts: Date.now() });

    return vector;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
