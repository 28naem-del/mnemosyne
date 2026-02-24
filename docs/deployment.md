# Deployment Guide

## Overview

Mnemosyne is designed around a single principle: **same code, same config interface, every deployment model**. Whether you run everything on your laptop or distribute across a fleet of cloud services, the only thing that changes is the URLs in your `MnemosyneConfig` object. No code changes. No conditional imports. No "cloud edition."

Three deployment models are documented here:

1. **Single Node** -- everything on one machine. Development, testing, single-agent production.
2. **Multi-Agent Mesh** -- multiple agents sharing centralized backing services. Real-time sync and collaboration.
3. **Cloud / Managed** -- managed cloud services for production at scale. Serverless-friendly.

Each model uses the same `createMnemosyne()` call, the same 9 tools, the same 12-step pipeline. The backing services scale independently; Mnemosyne adapts gracefully when optional services are unavailable.

---

## Backing Service Details

Before diving into deployment models, understand what each backing service does, when you need it, and what resources it requires.

### Qdrant (Required)

**What it does:** Primary vector storage. All memories are stored as 768-dimensional embeddings in Qdrant's HNSW index. Qdrant holds the memory cells, their full metadata payload (23 fields per memory), and handles filtered vector search. Every collection -- shared memories, private memories, agent profiles, skill library -- lives in Qdrant.

**When it is needed:** Always. Qdrant is the only required backing service. Without it, Mnemosyne cannot function.

**Port:** 6333 (REST API), 6334 (gRPC)

**Resource requirements:**

| Memory Count | RAM Required | Disk Required | Notes |
|-------------|-------------|--------------|-------|
| Up to 10K | 512 MB | 100 MB | Development workloads |
| Up to 100K | 2 GB | 1 GB | Single-agent production |
| Up to 1M | 8 GB | 10 GB | Multi-agent fleet |
| 1M+ | 16+ GB | 50+ GB | Consider sharding or Qdrant Cloud |

The HNSW index lives in RAM. At 768 dimensions, each vector consumes approximately 3 KB of memory (vector + metadata overhead). Qdrant also supports disk-backed mode for cost optimization at the expense of latency.

**Docker command:**

```bash
docker run -d --name qdrant \
  -p 6333:6333 \
  -p 6334:6334 \
  -v qdrant_data:/qdrant/storage \
  qdrant/qdrant
```

**Configuration:**

```typescript
{
  vectorDbUrl: 'http://localhost:6333'
}
```

---

### Redis (Optional)

**What it does:** Two functions in one service:

1. **L2 distributed cache** -- 1-hour TTL, pattern-based invalidation. Sits behind the in-process L1 cache (50 entries, 5-min TTL). Together they deliver sub-10ms cached recall.
2. **Pub/Sub broadcast** -- real-time memory events across the agent mesh. When one agent stores a memory, all other agents receive a typed event (new memory, invalidation, conflict alert, critical priority routing).

**When it is needed:**

- Multi-agent deployments (required for pub/sub broadcast and shared state synchronization)
- Any deployment where you want distributed caching across multiple Mnemosyne instances
- Single-agent deployments that need cache persistence across process restarts

**Port:** 6379

**Resource requirements:**

| Agent Count | RAM Required | Notes |
|------------|-------------|-------|
| 1-5 agents | 256 MB | Minimal cache + pub/sub |
| 5-20 agents | 512 MB | Moderate cache usage |
| 20-50 agents | 1 GB | High throughput pub/sub |
| 50+ agents | 2+ GB | Consider Redis Cluster |

**Docker command:**

```bash
docker run -d --name redis \
  -p 6379:6379 \
  -v redis_data:/data \
  redis:7-alpine redis-server --appendonly yes
```

**What happens when Redis is unavailable:** Mnemosyne degrades gracefully. The L1 in-memory cache still works (50 entries, 5-min TTL). Broadcast is silently disabled -- agents still store and recall memories, they just do not receive real-time notifications from other agents. Shared blocks fall back to direct Qdrant storage (higher latency, but functional).

**Configuration:**

```typescript
{
  cacheUrl: 'redis://localhost:6379'
}
```

---

### FalkorDB (Optional)

**What it does:** Temporal knowledge graph. Stores entity relationships extracted from memories with full temporal metadata. Enables:

- **Temporal queries** -- "What was X connected to as of date Y?"
- **Path finding** -- shortest-path queries between any two entities
- **Timeline reconstruction** -- ordered history of all memories mentioning an entity
- **Entity extraction** -- automatic identification of people, machines, technologies, IPs, dates, ports, URLs
- **Flash Reasoning** -- chain-of-thought traversal through linked memory graphs

**Graph schema:**

```
(Memory) --MENTIONS--> (Entity)
(Memory) --CREATED_BY--> (Agent)
(Entity) --RELATES_TO--> (Entity)
```

**When it is needed:**

- When you want entity extraction and automatic relationship tracking
- When you need temporal queries ("What changed between Tuesday and Thursday?")
- When you want Flash Reasoning chains that traverse linked memories
- When agents need to understand the topology of their knowledge

**Port:** 6380 (mapped from internal 6379 -- FalkorDB uses the Redis wire protocol)

**Resource requirements:**

| Entity Count | RAM Required | Notes |
|-------------|-------------|-------|
| Up to 100K | 256 MB | Typical single-agent workload |
| Up to 1M | 512 MB | Multi-agent fleet |
| 1M-10M | 2 GB | Large graph, complex traversals |
| 10M+ | 4+ GB | Increase memory allocation |

**Docker command:**

```bash
docker run -d --name falkordb \
  -p 6380:6379 \
  -v falkordb_data:/data \
  falkordb/falkordb
```

Note: FalkorDB uses the Redis wire protocol on port 6379 internally. We map it to host port 6380 to avoid conflict with Redis.

**What happens when FalkorDB is unavailable:** Mnemosyne disables graph ingestion and graph enrichment. Vector search, auto-linking (via cosine similarity in Qdrant), and all other features continue to work. Flash Reasoning is disabled since it depends on graph traversal.

**Configuration:**

```typescript
{
  graphDbUrl: 'redis://localhost:6380'
}
```

---

### Embedding Service (Required)

**What it does:** Converts text to 768-dimensional vectors for storage and search. Mnemosyne calls any OpenAI-compatible `/v1/embeddings` endpoint.

**Port:** 11434 (default for Ollama/MLX Serve), or cloud API endpoints

**Options:**

| Provider | Endpoint | Latency | Cost | Notes |
|----------|----------|---------|------|-------|
| **Ollama** (local) | `http://localhost:11434/v1/embeddings` | ~15ms | Free | Uses `nomic-embed-text`, fully private |
| **MLX Serve** (local, macOS) | `http://localhost:11434/v1/embeddings` | ~10ms | Free | Optimized for Apple Silicon |
| **OpenAI** (cloud) | `https://api.openai.com/v1/embeddings` | 50-200ms | ~$0.00002/call | `text-embedding-3-small` (1536-dim) or configure 768-dim |
| **Cohere** (cloud) | `https://api.cohere.ai/v1/embeddings` | 50-150ms | ~$0.00001/call | `embed-english-v3.0` |
| **Self-hosted** | Any endpoint | Varies | Varies | Any model that outputs 768-dim vectors |

768-dimensional vectors are recommended (Nomic architecture). This is what Mnemosyne's HNSW index, similarity thresholds, and auto-link detection are calibrated for. Other dimensions work but may require threshold tuning.

**Docker command (Ollama):**

```bash
docker run -d --name ollama \
  -p 11434:11434 \
  -v ollama_data:/root/.ollama \
  ollama/ollama

# Pull the embedding model
docker exec ollama ollama pull nomic-embed-text
```

**Resource requirements (local embedding):**

| Provider | RAM Required | CPU/GPU | Notes |
|----------|-------------|---------|-------|
| Ollama (nomic-embed-text) | 1 GB | 2 CPU cores | Single-threaded by default |
| MLX Serve (macOS) | 1 GB | Apple Silicon | Uses Metal for acceleration |
| vLLM / TEI | 2+ GB | GPU recommended | High-throughput serving |

