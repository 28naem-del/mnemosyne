/**
 * BM25 Hybrid Search
 *
 * In-memory BM25 inverted index + Reciprocal Rank Fusion (RRF)
 * to merge vector search and keyword search results.
 *
 * Catches exact matches that embeddings miss:
 * IP addresses, port numbers, error codes, version strings.
 *
 * Zero npm dependencies. Zero LLM calls.
 */

import type { MemCellSearchResult } from "./types.js";
import type { QdrantDB } from "./qdrant.js";

/** Term frequency statistics for a single document */
interface TermStats {
  tf: number;       // term frequency in this document
  docLen: number;   // total tokens in this document
}

/** Inverted index entry */
interface PostingEntry {
  pointId: string;
  tf: number;
  docLen: number;
}

/** BM25 tuning parameters */
interface BM25Params {
  k1: number;  // term saturation, default 1.2
  b: number;   // length normalization, default 0.75
}

/** A single scored result from BM25 */
export interface BM25Result {
  pointId: string;
  score: number;
}

/** Fused result combining vector + BM25 */
export interface HybridResult {
  pointId: string;
  vectorRank: number;
  bm25Rank: number;
  fusedScore: number;  // RRF score
  entry: MemCellSearchResult;
}

export class BM25Index {
  private index: Map<string, PostingEntry[]>;  // term → postings
  private docCount: number;
  private totalDocLen: number;  // sum of all doc lengths for avg calculation
  private docTerms: Map<string, string[]>;  // pointId → tokens (for removal)
  private params: BM25Params;

  constructor(params?: Partial<BM25Params>) {
    this.index = new Map();
    this.docCount = 0;
    this.totalDocLen = 0;
    this.docTerms = new Map();
    this.params = {
      k1: params?.k1 ?? 1.2,
      b: params?.b ?? 0.75,
    };
  }

  /** Tokenize text: lowercase, strip punctuation, split on whitespace.
   *  Preserves IPs, version numbers, and technical tokens. */
  tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s.\-:/]/g, " ")  // keep dots, hyphens, colons, slashes for IPs/versions
      .split(/\s+/)
      .filter(t => t.length > 0)
      .map(t => t.replace(/^[.\-:]+|[.\-:]+$/g, ""));  // trim leading/trailing special chars
  }

  /** Add a document to the in-memory inverted index */
  addDocument(pointId: string, text: string): void {
    // Remove existing if present (idempotent)
    if (this.docTerms.has(pointId)) {
      this.removeDocument(pointId);
    }

    const tokens = this.tokenize(text);
    if (tokens.length === 0) return;

    this.docTerms.set(pointId, tokens);
    this.docCount++;
    this.totalDocLen += tokens.length;

    // Count term frequencies
    const tfMap = new Map<string, number>();
    for (const token of tokens) {
      tfMap.set(token, (tfMap.get(token) || 0) + 1);
    }

    // Update inverted index
    for (const [term, tf] of tfMap) {
      let postings = this.index.get(term);
      if (!postings) {
        postings = [];
        this.index.set(term, postings);
      }
      postings.push({ pointId, tf, docLen: tokens.length });
    }
  }

  /** Remove a document from the index */
  removeDocument(pointId: string): void {
    const tokens = this.docTerms.get(pointId);
    if (!tokens) return;

    this.docCount--;
    this.totalDocLen -= tokens.length;
    this.docTerms.delete(pointId);

    // Remove from inverted index
    const termsToClean = new Set(tokens);
    for (const term of termsToClean) {
      const postings = this.index.get(term);
      if (!postings) continue;
      const filtered = postings.filter(p => p.pointId !== pointId);
      if (filtered.length === 0) {
        this.index.delete(term);
      } else {
        this.index.set(term, filtered);
      }
    }
  }

  /** Score a query against all indexed documents */
  search(query: string, limit: number): BM25Result[] {
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0 || this.docCount === 0) return [];

    const avgDocLen = this.totalDocLen / this.docCount;
    const { k1, b } = this.params;
    const N = this.docCount;

    // Accumulate scores per document
    const scores = new Map<string, number>();

    for (const term of queryTokens) {
      const postings = this.index.get(term);
      if (!postings) continue;

      const df = postings.length;
      // BM25 IDF: log((N - df + 0.5) / (df + 0.5) + 1)
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      for (const posting of postings) {
        const tfNorm = (posting.tf * (k1 + 1)) /
          (posting.tf + k1 * (1 - b + b * posting.docLen / avgDocLen));
        const contribution = idf * tfNorm;

        scores.set(
          posting.pointId,
          (scores.get(posting.pointId) || 0) + contribution,
        );
      }
    }

    // Sort by score descending, take top limit
    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([pointId, score]) => ({ pointId, score }));
  }

  /** Bulk-load documents (called at startup or cache rebuild) */
  bulkLoad(docs: Array<{ id: string; text: string }>): void {
    for (const doc of docs) {
      this.addDocument(doc.id, doc.text);
    }
  }

  /** Return index stats */
  stats(): { docCount: number; termCount: number; avgDocLen: number } {
    return {
      docCount: this.docCount,
      termCount: this.index.size,
      avgDocLen: this.docCount > 0 ? this.totalDocLen / this.docCount : 0,
    };
  }
}

