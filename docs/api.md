# API Reference

## Overview

Mnemosyne exposes **9 tools** that give any AI agent persistent, self-improving, collaborative memory. These tools cover the full memory lifecycle: storing, recalling, forgetting, sharing state across agents, providing feedback for reinforcement learning, running consolidation maintenance, and querying cross-agent knowledge. Two additional lifecycle hooks fire automatically around every agent invocation.

### Integration Methods

**MCP Server (recommended for Claude, Cursor, and MCP-compatible agents)**

Mnemosyne ships as a fully compliant [Model Context Protocol](https://modelcontextprotocol.io/) server. All 9 tools are auto-discovered by any MCP client. No glue code required.

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "npx",
      "args": ["mnemosy-ai", "--mcp"],
      "env": {
        "MNEMOSYNE_VECTOR_DB": "http://localhost:6333",
        "MNEMOSYNE_EMBED_URL": "http://localhost:11434/v1/embeddings",
        "MNEMOSYNE_REDIS_URL": "redis://localhost:6379",
        "MNEMOSYNE_GRAPH_URL": "redis://localhost:6380",
        "MNEMOSYNE_AGENT_ID": "my-agent"
      }
    }
  }
}
```

**Direct SDK (for custom integrations)**

Import and use the SDK directly in any TypeScript/Node.js application:

```typescript
import { createMnemosyne } from 'mnemosy-ai';

const m = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'my-agent',
});

// All 9 tools available as methods
await m.store('User prefers dark mode');
const results = await m.recall('user preferences');
```

**Framework Adapters**

Mnemosyne provides adapter functions for popular agent frameworks:

```typescript
// LangChain
import { mnemosyneTools } from 'mnemosy-ai/langchain';

// Vercel AI SDK
import { mnemosyneTools } from 'mnemosy-ai/ai-sdk';

// OpenAI function calling
import { mnemosyneToolDefs } from 'mnemosy-ai/openai';
```

---

## Core Memory Operations

### 1. memory_recall

Intelligent memory search with multi-signal ranking. This is the primary retrieval interface -- it goes far beyond simple vector similarity by combining 5 independent scoring signals, detecting query intent, applying diversity reranking, enriching results with graph context, and generating flash reasoning chains.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | Yes | -- | Natural language search query |
| `limit` | `number` | No | `5` | Maximum number of results to return |
| `minScore` | `number` | No | `0.3` | Minimum relevance threshold (0.0-1.0). Results below this score are excluded |

#### Returns

Ranked list of memories with scores, confidence tags, and decay status. Each result contains:

```typescript
interface RecallResult {
  id: string;                    // Memory UUID
  text: string;                  // Memory content
  score: number;                 // Composite relevance score (0.0-1.0)
  confidenceTag: ConfidenceTag;  // "Mesh Fact" | "Grounded" | "Inferred" | "Uncertain"
  confidenceScore: number;       // Numeric confidence (0.0-1.0)
  memoryType: MemoryType;        // Classification (episodic, semantic, etc.)
  entities: string[];            // Extracted entities
  linkedMemories: string[];      // IDs of connected memories
  decayStatus: string;           // "active" | "fading" | "archived"
  eventTime: string;             // When the event occurred
  botId: string;                 // Creating agent
  reasoningChain?: string;       // Flash reasoning context (if linked memories found)
  graphContext?: string[];        // Related entities from knowledge graph
}
```

#### Features

- **Intent-aware scoring** -- Automatically detects query intent (factual, temporal, procedural, preference, exploratory) and adapts signal weights. A "when did we deploy?" query boosts recency. A "how to restart Redis" query boosts procedural type relevance and access frequency.
- **Diversity reranking** -- Prevents redundant results. Results with >0.9 cosine similarity are clustered (only the best passes through, others get -40% penalty). Overlap penalty (-15%) for >0.8 similarity to already-selected results. Type diversity enforcement (-5% per additional same-type result after 3).
- **Graph enrichment** -- Appends related entities and relationships from the temporal knowledge graph. If a memory mentions "Redis", the graph contributes connected entities (port numbers, related services, configuration details).
- **Flash reasoning chains** -- BFS traversal through linked memories reconstructs multi-step logic: `"deployed service -> because -> config changed -> therefore -> restart needed"`. Cycle detection ensures bounded latency.
- **Agent awareness auto-detection** -- Queries mentioning agent names (e.g., "what does the devops agent know about...") are automatically routed through the Agent Awareness Engine for cross-agent knowledge lookup.
- **Proactive recall** -- Before every agent invocation, the system generates speculative queries based on the incoming prompt and surfaces relevant memories the agent did not explicitly request.
- **2-tier cache** -- L1 in-memory cache (50 entries, 5-min TTL, LRU eviction) for sub-10ms repeated lookups. L2 Redis cache (1-hour TTL) for distributed cache sharing. Cache keys are derived from query embedding + parameters.

#### Multi-Signal Scoring Breakdown

| Signal | What It Measures | Base Weight |
|--------|-----------------|-------------|
| Semantic Similarity | Vector distance between query and memory | 40% |
| Temporal Recency | How recently the memory was created or accessed | 20% |
| Importance x Confidence | Priority score multiplied by confidence rating | 20% |
| Access Frequency | How often this memory has been recalled (logarithmic scale) | 10% |
| Type Relevance | How well the memory type matches inferred query intent | 10% |

#### Intent-Adaptive Weight Adjustments

| Detected Intent | Primary Boost | Effect |
|----------------|---------------|--------|
| Factual | Similarity | Similarity weight raised to 50% |
| Temporal | Recency | Recency weight raised to 35% |
| Procedural | Frequency | Frequency gets +20% boost |
| Preference | Type Relevance | Type Relevance gets +20% boost |
| Exploratory | Balanced | Even distribution across all signals |

#### Example

```typescript
import { createMnemosyne } from 'mnemosy-ai';

const m = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'ops-agent',
});

// Basic recall -- intent detected as "procedural"
const results = await m.recall('deployment procedures for production');
// Returns ranked results with composite scores, confidence tags, reasoning chains

// With explicit parameters -- raise threshold, request more results
const filtered = await m.recall('deployment procedures for production', {
  limit: 10,
  minScore: 0.5,
});

