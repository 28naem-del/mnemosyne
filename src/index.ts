/**
 * Mnemosyne Memory OS — Cognitive Memory for AI Agents
 *
 * Persistent, self-improving, multi-agent memory system.
 *
 * @example
 * ```typescript
 * import { createMnemosyne } from 'mnemosy-ai'
 *
 * const memory = await createMnemosyne({
 *   vectorDbUrl: 'http://localhost:6333',
 *   embeddingUrl: 'http://localhost:11434/v1/embeddings',
 *   agentId: 'my-agent',
 * })
 *
 * await memory.store("User prefers dark mode", { importance: 0.8 })
 * const results = await memory.recall("user preferences")
 * ```
 */

export type { MnemosyneConfig } from "./config.js";
export { resolveConfig } from "./config.js";
export type { MemoryCategory } from "./config.js";

// Re-export core types
export type {
  MemCell,
  MemCellSearchResult,
  MemoryType,
  UrgencyLevel,
  Domain,
  ConfidenceTag,
  Classification,
  BroadcastMessage,
  Procedure,
} from "./core/types.js";

export {
  MEMORY_TYPES,
  URGENCY_LEVELS,
  DOMAINS,
  CONFIDENCE_TAGS,
  CLASSIFICATIONS,
  DECAY_RATES,
  SOURCE_TRUST,
  DEFAULT_COLLECTIONS,
} from "./core/types.js";

// Re-export core classes
export { QdrantDB } from "./core/qdrant.js";
export { EmbeddingsClient } from "./core/embeddings.js";
export { classifyMemory } from "./core/security.js";
export { BM25Index, reciprocalRankFusion, hybridSearch } from "./core/bm25.js";

// Re-export cognitive
export { computeActivation, getDecayStatus } from "./cognitive/decay.js";
export { computeMultiSignalScore, applyDiversityReranking, detectQueryIntent } from "./cognitive/retrieval.js";
export { routeQuery, classifyExtendedIntent } from "./cognitive/intent.js";
export { computeConfidence, confidenceLabel } from "./cognitive/confidence.js";
export { runConsolidation } from "./cognitive/consolidation.js";
export { runDreamConsolidation } from "./cognitive/dream.js";
export { runPatternMining } from "./cognitive/pattern-miner.js";
export { memoryFeedback, detectFeedbackSignal } from "./cognitive/feedback.js";

// Re-export graph
export { FalkorDBClient } from "./graph/falkordb.js";
export { activationSearch } from "./graph/activation.js";
export { findAutoLinks, createBidirectionalLinks } from "./graph/autolink.js";

// Re-export broadcast
export { MemoryPublisher } from "./broadcast/publisher.js";
export { MemorySubscriber } from "./broadcast/subscriber.js";
export { SharedBlockManager } from "./broadcast/shared-blocks.js";

// Config + factory
import { resolveConfig, type MnemosyneConfig, type MemoryCategory } from "./config.js";
import { QdrantDB } from "./core/qdrant.js";
import { EmbeddingsClient } from "./core/embeddings.js";
import { classifyMemory as classifySecurity } from "./core/security.js";
import {
  isDuplicate,
  detectConflict,
  shouldSemanticMerge,
  buildMergedPayload,
} from "./core/dedup.js";
import {
  BM25Index,
  hybridSearch as doHybridSearch,
  bootstrapBM25Index,
  createQdrantTextIndex,
} from "./core/bm25.js";
import { DEFAULT_COLLECTIONS, type MemCell, type MemCellSearchResult, type BroadcastMessage } from "./core/types.js";
import {
  classifyMemoryType,
  classifyUrgency,
  classifyDomain,
  computePriorityScore,
} from "./pipeline/classifier.js";
import { extractEntities } from "./pipeline/extractor.js";
import { ExtractionClient } from "./pipeline/extractor.js";
import { LayerCache } from "./cache/layer-cache.js";
import { FalkorDBClient } from "./graph/falkordb.js";
import { findAutoLinks, createBidirectionalLinks } from "./graph/autolink.js";
import { activationSearch } from "./graph/activation.js";
import {
  computeActivation,
  getDecayStatus,
} from "./cognitive/decay.js";
import { computeConfidence } from "./cognitive/confidence.js";
import { SkillLibrary } from "./cognitive/skills.js";
import {
  routeQuery,
  INTENT_MIN_THRESHOLDS,
} from "./cognitive/intent.js";
import {
  computeMultiSignalScore,
  applyDiversityReranking,
  detectQueryIntent,
  type QueryContext,
} from "./cognitive/retrieval.js";
import { enrichWithChains, formatChainContext } from "./cognitive/chains.js";
import { memoryFeedback, detectFeedbackSignal } from "./cognitive/feedback.js";
import {
  analyzeSentiment,
  newFrustrationState,
  updateFrustration,
  computeAdaptation,
  type FrustrationState,
} from "./cognitive/sentiment.js";
import { runConsolidation } from "./cognitive/consolidation.js";
import { runDreamConsolidation, shouldRunDream, formatDreamReport } from "./cognitive/dream.js";
import { MemoryPublisher } from "./broadcast/publisher.js";
import { SharedBlockManager } from "./broadcast/shared-blocks.js";

