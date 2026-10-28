# Dependency inference report, suite dependencies-v1 (synthetic)

All records, tasks and ground truth are synthetic, generated from a fixed seed. Retrieval is the zero-model lexical path. Acceptance is an eval-only policy that accepts every proposal; in production each proposal is a reviewer decision.

Command: `node dist/evaluation/dependencies/cli.js --corpus benchmarks/dependencies/v1/corpus.json --out reports/dependencies/v1 --seeds 1,2,3,4,5,11,12,13,14,15`

Corpus: 228 records (120 premises, 84 procedures, 24 runtime skills), 717 tasks, 160 true undeclared edges, 78 declared edges. Seed 20261028, sha256 `e56da493f548a94907b6f95b9f8c2c8d3a984b9ad7f079706921e3801aca0d6f`, matches generator: true.

Rule `co-use-success-v1`, thresholds: minSupport 2, minReliance 0.4, minLift 1.5, minConfidence 0.25, z 1, guard holdReliance 0.

## Gate

| Metric | Value | Threshold | Pass |
| --- | --- | --- | --- |
| Invalidation recall (micro, 170/177) | 96.05% | >= 90.00% | yes |
| Precision of accepted edges (152/155) | 98.06% | >= 95.00% | yes |
| Stale-procedure executions (guarded executor, 248 checks over 120 corrections) | 0 | = 0 | yes |

Gate passed: true.

## What produces stale = 0 (decomposition)

Stale = 0 is produced by the premise guard, not by inference. With holdReliance 0 the guard is a blanket hold: it holds every dependent that had at least one judged successful co-use with a premise that has since changed, whether or not the dependent relies on it.

| Configuration | Stale executions | Guard holds (true / false) | False-hold rate |
| --- | --- | --- | --- |
| Inference + accept-all, guard off | 7 of 248 | n/a | n/a |
| Guard on, zero accepted edges | 0 of 248 | 272 (179 / 93) | 34.19% |
| Inference + accept-all, guard on (the gate) | 0 of 248 | 97 (7 / 90) | 92.78% |

- Inference alone leaves 7 stale of 248. With neither inference nor the guard, at least 177 true undeclared pairs stay active after their premise is corrected.
- What inference buys on top of the guard: the kernel cascade itself invalidates 170 of 177 true undeclared pairs, so guard holds drop from 272 to 97, a shorter review queue of cheaper holds; the links are declared dependencies with ledgered review receipts, which hold without the guard in the executor; and every proposal is a review item with its evidence.
- The guard's false-hold rate after accept-all is 92.78% (90 of 97 holds were on a premise outside the dependent's true closure).
- Observability floor. The generator forces every true edge into at least one judged successful used set (src/evaluation/dependencies/generator.ts, "Observability floor"), which is exactly the condition the guard needs. Recorded without the floor (`node dist/evaluation/dependencies/cli.js --seed N --no-floor`): seed 20261028 stale 1 (S005 on F045); seed 11 stale 2 (P083 on F028, P083 on R006). Recall and precision are unchanged on those seeds.
- Precision denominator. 295 of 405 decoys (retrieved-unused 217, failed-only 58, sibling 20) can never count as support under the rule, by construction. Precision is tested by the hub (89) and incidental (21) decoys only.

## Detail

- Invalidation recall, macro over corrected premises: 96.29%.
- Misses whose carrying premise had fewer than minSupport (2) judged successful co-uses, so no two-task rule can see them: 6 of 7. Recall over the remaining pairs (diagnostic, not gated): 99.42%.
- Kernel-only executor (no premise guard): 7 stale executions, all on true pairs inference did not link; 0 on declared or accepted pairs. The guard held 7 of the 7.
- Over-invalidation (dependent invalidated or retired by a premise outside its true closure): 3.
- Guard over-holds (dependent held for review by a premise outside its true closure): 90.
- Proposals 156, accepted 155, skipped 1 (P053 on F058: Dependency is already declared.). False accepted edges by decoy class: incidental 1, hub 2.
- Tasks judged: 556 successful, 104 failed, 17 unjudged, 40 recall-only, 0 conflicting. Pairs considered 319; rejected: declared 66, support 94, reliance 2, confidence 1.
- Decoys: retrieved-unused 217, failed-only 58, sibling 20, incidental 21, hub 89.

## Misses (true undeclared pairs not invalidated)

| Dependent | Premise | Reason | Judged co-uses |
| --- | --- | --- | --- |
| P008 | F059 | not-inferred | 2 |
| P011 | R012 | not-inferred | 1 |
| P065 | R007 | not-inferred | 1 |
| P082 | F015 | not-inferred | 1 |
| P083 | F013 | not-inferred | 1 |
| P084 | F002 | not-inferred | 1 |
| S005 | F045 | not-inferred | 1 |

## Stale executions through the guarded executor

None.

## False accepted edges

| Dependent | Premise | Decoy class |
| --- | --- | --- |
| P061 | R002 | hub |
| S009 | R002 | hub |
| S015 | F046 | incidental |

## Robustness (other seeds, same parameters; not part of the gate)

Tuning seeds were looked at while the defaults were chosen: the inference thresholds on seeds 1-5, the corpus parameter rareRuns on seeds 1-10. Held-out seeds were first run after every default was fixed. The guard default holdReliance 0 was set after the first run on the gate seed, which had one stale execution at 0.34; docs/DEPENDENCIES.md records that run.

| Seed | Role | Recall | Precision | Stale (guarded) | Stale (kernel only) | Over-invalidated | Guard over-holds | Stale, guard only (0 edges) | Guard holds (true / false) | Guard false-hold rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | tuning | 95.12% | 97.77% | 0 | 10 | 4 | 86 | 0 | 96 (10 / 86) | 89.58% |
| 2 | tuning | 96.32% | 98.81% | 0 | 7 | 3 | 92 | 0 | 100 (8 / 92) | 92.00% |
| 3 | tuning | 92.89% | 98.24% | 0 | 14 | 4 | 95 | 0 | 110 (15 / 95) | 86.36% |
| 4 | tuning | 92.39% | 98.26% | 0 | 15 | 3 | 82 | 0 | 97 (15 / 82) | 84.54% |
| 5 | tuning | 92.82% | 99.39% | 0 | 13 | 1 | 95 | 0 | 108 (13 / 95) | 87.96% |
| 11 | held-out | 94.97% | 98.11% | 0 | 9 | 3 | 89 | 0 | 98 (9 / 89) | 90.82% |
| 12 | held-out | 96.81% | 97.63% | 0 | 6 | 4 | 95 | 0 | 102 (7 / 95) | 93.14% |
| 13 | held-out | 94.38% | 95.06% | 0 | 10 | 8 | 95 | 0 | 105 (10 / 95) | 90.48% |
| 14 | held-out | 92.93% | 98.17% | 0 | 13 | 3 | 88 | 0 | 101 (13 / 88) | 87.13% |
| 15 | held-out | 95.08% | 98.78% | 0 | 9 | 2 | 86 | 0 | 95 (9 / 86) | 90.53% |

Stale (kernel only) is staleWithoutGuard. Guard false-hold rate across these seeds: 84.54% to 93.14%.