// Results are ranked by composite multi-signal score
for (const r of filtered) {
  console.log(`[${r.confidenceTag}] (${r.score.toFixed(2)}) ${r.text}`);
  // [Grounded] (0.87) Production deployment requires approval from tech lead...
  // [Mesh Fact] (0.82) Deployment pipeline uses GitHub Actions with staging gate...
  // [Inferred] (0.71) Last deployment on Jan 15 included Redis migration step...

  if (r.reasoningChain) {
    console.log(`  Reasoning: ${r.reasoningChain}`);
    // Reasoning: deployed service -> because -> config changed -> therefore -> restart needed
  }

  if (r.graphContext?.length) {
    console.log(`  Graph context: ${r.graphContext.join(', ')}`);
    // Graph context: GitHub Actions, staging-server, port 443, Redis 7.2
  }
}

// Temporal intent -- recency signal automatically boosted
const recent = await m.recall('what changed in the last deploy?');

// Agent awareness auto-detection -- routed through ToMA engine
const crossAgent = await m.recall('what does the devops agent know about Redis?');
```

---

### 2. memory_store

Full 12-step ingestion pipeline. Every memory passes through security filtering, embedding generation, deduplication, entity extraction, classification, priority scoring, confidence rating, vector storage, auto-linking, graph ingestion, and mesh broadcast. The entire pipeline runs with zero LLM calls in under 50ms.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | `string` | Yes | -- | Content to memorize. Maximum recommended length: 500 characters for optimal embedding quality |
| `importance` | `number` | No | auto | Override importance score (0.0-1.0). When omitted, importance is computed from urgency and domain classification |
| `category` | `string` | No | auto | Type hint to guide classification. When omitted, the 7-type classifier runs automatically |
| `eventTime` | `string` | No | `now` | When the event occurred (ISO 8601 format). Supports bi-temporal model: `eventTime` is when it happened, `ingestedAt` is when stored |

#### Returns

```typescript
interface StoreResult {
  status: 'created' | 'duplicate' | 'blocked_secret';
  id?: string;                        // UUID of created memory (absent if duplicate/blocked)
  linkedCount: number;                // Number of auto-linked related memories
  classification: Classification;     // public | private | secret
  memoryType: MemoryType;             // Detected type
  entities: string[];                 // Extracted entities
  priorityScore: number;              // Computed priority (0.0-1.0)
  confidenceTag: ConfidenceTag;       // Assigned confidence tier
}
```

#### 12-Step Pipeline Detail

| Step | Component | What Happens |
|------|-----------|-------------|
| 1 | **Security Filter** | 3-tier classification (public/private/secret). Blocks API keys, credentials, private keys, and secrets from ever being stored. Returns `blocked_secret` if detected |
| 2 | **Embedding Generation** | Converts text to 768-dimensional vector. LRU cache (512 entries) avoids re-embedding identical text |
| 3 | **Deduplication & Merge** | Cosine similarity check against existing memories. >=0.92 = duplicate (merge or reject). 0.70-0.92 = potential conflict (broadcast alert) |
| 4 | **Extraction Pipeline** | Extracts structured metadata: memory type, entities (names, IPs, dates, technologies, URLs, ports). Fully algorithmic, zero LLM calls |
| 5 | **Urgency Classification** | 4-level urgency: `critical`, `important`, `reference`, `background`. Keyword-driven detection |
| 6 | **Domain Classification** | 5 domains: `technical`, `personal`, `project`, `knowledge`, `general`. Determines retrieval weighting |
| 7 | **Priority Scoring** | Composite score from urgency x domain. Critical+technical = 1.0, background+general = 0.2 |
| 8 | **Confidence Rating** | Multi-signal confidence: retrieval quality x source trust x cross-agent agreement. Assigns tier: Mesh Fact, Grounded, Inferred, or Uncertain |
| 9 | **Vector Storage** | Written to appropriate Qdrant collection with full 23-field metadata payload |
| 10 | **Auto-Linking** | Bidirectional links to related memories (similarity > 0.70). Creates Zettelkasten-style knowledge web |
| 11 | **Graph Ingestion** | Entities and relationships added to temporal knowledge graph. Memory -> Entity -> Entity traversal paths |
| 12 | **Broadcast** | Published to mesh via typed Redis pub/sub channels. Critical memories get priority routing. Caches invalidated |

#### Example

```typescript
import { createMnemosyne } from 'mnemosy-ai';

const m = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'backend-agent',
});

// Basic store -- pipeline auto-classifies everything
const result = await m.store(
  'User prefers TypeScript over JavaScript for all new projects'
);
console.log(result);
// {
//   status: "created",
//   id: "f7a1b2c3-...",
//   linkedCount: 2,
//   classification: "public",
//   memoryType: "preference",
//   entities: ["TypeScript", "JavaScript"],
//   priorityScore: 0.4,
//   confidenceTag: "Grounded"
// }

// With importance override and explicit event time
const migration = await m.store(
  'Redis cluster migrated to port 6380 on 2024-01-15',
  {
    importance: 0.8,
    eventTime: '2024-01-15T10:00:00Z',
  }
);
console.log(migration);
// {
//   status: "created",
//   id: "a4d5e6f7-...",
//   linkedCount: 3,
//   classification: "public",
//   memoryType: "episodic",
//   entities: ["Redis", "6380"],
//   priorityScore: 0.8,
//   confidenceTag: "Grounded"
// }

// With category hint -- overrides auto-classification
const runbook = await m.store(
  'To restart the auth service: 1) SSH into prod-01, 2) Run systemctl restart auth, 3) Verify with curl localhost:8080/health',
  { category: 'procedural' }
);
// { status: "created", memoryType: "procedural", ... }

// Duplicate detection -- pipeline rejects near-identical content
const dup = await m.store('Redis cluster migrated to port 6380');
console.log(dup.status); // "duplicate"

// Secret blocking -- security filter catches credentials
const blocked = await m.store('Database password is hunter2');
console.log(blocked.status); // "blocked_secret"

