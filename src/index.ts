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
 * await memory.store({ text: "User prefers dark mode", importance: 0.8 })
 * const results = await memory.recall({ query: "user preferences" })
 * ```
 */

export type { MnemosyneConfig } from "./config.js";
export { LocalMemory, createLocalMemory } from "./local/index.js";
export type { MemoryRecord, ContextPacket, MemorySnapshot } from "./local/types.js";
export { reflect, commitVerifiedLesson } from "./reflection/index.js";
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
export { maintainMemory } from "./cognitive/maintenance.js";
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
import { createHash } from "node:crypto";
import { QdrantDB } from "./core/qdrant.js";
import { EmbeddingsClient } from "./core/embeddings.js";
import { classifyMemory as classifySecurity } from "./core/security.js";
import {
  isDuplicate,
  detectConflict,
} from "./core/dedup.js";
import {
  BM25Index,
  hybridSearch as doHybridSearch,
  bootstrapBM25Index,
  type BM25BootstrapStatus,
} from "./core/bm25.js";
import { type MemCell, type MemCellSearchResult, type BroadcastMessage } from "./core/types.js";
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
import { computeFeedback, buildFeedbackPayload, detectFeedbackSignal } from "./cognitive/feedback.js";
import { maintainMemory } from "./cognitive/maintenance.js";
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
  text?: string;
  importance?: number;
  category?: MemoryCategory;
  memoryType?: string;
  metadata?: Record<string, unknown>;
};

/** Options for recalling memories */
export type RecallOptions = {
  query?: string;
  limit?: number;
  minScore?: number;
};

/** Options for forgetting a memory */
export type ForgetOptions = {
  /** @deprecated Query-based erasure is disabled. Recall, then select an explicit ID. */
  query?: string;
  id?: string;
  collection?: string;
};

/** The Mnemosyne instance — your memory API */
export interface Mnemosyne {
  store(textOrInput: string | (StoreOptions & { text: string }), options?: StoreOptions): Promise<string | null>;
  recall(queryOrInput: string | (RecallOptions & { query: string }), options?: RecallOptions): Promise<MemCellSearchResult[]>;
  forget(idOrOptions: string | ForgetOptions): Promise<boolean>;
  update(id: string, payload: { importance?: number; category?: string }): Promise<boolean>;
  search(query: string, filters?: Record<string, unknown>): Promise<MemCellSearchResult[]>;
  stats(): Promise<{ total: number }>;
  consolidate(options?: { dryRun?: boolean }): Promise<unknown>;
  dream(): Promise<unknown>;
  feedback(userResponse: string): Promise<unknown>;
  readonly db: QdrantDB;
  readonly embeddings: EmbeddingsClient;
  readonly config: ReturnType<typeof resolveConfig>;
  /** The factory awaits keyword indexing; this reports startup coverage. */
  readonly bm25Status: Readonly<{ enabled: boolean; ready: boolean; collections: readonly BM25BootstrapStatus[] }>;
}

/** Config input with convenience aliases */
export type MnemosyneConfigInput = Omit<MnemosyneConfig, 'vectorDbUrl'> & {
  vectorDbUrl?: string;
  /** Alias for vectorDbUrl */
  qdrantUrl?: string;
  /** Alias for collections.shared */
  collectionName?: string;
};

/**
 * Create a Mnemosyne memory instance.
 *
 * @example
 * ```typescript
 * const memory = await createMnemosyne({
 *   qdrantUrl: 'http://localhost:6333',
 *   embeddingUrl: 'http://localhost:11434/v1/embeddings',
 *   agentId: 'my-agent',
 * })
 * ```
 */
export async function createMnemosyne(userConfig: MnemosyneConfigInput): Promise<Mnemosyne> {
  const { qdrantUrl, collectionName, ...rest } = userConfig;
  const normalizedConfig: MnemosyneConfig = {
    ...rest,
    vectorDbUrl: rest.vectorDbUrl ?? qdrantUrl ?? "",
    ...(collectionName ? { collections: { ...rest.collections, shared: collectionName } } : {}),
  };
  const cfg = resolveConfig(normalizedConfig);

  const httpOptions = { apiKey: cfg.qdrantApiKey, timeoutMs: cfg.requestTimeoutMs };
  const db = new QdrantDB(cfg.vectorDbUrl, cfg.agentId, {
    shared: cfg.sharedCollection,
    private: cfg.privateCollection,
    profiles: cfg.profilesCollection,
    skills: cfg.skillsCollection,
  }, httpOptions);
  const embeddings = new EmbeddingsClient(cfg.embeddingUrl, cfg.embeddingModel, {
    apiKey: cfg.embeddingApiKey,
    timeoutMs: cfg.requestTimeoutMs,
    dimensions: cfg.embeddingDimensions,
  });

  // Verify the actual provider output before creating or using collections.
  const probe = await embeddings.embed("Mnemosyne embedding dimension check");
  const vectorSize = probe.length;

  // Auto-create collections if they don't exist
  await Promise.all([
    db.ensureCollection(cfg.sharedCollection, vectorSize),
    db.ensureCollection(cfg.privateCollection, vectorSize),
    db.ensureCollection(cfg.profilesCollection, vectorSize),
    db.ensureCollection(cfg.skillsCollection, vectorSize),
  ]);

  let extraction: ExtractionClient | null = null;
  let falkordb: FalkorDBClient | null = null;
  let publisher: MemoryPublisher | null = null;
  let skills: SkillLibrary | null = null;
  let bm25Index: BM25Index | null = null;
  const bm25Collections: BM25BootstrapStatus[] = [];
  const cacheNamespace = createHash("sha256").update(JSON.stringify(cfg)).digest("hex");
  const layerCache = new LayerCache(cfg.redisUrl, cacheNamespace);

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
    // In-memory BM25 does not require a Qdrant payload index. Await both scoped
    // corpora so the first recall has the same keyword coverage as later calls.
    for (const collection of [cfg.sharedCollection, cfg.privateCollection]) {
      bm25Collections.push(await bootstrapBM25Index(
        cfg.vectorDbUrl, collection, bm25Index, cfg.bm25MaxDocs, cfg.bm25BatchSize,
        undefined,
        { ...httpOptions, filters: collection === cfg.privateCollection ? { agent_id: cfg.agentId } : undefined },
      ));
    }
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
  const forgottenIds = new Set<string>();

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

    if (existing.length > 0) {
      const conflict = detectConflict(existing[0].entry.text, text, existing[0].score);
      if (conflict.isConflict && publisher) {
        await publisher.publishConflict(existing[0].entry.id, "pending", conflict.reason || "");
      }
      // Similarity alone cannot establish equivalence: changed numbers and
      // negations often have almost identical embeddings. Retain both facts.
      if (isDuplicate(existing[0].score) && existing[0].entry.text === text
          && JSON.stringify(existing[0].entry.metadata ?? {}) === JSON.stringify(options.metadata ?? {})
          && (options.importance === undefined || options.importance === existing[0].entry.importance)
          && (options.category === undefined || options.category === existing[0].entry.category)
          && (options.memoryType === undefined || options.memoryType === existing[0].entry.memoryType)) {
        return { action: "duplicate" };
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
      ? computeConfidence(0.7, 1.0, 0.8)
      : { score: 0.7, tag: "grounded" as const };

    const cell = await db.store(text, vector, {
      memoryType,
      classification,
      scope: classification === "private" ? "private" : "public",
      category: options.category || detectCategory(text),
      importance: options.importance ?? 0.7,
      metadata: options.metadata,
      urgency,
      domain,
      priorityScore,
      confidence,
      confidenceTag,
    });

    // Auto-link
    if (cfg.enableAutoLink) {
      try {
        const links = await findAutoLinks(cfg.vectorDbUrl, collection, vector, cell.id, cfg.autoLinkThreshold, 5, {
          ...httpOptions, agentId: classification === "private" ? cfg.agentId : undefined,
        });
        if (links.linkedIds.length > 0) {
          await createBidirectionalLinks(cfg.vectorDbUrl, collection, cell.id, links.linkedIds, httpOptions);
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
      // A different instance may have changed or deleted a point. Cached text
      // is never authority: hydrate live scoped records and fail closed on
      // transport errors instead of returning stale or unauthorized content.
      const checked = await Promise.all(cached.map(async result => {
        if (forgottenIds.has(result.entry.id)) return null;
        const collection = result.entry.classification === "private" ? cfg.privateCollection : cfg.sharedCollection;
        const current = await db.getScopedPoint(result.entry.id, collection);
        if (!current) {
          bm25Index?.removeDocument(result.entry.id);
          return null;
        }
        return { ...result, entry: current.cell };
      })).catch(async error => {
        for (const result of cached) bm25Index?.removeDocument(result.entry.id);
        lastRecalledResults = [];
        embeddings.clearCache();
        await layerCache.invalidateAll();
        throw error;
      });
      const visible = checked.filter((result): result is MemCellSearchResult => result !== null);
      await layerCache.set(query, limit, minScore, visible);
      trackQueryTopics(query);
      lastRecalledResults = visible;
      return visible;
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
          // The graph supplies candidate IDs only; its text and ownership
          // cannot override the authoritative scoped Qdrant record.
          const stored = await db.getScopedPoint(gm.memoryId);
          if (!stored || gm.activationScore * 0.7 < minScore) continue;
          results.push({
            entry: stored.cell,
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

    const finalResults = results.filter(result => !forgottenIds.has(result.entry.id)).slice(0, limit);
    layerCache.set(query, limit, minScore, finalResults).catch(() => {});
    lastRecalledResults = finalResults;

    return finalResults;
  }

  async function findStoredMemory(id: string): Promise<{ collection: string; cell: MemCell } | null> {
    return db.getScopedPoint(id);
  }

  const mnemosyne: Mnemosyne = {
    async store(textOrInput, options = {}) {
      let text: string;
      let opts: StoreOptions;
      if (typeof textOrInput === "string") {
        text = textOrInput;
        opts = options;
      } else {
        text = textOrInput.text;
        opts = textOrInput;
      }
      const result = await fullStorePipeline(text, opts);
      if (result.action === "created" && result.cell) return result.cell.id;
      return null;
    },

    async recall(queryOrInput, options = {}) {
      let query: string;
      let opts: RecallOptions;
      if (typeof queryOrInput === "string") {
        query = queryOrInput;
        opts = options;
      } else {
        query = queryOrInput.query;
        opts = queryOrInput;
      }
      const limit = opts.limit ?? 5;
      const minScore = opts.minScore ?? 0.3;

      if (cfg.enableSentimentTracking) {
        const adaptation = computeAdaptation(frustrationState);
        return enhancedSearch(query, Math.min(limit, adaptation.resultLimit), opts.minScore ?? adaptation.minScore);
      }
      return enhancedSearch(query, limit, minScore);
    },

    async forget(idOrOptions) {
      const opts: ForgetOptions = typeof idOrOptions === "string" ? { id: idOrOptions } : idOrOptions;
      if (!opts.id?.trim()) {
        throw new Error("Forget requires an explicit memory ID. Query-based erasure is disabled; recall and review candidates first. No deletion was attempted.");
      }
      if (falkordb || publisher) {
        throw new Error("Forget with graph or broadcast replicas is not supported by this backend; no deletion was attempted. Disable those integrations only after separately removing their copies.");
      }
      if (cfg.redisUrl && !layerCache.l2.isAvailable) {
        throw new Error("Redis cache is unavailable; cached-copy erasure cannot be verified. No deletion was attempted.");
      }
      const id = opts.id;
      if (!await db.deleteScopedPoint(id, opts.collection)) return false;
      forgottenIds.add(id);
      bm25Index?.removeDocument(id);
      embeddings.clearCache();
      recentTopics.length = 0;
      lastRecalledResults = lastRecalledResults.filter(result => result.entry.id !== id);
      await layerCache.invalidateAll(true);
      return true;
    },

    async update(id, payload) {
      try {
        const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (payload.importance !== undefined) update.importance = payload.importance;
        if (payload.category) update.category = payload.category;
        const stored = await findStoredMemory(id);
        if (!stored || stored.cell.deleted) return false;
        await db.updatePayload(stored.collection, id, update);
        await layerCache.invalidateAll();
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
      const report = await maintainMemory(db, options);
      if (!options.dryRun) await layerCache.invalidateAll();
      return report;
    },

    async dream() {
      const started = Date.now();
      const report = await maintainMemory(db);
      await layerCache.invalidateAll();
      return {
        phase: "complete", startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(),
        durationMs: Date.now() - started, errors: [], maintenance: report,
        stats: {
          memoriesScanned: report.analyzed, duplicatesMerged: 0, staleArchived: 0, contradictionsResolved: 0,
          promoted: 0, demoted: report.staleDemoted, strengthened: report.strengthened,
          patternsDiscovered: 0, lessonsAbstracted: 0, spaceSavedBytes: 0,
        },
      };
    },

    async feedback(userResponse) {
      if (lastRecalledResults.length === 0) return [];
      const signal = detectFeedbackSignal(userResponse);
      const applied = [];
      for (const recalled of lastRecalledResults) {
        if (forgottenIds.has(recalled.entry.id)) continue;
        const stored = await findStoredMemory(recalled.entry.id);
        if (!stored || stored.cell.deleted) continue;
        const feedback = computeFeedback(stored.cell, signal);
        await db.updatePayload(stored.collection, stored.cell.id, buildFeedbackPayload(feedback, stored.cell.metadata));
        applied.push(feedback);
      }
      await layerCache.invalidateAll();
      return applied;
    },

    db,
    embeddings,
    config: cfg,
    bm25Status: Object.freeze({ enabled: cfg.enableBM25, ready: true, collections: Object.freeze(bm25Collections.map(status => Object.freeze(status))) }),
  };

  return mnemosyne;
}

export default createMnemosyne;
