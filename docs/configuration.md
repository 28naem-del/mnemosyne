# Configuration Reference

Mnemosyne is controlled through a single configuration object passed to `createMnemosyne()`. Every cognitive feature is independently toggleable, allowing you to start with bare vector storage and progressively enable the full cognitive OS as your needs grow. There is no all-or-nothing commitment -- you adopt exactly what you need.

```typescript
import { createMnemosyne } from 'mnemosy-ai'

const mnemosyne = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'my-agent',
  // ... additional options
})
```

The config object is validated at initialization. Missing required fields throw a clear error. Optional fields fall back to sensible defaults. Environment variables serve as a secondary source when explicit values are not provided.

---

## Full TypeScript Interface

The complete configuration interface with JSDoc annotations:

```typescript
interface MnemosyneConfig {
  // ── Infrastructure Endpoints ──────────────────────────────────────

  /**
   * Qdrant vector database endpoint URL.
   * Primary storage backend for all memory collections (shared, private,
   * agent profiles, skill library). Mnemosyne creates and manages its own
   * collections automatically on first run.
   *
   * @required
   * @example 'http://localhost:6333'
   * @example 'http://qdrant-cluster.internal:6333'
   */
  vectorDbUrl: string

  /**
   * OpenAI-compatible embedding API endpoint.
   * Must accept POST requests in the standard OpenAI /v1/embeddings format
   * and return 768-dimensional vectors. Nomic text architecture is recommended
   * for optimal performance with the default similarity thresholds.
   *
   * Compatible services: Ollama, MLX Embed Server, vLLM, OpenAI API,
   * Cohere Embed, Voyage AI, or any /v1/embeddings-compatible endpoint.
   *
   * @required
   * @example 'http://localhost:11434/v1/embeddings'
   * @example 'https://api.openai.com/v1/embeddings'
   */
  embeddingUrl: string

  /**
   * FalkorDB or RedisGraph endpoint for the temporal knowledge graph.
   * Enables entity-relationship storage, temporal queries, path finding,
   * and timeline reconstruction. When absent, all graph features are
   * silently skipped -- the rest of the system functions normally.
   *
   * @optional
   * @default undefined (graph features disabled)
   * @example 'redis://localhost:6380'
   */
  graphDbUrl?: string

  /**
   * Redis endpoint for L2 distributed cache and pub/sub broadcast.
   * When provided, enables two independent capabilities:
   *   1. L2 cache -- shared query result cache with 1-hour TTL
   *   2. Pub/sub -- real-time memory event broadcast across agent mesh
   *
   * When absent, L1 in-process cache still operates. Broadcast and
   * Mesh Sync features are silently disabled.
   *
   * @optional
   * @default undefined (L2 cache and broadcast disabled)
   * @example 'redis://localhost:6379'
   */
  cacheUrl?: string

  /**
   * External extraction service endpoint. When provided, Mnemosyne
   * delegates entity extraction and metadata enrichment to this service
   * instead of using the built-in zero-LLM extraction pipeline.
   *
   * The built-in pipeline is fully capable for most use cases. This option
   * exists for specialized extraction needs or integration with existing
   * NLP infrastructure.
   *
   * @optional
   * @default undefined (uses built-in extraction)
   * @example 'http://localhost:1995/extract'
   */
  extractionUrl?: string

  // ── Identity ──────────────────────────────────────────────────────

  /**
   * Unique identifier for this agent instance. Used for memory provenance
   * tracking, private collection scoping, multi-agent awareness features,
   * pub/sub channel subscription, and session snapshot recovery.
   *
   * In a multi-agent mesh, every agent must have a distinct agentId while
   * sharing the same infrastructure endpoints.
   *
   * @required
   * @example 'devops-agent-01'
   * @example 'research-assistant'
   */
  agentId: string

  // ── Feature Toggles ───────────────────────────────────────────────

  /**
   * Automatically extract and store noteworthy memories from conversations
   * during the agent_end lifecycle hook. Identifies up to 3 salient facts,
   * decisions, or behavioral patterns per conversation and runs them through
   * the full 12-step ingestion pipeline.
   *
   * @default true
   */
  autoCapture?: boolean

  /**
   * Automatically recall relevant memories before agent start via the
   * before_agent_start lifecycle hook. Recovers previous session context,
   * searches for relevant memories, generates proactive queries, and
   * injects everything as prepended context.
   *
   * @default true
   */
  autoRecall?: boolean

  /**
   * Enable temporal knowledge graph integration. When active, ingestion
   * runs graph entity extraction and relationship storage (pipeline step 11).
   * Recall results are enriched with graph context. Requires graphDbUrl.
   *
   * Degrades gracefully: if true but graphDbUrl is not set, graph features
   * are silently skipped.
   *
   * @default true
   */
  enableGraph?: boolean

  /**
   * Enable automatic bidirectional linking between related memories.
   * During ingestion (pipeline step 10), new memories are compared against
   * existing memories. Pairs exceeding the autoLinkThreshold cosine
   * similarity are linked in both directions, building a Zettelkasten-style
   * knowledge web used by Flash Reasoning chains.
   *
   * @default true
   */
  enableAutoLink?: boolean

  /**
   * Enable activation decay model. Memories have activation levels that
   * decay logarithmically over time, with rates determined by urgency level.
   * Each access refreshes activation. Core and procedural memory types are
   * always immune to decay regardless of this setting.
   *
   * When disabled, all memories remain permanently active with no time-based
   * scoring penalty.
   *
   * @default true
   */
  enableDecay?: boolean

  /**
   * Enable cross-agent pub/sub broadcast. Memory events (store, update,
   * delete, conflict detection) are published to typed Redis channels.
   * Critical memories receive priority routing. Requires cacheUrl.
   *
   * Degrades gracefully: if true but cacheUrl is not set, broadcast is
   * silently skipped.
   *
   * @default true
   */
  enableBroadcast?: boolean

  /**
   * Enable urgency x domain priority scoring during ingestion (pipeline
   * step 7). Produces a composite 0.0-1.0 score from urgency classification
   * and domain classification. Influences retrieval ranking via the
   * importance x confidence signal.
   *
   * When disabled, all memories receive a default priority score of 0.5.
   *
   * @default true
   */
  enablePriorityScoring?: boolean

  /**
   * Enable the 4-tier confidence rating system during ingestion (pipeline
   * step 8). Confidence is computed from retrieval quality (50%),
   * cross-agent agreement (30%), and source trust (20%). Produces both
   * a numeric score and a human-readable tag (Mesh Fact, Grounded,
   * Inferred, Uncertain).
   *
   * When disabled, all memories receive a default confidence of 0.5 and
   * no confidence tag.
   *
   * @default true
   */
  enableConfidenceTags?: boolean

  // ── Tuning Parameters ─────────────────────────────────────────────

  /**
   * Minimum cosine similarity required for automatic bidirectional linking
   * between memories. Lower values create more connections (denser knowledge
   * graph, more noise). Higher values create fewer connections (sparser
   * graph, higher precision).
   *
   * @default 0.70
   * @min 0.0
   * @max 1.0
   */
  autoLinkThreshold?: number

  /**
   * Maximum characters per auto-captured memory during the agent_end
   * lifecycle hook. Longer observations are truncated to this limit.
   * Increase for agents that handle long-form content; decrease for agents
   * that process many short interactions.
   *
   * @default 500
   */
  captureMaxChars?: number
}
```