// Private memory with credential-adjacent content that passes filter
const config = await m.store('Auth service connects to PostgreSQL on port 5432');
console.log(config.classification); // "public"
```

---

### 3. memory_forget

Soft-delete by ID or semantic search. Memories are never physically deleted -- they are marked with `deleted: true` and excluded from future searches. This preserves audit trails and enables recovery.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `memoryId` | `string` | No | -- | Direct ID reference. Supports short IDs (first 8 characters of the UUID) for convenience |
| `query` | `string` | No | -- | Semantic search to find what to forget. Returns candidates for confirmation when ambiguous |

At least one of `memoryId` or `query` must be provided.

#### Returns

```typescript
// When memoryId is provided or single high-confidence match found
interface ForgetConfirmation {
  status: 'deleted';
  id: string;
  text: string;       // The forgotten memory's content (for confirmation)
}

// When query matches multiple candidates
interface ForgetCandidates {
  status: 'candidates';
  matches: Array<{
    id: string;
    text: string;
    score: number;
  }>;
  message: string;    // "Multiple matches found. Specify memoryId to forget."
}
```

#### Features

- **Short ID resolution** -- The first 8 characters of any UUID are sufficient to identify a memory. The system resolves short IDs to full UUIDs automatically.
- **Auto-delete on high confidence** -- When a semantic query produces exactly one result with a confidence score above 0.9, that memory is automatically soft-deleted without requiring disambiguation.
- **Candidate list** -- When a query matches multiple memories or no single result exceeds the 0.9 threshold, the system returns a ranked candidate list for the agent or user to select from.
- **Mesh invalidation** -- On successful deletion, a broadcast invalidation event is sent to all agents in the mesh. L1 and L2 caches are purged for any queries that referenced the deleted memory.

#### Example

```typescript
import { createMnemosyne } from 'mnemosy-ai';

const m = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'cleanup-agent',
});

// Forget by direct full UUID
const deleted = await m.forget({ memoryId: 'f7a1b2c3-d4e5-6789-abcd-ef0123456789' });
console.log(deleted);
// { status: "deleted", id: "f7a1b2c3-...", text: "Old deployment procedure..." }

// Forget by short ID (first 8 chars of the UUID)
await m.forget({ memoryId: 'f7a1b2c3' });
// Resolves "f7a1b2c3" to "f7a1b2c3-d4e5-6789-abcd-ef0123456789"

// Forget by semantic search -- auto-delete if single high-confidence match
const result = await m.forget({ query: 'old deployment procedure for legacy system' });
console.log(result);
// { status: "deleted", id: "...", text: "Deploy to prod by SSH into legacy-01..." }

// Ambiguous query returns candidates for disambiguation
const ambiguous = await m.forget({ query: 'deployment' });
console.log(ambiguous);
// {
//   status: "candidates",
//   matches: [
//     { id: "abc12345-...", text: "Production deployment requires...", score: 0.84 },
//     { id: "def67890-...", text: "Staging deployment runs nightly...", score: 0.79 },
//     { id: "ghi11121-...", text: "Deploy to prod by SSH into...", score: 0.71 },
//   ],
//   message: "Multiple matches found. Specify memoryId to forget."
// }

// Then forget the specific one by ID
await m.forget({ memoryId: 'ghi11121' });
```

---

## Mesh Sync

Shared memory blocks provide a cross-agent coordination mechanism. These are named, versioned key-value entries that all agents in the mesh can read and write. Think of them as shared whiteboards: `"project_status"`, `"current_sprint"`, `"team_preferences"`.

Blocks are stored as core memories with maximum confidence, ensuring they participate in retrieval, reasoning, and consolidation alongside organic memories. Changes are broadcast to all connected agents in real time via Redis pub/sub.

### 4. memory_block_get

Read a named shared memory block.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | Yes | -- | Block name (e.g., `"project_status"`, `"team_roster"`, `"deploy_freeze"`) |

#### Returns

```typescript
interface BlockGetResult {
  content: string;       // Block content
  version: number;       // Monotonically increasing version number
  lastWriter: string;    // agentId of the last agent to update this block
  updatedAt: string;     // ISO 8601 timestamp of last update
}
```

Returns `null` if the block does not exist.

#### Example

```typescript
import { createMnemosyne } from 'mnemosy-ai';

const m = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'reader-agent',
});

// Read a shared block
const status = await m.blockGet('project_status');
if (status) {
  console.log(status.content);
  // "Sprint 14: Auth system complete, starting payments module"
  console.log(`Version: ${status.version}, Writer: ${status.lastWriter}`);
  // "Version: 3, Writer: project-manager-agent"
  console.log(`Updated: ${status.updatedAt}`);
  // "Updated: 2024-01-20T14:32:00Z"
} else {
  console.log('Block does not exist yet');
}

// Check deploy freeze before proceeding
const freeze = await m.blockGet('deploy_freeze');
if (freeze?.content === 'true') {
  console.log('Deploy freeze is active -- aborting deployment');
}
```

---

### 5. memory_block_set

Write or update a named shared memory block. Creates the block if it does not exist. Increments the version number on every write. Broadcasts the change to all agents in the mesh.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `name` | `string` | Yes | -- | Block name |
| `content` | `string` | Yes | -- | Block content (replaces previous content entirely) |

#### Returns

```typescript
interface BlockSetResult {
  version: number;   // New version number after write
  id: string;        // Memory ID of the underlying core memory
}
```

#### Example

```typescript
import { createMnemosyne } from 'mnemosy-ai';

const m = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'project-manager-agent',
});

// Create a new shared block
const created = await m.blockSet(
  'project_status',
  'Sprint 14: Auth system complete, starting payments module'
);
console.log(created);
// { version: 1, id: "b3c4d5e6-..." }

// Update the block -- version increments automatically
const updated = await m.blockSet(
  'project_status',
  'Sprint 14: Payments module 60% complete, on track for Friday release'
);
console.log(updated);
// { version: 2, id: "b3c4d5e6-..." }

// Common shared blocks used across agent meshes
await m.blockSet('team_preferences', 'Code style: Prettier, semicolons, single quotes');
await m.blockSet('active_incidents', 'None');
await m.blockSet('deploy_freeze', 'false');
await m.blockSet('current_sprint', 'Sprint 14: Jan 15 - Jan 29');
await m.blockSet('on_call', 'devops-agent-02');