**Configuration:**

```typescript
{
  embeddingUrl: 'http://localhost:11434/v1/embeddings'
}
```

---

## Deployment Model 1: Single Node

```
┌──────────────────────────────────────────────────────────────┐
│                        HOST MACHINE                          │
│                                                              │
│   ┌──────────────────────────────────────────────────────┐   │
│   │                  Your Application                     │   │
│   │          ┌──────────────────────────┐                 │   │
│   │          │       Mnemosyne          │                 │   │
│   │          │      (mnemosy-ai)        │                 │   │
│   │          └────────┬─────────────────┘                 │   │
│   └───────────────────┼──────────────────────────────────┘   │
│                       │                                      │
│          ┌────────────┼────────────┬──────────────┐          │
│          ▼            ▼            ▼              ▼          │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│   │  Qdrant  │ │  Redis   │ │ FalkorDB │ │  Embedding   │  │
│   │  :6333   │ │  :6379   │ │  :6380   │ │  Service     │  │
│   │ (vector) │ │ (cache + │ │ (graph)  │ │  :11434      │  │
│   │ REQUIRED │ │  pubsub) │ │ OPTIONAL │ │  REQUIRED    │  │
│   │          │ │ OPTIONAL │ │          │ │              │  │
│   └──────────┘ └──────────┘ └──────────┘ └──────────────┘  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**When to use:** Development, testing, single-agent production deployments.

**Minimum requirements:** 4 GB RAM, 2 CPU cores.

**Recommended requirements:** 8 GB RAM, 4 CPU cores (for all four services plus your application).

### Starting Individual Services

If you want to start services one at a time (useful for minimal setups):

**Qdrant (required):**

```bash
docker run -d --name qdrant \
  -p 6333:6333 \
  -p 6334:6334 \
  -v qdrant_data:/qdrant/storage \
  --restart unless-stopped \
  qdrant/qdrant
```

**Redis (optional -- enables L2 cache + pub/sub):**

```bash
docker run -d --name redis \
  -p 6379:6379 \
  -v redis_data:/data \
  --restart unless-stopped \
  redis:7-alpine redis-server --appendonly yes
```

**FalkorDB (optional -- enables knowledge graph):**

```bash
docker run -d --name falkordb \
  -p 6380:6379 \
  -v falkordb_data:/data \
  --restart unless-stopped \
  falkordb/falkordb
```

**Embedding service (required -- any OpenAI-compatible endpoint):**

```bash
docker run -d --name ollama \
  -p 11434:11434 \
  -v ollama_data:/root/.ollama \
  --restart unless-stopped \
  ollama/ollama

# Pull the embedding model after the container starts
docker exec ollama ollama pull nomic-embed-text
```

### Docker Compose (All Services)

Create a `docker-compose.yml` with all four services, health checks, volumes, and resource limits:

```yaml
version: "3.8"

networks:
  mnemosyne:
    driver: bridge

services:
  # ──────────────────────────────────────
  # Qdrant — Primary vector storage
  # ──────────────────────────────────────
  qdrant:
    image: qdrant/qdrant:latest
    container_name: mnemosyne-qdrant
    networks:
      - mnemosyne
    ports:
      - "6333:6333"    # REST API
      - "6334:6334"    # gRPC
    volumes:
      - qdrant_data:/qdrant/storage
    environment:
      - QDRANT__SERVICE__GRPC_PORT=6334
    deploy:
      resources:
        limits:
          memory: 2G
        reservations:
          memory: 512M
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:6333/healthz"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s

  # ──────────────────────────────────────
  # Redis — L2 cache + pub/sub broadcast
  # ──────────────────────────────────────
  redis:
    image: redis:7-alpine
    container_name: mnemosyne-redis
    networks:
      - mnemosyne
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    command: >
      redis-server
      --appendonly yes
      --maxmemory 512mb
      --maxmemory-policy allkeys-lru
    deploy:
      resources:
        limits:
          memory: 768M
        reservations:
          memory: 256M
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 5s

  # ──────────────────────────────────────
  # FalkorDB — Temporal knowledge graph
  # ──────────────────────────────────────
  falkordb:
    image: falkordb/falkordb:latest
    container_name: mnemosyne-falkordb
    networks:
      - mnemosyne
    ports:
      - "6380:6379"
    volumes:
      - falkordb_data:/data
    deploy:
      resources:
        limits:
          memory: 1G
        reservations:
          memory: 256M
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "-p", "6379", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 5s

  # ──────────────────────────────────────
  # Ollama — Local embedding service
  # ──────────────────────────────────────
  ollama:
    image: ollama/ollama:latest
    container_name: mnemosyne-ollama
    networks:
      - mnemosyne
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama
    deploy:
      resources:
        limits:
          memory: 2G
        reservations:
          memory: 1G
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:11434/api/tags"]
      interval: 15s
      timeout: 10s
      retries: 3
      start_period: 30s

volumes:
  qdrant_data:
    driver: local
  redis_data:
    driver: local
  falkordb_data:
    driver: local
  ollama_data:
    driver: local
```

Start everything:

```bash
docker compose up -d
```

Pull the embedding model:

```bash
docker exec mnemosyne-ollama ollama pull nomic-embed-text
```

Verify all services are healthy:

```bash
docker compose ps
```

Expected output -- all services showing `healthy`:

```
NAME                  STATUS                  PORTS
mnemosyne-qdrant      Up (healthy)            0.0.0.0:6333->6333/tcp, 0.0.0.0:6334->6334/tcp
mnemosyne-redis       Up (healthy)            0.0.0.0:6379->6379/tcp
mnemosyne-falkordb    Up (healthy)            0.0.0.0:6380->6379/tcp
mnemosyne-ollama      Up (healthy)            0.0.0.0:11434->11434/tcp
```

### Install Mnemosyne

```bash
npm install mnemosy-ai
```

### Minimal Configuration (Vector-Only)

This is the simplest possible setup. Only Qdrant and an embedding service are required. All optional features that depend on Redis or FalkorDB are disabled.

```typescript
import { createMnemosyne } from 'mnemosy-ai'

const mnemosyne = await createMnemosyne({
  // Required -- vector storage
  vectorDbUrl: 'http://localhost:6333',

  // Required -- embedding generation
  embeddingUrl: 'http://localhost:11434/v1/embeddings',

  // Required -- unique identifier for this agent
  agentId: 'my-agent',

  // Disable features that require optional services
  enableGraph: false,       // No FalkorDB
  enableBroadcast: false,   // No Redis pub/sub
})
```

What you get with this minimal config:

- Full 12-step zero-LLM ingestion pipeline
- Vector search with multi-signal scoring
- Activation decay model
- Diversity reranking
- Auto-linking via cosine similarity (stored in Qdrant metadata)
- Security filter (blocks secrets)
- Deduplication and merge
- Priority scoring and confidence tags
- L1 in-memory cache (50 entries, 5-min TTL)
- Session survival across context resets

What you do NOT get:

- L2 distributed cache (falls back to L1 only)
- Real-time broadcast to other agents
- Shared blocks via Redis (falls back to Qdrant-backed blocks)
- Knowledge graph traversal and temporal queries
- Flash Reasoning chains
- Entity extraction to graph

### Full Configuration (All Features)

All four backing services running, all cognitive features enabled:

```typescript
import { createMnemosyne } from 'mnemosy-ai'