// Prompt injection detection
const PROMPT_INJECTION_PATTERNS = [
  /ignore (all|any|previous|above|prior) instructions/i,
  /do not follow (the )?(system|developer)/i,
  /system prompt/i,
  /developer message/i,
  /<\s*(system|assistant|developer|tool|function|relevant-memories)\b/i,
  /\b(run|execute|call|invoke)\b.{0,40}\b(tool|command)\b/i,
];

export function looksLikePromptInjection(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return PROMPT_INJECTION_PATTERNS.some((p) => p.test(normalized));
}

const ESCAPE_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeMemoryForPrompt(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c);
}

function detectCategory(text: string): MemoryCategory {
  const lower = text.toLowerCase();
  if (/prefer|like|love|hate|want/i.test(lower)) return "preference";
  if (/decided|will use/i.test(lower)) return "decision";
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called/i.test(lower)) return "entity";
  if (/is|are|has|have/i.test(lower)) return "fact";
  return "other";
}

/** Options for storing a memory */
export type StoreOptions = {
  importance?: number;
  category?: MemoryCategory;
  memoryType?: string;
};

/** Options for recalling memories */
export type RecallOptions = {
  limit?: number;
  minScore?: number;
};

/** Options for forgetting a memory */
export type ForgetOptions = {
  query?: string;
  id?: string;
};

/** The Mnemosyne instance — your memory API */
export interface Mnemosyne {
  store(text: string, options?: StoreOptions): Promise<{ action: string; cell?: MemCell }>;
  recall(query: string, options?: RecallOptions): Promise<MemCellSearchResult[]>;
  forget(options: ForgetOptions): Promise<boolean>;
  update(id: string, payload: { importance?: number; category?: string }): Promise<boolean>;
  search(query: string, filters?: Record<string, unknown>): Promise<MemCellSearchResult[]>;
  stats(): Promise<{ total: number }>;
  consolidate(options?: { dryRun?: boolean }): Promise<unknown>;
  dream(): Promise<unknown>;
  feedback(userResponse: string): Promise<unknown>;
  readonly db: QdrantDB;
  readonly embeddings: EmbeddingsClient;
  readonly config: ReturnType<typeof resolveConfig>;
}

/**
 * Create a Mnemosyne memory instance.
 *
 * @example
 * ```typescript
 * const memory = await createMnemosyne({
 *   vectorDbUrl: 'http://localhost:6333',
 *   embeddingUrl: 'http://localhost:11434/v1/embeddings',
 *   agentId: 'my-agent',
 * })
 * ```
 */