// Read it back from any agent in the mesh
const read = await m.blockGet('project_status');
console.log(read);
// {
//   content: "Sprint 14: Payments module 60% complete, on track for Friday release",
//   version: 2,
//   lastWriter: "project-manager-agent",
//   updatedAt: "2024-01-22T09:15:00Z"
// }
```

---

## Self-Improvement

### 6. memory_feedback

Reinforcement learning signal for retrieved memories. Closes the feedback loop: agents report which memories actually proved useful and which were misleading. Over time, this data drives automatic promotion of valuable memories and flagging of poor ones.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `signal` | `"positive"` \| `"negative"` | Yes | -- | Was the recalled memory useful? |
| `memoryId` | `string` | No | -- | Specific memory to apply feedback to. When omitted, feedback is applied to all memories returned in the most recent `memory_recall` call |

#### Returns

```typescript
interface FeedbackResult {
  updated: number;     // Number of memories that received the feedback signal
  promoted: number;    // Number of memories promoted to core type
}
```

#### How Reinforcement Learning Works

Each memory tracks three feedback counters:

- `hitCount` -- Total number of times the memory was retrieved and feedback was given
- `usefulCount` -- Number of positive feedback signals received
- `usefulness_ratio` -- Computed as `usefulCount / hitCount`

**Promotion rule:** When a memory's usefulness ratio exceeds 0.7 after at least 3 retrievals with feedback, it is automatically promoted to `core` memory type. Core memories are immune to activation decay, ensuring they persist permanently.

**Review flag:** Memories with consistently negative feedback (usefulness ratio < 0.3 after 5+ retrievals) are flagged for manual review.

#### Example

```typescript
import { createMnemosyne } from 'mnemosy-ai';

const m = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'support-agent',
});

// Step 1: Recall memories relevant to the current task
const results = await m.recall('database connection settings');

// Step 2: The agent uses the recalled memories to answer a question.
// The answer was helpful -- send positive feedback to all recalled memories.
const feedback = await m.feedback('positive');
console.log(feedback);
// { updated: 3, promoted: 0 }

// Targeted feedback on a specific memory that was especially helpful
const targeted = await m.feedback('positive', { memoryId: 'abc12345' });
console.log(targeted);
// { updated: 1, promoted: 1 }
// This memory crossed the promotion threshold (ratio > 0.7 after 3+ hits)
// It is now a "core" memory, immune to activation decay

// Negative feedback -- the recalled memory was wrong or misleading
await m.feedback('negative');
// { updated: 3, promoted: 0 }
// The affected memories' usefulness ratios decrease

// Feedback is also detected automatically by the agent_end lifecycle hook
// Positive signals: explicit thanks, "that's right", referencing recalled content
// Negative signals: "that's wrong", corrections, ignoring recalled memories
```

---

### 7. memory_consolidate

Run the active consolidation pipeline on demand. This is a four-phase maintenance process that detects contradictions, merges near-duplicates, promotes popular memories, and demotes stale ones. Can also run on a schedule (e.g., nightly) for autonomous memory hygiene.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `batchSize` | `number` | No | `100` | Number of memories to process per batch. Larger batches are more thorough but take longer. Maximum: 1000 |

#### Returns

```typescript
interface ConsolidationReport {
  contradictions: number;        // Memory pairs with conflicting assertions detected
  nearDuplicatesMerged: number;  // Pairs merged (>0.92 similarity, keeping higher quality)
  popularPromoted: number;       // Memories promoted to core type (>10 accesses)
  staleDemoted: number;          // Memories deprioritized (30+ days idle, importance < 0.3)
  processedCount: number;        // Total memories examined
  durationMs: number;            // Pipeline execution time in milliseconds
}
```

#### Four-Phase Pipeline

| Phase | What It Does | Detection Criteria |
|-------|-------------|-------------------|
| **1. Contradiction Detection** | Finds memory pairs that assert conflicting facts. Surfaces them for resolution | Cosine similarity 0.70-0.92 + semantic negation mismatch |
| **2. Near-Duplicate Merge** | Combines memories with overlapping content. Preserves the higher-quality version with merged metadata | Cosine similarity >= 0.92. Keeps higher access count version |
| **3. Popular Promotion** | Elevates frequently-accessed memories to permanent `core` type | Access count > 10 retrievals |
| **4. Stale Demotion** | Reduces priority of idle, low-importance memories to keep the active knowledge base sharp | 30+ days since last access AND importance < 0.3 |

#### Example

```typescript
import { createMnemosyne } from 'mnemosy-ai';

const m = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'maintenance-agent',
});

// Run consolidation with default batch size (100)
const report = await m.consolidate();
console.log(report);
// {
//   contradictions: 2,
//   nearDuplicatesMerged: 7,
//   popularPromoted: 3,
//   staleDemoted: 12,
//   processedCount: 100,
//   durationMs: 1847
// }

// Larger batch for thorough weekly cleanup
const deepReport = await m.consolidate({ batchSize: 500 });
console.log(`Processed ${deepReport.processedCount} memories in ${deepReport.durationMs}ms`);
// "Processed 500 memories in 8234ms"

// Log consolidation summary
console.log(`Contradictions found: ${deepReport.contradictions}`);
console.log(`Duplicates merged:    ${deepReport.nearDuplicatesMerged}`);
console.log(`Popular promoted:     ${deepReport.popularPromoted}`);
console.log(`Stale demoted:        ${deepReport.staleDemoted}`);

// Schedule nightly consolidation (example with node-cron)
import cron from 'node-cron';

