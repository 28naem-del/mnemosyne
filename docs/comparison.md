# Detailed Comparison: Mnemosyne vs Every Major AI Memory System

> An honest, technical comparison with real numbers. We acknowledge what competitors do well — and show where Mnemosyne operates in a category of its own.

---

## 1. Overview: The AI Memory Landscape

AI agents have a memory problem. Every conversation starts from zero. Every session is a blank slate. The industry has responded with a growing ecosystem of memory systems — but they are not all solving the same problem, and they are not all solving it at the same depth.

The AI memory landscape in 2026 breaks down into five categories:

| Category | Systems | Approach |
|---|---|---|
| **Vector Store + LLM Extraction** | Mem0 | Send text to an LLM, store extracted facts as vectors |
| **Conversation Memory** | Zep | Ingest chat messages, summarize with LLM, retrieve by session |
| **Knowledge ETL** | Cognee | Process documents through LLMs to build knowledge graphs |
| **Framework Memory Primitives** | LangMem / LangChain | Buffer, summary, and entity memory utilities tied to a framework |
| **LLM-Directed Memory** | Letta (MemGPT) | The LLM manages its own memory through tool calls |

Mnemosyne does not fit neatly into any of these categories. It is a **cognitive memory operating system** — a 5-layer architecture that combines vector storage, knowledge graphs, cognitive scoring, multi-agent mesh, and self-improvement into a single system. No LLM calls in the pipeline. No per-memory costs. No cloud lock-in.

Why does comparison matter? Because choosing the wrong memory system is expensive to reverse. Memory systems accumulate state. They become load-bearing infrastructure. Migrating 100,000 memories from one system to another is not a weekend project. The choice you make now determines your cost structure, retrieval quality, scalability ceiling, and multi-agent capabilities for the foreseeable future.

This document provides the data you need to make that choice correctly.

---

## 2. System Profiles

### Mnemosyne

**Category:** Cognitive Memory OS | **Language:** TypeScript | **License:** Open Source (MIT)

Mnemosyne is a 5-layer cognitive memory architecture that gives AI agents persistent, searchable, self-improving long-term memory. It processes memories through a deterministic 12-step pipeline with zero LLM calls, then layers cognitive intelligence on top: activation decay, multi-signal scoring, intent-aware retrieval, diversity reranking, flash reasoning, reinforcement learning, and active consolidation. It is the only system that natively supports multi-agent mesh with real-time pub/sub, Theory of Mind for agents, cross-agent knowledge gap analysis, and fleet-level insight synthesis. Currently running in production with 13,000+ memories across a 10-node agent mesh with sub-200ms retrieval latency.

**Key differentiators:** Zero-LLM pipeline, 5-layer architecture, 10 cognitive features, multi-agent mesh native, self-improving consolidation, $0.00 per-memory cost.

### Mem0

**Category:** Vector Store + LLM Extraction | **Language:** Python | **Stars:** 41K+ | **License:** Apache 2.0 (open core)

Mem0 is the most well-known AI memory system. It popularized the concept of persistent memory for AI agents and has built significant community adoption. When you store a memory, Mem0 sends your text to an LLM (GPT-4, Claude, etc.) to extract key facts, then stores the extracted facts as vectors. Retrieval is vector similarity search with optional graph lookups on the Pro plan ($249/month). Mem0 offers both a self-hosted open-source version and a managed cloud platform (Mem0 Cloud) with free and paid tiers.

**Strengths:** Largest community, managed cloud option, simple API, Python-native, strong integrations ecosystem.
**Limitations:** LLM required for every memory (non-deterministic, costly at scale), knowledge graph gated behind Pro plan, no cognitive features, limited multi-agent support.

### Zep

**Category:** Conversation Memory | **Language:** Python/Go | **License:** Open Source + Cloud

Zep is a purpose-built memory system for conversation-driven applications. It ingests chat messages, uses an LLM to generate session summaries and extract entities, and provides retrieval through semantic search with temporal filtering. Zep also offers a fact extraction feature that pulls structured facts from conversations. The system is designed specifically for chatbots and LLM-powered applications where conversation history is the primary memory substrate.

**Strengths:** Clean conversation memory model, managed cloud option, good session management, entity and fact extraction.
**Limitations:** Conversation-only scope, no knowledge graph, no multi-agent support, no cognitive features, LLM-dependent extraction.

### Cognee

**Category:** Knowledge ETL | **Language:** Python | **License:** Apache 2.0

Cognee is a knowledge-graph-centric system that focuses on building structured knowledge from unstructured data. It processes documents through LLMs to extract entities, relationships, and structured knowledge, then populates a graph database (Neo4j or others). The graph is the primary abstraction, and retrieval combines graph traversal with vector search. Cognee's strength is in deep, LLM-quality relationship extraction from documents — it finds implicit connections and nuanced relationships that rule-based extractors miss.

**Strengths:** Deep LLM-quality relationship extraction, graph-first architecture, document processing pipeline, flexible graph backends.
**Limitations:** LLM required for graph construction (costly at scale), no multi-agent support, no cognitive features, no self-improvement, early-stage maturity.

### LangMem / LangChain Memory

**Category:** Framework Memory Primitives | **Language:** Python | **License:** MIT

LangMem is the memory subsystem within the LangChain ecosystem. It provides basic memory abstractions: conversation buffer memory (raw message history), conversation summary memory (LLM-compressed summaries), entity memory (extracted entities), and vector store-backed memory (semantic search over past interactions). These are utilities — building blocks that integrate tightly with LangChain agents and chains. LangMem recently expanded with a dedicated `langmem` package offering managed long-term memory with background processing.

**Strengths:** Tight LangChain integration, simple API for basic use cases, part of a large ecosystem, variety of memory types.
**Limitations:** Framework lock-in (LangChain-coupled), no knowledge graph, no multi-agent support, no cognitive features, no self-improvement, LLM-dependent for summarization and extraction.

### Letta (formerly MemGPT)

**Category:** LLM-Directed Memory | **Language:** Python | **License:** Apache 2.0

Letta pioneered the concept of managing an LLM's context window as a memory hierarchy. It defines three tiers: core memory (always in context), recall memory (searchable conversation history), and archival memory (long-term vector store). The breakthrough idea is that the LLM itself manages memory through tool calls — the agent decides what to save, what to retrieve, what to archive, and what to forget. This creates a self-managing memory system where the LLM's judgment drives every memory operation. Letta also provides a full agent framework with persistent stateful agents, tool execution, and a server-based architecture.

**Strengths:** Innovative LLM-directed memory management, context window optimization, persistent stateful agents, full agent framework, growing community.
**Limitations:** Non-deterministic memory management (LLM judgment varies), LLM cost for every memory operation, no knowledge graph, limited multi-agent support, no cognitive features beyond context management.

---

## 3. Detailed Feature Comparison

Legend: **Y** = fully implemented and available | **P** = partial implementation | **$** = requires paid tier | **-** = not available

### Pipeline Features

