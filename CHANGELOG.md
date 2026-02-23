# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-02-23

### Added

- **Vector memory store/recall/forget** — Store, retrieve, and delete memories using dense vector embeddings via Qdrant for high-accuracy semantic search
- **BM25 hybrid search** — Combine sparse BM25 keyword matching with dense vector search for superior retrieval precision
- **Spreading activation** — Graph-based spreading activation traversal that surfaces related memories contextually, even when semantic similarity is low
- **Temporal sequences** — Automatically discover and replay ordered event sequences; predict likely next events from a current trigger
- **Pattern mining** — Mine co-occurrence clusters, entity correlations, recurring errors, and anomalies from the memory corpus
- **Dream consolidation** — Background consolidation job that deduplicates, merges near-duplicate memories, strengthens frequently accessed facts, and prunes stale entries
- **Cross-bot synthesis** — Fleet-wide knowledge synthesis discovers consensus, contradictions, blind spots, and complementary knowledge across all agent instances
- **Conversation digests** — Automatically compress and summarize long conversation histories into concise, searchable digests
- **Observational memory** — Passive background observation mode that captures environmental signals and inferences without explicit store calls
- **Theory of Mind for Agents (TOMA)** — Query what a specific bot knows about a topic from its own perspective; supports multi-agent knowledge attribution
- **Memory-R1 feedback** — Reinforcement-style feedback loop (positive/negative signals) that promotes or demotes memories based on retrieval usefulness
- **Cognitive intent detection** — Automatically classify the intent behind incoming text (storing facts, querying, reflecting, planning) to route memory operations intelligently
- **Proactive queries** — Agents can subscribe to memory topics and receive push notifications when relevant new memories arrive
- **Knowledge graph via FalkorDB** — Persist entity relationships and semantic links in a property graph; enables multi-hop reasoning over stored knowledge
- **Cross-agent broadcast via Redis** — Publish memory events to a Redis pub/sub channel so all agents in a fleet receive real-time memory updates
- **Configurable backends** — Swap vector store (Qdrant), graph store (FalkorDB), document store (MongoDB), and cache (Redis) independently via environment variables
- **Auto-collection creation** — Collections are created automatically on first use with sensible defaults; no manual setup required
- **Ollama/OpenAI embedding support** — Generate embeddings locally via Ollama or via the OpenAI-compatible API; configure with a single env variable
- **Smart compaction** — Intelligently compact memory collections by merging redundant entries while preserving semantic coverage
- **Memory decay** — Time-aware decay weighting that reduces the retrieval score of old, unaccessed memories to surface fresher context
- **Memory feedback** — Per-memory signal API allowing callers to mark recalled memories as useful or wrong for continuous quality improvement
- **Fleet synthesis** — Aggregate and reconcile knowledge across a distributed fleet of agents into a unified, deduplicated knowledge base
- **Memory lessons** — Auto-extract actionable lessons, anti-patterns, gotchas, and corrections from conversation history
- **Memory preferences** — Track and surface inferred user or agent preferences (tools, languages, styles, workflows) with confidence scores
- **Memory sequences** — Discover temporal sequences (after A, B typically follows within N hours) and expose them for planning and prediction
- **Memory patterns** — Surface topic clusters, co-occurrence patterns, and correlation matrices mined from the stored memory corpus
- **Memory timeline** — Retrieve memories filtered and sorted by time range for chronological context reconstruction
- **Memory blocks** — Named shared memory blocks (fleet-wide working memory) readable and writable by all agents in the fleet
- **Memory consolidation** — On-demand deep consolidation: finds contradictions, merges near-duplicates, promotes popular memories, and demotes stale ones
- **Memory dream** — Asynchronous background dream consolidation pass with a status/report endpoint to check progress
- **Anomaly detection** — Identify statistically unusual memory entries or patterns that deviate significantly from established knowledge
- **Correlation analysis** — Compute and store pairwise correlation between memory topics and entities to reveal hidden relationships

[1.0.0]: https://github.com/28naem-del/mnemosyne/releases/tag/v1.0.0