cron.schedule('0 2 * * *', async () => {
  const nightly = await m.consolidate({ batchSize: 1000 });
  console.log('[nightly] Consolidation complete:', nightly);
});
```

---

## Agent Awareness

### 8. memory_toma

Query what a specific agent knows about a topic. Implements Theory of Mind for Agents (ToMA) -- the ability for one agent to model another agent's knowledge state. This enables intelligent task routing, collaborative problem-solving, and knowledge gap identification.

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `agentId` | `string` | Yes | -- | Target agent identifier (e.g., `"devops-agent"`, `"hr-agent"`) |
| `topic` | `string` | Yes | -- | What to ask about (natural language) |
| `limit` | `number` | No | `5` | Maximum results to return |

#### Returns

Formatted list of the target agent's knowledge on the specified topic:

```typescript
interface TomaResult {
  agentId: string;
  topic: string;
  memories: Array<{
    text: string;
    confidenceTag: ConfidenceTag;
    memoryType: MemoryType;
    eventTime: string;
    score: number;
  }>;
  knowledgeProfile?: {
    totalMemories: number;
    topDomains: string[];
    topTypes: string[];
    avgConfidence: number;
    lastActiveAt: string;
  };
}
```

#### Capabilities

| Capability | Description |
|-----------|-------------|
| **Agent Knowledge Query** | "What does Agent-B know about topic X?" -- filtered vector search scoped by agent ID |
| **Knowledge Gap Analysis** | Compare two agents' knowledge on a topic -- surface what one knows that the other does not |
| **Agent Profiles** | Aggregated view: total memories, top domains, top types, average confidence, last active time |
| **Cross-Agent Synthesis** | When 3+ agents independently agree on a fact, it is synthesized into a fleet-level insight with elevated confidence |
| **Auto-Detection** | Queries containing agent names in `memory_recall` are automatically routed through the awareness engine without explicit `memory_toma` calls |

#### Example

```typescript
import { createMnemosyne } from 'mnemosy-ai';

const m = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'coordinator-agent',
});

// What does the devops agent know about production databases?
const knowledge = await m.toma('devops-agent', 'production database');
console.log(knowledge);
// {
//   agentId: "devops-agent",
//   topic: "production database",
//   memories: [
//     {
//       text: "Production DB is PostgreSQL 15 on port 5432",
//       confidenceTag: "Grounded",
//       memoryType: "semantic",
//       eventTime: "2024-01-10T09:00:00Z",
//       score: 0.91
//     },
//     {
//       text: "DB backups run at 02:00 UTC daily to S3",
//       confidenceTag: "Mesh Fact",
//       memoryType: "procedural",
//       eventTime: "2024-01-12T15:30:00Z",
//       score: 0.87
//     },
//   ],
//   knowledgeProfile: {
//     totalMemories: 847,
//     topDomains: ["technical", "project"],
//     topTypes: ["episodic", "procedural", "semantic"],
//     avgConfidence: 0.74,
//     lastActiveAt: "2024-01-20T14:32:00Z"
//   }
// }

// Knowledge gap analysis -- compare two agents on the same topic
const devopsKnowledge = await m.toma('devops-agent', 'Redis configuration');
const backendKnowledge = await m.toma('backend-agent', 'Redis configuration');

// Find what devops knows that backend does not
const devopsTexts = new Set(devopsKnowledge.memories.map((m) => m.text));
const backendTexts = new Set(backendKnowledge.memories.map((m) => m.text));

const gap = devopsKnowledge.memories.filter((m) => !backendTexts.has(m.text));
console.log(`DevOps knows ${gap.length} things about Redis that Backend does not`);

// Request more results with limit
const detailed = await m.toma('devops-agent', 'infrastructure monitoring', 15);
```

---

## Lifecycle Hooks

Lifecycle hooks fire automatically around every agent invocation. They require no explicit calls -- Mnemosyne injects them into the agent execution pipeline.

### 9. before_agent_start (automatic)

Fires before every agent invocation. Provides cognitive continuity and proactive context injection.

#### What It Does

| Step | Action | Purpose |
|------|--------|---------|
| 1 | **Session Recovery** | Loads the previous session snapshot (if available) from the last context window compaction or session end. Restores working memories, recent decisions, and open threads |
| 2 | **Relevant Memory Search** | Searches for memories relevant to the current prompt using the incoming user message as the query |
| 3 | **Proactive Query Generation** | Generates 1-3 speculative queries derived from entity extraction in the incoming prompt to surface context the agent did not explicitly request |
| 4 | **Context Injection** | Prepends recovered session context + recalled memories + proactive results as system context for the agent. Deduplicated and scored before injection |

#### Behavior Notes

- Runs with zero agent involvement. The agent receives pre-loaded context as if it always had that knowledge.
- Session recovery handles context window compaction gracefully. When an agent's context is reset mid-conversation, the snapshot ensures no discontinuity.
- Proactive recall generates 1-3 speculative queries based on entity extraction from the incoming prompt.
- Combined context is deduplicated and scored before injection to avoid noise.
- Configurable via `autoRecall: boolean` in the config. Set to `false` to disable.

---

### 10. agent_end (automatic)

Fires after every agent completion. Captures knowledge and applies feedback.

#### What It Does

| Step | Action | Purpose |
|------|--------|---------|
| 1 | **Session Snapshot** | Saves a structured snapshot of the current cognitive state -- working memories, recent decisions, open threads -- for recovery on next invocation |
| 2 | **Auto-Capture** | Extracts up to 3 noteworthy memories from the completed conversation. Uses observational memory compression to identify salient facts, decisions, and behavioral patterns |
| 3 | **Feedback Detection** | Analyzes the conversation for implicit feedback signals. Positive: explicit thanks, "that's right", referencing recalled content. Negative: "that's wrong", corrections, ignoring recalled memories. Applies detected signals via `memory_feedback` |

#### Behavior Notes

- Auto-capture respects the `captureMaxChars` configuration (default: 500 characters per captured memory).
- Only genuinely noteworthy content is captured. Routine acknowledgments, filler, and noise are filtered out.
- The session snapshot is stored as a private memory scoped to the current agent, not broadcast to the mesh.
- Configurable via `autoCapture: boolean` in the config. Set to `false` to disable.

---

## CLI Reference

Mnemosyne includes a command-line interface for operations, maintenance, and diagnostics. All commands use the `mnemosyne` binary installed with the `mnemosy-ai` package.

### Commands

#### `mnemosyne count`

Display memory count across all collections.

```bash
$ mnemosyne count
Shared Memories:  8,421
Private Memories: 3,102
Agent Profiles:       47
Skill Library:       312
Total:           11,882
```

#### `mnemosyne search <query>`

Enhanced search with full JSON output including scores, types, confidence, and decay status.

```bash
$ mnemosyne search "Redis port"
[
  {
    "id": "a1b2c3d4-...",
    "text": "Redis cluster migrated to port 6380 on 2024-01-15",
    "score": 0.91,
    "confidenceTag": "Grounded",
    "memoryType": "episodic",
    "entities": ["Redis", "6380"],
    "decayStatus": "active"
  },
  {
    "id": "e5f6a7b8-...",
    "text": "Redis default port is 6379, cluster bus port is 16379",
    "score": 0.85,
    "confidenceTag": "Mesh Fact",
    "memoryType": "semantic",
    "entities": ["Redis", "6379", "16379"],
    "decayStatus": "active"
  }
]
```

#### `mnemosyne consolidate [--dry-run]`

Run the standard consolidation pipeline. Use `--dry-run` to preview changes without modifying data.

```bash
$ mnemosyne consolidate --dry-run
[DRY RUN] Consolidation Report:
  Contradictions found:      2
  Near-duplicates to merge:  7
  Popular to promote:        3
  Stale to demote:          12
  No changes applied (dry run).

