# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] — stable release, 2026-10-27

The 2.0.0-rc.10 candidate promoted to stable **with no source change**: the tree is the rc.10 tree
plus the version strings, the install and MCP snippets, the site and release metadata, this entry
and one dependency security patch. npm `latest` now points at 2.0.0 (it was 1.0.1); the 1.x line
stays installable as `mnemosy-ai@1`.

### Security

- **`zod` 4.6.2 → 4.6.7** (range `^4.6.7`) for [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5),
  "Zod can exhaust memory while validating oversized constrained collections" (high, published
  2026-10-01, patched in 4.6.6). `zod` validates the MCP tool arguments in this package. No
  behaviour change was observed: the full suite (78 files, 1,505 tests, 38 environment-gated)
  passes unchanged on the patched tree.

**Upgrading from 1.x is a breaking change.** Read [docs/MIGRATION-v2.md](docs/MIGRATION-v2.md)
before moving an existing Vector Engine application: version 2 corrects retrieval scoring, awaits
paginated startup indexing, disables query-based forgetting, requires Node.js >= 22.16 and ships as
ESM. A `^1` dependency range keeps resolving to 1.x; a fresh unpinned `npm install mnemosy-ai`
now installs 2.0.0. No existing database is migrated or deleted.

**Two Tier 1 exit gates remain unmet and ship disclosed, unchanged from rc.10:**

- **T1.2 recall latency at one million records** — target p95 under 50 ms; measured p95 139.4,
  146.9 and 223.3 ms for hybrid `recall()` through the opt-in `indexMode: 'hnsw'` on a synthetic
  1M-record fixture, three fresh processes of 300 queries each. Commands and outputs are in
  `reports/t1-targets/`.
- **T1.3 contextual reranking** — gate 72.80% all-evidence hit on LoCoMo (1,531 annotated
  questions); shipped at 71.98%, 0.82 points (13 questions) short. The best variant tried was still
  four questions short and was not merged.

The measured results are the rc.10 results: LongMemEval-S answer accuracy 409/500 (81.8%, Wilson 95%
CI 78.2–84.9) by an LLM judge, LoCoMo reranker gain MRR@10 +0.163, and the matched Mem0 OSS run with
every loss published in [COMPARISON.md](COMPARISON.md). The T1.4 temporal-routing gate passes by
0.28 points in-sample and is described as fragile where the feature is listed under rc.10 below.
Everything else about this version is described in the rc.10 entry.

## [2.0.0-rc.10] — Tier 1 retrieval, 2026-10-21

Tier 1 retrieval reconciled onto the published RC9 packaging and released on the `next` channel;
`latest` stays on 1.0.1. Two of the Tier 1 exit gates are not met and are stated where the feature
is described below (T1.2 recall latency at one million records, T1.3 contextual reranking). Every
commit referenced below is on `main` and can be read with `git show <sha>`.

### Added

