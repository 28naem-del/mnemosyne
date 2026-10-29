# Release status: 2.0.0 (stable) and 3.0.0-rc.3 (pre-release)

**Newest pre-release: 3.0.0-rc.3** (29 October 2026, npm `next`; install with `npm install mnemosy-ai@next` or pin `mnemosy-ai@3.0.0-rc.3`). It carries the fixes, security changes and wider `ioredis` peer range listed in the [changelog](../CHANGELOG.md) on top of 3.0.0-rc.2 (28 October 2026), the first 3.0 release on npm. It is a breaking release: the legacy vector engine moves out of `mnemosy-ai` into `mnemosy-ai-legacy`, which is not on npm yet, so build it from a checkout or stay on `mnemosy-ai@2` ([version 3 migration](MIGRATION-v3.md)). It adds opt-in precision controls with native abstention, an outcome-gated and reversible consolidation gate, inferred dependencies and the five-moment `mnemosy demo`; the default retrieval path is unchanged. The measured results (taken on 3.0.0-rc.2), each with its protocol, and its known limits (including recall latency, measured only on a loaded machine) are in the [changelog](../CHANGELOG.md) and [Benchmarks and trust evidence](BENCHMARKS-TRUST.md). The rest of this page describes 2.0.0, which 3.0 builds on.

