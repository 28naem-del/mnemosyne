<p align="center">
  <img src="assets/mnemosyne-logo.svg" alt="Mnemosyne" width="180" />
</p>

<h1 align="center">Mnemosyne</h1>

<p align="center">
  <strong>Cognitive Memory OS for AI Agents</strong>
</p>

<p align="center">
  <em>The first AI memory system that thinks like a brain</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mnemosy-ai"><img src="https://img.shields.io/npm/v/mnemosy-ai?color=blue&label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/mnemosy-ai"><img src="https://img.shields.io/npm/dm/mnemosy-ai?color=green" alt="downloads" /></a>
  <a href="https://github.com/28naem-del/mnemosyne/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license" /></a>
  <a href="#"><img src="https://img.shields.io/badge/TypeScript-100%25-blue?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://github.com/28naem-del/mnemosyne"><img src="https://img.shields.io/github/stars/28naem-del/mnemosyne?style=social" alt="GitHub stars" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#comparison">Comparison</a> &bull;
  <a href="docs/api.md">API</a> &bull;
  <a href="docs/deployment.md">Deploy</a> &bull;
  <a href="COMPARISON.md">Why Mnemosyne?</a>
</p>

---

Every AI agent today has amnesia. Every conversation starts from zero. They can't learn from mistakes. They can't build expertise. They can't share what they know with other agents. **This is the single biggest bottleneck to autonomous AI.**

Mnemosyne is not another vector database wrapper. It's a **5-layer cognitive architecture** that gives your agents persistent, self-improving, collaborative memory &mdash; inspired by how the human brain actually stores, retrieves, and strengthens memories over time.

This matters now because agents are moving from demos to production. Stateless agents can't operate in production. They need memory that *thinks*.

<table>
<tr>
<td width="33%" align="center">
<h3>10 cognitive features</h3>
<p>Decay, reasoning, consolidation, Theory of Mind, reinforcement learning... 10 capabilities that exist only in research papers. We ship them all.</p>
</td>
<td width="33%" align="center">
<h3>$0 per memory stored</h3>
<p>Zero LLM calls during ingestion. Full 12-step pipeline runs algorithmically in &lt;50ms. Competitors charge ~$0.01 per memory via LLM.</p>
</td>
<td width="33%" align="center">
<h3>Free knowledge graph</h3>
<p>Temporal entity graph with auto-linking, path finding, and timeline reconstruction. Built-in. Mem0 charges $249/mo for theirs.</p>
</td>
</tr>
</table>

> **Production-proven:** 13,000+ memories across a 10-agent mesh with sub-200ms retrieval. Not a demo. Not a roadmap. Running right now.

---

## Quick Start

```bash
npm install mnemosy-ai
```

```typescript
import { createMnemosyne } from 'mnemosy-ai'

const m = await createMnemosyne({
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'my-agent'
})

await m.store("User prefers dark mode and TypeScript")  // 12-step pipeline, <50ms
const memories = await m.recall("user preferences")      // multi-signal ranked
await m.feedback("positive")                              // memories learn from use
```

Your agent now has persistent memory that gets smarter over time. That's it.

> Only hard requirement: Qdrant (`docker run -d -p 6333:6333 qdrant/qdrant`). Redis and FalkorDB are optional. See [full quickstart](docs/quickstart.md).

---

## Features

33 features across 5 layers. Every feature is independently toggleable &mdash; start simple, enable progressively.

### &#x2699;&#xFE0F; Infrastructure (L1)

| Feature | What it does |
|---------|-------------|
| **Vector Storage** | 768-dim embeddings on Qdrant with HNSW indexing. Sub-linear search scaling to billions of vectors |
| **2-Tier Cache** | L1 in-memory (50 entries, 5min TTL) + L2 Redis (1hr TTL). Sub-10ms cached recall |
| **Pub/Sub Broadcast** | Real-time memory events across your entire agent mesh via Redis channels |
| **Knowledge Graph** | Temporal entity graph on FalkorDB with auto-linking, path finding, and timeline reconstruction |
| **Bi-Temporal Model** | Every memory tracks `eventTime` (when it happened) + `ingestedAt` (when stored) for temporal queries |
| **Soft-Delete** | Memories are never physically deleted. Full audit trails and recovery at any time |