---

## Infrastructure Endpoints

Infrastructure endpoints tell Mnemosyne where its backing services live. Two are required, three are optional. Mnemosyne degrades gracefully when optional services are absent -- features that depend on them are silently skipped, and the rest of the system functions normally.

### `vectorDbUrl` (required)

The Qdrant vector database endpoint. This is the primary storage backend for all four memory collections: shared memories, private memories, agent profiles, and the skill library. Mnemosyne creates and manages its own collections automatically on first initialization.

```typescript
vectorDbUrl: 'http://localhost:6333'
```

Qdrant must be running and reachable before `createMnemosyne()` is called. Mnemosyne will validate the connection at startup and throw if Qdrant is unreachable. Supports Qdrant Cloud URLs, local instances, and Docker containers.

**What depends on it:** Everything. The vector store is the only hard infrastructure dependency. Every feature in Mnemosyne reads from or writes to Qdrant.

### `embeddingUrl` (required)

Any OpenAI-compatible `/v1/embeddings` endpoint. Mnemosyne sends POST requests in the standard OpenAI format and expects 768-dimensional vectors in the response. The endpoint must be reachable at initialization time.

```typescript
embeddingUrl: 'http://localhost:11434/v1/embeddings'
```

Compatible services include:

| Service | Type | Notes |
|---------|------|-------|
| Ollama (`nomic-embed-text`) | Local, free | Recommended for development |
| MLX Embed Server | Local, free | Apple Silicon optimized |
| vLLM | Local, free | GPU-accelerated |
| OpenAI API | Cloud, paid | `text-embedding-3-small` or similar |
| Cohere Embed | Cloud, paid | Via OpenAI-compatible proxy |
| Voyage AI | Cloud, paid | Via OpenAI-compatible proxy |

768-dimensional Nomic text architecture is recommended. The default similarity thresholds (0.70 for auto-linking, 0.92 for deduplication) are calibrated for this embedding space. If you use a different embedding model or dimensionality, you may need to adjust these thresholds accordingly.

**What depends on it:** Every store and recall operation. Embeddings are generated for both ingestion (to store vectors) and retrieval (to search by similarity).

### `graphDbUrl` (optional)

FalkorDB or RedisGraph endpoint for the temporal knowledge graph. When provided, enables entity-relationship storage, temporal queries ("What was X connected to as of date Y?"), path finding between entities, and timeline reconstruction.

```typescript
graphDbUrl: 'redis://localhost:6380'
```

