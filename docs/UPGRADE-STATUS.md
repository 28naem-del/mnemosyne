# Release status: 2.0.0-rc.8

Mnemosyne 2.0.0-rc.8 is a source release candidate for developer evaluation. The [README quickstart](../README.md#start-with-a-working-demonstration) builds the tagged GitHub source. npm and PyPI publication are separate release actions; a source prerelease does not mean the same version is available from either registry.

## Implemented in this candidate

| Area | Available behavior | Important boundary |
|---|---|---|
| Evidence kernel | Scoped memory, explicit sharing, correction cascades, conflicts, source history, outcomes and replay-aware forgetting. | Controller-provided provenance and trust do not authenticate truth. |
| Host lifecycle | `MemoryAgent` context preparation, supplied-turn capture, durable jobs, finite workers and action bindings. | The host installs the integration, selects providers and starts work. |
| Context and profiles | Budgeted source-backed observations and summaries, original-byte expansion, typed profiles with unknown/conflict states. | Generated assertions remain fallible; default budgeting uses UTF-8 bytes. |
| Retrieval | Scoped BM25 default, explicit overlap compatibility, full eligible vector scans, optional fusion and reranking. | Dense search is bounded exact scanning, not an ANN index. |
| Local intelligence | Explicitly provisioned, pinned CPU embedding and reranking providers with cached offline inference. | Optional runtime and model licenses remain separate; use the documented patched dependency. |
| Temporal memory | Independent `asOf` and `knownAt` through SDK, HTTP, MCP and Python; causal correction history and scheduled changes. | Current access and erasure still apply; ambiguous legacy invalidations remain withheld. |
| Skill promotion | Persisted promotion requirements, distinct task/verifier thresholds, failed-evidence retirement and usage traces. | Compatibility defaults to one task/verifier; the recommended two-of-each policy is explicit. |
| Gradual migration | Read-only legacy adapter, used-record capture, paired coverage checks, staged preference and routing rollback. | Observed workload coverage is not complete-store migration; legacy reconciliation continues. |
| Full migration | Eleven explicit export profiles, exact originals, preview, atomic apply, retries, guarded undo and replay tombstones. | Foreign embeddings, graphs and unsupported policy semantics are not automatically converted. |
| Freshness | Explicit source recheck policies, last-confirmed evidence, bounded probes and dependency validation before actions. | Age does not rewrite facts; the host supplies verification, scheduling and complete dependencies. |
| Operations | Scope-bound HTTP credentials, revocation, live inspector, Python client and verified whole-database recovery. | Backups are plaintext; remote identity, TLS and deployment isolation remain application work. |

Follow the [runtime](RUNTIME.md), [agent](AGENT.md), [context](CONTEXT.md), [profile](PROFILES.md), [migration](MIGRATION.md), [bridge](BRIDGE.md), [freshness](MAINTENANCE.md), [local model](LOCAL-MODELS.md) and [operator](OPERATIONS.md) guides for the actual interfaces. Existing backend users should read [version migration](MIGRATION-v2.md); no existing database is automatically moved or deleted.

## What the measurements establish

The paired corpus report includes all 500 LongMemEval S questions, with positive retrieval scores on 470 answerable annotated cases. At 20 retrieved chunks, complete annotated-session coverage is 386/470 for the earlier overlap scorer and 425/470 for BM25. Under the same 8,192-byte packing budget, the respective results are 367/470 and 382/470. All 30 abstention questions stay in attempt counts; all 500 full-history controls overflow that budget.

This is an offline retrieval experiment without model calls. It uses same-day timestamp compatibility and includes 1,475 sessions later than the stated question instant. Session-level credit does not prove delivery of the answer-bearing passage. See [reports, hashes and conditions](evaluation/BENCHMARKS.md) and the [corpus protocol](evaluation/CORPUS_PROTOCOL.md). The older 499-question protocol pins overlap explicitly and remains a separate historical baseline.

The synthetic [evidence lifecycle diagnostic](evaluation/EVIDENCE-PROTOCOL.md) separately measures valid retention, obsolete exposure and citation identity. Its reviewed candidate report retains one known failure: an unrelated source-field change can invalidate a still-correct dependent rule. Deterministic demos and this diagnostic establish exercised behavior, not general agent task improvement. The [matched agent harness](AGENT-EVALUATION.md) is available for explicitly configured model experiments; a representative held-out generated-answer comparison has not been completed.

## Remaining engineering work

- **More precise retention:** reconcile changed assertions inside a source and represent alternative sufficient evidence, so an unrelated edit need not retire every dependent rule.
- **Semantic and answer evaluation:** run pinned local semantic providers and stronger summary baselines on held-out tasks, measuring quality, cost, latency and negative transfer together.
- **Native integration validation:** generic protocols and explicit event adapters are available; six native framework lifecycle integrations have not been validated end to end.
- **Managed operations:** database/backup encryption, enterprise identity, bidirectional synchronization and a hosted service are not included.
- **Larger collections:** measure the new BM25 default on representative large workloads and evaluate an ANN path without weakening scope, time or erasure behavior. Historical 100,000-record overlap timings do not describe BM25 performance.

## Evaluate before adopting

Run the source checks and examples against temporary data, then exercise your own correction, replay, failure and recovery scenarios. Preview full imports before applying them, or begin gradual migration in shadow mode with your original store available. Use [SECURITY.md](../SECURITY.md) for trust boundaries and [deployment](deployment.md) for host configuration. Repository CI and local measurements are evidence for the tested conditions, not a production certification.

Mnemosyne is developed by Aristotle Intelligence Inc., a Delaware company, and has been fully self-funded to date. For advanced memory requirements, integration support or investor enquiries, contact [28naem@gmail.com](mailto:28naem@gmail.com). Reproducible non-sensitive bugs belong in [GitHub issues](https://github.com/28naem-del/mnemosyne/issues).