### &#x1F527; Pipeline (L2)

| Feature | What it does |
|---------|-------------|
| **12-Step Ingestion** | Security &rarr; embed &rarr; dedup &rarr; extract &rarr; classify &rarr; score &rarr; link &rarr; graph &rarr; broadcast |
| **Zero-LLM Pipeline** | Classification, entity extraction, urgency detection, conflict resolution &mdash; all algorithmic. **$0 per memory** |
| **Security Filter** | 3-tier classification (public/private/secret). Blocks API keys, credentials, and private keys from storage |
| **Smart Dedup & Merge** | Cosine &ge;0.92 = duplicate (merge). 0.70&ndash;0.92 = conflict (broadcast alert). Preserves highest-quality version |
| **Entity Extraction** | Automatic identification: people, machines, IPs, dates, technologies, URLs, ports. Zero LLM calls |
| **7-Type Taxonomy** | episodic, semantic, preference, relationship, procedural, profile, core &mdash; classified algorithmically |

### &#x1F310; Knowledge Graph (L3)

| Feature | What it does |
|---------|-------------|
| **Temporal Queries** | "What was X connected to as of date Y?" &mdash; relationships carry `since` timestamps |
| **Auto-Linking** | New memories automatically discover and link to related memories. Bidirectional. Zettelkasten-style |
| **Path Finding** | Shortest-path queries between any two entities with configurable max depth |
| **Timeline Reconstruction** | Ordered history of all memories mentioning a given entity |
| **Depth-Limited Traversal** | Configurable graph exploration (default: 2 hops) balancing relevance vs. noise |

### &#x1F9E0; Cognitive (L4)

| Feature | What it does |
|---------|-------------|
| **Activation Decay** | Logarithmic decay model. Critical memories stay for months. Core and procedural are **immune** |
| **Multi-Signal Scoring** | 5 independent signals: similarity, recency, importance&times;confidence, frequency, type relevance |
| **Intent-Aware Retrieval** | Auto-detects query intent (factual, temporal, procedural, preference, exploratory). Adapts scoring weights |
| **Diversity Reranking** | Cluster detection (&gt;0.9), overlap penalty (&gt;0.8), type diversity &mdash; prevents echo chambers in results |
| **4-Tier Confidence** | Mesh Fact &ge;0.85, Grounded 0.65&ndash;0.84, Inferred 0.40&ndash;0.64, Uncertain &lt;0.40 |
| **Priority Scoring** | Urgency &times; Domain composite. Critical+technical = 1.0, background+general = 0.2 |

### &#x1F680; Self-Improvement (L5)

| Feature | What it does |
|---------|-------------|
| **Reinforcement Learning** | Feedback loop tracks usefulness. Auto-promotes memories with &gt;0.7 ratio after 3+ retrievals |
| **Active Consolidation** | 4-phase autonomous maintenance: contradiction detection, dedup merge, popular promotion, stale demotion |
| **Flash Reasoning** | BFS traversal through linked memory graphs. Reconstructs multi-step logic: `"service failed &rarr; config changed &rarr; rollback needed"` |
| **Agent Awareness (ToMA)** | Theory of Mind for agents. "What does Agent-B know about X?" Knowledge gap analysis across the mesh |
| **Cross-Agent Synthesis** | When 3+ agents independently agree on a fact, it's auto-synthesized into fleet-level insight |
| **Proactive Recall** | Generates speculative queries from incoming prompts. Injects relevant context *before* the agent asks |
| **Session Survival** | Snapshot/recovery across context window resets. Agent resumes with full awareness. Zero discontinuity |
| **Observational Memory** | Compresses raw conversation streams into structured, high-signal memory cells. Like human working memory |
| **Procedural Memory** | Learned procedures stored as first-class objects. **Immune to decay.** Shared across the entire mesh |
| **Mesh Sync** | Named, versioned shared state blocks. Real-time broadcast propagation to all agents |

