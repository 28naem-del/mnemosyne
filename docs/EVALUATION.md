# Evaluation evidence — 2026-09-12

This release separates correctness checks from memory-quality claims. No paid model calls, public memory benchmark runs, or matched competitor experiments were performed.

## Verified rc2 checkpoint

The September 12 rc2 checkpoint passed **304 TypeScript tests** on both **Node 22.16.0 and Node 24.21.0**, plus source/example typechecking and build. The Python standard-library HTTP client passed **8 tests**. Dependency audit reported **0 known vulnerabilities**. A fresh offline-installed package imported all 11 tested entry points and ran the 14-check memory demo and 13-check learning demo. Python-to-Node integration additionally exercised capture, correction, history, forgetting and replay rejection against the actual loopback service. CI includes both Node versions, Python 3.10/3.13, installed-package checks and the executable SDK example; configured CI is distinct from a completed remote run.

Independent review exercised kernel, runtime, transport, provider, connector, branch, relation and website boundaries. Repairs include correction during asynchronous retrieval, historical graph projections, concurrent model publication, source-content restoration, delayed extraction, analysis-channel exclusion, and capture-disabled HTTP writes. Browser checks covered the live inspector's correction/forget/disconnect behavior and the recorded learning cycle at desktop and phone widths.

Snyk Code scanning was attempted but could not run because the local account is unauthenticated. Semgrep ran 99 security-audit rules on 82 first-party source targets with 0 findings. It reported one partial-parse warning at a TypeScript type-only re-export in `src/local/index.ts`; approximately 99.9% of lines parsed. This is not a completed Snyk scan. Docker/Compose execution and live production backend conformance were not tested; the Compose plugin was unavailable. These limitations remain despite passing local tests.

The earlier rc1 checkpoint passed 173 tests and remote Node 22.16/24 CI. Those historical results do not substitute for verification of rc2.

## Correctness and integration

The original 62 tests passed before the reported defects were fixed. The upgrade adds regression coverage for those missing cases and for the new lifecycle. Current tests cover source corrections, descendant invalidation, private/shared scopes, conflicting facts/checkpoints, bounded context, outcomes, snapshot roundtrips and retry identity, simultaneous local connections, reflection validation/cancellation, and real MCP stdio sessions.

Qdrant/graph/Redis regressions use in-process mocked transports. They test request construction, ownership, score handling, response errors, cache revalidation, maintenance guards, and private broadcast routing. They do not establish live service compatibility under production load.

`npm run check` typechecks and builds before running tests, so MCP subprocess tests execute the current CLI. CI targets Node 22.16 and 24. The six-step executable demo makes 14 assertions against isolated real SQLite records, including opening a new agent connection and correcting the brief. The website reads that recorded run; it does not invoke an LLM.

`npm run demo:learning` runs a second isolated real-SQLite demonstration: exact capture and replay, a scripted source-cited observation job, an inactive candidate, two controller-executed trial cases, explicit workspace publication, a second agent's recall, cross-workspace isolation, transitive correction, original-source inspection, forgetting and replay blocking after reopening. Its **13 checks** and two passing trial cases are integration evidence. The proposer is a hand-authored fixture; zero LLM calls are made. The website's second recording exposes both successful and failed or unrun checks.

## Synthetic scale probe

Run `npm run benchmark -- --count 10000 --queries 100 --out NEW_FILE.json`. Counts are bounded at 100,000 records. The runner writes deterministic SKU facts to a temporary file-backed SQLite database with per-record transactions and WAL, performs 100 exact-ID queries and 20 broad queries, then removes its temporary database. It does not simulate a crash or certify crash durability.

The following historical rc1 measurements were observed on macOS arm64, Node 26.4.0, on September 12. Background host load and cold/warm cache states were not controlled. These are single-process exploratory measurements, not latency guarantees:

- **10,000 records:** ingestion 1.345 seconds; exact-ID hits@5 100/100, p50 0.033 ms, p95 0.115 ms; broad-query p50 130.858 ms, p95 158.908 ms.
- **100,000 records:** ingestion 16.375 seconds; exact-ID hits@5 100/100, p50 0.040 ms, p95 1.890 ms; broad-query p50 1464.238 ms, p95 1933.133 ms.