When absent, all graph-dependent features are silently skipped. The 12-step ingestion pipeline runs steps 1-10 and 12, skipping step 11 (graph ingestion). Recall results omit graph enrichment. Everything else works normally.

**What depends on it:** Temporal graph queries, graph-based entity extraction and relationship storage, path finding between entities, timeline reconstruction.

### `cacheUrl` (optional)

Redis endpoint. When provided, enables two independent capabilities:

1. **L2 distributed cache** -- Shared query result cache with 1-hour TTL and pattern-based invalidation. Works alongside the always-active L1 in-process cache for sub-10ms repeated lookups across all agents.
2. **Pub/sub broadcast** -- Real-time memory event propagation across the agent mesh. Required for cross-agent features including Mesh Sync shared blocks, cross-agent corroboration, and fleet-level synthesis.

```typescript
cacheUrl: 'redis://localhost:6379'
```

When absent, L1 in-process cache still operates (50 entries, 5-minute TTL). Broadcast, Mesh Sync, and cross-agent corroboration features are silently disabled. Individual agent memory operations are fully functional.

**What depends on it:** L2 distributed cache, pub/sub broadcast, Mesh Sync shared blocks, cross-agent corroboration, fleet-level synthesis.

### `extractionUrl` (optional)

External extraction service endpoint. When provided, Mnemosyne delegates entity extraction and metadata enrichment to this service instead of using the built-in zero-LLM extraction pipeline.

```typescript
extractionUrl: 'http://localhost:1995/extract'
```

The built-in extraction pipeline is fully capable for most use cases -- it handles entity extraction (people, machines, technologies, IPs, dates, ports, URLs), type classification, urgency detection, and domain classification, all algorithmically with zero LLM calls. The external service option exists for specialized extraction needs, custom entity types, or integration with an existing NLP infrastructure.

When absent, the built-in pipeline handles all extraction. No functionality is lost.

**What depends on it:** Nothing requires it. This is purely an override mechanism.

---

## Identity

### `agentId` (required)

A unique string identifier for this agent instance. This is the agent's identity within the Mnemosyne system and is used across multiple subsystems:

- **Memory provenance** -- Every stored memory records which agent created it via the `botId` field.
- **Private collection scoping** -- Each agent gets its own private memory collection, isolated from other agents.
- **Agent Awareness Engine** -- Other agents can query "What does agent X know about topic Y?" using this identifier.
- **Pub/sub channels** -- The agent subscribes to broadcast channels using this ID.
- **Session recovery** -- Session snapshots are stored and retrieved by agent ID, enabling continuity across context resets.

```typescript
agentId: 'devops-agent-01'
```

In a multi-agent mesh, every agent must have a **distinct** `agentId` while pointing to the **same** Qdrant, Redis, and FalkorDB instances. This is what allows agents to share memories while maintaining individual identity.

Naming conventions are up to you. Some common patterns:

```typescript
agentId: 'research-assistant'         // Role-based
agentId: 'agent-node-03'              // Numbered
agentId: 'server-1-devops'            // Machine + role
agentId: 'customer-support-tier-2'    // Function + tier
```

---

## Feature Toggles

All feature toggles are boolean values. All default to `true`. Set any toggle to `false` to disable that specific feature independently without affecting anything else. This is the core of Mnemosyne's progressive adoption model -- you never pay for features you are not using.

### `autoCapture`

| Property | Value |
|----------|-------|
| **Type** | `boolean` |
| **Default** | `true` |
| **Infrastructure** | Qdrant only |

Controls automatic memory extraction from conversations during the `agent_end` lifecycle hook. When enabled, Mnemosyne analyzes completed conversations, identifies up to 3 noteworthy facts, decisions, or behavioral patterns, and stores each through the full 12-step ingestion pipeline.

**When enabled:** Conversations automatically produce persistent memories. The agent learns from every interaction without explicit `memory_store` calls. Extracted observations are capped at `captureMaxChars` characters each.

**When disabled:** Memories are only stored through explicit `memory_store` tool calls. The agent_end hook still fires for session snapshot saving but skips observation extraction. Useful when you want full manual control over what gets stored.

```typescript
autoCapture: false  // Only store memories via explicit tool calls
```

### `autoRecall`

| Property | Value |
|----------|-------|
| **Type** | `boolean` |
| **Default** | `true` |
| **Infrastructure** | Qdrant only |

Controls automatic memory retrieval before agent invocation via the `before_agent_start` lifecycle hook. When enabled, Mnemosyne performs four operations before the agent sees the user's prompt:

1. Recovers previous session context (if a session snapshot exists)
2. Searches for memories relevant to the current prompt
3. Generates proactive queries to surface related context the user did not explicitly ask about
4. Injects all recovered and recalled memories as prepended context

**When enabled:** The agent starts every conversation with relevant history already loaded. Eliminates the cold-start problem. Enables session continuity across context window resets.