| # | Feature | Mnemosyne | Mem0 | Zep | Cognee | LangMem | Letta |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| 1 | Zero-LLM ingestion pipeline | **Y** | - | - | - | - | - |
| 2 | Deterministic classification (same input = same output) | **Y** | - | - | - | - | - |
| 3 | Security filter (blocks secrets/credentials) | **Y** | - | - | - | - | - |
| 4 | Smart deduplication with semantic merge | **Y** | **Y** | - | **Y** | - | - |
| 5 | Conflict/contradiction detection | **Y** | - | - | - | - | - |
| 6 | 7-type memory taxonomy | **Y** | - | - | - | - | P (3 types) |
| 7 | Automatic classification (type + urgency + domain) | **Y** | P | P | P | - | - |
| 8 | Priority scoring (urgency x domain composite) | **Y** | - | - | - | - | - |
| 9 | 4-tier confidence system | **Y** | - | - | - | - | - |
| 10 | Bi-temporal data model (event time + ingestion time) | **Y** | - | - | - | - | - |
| 11 | Soft-delete architecture (audit trail) | **Y** | - | - | - | - | - |
| 12 | 23-field memory cell schema | **Y** | - | - | - | - | - |

### Cognitive Features

| # | Feature | Mnemosyne | Mem0 | Zep | Cognee | LangMem | Letta |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| 13 | Activation decay (time-based relevance) | **Y** | - | - | - | - | - |
| 14 | Multi-signal scoring (5 independent signals) | **Y** | - | - | - | - | - |
| 15 | Intent-aware retrieval (5 query intents) | **Y** | - | - | - | - | - |
| 16 | Diversity reranking (cluster + overlap + type penalty) | **Y** | - | - | - | - | - |
| 17 | Flash reasoning (chain-of-thought graph traversal) | **Y** | - | - | - | - | - |
| 18 | Proactive recall (anticipatory context injection) | **Y** | - | - | - | - | - |
| 19 | Session survival (context reset continuity) | **Y** | - | - | - | - | **Y** |
| 20 | Observational memory (conversation compression) | **Y** | - | - | - | - | - |
| 21 | Procedural memory / skill library (decay-immune) | **Y** | - | - | - | - | **Y** |

### Knowledge Graph Features

| # | Feature | Mnemosyne | Mem0 | Zep | Cognee | LangMem | Letta |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| 22 | Built-in knowledge graph | **Y** (free) | **$** ($249/mo) | - | **Y** | - | - |
| 23 | Temporal graph queries ("X as of date Y") | **Y** | - | - | P | - | - |
| 24 | Auto-linking (bidirectional, threshold-based) | **Y** | - | - | - | - | - |
| 25 | Path finding / multi-hop traversal | **Y** | P | - | **Y** | - | - |
| 26 | Timeline reconstruction per entity | **Y** | - | - | - | - | - |
| 27 | Entity extraction | **Y** (zero-LLM) | **Y** (LLM) | **Y** (LLM) | **Y** (LLM) | - | - |
| 28 | Graph enrichment on retrieval | **Y** | P | - | **Y** | - | - |

### Multi-Agent Features