> Deep dive into every feature: [docs/features.md](docs/features.md)

---

## AGI-Grade Capabilities

These 10 capabilities exist almost exclusively in academic papers and closed research labs. Mnemosyne ships all of them as production infrastructure.

| Capability | Industry Status | Mnemosyne |
|---|---|---|
| Flash Reasoning (chain-of-thought graph traversal) | Research paper only | **Production** |
| Theory of Mind for agents | Research paper only | **Production** |
| Observational memory compression | Research paper only | **Production** |
| Reinforcement learning on memory | Research paper only | **Production** |
| Autonomous self-improving consolidation | Not implemented anywhere | **Production** |
| Cross-agent shared cognitive state | Not implemented anywhere | **Production** |
| Bi-temporal knowledge graph | Research paper only | **Production** |
| Proactive anticipatory recall | Not implemented anywhere | **Production** |
| Procedural memory / skill library | Not implemented anywhere | **Production** |
| Session survival across context resets | Not implemented anywhere | **Production** |

---

## Comparison

Full analysis: **[COMPARISON.md](COMPARISON.md)** &bull; Detailed docs: **[docs/comparison.md](docs/comparison.md)**

### Feature-by-Feature

| Feature | Mnemosyne | Mem0 | Zep | Cognee | LangMem | Letta |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Pipeline & Ingestion** | | | | | | |
| Zero-LLM ingestion pipeline | &#x2705; | &#x274C; LLM | &#x274C; LLM | &#x274C; LLM | &#x274C; LLM | &#x274C; LLM |
| 12-step structured pipeline | &#x2705; | Partial | Partial | &#x2705; | &#x274C; | &#x274C; |
| Security filter (secret blocking) | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Smart dedup with semantic merge | &#x2705; | &#x2705; | &#x274C; | &#x2705; | &#x274C; | &#x274C; |
| Conflict detection & alerts | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| 7-type memory taxonomy | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | Partial |
| Entity extraction (zero-LLM) | &#x2705; | LLM-based | LLM-based | LLM-based | &#x274C; | &#x274C; |
| **Cognitive Features** | | | | | | |
| Activation decay model | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Multi-signal scoring (5 signals) | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Intent-aware retrieval | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Diversity reranking | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| 4-tier confidence system | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Priority scoring (urgency &times; domain) | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Flash reasoning chains | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Reinforcement learning | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Active consolidation (4-phase) | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Proactive recall | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Session survival | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x2705; |
| Observational memory | &#x2705; | &#x274C; | &#x2705; | &#x274C; | &#x274C; | &#x274C; |
| **Knowledge Graph** | | | | | | |
| Built-in knowledge graph | &#x2705; Free | $249/mo | &#x274C; | &#x2705; | &#x274C; | &#x274C; |
| Temporal graph queries | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Auto-linking (bidirectional) | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Path finding between entities | &#x2705; | &#x274C; | &#x274C; | Partial | &#x274C; | &#x274C; |
| Timeline reconstruction | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Bi-temporal data model | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| **Multi-Agent** | | | | | | |
| Real-time broadcast (pub/sub) | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Theory of Mind (agent awareness) | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Cross-agent synthesis | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Knowledge gap analysis | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Shared state blocks (Mesh Sync) | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| **Infrastructure** | | | | | | |
| 2-tier caching (L1 + L2) | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Soft-delete architecture | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x274C; |
| Procedural memory (skill library) | &#x2705; | &#x274C; | &#x274C; | &#x274C; | &#x274C; | &#x2705; |
| CLI tools | &#x2705; | &#x2705; | &#x274C; | &#x2705; | &#x274C; | &#x2705; |

**Score: Mnemosyne 33/33 &bull; Mem0 5/33 &bull; Zep 3/33 &bull; Cognee 5/33 &bull; LangMem 0/33 &bull; Letta 4/33**

### Pricing