/**
 * Reciprocal Rank Fusion: merges vector + BM25 ranked lists.
 * RRF(d) = Σ 1/(k + rank_i(d))  where k=60 (standard constant)
 */
export function reciprocalRankFusion(
  vectorResults: MemCellSearchResult[],
  bm25Results: BM25Result[],
  k = 60,
): HybridResult[] {
  const scores = new Map<string, { vectorRank: number; bm25Rank: number; score: number; entry?: MemCellSearchResult }>();

  // Score vector results
  for (let rank = 0; rank < vectorResults.length; rank++) {
    const id = vectorResults[rank].entry.id;
    const existing = scores.get(id) || { vectorRank: -1, bm25Rank: -1, score: 0 };
    existing.vectorRank = rank + 1;
    existing.score += 1.0 / (k + rank + 1);
    existing.entry = vectorResults[rank];
    scores.set(id, existing);
  }

  // Score BM25 results
  for (let rank = 0; rank < bm25Results.length; rank++) {
    const id = bm25Results[rank].pointId;
    const existing = scores.get(id) || { vectorRank: -1, bm25Rank: -1, score: 0 };
    existing.bm25Rank = rank + 1;
    existing.score += 1.0 / (k + rank + 1);
    scores.set(id, existing);
  }

  // Sort by fused score descending
  return Array.from(scores.entries())
    .filter(([, v]) => v.entry != null)  // only return entries we have full data for
    .sort((a, b) => b[1].score - a[1].score)
    .map(([pointId, v]) => ({
      pointId,
      vectorRank: v.vectorRank,
      bm25Rank: v.bm25Rank,
      fusedScore: v.score,
      entry: v.entry!,
    }));
}

/**
 * Run hybrid search: vector search + BM25, fused via RRF.
 * Returns top-limit results sorted by fusedScore descending.
 */
export async function hybridSearch(
  qdrant: QdrantDB,
  bm25Index: BM25Index,
  queryVector: number[],
  queryText: string,
  limit: number,
  minScore: number,
  filters?: Record<string, unknown>,
): Promise<MemCellSearchResult[]> {
  // Run vector search and BM25 in parallel
  const [vectorResults, bm25Results] = await Promise.all([
    qdrant.searchAll(queryVector, limit * 3, minScore),
    Promise.resolve(bm25Index.search(queryText, limit * 3)),
  ]);

  // If BM25 found nothing extra, just return vector results
  if (bm25Results.length === 0) {
    return vectorResults.slice(0, limit);
  }

  // Fuse with RRF
  const fused = reciprocalRankFusion(vectorResults, bm25Results);

  // Map back to MemCellSearchResult format, using fused score
  return fused.slice(0, limit).map(h => ({
    entry: h.entry.entry,
    score: h.fusedScore,
    source: h.entry.source,
  }));
}

/**
 * Bootstrap the BM25 index from Qdrant scroll API.
 * Loads up to maxDocs documents in batches, non-blocking.
 */
export async function bootstrapBM25Index(
  qdrantUrl: string,
  collection: string,
  bm25Index: BM25Index,
  maxDocs = 5000,
  batchSize = 100,
  logger?: { info: (msg: string) => void },
): Promise<void> {
  let loaded = 0;
  let offset: string | number | null = null;

  while (loaded < maxDocs) {
    const remaining = Math.min(batchSize, maxDocs - loaded);
    const body: Record<string, unknown> = {
      limit: remaining,
      filter: { must: [{ key: "deleted", match: { value: false } }] },
      with_payload: { include: ["text"] },
      with_vector: false,
    };
    if (offset !== null) {
      body.offset = offset;
    }

    try {
      const res = await fetch(`${qdrantUrl}/collections/${collection}/points/scroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) break;

      const data = (await res.json()) as {
        result: {
          points: Array<{ id: string; payload: Record<string, unknown> }>;
          next_page_offset?: string | number | null;
        };
      };

      const points = data.result.points || [];
      if (points.length === 0) break;

      for (const point of points) {
        const text = (point.payload.text as string) || (point.payload.content as string) || "";
        if (text) {
          bm25Index.addDocument(String(point.id), text);
          loaded++;
        }
      }

      offset = data.result.next_page_offset ?? null;
      if (offset === null) break;
    } catch {
      break;
    }
  }

  logger?.info(`bm25: bootstrapped ${loaded} docs (${bm25Index.stats().termCount} terms)`);
}

/**
 * Create a full-text payload index on the 'text' field in Qdrant.
 * Idempotent — Qdrant ignores if index already exists.
 */
export async function createQdrantTextIndex(
  qdrantUrl: string,
  collection: string,
  logger?: { info: (msg: string) => void },
): Promise<void> {
  try {
    const res = await fetch(`${qdrantUrl}/collections/${collection}/index`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        field_name: "text",
        field_schema: {
          type: "text",
          tokenizer: "word",
          min_token_len: 2,
          max_token_len: 40,
          lowercase: true,
        },
      }),
    });
    if (res.ok) {
      logger?.info(`bm25: text index created/verified on ${collection}`);
    }
  } catch {
    // Non-fatal — BM25 in-memory index still works without Qdrant text index
  }
}
