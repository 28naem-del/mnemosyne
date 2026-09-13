# Choose a memory path

Mnemosyne offers several ways to add persistent evidence to an agent. Choose by the control and integration your application needs. This page compares implemented paths and their tradeoffs; it is not a ranking against another product.

## Capability overview

| Path | Best fit | What it provides | What you supply |
|---|---|---|---|
| Local memory | A keyless starting point or an embedded application | SQLite persistence, scoped BM25, corrections, dependencies, history and budgeted context. | A trusted host identity, writable local storage and the agent's model loop. |
| Local hybrid retrieval | Queries that need semantic matching as well as words | Independent lexical/dense candidates, rank fusion and optional reranking with source-state checks. | An explicit embedding provider, indexing and optional reranker; CPU models require deliberate provisioning. |
| Runtime and agent lifecycle | An existing agent that should retain visible work and reuse tested procedures | Capture, durable bounded jobs, source-backed models, trial-gated skills and before/after-turn integration. | Proposal callbacks, actual task verifiers, scheduling and action authorization. |
| MCP or authenticated HTTP | A client that needs a process or language boundary | Scoped tools; HTTP adds bearer principals, capability checks and a browser inspector. | Client configuration and secure token handling; remote hosting needs its own TLS and identity deployment. |
| Gradual migration | Keep the current memory system while adopting a new one | Read-only legacy search, private source staging, paired-query adoption and fallback. | An owner-scoped adapter with stable record IDs/revisions. Legacy search stays connected. |
| Full export migration | A deliberate bulk transfer | Eleven profiles, source-byte preview, completeness checks, atomic apply and guarded undo. | A supported export and an explicit source-owner/destination mapping. Unsupported semantics need review. |
| Compatibility service API | Maintain an existing `createMnemosyne` application | The existing vector-backed API and explicitly configured graph/broadcast modules. | The original services and embedding endpoint; local runtime semantics are separate. |

See [examples](../examples/README.md) for a runnable path and [integration coverage](README.md#integration-coverage) for what has actually been checked. An adapter contract or export parser is not a promise that every external framework, account API or SDK version works without integration work.

## Compare on the workload you care about

For retrieval, use the same corpus, questions, ownership rules, temporal cutoff, candidate count, tokenizer and context budget. Report evidence coverage both before and after packing, plus exclusions, overflows, provider cost and latency. A matching session ID can still miss the answer-bearing passage.

For agent quality, hold the model, task input, reader instructions and judge protocol constant. Include no-memory and complete-history controls, updates, erasure, abstention and stale-answer checks. The [agent harness](AGENT-EVALUATION.md) accepts real reader callbacks, while the [corpus protocol](evaluation/CORPUS_PROTOCOL.md) keeps raw evidence, questions and private labels separate.

The checked-in [LongMemEval retrieval run](evaluation/BENCHMARKS.md) compares Mnemosyne scoring conditions. It does not measure competing systems, generated-answer accuracy or universal task improvement. Public results from another system can use a different dataset split, model, context budget or product edition; they are not automatically comparable.

## Deployment tradeoffs

The local path keeps lifecycle state inspectable in one database and needs no remote service for lexical recall. Its synchronous scans and explicit model setup trade managed convenience for application control. The HTTP interface has authentication, but it is not a managed cloud account system. Databases and backups are plaintext unless your storage layer protects them.

If you require automatic multi-device sync, enterprise single sign-on, distributed storage or fully packaged framework plugins, budget for additional integration and deployment work. Read [features and boundaries](features.md), [operations](OPERATIONS.md) and [security](../SECURITY.md) before selecting the path for production.