| # | Feature | Mnemosyne | Mem0 | Zep | Cognee | LangMem | Letta |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| 29 | Agent mesh (real-time pub/sub broadcast) | **Y** | - | - | - | - | - |
| 30 | Theory of Mind (query other agents' knowledge) | **Y** | - | - | - | - | - |
| 31 | Cross-agent synthesis (fleet-level insights) | **Y** | - | - | - | - | - |
| 32 | Knowledge gap analysis (compare agent knowledge) | **Y** | - | - | - | - | - |
| 33 | Shared state blocks (Mesh Sync, versioned) | **Y** | - | - | - | - | - |
| 34 | Per-agent private memory collections | **Y** | **Y** | **Y** | - | - | **Y** |
| 35 | Configurable trust hierarchies | **Y** | - | - | - | - | - |
| 36 | Cross-agent corroboration (3+ agents = Mesh Fact) | **Y** | - | - | - | - | - |

### Self-Improvement Features

| # | Feature | Mnemosyne | Mem0 | Zep | Cognee | LangMem | Letta |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| 37 | Reinforcement learning (feedback loop) | **Y** | - | - | - | - | - |
| 38 | Active consolidation: contradiction detection | **Y** | - | - | - | - | - |
| 39 | Active consolidation: near-duplicate merge | **Y** | **Y** | - | **Y** | - | - |
| 40 | Active consolidation: popular promotion | **Y** | - | - | - | - | - |
| 41 | Active consolidation: stale demotion | **Y** | - | - | - | - | - |
| 42 | Autonomous memory maintenance (no human required) | **Y** | - | - | - | - | - |

### Infrastructure Features

| # | Feature | Mnemosyne | Mem0 | Zep | Cognee | LangMem | Letta |
|---|---|:---:|:---:|:---:|:---:|:---:|:---:|
| 43 | 2-tier caching (L1 in-memory + L2 distributed) | **Y** | - | - | - | - | - |
| 44 | Vector similarity search | **Y** | **Y** | **Y** | **Y** | **Y** | **Y** |
| 45 | Metadata filtering | **Y** | **Y** | **Y** | **Y** | **Y** | **Y** |
| 46 | CLI tools for operations | **Y** | **Y** | - | **Y** | - | **Y** |
| 47 | Framework-agnostic integration | **Y** | **Y** | **Y** | **Y** | - | P |
| 48 | Modular feature toggles (progressive adoption) | **Y** | - | - | - | - | - |
| 49 | Lifecycle hooks (before_agent_start, agent_end) | **Y** | - | - | - | - | - |

### Summary Count

| System | Total Features (of 49) | Free Features | Paid-Only Features |
|---|---|---|---|
| **Mnemosyne** | **49** | **49** | 0 |
| **Mem0** | ~11 | ~9 | ~2 (graph, multi-agent) |
| **Zep** | ~7 | ~7 | 0 |
| **Cognee** | ~10 | ~10 | 0 |
| **LangMem** | ~5 | ~5 | 0 |
| **Letta** | ~9 | ~9 | 0 |

---

## 4. Architecture Comparison

### Mnemosyne: 5-Layer Cognitive OS

```
+----------------------------------------------------------------------+
|                      MNEMOSYNE COGNITIVE OS                          |
|                                                                      |
|   L5: SELF-IMPROVEMENT                                               |
|   [ Reinforcement ] [ Consolidation ] [ Flash Reasoning ] [ ToMA ]   |
|                                                                      |
|   L4: COGNITIVE                                                      |
|   [ Activation Decay ] [ Confidence ] [ Priority ] [ Diversity ]     |
|                                                                      |
|   L3: KNOWLEDGE GRAPH                                                |
|   [ Temporal Graph ] [ Auto-Linking ] [ Path Traversal ] [ Entities ]|
|                                                                      |
|   L2: PIPELINE                                                       |
|   [ Extraction ] [ Type Classify ] [ Dedup & Merge ] [ Security ]    |
|                                                                      |
|   L1: INFRASTRUCTURE                                                 |
|   [ Vector DB ] [ Graph DB ] [ 2-Tier Cache ] [ Pub/Sub Broadcast ]  |
+----------------------------------------------------------------------+
```

Mnemosyne is designed as a layered operating system for cognition. Each layer builds on the one below it, and every layer is independently toggleable. You can start with L1+L2 (a smart vector store with deterministic ingestion) and progressively enable L3 (knowledge graph), L4 (cognitive scoring and decay), and L5 (self-improvement and multi-agent awareness) as your needs grow. There is no all-or-nothing commitment.

The 12-step pipeline in L2 is entirely algorithmic — zero LLM calls. Classification, entity extraction, urgency detection, domain classification, priority scoring, confidence rating, deduplication, conflict detection, and auto-linking all run through deterministic code paths. This means sub-50ms ingestion, $0.00 per-memory cost, and identical behavior on every run.

L3 adds a temporal knowledge graph powered by FalkorDB. Memories are connected to extracted entities, relationships carry timestamps, and the graph supports path-finding, timeline reconstruction, and temporal queries.

L4 adds cognitive intelligence: activation decay (memories fade over time unless reinforced), multi-signal composite scoring (5 independent signals weighted by detected query intent), and diversity reranking (prevents redundant results).

L5 adds self-improvement: reinforcement learning (feedback loop that tracks which memories proved useful), 4-phase active consolidation (contradiction detection, near-duplicate merge, popular promotion, stale demotion), flash reasoning (chain-of-thought traversal through linked memories), and the Agent Awareness Engine (Theory of Mind for agents, knowledge gap analysis, fleet-level synthesis).

**Infrastructure:** Qdrant (vector DB), FalkorDB (graph DB), Redis (cache + pub/sub), any OpenAI-compatible embedding endpoint. All open source.

### Mem0: Vector Store + LLM Extraction

```
+-------------------------------------------+
|              MEM0                          |
|                                           |
|   [ LLM Extraction ] --> [ Vector Store ] |
|          |                      |         |
|   [ Graph Store ]    [ Metadata Filter ]  |
|     (Pro only)         [ Reranker ]       |
+-------------------------------------------+
```

Mem0 is architecturally straightforward: text goes in, an LLM (GPT-4, Claude, etc.) extracts key facts, facts go into a vector store. Retrieval is vector similarity search with optional metadata filtering and a reranker. Graph storage was added and is available on the Pro plan ($249/month). The simplicity is both a strength — easy to understand, easy to integrate, fast to ship — and a limitation — there is no cognitive intelligence on top of storage. Every memory is a flat vector with metadata. There is no decay, no multi-signal scoring, no intent detection, no diversity control, no self-improvement.

The LLM dependency in the ingestion path is the most consequential design choice. It means extraction quality is high (LLMs are good at pulling facts from text) but it also means non-deterministic behavior (same text can produce different extractions on retry), 500ms-2s latency per memory, and a cost floor of approximately $0.01 per memory that scales linearly.

**Infrastructure:** Any vector DB (Qdrant, Chroma, Pinecone, etc.), any LLM provider. Optional Neo4j for graph (Pro tier).

### Zep: Conversation Memory Server

```
+-------------------------------------------+
|               ZEP                         |
|                                           |
|   [ Message Ingestion ] --> [ LLM ]  -->  |
|   [ Summary + Entities + Facts ] --> Store|
|          |                                |
|   [ Session Management ]                  |
|   [ Temporal Retrieval  ]                 |
+-------------------------------------------+
```

Zep is purpose-built for conversation memory. Messages flow in, get processed by an LLM to generate summaries, extract entities, and pull structured facts, then are stored for retrieval. Session management provides temporal scoping — you can retrieve memories by conversation, by time range, or by entity. The architecture is clean and well-suited for its intended use case: chatbots and conversational AI where message history is the primary memory substrate.

Zep does not attempt to be a general-purpose memory system. There is no knowledge graph, no multi-agent coordination, no cognitive scoring, and no self-improvement. This is a deliberate scope decision, not a missing feature. Zep does conversation memory well by keeping scope narrow.

**Infrastructure:** Managed cloud (Zep Cloud) or self-hosted with PostgreSQL + vector extensions.

### Cognee: Knowledge ETL + Graph

```
+-------------------------------------------+
|             COGNEE                         |
|                                           |
|   [ Document Ingestion ] --> [ LLM ]  --> |
|   [ Entity Extraction ] --> [ Graph DB ]  |
|          |                      |         |
|   [ Graph Queries ] [ Vector Search ]     |
+-------------------------------------------+
```

Cognee centers on knowledge graph construction. Documents (not just conversations) are processed through LLMs to extract entities and relationships at a depth that algorithmic extractors cannot match. The LLM infers implicit relationships, nuanced connections, and semantic structure. The resulting graph is the primary retrieval substrate — queries combine graph traversal with vector search to find information through both structural and semantic similarity.

Cognee's trade-off is the inverse of Mnemosyne's: higher extraction quality (LLMs find implicit relationships that rules miss) at the cost of higher latency, higher per-memory cost, and non-deterministic behavior. If your primary need is building rich, deep knowledge graphs from document corpora, Cognee's LLM-powered extraction may produce richer graphs than Mnemosyne's algorithmic extraction.

**Infrastructure:** Flexible — supports Neo4j, NetworkX, or other graph backends. Qdrant, Weaviate, or other vector stores. Requires an LLM provider.

### LangMem / LangChain Memory

```
+-------------------------------------------+
|            LANGMEM                        |
|                                           |
|   [ Buffer Memory ]                       |
|   [ Summary Memory ] --> [ LLM ]          |
|   [ Entity Memory  ] --> [ LLM ]          |
|   [ Vector Memory  ] --> [ Vector Store ] |
|          |                                |
|   [ LangChain Integration ]              |
+-------------------------------------------+
```

LangMem provides memory abstractions as utilities within the LangChain framework. Each memory type is a self-contained component: buffer memory stores raw messages, summary memory compresses conversations through an LLM, entity memory tracks extracted entities, and vector memory enables semantic search over past interactions. These are useful building blocks, but they remain building blocks — there is no cross-cutting intelligence layer, no cognitive scoring, no self-improvement, no knowledge graph.

The most significant architectural constraint is framework coupling. LangMem is part of LangChain. If you build on LangMem, you are building on LangChain. If you later migrate to CrewAI, AutoGen, or a custom framework, your memory layer does not migrate with you.

**Infrastructure:** Depends on configured backend. Can use any vector store LangChain supports. Requires an LLM for summary and entity memory types.

### Letta (MemGPT): LLM-Directed Memory

```
+-------------------------------------------+
|           LETTA (MemGPT)                  |
|                                           |
|   [ Core Memory ] (always in context)     |
|          |                                |
|   [ Recall Memory ] (conversation log)    |
|          |                                |
|   [ Archival Memory ] (long-term vector)  |
|          |                                |
|   [ LLM-Directed Memory Management ]     |
|   [ Tool Execution Framework ]            |
+-------------------------------------------+
```

Letta's architecture is built around a single insight: the LLM can manage its own memory. The system defines three tiers — core memory (critical context always in the prompt), recall memory (searchable conversation history), and archival memory (long-term vector store). The LLM decides what moves between tiers through tool calls. When the context window fills, the LLM autonomously archives low-priority content and retrieves high-priority content.

This is philosophically the opposite of Mnemosyne's approach. Letta trusts the LLM's judgment. Mnemosyne trusts algorithms. The trade-off: Letta's memory management can leverage the full reasoning power of the LLM, but it is non-deterministic and every memory management action costs an LLM call. Mnemosyne's memory management is consistent, fast, and free, but does not benefit from LLM reasoning during ingestion.

Letta is also a full agent framework, not just a memory layer. It provides persistent stateful agents, tool execution, a server architecture, and an API. If you want an opinionated end-to-end agent platform, Letta is a complete solution. If you want a memory layer to plug into your existing agent framework, it is a heavier dependency.

**Infrastructure:** Letta server, any LLM provider. PostgreSQL for storage. Optional managed cloud.

---

## 5. Pricing Comparison

### Per-Memory Ingestion Cost

The cost of storing a single memory, including all processing (extraction, classification, embedding, linking, graph ingestion).

| System | Cost per Memory | What's Included |
|---|---|---|
| **Mnemosyne** | **~$0.0001** (embedding only) | Full 12-step pipeline, classification, entity extraction, dedup, auto-linking, graph ingestion, broadcast |
| **Mem0** (self-hosted) | ~$0.01-0.03 | LLM extraction call + embedding |
| **Mem0** (cloud) | Included in plan | Plan-dependent limits (free tier: 1K memories) |
| **Zep** (cloud) | Included in plan | Summarization + entity extraction + fact extraction |
| **Zep** (self-hosted) | ~$0.01-0.02 | LLM summarization + embedding |
| **Cognee** | ~$0.01-0.05 | LLM entity/relationship extraction + embedding + graph construction |
| **LangMem** | ~$0.01-0.03 | LLM summarization/extraction (if used) + embedding |
| **Letta** | ~$0.01-0.05 | LLM-directed memory management decisions + embedding |

Mnemosyne's only variable cost is embedding generation — approximately $0.0001 per memory using a local model (Nomic via MLX, Ollama, etc.), or genuinely $0.00 with a self-hosted embedding server. All other processing in the 12-step pipeline is algorithmic and costs nothing. Every competitor requires at least one LLM API call per memory stored.

### Self-Hosted Infrastructure Costs

Monthly infrastructure cost for running each system's required services on your own hardware/VPS.

| Component | Mnemosyne | Mem0 | Zep | Cognee | LangMem | Letta |
|---|---|---|---|---|---|---|
| Vector DB (Qdrant/similar) | ~$10-20 | ~$10-20 | ~$10-20 | ~$10-20 | ~$10-20 | ~$10-20 |
| Graph DB | ~$5-10 (FalkorDB) | ~$20-50 (Neo4j, if used) | N/A | ~$20-50 (Neo4j) | N/A | N/A |
| Cache / Pub/Sub (Redis) | ~$5-10 | Optional | N/A | N/A | N/A | N/A |
| Embedding Server | ~$0-10 (local) | ~$0-10 (local) | ~$0-10 | ~$0-10 | ~$0-10 | ~$0-10 |
| LLM API (ingestion) | **$0** | **$100-3,000+** | **$50-2,000+** | **$100-5,000+** | **$50-2,000+** | **$100-5,000+** |
| **Total (10K mem/mo)** | **~$20-40** | **~$130-320** | **~$70-220** | **~$140-530** | **~$70-320** | **~$120-530** |

### Cloud / Managed Service Costs

| System | Free Tier | Starter/Pro | Enterprise |
|---|---|---|---|
| **Mnemosyne** | BYO infra (all features free) | N/A | N/A |
| **Mem0 Cloud** | 1K memories, basic features | $49-249/mo (graph at $249) | Contact sales |
| **Zep Cloud** | Limited free tier | $49-199/mo | Custom |
| **Cognee** | BYO infra (open source) | Cloud beta | N/A |
| **LangMem** | Part of LangSmith plans | LangSmith pricing | LangSmith enterprise |
| **Letta Cloud** | Free tier available | Usage-based | Custom |

### Knowledge Graph Costs

| System | Graph Availability | Additional Cost |
|---|---|---|
| **Mnemosyne** | Built-in, always available | $0 (FalkorDB is open source) |
| **Mem0** | Pro plan only | $249/month |
| **Zep** | Not available | N/A |
| **Cognee** | Core feature | $0 (self-hosted) + LLM extraction costs |
| **LangMem** | Not available | N/A |
| **Letta** | Not available | N/A |

### Multi-Agent Costs

| System | Multi-Agent Support | Additional Cost |
|---|---|---|
| **Mnemosyne** | Full mesh, pub/sub, ToMA, synthesis | $0 (all features included) |
| **Mem0** | Enterprise tier only | Enterprise pricing (contact sales) |
| **Zep** | Not available | N/A |
| **Cognee** | Not available | N/A |
| **LangMem** | Not available | N/A |
| **Letta** | Basic multi-agent framework | $0 (self-hosted) |

### Cost at Scale: 10K, 100K, and 1M Memories per Month

#### 10,000 memories/month

| System | Infrastructure | LLM Ingestion | Feature Costs | Monthly Total |
|---|---|---|---|---|
| **Mnemosyne** | ~$30 | $0 | $0 | **~$30** |
| **Mem0** (self-hosted) | ~$30 | ~$100-300 | $0 (limited features) | **~$130-330** |
| **Mem0** (cloud Pro) | Included | Included | $249 (for graph) | **$249** |
| **Zep** (cloud) | Included | Included | Plan cost | **$49-199** |
| **Cognee** (self-hosted) | ~$40 | ~$100-500 | $0 | **~$140-540** |
| **LangMem** (self-hosted) | ~$20 | ~$100-300 | $0 | **~$120-320** |
| **Letta** (self-hosted) | ~$30 | ~$100-500 | $0 | **~$130-530** |

#### 100,000 memories/month

| System | Infrastructure | LLM Ingestion | Feature Costs | Monthly Total |
|---|---|---|---|---|
| **Mnemosyne** | ~$60 | $0 | $0 | **~$60** |
| **Mem0** (self-hosted) | ~$60 | ~$1,000-3,000 | $0 | **~$1,060-3,060** |
| **Mem0** (cloud) | Enterprise | Enterprise | Enterprise | **Enterprise pricing** |
| **Cognee** (self-hosted) | ~$70 | ~$1,000-5,000 | $0 | **~$1,070-5,070** |
| **LangMem** (self-hosted) | ~$40 | ~$1,000-3,000 | $0 | **~$1,040-3,040** |
| **Letta** (self-hosted) | ~$60 | ~$1,000-5,000 | $0 | **~$1,060-5,060** |

#### 1,000,000 memories/month

| System | Infrastructure | LLM Ingestion | Feature Costs | Monthly Total |
|---|---|---|---|---|
| **Mnemosyne** | ~$250 | $0 | $0 | **~$250** |
| **Mem0** (self-hosted) | ~$250 | ~$10,000-30,000 | $0 | **~$10,250-30,250** |
| **Cognee** (self-hosted) | ~$300 | ~$10,000-50,000 | $0 | **~$10,300-50,300** |
| **Letta** (self-hosted) | ~$250 | ~$10,000-50,000 | $0 | **~$10,250-50,250** |

The pattern is clear: **at scale, Mnemosyne's zero-LLM architecture creates a 40-200x cost advantage on ingestion**. Infrastructure costs (vector DB, graph DB, cache) are roughly equivalent across all systems. The difference is entirely the per-memory LLM processing cost that Mnemosyne eliminates.

### Total Cost of Ownership: 12-Month Estimate at 100K Memories/Month

| System | Year 1 Total | Notes |
|---|---|---|
| **Mnemosyne** | **~$720** | Infrastructure only, all 49 features included |
| **Mem0** (self-hosted, basic) | ~$12,720-36,720 | LLM costs dominate, limited features |
| **Mem0** (cloud, Pro) | ~$3,000-6,000+ | Plan + overage, graph included at Pro tier |
| **Zep** (cloud) | ~$600-2,400 | Conversation-only scope, no graph or multi-agent |
| **Cognee** (self-hosted) | ~$12,840-60,840 | LLM costs dominate |
| **LangMem** (self-hosted) | ~$12,480-36,480 | LLM costs dominate, minimal features |
| **Letta** (self-hosted) | ~$12,720-60,720 | LLM costs dominate |

---

## 6. Performance Comparison

### Ingestion Latency

The time to fully process and store a single memory.

| System | Ingestion Latency | Bottleneck |
|---|---|---|
| **Mnemosyne** | **< 50ms** | Embedding generation (~15ms) + algorithmic pipeline (~35ms) |
| **Mem0** (self-hosted) | 500ms - 2s | LLM extraction call |
| **Mem0** (cloud) | 200ms - 1s | Network + LLM extraction |
| **Zep** | 500ms - 2s | LLM summarization + entity extraction |
| **Cognee** | 1s - 5s | LLM entity/relationship extraction + graph construction |
| **LangMem** | 300ms - 2s | LLM summarization (if used) |
| **Letta** | 500ms - 3s | LLM memory management decision + storage |

Mnemosyne's ingestion is 10-100x faster because the entire pipeline is algorithmic. There is no LLM round-trip. The embedding generation (~15ms with a local model) is the only variable-latency step, and it is cached (512-entry LRU).

### Retrieval Latency

The time to search and return ranked results.

| System | Cache Hit | Cache Miss | Notes |
|---|---|---|---|
| **Mnemosyne** | **< 10ms** (L1 hit) | **< 200ms** (full search) | 2-tier cache, multi-signal scoring, graph enrichment, diversity reranking |
| **Mem0** | N/A | 100-500ms | Vector search + optional reranking |
| **Zep** | N/A | 100-300ms | Vector search + temporal filtering |
| **Cognee** | N/A | 200-1000ms | Graph traversal + vector search |
| **LangMem** | N/A | 50-200ms | Simple vector search |
| **Letta** | N/A | 200-500ms | LLM may issue multiple search tool calls |

Mnemosyne's retrieval is competitive even though it does substantially more work per query (5-signal scoring, intent detection, diversity reranking, graph enrichment, flash reasoning). The 2-tier cache (L1 in-memory with 50 entries/5-min TTL, L2 distributed via Redis with 1-hour TTL) handles repeated and similar queries at sub-10ms latency. Cache hit rates exceed 60% in typical conversational workloads.

### Throughput

| System | Write Throughput | Read Throughput | Notes |
|---|---|---|---|
| **Mnemosyne** | ~20 memories/sec | ~50-100 queries/sec | Limited by embedding service; pipeline itself is sub-50ms |
| **Mem0** (self-hosted) | ~1-2 memories/sec | ~10-20 queries/sec | Limited by LLM API rate limits |
| **Zep** | ~1-2 memories/sec | ~20-30 queries/sec | Limited by LLM API rate limits |
| **Cognee** | ~0.5-1 memories/sec | ~5-10 queries/sec | Heavy LLM processing for graph construction |
| **LangMem** | ~1-3 memories/sec | ~20-50 queries/sec | Depends on backend |
| **Letta** | ~1-2 memories/sec | ~5-20 queries/sec | LLM bottleneck on both paths |

### Caching Architecture

| System | L1 Cache | L2 Cache | Cache Invalidation | Hit Rate |
|---|---|---|---|---|
| **Mnemosyne** | In-memory (50 entries, 5-min TTL, LRU) | Redis (1-hour TTL, pattern-based) | Automatic on write + broadcast | >60% in conversational workloads |
| **Mem0** | None built-in | None built-in | N/A | N/A |
| **Zep** | None built-in | None built-in | N/A | N/A |
| **Cognee** | None built-in | None built-in | N/A | N/A |
| **LangMem** | None built-in | None built-in | N/A | N/A |
| **Letta** | None built-in | None built-in | N/A | N/A |

Mnemosyne is the only system with a built-in multi-tier caching architecture. Other systems rely on external caching layers or no caching at all.

### Scalability Properties

| Property | Mnemosyne | Others |
|---|---|---|
| Vector search scaling | Sub-linear (Qdrant HNSW index) | Similar (all use HNSW or equivalent) |
| Graph query scaling | Depth-limited traversal (configurable max 3 hops) | Cognee: depends on graph backend; others: N/A |
| Memory capacity tested | 13,000+ (production) | Varies; Mem0 cloud handles large scale |
| Concurrent agents | 10+ (production, no locking) | Not applicable for most competitors |
| Broadcast throughput | Thousands of messages/second (Redis pub/sub) | Not applicable for most competitors |

---

## 7. Individual Matchups

### Mnemosyne vs Mem0

Mem0 deserves credit for popularizing persistent AI memory. It has the largest community (41K+ stars), the most integrations, and a managed cloud platform that eliminates infrastructure management. These are real advantages.

**Where Mem0 wins:**
- **Community and ecosystem:** 41K+ GitHub stars means more tutorials, more integrations, more community answers to your questions. If you get stuck, there is a larger pool of people who have solved similar problems.
- **Managed cloud:** Mem0 Cloud handles infrastructure entirely. You sign up, get an API key, and start storing memories. No Docker containers, no Qdrant, no Redis. For teams that cannot or do not want to manage infrastructure, this is significant.
- **Simplicity:** Mem0's API is smaller and simpler. `add()`, `search()`, `get()`, `delete()`. If you need basic memory and nothing more, Mem0 has fewer concepts to learn.
- **Python-native:** The AI/ML ecosystem is Python-first. Mem0 fits natively into Python workflows, Jupyter notebooks, and Python agent frameworks.
- **Proven at scale in cloud:** Mem0 Cloud has handled large-scale production workloads. Their managed infrastructure has been battle-tested by thousands of users.

**Where Mnemosyne wins:**
- **Zero-LLM pipeline:** Sub-50ms ingestion, $0.00 per memory, deterministic behavior. At 100K memories/month, this saves $1,000-3,000/month in LLM costs alone.
- **Cognitive features:** 10 features (decay, multi-signal scoring, intent-aware retrieval, diversity reranking, flash reasoning, reinforcement learning, consolidation, proactive recall, session survival, observational memory) that have no equivalent in Mem0.
- **Knowledge graph included free:** FalkorDB is open source. Mem0's graph requires the Pro plan at $249/month.
- **Multi-agent native:** Real-time mesh, pub/sub, Theory of Mind, knowledge gap analysis, fleet-level synthesis, shared state blocks — all free, all production-ready. Mem0's multi-agent support is enterprise-only.
- **Self-improving:** Reinforcement learning and 4-phase autonomous consolidation. Mem0 does not improve through use.
- **Retrieval quality:** 5-signal composite scoring, intent-aware weight adaptation, diversity reranking vs. vector similarity with optional reranking.

**Bottom line:** Mem0 is the safe, popular choice for teams that need basic memory with minimal operational burden. Mnemosyne is the choice for teams that need cognitive intelligence, multi-agent collaboration, zero-LLM economics, or self-improving memory. The gap is not incremental — these are architecturally different systems solving the same problem at fundamentally different depths.

---

### Mnemosyne vs Zep

Zep is a well-executed, focused system. It does conversation memory and does it cleanly.

**Where Zep wins:**
- **Purpose-built conversation model:** If your application is a chatbot and you need message history, session scoping, summaries, and entity extraction from conversations — Zep was designed from the ground up for exactly this. The developer experience for conversation-specific memory is polished.
- **Managed cloud:** Zep Cloud eliminates infrastructure concerns with a clean hosted offering.
- **Fact extraction:** Zep's structured fact extraction from conversations is well-implemented and useful for building user profiles from chat.
- **Simplicity for chat apps:** Fewer concepts, narrower scope, faster to integrate for the specific use case of conversation memory.

**Where Mnemosyne wins:**
- **Scope:** Mnemosyne handles conversation memory as one use case among many. It also handles knowledge management, procedural memory, multi-agent coordination, preference tracking, relationship mapping, and more.
- **Knowledge graph:** Zep has no knowledge graph. Mnemosyne includes temporal graph queries, auto-linking, path finding, and timeline reconstruction.
- **Multi-agent:** Zep is single-agent. Mnemosyne supports full agent mesh with real-time broadcast, ToMA, synthesis, and shared state.
- **Cognitive features:** Activation decay, multi-signal scoring, intent-aware retrieval, diversity reranking, flash reasoning, reinforcement learning, consolidation. Zep has summarization.
- **Zero-LLM ingestion:** Deterministic, fast, free. Zep requires LLM calls for summarization and extraction.
- **Self-improving:** Reinforcement learning and autonomous consolidation. Zep's memory quality is static after storage.

**Bottom line:** Zep is the right choice if conversation memory is your only requirement and you want a managed service with minimal setup. Mnemosyne is the right choice if you need anything beyond conversation memory — knowledge graphs, multi-agent, cognitive features, or general-purpose long-term memory.

---

### Mnemosyne vs Cognee

Cognee is the most interesting competitor from a knowledge graph perspective. It takes a fundamentally different approach to graph construction.

**Where Cognee wins:**
- **LLM-quality relationship extraction:** Cognee uses LLMs to extract entities and relationships, which means it can find implicit connections, infer nuanced relationships, and build richer semantic structure than rule-based extraction. If your documents contain complex, implicit relationships ("the acquisition suggests that Company A is moving into the healthcare market"), Cognee's LLM-powered extraction will capture this. Mnemosyne's algorithmic extraction will miss it.
- **Document processing:** Cognee is designed to process documents (PDFs, articles, reports), not just conversations or short text snippets. If your primary input is a document corpus, Cognee's pipeline is optimized for this.
- **Graph-first query model:** If your retrieval patterns are inherently graph-oriented (multi-hop traversal, relationship queries, subgraph extraction), Cognee's graph-first architecture provides a natural query model.
- **Flexible graph backends:** Cognee supports multiple graph backends (Neo4j, NetworkX, etc.), giving you flexibility in graph infrastructure.

**Where Mnemosyne wins:**
- **Zero-LLM efficiency:** At 100K documents, Cognee's LLM extraction costs $1,000-5,000/month. Mnemosyne's costs $0. The extraction is less deep, but for many use cases (explicit entities, names, IPs, technologies, dates, URLs), algorithmic extraction is sufficient.
- **Cognitive layer on top of the graph:** Mnemosyne does not stop at the graph. Memories have activation levels, confidence scores, reinforcement signals, decay dynamics, and multi-signal scoring. The graph is one component of a larger cognitive system.
- **Multi-agent native:** Cognee has no multi-agent support. Mnemosyne has full mesh, pub/sub, ToMA, and fleet synthesis.
- **Self-improving:** Reinforcement learning and autonomous consolidation. Cognee's graph is static after construction.
- **Temporal graph:** Mnemosyne's graph is bi-temporal (event time + ingestion time). Every relationship carries timestamps. Cognee's temporal support is limited.
- **General-purpose memory:** Mnemosyne handles all memory types (episodic, semantic, preference, procedural, relationship, profile, core). Cognee is focused on knowledge graph construction.

**Bottom line:** Cognee is the right choice if deep knowledge graph construction from documents is your primary and only need, and you are willing to pay LLM costs for extraction quality. Mnemosyne is the right choice if you need a general-purpose cognitive memory system that includes a knowledge graph as one capability among many.

---

### Mnemosyne vs LangMem / LangChain Memory

LangMem is not really a standalone memory system — it is a set of memory utilities within the LangChain framework. The comparison is therefore between a cognitive memory OS and a set of memory primitives.

**Where LangMem wins:**
- **LangChain integration:** If you are building with LangChain, LangMem is the path of least resistance. It integrates directly with chains, agents, and the broader LangChain ecosystem. There is no adapter layer, no protocol translation.
- **Simplicity:** Buffer memory, summary memory, entity memory, vector memory. Four concepts, simple APIs, well-documented within the LangChain docs.
- **Ecosystem breadth:** LangChain's ecosystem includes hundreds of integrations. LangMem inherits all of them.
- **Lowest switching cost:** If you are already using LangChain, LangMem requires zero additional dependencies.

**Where Mnemosyne wins:**
- **Framework independence:** Mnemosyne works with LangChain, CrewAI, AutoGen, custom frameworks, or no framework. Your memory investment survives framework migrations. LangMem is locked to LangChain.
- **Feature depth:** 49 features vs. ~5. Knowledge graph, multi-agent mesh, cognitive scoring, self-improvement, activation decay, flash reasoning, reinforcement learning, consolidation — none of these exist in LangMem.
- **Zero-LLM ingestion:** LangMem's summary and entity memory types require LLM calls. Mnemosyne's pipeline is fully algorithmic.
- **Persistence and durability:** Mnemosyne uses Qdrant + FalkorDB + Redis with soft-delete, bi-temporal tracking, and session survival. LangMem's persistence depends entirely on the backend you configure, and there is no built-in durability model.
- **Retrieval quality:** 5-signal composite scoring with intent-aware weighting and diversity reranking vs. basic vector similarity or recency-based retrieval.

**Bottom line:** LangMem is the right choice if you are fully committed to LangChain, need basic memory, and value minimal setup over feature depth. Mnemosyne is the right choice for everything else — framework independence, cognitive features, knowledge graphs, multi-agent, self-improvement, or any use case that outgrows basic store-and-retrieve.

---

### Mnemosyne vs Letta (MemGPT)

Letta is the most philosophically interesting competitor. It asks a genuinely different question: "What if the LLM manages its own memory?"

**Where Letta wins:**
- **LLM-directed memory management:** The LLM decides what to save, what to archive, what to retrieve. This means memory management benefits from the full reasoning capability of the LLM. For complex, ambiguous memory decisions ("is this worth remembering?"), LLM judgment can be superior to algorithmic rules.
- **Context window optimization:** Letta pioneered this. The system actively manages what is in the LLM's context window, archiving low-priority content and retrieving high-priority content as needed. For applications where context window utilization is the primary bottleneck, Letta is purpose-built.
- **Persistent stateful agents:** Letta provides a complete agent framework with persistent state, tool execution, and a server architecture. You get stateful agents out of the box, not just a memory layer.
- **Agent framework completeness:** If you want an opinionated, end-to-end agent platform (not just memory), Letta is a more complete solution than a standalone memory system.
- **Self-managing memory operations:** The LLM handles its own memory housekeeping — archiving old content, retrieving relevant context, updating core memory. This reduces the operational burden of memory management.

**Where Mnemosyne wins:**
- **Deterministic behavior:** Same input always produces the same classification, scoring, and storage outcome. Letta's LLM-directed management produces different results on different runs. For auditable, reproducible systems, this matters.
- **Zero-LLM cost:** Every memory management action in Letta requires an LLM call. In Mnemosyne, every memory management action is free. At scale, this is a 50-200x cost difference.
- **Cognitive features beyond context management:** Activation decay, multi-signal scoring, intent-aware retrieval, diversity reranking, flash reasoning, reinforcement learning, 4-phase consolidation, proactive recall, observational memory compression. Letta has context management and persistent state; Mnemosyne has 10 cognitive features.
- **Knowledge graph:** Mnemosyne includes a temporal knowledge graph with auto-linking, path finding, and timeline reconstruction. Letta has no graph.
- **Multi-agent mesh:** Real-time pub/sub, Theory of Mind, knowledge gap analysis, fleet-level synthesis, shared state blocks. Letta has a basic multi-agent framework but no real-time mesh, no ToMA, no synthesis.
- **Self-improving:** Reinforcement learning (feedback loop that promotes useful memories, flags poor ones) and autonomous 4-phase consolidation. Letta does not improve through use.
- **Framework agnostic:** Mnemosyne is a memory layer that works with any agent framework. Letta is an agent framework — you adopt the whole platform or none of it.

**Bottom line:** Letta is the right choice if you want LLM-directed memory management, context window optimization, and a complete agent framework. Mnemosyne is the right choice if you want deterministic, zero-cost memory management with cognitive intelligence, knowledge graphs, multi-agent mesh, and self-improvement that works with any agent framework you choose.

---

## 8. Decision Guide

A practical "if you need X, use Y" reference.

| If you need... | Best choice | Runner-up | Why |
|---|---|---|---|
| **Basic memory, largest community** | Mem0 | Zep | 41K stars, most tutorials, managed cloud |
| **Managed cloud, zero infrastructure** | Mem0 Cloud or Zep Cloud | Letta Cloud | Fully managed, no containers to run |
| **Conversation memory only** | Zep | Mem0 | Purpose-built, clean session model |
| **Knowledge graph from documents** | Cognee | Mnemosyne | LLM-quality deep relationship extraction |
| **Tight LangChain integration** | LangMem | Mem0 | Native to the LangChain ecosystem |
| **LLM-directed memory management** | Letta | - | Only system where the LLM manages its own memory |
| **Full agent framework + memory** | Letta | - | Complete agent platform, not just memory |
| **Context window optimization** | Letta | Mnemosyne | Letta pioneered this, built a framework around it |
| **Zero-LLM ingestion (fast, free, deterministic)** | **Mnemosyne** | - | Only system with fully algorithmic pipeline |
| **Cognitive features (decay, reasoning, scoring)** | **Mnemosyne** | - | 10 production-ready cognitive features, no competitor has any |
| **Multi-agent mesh (pub/sub, ToMA, synthesis)** | **Mnemosyne** | Mem0 Enterprise | Only open-source system with full mesh |
| **Knowledge graph included free** | **Mnemosyne** | Cognee | FalkorDB built-in + temporal queries + auto-linking |
| **Self-improving memory** | **Mnemosyne** | - | Only system with reinforcement learning + consolidation |
| **Lowest cost at scale (100K+ memories)** | **Mnemosyne** | - | 40-200x cheaper than LLM-dependent systems |
| **Deterministic, auditable memory behavior** | **Mnemosyne** | - | Algorithmic pipeline, 23-field schema, soft-delete, bi-temporal |
| **Framework independence** | **Mnemosyne** | Mem0 / Cognee | Works with any agent framework or none |
| **Procedural memory / skill library** | **Mnemosyne** | Letta | Decay-immune skill storage, fleet-wide skill sharing |
| **Session survival across context resets** | **Mnemosyne** | Letta | Snapshot/recovery with full cognitive state |
| **Theory of Mind (model other agents' knowledge)** | **Mnemosyne** | - | Only system with agent awareness engine |
| **Fleet-level insight synthesis** | **Mnemosyne** | - | Cross-agent corroboration, automatic synthesis |
| **Production-hardened (13K+ mem, 10-agent mesh)** | **Mnemosyne** | Mem0 Cloud | Battle-tested with real production workload |
| **Python-native tooling** | Mem0 | Cognee / Letta | Most AI memory systems are Python |
| **TypeScript-native** | **Mnemosyne** | - | Built in TypeScript for Node.js runtime |

---

## 9. Migration Guide

### Migrating from Mem0 to Mnemosyne

**Data migration:**
1. Export existing memories from Mem0 using its API (`get_all()` or batch export).
2. For each memory, call `memory_store` with the original text content. Mnemosyne's 12-step pipeline will re-classify, re-extract entities, score, and link automatically.
3. If you have metadata (user IDs, timestamps, tags) in Mem0, map them to Mnemosyne's schema: `botId` for agent/user scoping, `eventTime` for when it happened, `importance` for priority override.
4. Mem0's extracted facts (the LLM-processed versions) can be stored as-is if you prefer to preserve the LLM extraction. Alternatively, store the original raw text and let Mnemosyne re-process it through the zero-LLM pipeline.

**What you gain:** All 10 cognitive features, knowledge graph (free), multi-agent mesh, zero-LLM costs going forward, deterministic pipeline.

**What you lose:** Mem0 Cloud managed hosting (you now manage infrastructure), Python-native API (Mnemosyne is TypeScript), Mem0's community ecosystem.

**Effort estimate:** Small (< 1 day) for data migration. Medium (1-3 days) for API integration changes. The pipeline handles re-processing automatically.

### Migrating from Zep to Mnemosyne

**Data migration:**
1. Export conversation sessions and summaries from Zep.
2. Store session summaries as `semantic` type memories via `memory_store`. Store individual messages as `episodic` type memories if desired.
3. Map Zep's session IDs to Mnemosyne's `source` field for provenance tracking.
4. Zep's extracted entities will be re-extracted by Mnemosyne's pipeline. The algorithmic extraction may capture different entities than Zep's LLM-based extraction.

**What you gain:** Knowledge graph, multi-agent mesh, cognitive features, all 7 memory types, self-improvement, zero-LLM costs.

**What you lose:** Zep's focused conversation model (Mnemosyne is general-purpose), managed cloud hosting, Zep's fact extraction format.

**Effort estimate:** Small (< 1 day) for data migration. Small-medium (1-2 days) for API integration. Conversation memory is one of Mnemosyne's standard use cases.

### Migrating from Cognee to Mnemosyne

**Data migration:**
1. Export your knowledge graph (entities and relationships) from Cognee's graph backend.
2. Store the underlying source documents/texts via `memory_store` to rebuild Mnemosyne's vector index and trigger re-classification.
3. For existing graph relationships that Cognee extracted via LLM (especially implicit/nuanced ones), consider importing them directly into FalkorDB to preserve the LLM-quality extraction.
4. Mnemosyne's algorithmic entity extraction will handle explicit entities. Import Cognee's LLM-extracted implicit relationships separately if they are valuable.

**What you gain:** Cognitive features, multi-agent mesh, temporal graph queries, auto-linking, self-improvement, zero-LLM costs going forward, activation decay.

**What you lose:** LLM-quality deep relationship extraction (Mnemosyne's extraction is algorithmic, missing implicit relationships). Mitigate this by preserving Cognee's existing graph data.

**Effort estimate:** Medium (2-5 days). Graph data migration requires careful mapping between schemas. Source text re-ingestion is automated.

### Migrating from LangMem to Mnemosyne

**Data migration:**
1. Export stored memories from whatever backend LangMem was configured to use (vector store contents, entity stores, summary stores).
2. Store texts via `memory_store`. Mnemosyne handles classification, entity extraction, and linking automatically.
3. If you had LangChain-specific integration points, create an adapter that calls Mnemosyne's 9 tools in place of LangMem's memory classes.

**What you gain:** Framework independence (no more LangChain lock-in), all cognitive features, knowledge graph, multi-agent mesh, self-improvement, zero-LLM costs, deterministic pipeline.

**What you lose:** Tight LangChain integration (you will need an adapter layer).

**Effort estimate:** Small (< 1 day) for data migration. Medium (1-3 days) for replacing LangChain memory integration with Mnemosyne tool calls. The main work is rewriting the agent-memory interface.

### Migrating from Letta to Mnemosyne

**Data migration:**
1. Export core memory, recall memory, and archival memory from Letta's PostgreSQL backend.
2. Map Letta's core memory to Mnemosyne's `core` type (immune to decay, always high priority).
3. Map recall memory (conversation logs) to `episodic` type memories.
4. Map archival memory to appropriate types (`semantic`, `procedural`, `preference`, etc.) based on content.
5. Store all via `memory_store` for re-processing through the 12-step pipeline.

**What you gain:** All cognitive features, knowledge graph, full multi-agent mesh, deterministic management, zero-LLM memory costs, framework independence.

**What you lose:** LLM-directed memory management (Mnemosyne uses algorithmic management), Letta's agent framework (you will need a separate agent framework), context window optimization (Mnemosyne handles session survival differently).

**Effort estimate:** Medium (2-4 days). The main challenge is replacing Letta's agent framework — Mnemosyne is a memory layer, not a full agent platform. You will need to pair it with another agent framework.

### General Migration Notes

- **Re-processing is cheap:** Since Mnemosyne's pipeline is zero-LLM, re-ingesting your entire memory corpus costs nothing beyond embedding generation (~$0.0001/memory). You can re-process 100K memories for under $10.
- **Preserve provenance:** Use Mnemosyne's `source` field to tag migrated memories with their original system and migration timestamp.
- **Incremental migration:** You can run both systems in parallel during migration. Store new memories in Mnemosyne while gradually migrating the old corpus.
- **Auto-linking rebuilds connections:** Once memories are in Mnemosyne, the auto-linking system will discover and create bidirectional links between related memories, effectively rebuilding the knowledge web.

---

## Final Verdict

| Dimension | Winner | Runner-Up | Notes |
|---|---|---|---|
| **Cognitive features** | **Mnemosyne** (10) | Letta (1) | No other system implements decay, reasoning, consolidation, ToMA, or reinforcement |
| **Ingestion cost** | **Mnemosyne** ($0) | All others (~$0.01+) | Zero-LLM architecture is unique to Mnemosyne |
| **Ingestion latency** | **Mnemosyne** (<50ms) | All others (500ms-2s) | Algorithmic pipeline vs. LLM round-trip |
| **Knowledge graph (free)** | **Mnemosyne** | Cognee | Mnemosyne adds temporal queries and auto-linking; Cognee adds deeper LLM extraction |
| **Multi-agent** | **Mnemosyne** | Mem0 (enterprise) | Only Mnemosyne has mesh, pub/sub, ToMA, synthesis, knowledge gap analysis |
| **Self-improvement** | **Mnemosyne** | - | No other system has reinforcement learning or autonomous consolidation |
| **Retrieval intelligence** | **Mnemosyne** | Mem0 | 5-signal, intent-aware, diversity-reranked vs. basic vector similarity |
| **Community size** | **Mem0** (41K stars) | Letta | Community matters for support, integrations, and ecosystem |
| **Managed cloud** | **Mem0** / **Zep** | Letta | If zero-ops matters, managed services win |
| **Simplicity** | **Mem0** | LangMem | Fewest concepts, fastest to get started |
| **Conversation memory** | **Zep** | Mnemosyne | Zep is purpose-built; Mnemosyne handles it as one use case |
| **Graph extraction depth** | **Cognee** | Mem0 (Pro) | LLM-based extraction finds implicit relationships |
| **LangChain integration** | **LangMem** | Mem0 | Native to the ecosystem |
| **Context window management** | **Letta** | Mnemosyne | Letta pioneered this and built an entire framework around it |
| **Framework independence** | **Mnemosyne** | Mem0 / Cognee | Works with any agent framework or none |
| **Cost at scale (1M memories)** | **Mnemosyne** (~$250/mo) | - | 40-200x cheaper than LLM-dependent alternatives |
| **Production hardening** | **Mnemosyne** | Mem0 | 13K memories, 10-agent mesh, soft-delete, bi-temporal, 2-tier cache |
| **Deterministic behavior** | **Mnemosyne** | - | Only system with fully algorithmic ingestion pipeline |

### The Bottom Line

If you need a simple memory layer with the largest community and managed cloud, **Mem0** is the safe choice.

If you need conversation-specific memory with minimal complexity, **Zep** is well-suited.

If you need deep knowledge graph construction from documents, **Cognee** is the specialist.

If you need tight LangChain integration, **LangMem** is the path of least resistance.

If you want LLM-directed memory management and a full agent framework, **Letta** is innovative and capable.

If you need cognitive intelligence, multi-agent collaboration, zero-LLM efficiency, self-improving memory, and knowledge graphs — all open source, all production-ready, all in one system — **Mnemosyne is the only option that exists**.

No other system combines these capabilities. Not because competitors chose not to build them, but because building them requires a fundamentally different architecture — one designed from the ground up as a cognitive operating system rather than a vector store with an API.

---

<p align="center">
  <strong>Mnemosyne</strong> — Because intelligence without memory isn't intelligence.
</p>