const mnemosyne = await createMnemosyne({
  // Required services
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',

  // Optional services
  cacheUrl: 'redis://localhost:6379',
  graphDbUrl: 'redis://localhost:6380',

  // Identity
  agentId: 'my-agent',

  // Cognitive features (all default to true when services are available)
  autoCapture: true,            // Auto-store from conversations
  autoRecall: true,             // Auto-recall before agent start
  enableGraph: true,            // Knowledge graph integration
  enableAutoLink: true,         // Automatic memory linking
  enableDecay: true,            // Activation decay model
  enableBroadcast: true,        // Cross-agent pub/sub
  enablePriorityScoring: true,  // Urgency/domain scoring
  enableConfidenceTags: true,   // Confidence rating system

  // Tuning
  autoLinkThreshold: 0.70,     // Min similarity for auto-link (default)
  captureMaxChars: 500,        // Max chars per auto-capture (default)
})
```

### Verification Steps

After configuring Mnemosyne, verify the full stack is working:

```typescript
import { createMnemosyne } from 'mnemosy-ai'

const mnemosyne = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  cacheUrl: 'redis://localhost:6379',
  graphDbUrl: 'redis://localhost:6380',
  agentId: 'test-agent',
})

// 1. Store a memory
const storeResult = await mnemosyne.store(
  'The production database runs on PostgreSQL 16 on port 5432'
)
console.log('Store result:', storeResult)
// Expected: { status: "created", linkedCount: 0 }

// 2. Recall a memory
const recallResult = await mnemosyne.recall('what database is used in production?')
console.log('Recall result:', recallResult)
// Expected: Array with the stored memory, scored and ranked

// 3. Store another memory to test auto-linking
const storeResult2 = await mnemosyne.store(
  'PostgreSQL backups run every 6 hours via pg_dump'
)
console.log('Store result 2:', storeResult2)
// Expected: { status: "created", linkedCount: 1 }  <-- linked to first memory

// 4. Test shared blocks
await mnemosyne.blockSet('deployment_status', 'All services green')
const block = await mnemosyne.blockGet('deployment_status')
console.log('Block content:', block.content)
// Expected: "All services green"

// 5. Run consolidation
const report = await mnemosyne.consolidate()
console.log('Consolidation report:', report)
// Expected: { contradictions: 0, nearDuplicatesMerged: 0, popularPromoted: 0, staleDemoted: 0 }
```

You can also verify via the CLI:

```bash
# Check memory count
npx mnemosyne count

# Search for memories
npx mnemosyne search "production database"

# Run a dry-run consolidation
npx mnemosyne consolidate --dry-run
```

---

## Deployment Model 2: Multi-Agent Mesh

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│   Agent A     │   │   Agent B     │   │   Agent C     │   │   Agent D     │
│  (DevOps)     │   │  (Support)    │   │  (Research)   │   │  (Security)   │
│ ┌──────────┐  │   │ ┌──────────┐  │   │ ┌──────────┐  │   │ ┌──────────┐  │
│ │Mnemosyne │  │   │ │Mnemosyne │  │   │ │Mnemosyne │  │   │ │Mnemosyne │  │
│ │agentId:  │  │   │ │agentId:  │  │   │ │agentId:  │  │   │ │agentId:  │  │
│ │"devops"  │  │   │ │"support" │  │   │ │"research"│  │   │ │"security"│  │
│ └────┬─────┘  │   │ └────┬─────┘  │   │ └────┬─────┘  │   │ └────┬─────┘  │
└──────┼────────┘   └──────┼────────┘   └──────┼────────┘   └──────┼────────┘
       │                   │                   │                   │
       │        ┌──────────┘                   └──────────┐        │
       │        │                                         │        │
       └────────┼─────────────────┬───────────────────────┼────────┘
                │                 │                       │
                ▼                 ▼                       ▼
   ┌──────────────────────────────────────────────────────────────┐
   │                     SHARED SERVICES HOST                      │
   │                                                               │
   │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐ │
   │  │  Qdrant  │  │  Redis   │  │ FalkorDB │  │  Embedding   │ │
   │  │  :6333   │  │  :6379   │  │  :6380   │  │  Service     │ │
   │  │          │  │          │  │          │  │  :11434      │ │
   │  │ Unified  │  │ L2 Cache │  │ Shared   │  │              │ │
   │  │ Memory   │  │ + Pub/Sub│  │ Graph    │  │  Shared      │ │
   │  │ Store    │  │ Broadcast│  │          │  │  Embeddings  │ │
   │  └──────────┘  └──────────┘  └──────────┘  └──────────────┘ │
   │                                                               │
   └──────────────────────────────────────────────────────────────┘
```

**When to use:** Multiple agents that need shared memory, real-time synchronization, cross-agent awareness, and collaborative knowledge building.

**Architecture:** Each agent runs its own Mnemosyne instance in its own process (or container, or machine). All instances connect to the same shared backing services. Redis pub/sub provides real-time event propagation. Qdrant holds the unified memory store. FalkorDB holds the shared knowledge graph.

### How Multi-Agent Sync Works

1. **Pub/Sub broadcast:** When Agent A stores a memory, a typed event is published to Redis. All other agents receive it instantly and can invalidate caches, update local state, or react to critical alerts. Event types include: new memory, cache invalidation, conflict alert, critical priority routing.

2. **Shared blocks (Mesh Sync):** Named, versioned key-value state that all agents can read and write. Think of them as shared whiteboards: `"project_status"`, `"current_sprint"`, `"team_preferences"`. Stored as core memories with maximum confidence, ensuring they participate in retrieval and reasoning alongside organic memories.

3. **Agent Awareness Engine:** Any agent can query another agent's knowledge -- `"What does the DevOps agent know about the production database?"` -- without direct communication. Knowledge gap analysis identifies what one agent knows that another does not.

4. **Cross-agent corroboration:** When 3+ agents independently store memories that agree on the same fact, Mnemosyne auto-synthesizes a fleet-level insight with elevated confidence (tagged "Mesh Fact").

5. **Collection isolation:** Shared memories are fleet-wide. Private memories are scoped to a single agent. Both live in the same Qdrant cluster but in separate collections.

### Infrastructure Setup

Deploy the shared services on a dedicated infrastructure host (or multiple hosts if you need more isolation). All agents connect to these endpoints.

**Shared services `docker-compose.yml`:**

```yaml
version: "3.8"

networks:
  mnemosyne:
    driver: bridge

services:
  qdrant:
    image: qdrant/qdrant:latest
    container_name: mnemosyne-qdrant
    networks:
      - mnemosyne
    ports:
      - "6333:6333"
      - "6334:6334"
    volumes:
      - qdrant_data:/qdrant/storage
    environment:
      - QDRANT__SERVICE__GRPC_PORT=6334
    deploy:
      resources:
        limits:
          memory: 4G
        reservations:
          memory: 1G
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:6333/healthz"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s

  redis:
    image: redis:7-alpine
    container_name: mnemosyne-redis
    networks:
      - mnemosyne
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    command: >
      redis-server
      --appendonly yes
      --maxmemory 1gb
      --maxmemory-policy allkeys-lru
      --requirepass "${REDIS_PASSWORD:-}"
    deploy:
      resources:
        limits:
          memory: 1536M
        reservations:
          memory: 512M
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 5s

  falkordb:
    image: falkordb/falkordb:latest
    container_name: mnemosyne-falkordb
    networks:
      - mnemosyne
    ports:
      - "6380:6379"
    volumes:
      - falkordb_data:/data
    deploy:
      resources:
        limits:
          memory: 2G
        reservations:
          memory: 512M
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "-p", "6379", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 5s

  ollama:
    image: ollama/ollama:latest
    container_name: mnemosyne-ollama
    networks:
      - mnemosyne
    ports:
      - "11434:11434"
    volumes:
      - ollama_data:/root/.ollama
    deploy:
      resources:
        limits:
          memory: 2G
        reservations:
          memory: 1G
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:11434/api/tags"]
      interval: 15s
      timeout: 10s
      retries: 3
      start_period: 30s

volumes:
  qdrant_data:
    driver: local
  redis_data:
    driver: local
  falkordb_data:
    driver: local
  ollama_data:
    driver: local
```

Start the shared services:

```bash
docker compose up -d
docker exec mnemosyne-ollama ollama pull nomic-embed-text
```

Replace `INFRA_HOST` in the examples below with the hostname or IP address of the machine running these services (e.g., `192.168.1.100`, `my-server.local`, or a VPN IP).