**When disabled:** The agent starts with no pre-loaded context. Memories are only retrieved through explicit `memory_recall` tool calls. Useful for agents that need deterministic, controlled retrieval or for debugging.

```typescript
autoRecall: false  // Agent starts with a blank slate each time
```

### `enableGraph`

| Property | Value |
|----------|-------|
| **Type** | `boolean` |
| **Default** | `true` |
| **Infrastructure** | Requires `graphDbUrl` |

Controls temporal knowledge graph integration. When active, the ingestion pipeline runs graph entity extraction and relationship storage (pipeline step 11), and recall results are enriched with graph-derived context.

**When enabled (with `graphDbUrl` set):** Entities (people, machines, technologies, IPs, dates, URLs) are extracted from memories and ingested into the FalkorDB graph with temporal relationships. Recall results include graph enrichment. Temporal queries, path finding, and timeline reconstruction are available.

**When enabled (without `graphDbUrl`):** Silently skipped. No errors, no performance impact. This is the graceful degradation behavior.

**When disabled:** Graph ingestion (pipeline step 11) is skipped entirely. No entities or relationships are written to the graph. Recall results omit graph enrichment. Temporal queries, path finding, and timeline reconstruction are unavailable. All other features work normally.

```typescript
enableGraph: false  // Skip graph ingestion and enrichment
```

### `enableAutoLink`

| Property | Value |
|----------|-------|
| **Type** | `boolean` |
| **Default** | `true` |
| **Infrastructure** | Qdrant only |

Controls automatic bidirectional linking between related memories during ingestion (pipeline step 10). When enabled, each new memory is compared against existing memories. Pairs exceeding the `autoLinkThreshold` cosine similarity are linked in both directions via the `linkedMemories` field, creating a Zettelkasten-style knowledge web.

**When enabled:** Memories automatically discover and connect to related content. Flash Reasoning chains can traverse these links for multi-step reasoning. The knowledge graph grows organically with every stored memory.

**When disabled:** No automatic links are created. The `linkedMemories` field remains empty. Flash Reasoning chains have no links to traverse. You can still create links manually if needed. Useful in high-throughput scenarios where the linking overhead is undesirable.

```typescript
enableAutoLink: false  // No automatic linking between memories
```

### `enableDecay`

| Property | Value |
|----------|-------|
| **Type** | `boolean` |
| **Default** | `true` |
| **Infrastructure** | Qdrant only |

Controls the activation decay model. When enabled, memories have activation levels that decay logarithmically over time. Each access refreshes activation. Decay rates vary by urgency level: critical memories decay slowly (months), background memories decay quickly (hours). Memories transition through three states: Active, Fading, and Archived.

**When enabled:** Time-based relevance naturally surfaces recent and frequently-accessed memories while archiving stale ones. The retrieval scoring incorporates decay status, so recent critical memories rank higher than old background ones.

**When disabled:** All memories remain permanently active with no time-based scoring penalty. Every memory ever stored participates in search results equally, regardless of age or access pattern. Useful for archival systems where nothing should ever fade.

Core and procedural memory types are **always immune to decay** regardless of this setting. Learned procedures and verified foundational knowledge persist indefinitely.

```typescript
enableDecay: false  // All memories remain permanently active
```

### `enableBroadcast`

| Property | Value |
|----------|-------|
| **Type** | `boolean` |
| **Default** | `true` |
| **Infrastructure** | Requires `cacheUrl` |

Controls cross-agent pub/sub broadcast via Redis. When active, memory events (store, update, delete, conflict detection) are published to typed channels. Critical memories receive priority routing. Other agents in the mesh receive these events in real time and can react accordingly (cache invalidation, corroboration, conflict alerts).

**When enabled (with `cacheUrl` set):** Memory events propagate across the agent mesh in real time. Required for Mesh Sync shared blocks, cross-agent corroboration, and fleet-level synthesis.

**When enabled (without `cacheUrl`):** Silently skipped. No errors, no performance impact.

**When disabled:** No events are published to Redis channels. The agent operates in isolation. Other agents in the mesh do not receive updates from this agent. Mesh Sync shared blocks, cross-agent corroboration, and fleet-level synthesis are unavailable for this agent. Useful for single-agent deployments or agents that should not broadcast their activity.

```typescript
enableBroadcast: false  // Agent operates in isolation
```

### `enablePriorityScoring`

| Property | Value |
|----------|-------|
| **Type** | `boolean` |
| **Default** | `true` |
| **Infrastructure** | Qdrant only |

Controls urgency x domain priority scoring during ingestion (pipeline step 7). When enabled, each memory receives a composite 0.0-1.0 priority score based on its urgency classification (critical, important, reference, background) and domain classification (technical, personal, project, knowledge, general).

**When enabled:** Priority scores influence retrieval ranking via the importance x confidence signal. Critical technical memories score 1.0; background general memories score 0.2. This ensures high-priority information surfaces first.

