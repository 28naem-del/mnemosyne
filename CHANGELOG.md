# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Refresh the repository logo, sharing artwork and README; add a documentation index and task-oriented gallery for all 15 examples.
- Align architecture, historical context, skill policy, onboarding and deployment guides with the implemented release.
- Check local documentation paths and anchors in CI, with regression fixtures for broken images, renamed headings and illustrative code.
- Include branding and root guides in future packages, verify their presence, and include license notices in the runtime container.
- Update issue forms for current interfaces and private reporting; clarify the demo's optional semantic retrieval capability.

The published `v2.0.0-rc.8` tag and its download assets remain unchanged. These follow-up improvements are available on `main`.

## [2.0.0-rc.8] — source release candidate, 2026-09-13

### Added

- Gradual migration beside an explicitly supplied, read-only legacy search adapter. Used-record capture, stable origins, paired recall checks, shadow/assist/preferred routing, reconciliation and routing rollback complement full export migration.
- A corpus evaluation protocol separating original source data, questions and private grading labels, with all-500 LongMemEval support, caller-supplied LoCoMo and BEAM adapters, deterministic oversized-turn splitting, packed evidence scores, timing, failure accounting and implementation fingerprints.
- Explicit pinned local CPU embeddings and reranking, cached offline inference, process isolation and runtime dependency validation. Provisioning and third-party model licenses remain caller-visible.
- Persisted skill promotion requirements and `RECOMMENDED_SKILL_PROMOTION_POLICY`, requiring two distinct tasks and two verifier identities. Existing compatibility behavior remains one task and one verifier.
- An evidence lifecycle diagnostic reporting valid retention, obsolete exposure and citation identity separately, including known failing and unsupported cases.

### Changed and fixed

- Local lexical retrieval now defaults to scoped BM25. Explicit overlap remains available; the older evaluation protocol pins it to preserve historical comparisons.
- Semantic retrieval scans the full authorized indexed corpus with bounded retained candidates and a deadline, so older indexed evidence is not excluded merely by recency.
- Context compilation carries independent `asOf` and `knownAt` through SDK, HTTP, MCP and Python. Persisted correction causes improve historical and future-effective projection while retaining conservative handling of ambiguous legacy invalidations.
- Shared origin erasure prevents gradual and full imports from reviving each other's forgotten identities; agent context packets are rechecked before dispatch.
- Candidate versions and package exports include the new runtime and evaluation surfaces. Developer documentation now distinguishes source installation, optional providers, benchmark evidence and operational limits.

### Evidence and limits

- On the same 500-question LongMemEval S input, complete annotated-session retrieval at 20 chunks improves from 386/470 to 425/470; after identical 8,192-byte packing, from 367/470 to 382/470. The 30 abstentions remain in attempt counts. Same-day timestamp compatibility, full-context overflows, and the absence of generated-answer scoring are disclosed in the [report](docs/evaluation/BENCHMARKS.md).
- Gradual migration never writes the original store and continues reconciliation; observed coverage does not establish whole-store migration or answer quality. Local semantic search remains exact scanning, not ANN.
- Unrelated source-field changes can still retire valid guidance. Encryption, enterprise identity, bidirectional synchronization and six validated native framework integrations remain open. See [release status](docs/UPGRADE-STATUS.md).
- This entry describes a source candidate. It does not assert npm or PyPI publication.

## [2.0.0-rc.7] — source release candidate, 2026-09-13

- Added the opt-in `MemoryAgent` host loop, explicit event adapters, durable turn reservations, finite observation workers and action bindings that recheck declared dependencies before host dispatch.
- Added adaptive context with source expansion, hierarchical projections, complete generation fingerprints and invalidation of stale cached selection plans.
- Added typed, source-backed profiles with supported/unknown/conflict fields and generation revalidation.
- Added whole-database backup, integrity verification and restore into a new path, including durable jobs and erasure guards. Backups are plaintext and contain all scopes.
- Added a matched agent experiment harness with isolated no-memory, recent-history, lexical and adaptive conditions; scripted fixtures do not establish model task improvement.

## [2.0.0-rc.6] — source release candidate, 2026-09-13