### Per-Agent Configuration

Each agent gets a unique `agentId` but connects to the same service URLs. The `agentId` determines:

- Which private memories belong to this agent
- How this agent's memories are tagged in the shared collection
- How other agents reference this agent in Theory of Mind queries
- How the Agent Awareness Engine builds this agent's profile

**Agent A (DevOps):**

```typescript
import { createMnemosyne } from 'mnemosy-ai'

const mnemosyne = await createMnemosyne({
  vectorDbUrl: 'http://INFRA_HOST:6333',
  embeddingUrl: 'http://INFRA_HOST:11434/v1/embeddings',
  cacheUrl: 'redis://INFRA_HOST:6379',
  graphDbUrl: 'redis://INFRA_HOST:6380',
  agentId: 'devops-agent',
  autoCapture: true,
  autoRecall: true,
  enableGraph: true,
  enableAutoLink: true,
  enableDecay: true,
  enableBroadcast: true,        // Must be true for mesh sync
  enablePriorityScoring: true,
  enableConfidenceTags: true,
})
```

**Agent B (Support):**

```typescript
import { createMnemosyne } from 'mnemosy-ai'

const mnemosyne = await createMnemosyne({
  vectorDbUrl: 'http://INFRA_HOST:6333',       // Same Qdrant
  embeddingUrl: 'http://INFRA_HOST:11434/v1/embeddings',  // Same embedding
  cacheUrl: 'redis://INFRA_HOST:6379',          // Same Redis
  graphDbUrl: 'redis://INFRA_HOST:6380',        // Same FalkorDB
  agentId: 'support-agent',                     // Different agentId
  enableBroadcast: true,
  autoCapture: true,
  autoRecall: true,
  enableGraph: true,
  enableAutoLink: true,
  enableDecay: true,
  enablePriorityScoring: true,
  enableConfidenceTags: true,
})
```

**Agent C (Research):**

```typescript
import { createMnemosyne } from 'mnemosy-ai'

const mnemosyne = await createMnemosyne({
  vectorDbUrl: 'http://INFRA_HOST:6333',
  embeddingUrl: 'http://INFRA_HOST:11434/v1/embeddings',
  cacheUrl: 'redis://INFRA_HOST:6379',
  graphDbUrl: 'redis://INFRA_HOST:6380',
  agentId: 'research-agent',                    // Different agentId
  enableBroadcast: true,
  autoCapture: true,
  autoRecall: true,
  enableGraph: true,
  enableAutoLink: true,
  enableDecay: true,
  enablePriorityScoring: true,
  enableConfidenceTags: true,
})
```

### Verifying Mesh Connectivity

After all agents are configured and running, verify that the mesh is functioning:

**1. Verify all agents can reach shared services:**

```bash
# From each agent host, test connectivity
curl http://INFRA_HOST:6333/healthz               # Qdrant
redis-cli -h INFRA_HOST -p 6379 ping              # Redis
redis-cli -h INFRA_HOST -p 6380 ping              # FalkorDB
curl http://INFRA_HOST:11434/api/tags              # Ollama
```

**2. Verify cross-agent memory visibility:**

```typescript
// On Agent A (DevOps)
await mnemosyneA.store('Production deployment completed at 14:00 UTC')

// On Agent B (Support) -- should find Agent A's memory
const results = await mnemosyneB.recall('deployment status')
console.log(results)
// Expected: Returns the memory stored by Agent A (shared collection)
```

**3. Test shared blocks:**

```typescript
// Agent A writes a shared block
await mnemosyneA.blockSet('project_status', 'Sprint 5: 80% complete, 3 bugs open')

// Agent B reads the same block
const block = await mnemosyneB.blockGet('project_status')
console.log(block.content)
// Expected: "Sprint 5: 80% complete, 3 bugs open"
console.log(block.lastWriter)
// Expected: "devops-agent"
```

**4. Test broadcast (real-time sync):**

```typescript
// Agent B subscribes to events (happens automatically with enableBroadcast: true)
// Agent A stores a critical memory
await mnemosyneA.store('CRITICAL: Database failover initiated on primary cluster', {
  importance: 1.0,
})
// Agent B's L1 and L2 caches are automatically invalidated
// Agent B's next recall will include the new critical memory
```

**5. Test Agent Awareness (Theory of Mind):**

```typescript
// Agent B asks: "What does the DevOps agent know about deployments?"
const devopsKnowledge = await mnemosyneB.toma('devops-agent', 'deployments')
console.log(devopsKnowledge)
// Expected: List of DevOps agent's memories related to deployments

// Knowledge gap analysis
const gap = await mnemosyneB.knowledgeGap('support-agent', 'devops-agent', 'infrastructure')
console.log(gap)
// Expected: Topics that DevOps knows about but Support does not
```

### Scaling Considerations for Mesh Deployments

**Adding agents:** Simply deploy a new Mnemosyne instance with a unique `agentId` pointing to the same shared services. No configuration changes on existing agents. The new agent immediately has access to all shared memories and begins participating in broadcast events.

**Network topology:** Agents do not communicate directly with each other. All communication flows through the shared services (Qdrant for storage, Redis for real-time events). This means agents can be on different networks, different machines, or even different data centers -- as long as they can reach the shared services.

**Bandwidth:** Each store operation publishes a small event to Redis pub/sub (a few hundred bytes). Each recall operation reads from Qdrant (a few KB). Even with 50 agents doing continuous operations, bandwidth to the shared services is modest (low single-digit MB/s).

**Agent count limits:**

| Agent Count | Shared Service Requirements | Notes |
|------------|----------------------------|-------|
| 2-5 | Minimal (single node compose) | Default resource limits are sufficient |
| 5-20 | Moderate (increase Qdrant to 4 GB RAM) | Monitor Qdrant memory, Redis pub/sub throughput |
| 20-50 | High (dedicated host, Redis 2 GB) | Consider separating services onto different hosts |
| 50+ | Production-grade | Use managed services or dedicated infrastructure per service |

---

## Deployment Model 3: Cloud / Managed

```
┌─────────────────────────────────────────────────────────────────┐
│                     CLOUD INFRASTRUCTURE                         │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ Qdrant Cloud│  │ Redis Cloud  │  │  OpenAI / Cohere     │   │
│  │  (managed)  │  │ (ElastiCache │  │  Embedding API       │   │
│  │             │  │  / Upstash)  │  │                      │   │
│  │  Vector     │  │  Cache +     │  │  /v1/embeddings      │   │
│  │  Storage    │  │  Pub/Sub     │  │                      │   │
│  └──────┬──────┘  └──────┬───────┘  └──────────┬───────────┘   │
│         │                │                      │               │
│  ┌──────┴──────┐         │                      │               │
│  │ FalkorDB   │         │                      │               │
│  │ Cloud      │         │                      │               │
│  │ (managed)  │         │                      │               │
│  └──────┬──────┘         │                      │               │
│         │                │                      │               │
└─────────┼────────────────┼──────────────────────┼───────────────┘
          │                │                      │
          └────────────────┼──────────────────────┘
                           │
            ┌──────────────┴──────────────┐
            │                              │
   ┌────────┴────────┐         ┌──────────┴──────────┐
   │  Agent Instance  │         │  Agent Instance      │
   │  (container /    │         │  (serverless /       │
   │   VM / Lambda)   │         │   Cloud Run / ECS)   │
   │  ┌────────────┐  │         │  ┌────────────┐      │
   │  │ Mnemosyne  │  │         │  │ Mnemosyne  │      │
   │  │(mnemosy-ai)│  │         │  │(mnemosy-ai)│      │
   │  └────────────┘  │         │  └────────────┘      │
   └──────────────────┘         └──────────────────────┘
```

**When to use:** Production at scale, serverless agent deployments, when you want zero infrastructure management, or when agents run in ephemeral environments (Lambda, Cloud Run, ECS tasks).

### Compatible Managed Services

#### Qdrant Cloud

