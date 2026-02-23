# Quick Start Guide

Get Mnemosyne up and running in under 10 minutes. This guide walks you through every step, from starting backing services to running your first cognitive memory operations.

---

## Prerequisites

- **Node.js 18+** (LTS recommended)
- **Docker** (recommended for backing services)
- **An OpenAI-compatible embedding endpoint** (local or remote)

If you don't have an embedding service yet, you can use any endpoint that implements the OpenAI `/v1/embeddings` API. Options include:

| Provider | Type | Cost | Notes |
|----------|------|------|-------|
| [Ollama](https://ollama.com) with `nomic-embed-text` | Local | Free | Easiest local option, runs on any hardware |
| [MLX Embed Server](https://github.com/mlx-community) | Local | Free | Optimized for Apple Silicon |
| [OpenAI API](https://platform.openai.com) (`text-embedding-3-small`) | Cloud | Paid | Hosted, no setup required |
| Any `/v1/embeddings` compatible API | Either | Varies | Mnemosyne works with any OpenAI-compatible endpoint |

Mnemosyne uses **768-dimensional embeddings** by default (Nomic text architecture). If you use a different embedding model, make sure it produces 768-dim vectors, or configure accordingly.

---

## Install Backing Services

Mnemosyne has one hard requirement (**Qdrant**) and two optional services (**Redis**, **FalkorDB**) that unlock additional capabilities. Start with just Qdrant and add the others when you need them.

### Qdrant (required) -- Vector Database

Qdrant stores all memory embeddings and provides HNSW-indexed vector search. This is the only service you absolutely need.

```bash
docker run -d \
  --name qdrant \
  -p 6333:6333 \
  -v qdrant_data:/qdrant/storage \
  qdrant/qdrant
```

Verify it is running:

```bash
curl http://localhost:6333/healthz
# Expected: {"title":"qdrant - vectorass engine","version":"..."}
```

### Redis (optional) -- L2 Cache + Multi-Agent Broadcast

Redis enables two features: a distributed **L2 cache layer** (1-hour TTL, pattern-based invalidation) and **real-time pub/sub broadcast** for multi-agent deployments. Without Redis, you still get the in-memory L1 cache (50 entries, 5-min TTL), but you lose cross-agent communication and shared memory blocks.

```bash
docker run -d \
  --name redis \
  -p 6379:6379 \
  redis:7-alpine
```

### FalkorDB (optional) -- Knowledge Graph

FalkorDB provides the **temporal knowledge graph** layer. It enables entity extraction, auto-linking between memories, path finding, and temporal queries ("What was X connected to as of date Y?"). Without it, Mnemosyne works as a pure vector memory system -- still powerful, just without graph capabilities.

```bash
docker run -d \
  --name falkordb \
  -p 6380:6379 \
  falkordb/falkordb
```

### Embedding Service (if running locally)

If you are using Ollama for local embeddings:

```bash
# Install Ollama (macOS/Linux)
curl -fsSL https://ollama.com/install.sh | sh

# Pull the Nomic embedding model
ollama pull nomic-embed-text

# Ollama serves embeddings at http://localhost:11434/v1/embeddings by default
```

Test the embedding endpoint:

```bash
curl http://localhost:11434/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input": "hello world", "model": "nomic-embed-text"}'
```

### Docker Compose (All Services at Once)

For convenience, here is a `docker-compose.yml` that starts all three backing services:

```yaml
# docker-compose.yml
version: "3.8"

services:
  qdrant:
    image: qdrant/qdrant
    ports:
      - "6333:6333"
    volumes:
      - qdrant_data:/qdrant/storage
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    restart: unless-stopped

  falkordb:
    image: falkordb/falkordb
    ports:
      - "6380:6379"
    restart: unless-stopped

volumes:
  qdrant_data:
```

```bash
docker compose up -d
```

---

## Install Mnemosyne

```bash
npm install mnemosy-ai
```

Or with your preferred package manager:

```bash
# yarn
yarn add mnemosy-ai

# pnpm
pnpm add mnemosy-ai
```

---

## Basic Usage

The three operations you will use most: **store**, **recall**, and **feedback**.

### Store a Memory

Every call to `store()` runs the full 12-step zero-LLM ingestion pipeline: security filtering, embedding generation, deduplication, entity extraction, type classification, urgency detection, domain classification, priority scoring, confidence rating, vector storage, auto-linking, and broadcast. All in under 50ms with zero LLM calls.

```typescript
import { createMnemosyne } from 'mnemosy-ai';

const m = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'my-agent',
  enableGraph: false,
  enableBroadcast: false,
});

// Store different types of memories -- classification is automatic
await m.store("User prefers TypeScript over JavaScript");
// -> Classified as: preference, domain: technical, urgency: reference

await m.store("Project deadline is March 15th 2026");
// -> Classified as: episodic, domain: project, urgency: important

await m.store("The production database is PostgreSQL 16 on port 5432");
// -> Classified as: semantic, domain: technical, urgency: reference
// -> Entities extracted: PostgreSQL, 5432

await m.store("To deploy: 1) Run migrations 2) Build image 3) Push to registry 4) Apply manifest");
// -> Classified as: procedural, domain: technical, urgency: important
// -> Procedural memories are IMMUNE to activation decay

// Security filter blocks secrets automatically
await m.store("The API key is sk-proj-abc123xyz");
// -> Returns: { status: "blocked_secret" } -- never stored
```

### Recall Memories

Recall uses intent-aware multi-signal scoring. Mnemosyne automatically detects whether your query is factual, temporal, procedural, preference-based, or exploratory, and adjusts the five scoring signals accordingly.

```typescript
// Preference query -- boosts type relevance signal
const prefs = await m.recall("What does the user prefer?");
console.log(prefs);
// Returns: "User prefers TypeScript over JavaScript"
// Score breakdown: high similarity + high type relevance (preference match)

// Temporal query -- boosts recency signal
const deadlines = await m.recall("upcoming deadlines");
console.log(deadlines);
// Returns: "Project deadline is March 15th 2026"
// Score breakdown: high similarity + high recency + high importance

// Procedural query -- boosts frequency signal
const steps = await m.recall("how to deploy");
console.log(steps);
// Returns the deployment procedure
// Score breakdown: high similarity + procedural type match

// You can tune recall with optional parameters
const results = await m.recall("database configuration", {
  limit: 10,       // Return up to 10 results (default: 5)
  minScore: 0.5,   // Only return results above 0.5 relevance (default: 0.3)
});
```

### Provide Feedback

Feedback closes the reinforcement learning loop. It tells Mnemosyne which recalled memories were actually useful, enabling the system to self-optimize retrieval quality over time.

```typescript
// After the agent uses recalled memories to answer a question...

// User confirms the answer was helpful:
await m.feedback("positive");
// All memories from the last recall get their usefulness score incremented.
// Memories with usefulness ratio > 0.7 after 3+ retrievals are automatically
// promoted to "core" type (immune to decay, permanently retained).

// User corrects the agent -- the recalled memory was wrong:
await m.feedback("negative", { memoryId: "abc12345" });
// The specific memory is flagged for review.
// Consistently negative memories are deprioritized in future retrievals.
```

### Forget a Memory

Soft-delete by semantic search or by direct ID. Memories are never physically deleted -- soft-delete enables audit trails and recovery.

```typescript
// Forget by semantic search -- finds the best match and removes it
await m.forget({ query: "project deadline" });

// Forget by ID (supports short IDs -- first 8 characters of the UUID)
await m.forget({ memoryId: "abc12345" });

// If the search is ambiguous, forget() returns candidates for you to choose from
const result = await m.forget({ query: "database" });
// If multiple matches: { status: "ambiguous", candidates: [...] }
// If single high-confidence match: { status: "forgotten" }
```

### Complete Basic Example

Here is a full working example you can copy and run:

```typescript
import { createMnemosyne } from 'mnemosy-ai';

async function main() {
  // 1. Initialize with minimal config (Qdrant only)
  const m = await createMnemosyne({
    vectorDbUrl: 'http://localhost:6333',
    embeddingUrl: 'http://localhost:11434/v1/embeddings',
    agentId: 'quickstart-agent',
    enableGraph: false,
    enableBroadcast: false,
  });

  // 2. Store some memories
  await m.store("User prefers dark mode and TypeScript");
  await m.store("The API runs on port 8080 behind an nginx reverse proxy");
  await m.store("Last deploy failed because of a missing environment variable");
  await m.store("To restart the service: ssh into prod, run systemctl restart api");

  // 3. Recall with different intents
  const preferences = await m.recall("user preferences");
  console.log("Preferences:", preferences);

  const infra = await m.recall("how is the API deployed");
  console.log("Infrastructure:", infra);

  const procedures = await m.recall("how to restart");
  console.log("Procedures:", procedures);

  const issues = await m.recall("recent problems");
  console.log("Issues:", issues);

  // 4. Feedback -- the procedure was helpful
  await m.feedback("positive");

  // 5. Clean up -- forget the outdated info
  await m.forget({ query: "deploy failed" });

  console.log("Done!");
}

main().catch(console.error);
```

---

## Configuration Options

### Minimal Configuration (Vector-Only)

The simplest setup. Only requires Qdrant and an embedding endpoint. You still get the full 12-step ingestion pipeline, multi-signal retrieval, activation decay, deduplication, confidence ratings, and diversity reranking.

```typescript
import { createMnemosyne } from 'mnemosy-ai';

const m = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',          // Qdrant (required)
  embeddingUrl: 'http://localhost:11434/v1/embeddings', // Embedding API (required)
  agentId: 'my-agent',                           // Unique agent ID (required)

  // Disable features that need Redis or FalkorDB
  enableGraph: false,
  enableBroadcast: false,
});
```

### Full Configuration (All Features, Annotated)

Every option explained. All feature toggles default to `true` when the corresponding backing service URL is provided.

```typescript
import { createMnemosyne } from 'mnemosy-ai';

const m = await createMnemosyne({
  // --- Infrastructure Endpoints ---

  vectorDbUrl: 'http://localhost:6333',
  // Qdrant endpoint. Required. Stores all memory embeddings.
  // Supports both HTTP (6333) and gRPC (6334) protocols.

  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  // Any OpenAI-compatible /v1/embeddings endpoint. Required.
  // Must produce 768-dimensional vectors (Nomic text architecture).
  // Works with Ollama, MLX Embed, OpenAI API, or any compatible service.

  graphDbUrl: 'redis://localhost:6380',
  // FalkorDB / RedisGraph endpoint. Optional.
  // Enables: entity extraction, auto-linking, path finding,
  // temporal queries, timeline reconstruction, flash reasoning.

  cacheUrl: 'redis://localhost:6379',
  // Redis endpoint. Optional.
  // Enables: L2 distributed cache (1hr TTL), pub/sub broadcast,
  // shared memory blocks (Mesh Sync), cross-agent communication.

  extractionUrl: 'http://localhost:1995/extract',
  // Optional external extraction service endpoint.
  // If not provided, Mnemosyne uses its built-in zero-LLM extraction.

  // --- Identity ---

  agentId: 'production-agent-01',
  // Unique identifier for this agent. Required.
  // Used for: memory provenance, private collections, agent awareness,
  // pub/sub channels, session snapshots.

  // --- Feature Toggles ---

  autoCapture: true,
  // Automatically extract and store noteworthy memories from conversations.
  // The agent_end hook captures up to 3 salient facts per conversation.

  autoRecall: true,
  // Proactive recall before every agent invocation.
  // The before_agent_start hook searches for relevant memories based on
  // the incoming prompt and injects them as pre-loaded context.

  enableGraph: true,
  // Enable the knowledge graph layer (requires graphDbUrl).
  // Adds: entity extraction, auto-linking, path finding, temporal queries,
  // timeline reconstruction, flash reasoning chains.

  enableAutoLink: true,
  // Automatically create bidirectional links between related memories.
  // New memories are compared against existing ones; pairs above the
  // autoLinkThreshold get linked, building a Zettelkasten-style knowledge web.

  enableDecay: true,
  // Enable activation decay model. Memories fade over time based on urgency:
  //   Critical: slow decay (stays active for months)
  //   Important: moderate decay (active for weeks)
  //   Reference: normal decay (fades over days)
  //   Background: fast decay (fades within hours)
  // Procedural and core memories are immune to decay.

  enableBroadcast: true,
  // Enable cross-agent pub/sub broadcast (requires cacheUrl).
  // Every store/update/forget event is published to the agent mesh.
  // Critical memories get priority routing.

  enablePriorityScoring: true,
  // Enable urgency x domain composite priority scoring.
  // Urgency (critical/important/reference/background) combined with
  // domain (technical/personal/project/knowledge/general) produces
  // a 0.0-1.0 priority score that influences retrieval ranking.

  enableConfidenceTags: true,
  // Enable the 4-tier confidence rating system.
  // Every memory gets a confidence score and human-readable tag:
  //   Mesh Fact (>= 0.85): corroborated by multiple agents
  //   Grounded (0.65-0.84): strong single-source evidence
  //   Inferred (0.40-0.64): reasonable inference, not verified
  //   Uncertain (< 0.40): low confidence, needs verification

  // --- Tuning ---

  autoLinkThreshold: 0.70,
  // Minimum cosine similarity for auto-linking two memories.
  // Lower = more links (more connections, potentially more noise).
  // Higher = fewer links (more precise, potentially missing connections).
  // Default: 0.70. Range: 0.0 - 1.0.

  captureMaxChars: 500,
  // Maximum characters per auto-captured memory.
  // Longer content is truncated. Keeps memory cells concise and focused.
  // Default: 500.
});
```

### Progressive Adoption Path

You do not need to enable everything at once. Start simple and add features as you need them:

| Level | Services Needed | What You Get |
|-------|----------------|--------------|
| **Vector-Only** | Qdrant | Persistent memory, 12-step pipeline, multi-signal recall, decay, dedup, confidence ratings, diversity reranking |
| **+ Knowledge Graph** | Qdrant + FalkorDB | Entity extraction, auto-linking, path finding, temporal queries, flash reasoning |
| **+ Multi-Agent** | Qdrant + FalkorDB + Redis | Pub/sub broadcast, shared blocks, L2 cache, agent awareness, cross-agent corroboration |
| **Full Cognitive** | All services, all toggles | Everything above + proactive recall, session survival, auto-capture, reinforcement learning |

---

## Your First Cognitive Features

Even at the vector-only level, Mnemosyne does far more than store and retrieve vectors. Here are the cognitive features you get out of the box.

### Activation Decay

Memories fade over time, just like human memory. Each access refreshes the activation level. Critical and procedural memories resist decay; background memories fade quickly.

```typescript
import { createMnemosyne } from 'mnemosy-ai';

async function decayDemo() {
  const m = await createMnemosyne({
    vectorDbUrl: 'http://localhost:6333',
    embeddingUrl: 'http://localhost:11434/v1/embeddings',
    agentId: 'decay-demo',
    enableGraph: false,
    enableBroadcast: false,
    enableDecay: true,  // Enabled by default, shown here for clarity
  });

  // Store memories with different urgency levels (auto-detected from content)
  await m.store("CRITICAL: Production database is down, immediate action required");
  // -> Urgency: critical, decay rate: 0.3 (slow), stays active for months

  await m.store("The team decided to use PostgreSQL for the new project");
  // -> Urgency: reference, decay rate: 0.6 (normal), fades over days

  await m.store("Saw a typo in the README, minor issue");
  // -> Urgency: background, decay rate: 0.8 (fast), fades within hours

  await m.store("To deploy: 1) Build 2) Test 3) Push 4) Apply manifest");
  // -> Type: procedural -- IMMUNE to decay, permanently active

  // Hours later... background memories are fading
  // Days later... reference memories are fading
  // Weeks later... critical memories are still active
  // Forever... procedural memories never decay

  // Each recall refreshes activation, so frequently-used memories stay fresh
  await m.recall("deployment steps");  // Refreshes the procedural memory
  await m.recall("deployment steps");  // Each access bumps the activation level
}

decayDemo().catch(console.error);
```

**Activation states:**

| State | Activation Level | Behavior |
|-------|-----------------|----------|
| **Active** | >= -2.0 | Appears in search results normally |
| **Fading** | -2.0 to -4.0 | Reduced score in search results |
| **Archived** | < -4.0 | Excluded from search results entirely |

### Auto-Linking

When you store a memory, Mnemosyne automatically finds related existing memories and creates bidirectional links. This builds a Zettelkasten-style knowledge web without any manual effort.

```typescript
import { createMnemosyne } from 'mnemosy-ai';

async function autoLinkDemo() {
  const m = await createMnemosyne({
    vectorDbUrl: 'http://localhost:6333',
    embeddingUrl: 'http://localhost:11434/v1/embeddings',
    agentId: 'link-demo',
    enableGraph: false,
    enableBroadcast: false,
    enableAutoLink: true,
    autoLinkThreshold: 0.70,
  });

  // Store related memories
  const r1 = await m.store("The payment service runs on port 3001");
  console.log(r1);
  // { status: "created", linkedCount: 0 }  -- nothing to link to yet

  const r2 = await m.store("Payment service uses Stripe as the payment gateway");
  console.log(r2);
  // { status: "created", linkedCount: 1 }  -- auto-linked to memory about payment service

  const r3 = await m.store("The payment service had an outage on Feb 15th due to Stripe API rate limits");
  console.log(r3);
  // { status: "created", linkedCount: 2 }  -- auto-linked to both previous memories

  // When you recall, linked memories enrich the results
  const results = await m.recall("payment service issues");
  // Returns the outage memory, enriched with links to:
  //   - "Payment service uses Stripe..." (related context)
  //   - "The payment service runs on port 3001" (infrastructure context)
  // These links enable flash reasoning chains:
  //   "payment outage -> caused by Stripe rate limits -> service on port 3001"
}

autoLinkDemo().catch(console.error);
```

### Entity Extraction

Mnemosyne extracts structured entities from every memory, entirely algorithmically with zero LLM calls. Extracted entities include people, technologies, IP addresses, ports, dates, and URLs.

```typescript
import { createMnemosyne } from 'mnemosy-ai';

async function entityDemo() {
  const m = await createMnemosyne({
    vectorDbUrl: 'http://localhost:6333',
    embeddingUrl: 'http://localhost:11434/v1/embeddings',
    agentId: 'entity-demo',
    enableGraph: false,
    enableBroadcast: false,
  });

  await m.store("Alice deployed the API to 10.0.1.50:8080 on March 1st using Docker");
  // Entities extracted automatically (zero LLM calls):
  //   - Person: Alice
  //   - IP: 10.0.1.50
  //   - Port: 8080
  //   - Date: March 1st
  //   - Technology: Docker, API

  await m.store("Bob fixed the PostgreSQL replication lag on db-prod.internal:5432");
  // Entities extracted:
  //   - Person: Bob
  //   - Technology: PostgreSQL
  //   - Host: db-prod.internal
  //   - Port: 5432

  // Entity-rich memories produce better search results because
  // the extracted metadata participates in multi-signal scoring
  const results = await m.recall("what did Alice deploy");
  // High relevance: entity match (Alice) + semantic similarity
}

entityDemo().catch(console.error);
```

### Deduplication and Conflict Detection

Mnemosyne automatically detects duplicates and conflicts during ingestion. Duplicate memories (>= 0.92 cosine similarity) are merged or rejected. Conflicting memories (0.70-0.92 similarity with semantic disagreement) trigger alerts.

```typescript
import { createMnemosyne } from 'mnemosy-ai';

async function dedupDemo() {
  const m = await createMnemosyne({
    vectorDbUrl: 'http://localhost:6333',
    embeddingUrl: 'http://localhost:11434/v1/embeddings',
    agentId: 'dedup-demo',
    enableGraph: false,
    enableBroadcast: false,
  });

  // Store a fact
  await m.store("The database server runs PostgreSQL 16");
  // { status: "created" }

  // Store a near-duplicate
  await m.store("PostgreSQL 16 is running on the database server");
  // { status: "duplicate" } -- cosine similarity >= 0.92, merged automatically

  // Store a conflicting fact
  await m.store("The database server runs MySQL 8");
  // Conflict detected: similarity 0.70-0.92 with semantic disagreement
  // The memory is still stored, but a conflict alert is broadcast
  // Active consolidation (m.consolidate()) will surface this for resolution
}

dedupDemo().catch(console.error);
```

### Multi-Signal Scoring and Diversity Reranking

Every search scores results across 5 independent signals. Results are then diversity-reranked to prevent returning five variations of the same information.

```typescript
import { createMnemosyne } from 'mnemosy-ai';

async function scoringDemo() {
  const m = await createMnemosyne({
    vectorDbUrl: 'http://localhost:6333',
    embeddingUrl: 'http://localhost:11434/v1/embeddings',
    agentId: 'scoring-demo',
    enableGraph: false,
    enableBroadcast: false,
  });

  // Store diverse memories about deployments
  await m.store("To deploy: run migrations, build, push, apply manifest");
  await m.store("Last deploy failed because of missing env var");
  await m.store("We deploy to staging first, then production after QA sign-off");
  await m.store("Deploy frequency target is twice per week");
  await m.store("Alice handles production deploys on Tuesdays");

  // Factual query -- similarity gets 50% weight
  const factual = await m.recall("who handles deploys");
  // Alice memory scores highest: strong semantic match

  // Temporal query -- recency gets 35% weight
  const temporal = await m.recall("what happened in the last deploy");
  // The failure memory scores highest: temporal intent detected, recency boosted

  // Procedural query -- frequency gets 20% boost
  const procedural = await m.recall("how to deploy");
  // The step-by-step memory scores highest: procedural type match

  // Exploratory query -- balanced weights
  const exploratory = await m.recall("tell me about deployments");
  // Returns a DIVERSE mix: procedure, failure, schedule, responsibility
  // Diversity reranking ensures no two results are >0.9 similar
  // Same-type penalty kicks in after 3+ results of the same memory type
}

scoringDemo().catch(console.error);
```

---

## Adding Knowledge Graph

Enable FalkorDB to unlock Layer 3 -- the temporal knowledge graph. This adds entity-relationship tracking, multi-hop path finding, temporal queries, and flash reasoning chains.

### Configuration

```typescript
import { createMnemosyne } from 'mnemosy-ai';

const m = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  graphDbUrl: 'redis://localhost:6380',   // FalkorDB endpoint
  agentId: 'graph-agent',

  enableGraph: true,        // Enable knowledge graph layer
  enableAutoLink: true,     // Auto-link related memories (bidirectional)
  autoLinkThreshold: 0.70,  // Minimum cosine similarity for auto-linking

  enableBroadcast: false,   // Redis not needed yet
});
```

### How the Graph Works

When you store a memory, Mnemosyne automatically:

1. Extracts entities (people, technologies, IPs, dates, URLs, ports)
2. Creates graph nodes for each entity
3. Links memories to their entities: `(Memory) --MENTIONS--> (Entity)`
4. Links entities to each other: `(Entity) --RELATES_TO--> (Entity)`
5. Tags all relationships with timestamps for temporal queries
6. Auto-links related memories bidirectionally

```typescript
// Build a knowledge graph through normal store operations
await m.store("Alice deployed the payment service to production on March 1st");
await m.store("The payment service connects to PostgreSQL on db-prod.internal:5432");
await m.store("Alice fixed a critical bug in the payment service last week");
await m.store("Bob reviewed Alice's fix and approved the PR");
await m.store("The payment service processes transactions via Stripe API");

// The graph now contains:
//
//   (Alice) --RELATES_TO--> (payment service)
//   (Alice) --RELATES_TO--> (Bob)
//   (payment service) --RELATES_TO--> (PostgreSQL)
//   (payment service) --RELATES_TO--> (Stripe)
//   (payment service) --RELATES_TO--> (db-prod.internal)
//   (PostgreSQL) --RELATES_TO--> (db-prod.internal)
//
// Each relationship has a `since` timestamp for temporal queries.
// Each memory is linked to its mentioned entities via MENTIONS edges.
```

### Graph-Enriched Recall

With the graph enabled, recall results are enriched with entity context and flash reasoning chains:

```typescript
// Standard vector search + graph enrichment
const results = await m.recall("payment service issues");
// Returns memories about the payment service, enriched with:
//   - Related entities: Alice, PostgreSQL, Stripe, db-prod.internal
//   - Linked memories: deployment, bug fix, database connection
//   - Flash reasoning chain:
//     "payment service deployed -> had critical bug -> fixed by Alice -> reviewed by Bob"

// Timeline reconstruction -- chronological history of an entity
const timeline = await m.recall("timeline of payment service");
// Returns all memories mentioning "payment service" in order:
//   1. Connects to PostgreSQL on db-prod.internal:5432
//   2. Deployed to production on March 1st
//   3. Critical bug found
//   4. Bug fixed by Alice

// Relationship discovery -- how two entities connect
const relationship = await m.recall("how are Alice and PostgreSQL related");
// Graph traversal finds the path:
//   Alice -> payment service -> PostgreSQL
// Returns memories along that path with context
```

### What the Knowledge Graph Adds

| Capability | Description |
|------------|-------------|
| **Entity Extraction** | Automatic identification of people, machines, technologies, IPs, dates, ports, URLs |
| **Auto-Linking** | New memories discover and link to related existing memories (bidirectional) |
| **Path Finding** | Shortest-path queries between any two entities (configurable max depth, default: 3 hops) |
| **Timeline Reconstruction** | Ordered history of all memories mentioning a given entity |
| **Temporal Queries** | "What was X connected to as of date Y?" using bi-temporal timestamps |
| **Flash Reasoning** | Chain-of-thought traversal through linked memories: `A -> because -> B -> therefore -> C` |
| **Graph Enrichment** | Recall results automatically include related entities and reasoning context |

---

## Adding Multi-Agent

Add Redis to unlock the multi-agent capabilities: real-time pub/sub broadcast, shared memory blocks (Mesh Sync), cross-agent corroboration, and the Agent Awareness Engine (Theory of Mind for Agents).

### Configuration

```typescript
import { createMnemosyne } from 'mnemosy-ai';

// Agent A: DevOps agent
const devopsAgent = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  graphDbUrl: 'redis://localhost:6380',
  cacheUrl: 'redis://localhost:6379',      // Redis for cache + broadcast
  agentId: 'devops-agent',                 // Each agent needs a unique ID

  enableGraph: true,
  enableAutoLink: true,
  enableBroadcast: true,                   // Enable pub/sub broadcast
  enableDecay: true,
  enablePriorityScoring: true,
  enableConfidenceTags: true,
  autoLinkThreshold: 0.70,
});

// Agent B: Backend agent (separate process, same config pattern)
const backendAgent = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  graphDbUrl: 'redis://localhost:6380',
  cacheUrl: 'redis://localhost:6379',
  agentId: 'backend-agent',               // Different agent ID
  enableGraph: true,
  enableAutoLink: true,
  enableBroadcast: true,
  enableDecay: true,
  enablePriorityScoring: true,
  enableConfidenceTags: true,
  autoLinkThreshold: 0.70,
});
```

### Shared Memory Blocks (Mesh Sync)

Shared blocks are named, versioned key-value state that all agents can read and write. They are stored as core memories with maximum confidence, so they always surface in relevant searches.

```typescript
// DevOps agent writes shared state
await devopsAgent.blockSet({
  name: "project_status",
  content: "Sprint 12 in progress. Payment refactor: 80% complete. Target: March 15th."
});

await devopsAgent.blockSet({
  name: "on_call",
  content: "Alice is on-call this week. Escalation: Bob (backup). PagerDuty channel: #ops-alerts."
});

await devopsAgent.blockSet({
  name: "team_preferences",
  content: "Code style: Prettier + ESLint. Language: TypeScript strict mode. Tests: Vitest. CI: GitHub Actions."
});

// Backend agent (different process, different machine) reads the same block
const status = await backendAgent.blockGet({ name: "project_status" });
console.log(status);
// {
//   content: "Sprint 12 in progress. Payment refactor: 80% complete. Target: March 15th.",
//   version: 1,
//   lastWriter: "devops-agent",
//   updatedAt: "2026-03-01T10:00:00Z"
// }

// Any agent can update -- version increments automatically
await backendAgent.blockSet({
  name: "project_status",
  content: "Sprint 12 complete. Payment refactor: merged. Deployed to staging."
});

const updated = await devopsAgent.blockGet({ name: "project_status" });
console.log(updated.version);    // 2
console.log(updated.lastWriter); // "backend-agent"
```

### Agent Awareness (Theory of Mind)

Query what any agent in the mesh knows about any topic, without direct communication.

```typescript
// What does the backend agent know about the production database?
const knowledge = await devopsAgent.toma({
  agentId: "backend-agent",
  topic: "production database",
});
console.log(knowledge);
// Returns a formatted list of everything backend-agent has stored about
// the production database: schemas, connection strings, migration history, etc.

// What does the DevOps agent know about deployment procedures?
const procedures = await backendAgent.toma({
  agentId: "devops-agent",
  topic: "deployment procedures",
  limit: 5,
});
console.log(procedures);
// Returns the DevOps agent's deployment knowledge: runbooks, procedures, configs
```

### Cross-Agent Broadcast and Corroboration

When any agent stores a memory, it is automatically broadcast to all others in the mesh. When 3+ agents independently confirm the same fact, it is promoted to "Mesh Fact" confidence.

```typescript
// DevOps agent stores a critical memory
await devopsAgent.store("Production deploy failed at 14:32 -- rollback initiated");
// Automatically:
//   1. Stored in Qdrant (shared collection, visible to all agents)
//   2. Broadcast event published to Redis pub/sub
//   3. All connected agents receive the event and invalidate relevant caches
//   4. Classified as urgency: critical -- gets priority routing

// Backend agent independently stores corroborating info
await backendAgent.store("API returning 500 errors since 14:32, appears deploy-related");

// If a third agent also confirms...
// await qaAgent.store("Automated tests failing since 14:32, production API unreachable");
// -> The fact "production issue at 14:32" is now corroborated by 3 agents
// -> Promoted to "Mesh Fact" confidence (>= 0.85)
// -> Fleet-level insight synthesized automatically
```

### What Multi-Agent Adds

| Capability | Description |
|------------|-------------|
| **Pub/Sub Broadcast** | Real-time memory events across the agent mesh via Redis |
| **Mesh Sync Blocks** | Named, versioned shared state (project status, on-call, team preferences) |
| **Agent Awareness (ToMA)** | Query what any agent knows about any topic |
| **Knowledge Gap Analysis** | Identify what one agent knows that another does not |
| **Cross-Agent Corroboration** | When 3+ agents agree, facts are promoted to Mesh Fact confidence |
| **Fleet-Level Synthesis** | Auto-synthesized insights that no single agent could produce |
| **L2 Distributed Cache** | Redis-backed cache layer (1-hour TTL) shared across all agents |
| **Cache Invalidation** | Pattern-based invalidation on store, update, and forget events |

---

## Next Steps

Now that you have Mnemosyne running, explore the rest of the documentation:

- **[Configuration Reference](configuration.md)** -- Every config option explained with defaults, ranges, and recommendations
- **[Features Deep Dive](features.md)** -- Detailed walkthrough of all 10 cognitive features with architecture diagrams
- **[API Reference](api.md)** -- Complete documentation for all 9 tools: parameters, return types, error handling, and examples
- **[Deployment Guide](deployment.md)** -- Production deployment patterns: single node, multi-agent mesh, and cloud/managed
- **[Comparison](comparison.md)** -- How Mnemosyne compares to Mem0, Zep, Cognee, LangMem, and Letta

### Quick Reference: All 9 Tools

| Tool | Purpose |
|------|---------|
| `memory_store` | Full 12-step ingestion pipeline |
| `memory_recall` | Intelligent search with multi-signal ranking |
| `memory_forget` | Soft-delete by ID or semantic search |
| `memory_block_get` | Read a named shared memory block |
| `memory_block_set` | Write/update a named shared memory block |
| `memory_feedback` | Reinforcement learning signal (positive/negative) |
| `memory_consolidate` | Run 4-phase active consolidation pipeline |
| `memory_toma` | Query another agent's knowledge (Theory of Mind) |
| `before_agent_start` | Automatic hook: session recovery, proactive recall |

### CLI Commands

Mnemosyne includes a CLI for operations and maintenance:

```bash
# Count memories across all collections
mnemosyne count

# Search memories (returns JSON)
mnemosyne search "deployment procedures"

# Run consolidation (dry run first)
mnemosyne consolidate --dry-run
mnemosyne consolidate

# Run deep consolidation (all 4 phases)
mnemosyne consolidate-deep --batch 100

# Agent profiles and knowledge queries
mnemosyne bot-profile devops-agent
mnemosyne knowledge-gap devops-agent backend-agent "database migrations"
mnemosyne synthesize "production infrastructure"

# Skill library
mnemosyne skills
mnemosyne skills "deploy"
```

---

## Troubleshooting

### Qdrant connection refused

```
Error: connect ECONNREFUSED 127.0.0.1:6333
```

Make sure Qdrant is running: `docker ps | grep qdrant`. If not, start it:

```bash
docker run -d --name qdrant -p 6333:6333 -v qdrant_data:/qdrant/storage qdrant/qdrant
```

### Embedding endpoint not responding

```
Error: Failed to generate embedding
```

Verify your embedding service is running and accessible. Test it directly:

```bash
curl http://localhost:11434/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input": "test", "model": "nomic-embed-text"}'
```

### FalkorDB graph features not working

Make sure `graphDbUrl` is set and `enableGraph` is `true`. FalkorDB runs on a different port than standard Redis (6380 in our examples, mapped from its internal 6379) to avoid conflicts.

### Redis broadcast not connecting

Verify Redis is running on the port specified in `cacheUrl`. If you use both FalkorDB and Redis, they must be on separate ports (FalkorDB: 6380, Redis: 6379).

### Memories not persisting across container restarts

Ensure Qdrant has a volume mount: `-v qdrant_data:/qdrant/storage`. Without a volume, data is stored in the container's ephemeral filesystem and lost on restart.

### Secrets being blocked from storage

This is intentional. Mnemosyne's security filter automatically blocks API keys, credentials, private keys, and other secrets from being stored. If you see `{ status: "blocked_secret" }`, the content contained sensitive material. Redact secrets before storing.

---

<p align="center">
  <strong>Mnemosyne</strong> -- Because intelligence without memory isn't intelligence.
</p>