- **Opt-in dense index (`indexMode`).** `'exact' | 'auto' | 'sqlite-vec' | 'hnsw'`, defaulting to
  `$MNEMOSYNE_INDEX_MODE` else `'auto'`. `auto` uses `sqlite-vec` when the extension loads and
  otherwise falls back to the exact scan — still exact, just scored in C. `hnsw` is approximate and
  sublinear, is the only retrieval component that can miss a true neighbour, and is **never selected
  on your behalf**; asking for `sqlite-vec` or `hnsw` and not getting it throws rather than silently
  degrading. No mode changes what a record scores or whether it may be returned: every candidate an
  index proposes is re-authorized and rescored against the stored vector, so an index is a shortlist
  and never an authority. `c8f994c`, `0f244e5`, `7730916`, `ab60b9a`, `ef8458f`, `745c299`,
  `2dcdf7a`. **Its Tier 1 exit target, p95 recall latency under 50 ms at 1,000,000 records, is not
  met.** Hybrid `recall()` on a synthetic 1M-record `hnsw` fixture store (each query pays a real ONNX
  embedding pass, the search runs on the fixture's vectors; reranker off, ledger on) measured p95
  139.4, 146.9 and 223.3 ms in three fresh processes of 300 queries each, host load average 2–3.
  Commands and outputs are in `reports/t1-targets/`.
- **`sqliteVecPath`** — an explicit path to a `sqlite-vec` loadable extension, with deliberately no
  environment-variable equivalent, so a machine-wide variable can no longer decide what every
  `LocalMemory` on the host `dlopen`s. `a5b9db7`.
- **`cacheSize`** — passes through to `PRAGMA cache_size` (negative = KiB, positive = pages);
  default `-65536`, i.e. 64 MiB. `7034027`, with peak-RSS-at-1M-records measurements in `209184e`.
- **`hnswlib-node` pinned to exactly `3.0.0`** and `sqlite-vec` to `^0.1.9`, both as
  `optionalDependencies` so neither is required to install. `ca98458`.
- **Opt-in temporal routing** on `recall` and context compilation: a retrieval query's absolute and
  relative dates are parsed and can set an `asOf`, behind an explicit switch and a minimum parser
  confidence. A query-parsed clock can never reach past the present. `691c957`, `37374f0`,
  `9b08819`, `450360d`; the benchmark reports the temporal-reasoning subset separately in `b834028`. The same switch now
  also applies a when-intent prior (`a82d500`): when a query asks *when* something happened but
  carries no date the router can use, candidates whose own text carries a parseable date are promoted
  within a fixed depth. On the full LoCoMo set (1,531 annotated questions) the date window alone gains
  **+2.45 pts** recall@10 on the temporal category (79.92 → 82.37), **short of its +3.0 gate**; with
  the prior the gain is **+3.28** (79.92 → 83.20) and overall recall@10 rises 73.57 → 75.34, which
  meets the gate by 0.28 pts — less than one question, since each of the 320 temporal questions is
  worth 0.31. Against the date window alone the prior wins 10 temporal questions and loses 7, which is
  not a significant difference; on conversations 0–4 alone the prior gains only +2.24. Its pattern
  was designed by reading that same category, so the pass is in-sample and fragile; no out-of-sample
  check has been run. The LoCoMo benchmark now checks the gate's overall-floor half too (`9eda585`).
- **Cross-encoder reranking** of the fused candidate set, with a bundled int8 ONNX embedder that
  runs synchronously and offline. `72dcb20`, `ebb48ed`, `6503021`.
- **Contextual reranking (T1.3)** — a candidate is scored with its in-session neighbours rather
  than alone, bounded by `--rerank-context-top-n`. **This merged with its `g3` gate not met: the
  measured result is short of the gate by 0.82.** `a6bfb14`, `a6e98eb`, `2b948e4`, `b286fb4`.
- **Full-candidate provenance and outcome ledger** — the ledger records the complete retrieval
  candidate set rather than only what was returned. `1b146d7`, `a40e470`.
- **A matched competitor benchmark.** Competitor systems are scored as conditions inside our own
  `runCorpusBenchmark` loop — one process, one chunk set, one K, one packing budget, one evidence
  scorer — rather than having their published numbers quoted. Results, including every condition
  where Mem0 OSS beats us, are in [COMPARISON.md](COMPARISON.md). `cf031cf`, `868c8a8`, `79afea3`,
  `aec71e8`; Mem0's paid `infer:true` extraction path measured separately in `e7c572b`, and the
  full-corpus projection made to reproduce from its own inputs in `e94a261`.

### Changed

- **BREAKING — hybrid dense+BM25 RRF retrieval is now the default.** `retrieval: 'lexical'` selects
  the previous behaviour. `c155431`; the default benchmark moved to LoCoMo recall@10 in `9750914`.
- **BREAKING — dense vectors are stored as a packed float32 BLOB instead of JSON float64**, and
  `PRAGMA user_version` moves 1 → 2 so an older build refuses the file instead of misreading it.
  Existing databases migrate on open and need no rewrite; `#decodeVector` reads both shapes.
  **This is a real behaviour change, not only a storage one:** float32 rounding can reorder
  near-ties, measured at 7 of 400 top-10 identity mismatches on a deliberately tie-dense synthetic
  corpus, on both `recall()` and `recallHybrid()`. Measured effect on the LoCoMo and LongMemEval-S
  runs: **zero**. `2a9f00c`.
- BM25 corpus statistics are cached instead of rescanned on every recall, with guards for a reader
  clock that steps backwards across a temporal bound. `a8b3c77`, `e2db2e0`, `fc3d5b7`, `9645cd5`,
  `418b99b`, `28ba5b6`, `716dc2f`, `a8ffc58`, `e27763c`.
- The LongMemEval dense channel is bounded to a recent window, matching `LongMemEvalOptions`'
  documented intent instead of silently covering full history. `0c296c8`, `48433a4`.
- The MCP `memory_context` tool passes `asOf`, `knownAt` and `lexicalScoring` through. `478c715`.
- Documentation corrections from the release audit: the docs no longer deny the ANN index this
  release ships or the matched competitor run it carries, the matched run's compression figure is
  computed by its generator rather than hardcoded, and the npm keyword claiming the system
  improves itself — a v1 leftover asserting an unbuilt capability — is removed. `ad14cf5`,
  `5cf631c`, `bfb1595`, `f3f9b35`, `811dc00`.
- **`get()` and the outcome lookup reuse prepared statements** instead of re-preparing per call;
  results are unchanged (differential over 60 queries, identical scores and outcomes). `e5d9acc`.
- **The benchmark reader adapter** (`createCompatibleBenchmarkReader`) accepts a reply whose JSON
  object is followed by prose, takes named prompt versions (`promptVersion`; the default is
  byte-identical to before) and forwards an optional `asOf`. `fac8771`, `de2af6b`, `fc92973`. With
  prompt `v4_stacked`, `asOf` and weekday-formatted dates, and the top-20 reranked hits packed to
  16 KB, `anthropic/claude-sonnet-4.6` answers **409 of LongMemEval-S's 500 questions correctly
  (81.8%, 95% CI 78.2–84.9)** by the `anthropic/claude-haiku-4.5` judge, against 71.2% for the
  default prompt at 8 KB on a 250-question sample; exact match is 7.6%. The prompt and budget were
  chosen on 100 of the 500 questions; the other 400 score 82.3%. This is a separate driver
  (`reports/t1.7-accuracy/`), not the LongMemEval runner, which still leaves answer quality
  unevaluated.

### Fixed

- **A second connection's BM25 statistics could go stale-low and silently drop every result.** A
  reader whose first live BM25 recall happened before another connection's writes kept the corpus
  size it saw at that first read, so `recall()` returned 0 rows where 6 were true and `compile()`
  lost its citations on the default hybrid path. The live clock is now re-seeded whenever
  `PRAGMA data_version` moves. `368bb95` (regression tests, red before the fix), `be393dc`.

## [2.0.0-rc.9] — packaging and release documentation, 2026-09-13

This candidate packages the tested RC8 memory engine with the repository and contact corrections below. It adds no new engine capabilities or benchmark claims. npm publication is a separate release step; Python package metadata follows this version without asserting PyPI publication.

- Refresh the repository logo, sharing artwork and README; add a documentation index and task-oriented gallery for all 15 examples.
- Align architecture, historical context, skill policy, onboarding and deployment guides with the implemented release.
- Check local documentation paths and anchors in CI, with regression fixtures for broken images, renamed headings and illustrative code.
- Include branding and root guides in future packages, verify their presence, and include license notices in the runtime container.
- Update issue forms for current interfaces and private reporting; clarify the demo's optional semantic retrieval capability.
- Correct current support, security and partnership contacts to `28naem@gmail.com`; check public identity, support links and release status consistently in CI.
- Direct website setup links to runnable instructions and correct the published evidence status while preserving recorded measurements.
- Require documentation and public metadata checks before npm packaging, validate trusted-publishing CLI compatibility, and publish the exact verified tarball with provenance.

The published `v2.0.0-rc.8` tag and its download assets remain unchanged; its release notes flag the obsolete contact address in those immutable downloads.

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