Fully managed vector database. Zero-ops, automatic scaling, built-in backups, TLS by default.

- **Sign up:** https://cloud.qdrant.io
- **Pricing:** Free tier for up to 1 GB. Paid tiers scale by storage and RAM.
- **Configuration:**

```typescript
{
  vectorDbUrl: 'https://your-cluster-id.us-east4-0.gcp.cloud.qdrant.io:6333',
  // API key passed via environment variable or header
}
```

- **Regions:** Available on GCP, AWS, and Azure across multiple regions.
- **Latency:** 5-20ms per vector search (varies by region and cluster size).

#### Redis Cloud / ElastiCache / Upstash

Any managed Redis service that supports pub/sub and standard Redis commands.

**Redis Cloud (Redis Labs):**

```typescript
{
  cacheUrl: 'rediss://default:password@redis-12345.c1.us-east-1-2.ec2.cloud.redislabs.com:12345',
}
```

**AWS ElastiCache:**

```typescript
{
  cacheUrl: 'rediss://your-cluster.abc123.ng.0001.use1.cache.amazonaws.com:6379',
}
```

**Upstash (serverless Redis):**

```typescript
{
  cacheUrl: 'rediss://default:password@us1-abc-12345.upstash.io:6379',
}
```

- **Pub/Sub note:** Upstash serverless Redis has limited pub/sub support. For multi-agent mesh deployments that depend heavily on real-time broadcast, use Redis Cloud or ElastiCache instead.
- **Latency:** 1-5ms per cache operation.

#### FalkorDB Cloud

Managed graph database with the RedisGraph-compatible API.

- **Sign up:** https://app.falkordb.cloud
- **Configuration:**

```typescript
{
  graphDbUrl: 'redis://your-instance.falkordb.cloud:6380',
}
```

- **Alternative:** If no managed FalkorDB is available in your region, you can run FalkorDB on a small VM (2 GB RAM is sufficient for most workloads) or omit it entirely and set `enableGraph: false`.

#### OpenAI / Cohere / Any Compatible Embedding API

Any service that exposes an OpenAI-compatible `/v1/embeddings` endpoint.

**OpenAI:**

```typescript
{
  embeddingUrl: 'https://api.openai.com/v1/embeddings',
  // API key via OPENAI_API_KEY environment variable
}
```

**Cohere:**

```typescript
{
  embeddingUrl: 'https://api.cohere.ai/v1/embeddings',
  // API key via COHERE_API_KEY environment variable
}
```

**Azure OpenAI:**

```typescript
{
  embeddingUrl: 'https://your-resource.openai.azure.com/openai/deployments/your-model/embeddings?api-version=2024-02-01',
}
```

**Dimension note:** 768-dimensional vectors are what Mnemosyne's thresholds are calibrated for. If you use OpenAI's `text-embedding-3-small` (which outputs 1536-dim by default), either configure the API to output 768-dim or adjust Mnemosyne's auto-link and dedup thresholds accordingly.

### Full Cloud Configuration Example

```typescript
import { createMnemosyne } from 'mnemosy-ai'

const mnemosyne = await createMnemosyne({
  // Qdrant Cloud
  vectorDbUrl: 'https://abc12345.us-east4-0.gcp.cloud.qdrant.io:6333',

  // OpenAI embeddings
  embeddingUrl: 'https://api.openai.com/v1/embeddings',

  // Redis Cloud
  cacheUrl: 'rediss://default:your-password@redis-12345.c1.us-east-1-2.ec2.cloud.redislabs.com:12345',

  // FalkorDB Cloud (or omit and set enableGraph: false)
  graphDbUrl: 'redis://your-instance.falkordb.cloud:6380',

  // Identity
  agentId: 'production-agent-01',

  // All features enabled
  autoCapture: true,
  autoRecall: true,
  enableGraph: true,
  enableAutoLink: true,
  enableDecay: true,
  enableBroadcast: true,
  enablePriorityScoring: true,
  enableConfidenceTags: true,
  autoLinkThreshold: 0.70,
})
```

### Cloud Configuration Without FalkorDB

If you do not want to manage a FalkorDB instance, omit the graph:

```typescript
import { createMnemosyne } from 'mnemosy-ai'

const mnemosyne = await createMnemosyne({
  vectorDbUrl: 'https://abc12345.us-east4-0.gcp.cloud.qdrant.io:6333',
  embeddingUrl: 'https://api.openai.com/v1/embeddings',
  cacheUrl: 'rediss://default:your-password@redis-12345.c1.us-east-1-2.ec2.cloud.redislabs.com:12345',

  agentId: 'production-agent-01',
  enableGraph: false,            // No FalkorDB -- graph features disabled
  enableAutoLink: true,          // Auto-linking still works via cosine similarity
  enableBroadcast: true,
  enableDecay: true,
  enablePriorityScoring: true,
  enableConfidenceTags: true,
})
```

### Security Considerations

**TLS everywhere:** All managed cloud services use TLS by default.

- Qdrant Cloud: Use `https://` URL (TLS is mandatory).
- Redis Cloud / ElastiCache: Use `rediss://` URL scheme (note the double `s` -- this signals TLS).
- OpenAI / Cohere: Always `https://`.
- FalkorDB Cloud: Check provider documentation; use `rediss://` if TLS is supported.

**Authentication:**

| Service | Auth Method | Configuration |
|---------|-----------|---------------|
| Qdrant Cloud | API key | Passed via environment variable or header |
| Redis Cloud | Password in URL | `rediss://default:password@host:port` |
| ElastiCache | IAM or AUTH token | `rediss://:auth-token@host:port` |
| Upstash | Password in URL | `rediss://default:password@host:port` |
| OpenAI | API key header | `OPENAI_API_KEY` environment variable |
| Cohere | API key header | `COHERE_API_KEY` environment variable |

**Network security:**

- Place all backing services in a private subnet (VPC, private endpoint).
- Never expose Qdrant or Redis directly to the public internet without authentication.
- Use VPC peering or private endpoints for agent-to-service communication.
- If agents run in serverless (Lambda, Cloud Run), use VPC connectors or private networking.

**Built-in security filter:** Mnemosyne's 3-tier security classifier runs on every memory before storage, regardless of deployment model:

| Classification | Behavior |
|---------------|----------|
| **Public** | Stored in shared collection, visible to all agents |
| **Private** | Stored in agent-scoped collection, visible only to the creating agent |
| **Secret** | **Blocked from storage entirely**. API keys, credentials, private keys are detected and rejected. |

### Cost Estimation

Mnemosyne's zero-LLM pipeline means the only per-memory variable cost is the embedding API call. The ingestion pipeline itself (classification, entity extraction, urgency detection, conflict resolution, auto-linking) costs nothing.

**Per-memory costs:**

| Component | Cost Per Memory | Notes |
|-----------|----------------|-------|
| Embedding (OpenAI) | ~$0.00002 | `text-embedding-3-small`, one call per store + one per recall |
| Embedding (Cohere) | ~$0.00001 | `embed-english-v3.0` |
| Embedding (local) | $0.00 | Ollama / MLX Serve -- only hardware cost |
| Pipeline (ingestion) | $0.00 | Zero LLM calls -- fully algorithmic |
| Pipeline (retrieval) | $0.00 | Scoring, decay, diversity -- all algorithmic |

**Monthly infrastructure costs (estimates):**

| Tier | Memory Count | Qdrant | Redis | Embedding | Total |
|------|-------------|--------|-------|-----------|-------|
| **Free / Dev** | <10K | Qdrant Cloud Free | Upstash Free | Local (Ollama) | $0/month |
| **Starter** | 10K-100K | Qdrant Cloud $25 | Redis Cloud $5 | OpenAI ~$5 | ~$35/month |
| **Production** | 100K-1M | Qdrant Cloud $100 | Redis Cloud $30 | OpenAI ~$20 | ~$150/month |
| **Scale** | 1M+ | Qdrant Cloud $300+ | ElastiCache $50+ | OpenAI ~$50+ | ~$400+/month |