- Expanded explicit export migration from seven to eleven profiles, adding supported store-item, temporal-edge, memory-record and document-export shapes. Exact accepted formats remain in the [migration guide](docs/MIGRATION.md#supported-shapes).
- Preserved private/untrusted import defaults, exact original record bytes, stable source identities, atomic application, guarded undo and durable erasure replay protection.

## [2.0.0-rc.5] — source release candidate, 2026-09-13

- Added offline export migration for seven explicit Mem0, Letta-block, legacy Mnemosyne/Qdrant and Markdown profiles, with exact UTF-8 record spans, owner selection, completeness and byte-accounting reports.
- Added reviewed-plan CLI/SDK application, private untrusted defaults, stable replay identities, destination conflict inspection, paged originals, guarded atomic undo and source forgetting with durable replay tombstones.
- Added a kernel rollback guard that protects changed records, later dependents and outcomes, plus indexes for bounded rollback checks.
- Added explicit source freshness policies, persisted check evidence, bounded asynchronous probes and freshness-aware lexical recall. Age alone does not alter assertions or trust.
- Added short-lived, action-bound local dependency read sets with expiry, evidence/outcome revalidation and per-instance signature checks. These do not authorize or lock external actions.
- Added `/migration` and `/maintenance` package entry points, `migrate` and `health` commands, two executable temporary-database examples and dedicated guides. Existing local snapshot import remains separate.

## [2.0.0-rc.4] — source release candidate, 2026-09-13

### Added

- OpenAI Responses and Gemini Generate Content function-tool wrappers for the six virtual memory commands, with provider-specific schemas, bounded argument validation, correlated errors and protocol-separated retry identities.
- A public neutral command executor and immutable generic capture mode. A fresh generic namespace can serve OpenAI, Gemini and Claude without falsely labeling another provider's notes as Claude output; existing Claude namespaces preserve their identities and reject opposite-mode reuse.
- A deterministic protocol example that shares a note across three interfaces, preserves original Responses/Gemini history and signature sentinels, collects correlated failures, and handles a final reply without calls. CI runs the example from the source checkout.

### Limits

- Wrappers handle individual completed calls. The host owns streaming assembly, candidate selection, complete conversation history, API requests and bounded model loops. Gemini Interactions and OpenAI Chat Completions are separate protocols.
- No live provider/model session was used. These are locally verified protocol adapters, not consumer-memory imports or proof of model performance. [Integration guide](docs/PROVIDER-TOOLS.md).

## [2.0.0-rc.3] — source release candidate, 2026-09-13

### Added

- A native Anthropic `memory_20250818` text adapter over scoped SQLite: six virtual file commands, strict paths, host policy, source revisions, dependent-memory invalidation, deletion and durable retry receipts. The `/adapters` export supports a manual Messages loop and a structural SDK runnable without a mandatory Anthropic dependency.
- An executable local native-command example and package/CI checks. No Claude API session or production integration is implied.
- A public cleaned LongMemEval S retrieval baseline covering 499/500 cases, with a verified source checksum, exact exclusion manifest, raw per-case results and independent score recomputation. Complete evidence coverage was 406/499 at 20 retrieved turns; answer quality remains unevaluated.

### Fixed

- Added explicit `question-day` timestamp compatibility for supplied evaluation histories while retaining strict-instant validation by default. Reports preserve source dates and disclose every effective cutoff and affected-session count.

### Limits

- Native files are text only, private, create-exclusive and untrusted by default. Empty directories are implicit; editing after an adapter restart requires a new view. Deletion requires explicit host permission.
- Evaluation uses day-level compatibility and excludes one oversized turn before scoring. Its retrieval metrics are not published answer scores or evidence of AGI. [Raw evaluation and limitations](docs/evaluation/LONGMEMEVAL-S-BASELINE.md).

## [2.0.0-rc.2] — source release candidate, 2026-09-13

### Added

- Exact supplied transcript capture for generic, Codex and Claude visible-message JSONL, bounded original-source pages, and explicit document/image extraction callbacks.
- A regular-file connector with explicit foreground watching, stable transcript retry identities, partial-final-row handling, and replay-blocking source tombstones.
- Durable observation and model jobs with leases, retries, bounded calls/bytes/time, source revalidation before commit, and source-backed model freshness checks.
- Typed skill candidates, controller-supplied trial evidence or verifier callbacks, outcome-gated promotion/retirement, and retrieval/use traces. Generated content remains fallible evidence.
- Incremental SQLite embedding indexes and hybrid recall through explicitly configured providers; model/revision/dimension checks, cancellation and response bounds.
- Validity/knowledge-time queries, scoped pagination, atomic controller operations, entity aliases and evidence-linked traversal, and isolated branch staging with atomic merges.
- An authenticated loopback HTTP service and live inspector, dependency-free Python client, additional CLI/MCP runtime interfaces, and explicit OpenAI-compatible provider adapters.
- A deterministic 13-check capture-to-skill-to-shared-lesson demonstration, transport/runtime regression tests, Python CI, and installed-package checks for the new exports.

### Fixed

- Runtime provenance and persisted envelope validation, duplicate/no-progress proposals, source changes during asynchronous work, and replay after source forgetting.
- Stale skill/model visibility after evidence correction or failed outcomes, untrusted branch result handling, cross-owner receipt shadowing, merge rollback, and forgotten-result replay.
- HTTP token/scope enforcement, revocation during delayed requests, response bounds, controller-state mutation restrictions, and inspector state across reconnects.
- Python redirect handling, malformed responses, timeout errors, and input/response byte limits.

### Limits

- Providers, job execution, trial verification and workspace publication are explicit controller responsibilities. There is no installed scheduler, automatic model download, cloud synchronization or model-weight training.
- The learning demonstration uses scripted fixtures and real local APIs. It does not establish general task improvement, AGI, or superiority over other memory systems.
- This changelog describes the source candidate, not a published npm/PyPI release or production deployment. See [runtime contracts](docs/RUNTIME.md) and [evaluation limits](docs/EVALUATION.md).

### Evaluation and measured implementation changes

- Added an offline LongMemEval v1 retrieval adapter and CLI with isolated baselines, evidence-session metrics, label-leakage guards, reproducible tie-breaking, raw-file fingerprints and bounded optional embeddings. Answer quality remains unevaluated.
- Repaired a SQLite planner regression using grouped term postings. The synthetic 100,000-record exact-ID p95 measured 0.332 ms and broad-query p95 411.906 ms; these are local workload observations, not guarantees.
- Reduced new posting-table storage with `WITHOUT ROWID` while preserving existing table layouts and durability defaults. Added measured write-cost and batching tradeoffs to the evaluation report.

## [2.0.0-rc.1] — source release candidate, 2026-09-12

### Added

- Embedded SQLite memory with source provenance, owner/workspace visibility, correction cascades, keyed conflicts, typed checkpoints, controller outcomes, and bounded context compilation.
- Portable owner snapshots with atomic restore, retry identity, consistent size limits, and explicit cross-agent provenance omissions.
- Real CLI and MCP stdio interfaces, bounded tool responses, and launch-time capability controls.
- Optional single-pass reflection with caller-selected providers, source/outcome revision checks, independent controller validation, and no automatic memory writes.
- Executable 14-check handoff/correction demo, synthetic retrieval probe, source-linked research, and a responsive static site candidate with inspectable recorded evidence.

### Fixed

- RRF score dilution (#21), keyword-only hydration, and awaited paginated BM25 startup with configurable coverage diagnostics (#22).
- Scoped erasure, graph hydration, cross-instance cache revalidation, immutable collection configuration, backend credentials/timeouts, and embedding dimension checks.
- Private high-priority broadcast content leaking onto the shared critical channel.
- Snapshot idempotency/size mismatches, conflicting handoff state, stale reflection proposals, and valid context being crowded out by failed evidence.
- Broken backend examples, unsupported documentation claims, outdated runtime requirements, dependency update backlog, and nonexistent Dependabot labels.

### Changed

- Node >=22.16 required; CI covers Node 22.16/24 and the installed package.
- Explicit IDs required for erasure. Unsafe historical URL-only destructive maintenance helpers fail closed; scoped nondestructive replacements are available.
- Prerelease publication uses the next tag and verifies release identity. No npm release or production website deployment is implied by this source changelog.

Read [migration](docs/MIGRATION-v2.md), [issue disposition](docs/ISSUE-AUDIT-2026-09-12.md), and [evaluation limits](docs/EVALUATION.md).

## Historical release notes

The entries below preserve earlier release descriptions. Their terminology is historical; current behavior and limitations are described in the maintained contracts above.

## [1.0.1] — 2026-02-24

### Security

- **Docker Compose hardened** — All service ports now bind to `127.0.0.1` instead of `0.0.0.0`, preventing accidental public exposure of Qdrant, Redis, FalkorDB, and MongoDB on cloud deployments
- **CI security audit enforced** — Replaced permissive `npm audit || true` with strict `npm audit --omit=dev --audit-level=high` in both CI and publish workflows; builds now fail on high/critical vulnerabilities
- **Dependency scripts disabled in CI** — Added `--ignore-scripts` to `npm ci` in CI workflow to prevent supply-chain attacks via malicious postinstall scripts
- **Dependabot enabled** — Automated weekly dependency updates for both npm packages and GitHub Actions, with separate labels for triage

## [1.0.0] — 2026-02-23

### Added

- **Vector memory store/recall/forget** — Store, retrieve, and delete memories using dense vector embeddings via Qdrant for semantic search
- **BM25 hybrid search** — Combine sparse BM25 keyword matching with dense vector search for combined lexical and semantic retrieval
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

[1.0.1]: https://github.com/28naem-del/mnemosyne/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/28naem-del/mnemosyne/releases/tag/v1.0.0