| Urgency \ Domain | technical | project | personal | knowledge | general |
|---|---|---|---|---|---|
| critical | 1.0 | 0.95 | 0.90 | 0.85 | 0.80 |
| important | 0.80 | 0.75 | 0.70 | 0.65 | 0.60 |
| reference | 0.50 | 0.45 | 0.40 | 0.35 | 0.30 |
| background | 0.30 | 0.28 | 0.25 | 0.22 | 0.20 |

**When disabled:** All memories receive a flat default priority score of 0.5. Urgency and domain are still classified (for metadata), but the composite score is not computed and does not influence retrieval. Useful when you want uniform retrieval weighting.

```typescript
enablePriorityScoring: false  // All memories get priority 0.5
```

### `enableConfidenceTags`

| Property | Value |
|----------|-------|
| **Type** | `boolean` |
| **Default** | `true` |
| **Infrastructure** | Qdrant only |

Controls the 4-tier confidence rating system during ingestion (pipeline step 8). Confidence is computed from three weighted signals:

- **Retrieval quality** (50%) -- How well the original information was extracted
- **Cross-agent agreement** (30%) -- Whether other agents have corroborating memories
- **Source trust** (20%) -- Configurable trust hierarchy for different agent/input sources

The composite score maps to a human-readable tag:

| Tag | Score Range | Meaning |
|-----|------------|---------|
| Mesh Fact | >= 0.85 | Corroborated by multiple agents or sources |
| Grounded | 0.65 - 0.84 | Strong single-source evidence |
| Inferred | 0.40 - 0.64 | Reasonable inference, not directly verified |
| Uncertain | < 0.40 | Low confidence, may need verification |

**When enabled:** Each memory carries both a numeric confidence score and a human-readable tag. Confidence participates in the multi-signal retrieval scoring (importance x confidence signal). Agents can filter or weight results by confidence tier.

**When disabled:** All memories receive a default confidence score of 0.5 and no confidence tag. The importance x confidence signal still participates in retrieval scoring but uses the flat default. Useful when confidence granularity is not needed.

```typescript
enableConfidenceTags: false  // All memories get confidence 0.5, no tag
```

---

## Tuning Parameters

### `autoLinkThreshold`

| Property | Value |
|----------|-------|
| **Type** | `number` |
| **Default** | `0.70` |
| **Range** | `0.0` - `1.0` |

Minimum cosine similarity required for automatic bidirectional linking between memories. This threshold controls the density of the knowledge web that `enableAutoLink` builds.

- **Lower values** (0.55-0.65) create more connections. The knowledge graph is denser, Flash Reasoning chains find more traversal paths, but noise increases. Good for exploratory or research agents where serendipitous connections are valuable.
- **Default** (0.70) is a balanced setting calibrated for 768-dimensional Nomic embeddings. Provides good precision without missing obvious connections.
- **Higher values** (0.75-0.85) create fewer connections. The knowledge graph is sparser and more precise. Good for production agents where accuracy matters more than discovery.

This threshold also interacts with two other hard-coded similarity thresholds in the pipeline:

| Threshold | Value | Purpose |
|-----------|-------|---------|
| Auto-link | `autoLinkThreshold` (default 0.70) | Bidirectional linking |
| Conflict detection | 0.70 - 0.92 | Potential contradiction alert |
| Deduplication | >= 0.92 | Duplicate detection and merge |

```typescript
autoLinkThreshold: 0.65  // Aggressive linking for research
autoLinkThreshold: 0.80  // Conservative linking for production
```

### `captureMaxChars`

| Property | Value |
|----------|-------|
| **Type** | `number` |
| **Default** | `500` |

Maximum characters per auto-captured memory during the `agent_end` lifecycle hook. When `autoCapture` is enabled, extracted observations that exceed this limit are truncated. This prevents excessively long memories from bloating the vector store and ensures embedding quality remains high (very long texts can degrade embedding precision).

```typescript
captureMaxChars: 250   // Short captures for high-volume chat agents
captureMaxChars: 1000  // Longer captures for research or analysis agents
```

---

## Configuration Profiles

These profiles cover common deployment patterns. Copy the one that matches your situation and adjust as needed.

### Minimal (Vector-Only)

The simplest possible configuration. Just Qdrant and an embedding service. All cognitive features disabled. Mnemosyne functions as a smart vector store with deduplication and security filtering.

```typescript
import { createMnemosyne } from 'mnemosy-ai'

const mnemosyne = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'simple-agent',

  autoCapture: false,
  autoRecall: false,
  enableGraph: false,
  enableAutoLink: false,
  enableDecay: false,
  enableBroadcast: false,
  enablePriorityScoring: false,
  enableConfidenceTags: false,
})
```

**Available:** `memory_store`, `memory_recall` (vector similarity only), `memory_forget`, security filter, deduplication.

**Disabled:** Graph features, caching, broadcast, decay, priority scoring, confidence tags, auto-capture, auto-recall, Mesh Sync, Flash Reasoning, reinforcement learning.

**Use when:** Evaluating Mnemosyne, environments where only Qdrant is available, or you want full manual control over every aspect of memory management.