$ mnemosyne consolidate
Consolidation Report:
  Contradictions found:      2
  Near-duplicates merged:    7
  Popular promoted:          3
  Stale demoted:            12
  Processed: 100 memories in 1847ms
```

#### `mnemosyne consolidate-deep [--batch N]`

Run the full active consolidation with all 4 phases. Optionally set batch size (default: 100, max: 1000).

```bash
$ mnemosyne consolidate-deep --batch 500
Deep Consolidation Report:
  Phase 1 - Contradictions:     5
  Phase 2 - Duplicates merged: 23
  Phase 3 - Popular promoted:   8
  Phase 4 - Stale demoted:     41
  Processed: 500 memories in 8234ms
```

#### `mnemosyne bot-profile <agentId>`

Display a comprehensive knowledge profile for a specific agent.

```bash
$ mnemosyne bot-profile devops-agent
Agent: devops-agent
Total Memories:  847
Top Domains:     technical (72%), project (18%), knowledge (10%)
Top Types:       episodic (45%), procedural (28%), semantic (19%)
Avg Confidence:  0.74 (Grounded)
Last Active:     2024-01-20T14:32:00Z
```

#### `mnemosyne knowledge-gap <agentA> <agentB> <topic>`

Cross-agent knowledge gap analysis. Shows what agentA knows about a topic that agentB does not.

```bash
$ mnemosyne knowledge-gap devops-agent backend-agent "Redis"
Knowledge Gap: devops-agent vs backend-agent on "Redis"

devops-agent knows (that backend-agent does not):
  1. [Grounded] Redis cluster migrated to port 6380 on 2024-01-15
  2. [Grounded] Redis Sentinel runs on ports 26379-26381
  3. [Inferred] Redis memory limit set to 4GB on production

backend-agent knows (that devops-agent does not):
  1. [Grounded] Redis cache TTL for sessions is 3600 seconds
  2. [Inferred] Redis connection pool size is 20 per service

Shared knowledge (both agree):
  1. [Mesh Fact] Redis is used for session storage and pub/sub
```

#### `mnemosyne synthesize <topic>`

Fleet-level insight synthesis across all agents. Requires memories from 3+ agents to generate synthesized insights.

```bash
$ mnemosyne synthesize "production architecture"
Fleet Synthesis: "production architecture"
Sources: 5 agents contributed

Synthesized Insights:
  1. [Mesh Fact] Production runs on Kubernetes with 3 node pools
  2. [Mesh Fact] PostgreSQL 15 is the primary database on port 5432
  3. [Mesh Fact] Redis handles session storage, caching, and pub/sub
  4. [Grounded] Deployments go through staging -> canary -> production pipeline

Contributing agents: devops-agent, backend-agent, platform-agent, sre-agent, data-agent
```

#### `mnemosyne skills [query]`

List all procedural memories in the skill library, or search with an optional query.

```bash
$ mnemosyne skills
Skill Library: 312 procedures

Recent:
  1. [Grounded] How to restart the auth service (3 steps)
  2. [Mesh Fact] Database backup and restore procedure (7 steps)
  3. [Grounded] Kubernetes pod debugging workflow (5 steps)
  ...

$ mnemosyne skills "deploy"
Skill Library: 12 matches for "deploy"

  1. [Mesh Fact] (0.94) Production deployment checklist (8 steps)
  2. [Grounded] (0.89) Canary deployment rollback procedure (4 steps)
  3. [Grounded] (0.82) Staging environment deploy script (3 steps)
  ...
```

---

## Memory Cell Schema

The full 23-field TypeScript interface for a single memory record. Every memory stored in Mnemosyne carries this complete metadata payload.

```typescript
interface MemoryCell {
  // -- Identity ---------------------------------------------------------------
  /** Universally unique identifier (UUID v4) */
  id: string;

  /** Memory content -- the actual text being remembered */
  text: string;

  // -- Classification ---------------------------------------------------------
  /** 7-type taxonomy: episodic, semantic, preference, relationship, procedural, profile, core */
  memoryType: MemoryType;

  /** Security classification: public (fleet-wide), private (agent-scoped), secret (blocked) */
  classification: Classification;

  /** 4-level urgency: critical, important, reference, background */
  urgency: UrgencyLevel;

  /** 5-domain classification: technical, personal, project, knowledge, general */
  domain: Domain;

  // -- Scoring ----------------------------------------------------------------
  /** Manual or auto-computed importance (0.0-1.0). Influences retrieval ranking */
  importance: number;

  /** Composite priority from urgency x domain (0.0-1.0). Critical+technical = 1.0 */
  priorityScore: number;

  /** Multi-signal confidence (0.0-1.0). From retrieval quality, cross-agent agreement, source trust */
  confidenceScore: number;

  /** Human-readable confidence tier: "Mesh Fact", "Grounded", "Inferred", "Uncertain" */
  confidenceTag: ConfidenceTag;

  // -- Temporal (bi-temporal model) -------------------------------------------
  /** When the event actually occurred (ISO 8601). Supports temporal queries */
  eventTime: string;

  /** When this memory was ingested into the system (ISO 8601) */
  ingestedAt: string;

  /** Last modification timestamp (ISO 8601). Updated on merge, feedback, or promotion */
  updatedAt: string;

  // -- Provenance -------------------------------------------------------------
  /** Identifier of the agent that created this memory */
  botId: string;

  /** Origin context -- conversation ID, tool name, or "manual" */
  source: string;

  // -- Connectivity -----------------------------------------------------------
  /** Bidirectional links to related memories (UUIDs). Auto-populated when similarity > 0.70 */
  linkedMemories: string[];