Mnemosyne 2.0.0 is the stable release of the version 2 line: the 2.0.0-rc.10 candidate promoted on 27 October 2026 with no source change (one dependency security patch, noted in the changelog). The [README quickstart](../README.md#start-with-a-working-demonstration) covers npm installation and building the matching source tag. Its npm channel is `latest`; the 1.x line stays installable as `mnemosy-ai@1`, and upgrading from it is a breaking change (see [version migration](MIGRATION-v2.md)). The release carries the Tier 1 retrieval work over the RC9 packaging; its measured results and the two release targets that are not met (recall latency at one million records, contextual reranking) are stated in the [changelog](../CHANGELOG.md). It does not publish the Python client to PyPI.

## Implemented in 2.0.0

| Area | Available behavior | Important boundary |
|---|---|---|
| Evidence kernel | Scoped memory, explicit sharing, correction cascades, conflicts, source history, outcomes and replay-aware forgetting. | Controller-provided provenance and trust do not authenticate truth. |
| Host lifecycle | `MemoryAgent` context preparation, supplied-turn capture, durable jobs, finite workers and action bindings. | The host installs the integration, selects providers and starts work. |
| Context and profiles | Budgeted source-backed observations and summaries, original-byte expansion, typed profiles with unknown/conflict states. | Generated assertions remain fallible; default budgeting uses UTF-8 bytes. |
| Retrieval | Scoped BM25 default, explicit overlap compatibility, full eligible vector scans, optional fusion and reranking, and an opt-in approximate dense index. | Dense search is bounded exact scanning by default; `indexMode: 'hnsw'` selects an approximate index, is never chosen on your behalf, and is the one component that can miss a true neighbour. |
| Local intelligence | Explicitly provisioned, pinned CPU embedding and reranking providers with cached offline inference. | Optional runtime and model licenses remain separate; use the documented patched dependency. |
| Temporal memory | Independent `asOf` and `knownAt` through SDK, HTTP, MCP and Python; causal correction history and scheduled changes. | Current access and erasure still apply; ambiguous legacy invalidations remain withheld. |
| Skill promotion | Persisted promotion requirements, distinct task/verifier thresholds, failed-evidence retirement and usage traces. | Compatibility defaults to one task/verifier; the recommended two-of-each policy is explicit. |
| Gradual migration | Read-only legacy adapter, used-record capture, paired coverage checks, staged preference and routing rollback. | Observed workload coverage is not complete-store migration; legacy reconciliation continues. |
| Full migration | Eleven explicit export profiles, exact originals, preview, atomic apply, retries, guarded undo and replay tombstones. | Foreign embeddings, graphs and unsupported policy semantics are not automatically converted. |
| Freshness | Explicit source recheck policies, last-confirmed evidence, bounded probes and dependency validation before actions. | Age does not rewrite facts; the host supplies verification, scheduling and complete dependencies. |
| Operations | Scope-bound HTTP credentials, revocation, live inspector, Python client and verified whole-database recovery. | Backups are plaintext unless made with `--encrypt`; remote identity, TLS and deployment isolation remain application work. |

Follow the [runtime](RUNTIME.md), [agent](AGENT.md), [context](CONTEXT.md), [profile](PROFILES.md), [migration](MIGRATION.md), [bridge](BRIDGE.md), [freshness](MAINTENANCE.md), [local model](LOCAL-MODELS.md) and [operator](OPERATIONS.md) guides for the actual interfaces. Existing backend users should read [version migration](MIGRATION-v2.md); no existing database is automatically moved or deleted.

## What the measurements establish

The paired corpus report includes all 500 LongMemEval S questions, with positive retrieval scores on 470 answerable annotated cases. At 20 retrieved chunks, complete annotated-session coverage is 386/470 for the earlier overlap scorer and 425/470 for BM25. Under the same 8,192-byte packing budget, the respective results are 367/470 and 382/470. All 30 abstention questions stay in attempt counts; all 500 full-history controls overflow that budget.

This is an offline retrieval experiment without model calls. It uses same-day timestamp compatibility and includes 1,475 sessions later than the stated question instant. Session-level credit does not prove delivery of the answer-bearing passage. See [reports, hashes and conditions](evaluation/BENCHMARKS.md) and the [corpus protocol](evaluation/CORPUS_PROTOCOL.md). The older 499-question protocol pins overlap explicitly and remains a separate historical baseline.

The synthetic [evidence lifecycle diagnostic](evaluation/EVIDENCE-PROTOCOL.md) separately measures valid retention, obsolete exposure and citation identity. Its reviewed candidate report retains one known failure: an unrelated source-field change can invalidate a still-correct dependent rule. Deterministic demos and this diagnostic establish exercised behavior, not general agent task improvement. The [matched agent harness](AGENT-EVALUATION.md) is available for explicitly configured model experiments; a representative held-out generated-answer comparison has not been completed. A matched competitor *retrieval* benchmark against Mem0 OSS has been completed and is published with its losses in [COMPARISON.md](../COMPARISON.md).

## Remaining engineering work

- **More precise retention:** reconcile changed assertions inside a source and represent alternative sufficient evidence, so an unrelated edit need not retire every dependent rule.
- **Semantic and answer evaluation:** run pinned local semantic providers and stronger summary baselines on held-out tasks, measuring quality, cost, latency and negative transfer together.
- **Native integration validation:** generic protocols and explicit event adapters are available; six native framework lifecycle integrations have not been validated end to end.
- **Managed operations:** database encryption at rest, enterprise identity, bidirectional synchronization and a hosted service are not included.
- **Larger collections:** measure the new BM25 default on representative large workloads. The ANN path is no longer outstanding work: `indexMode` now offers `sqlite-vec` and `hnsw` as opt-in dense indexes that preserve scope, time and erasure behavior because every candidate is re-authorized and rescored against the stored vector before return. Its Tier 1 latency target, p95 under 50 ms at 1,000,000 records, is not met: hybrid recall through `hnsw` on a synthetic 1M-record fixture measured p95 139–223 ms (see the [changelog](../CHANGELOG.md)). Historical 100,000-record overlap timings do not describe BM25 performance.

## Evaluate before adopting

Run the source checks and examples against temporary data, then exercise your own correction, replay, failure and recovery scenarios. Preview full imports before applying them, or begin gradual migration in shadow mode with your original store available. Use [SECURITY.md](../SECURITY.md) for trust boundaries and [deployment](deployment.md) for host configuration. Repository CI and local measurements are evidence for the tested conditions, not a production certification.

Mnemosyne is developed by Aristotle Intelligence Inc., a Delaware company, and has been fully self-funded to date. For advanced memory requirements, integration support or investor enquiries, contact [28naem@gmail.com](mailto:28naem@gmail.com). Reproducible non-sensitive bugs belong in [GitHub issues](https://github.com/28naem-del/mnemosyne/issues).