### Standard (Single-Agent, Cognitive Features)

Full cognitive pipeline for a single agent. Graph and cache enabled. Broadcast disabled since there is only one agent. This is the recommended starting point for most projects.

```typescript
import { createMnemosyne } from 'mnemosy-ai'

const mnemosyne = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'dev-agent',

  graphDbUrl: 'redis://localhost:6380',
  cacheUrl: 'redis://localhost:6379',

  autoCapture: true,
  autoRecall: true,
  enableGraph: true,
  enableAutoLink: true,
  enableDecay: true,
  enableBroadcast: false,
  enablePriorityScoring: true,
  enableConfidenceTags: true,

  autoLinkThreshold: 0.70,
  captureMaxChars: 500,
})
```

**Available:** Full 12-step pipeline, graph queries, L2 cache, activation decay, priority scoring, confidence tags, auto-linking, Flash Reasoning, reinforcement learning, consolidation, session survival, proactive recall, procedural memory.

**Disabled:** Broadcast (not needed for single-agent).

**Use when:** Building a single intelligent agent that needs to learn and remember across sessions.

### Full (Production Single-Agent, Tuned)

Production deployment for a single agent with all cognitive features enabled and conservative thresholds for precision.

```typescript
import { createMnemosyne } from 'mnemosy-ai'

const mnemosyne = await createMnemosyne({
  vectorDbUrl: 'http://qdrant-prod:6333',
  embeddingUrl: 'http://embed-prod:11434/v1/embeddings',
  agentId: 'production-agent-01',

  graphDbUrl: 'redis://falkordb-prod:6380',
  cacheUrl: 'redis://redis-prod:6379',

  autoCapture: true,
  autoRecall: true,
  enableGraph: true,
  enableAutoLink: true,
  enableDecay: true,
  enableBroadcast: false,
  enablePriorityScoring: true,
  enableConfidenceTags: true,

  autoLinkThreshold: 0.75,  // Conservative -- fewer but more precise links
  captureMaxChars: 500,
})
```

**Available:** Everything except broadcast. Full cognitive OS for a single agent.

**Use when:** Running a single agent in production where accuracy and reliability matter more than multi-agent collaboration.

### Multi-Agent Mesh (All Features)

Full multi-agent deployment. All features enabled including cross-agent broadcast, Mesh Sync shared blocks, Agent Awareness Engine, and fleet-level synthesis. Each agent in the mesh uses this configuration template, varying only `agentId`.

```typescript
import { createMnemosyne } from 'mnemosy-ai'

// Each agent in the mesh uses this config with a unique agentId
const mnemosyne = await createMnemosyne({
  vectorDbUrl: 'http://qdrant-cluster:6333',
  embeddingUrl: 'http://embed-cluster:11434/v1/embeddings',
  agentId: 'mesh-agent-01',  // unique per agent

  graphDbUrl: 'redis://falkordb-cluster:6380',
  cacheUrl: 'redis://redis-cluster:6379',

  autoCapture: true,
  autoRecall: true,
  enableGraph: true,
  enableAutoLink: true,
  enableDecay: true,
  enableBroadcast: true,     // required for mesh
  enablePriorityScoring: true,
  enableConfidenceTags: true,

  autoLinkThreshold: 0.70,
  captureMaxChars: 500,
})
```

**Available:** Everything. Full cognitive OS including real-time cross-agent broadcast, Mesh Sync shared blocks, Agent Awareness Engine (Theory of Mind), knowledge gap analysis, cross-agent corroboration, fleet-level synthesis, session survival, proactive recall, and procedural memory sharing.

**Mesh requirement:** Every agent must point to the **same** Qdrant, Redis, and FalkorDB instances. Each agent must have a **unique** `agentId`. Events propagate automatically via Redis pub/sub.

**Use when:** Running multiple agents that need to share knowledge, collaborate in real time, and build on each other's learning.

---

## Environment Variables

All infrastructure endpoints and the agent identity can be set via environment variables. Environment variables are read as fallbacks -- explicit values in the config object always take precedence.

| Environment Variable | Config Option | Example |
|---|---|---|
| `MNEMOSYNE_VECTOR_DB` | `vectorDbUrl` | `http://localhost:6333` |
| `MNEMOSYNE_EMBED_URL` | `embeddingUrl` | `http://localhost:11434/v1/embeddings` |
| `MNEMOSYNE_REDIS_URL` | `cacheUrl` | `redis://localhost:6379` |
| `MNEMOSYNE_GRAPH_URL` | `graphDbUrl` | `redis://localhost:6380` |
| `MNEMOSYNE_AGENT_ID` | `agentId` | `my-agent` |
| `MNEMOSYNE_EXTRACTION_URL` | `extractionUrl` | `http://localhost:1995/extract` |

Feature toggles and tuning parameters do not have environment variable equivalents. They must be set in the config object.

### Environment-Only Configuration

