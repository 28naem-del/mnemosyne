/**
 * OpenAI-compatible embeddings client with caching.
 * Works with any provider exposing /v1/embeddings endpoint.
 */
export class EmbeddingsClient {
  private readonly embedUrl: string;
  private readonly model: string;
  private cache = new Map<string, { vector: number[]; ts: number }>();
  private readonly cacheTTL = 300_000;
  private readonly maxCache = 512;

  constructor(embedUrl: string, model = "nomic-text-v1.5") {
    this.embedUrl = embedUrl;
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    const cached = this.cache.get(text);
    if (cached && Date.now() - cached.ts < this.cacheTTL) {
      return cached.vector;
    }

    const res = await fetch(this.embedUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text, model: this.model }),
    });
    if (!res.ok) {
      throw new Error(`Embedding failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    const vector = data.data[0].embedding;

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
