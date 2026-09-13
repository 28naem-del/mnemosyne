# What the v2 candidates add, and what remains to prove

The experience runtime builds on the rc1 evidence kernel. These are implemented paths in the source candidate; npm and production website release are separate steps. [The executable guide](RUNTIME.md) and [evaluation evidence](EVALUATION.md) distinguish working behavior from performance hypotheses.

## rc7: a complete opt-in host loop

The [agent SDK](AGENT.md) puts recall before a host turn and durable capture/scheduling after it. Completed Codex and Claude SDK events can enter through explicit adapters. A finite background worker has aggregate call, byte, cycle and time limits; it starts only when requested. Durable turn reservations prevent automatic redispatch after ambiguous failures. Action bindings validate their complete declared memory dependencies immediately before the host callback.

[Adaptive context](CONTEXT.md) selects observations, hierarchical projections and original source excerpts within a declared budget. Exact UTF-8 source handles support expansion, and a bounded local cache stores selection metadata rather than copies of private source text. Full generation fingerprints include all supplied inputs, ancestor records, source-check state and successful/failed outcomes. Changing any of that evidence prevents an old summary from being silently certified as current. Existing legacy summaries without this proof fall back to their original sources.

These paths add automatic host lifecycle processing once integrated; they do not install application hooks, choose a paid model or change the behavior of every legacy recall endpoint. Model summarization is an explicit callback. Compression remains a heuristic and needs task-quality evaluation on the intended workload.

[Whole-database recovery](OPERATIONS.md) takes a consistent SQLite snapshot while WAL writes are active, verifies integrity and a manifest digest, and restores into a new path. It preserves all workspaces, pending work and erasure tombstones. This is a local operator capability, separate from scoped agent exports and production identity management.

[Structured profiles](PROFILES.md) bind a caller-defined field schema to supporting sources. Each field explicitly reports a supported value, unknown state or conflicting candidates. Schema validation happens before persistence, and reads recheck the complete source generation state. A changed or forgotten input makes the old profile unavailable. These are supplied model assertions with inspectable evidence, not automatic verification of a person's attributes.

## Capture and recover original evidence

Selected text files can be synchronized or watched. Generic, Codex and Claude JSONL parsers preserve visible message text and replay identities; Codex analysis channels and tool-directed messages are excluded. Original text remains available in bounded UTF-8 pages after an observation or source correction. A document changed from A to B and back to A gets a new current revision, while old derived advice stays invalidated.

This is explicit file and SDK integration. It does not discover every application's chat history, install host hooks, or capture conversations without a configured caller.

## Process experience with budgets

Durable observation/model jobs have leases, bounded attempts, call/input/output/time limits, stale-source rejection and inspectable results. A caller-selected proposer turns supplied sources into compact observations. Topic models can expose overview/detail tiers and source freshness; concurrent refreshes with unchanged evidence share one active generation.

This brings background memory processing into the same evidence lifecycle as direct storage. Running jobs remains an explicit controller action. There is no hidden scheduler, default paid provider or claim that every observation is useful merely because it passes structural validation.

## Reuse skills only after a trial

A candidate skill records steps, prerequisites, parameters and evidence dependencies. It stays out of ordinary context until the controller supplies a passed trial. Task traces distinguish retrieved memories from memories actually used, so merely appearing in retrieval does not earn positive feedback. Source changes and failed evidence suppress dependent advice.

The recorded demonstration executes two trial cases and a two-agent handoff. It establishes those integration behaviors. Trial callbacks are trusted controller assertions; they are not cryptographic proof, reinforcement learning, model-weight training or general intelligence.

## Retrieve words, meaning, time and relationships

The same SQLite store supports lexical retrieval and explicit embedding-based hybrid retrieval with optional reranking. Persisted vectors track model identity, dimensions and source hashes. Historical queries distinguish valid time from knowledge time. Explicit entities and aliases connect through evidence-backed relationships with bounded traversal.

The lexical query planner was repaired and measured at 100,000 synthetic records. Local vector retrieval is bounded and brute-force, not an ANN index. Entity resolution uses explicit aliases, not a learned coreference system. Historical record projection does not reconstruct every possible mutable field transition. Semantic quality still needs a selected model and a matched task evaluation.