When all infrastructure is configured via environment variables, you can pass an empty object (or just feature overrides) to `createMnemosyne()`:

```bash
# .env or shell exports
export MNEMOSYNE_VECTOR_DB=http://localhost:6333
export MNEMOSYNE_EMBED_URL=http://localhost:11434/v1/embeddings
export MNEMOSYNE_REDIS_URL=redis://localhost:6379
export MNEMOSYNE_GRAPH_URL=redis://localhost:6380
export MNEMOSYNE_AGENT_ID=my-agent
```

```typescript
import { createMnemosyne } from 'mnemosy-ai'

// All required options read from environment variables.
// Feature toggles use their defaults (all true).
const mnemosyne = await createMnemosyne({})
```

### Mixed Configuration

A common pattern: infrastructure comes from the environment (varies per deployment), feature toggles come from code (fixed per agent design):

```typescript
import { createMnemosyne } from 'mnemosy-ai'

// Infrastructure URLs from environment,
// feature toggles and tuning from code
const mnemosyne = await createMnemosyne({
  enableGraph: true,
  enableBroadcast: true,
  autoLinkThreshold: 0.75,
  captureMaxChars: 1000,
})
```

### Docker / Container Configuration

For containerized deployments, pass environment variables through your orchestrator:

```yaml
# docker-compose.yml
services:
  my-agent:
    image: my-agent:latest
    environment:
      MNEMOSYNE_VECTOR_DB: http://qdrant:6333
      MNEMOSYNE_EMBED_URL: http://embed:11434/v1/embeddings
      MNEMOSYNE_REDIS_URL: redis://redis:6379
      MNEMOSYNE_GRAPH_URL: redis://falkordb:6380
      MNEMOSYNE_AGENT_ID: containerized-agent-01
```

---

## Progressive Adoption Guide

Mnemosyne is designed for incremental adoption. Start with the minimum and add features as you understand their value. Each step below adds one capability. You do not need to reach the final step -- stop wherever your needs are met.

### Step 1: Basic Vector Memory

Start here. Two services (Qdrant + embedding), three config fields, everything else disabled. You get persistent memory storage with deduplication, security filtering, and vector similarity search.

```typescript
import { createMnemosyne } from 'mnemosy-ai'

const mnemosyne = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'my-agent',

  // Start with everything off
  autoCapture: false,
  autoRecall: false,
  enableGraph: false,
  enableAutoLink: false,
  enableDecay: false,
  enableBroadcast: false,
  enablePriorityScoring: false,
  enableConfidenceTags: false,
})
```

**What you get:** `memory_store`, `memory_recall`, `memory_forget`. Basic persistent memory.

### Step 2: Add Cognitive Scoring

Turn on priority scoring and confidence tags. Memories are now classified by urgency, domain, and confidence level. Retrieval becomes smarter -- critical technical memories surface before background general ones.

```typescript
const mnemosyne = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'my-agent',

  autoCapture: false,
  autoRecall: false,
  enableGraph: false,
  enableAutoLink: false,
  enableDecay: false,
  enableBroadcast: false,
  enablePriorityScoring: true,   // NEW
  enableConfidenceTags: true,    // NEW
})
```

**What you add:** Urgency/domain-aware priority scoring, 4-tier confidence tags, improved retrieval ranking.

### Step 3: Add Automatic Linking and Decay

Turn on auto-linking and activation decay. Memories now connect to each other, forming a navigable knowledge web. Stale memories fade while frequently-accessed ones stay prominent. Flash Reasoning can traverse linked memories for multi-step reasoning.

```typescript
const mnemosyne = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'my-agent',

  autoCapture: false,
  autoRecall: false,
  enableGraph: false,
  enableAutoLink: true,          // NEW
  enableDecay: true,             // NEW
  enableBroadcast: false,
  enablePriorityScoring: true,
  enableConfidenceTags: true,

  autoLinkThreshold: 0.70,
})
```

**What you add:** Automatic bidirectional linking, Flash Reasoning chain traversal, time-based activation decay, active/fading/archived memory states.

### Step 4: Add Lifecycle Automation

Turn on auto-capture and auto-recall. The agent now learns from every conversation automatically and starts each session with relevant context pre-loaded. This is where Mnemosyne shifts from a tool you call to a system that works for you.

```typescript
const mnemosyne = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'my-agent',

  autoCapture: true,             // NEW
  autoRecall: true,              // NEW
  enableGraph: false,
  enableAutoLink: true,
  enableDecay: true,
  enableBroadcast: false,
  enablePriorityScoring: true,
  enableConfidenceTags: true,

  autoLinkThreshold: 0.70,
  captureMaxChars: 500,
})
```

**What you add:** Automatic memory extraction from conversations, proactive recall before agent start, session survival across context resets.

### Step 5: Add the Knowledge Graph

Add FalkorDB and enable graph integration. Memories are now enriched with entity relationships. Temporal queries, path finding, and timeline reconstruction become available.