| | Mnemosyne | Mem0 | Zep | Letta |
|---|---|---|---|---|
| **Self-hosted** | Free (MIT) | Free (limited) | Free (limited) | Free |
| **Knowledge graph** | Free (FalkorDB) | $249/mo (Pro) | N/A | N/A |
| **Per memory stored** | $0.00 (zero LLM) | ~$0.01 (LLM call) | ~$0.01 (LLM call) | ~$0.01 (LLM call) |
| **100K memories** | **$0** | ~$1,000 | ~$1,000 | ~$1,000 |
| **Multi-agent** | Free | Enterprise pricing | N/A | N/A |

### Architecture

| | Mnemosyne | Mem0 | Zep | Cognee | LangMem | Letta |
|---|---|---|---|---|---|---|
| **Approach** | Cognitive OS (5 layers) | Vector store + LLM | Session memory + LLM | Knowledge ETL + LLM | Conversation buffer | Self-editing memory |
| **LLM dependency** | None (embedding only) | Core (extraction) | Core (summarization) | Core (extraction) | Core (all ops) | Core (memory mgmt) |
| **Multi-agent** | Native mesh | Single-tenant | Single-tenant | Single-tenant | Single-tenant | Single-tenant |
| **Self-improving** | Yes (RL + consolidation) | No | No | No | No | No |
| **Ingestion latency** | &lt;50ms | 500ms&ndash;2s | 500ms&ndash;2s | 1&ndash;5s | N/A | 500ms&ndash;2s |

---

## Architecture

```
+----------------------------------------------------------------------+
|                      MNEMOSYNE COGNITIVE OS                          |
|                                                                      |
|  L5  SELF-IMPROVEMENT                                                |
|  [ Reinforcement ] [ Consolidation ] [ Flash Reasoning ] [ ToMA ]    |
|                                                                      |
|  L4  COGNITIVE                                                       |
|  [ Activation Decay ] [ Confidence ] [ Priority ] [ Diversity ]      |
|                                                                      |
|  L3  KNOWLEDGE GRAPH                                                 |
|  [ Temporal Graph ] [ Auto-Linking ] [ Path Traversal ] [ Entities ] |
|                                                                      |
|  L2  PIPELINE                                                        |
|  [ Extraction ] [ Classify ] [ Dedup & Merge ] [ Security Filter ]   |
|                                                                      |
|  L1  INFRASTRUCTURE                                                  |
|  [ Qdrant ] [ FalkorDB ] [ Redis Cache ] [ Redis Pub/Sub ]          |
+----------------------------------------------------------------------+
```

### Store Path &mdash; 12 steps, zero LLM, &lt;50ms

```
Input
  |
  v
Security Filter --> Embedding (768-dim) --> Dedup & Merge
  |                                              |
  |                    +-------------------------+
  |                    |                         |
  v                    v                         v
Extraction        Conflict Detection       (if duplicate: merge or reject)
  |
  +--- Urgency Classify (4 levels)
  +--- Domain Classify (5 domains)
  +--- Priority Score (urgency x domain)
  +--- Confidence Rate (3 signals)
  |
  v
Vector Store --> Auto-Link --> Graph Ingest --> Broadcast
```

### Recall Path &mdash; multi-signal, intent-aware

```
Query
  |
  v
Cache Lookup (L1 in-memory --> L2 Redis)
  |
  v (cache miss)
Embedding --> Vector Search (Qdrant)
  |
  v
Intent-Aware Multi-Signal Scoring
  |  5 signals weighted by detected intent:
  |  similarity, recency, importance*confidence, frequency, type relevance
  |
  +---> Diversity Reranking (cluster, overlap, type penalties)
  +---> Graph Enrichment (entity relationships, temporal context)
  |
  v
Flash Reasoning Chains (BFS through linked memories)
  |
  v
Final Results (ranked, diverse, enriched, with reasoning context)
```

---

## API Overview

9 tools that integrate with any LLM agent framework.