These are rough estimates. Actual costs depend on query frequency, agent count, and provider pricing.

---

## Health Checks

Verify each backing service is running correctly before connecting Mnemosyne.

### Qdrant

```bash
# REST health endpoint
curl http://localhost:6333/healthz
# Expected: {"title":"qdrant - vector search engine","version":"..."}

# Check collections (empty on first run, populated after Mnemosyne initializes)
curl http://localhost:6333/collections
# Expected: {"result":{"collections":[...]},"status":"ok","time":...}

# Check a specific collection's stats
curl http://localhost:6333/collections/shared_memories
# Expected: JSON with vectors_count, points_count, status

# Cluster info (for multi-node Qdrant)
curl http://localhost:6333/cluster
```

### Redis

```bash
# Ping
redis-cli -h localhost -p 6379 ping
# Expected: PONG

# Server info
redis-cli -h localhost -p 6379 info server | head -5

# Memory usage
redis-cli -h localhost -p 6379 info memory | grep used_memory_human
# Expected: used_memory_human:xxx

# Check pub/sub channels (populated after agents connect)
redis-cli -h localhost -p 6379 pubsub channels "mnemosyne:*"

# Key count (cache entries)
redis-cli -h localhost -p 6379 dbsize

# With authentication
redis-cli -h localhost -p 6379 -a 'your-password' ping
```

### FalkorDB

```bash
# Ping (uses Redis wire protocol)
redis-cli -h localhost -p 6380 ping
# Expected: PONG

# List graphs (populated after Mnemosyne stores memories with graph enabled)
redis-cli -h localhost -p 6380 GRAPH.LIST
# Expected: List of graph names (e.g., "mnemosyne_knowledge")

# Query graph stats
redis-cli -h localhost -p 6380 GRAPH.QUERY mnemosyne_knowledge "MATCH (n) RETURN count(n)"
# Expected: Count of nodes in the knowledge graph
```

### Embedding Service (Ollama)

```bash
# Check available models
curl http://localhost:11434/api/tags
# Expected: JSON with "nomic-embed-text" in models list

# Test embedding generation
curl -s http://localhost:11434/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input": "test embedding generation", "model": "nomic-embed-text"}' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Dimensions: {len(d[\"data\"][0][\"embedding\"])}')"
# Expected: Dimensions: 768
```

### Embedding Service (OpenAI)

```bash
curl -s https://api.openai.com/v1/embeddings \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input": "test", "model": "text-embedding-3-small"}' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Dimensions: {len(d[\"data\"][0][\"embedding\"])}')"
# Expected: Dimensions: 1536 (or 768 if configured)
```

### All-Services Health Check Script

Save this as `healthcheck.sh` and run it to verify all services at once:

```bash
#!/usr/bin/env bash
set -euo pipefail

HOST="${1:-localhost}"

echo "=== Mnemosyne Health Check ==="
echo ""

# Qdrant
echo -n "Qdrant ($HOST:6333)... "
if curl -sf "http://$HOST:6333/healthz" > /dev/null 2>&1; then
  echo "OK"
else
  echo "FAILED"
fi

# Redis
echo -n "Redis ($HOST:6379)... "
if redis-cli -h "$HOST" -p 6379 ping 2>/dev/null | grep -q PONG; then
  echo "OK"
else
  echo "FAILED (or not installed)"
fi

# FalkorDB
echo -n "FalkorDB ($HOST:6380)... "
if redis-cli -h "$HOST" -p 6380 ping 2>/dev/null | grep -q PONG; then
  echo "OK"
else
  echo "FAILED (or not installed)"
fi

# Ollama
echo -n "Ollama ($HOST:11434)... "
if curl -sf "http://$HOST:11434/api/tags" > /dev/null 2>&1; then
  echo "OK"
else
  echo "FAILED (or not installed)"
fi

echo ""
echo "=== Done ==="
```

```bash
chmod +x healthcheck.sh
./healthcheck.sh                  # Check localhost
./healthcheck.sh 192.168.1.100   # Check remote host
```

---

## Monitoring

### Key Metrics to Watch

| Metric | What to Track | Healthy Range | How to Measure |
|--------|--------------|---------------|---------------|
| **Memory count** | Total memories across all collections | Growing steadily | `mnemosyne count` or Qdrant API |
| **Store latency** | Time for the full 12-step ingestion pipeline | < 50ms | Application-level timing |
| **Recall latency (cached)** | L1 or L2 cache hit | < 10ms | Application-level timing |
| **Recall latency (uncached)** | Full vector search + scoring + graph enrichment | < 200ms | Application-level timing |
| **Cache hit rate** | L1 + L2 combined hit rate | > 60% for conversational workloads | Redis `INFO stats` keyspace hits/misses |
| **Embedding latency** | Time per embedding generation | < 20ms (local), < 200ms (cloud) | Application-level timing |
| **Dedup rate** | Percentage of stores that hit duplicate detection | Depends on workload | Count `duplicate` vs `created` store results |
| **Consolidation stats** | Contradictions, merges, promotions, demotions per run | Decreasing contradictions over time | `mnemosyne consolidate-deep` output |
| **Pub/Sub message rate** | Events published and received per second | Proportional to store rate | Redis `PUBSUB NUMSUB` |
| **Qdrant RAM usage** | Memory consumed by HNSW index | < 80% of allocated RAM | Qdrant telemetry or `docker stats` |
| **Redis memory** | Cache + pub/sub buffer size | < 80% of maxmemory | `redis-cli info memory` |

### Qdrant Monitoring

```bash
# Collection stats (memory count, vector count, index status)
curl -s http://localhost:6333/collections/shared_memories | python3 -m json.tool

# All collections summary
curl -s http://localhost:6333/collections | python3 -m json.tool

# Telemetry (detailed performance metrics)
curl -s http://localhost:6333/telemetry | python3 -m json.tool

# Cluster info (multi-node Qdrant deployments)
curl -s http://localhost:6333/cluster | python3 -m json.tool
```

### Redis Monitoring

```bash
# Memory usage
redis-cli -h localhost -p 6379 info memory

# Pub/sub channels active
redis-cli -h localhost -p 6379 pubsub channels "mnemosyne:*"

# Subscriber count per channel
redis-cli -h localhost -p 6379 pubsub numsub mnemosyne:broadcast

# Key count (cache entries)
redis-cli -h localhost -p 6379 dbsize

# Keyspace hit/miss ratio (cache effectiveness)
redis-cli -h localhost -p 6379 info stats | grep keyspace

# Connected clients (should match active agent count)
redis-cli -h localhost -p 6379 info clients | grep connected_clients
```

### Consolidation Reports

Run consolidation and inspect the report:

```bash
# Via CLI -- standard consolidation
npx mnemosyne consolidate --dry-run

# Deep consolidation (all 4 phases)
npx mnemosyne consolidate-deep --batch 100

# Expected output:
# {
#   contradictions: 3,
#   nearDuplicatesMerged: 12,
#   popularPromoted: 5,
#   staleDemoted: 8
# }
```

Track these numbers over time. A healthy system shows:

- **Contradictions decreasing** -- conflicts are being resolved
- **Near-duplicates decreasing** -- dedup at ingestion time is catching more
- **Popular promotions steady** -- valuable memories are being recognized
- **Stale demotions proportional** -- idle memories are being cleaned up

### Agent Profile Monitoring

```bash
# Get an agent's knowledge profile
npx mnemosyne bot-profile devops-agent

# Cross-agent knowledge gap
npx mnemosyne knowledge-gap support-agent devops-agent infrastructure

# Fleet-level synthesis on a topic
npx mnemosyne synthesize "production deployment procedures"
```

---

## Troubleshooting

### Qdrant Issues

**Problem: "Connection refused" to Qdrant**

```
Error: connect ECONNREFUSED 127.0.0.1:6333
```

**Cause:** Qdrant is not running or is not listening on the expected port.

**Solution:**

