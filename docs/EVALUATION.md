# Evaluation evidence — 2026-09-12

This release separates correctness checks from memory-quality claims. No paid model calls, public memory benchmark runs, or matched competitor experiments were performed.

## Verified release-candidate checks

On September 12, the final source passed all **173 tests** plus source/example typechecking and build on **Node 22.16.0 and Node 24.21.0**. Dependency audit reported **0 known vulnerabilities**. Independent kernel, compatibility, transport, reflection, package/release, and static-site reviews were completed and actionable findings repaired. The packaged CLI/import/demo smoke passed. Browser checks exercised all six demo steps, inspector tabs, keyboard navigation, and four routes at desktop/mobile widths without page overflow.

Snyk Code scanning was attempted but could not run because the local account is unauthenticated. Docker/Compose execution and live production backend conformance were not tested; the Compose plugin was unavailable. These limitations remain despite passing local tests.

## Correctness and integration

The original 62 tests passed before the reported defects were fixed. The upgrade adds regression coverage for those missing cases and for the new lifecycle. Current tests cover source corrections, descendant invalidation, private/shared scopes, conflicting facts/checkpoints, bounded context, outcomes, snapshot roundtrips and retry identity, simultaneous local connections, reflection validation/cancellation, and real MCP stdio sessions.

Qdrant/graph/Redis regressions use in-process mocked transports. They test request construction, ownership, score handling, response errors, cache revalidation, maintenance guards, and private broadcast routing. They do not establish live service compatibility under production load.

`npm run check` typechecks and builds before running tests, so MCP subprocess tests execute the current CLI. CI targets Node 22.16 and 24. The six-step executable demo makes 14 assertions against isolated real SQLite records, including opening a new agent connection and correcting the brief. The website reads that recorded run; it does not invoke an LLM.

## Synthetic scale probe

Run `npm run benchmark -- --count 10000 --queries 100 --out NEW_FILE.json`. Counts are bounded at 100,000 records. The runner writes deterministic SKU facts to a temporary file-backed SQLite database with per-record transactions and WAL, performs 100 exact-ID queries and 20 broad queries, then removes its temporary database. It does not simulate a crash or certify crash durability.

Observed on macOS arm64, Node 26.4.0, on September 12. Background host load and cold/warm cache states were not controlled. These are single-process exploratory measurements, not latency guarantees:

- **10,000 records:** ingestion 1.345 seconds; exact-ID hits@5 100/100, p50 0.033 ms, p95 0.115 ms; broad-query p50 130.858 ms, p95 158.908 ms.
- **100,000 records:** ingestion 16.375 seconds; exact-ID hits@5 100/100, p50 0.040 ms, p95 1.890 ms; broad-query p50 1464.238 ms, p95 1933.133 ms.

[10k raw measurement](evaluation/local-10000.json) and [100k raw measurement](evaluation/local-100000.json) preserve the measured values. Their original kind label mentioned durability; that label has been corrected because no crash experiment was conducted.

Broad lexical matches still require scanning many scoped records. SQLite work is synchronous and can block its MCP process. For large corpora use selective queries or evaluate the separate Qdrant backend; semantic local retrieval and bounded asynchronous processing are future performance work. These exact-ID fixtures do not measure indirect references, natural-language answer quality, or agent task improvement.

## Agent experiments still required

Freeze task splits and source/agent/model revisions before tuning. Compare no memory, a strong plain-file or summary baseline, and each enabled memory mechanism using the same model and compute allowance. Evaluate held-out tasks; do not tune abstention on test labels.

Measure completed task outcomes, stale-advice reuse after correction, negative transfer, scope leakage, unsupported assertions, context cost, latency, and handoff recovery. Include withheld and failed cases. Score answer correctness separately from evidence retrieval. Validate against the official protocols for [LongMemEval](https://github.com/xiaowu0162/LongMemEval) and [LoCoMo](https://github.com/snap-research/locomo) before publishing a benchmark claim. Use real independent task outcomes for reflection instead of repeatedly treating the same model's self-assessment as new evidence.

The design hypothesis is that explicit provenance, scope, correction, and bounded experience reuse improve continuity. Its general agent-performance benefit remains unmeasured.