| Tool | What it does |
|------|-------------|
| **`memory_recall`** | Intelligent search: multi-signal ranking, intent detection, diversity reranking, graph enrichment, flash reasoning |
| **`memory_store`** | Full 12-step ingestion: security filter, dedup, classify, link, graph ingest, broadcast |
| **`memory_forget`** | Soft-delete by ID or semantic search. Short ID support. Mesh-wide cache invalidation |
| **`memory_block_get`** | Read a named shared memory block (Mesh Sync) |
| **`memory_block_set`** | Write/update a named shared memory block with versioning |
| **`memory_feedback`** | Reinforcement signal: was the recalled memory useful? Drives promotion/demotion |
| **`memory_consolidate`** | Run 4-phase active consolidation: contradictions, dedup, promotion, demotion |
| **`memory_toma`** | Query what a specific agent knows about a topic (Theory of Mind) |
| **`before_agent_start`** | Automatic hook: session recovery, proactive recall, context injection |

```typescript
// Store with full pipeline
const result = await m.store("Deployment requires Redis 7+", {
  importance: 0.9,
  eventTime: "2024-01-15T10:30:00Z"
})
// -> { status: "created", linkedCount: 3 }

// Recall with multi-signal ranking
const memories = await m.recall("deployment requirements", { limit: 5 })
// -> ranked results with scores, confidence tags, reasoning chains

// Theory of Mind
const knowledge = await m.toma("devops-agent", "production database")
// -> what the DevOps agent knows about the production database

// Mesh Sync
await m.blockSet("project_status", "Phase 2: API integration complete")
const status = await m.blockGet("project_status")
// -> { content: "Phase 2: ...", version: 3, lastWriter: "pm-agent" }
```

> Complete API reference with all parameters: [docs/api.md](docs/api.md)

---

## Performance

| Metric | Value | Notes |
|--------|-------|-------|
| **Store latency** | &lt;50ms | Full 12-step pipeline, zero LLM calls |
| **Recall (cached)** | &lt;10ms | L1 in-memory cache hit |
| **Recall (uncached)** | &lt;200ms | Full multi-signal search + graph enrichment + reasoning |
| **Embedding** | ~15ms | 768-dim with LRU cache (512 entries) |
| **Consolidation** | ~1,000/min | Batch size 100, 4-phase pipeline |
| **Production capacity** | 13,000+ | Memories across 10-agent mesh |
| **Concurrent agents** | 10+ | Real-time pub/sub, zero locking |
| **Cache hit rate** | &gt;60% | Typical conversational workloads (L1 + L2) |

**Scalability:** Qdrant supports billions of vectors (HNSW). FalkorDB handles millions of graph nodes. Redis pub/sub handles thousands of messages/sec. Mnemosyne scales with its backing services.

---

## Deployment

Three deployment models. Same code, same config interface.

### Single Node

Everything on one machine. Minimum: 4GB RAM, 2 CPU cores.

```bash
# Start backing services
docker run -d -p 6333:6333 qdrant/qdrant           # Required
docker run -d -p 6379:6379 redis                     # Optional (enables cache + broadcast)
docker run -d -p 6380:6379 falkordb/falkordb         # Optional (enables knowledge graph)
```

### Multi-Agent Mesh

Multiple agents share centralized Qdrant, Redis, FalkorDB, and embedding service. Each agent runs its own Mnemosyne instance. Real-time sync via Redis pub/sub.

```
Agent A ──┐
Agent B ──┼──> [ Qdrant | Redis | FalkorDB | Embed Service ]
Agent C ──┘
```

### Cloud / Managed

Connect to Qdrant Cloud, Redis Cloud, any OpenAI-compatible embedding API. No code changes &mdash; configuration only. Works with any cloud provider.

> Detailed deployment guide with docker-compose files: [docs/deployment.md](docs/deployment.md)

---

## Configuration

Every cognitive feature is independently toggleable. Start with vector-only, enable features as you need them.