```bash
# Check if Qdrant container is running
docker ps | grep qdrant

# If not running, start it
docker start mnemosyne-qdrant

# Check logs for errors
docker logs mnemosyne-qdrant --tail 50

# Verify the port is accessible
curl http://localhost:6333/healthz
```

**Problem: Qdrant out of memory**

```
Error: Service unavailable: not enough memory
```

**Cause:** The HNSW index has grown beyond allocated RAM.

**Solution:** Increase the memory limit in your Docker Compose file or switch to Qdrant's disk-backed mode:

```yaml
qdrant:
  deploy:
    resources:
      limits:
        memory: 4G   # Increase from 2G
```

For very large collections, enable on-disk storage in Qdrant's configuration.

**Problem: Collections not being created**

**Cause:** Mnemosyne creates collections on first use. If you see "collection not found" errors, the initialization may have failed.

**Solution:** Check Mnemosyne's startup logs. The most common cause is the embedding service being unavailable at initialization time (Mnemosyne needs to verify the embedding dimension to create collections).

---

### Redis Issues

**Problem: "Connection refused" to Redis**

```
Error: connect ECONNREFUSED 127.0.0.1:6379
```

**Solution:**

```bash
docker ps | grep redis
docker start mnemosyne-redis
docker logs mnemosyne-redis --tail 50
redis-cli -h localhost -p 6379 ping
```

**Problem: Redis authentication failures**

```
Error: NOAUTH Authentication required
```

**Cause:** Redis requires a password but the `cacheUrl` does not include one.

**Solution:**

```typescript
{
  cacheUrl: 'redis://:your-password@localhost:6379'
}
```

**Problem: Pub/sub messages not being received by other agents**

**Cause:** Agents may be connected to different Redis instances, or `enableBroadcast` is set to `false`.

**Solution:**

1. Verify all agents point to the same Redis URL.
2. Verify `enableBroadcast: true` in every agent's config.
3. Check Redis pub/sub channels: `redis-cli pubsub channels "mnemosyne:*"` -- should show active channels.
4. Check subscriber count: `redis-cli pubsub numsub mnemosyne:broadcast` -- should match the number of active agents.

---

### FalkorDB Issues

**Problem: "Connection refused" to FalkorDB**

```bash
docker ps | grep falkordb
docker start mnemosyne-falkordb
redis-cli -h localhost -p 6380 ping
```

**Problem: Port conflict between Redis and FalkorDB**

FalkorDB uses the Redis wire protocol internally on port 6379. If both Redis and FalkorDB are on the same host, map FalkorDB to a different host port:

```bash
# FalkorDB on host port 6380, internal port 6379
docker run -d -p 6380:6379 falkordb/falkordb
```

```typescript
{
  cacheUrl: 'redis://localhost:6379',    // Redis
  graphDbUrl: 'redis://localhost:6380',  // FalkorDB (different port)
}
```

**Problem: Graph queries timing out**

**Cause:** Very deep traversals on a large graph.

**Solution:** Mnemosyne limits graph traversal depth to 3 hops by default. If you are running custom graph queries, add explicit depth limits. If the graph has grown very large (>10M nodes), consider increasing FalkorDB's memory allocation.

---

### Embedding Service Issues

**Problem: "Model not found" from Ollama**

```bash
# Pull the model
docker exec mnemosyne-ollama ollama pull nomic-embed-text

# Verify it is available
curl http://localhost:11434/api/tags
```

**Problem: Wrong embedding dimensions**

If you are using a model that produces vectors with a different dimension than 768, Mnemosyne's default thresholds may produce poor results.

**Solution:** Either use a 768-dim model (nomic-embed-text) or adjust the auto-link and dedup thresholds:

```typescript
{
  autoLinkThreshold: 0.65,  // Lower threshold for higher-dim embeddings
}
```

**Problem: High embedding latency from cloud APIs**

Cloud embedding APIs (OpenAI, Cohere) add 50-200ms per call. This is expected.

**Mitigations built into Mnemosyne:**

- LRU embedding cache (512 entries, 5-min TTL) eliminates redundant calls
- L1 in-memory cache (50 entries, 5-min TTL) caches full recall results
- L2 Redis cache (1-hour TTL) caches recall results across process restarts

If you are still seeing latency issues, check your rate limits with the cloud provider.

---

### General Issues

**Problem: Memories are not being auto-linked**

**Cause:** Auto-link threshold is too high, or there are no semantically similar memories in the store.

**Solution:**

```typescript
{
  enableAutoLink: true,
  autoLinkThreshold: 0.65,  // Lower from default 0.70 to link more aggressively
}
```

**Problem: Too many duplicate detections (false positives)**

**Cause:** Dedup threshold (0.92 cosine similarity) is too aggressive for your embedding model.

**Solution:** This threshold is tuned for 768-dim nomic-embed-text. If you are using a different model, the similarity distribution may differ. Store a few test memories and inspect the cosine similarities to calibrate.

**Problem: Mnemosyne starts but features are silently disabled**

**Cause:** Optional services (Redis, FalkorDB) are configured but unreachable at startup. Mnemosyne logs a warning and degrades gracefully.

**Solution:** Check the startup logs for warnings like "Redis connection failed, disabling broadcast" or "FalkorDB unreachable, disabling graph." Fix the service connectivity and restart.

---

## Scaling Guide

### When and How to Scale Each Component

#### Qdrant

**When to scale:**

- RAM usage consistently above 80% of allocated memory
- Search latency exceeding 200ms at the 95th percentile
- Memory count approaching millions

**How to scale:**

1. **Vertical (easiest):** Increase RAM allocation. Budget ~1 GB per 100K memories at 768-dim.
2. **Disk-backed mode:** Move the index partially to disk. Reduces RAM requirements at the cost of latency (2-5x slower).
3. **Sharding:** Qdrant supports collection sharding across multiple nodes. Split large collections for parallel search.
4. **Replication:** Add read replicas for high-throughput recall workloads.
5. **Qdrant Cloud:** Managed scaling handles all of the above automatically.

```bash
# Check current collection size and memory usage
curl -s http://localhost:6333/collections/shared_memories | \
  python3 -c "import sys,json; d=json.load(sys.stdin)['result']; print(f'Vectors: {d[\"vectors_count\"]}, Indexed: {d[\"indexed_vectors_count\"]}')"
```

#### Redis

**When to scale:**

- Memory usage approaching `maxmemory` limit
- Pub/sub subscriber count exceeding 50 per channel
- Key eviction rate increasing (cache is too small)

**How to scale:**

1. **Vertical:** Increase `maxmemory` in Redis configuration.
2. **Redis Cluster:** For horizontal scaling across multiple nodes. Handles sharding automatically.
3. **Separate concerns:** Run two Redis instances -- one for cache, one for pub/sub -- if your cache working set is very large.

```bash
# Check memory and eviction stats
redis-cli info memory | grep -E "used_memory_human|maxmemory_human"
redis-cli info stats | grep evicted_keys
```

#### FalkorDB

**When to scale:**

- Graph query latency exceeding 100ms
- Entity count exceeding 10 million
- RAM usage consistently above 80%

**How to scale:**

1. **Vertical:** Increase RAM allocation. Budget ~500 MB per million nodes.
2. **Query optimization:** Reduce max traversal depth. Default is 3 hops; reducing to 2 cuts query time significantly on dense graphs.
3. **Graph pruning:** Run consolidation to merge duplicate entities and prune stale relationships.

```bash
# Count nodes and edges
redis-cli -h localhost -p 6380 GRAPH.QUERY mnemosyne_knowledge "MATCH (n) RETURN count(n)"
redis-cli -h localhost -p 6380 GRAPH.QUERY mnemosyne_knowledge "MATCH ()-[r]->() RETURN count(r)"
```

#### Embedding Service

**When to scale:**

- Embedding latency exceeding 50ms (local) or rate limits being hit (cloud)
- Multiple agents doing heavy simultaneous store operations

**How to scale:**