## Stage changes and control access

Memory branches stage proposed additions/corrections outside ordinary context. Merge rechecks base evidence and applies changes atomically with replay receipts. The HTTP service binds each credential to a fixed scope, supports revocation and independent capture/recall/destructive controls, and serves a live inspector. MCP, CLI and Python expose narrower operations over the same store.

These branches are memory change sets, not distributed Git repositories or CRDT replication. HTTP defaults to loopback bearer authentication; remote TLS, user account management and enterprise identity integration are application work.

## Forget the source and its consequences

Forgetting captured evidence removes its live correction chain and dependent content. Hashed tombstones prevent the same transcript identity or document URI from being imported again by capture/watch after restart. Capture and recall can be disabled independently; disabling capture also blocks ordinary HTTP writes.

Erasure covers this live store. Existing exports, device snapshots and context already delivered to a model remain separate copies.

## Documents and adoption

Plain text, Markdown and JSON work directly. An explicit OpenAI-compatible vision adapter can extract text from selected PNG/JPEG/WebP images. Other binary documents require a caller-selected extractor. The repository now includes a live inspector, Python client, runtime guide, executable SDK example, and a second recorded website demo.

The [native Anthropic memory adapter](ANTHROPIC-MEMORY.md) maps six text commands to private virtual files, source revisions and forgetting. The [Responses and Gemini wrappers](PROVIDER-TOOLS.md) share a fresh generic namespace while preserving provider call identities and separate wire protocols. Their protocol examples run locally; no provider model session has been evaluated. Built-in PDF extraction and managed source connectors remain gaps.

The [migration service](MIGRATION.md) now supports eleven explicit profiles: the original Mem0, Letta blocks, legacy Mnemosyne/Qdrant and Markdown formats plus LangGraph store items, Graphiti edges, Hindsight memories and Supermemory documents. It previews supplied files without opening a destination database, retains exact selected record bytes, applies atomically, detects stable identity conflicts/replays and guards undo against later work. Privacy forgetting purges dependent live content and blocks the same source identity after restart. Foreign embeddings, graphs and policy semantics remain source data unless explicitly supported. It is a bounded offline export importer, not a universal account-archive parser or live synchronization service. Local snapshot compatibility remains documented [separately](MIGRATION-v2.md).

## Check facts that quietly become stale

The [freshness service](MAINTENANCE.md) persists explicit recheck policies and last-confirmed source evidence. A bounded caller-supplied probe can record confirmed, changed or unavailable results. Freshness-aware lexical recall checks watched ancestors; stale evidence stays out of that path without rewriting its text or trust. Host-bound action read sets validate exact local dependencies, check state and outcomes immediately before the host considers an action.

The host supplies source verification, scheduling and complete action dependencies. These checks do not authenticate factual truth, detect arbitrary implicit contradictions, or lock external actions. Existing generic recall/hybrid/MCP/HTTP operations are not automatically governed by the new service. The executable example uses a simulated clock and scripted source checks, with zero model calls.

## Research and evidence

The [provider research review](PROVIDER-MEMORY-RESEARCH.md) distinguishes consumer memory, developer memory services, prompt caching and model-architecture research. Public sources informed source recovery, selective consolidation, topic models, deletion and independent controls. Comparable features already exist elsewhere; assembling them does not establish novelty or superiority.

An offline [LongMemEval v1 retrieval adapter](LONGMEMEVAL.md) accepts caller-supplied batches and separates evidence-session metrics from answer quality. It does not download data or invoke a judge. A [public cleaned S baseline](evaluation/LONGMEMEVAL-S-BASELINE.md) covers 499 of 500 questions with explicit day-level compatibility and one oversized-turn exclusion; answer quality is unmeasured. The new [matched experiment harness](AGENT-EVALUATION.md) supplies isolated no-memory, recent-history, lexical and adaptive conditions under one reader with equal context/output budgets. It separates task correctness, evidence grounding, stale actions and negative transfer, and retains failed attempts in denominators. The harness and scripted fixtures are built; a frozen held-out model run, stronger summary baseline and actual competitor services are still needed to establish comparative performance. The current source candidate does not establish AGI or a public benchmark advantage.