```typescript
const mnemosyne = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'my-agent',

  graphDbUrl: 'redis://localhost:6380',  // NEW
  autoCapture: true,
  autoRecall: true,
  enableGraph: true,             // NEW
  enableAutoLink: true,
  enableDecay: true,
  enableBroadcast: false,
  enablePriorityScoring: true,
  enableConfidenceTags: true,

  autoLinkThreshold: 0.70,
  captureMaxChars: 500,
})
```

**What you add:** Temporal knowledge graph, entity extraction and relationship storage, graph-enriched recall results, path finding between entities, timeline reconstruction.

### Step 6: Add Caching and Multi-Agent Broadcast

Add Redis for L2 caching and enable broadcast. This unlocks the full multi-agent mesh. Every agent in the mesh uses this configuration with a unique `agentId`.

```typescript
const mnemosyne = await createMnemosyne({
  vectorDbUrl: 'http://qdrant-cluster:6333',
  embeddingUrl: 'http://embed-cluster:11434/v1/embeddings',
  agentId: 'mesh-agent-01',

  graphDbUrl: 'redis://falkordb-cluster:6380',
  cacheUrl: 'redis://redis-cluster:6379',  // NEW
  autoCapture: true,
  autoRecall: true,
  enableGraph: true,
  enableAutoLink: true,
  enableDecay: true,
  enableBroadcast: true,         // NEW
  enablePriorityScoring: true,
  enableConfidenceTags: true,

  autoLinkThreshold: 0.70,
  captureMaxChars: 500,
})
```

**What you add:** L2 distributed cache (sub-10ms repeated lookups), real-time cross-agent broadcast, Mesh Sync shared blocks, Agent Awareness Engine (Theory of Mind), knowledge gap analysis, cross-agent corroboration, fleet-level synthesis. The full cognitive OS.

---

## Feature Dependencies

This table shows which infrastructure components are required for each feature to function. Features degrade gracefully when their required infrastructure is absent -- no errors, no crashes, just silent skip.

| Feature | Qdrant | Redis | FalkorDB | Notes |
|---|:---:|:---:|:---:|---|
| `memory_store` (basic) | Required | - | - | Core vector storage |
| `memory_recall` (basic) | Required | - | - | Vector similarity search |
| `memory_forget` | Required | - | - | Soft-delete in vector store |
| Security filter | Required | - | - | Blocks secrets before storage |
| Deduplication and merge | Required | - | - | Cosine similarity on vector store |
| Entity extraction | Required | - | - | Algorithmic, zero-LLM |
| Type classification | Required | - | - | Algorithmic, zero-LLM |
| Priority scoring | Required | - | - | Urgency x domain computation |
| Confidence tags | Required | - | - | Multi-signal computation |
| Activation decay | Required | - | - | Stored in vector metadata |
| Multi-signal scoring | Required | - | - | 5-signal retrieval ranking |
| Intent-aware retrieval | Required | - | - | Query pattern detection |
| Diversity reranking | Required | - | - | Post-processing on results |
| Auto-linking | Required | - | - | Bidirectional links in metadata |
| Flash Reasoning | Required | - | - | Traverses linkedMemories |
| Reinforcement learning | Required | - | - | Feedback stored in metadata |
| Active consolidation | Required | - | - | Operates on vector store |
| Procedural memory | Required | - | - | Dedicated skill library collection |
| Session survival | Required | - | - | Snapshots in private collection |
| Observational memory | Required | - | - | Auto-capture pipeline |
| Proactive recall | Required | - | - | Speculative query generation |
| Agent Awareness (ToMA) | Required | - | - | Filtered vector search by agent |
| Knowledge gap analysis | Required | - | - | Cross-agent vector comparison |
| L1 cache | Required | - | - | In-process LRU, always active |
| L2 cache | Required | Required | - | Distributed Redis cache |
| Pub/sub broadcast | Required | Required | - | Redis pub/sub channels |
| Mesh Sync (shared blocks) | Required | Required | - | Broadcast + vector storage |
| Cross-agent corroboration | Required | Required | - | Requires broadcast events |
| Fleet-level synthesis | Required | Required | - | Requires cross-agent data |
| Temporal graph queries | Required | - | Required | FalkorDB Cypher queries |
| Graph entity extraction | Required | - | Required | Entities ingested to graph |
| Path finding | Required | - | Required | Graph traversal |
| Timeline reconstruction | Required | - | Required | Temporal graph queries |

**Summary:**

- **Qdrant only** -- All cognitive features work. Full 12-step pipeline, multi-signal retrieval, decay, consolidation, Flash Reasoning, reinforcement learning, session survival, and agent awareness. Already far beyond competing memory systems.
- **Qdrant + Redis** -- Adds L2 distributed cache, pub/sub broadcast, Mesh Sync shared blocks, cross-agent corroboration, and fleet-level synthesis.
- **Qdrant + Redis + FalkorDB** -- Adds temporal knowledge graph, entity relationships, path finding, and timeline reconstruction. The full cognitive OS.