  /** Extracted entities: people, machines, technologies, IPs, dates, ports, URLs */
  entities: string[];

  // -- Usage Tracking ---------------------------------------------------------
  /** Total number of times this memory has been retrieved via memory_recall */
  accessCount: number;

  /** Array of retrieval timestamps (Unix ms). Used for activation decay calculation */
  accessTimes: number[];

  /** Total feedback events received (positive + negative) */
  hitCount: number;

  /** Count of positive feedback signals. usefulness_ratio = usefulCount / hitCount */
  usefulCount: number;

  // -- State ------------------------------------------------------------------
  /** Soft-delete flag. When true, memory is excluded from searches but preserved for audit */
  deleted: boolean;

  /** Current activation state: "active" (>=-2.0), "fading" (-2.0 to -4.0), "archived" (<-4.0) */
  decayStatus: string;
}
```

---

## Memory Types

7-type taxonomy for memory classification. Assigned automatically by the pipeline or overridden via the `category` parameter on `memory_store`.

```typescript
type MemoryType =
  | 'episodic'       // Specific events and experiences ("deployed v2.3 on Jan 15")
  | 'semantic'       // General knowledge and facts ("Redis default port is 6379")
  | 'preference'     // User or agent preferences ("user prefers dark mode")
  | 'relationship'   // Connections between entities ("Alice reports to Bob")
  | 'procedural'     // Step-by-step procedures and skills ("To deploy: 1. Run tests 2. ...")
  | 'profile'        // Agent or entity profile summaries
  | 'core';          // Verified, high-value foundational memories (promoted via feedback/consolidation)
```

| Type | Description | Decay Behavior | Classification Triggers |
|------|-------------|---------------|------------------------|
| `episodic` | Specific events, incidents, deployments, meetings | Normal decay | Past tense, dates, "happened", "occurred" |
| `semantic` | General knowledge, facts, definitions | Normal decay | "is", "means", definitions, specifications |
| `preference` | User or agent preferences and styles | Normal decay | "prefer", "always use", "like", "dislike" |
| `relationship` | Connections between entities | Normal decay | "works with", "reports to", "connected to" |
| `procedural` | Step-by-step procedures and operational skills | **Immune to decay** | "step 1", "how to", numbered lists, "first...then" |
| `profile` | Agent or entity profile summaries | Normal decay | Agent metadata, aggregated summaries |
| `core` | Verified, high-value foundational memories | **Immune to decay** | Promoted via reinforcement learning or consolidation |

---

## Confidence Tiers

4-tier human-readable confidence indicator. Computed from three signals: retrieval quality (50%), cross-agent agreement (30%), and source trust (20%).

```typescript
type ConfidenceTag =
  | 'Mesh Fact'   // Score >= 0.85 -- Corroborated by multiple agents or sources
  | 'Grounded'    // Score 0.65-0.84 -- Strong single-source evidence
  | 'Inferred'    // Score 0.40-0.64 -- Reasonable inference, not directly verified
  | 'Uncertain';  // Score < 0.40 -- Low confidence, may need verification
```

| Tag | Score Range | Meaning | Typical Source |
|-----|-----------|---------|----------------|
| **Mesh Fact** | >= 0.85 | Corroborated by multiple agents or sources. Highest reliability | 3+ agents independently storing the same fact |
| **Grounded** | 0.65 - 0.84 | Strong single-source evidence. Reliable for most purposes | Direct observation, authoritative input |
| **Inferred** | 0.40 - 0.64 | Reasonable inference, not directly verified. Use with caution | Extracted from context, pattern-matched |
| **Uncertain** | < 0.40 | Low confidence. May need verification before acting on | Weak signals, ambiguous extraction |

---

## Additional Types

```typescript
/** Security classification -- determined in Step 1 of the ingestion pipeline */
type Classification =
  | 'public'    // Accessible by all agents in the mesh. Stored in shared collections
  | 'private'   // Scoped to the creating agent only. Stored in agent-specific collection
  | 'secret';   // Blocked from storage entirely. API keys, credentials, private keys auto-detected

/** 4-level urgency -- determines activation decay rate */
type UrgencyLevel =
  | 'critical'     // Decay rate 0.3 (slow), baseline +2.0 -- stays active for months
  | 'important'    // Decay rate 0.5, baseline +1.0 -- active for weeks
  | 'reference'    // Decay rate 0.6, baseline 0.0 -- fades over days
  | 'background';  // Decay rate 0.8 (fast), baseline -1.0 -- fades within hours

/** 5-domain classification -- determines retrieval weighting */
type Domain =
  | 'technical'    // Code, infrastructure, systems, debugging, architecture
  | 'personal'     // Preferences, habits, personal context
  | 'project'      // Project status, sprints, deadlines, team coordination
  | 'knowledge'    // General knowledge, research, learning
  | 'general';     // Catch-all for unclassified content

/** Activation decay states */
type DecayStatus =
  | 'active'     // Activation level >= -2.0 -- included in search results
  | 'fading'     // Activation level -2.0 to -4.0 -- included but penalized in scoring
  | 'archived';  // Activation level < -4.0 -- excluded from search results entirely

/** Query intent detected by the multi-signal scoring engine */
type QueryIntent =
  | 'factual'       // Looking for specific facts -- boosts similarity signal
  | 'temporal'      // Looking for recent events -- boosts recency signal
  | 'procedural'    // Looking for how-to steps -- boosts frequency signal
  | 'preference'    // Looking for preferences -- boosts type relevance signal
  | 'exploratory';  // Open-ended exploration -- balanced signal distribution

/** Reasoning chain relationship types (Flash Reasoning) */
type ReasoningRelation =
  | 'leads_to'      // A leads to B (causal)
  | 'because'       // A because B (explanatory)
  | 'therefore'     // A therefore B (consequential)
  | 'related_to';   // A related to B (associative)
