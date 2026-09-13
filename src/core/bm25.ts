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
import { qdrantRequest, type HttpOptions } from "./http.js";

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

export interface BM25BootstrapStatus {
  collection: string;
  loaded: number;
  scanned: number;
  truncated: boolean;
  nextOffset: string | number | null;
}

export interface BM25BootstrapOptions extends HttpOptions {
  filters?: Record<string, unknown>;
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
  keywordEntries: MemCellSearchResult[] = [],
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

  for (const entry of keywordEntries) {
    if (!scores.has(entry.entry.id)) {
      scores.set(entry.entry.id, { vectorRank: -1, bm25Rank: -1, score: 0, entry });
    }
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
    qdrant.searchAll(queryVector, limit * 3, minScore, filters),
    Promise.resolve(bm25Index.search(queryText, limit * 3)),
  ]);

  // If BM25 found nothing extra, just return vector results
  if (bm25Results.length === 0) {
    return vectorResults.slice(0, limit);
  }

  // Hydrate exact lexical matches that did not clear the vector threshold.
  const vectorIds = new Set(vectorResults.map(result => result.entry.id));
  const missingIds = bm25Results.map(result => result.pointId).filter(id => !vectorIds.has(id));
  const keywordCells = missingIds.length ? await qdrant.getSearchCandidates(missingIds, filters) : [];
  const queryTerms = new Set(keywordCells.length ? bm25Index.tokenize(queryText) : []);
  const keywordEntries: MemCellSearchResult[] = keywordCells.map(entry => {
    const terms = new Set(bm25Index.tokenize(entry.text));
    const matched = [...queryTerms].filter(term => terms.has(term)).length;
    // Query coverage is bounded relevance, not a cosine similarity estimate.
    return { entry, score: queryTerms.size ? matched / queryTerms.size : 0, source: "bm25" as const };
  }).filter(result => result.score >= minScore);
  const fused = reciprocalRankFusion(vectorResults, bm25Results, 60, keywordEntries);

  // RRF controls order. Preserve relevance on the original [0,1] scale for
  // downstream thresholds and multi-signal reranking (RRF is only ~0.03).
  return fused.slice(0, limit).map(h => ({
    ...h.entry,
    retrievalSignals: {
      vectorSimilarity: h.vectorRank > 0 ? h.entry.score : undefined,
      keywordScore: bm25Results.find(result => result.pointId === h.pointId)?.score,
      rrfScore: h.fusedScore,
    },
  }));
}

/**
 * Bootstrap the BM25 index from Qdrant scroll API.
 * Resolves only when scanning finishes. A corpus limit is reported explicitly;
 * transport errors reject instead of exposing a silently partial index.
 */
export async function bootstrapBM25Index(
  qdrantUrl: string,
  collection: string,
  bm25Index: BM25Index,
  maxDocs = 5000,
  batchSize = 100,
  logger?: { info: (msg: string) => void; warn?: (msg: string) => void },
  options: BM25BootstrapOptions = {},
): Promise<BM25BootstrapStatus> {
  if (!Number.isSafeInteger(maxDocs) || maxDocs <= 0 || !Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new Error("BM25 maxDocs and batchSize must be positive safe integers");
  }
  let loaded = 0;
  let scanned = 0;
  let offset: string | number | null = null;

  while (scanned < maxDocs) {
    const remaining = Math.min(batchSize, maxDocs - scanned);
    const body: Record<string, unknown> = {
      limit: remaining,
      filter: { must: [
        { key: "deleted", match: { value: false } },
        ...Object.entries(options.filters ?? {}).map(([key, value]) => ({ key, match: { value } })),
      ] },
      with_payload: { include: ["text", "content"] },
      with_vector: false,
    };
    if (offset !== null) {
      body.offset = offset;
    }

    const res = await qdrantRequest(qdrantUrl, `/collections/${encodeURIComponent(collection)}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, options);

    const data = (await res.json()) as {
      result: {
        points: Array<{ id: string; payload: Record<string, unknown> }>;
        next_page_offset?: string | number | null;
      };
    };

    const points = data.result.points || [];
    if (points.length === 0) { offset = null; break; }
    scanned += points.length;

    for (const point of points) {
      const text = (point.payload.text as string) || (point.payload.content as string) || "";
      if (text) {
        bm25Index.addDocument(String(point.id), text);
        loaded++;
      }
    }

    const nextOffset = data.result.next_page_offset ?? null;
    if (nextOffset !== null && nextOffset === offset) throw new Error("Qdrant BM25 scroll cursor did not advance");
    offset = nextOffset;
    if (offset === null) break;
  }

  logger?.info(`bm25: bootstrapped ${loaded} docs (${bm25Index.stats().termCount} terms)`);
  const truncated = offset !== null;
  if (truncated) {
    const warning = `bm25: ${collection} reached its ${maxDocs}-point startup limit; keyword search covers only the loaded portion. Increase bm25MaxDocs to index the remainder.`;
    if (logger?.warn) logger.warn(warning);
    else console.warn(warning);
  }
  return { collection, loaded, scanned, truncated, nextOffset: offset };
}

/**
 * Create a full-text payload index on the 'text' field in Qdrant.
 * Idempotent — Qdrant ignores if index already exists.
 */
export async function createQdrantTextIndex(
  qdrantUrl: string,
  collection: string,
  logger?: { info: (msg: string) => void },
  options: HttpOptions = {},
): Promise<void> {
  await qdrantRequest(qdrantUrl, `/collections/${encodeURIComponent(collection)}/index`, {
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
  }, options);
  logger?.info(`bm25: text index created/verified on ${collection}`);
}
