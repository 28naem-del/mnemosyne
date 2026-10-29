# Public claims and their evidence

This page lists each public claim made in the README, `llms.txt`, the site and these docs. For each one it gives the wording that the code supports, the conditions that come with it, and the file in this repository that backs it. Other pages may shorten a claim, but they must not go beyond what this page states. Benchmark and measured claims not listed here should not appear on a public surface.

"Recorded run" means an output saved in this repository. It is not a rerun on your machine.

## Identity

- **Tagline:** "The next agent starts wiser." The README, the site and both `llms.txt` files use this line and no other.
- **Name:** this is the TypeScript package `mnemosy-ai` (repository 28naem-del/mnemosyne, site mnemosy.ai). It is a separate project from mnemosyne-oss/mnemosyne (`mnemosyne-memory` on PyPI). Source: the name note in [README.md](../README.md) and [`.github/ISSUE_TEMPLATE/config.yml`](../.github/ISSUE_TEMPLATE/config.yml); package and site identity in [`scripts/public-identity.json`](../scripts/public-identity.json).

## Capabilities and their conditions

| Capability | What the code supports | Conditions and limits | Evidence |
|---|---|---|---|
| Corrections retire dependents | A correction retires the memories **recorded as depending on** the corrected source. What remains is still supported by current recorded evidence; that is not a claim that it is true. | Only declared dependencies, and inferred ones a reviewer accepted, are followed. Inferred dependencies are proposals. Inference alone left 7 of 248 checks stale in the synthetic suite; the zero comes from the optional premise guard. | [DEPENDENCIES.md](DEPENDENCIES.md), [dependency suite report](../reports/dependencies/v1/report.md) |
| Replay | Past visible-record states replay exactly, as of a world time and a knowledge time. | Covers visible records in one store. It is not a replay of a model or of a whole database file. Replay and `bisect` exist since 2.0.0. | [`tests/local-replay-determinism.test.ts`](../tests/local-replay-determinism.test.ts), [`site/demo-five.json`](../site/demo-five.json) |
| Bisect | Given the expected (gold) records of a reproducible retrieval failure, `bisect` finds the records that push them out of the top k. | It needs the gold record ids and `k`. It judges retrieval, not a generated answer. The `mnemosy bisect` CLI uses lexical retrieval only, even if the agent used hybrid retrieval. The hybrid path (new in 3.0.0-rc.1) is implemented and tested in the kernel, but `bisect` is not a public package export in 3.0.0-rc.3, so from npm the CLI is the entry point. A result can be `blamed`, `passing`, `unfixable` or `unconfirmed`, and several minimal blame sets can exist. | [`src/local/bisect.ts`](../src/local/bisect.ts), [vision note](vision/V0.md) |
| Consolidation keep rule | A pass is kept only when aggregate lexical coverage on the recorded replay set does not drop (`delta >= 0` overall, on the hold-out, and for each proposal alone) and every invariant holds. | This is not task-level or meaning-level non-regression: a loss on one task can be offset by a gain on another, and a token-subset paraphrase can be kept. Fewer than 2 replayable tasks gives `no_evidence`, which is not a keep. | [`src/consolidation/gate.ts`](../src/consolidation/gate.ts), [CONSOLIDATION.md](CONSOLIDATION.md#honest-limits) |
| Outcome gate in the standard MCP setup | **Off by default.** The MCP server has no consolidation or outcome tools, and the default ledger (`queries: 'digest'`) stores no query text, so every pass is `no_evidence`. | To turn it on, a host uses the SDK. It opens the store with `createLocalMemory({ ..., ledger: { queries: 'text' } })` and records verifier outcomes with `recordRetrievalOutcome`. Then it runs `consolidate()` or `mnemosy consolidate --apply`. Query text is then stored in the ledger. | [`src/mcp/server.ts`](../src/mcp/server.ts), [CONSOLIDATION.md](CONSOLIDATION.md#turn-the-gate-on) |
| Undo | `rollbackConsolidation` removes the records of an unchanged kept pass. The visible-record state hash is identical to the one before the pass only when nothing was written after it. | Later writes mean `restored: false`. A created record that changed or gained dependent work means `conflict`, and nothing changes. The hash covers visible records, not indexes, embeddings or the ledger. | [`src/consolidation/gate.ts`](../src/consolidation/gate.ts), [CONSOLIDATION.md](CONSOLIDATION.md#a-pass) |
| Signed receipts | A valid signature shows that the holder of the private key signed an assertion. That assertion binds the inputs, the code digest and the result. | It does not prove that the gate ran, or that the inputs or the result are true. | [`src/consolidation/signing.ts`](../src/consolidation/signing.ts), [CONSOLIDATION-SIGNING.md](CONSOLIDATION-SIGNING.md#what-a-signature-means) |
| Backups | `backupLocalDatabase` copies the SQLite database. | The consolidation signing key `<db>.consolidation.key` is **not** in the backup. Back it up separately. | [`src/operations/index.ts`](../src/operations/index.ts), [OPERATIONS.md](OPERATIONS.md#the-consolidation-signing-key) |
| MCP tools | 16 `memory_*` tools. `memory_forget` is added only with `--allow-destructive`, and `--read-only` omits every mutation tool. | No consolidation, bisect or outcome tool is exposed over MCP. | [`src/mcp/server.ts`](../src/mcp/server.ts) |
| Poisoning gate | Suite v1 with consolidation on: 0 of 167 attacks escaped and 0 of 60 benign controls were falsely quarantined (227 synthetic cases, lexical path, 294 gate decisions). Without the gate, 85 of 167 escape. | Synthetic suite, not a real-world rate. It says nothing about attacks outside the suite. An uncited paraphrase in trusted words is kept. | [report](../reports/poisoning/v1-consolidation/report.md), [ungated control](../reports/poisoning/v1-consolidation/ungated-control/) |

## Numbers

| Figure | Boundary | Evidence |
|---|---|---|
| PrecisionMemBench 70/77 single-turn, 11/12 session turns (rc.1: 22/77, 48/77, 6/12) | Public fixture that the controls were designed against, so it is not a held-out estimate. The 7 misses are those of our metadata-based configuration; the protocol omits explicit lifecycle fields. | [`reports/precisionmembench/final-lexical/run-summary.json`](../reports/precisionmembench/final-lexical/run-summary.json), [`final-hybrid`](../reports/precisionmembench/final-hybrid/) |
| Dependency suite v1: recall 96.05 %, precision 98.06 %, 0 of 248 stale with the premise guard, 7 of 248 without it, guard false-hold rate 92.78 % | Synthetic corpus, seed 20261028, 120 corrections, accept-all evaluation reviewer. | [`reports/dependencies/v1/report.md`](../reports/dependencies/v1/report.md) |
| Replay: 1000/1000 identical states, 24,000/24,000 as-of answers | Recorded run, synthetic store, two readers. | [`site/demo-five.json`](../site/demo-five.json), [`tests/breakthrough-demo.test.ts`](../tests/breakthrough-demo.test.ts) |
| Bisect: precision 1.00 on 2,000 records, **0.40 s** | One recorded run: 2026-10-28, 3.0.0-rc.2 build, on the maintainer's development machine (its model is not recorded). Times vary by machine. The test bar is under 60 s. One seeded culprit at `k = 1`, lexical path. This is the only bisect time quoted on public surfaces. | [`site/demo-five.json`](../site/demo-five.json) (moment 3, `seconds`), [`tests/breakthrough-demo.test.ts`](../tests/breakthrough-demo.test.ts) |
| Consolidation demo: kept 1 (delta +2), rolled back 2, chain of 4 receipts | Tiny scripted synthetic fixture. | [`site/demo-five.json`](../site/demo-five.json) |
| LongMemEval-S 409/500 (81.8 %, Wilson 95 % CI 78.2–84.9) | `claude-sonnet-4.6` reader, `claude-haiku-4.5` judge. The prompt and budget were chosen on 100 of the questions. Per-question answers are not committed. | [`reports/t1-targets/evidence/t17/full500-b16384.stats.txt`](../reports/t1-targets/evidence/t17/full500-b16384.stats.txt) |
| LoCoMo reranker gain MRR@10 +0.163 | Paired, the same candidate set with and without the reranker. | [`reports/t1-targets/evidence/t15-tip/t15-mrr-output.txt`](../reports/t1-targets/evidence/t15-tip/t15-mrr-output.txt) |
| Matched comparison with Mem0 OSS (2.0.0) | Retrieval only. It is not a comparison on the 3.0 numbers above. | [COMPARISON.md](../COMPARISON.md) |
| 1M-record recall p95 139–223 ms (50 ms goal not met) | Synthetic vectors, reranker off. | [`reports/t1-targets/evidence/t12/gate-run1.txt`](../reports/t1-targets/evidence/t12/gate-run1.txt) |
| Contextual reranking 71.98 % against a 72.80 % gate (not met) | | [`reports/t1-targets/evidence/t13/cmp-ctx-full10.txt`](../reports/t1-targets/evidence/t13/cmp-ctx-full10.txt) |
| Default retrieval recall unchanged from rc.1 to rc.2 (LoCoMo, LongMemEval-S) | Controls off. Per-question outputs are not committed. | [`reports/retrieval-regression/2026-10-28/summary.json`](../reports/retrieval-regression/2026-10-28/summary.json) |
| rc.2 latency figures (for example +18.2 % BM25 p50 with the opt-in controls) | Loaded 10-core host. The harness is **not committed**, so these figures cannot be reproduced from this repository. | Protocol stated in [CHANGELOG.md](../CHANGELOG.md) and [BENCHMARKS-TRUST.md](BENCHMARKS-TRUST.md) |
| Lifecycle diagnostic: 15/16 with compiled context, 13/16 with raw retrieval | Both conditions are stated together. | [`docs/evaluation/reports/evidence-lifecycle-after.json`](evaluation/reports/evidence-lifecycle-after.json) |

## Not claimed

- No general-intelligence or learning-in-weights claim. No claim that memory improves itself, and no lift number: no held-out improvement from experience has been measured. The gate keeps changes whose replayed lexical coverage does not drop, and that is all it does.
- Consolidation is outcome-gated and reversible under the conditions above. It is not called safe.
- The poisoning result is not immunity, and an uncited paraphrase in trusted words passes the gate.
- The 70/77 figure is not held out. The dependency and poisoning figures are synthetic and are not real-world rates.
- The zero stale procedures come from the premise guard, not from inference.
- The 3.0 numbers above were not run on Mem0, Zep, Letta or any other system.
