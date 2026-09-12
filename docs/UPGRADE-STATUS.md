# What the v2 candidates add, and what remains to prove

The experience runtime builds on the rc1 evidence kernel. These are implemented paths in the source candidate; npm and production website release are separate steps. [The executable guide](RUNTIME.md) and [evaluation evidence](EVALUATION.md) distinguish working behavior from performance hypotheses.

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

The [native Anthropic memory adapter](ANTHROPIC-MEMORY.md) now maps six text commands to private virtual files, source revisions and forgetting. The [Responses and Gemini wrappers](PROVIDER-TOOLS.md) share a fresh generic namespace while preserving provider call identities and separate wire protocols. Their protocol examples run locally; no provider model session has been evaluated. Built-in PDF extraction, managed source connectors and cross-system migration remain distinct gaps. The earlier [v2 migration notes](MIGRATION-v2.md) describe compatibility and local snapshots; they do not yet claim a complete importer for other products.

## Research and evidence

The [provider research review](PROVIDER-MEMORY-RESEARCH.md) distinguishes consumer memory, developer memory services, prompt caching and model-architecture research. Public sources informed source recovery, selective consolidation, topic models, deletion and independent controls. Comparable features already exist elsewhere; assembling them does not establish novelty or superiority.

An offline [LongMemEval v1 retrieval adapter](LONGMEMEVAL.md) now accepts caller-supplied batches and separates evidence-session metrics from answer quality. It does not download data or invoke a judge. A [public cleaned S baseline](evaluation/LONGMEMEVAL-S-BASELINE.md) now covers 499 of 500 questions with explicit day-level compatibility and one oversized-turn exclusion; answer quality is unmeasured. The next evidence step is matched task evaluation: no-memory and strong baseline comparisons, separate retrieval and answer scoring, held-out tasks, temporal corrections, negative transfer, privacy and cost. The current source candidate does not establish AGI or a public benchmark advantage.