1. **Local -- horizontal:** Run multiple Ollama/MLX instances behind a load balancer.
2. **Cloud -- rate limits:** Upgrade your API plan. OpenAI's `text-embedding-3-small` has generous rate limits on paid tiers.
3. **Caching:** Mnemosyne's built-in LRU embedding cache (512 entries) handles the most common case. For workloads with very diverse text, increase the cache size in a custom embedding wrapper.
4. **Batch processing:** When doing bulk imports, batch store operations to amortize embedding overhead.

---

## Graceful Degradation

Mnemosyne is designed to work with as few as two services (Qdrant + embedding) and gracefully degrade when optional services are unavailable. This table describes exactly what happens when each optional service goes down.

### Redis Down

| Feature | Behavior When Redis is Down |
|---------|---------------------------|
| **L2 cache** | Disabled. L1 in-memory cache (50 entries, 5-min TTL) still works. Recall latency increases for cache misses but retrieval is fully functional. |
| **Pub/Sub broadcast** | Disabled. Agents stop receiving real-time events from other agents. Memories are still stored and searchable -- agents just do not get instant notifications. |
| **Shared blocks** | Fall back to direct Qdrant storage. Blocks are stored as core memories in Qdrant. Reads and writes still work, but latency is higher (vector search vs. key-value lookup). |
| **Cache invalidation** | Disabled. L1 cache entries expire naturally via TTL (5 minutes). Agents may serve slightly stale data for up to 5 minutes. |
| **Cross-agent corroboration** | Still works on next recall. Corroboration is detected during retrieval (via vector similarity), not via pub/sub. |

**Recovery:** When Redis comes back online, Mnemosyne reconnects automatically. No data is lost. The L1 cache warms up naturally. Pub/sub subscriptions are re-established.

### FalkorDB Down

| Feature | Behavior When FalkorDB is Down |
|---------|-------------------------------|
| **Graph ingestion** | Disabled. Entities extracted from memories are not written to the graph. |
| **Temporal queries** | Unavailable. Queries like "What was X connected to as of date Y?" will not return graph-based results. |
| **Path finding** | Unavailable. Shortest-path queries between entities will not work. |
| **Flash Reasoning** | Disabled. Chain-of-thought traversal through linked memory graphs is not available. |
| **Entity extraction** | Still runs (it is algorithmic, not graph-dependent). Extracted entities are stored in memory metadata but not in the graph. |
| **Auto-linking** | Still works. Auto-linking uses cosine similarity in Qdrant, not the graph. |
| **Timeline reconstruction** | Partially degraded. Can still be done via filtered vector search (by entity name in metadata), but without graph-based ordering. |

**Recovery:** When FalkorDB comes back online, Mnemosyne reconnects. Previously missed graph ingestions are NOT retroactively written (memories stored while FalkorDB was down will have entities in metadata but not in the graph). Running consolidation after recovery can help rebuild graph connections.

### Embedding Service Down

| Feature | Behavior When Embedding Service is Down |
|---------|---------------------------------------|
| **Store operations** | **Fail.** Embedding generation is required for vector storage. Stores will return an error. |
| **Recall operations** | **Fail for uncached queries.** Queries that hit the L1 or L2 cache will still return results. New queries that require embedding generation will fail. |
| **All other features** | Degraded. Most features depend on either store or recall. |

**Impact:** The embedding service is effectively required. If it goes down, the system is severely degraded.

**Mitigation:**

- For local embedding (Ollama), configure Docker restart policies (`restart: unless-stopped`)
- For cloud APIs, implement retry logic in your application layer
- Mnemosyne's LRU embedding cache (512 entries) provides a small buffer for recently-seen text

### Qdrant Down

| Feature | Behavior When Qdrant is Down |
|---------|------------------------------|
| **Everything** | **Fails.** Qdrant is the primary storage layer. Without it, no memories can be stored or recalled. |

**Impact:** Qdrant is the single required infrastructure component. Treat it as critical.

**Mitigation:**

- Use persistent volumes (always)
- Enable Qdrant replication for high availability
- Use Qdrant Cloud for managed uptime guarantees
- Schedule regular collection snapshots for disaster recovery

### Degradation Summary

```
Full Stack (all services healthy):
  Qdrant + Redis + FalkorDB + Embedding = All features operational

Partial Stack (Redis down):
  Qdrant + FalkorDB + Embedding = Core memory + graph, no real-time sync

Partial Stack (FalkorDB down):
  Qdrant + Redis + Embedding = Core memory + sync, no graph/reasoning

Minimal Stack (Redis + FalkorDB down):
  Qdrant + Embedding = Vector search + L1 cache only

Critical Failure:
  Qdrant down OR Embedding down = System non-functional
```

---

## Backup and Recovery

### Qdrant Snapshots

Qdrant supports point-in-time snapshots for backup:

```bash
# Create a snapshot of a collection
curl -X POST http://localhost:6333/collections/shared_memories/snapshots

# List snapshots
curl http://localhost:6333/collections/shared_memories/snapshots

# Download a snapshot
curl -o backup.snapshot \
  http://localhost:6333/collections/shared_memories/snapshots/{snapshot_name}

# Restore from snapshot
curl -X PUT http://localhost:6333/collections/shared_memories/snapshots/recover \
  -H "Content-Type: application/json" \
  -d '{"location": "file:///path/to/backup.snapshot"}'
```

Schedule daily snapshots for production deployments. Qdrant Cloud handles this automatically.

### Redis Persistence

Redis supports two persistence mechanisms:

- **RDB snapshots:** Point-in-time snapshots at configurable intervals. Low overhead.
- **AOF (Append Only File):** Logs every write operation. Higher durability, slightly more overhead.

The Docker Compose examples above enable AOF by default (`--appendonly yes`).

```bash
# Manual RDB snapshot
redis-cli -h localhost -p 6379 BGSAVE

# Check last save time
redis-cli -h localhost -p 6379 LASTSAVE
```

### FalkorDB Persistence

FalkorDB uses the same persistence mechanisms as Redis (RDB and AOF):

```bash
# Manual snapshot
redis-cli -h localhost -p 6380 BGSAVE
```

### Soft-Delete Architecture

Mnemosyne uses soft-delete for all memory operations. When you call `memory_forget`, the memory's `deleted` flag is set to `true`, but the memory cell remains in Qdrant. This means:

- **Nothing is truly lost.** Accidental deletions can be recovered by un-setting the `deleted` flag.
- **Full audit trail.** Every memory that ever existed can be traced.
- **Recovery is straightforward.** No need to restore from backup for individual memory recovery.

### Recommended Backup Strategy

| Service | Backup Method | Frequency | Retention |
|---------|--------------|-----------|-----------|
| Qdrant | Collection snapshots | Daily | 7 days minimum |
| Redis | RDB snapshots + AOF | RDB: hourly, AOF: continuous | 7 days minimum |
| FalkorDB | RDB snapshots | Daily | 7 days minimum |

---

## Environment Variables Reference

For convenience, Mnemosyne configuration can be driven by environment variables. This is especially useful in containerized and serverless deployments.

```bash
# Required
export MNEMOSYNE_VECTOR_DB=http://localhost:6333
export MNEMOSYNE_EMBED_URL=http://localhost:11434/v1/embeddings
export MNEMOSYNE_AGENT_ID=my-agent

# Optional services
export MNEMOSYNE_REDIS_URL=redis://localhost:6379
export MNEMOSYNE_GRAPH_URL=redis://localhost:6380

# Feature toggles (all default to true when corresponding service is available)
export MNEMOSYNE_AUTO_CAPTURE=true
export MNEMOSYNE_AUTO_RECALL=true
export MNEMOSYNE_ENABLE_GRAPH=true
export MNEMOSYNE_ENABLE_BROADCAST=true
export MNEMOSYNE_ENABLE_DECAY=true

# Cloud API keys (when using cloud embedding providers)
export OPENAI_API_KEY=sk-...
export COHERE_API_KEY=...
```

These map directly to the `MnemosyneConfig` fields and can be used instead of (or alongside) programmatic configuration.
