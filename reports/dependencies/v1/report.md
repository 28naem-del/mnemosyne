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

| Seed | Role | Recall | Precision | Stale (guarded) | Stale (kernel only) | Over-invalidated | Guard over-holds |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | tuning | 95.12% | 97.77% | 0 | 10 | 4 | 86 |
| 2 | tuning | 96.32% | 98.81% | 0 | 7 | 3 | 92 |
| 3 | tuning | 92.89% | 98.24% | 0 | 14 | 4 | 95 |
| 4 | tuning | 92.39% | 98.26% | 0 | 15 | 3 | 82 |
| 5 | tuning | 92.82% | 99.39% | 0 | 13 | 1 | 95 |
| 11 | held-out | 94.97% | 98.11% | 0 | 9 | 3 | 89 |
| 12 | held-out | 96.81% | 97.63% | 0 | 6 | 4 | 95 |
| 13 | held-out | 94.38% | 95.06% | 0 | 10 | 8 | 95 |
| 14 | held-out | 92.93% | 98.17% | 0 | 13 | 3 | 88 |
| 15 | held-out | 95.08% | 98.78% | 0 | 9 | 2 | 86 |
