# Retrieval regression check, 2026-10-28: LoCoMo and LongMemEval-S before and after the precision work

`summary.json` holds the per-condition values (mean recall, any-hit, all-hit, MRR, latency
percentiles), the dataset provenance, `topK` and the implementation hash for each run, before
(`84cb6c3`) and after (`3619a5c`, the final build of the precision-controls branch, whose recall path
is identical to `16cd9c0` apart from comments). It is extracted from the full benchmark outputs produced by the commands recorded in
`summary.json`; those outputs are 0.8–11 MB each and are not committed.

| Benchmark | Condition | Before (recall / MRR) | After (recall / MRR) |
|---|---|---|---|
| LoCoMo, full set, zero-model, 1,531 annotated | overlap recall@10 | 40.49 / 0.2899 | 40.49 / 0.2899 |
| LoCoMo, full set, zero-model, 1,531 annotated | BM25 recall@10 | 52.47 / 0.3696 | 52.47 / 0.3696 |
| LoCoMo, conversations 0–2, 382 annotated | overlap recall@10 | 40.68 / 0.2827 | 40.68 / 0.2841 |
| LoCoMo, conversations 0–2, 382 annotated | BM25 recall@10 | 53.38 / 0.3697 | 53.38 / 0.3697 |
| LoCoMo, conversations 0–2, 382 annotated | hybrid recall@10 | 75.29 / 0.6325 | 75.29 / 0.6327 |
| LongMemEval-S cleaned, 470 annotated of 500 | lexical recall@20 | 89.72 / 78.72 | 89.72 / 78.72 |
| LongMemEval-S cleaned, 470 annotated of 500 | BM25 recall@20 | 95.08 / 89.57 | 95.08 / 89.57 |

Recall is identical in every row. The only movement is MRR on the conversations 0–2 subset
(overlap +0.0014, hybrid +0.0002); the final hybrid run was executed per conversation and aggregated
per annotated question, and the same aggregation reproduces the before-run summary exactly. The
opt-in precision controls were off, and neither corpus contains superseded or expired records, so
the always-on lifecycle prefilter had nothing to drop. These are retrieval metrics on public
datasets, not answer scores, and they say nothing about other products.