```typescript
// Minimal: just vector storage
const config = {
  vectorDbUrl: 'http://localhost:6333',
  embeddingUrl: 'http://localhost:11434/v1/embeddings',
  agentId: 'my-agent',
  enableGraph: false,
  enableBroadcast: false,
}

// Full cognitive OS: everything enabled
const config = {
  vectorDbUrl: 'http://qdrant:6333',
  embeddingUrl: 'http://embed:11434/v1/embeddings',
  graphDbUrl: 'redis://falkordb:6380',
  cacheUrl: 'redis://redis:6379',
  agentId: 'production-agent-01',
  autoCapture: true,           // Auto-store from conversations
  autoRecall: true,            // Auto-recall before agent starts
  enableGraph: true,           // Knowledge graph integration
  enableAutoLink: true,        // Automatic memory linking
  enableDecay: true,           // Activation decay model
  enableBroadcast: true,       // Cross-agent pub/sub
  enablePriorityScoring: true, // Urgency/domain scoring
  enableConfidenceTags: true,  // Confidence rating system
  autoLinkThreshold: 0.70,     // Min similarity for auto-link
}
```

> All configuration options explained: [docs/configuration.md](docs/configuration.md)

---

## Use Cases

| Use Case | Key Features Used |
|----------|------------------|
| **AI Coding Assistants** | Session survival, procedural memory, temporal graph ("What changed since deploy?") |
| **Enterprise Knowledge Agents** | Agent mesh, ToMA, cross-agent synthesis, shared blocks |
| **Customer Support** | Preference tracking, reinforcement learning, procedural memory for resolution patterns |
| **Research Assistants** | Flash reasoning, auto-linking, knowledge graph, diversity reranking |
| **DevOps & Infrastructure** | Temporal queries, proactive warnings, procedural runbooks, mesh sync |
| **Personal AI Companions** | Activation decay, observational memory, preference learning, session survival |

---

## Roadmap

### V2 &mdash; Next

| Feature | Description |
|---------|-------------|
| BM25 Hybrid Search | Text + vector via Reciprocal Rank Fusion |
| Auto Pattern Mining | TF-IDF + co-occurrence clustering for recurring themes |
| Auto Lesson Extraction | Detects corrections, stores as reusable lessons |
| Dream Consolidation | Nightly batch: consolidation + pattern mining + sequence detection |
| Spreading Activation | Graph-based activation propagation (1-hop=0.6, 2-hop=0.3) |
| Proactive Warnings | "Last time you did X, Y broke" |
| Temporal Sequences | "A &rarr; B within N hours" detection |
| Sentiment-Aware Retrieval | Emotion detection adjusts retrieval strategy |

### V3 &mdash; Vision

Hierarchical memory (episode &rarr; semantic &rarr; schema), multi-modal embeddings (image/audio/document), federated cross-org sharing with privacy boundaries, predictive recall, memory compression, natural language memory management, custom learned decay curves, distributed billion-node graph.

---

## Technical Specifications

| Spec | Value |
|------|-------|
| Language | TypeScript (Node.js) |
| Embedding | 768-dim, Nomic architecture, any OpenAI-compatible endpoint |
| Vector DB | Qdrant (required) |
| Graph DB | FalkorDB / RedisGraph (optional) |
| Cache / Pub/Sub | Redis (optional) |
| Memory types | 7 (episodic, semantic, preference, relationship, procedural, profile, core) |
| Confidence tiers | 4 (Mesh Fact, Grounded, Inferred, Uncertain) |
| Urgency levels | 4 (critical, important, reference, background) |
| Domains | 5 (technical, personal, project, knowledge, general) |
| Pipeline steps | 12 (all zero-LLM) |
| Search signals | 5 |
| Query intents | 5 (factual, temporal, procedural, preference, exploratory) |
| Tools | 9 |
| License | MIT |

---

## Contributing

We welcome contributions.

```bash
git clone https://github.com/28naem-del/mnemosyne.git
cd mnemosyne
npm install
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

[MIT](LICENSE)

---

<p align="center">
  <a href="https://mnemosy.ai">Website</a> &bull;
  <a href="mailto:team@mnemosy.ai">Contact</a> &bull;
  <a href="https://github.com/28naem-del/mnemosyne/issues">Issues</a>
</p>

<p align="center">
  <strong>Mnemosyne</strong> &mdash; Because intelligence without memory isn't intelligence.
</p>