[10k raw measurement](evaluation/local-10000.json) and [100k raw measurement](evaluation/local-100000.json) preserve the measured values. Their original kind label mentioned durability; that label has been corrected because no crash experiment was conducted.

### rc2 retrieval regression and repair

The added temporal filters initially caused SQLite to scan the workspace's records before its term postings. A new query groups indexed term matches before loading their records; scope, time, outcome and provenance checks remain applied. A paired 20,000-record probe improved both exact and broad queries, and the unchanged 100,000-record runner then measured:

- **100,000 records:** ingestion 63.086 seconds; exact-ID hits@5 100/100, p50 0.135 ms, p95 0.332 ms; broad-query p50 371.807 ms, p95 411.906 ms.
- Before the query repair, rc2 exact-ID p95 was 256.751 ms and broad-query p95 was 1780.928 ms. The regression is retained in the work log; no faster result is substituted for a failed run.

[The rc2 raw measurement](evaluation/local-rc2-100000.json) includes runtime, platform, workload and limits. Host load and cache state remain uncontrolled. Ingestion was slower than rc1 because rc2 maintains an additional term-posting index; retrieval improvements do not imply faster writes. These figures are not service-level guarantees or a comparison with another memory product.

Broad lexical queries still examine posting lists and synchronously load matching candidates. SQLite work can block its process. Hybrid retrieval adds explicitly selected embeddings and bounded candidate processing, but brute-force local vector comparison is not an approximate-nearest-neighbor index. These probes do not establish semantic answer quality, distributed load capacity or agent task improvement.

### Write cost and compact posting storage

A [paired 20,000-record investigation](evaluation/ingestion-rc2-20000.json) confirmed the write-cost change: rc1 took 2.234–2.239 seconds and rc2 took 10.546–10.797 seconds. Omitting posting maintenance in a temporary diagnostic copy brought it to 2.274 seconds; that diagnostic omission was not shipped. The fixture produced 300,000 term postings.

New posting tables now use SQLite's `WITHOUT ROWID` layout with the same composite key, reverse term index and foreign-key cascade. The paired database sizes decreased from roughly 80.1 MB to 61.8 MB. Existing tables remain supported without rebuilding or migrating them. Latency improvement from the compact layout was noisy, so no speed gain is claimed. The 100,000-record timing above predates this storage-layout change.

With the original rc2 layout, explicit atomic batches of 500 records took 5.269–5.283 seconds for the same 20,000 records, versus 10.354–10.403 seconds with independent per-record commits. Batching changes the commit boundary; it is not an equivalent durability workload. The default cache, WAL checkpoint, synchronous durability, secure deletion and foreign-key settings remain unchanged. Runtime capture and the evaluation importer already use bounded atomic batches.

## Offline dataset evaluation path

The new [LongMemEval v1 adapter](LONGMEMEVAL.md) accepts an explicitly supplied dataset file and runs isolated no-memory and lexical baselines, with optional selected embeddings. It measures evidence-session recall, precision and coverage; answer correctness and semantic abstention remain unevaluated. The runner strips reference answers, turn labels and evidence-marked identifiers from indexed data, uses deterministic ordinal record IDs, and records raw-file hashes, effective candidate windows and provider budgets.

Seventeen synthetic adapter tests cover label leakage, metrics, stable ties, BOM fingerprints, cancellation, multi-batch deadlines, bounds and cleanup. Two additional CLI tests cover file output and no-provider operation. No official dataset or external model was used for those checks. This is an executable evaluation path, not a published LongMemEval score.

## Agent experiments still required

Freeze task splits and source/agent/model revisions before tuning. Compare no memory, a strong plain-file or summary baseline, and each enabled memory mechanism using the same model and compute allowance. Evaluate held-out tasks; do not tune abstention on test labels.

Measure completed task outcomes, stale-advice reuse after correction, negative transfer, scope leakage, unsupported assertions, context cost, latency, and handoff recovery. Include withheld and failed cases. Score answer correctness separately from evidence retrieval. Validate against the official protocols for [LongMemEval](https://github.com/xiaowu0162/LongMemEval) and [LoCoMo](https://github.com/snap-research/locomo) before publishing a benchmark claim. Use real independent task outcomes for reflection instead of repeatedly treating the same model's self-assessment as new evidence.

The design hypothesis is that explicit provenance, scope, correction, and bounded experience reuse improve continuity. Its general agent-performance benefit remains unmeasured.
