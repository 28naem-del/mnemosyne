# Features and boundaries

Mnemosyne combines persistent evidence, current context and explicit controller feedback. This is the feature map for the **2.0.0-rc.8 source release**. Start with the [quickstart](quickstart.md) or choose a task in the [documentation index](README.md).

## Persistent local evidence

The SQLite engine stores source records, corrections, dependencies, task checkpoints, outcomes and retry identities. Records are private by default; workspace sharing is explicit. An explicit correction supersedes a source and invalidates declared descendants. Conflicting active texts with the same fact key remain visible as a conflict. Arbitrary language contradictions and missing dependencies are not inferred automatically.

WAL, transactions, prepared statements, input limits and scoped selectors support local use. Those selectors are supplied by trusted host code; they do not authenticate a process that can read the file. Database contents are plaintext.

## Retrieval that carries its history

Lexical recall defaults to scoped BM25 over term postings, with the earlier overlap scorer available explicitly. Optional hybrid recall combines independent lexical and stored-vector candidates, then optionally reranks them. Embeddings can run through an explicitly configured endpoint or [local CPU providers](LOCAL-MODELS.md). The normal install downloads no model weights and makes no model calls.

Recall and compilation accept `asOf` and `knownAt`, separating a fact's validity from the system's knowledge cutoff. Current queries exclude obsolete evidence; historical packets mark their clocks explicitly. Dense retrieval scans scoped stored vectors rather than using an approximate-nearest-neighbor service. Indexing, model choice and workload sizing remain host responsibilities.

## Budgeted and expandable context

`compile` returns a rendered evidence envelope with citations, exclusions and uncertainty. Only `packet.text` is within the configured prompt budget; raw records and diagnostic fields are separate. The default counter uses UTF-8 bytes, and applications can supply their model's tokenizer. Compilation withholds unsafe recommendations and preserves an explicit conflict as a group rather than choosing a winner to fit a budget.

[Adaptive context](CONTEXT.md) adds source-backed summaries, hierarchical compaction, exact original-source expansion and state-checked reuse. Repeated retrieval does not confirm a source. Provenance checks prevent stale representations from remaining eligible; they cannot certify that generated summaries are semantically correct.

## Capture, models and tested procedures

[MemoryRuntime](RUNTIME.md) captures visible messages or explicitly supplied documents, preserving source identity and original bytes within documented bounds. A bounded host-run worker processes durable observation/model jobs. Sources are checked at provider dispatch and before commit. No scheduler, transcript discovery or application hook installs itself.

Skills begin as non-advisory candidates. `RECOMMENDED_SKILL_PROMOTION_POLICY` requires successful trials spanning at least **two task IDs and two verifier IDs**; the policy persists with the skill. The compatibility default remains one task/one verifier. Reopening with a weaker default cannot weaken an existing candidate's requirements. Controller IDs and success flags are assertions, so the host must execute authentic independent checks. Failed prerequisites, trials or changed evidence can retire a skill. This is reusable external knowledge, not training model weights.

[MemoryAgent](AGENT.md) joins context before a turn with capture afterward. Task checkpoints preserve goals, decisions and next steps; declared evidence dependencies allow obsolete handoffs to retire. Traces associate retrieved and used memories with controller-observed outcomes.

## Freshness and action checks

[Maintenance](MAINTENANCE.md) uses explicit source policies and last-confirmed evidence to flag aging or changed facts. A bounded host-driven check can confirm, challenge or replace evidence. It does not guess a new truth merely because a fact aged. Applications choose and run their verifiers; ordinary recall does not automatically fetch documents or refresh timestamps.

Action read sets bind the proposed action, arguments and declared supporting memories. Validation can reject a corrected, forgotten, stale or failed dependency immediately before host dispatch. This local check is not external action authorization or a distributed transaction; it depends on the host declaring all relevant evidence.

## Adoption, tools and recovery

- [Gradual migration](BRIDGE.md) keeps the old system connected through a read-only search adapter. Mnemosyne stages encountered records and can supply more context as paired-query coverage grows. Adoption is not proof of complete-store migration or answer quality.
- [Full migration](MIGRATION.md) supports eleven explicit export profiles with preview, source inspection, completeness reports, atomic apply, retry recognition and guarded undo. Imports are private and untrusted by default; unsupported foreign policies and embeddings are not silently converted.
- [MCP and HTTP](deployment.md) expose scoped interfaces. HTTP uses bearer authentication and configured capabilities; the Python client accesses the same service. [Provider tool adapters](PROVIDER-TOOLS.md) support explicit native envelopes without selecting a model or discovering credentials.
- [Profiles](PROFILES.md) retain typed known, unknown and conflicting fields. [Relations and branches](RUNTIME.md#time-entities-and-branches) support evidence-backed traversal and reviewed staged changes.
- [Recovery](OPERATIONS.md) creates consistent whole-database backup bundles, verifies integrity and restores to a new path. Bundles include all owners and are plaintext. A digest is not an authenticity signature.

The `createMnemosyne` compatibility API retains its separately configured vector, graph and broadcast integrations. It does not automatically gain every local lifecycle behavior; follow the [existing-installation migration guide](MIGRATION-v2.md).

## Published measurements and pending validation

The [paired LongMemEval report](evaluation/BENCHMARKS.md) attempted all **500 questions**, with **470 positive evidence labels**. At K=20, BM25 retrieved all annotated evidence groups for 425/470 questions (**90.43%**) before packing, compared with overlap's 386/470 (**82.13%**). After an **8,192 UTF-8-byte context budget**, the same all-evidence statistic was 382/470 (**81.28%**) versus 367/470 (**78.09%**).

These are retrieval-coverage results, not generated-answer accuracy. A hit may be any chunk in an annotated session, which need not contain the answer-bearing passage. All complete-history controls overflowed that budget and contributed zero packed evidence. The question-day compatibility policy includes 1,475 sessions occurring after the stated question instant. Thirty abstention questions remain in attempt counts but are excluded from positive-evidence denominators. The pinned report records those limits, code/data fingerprints and timing; it used no embedding, generation or judge calls.

[Lifecycle diagnostics](evaluation/EVIDENCE-PROTOCOL.md) are a separate synthetic protocol. The checked-in candidate passes 15 of 16 cases; one conservative invalidation still retires a valid rule after an unrelated field edit. Alternative sufficient supports and general semantic entailment need more work. Neither these fixtures nor retrieval coverage prove zero stale actions in real deployments.

The [agent evaluation harness](AGENT-EVALUATION.md) supports matched reader experiments, but public generated-answer quality, held-out general task improvement and a matched competitor comparison remain unmeasured. Automatic cloud synchronization, enterprise identity and universal live-framework compatibility are also outside this release.