export async function createMnemosyne(userConfig: MnemosyneConfig): Promise<Mnemosyne> {
  const cfg = resolveConfig(userConfig);

  const db = new QdrantDB(cfg.vectorDbUrl, cfg.agentId);
  const embeddings = new EmbeddingsClient(cfg.embeddingUrl, cfg.embeddingModel);

  let extraction: ExtractionClient | null = null;
  let falkordb: FalkorDBClient | null = null;
  let publisher: MemoryPublisher | null = null;
  let skills: SkillLibrary | null = null;
  let bm25Index: BM25Index | null = null;
  const layerCache = new LayerCache(cfg.redisUrl);

  if (cfg.enableExtraction && cfg.extractionUrl) {
    extraction = new ExtractionClient(cfg.extractionUrl);
  }
  if (cfg.enableGraph && cfg.graphUrl) {
    falkordb = new FalkorDBClient(cfg.graphUrl);
  }
  if (cfg.enableBroadcast && cfg.redisUrl) {
    publisher = new MemoryPublisher(cfg.redisUrl);
  }
  skills = new SkillLibrary(cfg.vectorDbUrl, cfg.skillsCollection);

  if (cfg.enableBM25) {
    bm25Index = new BM25Index();
    // Bootstrap asynchronously
    createQdrantTextIndex(cfg.vectorDbUrl, cfg.sharedCollection).catch(() => {});
    bootstrapBM25Index(cfg.vectorDbUrl, cfg.sharedCollection, bm25Index, 5000, 100).catch(() => {});
  }

  // Connect optional services
  if (cfg.redisUrl) {
    layerCache.connect().catch(() => {});
  }
  if (falkordb) {
    falkordb.connect().catch(() => {});
  }

  // Session state
  let lastRecalledResults: MemCellSearchResult[] = [];
  let frustrationState: FrustrationState = newFrustrationState();
  const recentTopics: string[] = [];
  const MAX_RECENT_TOPICS = 20;

  function trackQueryTopics(query: string) {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 3);
    for (const t of terms) {
      if (!recentTopics.includes(t)) {
        recentTopics.push(t);
        if (recentTopics.length > MAX_RECENT_TOPICS) recentTopics.shift();
      }
    }
  }

  // Full store pipeline
  async function fullStorePipeline(
    text: string,
    options: StoreOptions = {},
  ): Promise<{ action: string; cell?: MemCell }> {
    const classification = classifySecurity(text);
    if (classification === "secret") return { action: "blocked_secret" };

    const vector = await embeddings.embed(text);
    const collection = classification === "private" ? cfg.privateCollection : cfg.sharedCollection;
    const existing = await db.search(collection, vector, 1, 0.85);

    let mergedMeta: Record<string, unknown> = {};
    let mergedImportance: number | undefined;
    let mergedAccessCount: number | undefined;
    let mergedLinkedMemories: string[] | undefined;

    if (existing.length > 0) {
      const conflict = detectConflict(existing[0].entry.text, text, existing[0].score);
      if (conflict.isConflict && publisher) {
        await publisher.publishConflict(existing[0].entry.id, "pending", conflict.reason || "");
      }
      if (isDuplicate(existing[0].score)) {
        const earlyType = options.memoryType || classifyMemoryType(text);
        const merge = shouldSemanticMerge(existing[0], text, earlyType);
        if (merge.shouldMerge) {
          const merged = buildMergedPayload(existing[0].entry, options.importance ?? 0.7, merge);
          mergedMeta = merged.metadata;
          mergedImportance = merged.importance;
          mergedAccessCount = merged.accessCount;
          mergedLinkedMemories = merged.linkedMemories;
          await db.softDelete(collection, existing[0].entry.id);
        } else {
          return { action: "duplicate" };
        }
      }
    }

    let memoryType = (options.memoryType as MemCell["memoryType"]) || classifyMemoryType(text);
    let entities: string[] = [];

    if (extraction) {
      const result = await extraction.extract(text, { agentId: cfg.agentId });
      if (result) {
        memoryType = result.memoryType;
        entities = result.entities;
      } else {
        entities = extractEntities(text);
      }
    } else {
      entities = extractEntities(text);
    }

    const urgency = classifyUrgency(text);
    const domain = classifyDomain(text);
    const priorityScore = cfg.enablePriorityScoring ? computePriorityScore(urgency, domain) : 0.5;
    const { score: confidence, tag: confidenceTag } = cfg.enableConfidenceTags
      ? computeConfidence(0.7, 1.0, cfg.agentId)
      : { score: 0.7, tag: "grounded" as const };

    const cell = await db.store(text, vector, {
      memoryType,
      classification,
      scope: classification === "private" ? "private" : "public",
      category: options.category || detectCategory(text),
      importance: mergedImportance ?? (options.importance ?? 0.7),
      accessCount: mergedAccessCount,
      linkedMemories: mergedLinkedMemories,
      metadata: Object.keys(mergedMeta).length > 0 ? mergedMeta : undefined,
      urgency,
      domain,
      priorityScore,
      confidence,
      confidenceTag,
    });

    // Auto-link
    if (cfg.enableAutoLink) {
      try {
        const links = await findAutoLinks(cfg.vectorDbUrl, collection, vector, cell.id, cfg.autoLinkThreshold);
        if (links.linkedIds.length > 0) {
          await createBidirectionalLinks(cfg.vectorDbUrl, collection, cell.id, links.linkedIds);
          cell.linkedMemories = links.linkedIds;
        }
      } catch { /* non-fatal */ }
    }

    // Graph ingest
    if (falkordb && cfg.enableGraph) {
      try { await falkordb.ingestMemory(cell.id, text, entities, cfg.agentId); } catch { /* non-fatal */ }
    }

    // Broadcast
    if (publisher && cfg.enableBroadcast) {
      try {
        const msg: BroadcastMessage = {
          memoryId: cell.id,
          agentId: cfg.agentId,
          memoryType: cell.memoryType,
          scope: cell.scope,
          textPreview: text.slice(0, 100),
          event: "new_memory",
          linkedCount: cell.linkedMemories.length,
          timestamp: new Date().toISOString(),
        };
        await publisher.publish(msg);
      } catch { /* non-fatal */ }
    }

    // Cache invalidation
    layerCache.invalidateAll().catch(() => {});

    // BM25 index update
    if (bm25Index) bm25Index.addDocument(cell.id, text);

    return { action: "created", cell };
  }

  // Enhanced search
  async function enhancedSearch(
    query: string,
    limit = 5,
    minScore = 0.3,
  ): Promise<MemCellSearchResult[]> {
    const cached = await layerCache.get(query, limit, minScore);
    if (cached) {
      trackQueryTopics(query);
      lastRecalledResults = cached;
      return cached;
    }

    const vector = await embeddings.embed(query);

    let results: MemCellSearchResult[];
    if (bm25Index && cfg.enableBM25) {
      results = await doHybridSearch(db, bm25Index, vector, query, limit * 3, minScore);
    } else {
      results = await db.searchAll(vector, limit * 3, minScore);
    }

    trackQueryTopics(query);
    const routing = routeQuery(query);
    const intent = routing.intent;
    const strategy = routing.strategy;

    const queryContext: QueryContext = {
      queryTerms: query.toLowerCase().split(/\s+/).filter(t => t.length > 3),
      recentTopics: [...recentTopics],
    };

    if (cfg.enableDecay) {
      results = results.map((r) => {
        const createdAtMs = r.entry.createdAt ? new Date(r.entry.createdAt).getTime() : undefined;
        const activation = computeActivation(r.entry.accessTimes, r.entry.urgency, r.entry.memoryType, Date.now(), createdAtMs);
        const status = getDecayStatus(activation);
        const multiSignalScore = computeMultiSignalScore(
          r.entry, r.score, intent, Date.now(), queryContext, undefined,
          strategy.boostTypes, strategy.penalizeTypes,
        );
        return { ...r, score: multiSignalScore, activation, decayStatus: status };
      })
      .filter((r) => (r as { decayStatus: string }).decayStatus !== "archive")
      .sort((a, b) => b.score - a.score);

      const intentThreshold = INTENT_MIN_THRESHOLDS[intent] ?? 0.35;
      results = results.filter(r => r.score >= intentThreshold);
      results = applyDiversityReranking(results, limit * 2) as typeof results;
    }

    // Graph enrichment
    if (falkordb && cfg.enableGraph) {
      try {
        const graphMemories = await activationSearch(falkordb, query, 5, {
          maxDepth: cfg.spreadActivationDepth,
          decayFactor: cfg.spreadActivationDecay,
        });
        for (const gm of graphMemories) {
          if (results.some(r => r.entry.id === gm.memoryId)) continue;
          const now = new Date().toISOString();
          results.push({
            entry: {
              id: gm.memoryId,
              text: gm.text || `[Graph activation] via ${gm.sourceEntity}`,
              memoryType: "semantic",
              classification: "public",
              agentId: cfg.agentId,
              scope: "public",
              urgency: "reference",
              domain: "knowledge",
              confidence: 0.8,
              confidenceTag: "grounded",
              priorityScore: gm.activationScore * 0.7,
              importance: gm.activationScore * 0.8,
              linkedMemories: [],
              accessTimes: [],
              accessCount: 0,
              eventTime: "",
              ingestedAt: "",
              createdAt: now,
              updatedAt: now,
              deleted: false,
            },
            score: gm.activationScore * 0.7,
            source: "graph_activation",
          });
        }
      } catch { /* non-fatal */ }
    }

    // Update access times
    for (const r of results.slice(0, limit)) {
      if (r.entry.id.startsWith("graph-")) continue;
      const col = r.entry.classification === "private" ? cfg.privateCollection : cfg.sharedCollection;
      db.updateAccessTime(col, r.entry.id).catch(() => {});
    }

    const finalResults = results.slice(0, limit);
    layerCache.set(query, limit, minScore, finalResults).catch(() => {});
    lastRecalledResults = finalResults;

    return finalResults;
  }

  const mnemosyne: Mnemosyne = {
    async store(text, options = {}) {
      return fullStorePipeline(text, options);
    },

    async recall(query, options = {}) {
      const limit = options.limit ?? 5;
      const minScore = options.minScore ?? 0.3;

      if (cfg.enableSentimentTracking) {
        const adaptation = computeAdaptation(frustrationState);
        return enhancedSearch(query, Math.min(limit, adaptation.resultLimit), adaptation.minScore);
      }
      return enhancedSearch(query, limit, minScore);
    },

    async forget(options) {
      if (options.id) {
        await db.softDelete(cfg.sharedCollection, options.id);
        await db.softDelete(cfg.privateCollection, options.id).catch(() => {});
        return true;
      }
      if (options.query) {
        const results = await enhancedSearch(options.query, 1, 0.7);
        if (results.length > 0) {
          const col = results[0].entry.classification === "private" ? cfg.privateCollection : cfg.sharedCollection;
          await db.softDelete(col, results[0].entry.id);
          return true;
        }
      }
      return false;
    },

    async update(id, payload) {
      try {
        const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (payload.importance !== undefined) update.importance = payload.importance;
        if (payload.category) update.category = payload.category;
        await fetch(`${cfg.vectorDbUrl}/collections/${cfg.sharedCollection}/points/payload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wait: true, points: [id], payload: update }),
        });
        return true;
      } catch { return false; }
    },

    async search(query, filters) {
      const vector = await embeddings.embed(query);
      return db.search(cfg.sharedCollection, vector, 10, 0.3, filters);
    },

    async stats() {
      const total = await db.count(cfg.sharedCollection);
      return { total };
    },

    async consolidate(options = {}) {
      return runConsolidation(cfg.vectorDbUrl, cfg.sharedCollection);
    },

    async dream() {
      return runDreamConsolidation(cfg.vectorDbUrl, cfg.embeddingUrl, cfg.agentId, {});
    },

    async feedback(userResponse) {
      if (lastRecalledResults.length === 0) return [];
      return memoryFeedback(cfg.vectorDbUrl, cfg.sharedCollection, lastRecalledResults, userResponse);
    },

    db,
    embeddings,
    config: cfg,
  };

  return mnemosyne;
}