```

---

## Error Handling

All API methods throw typed errors with consistent structure:

```typescript
interface MnemosyneError {
  code: string;        // Machine-readable error code
  message: string;     // Human-readable description
  details?: unknown;   // Additional context (varies by error type)
}
```

### Error Codes

| Code | Method(s) | Cause | Recovery |
|------|-----------|-------|----------|
| `VECTOR_DB_UNAVAILABLE` | All | Cannot connect to Qdrant | Check Qdrant is running and `vectorDbUrl` is correct. This is a hard dependency -- no fallback |
| `EMBEDDING_FAILED` | `store`, `recall` | Embedding service returned an error or timed out | Check embedding service is running and `embeddingUrl` is correct. Retry with backoff |
| `MEMORY_NOT_FOUND` | `forget`, `feedback` | Referenced memory ID does not exist or has already been deleted | Verify the memory ID. Use `recall` to search if the ID is unknown |
| `INVALID_PARAMETERS` | All | Missing required parameter or invalid value (e.g., negative `limit`, `importance` outside 0-1 range) | Check parameter types and ranges against the API reference |
| `CACHE_UNAVAILABLE` | `recall`, `blockGet`, `blockSet` | Redis is unreachable | **Degrades gracefully** -- recall works without caching, blocks fall back to Qdrant-only storage |
| `GRAPH_UNAVAILABLE` | `store`, `recall`, `toma` | FalkorDB is unreachable | **Degrades gracefully** -- store skips graph ingestion, recall skips graph enrichment |
| `SECRET_BLOCKED` | `store` | Content classified as secret (API keys, credentials, private keys) | Not an error -- intentional security behavior. The content was correctly blocked from storage |
| `CONSOLIDATION_FAILED` | `consolidate` | An error occurred during one of the four consolidation phases | Check logs for the specific phase that failed. Partial progress is preserved |

### Graceful Degradation

When optional services (Redis, FalkorDB) are unavailable, Mnemosyne degrades gracefully rather than failing:

```typescript
import { createMnemosyne } from 'mnemosy-ai';

// Only hard requirements: Qdrant + embedding service
const m = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'resilient-agent',
  // Redis down? These features degrade:
  //   - L2 cache: falls back to L1 only (in-memory)
  //   - Broadcast: disabled, no cross-agent sync
  //   - Shared blocks: fall back to Qdrant-only storage
  // FalkorDB down? These features degrade:
  //   - Graph enrichment: skipped in recall
  //   - Graph ingestion: skipped in store
  //   - Temporal queries: unavailable
});

// All core operations still work
await m.store('This still works without Redis or FalkorDB');
const results = await m.recall('does it work?');
// Yes -- just without caching, graph enrichment, or broadcast
```

### Error Handling Pattern

```typescript
import { createMnemosyne, MnemosyneError } from 'mnemosy-ai';

const m = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'safe-agent',
});

try {
  const result = await m.store('Important fact about production');
  if (result.status === 'blocked_secret') {
    console.warn('Content was blocked by security filter');
  } else if (result.status === 'duplicate') {
    console.log('Memory already exists -- skipped');
  } else {
    console.log(`Stored as ${result.memoryType} with ${result.linkedCount} links`);
  }
} catch (err) {
  if (err instanceof MnemosyneError) {
    switch (err.code) {
      case 'VECTOR_DB_UNAVAILABLE':
        console.error('Qdrant is down -- cannot store memories');
        break;
      case 'EMBEDDING_FAILED':
        console.error('Embedding service error -- retrying...');
        // Implement retry logic
        break;
      default:
        console.error(`Mnemosyne error [${err.code}]: ${err.message}`);
    }
  } else {
    throw err; // Re-throw unexpected errors
  }
}
```

---

## Rate Limits & Constraints

| Constraint | Value | Notes |
|------------|-------|-------|
| Max text length per `store` | 500 chars recommended | Longer text is accepted but embedding quality degrades beyond 512 tokens |
| Max `limit` per `recall` | 100 | Higher values are clamped |
| Max `batchSize` per `consolidate` | 1000 | Higher values are clamped |
| Max auto-captured memories per `agent_end` | 3 | Prevents conversation flooding |
| Embedding cache size | 512 entries | LRU eviction, 5-min TTL |
| L1 cache size | 50 entries | LRU eviction, 5-min TTL |
| L2 cache TTL | 1 hour | Pattern-based invalidation on writes |
| Auto-link threshold | 0.70 cosine similarity | Configurable via `autoLinkThreshold` |
| Duplicate threshold | 0.92 cosine similarity | Fixed |
| Conflict detection range | 0.70-0.92 cosine similarity | Fixed |
| Graph traversal max depth | 3 hops | Configurable |

---

## Configuration Reference

```typescript
interface MnemosyneConfig {
  // -- Infrastructure endpoints (required) ------------------------------------
  /** Qdrant endpoint. Required -- this is the primary memory store */
  vectorDbUrl: string;

  /** OpenAI-compatible embedding API endpoint. Required for vector generation */
  embeddingUrl: string;

  // -- Infrastructure endpoints (optional) ------------------------------------
  /** FalkorDB/RedisGraph endpoint. Enables knowledge graph features */
  graphDbUrl?: string;

  /** Redis endpoint for L2 cache + pub/sub broadcast */
  cacheUrl?: string;

  /** Optional extraction service endpoint for enhanced entity extraction */
  extractionUrl?: string;

  // -- Identity (required) ----------------------------------------------------
  /** This agent's unique identifier. Used for provenance tracking and agent awareness */
  agentId: string;

  // -- Feature toggles (all default to true) ----------------------------------
  /** Auto-store noteworthy memories from conversations via agent_end hook */
  autoCapture: boolean;

  /** Auto-recall relevant memories before agent start via before_agent_start hook */
  autoRecall: boolean;

  /** Enable temporal knowledge graph integration (requires graphDbUrl) */
  enableGraph: boolean;

  /** Enable automatic bidirectional memory linking */
  enableAutoLink: boolean;

  /** Enable activation decay model for time-based relevance */
  enableDecay: boolean;

  /** Enable cross-agent pub/sub broadcast (requires cacheUrl) */
  enableBroadcast: boolean;

  /** Enable urgency/domain priority scoring in the pipeline */
  enablePriorityScoring: boolean;

  /** Enable confidence rating system with 4-tier tags */
  enableConfidenceTags: boolean;

  // -- Tuning -----------------------------------------------------------------
  /** Minimum cosine similarity for auto-linking two memories (default: 0.70) */
  autoLinkThreshold: number;

  /** Maximum characters per auto-captured memory (default: 500) */
  captureMaxChars: number;
}
```
