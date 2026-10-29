# Retrieval benchmark protocol, October 2026

This protocol is fixed before any tuning. It governs every retrieval number
produced by the October 2026 retrieval work: TUNE/HOLDOUT splits, seeds,
metrics, success bars and how results may be reported. A change to it is a
reviewed pull request made before HOLDOUT is run, never after.

Harness: `src/evaluation/matched-benchmark.ts` (`npm run benchmark:matched`),
scorer `src/evaluation/corpus-benchmark.ts`.

## 1. Splits

| Corpus | Unit | Population | TUNE | HOLDOUT | File |
| --- | --- | --- | --- | --- | --- |
| LoCoMo (`locomo10.json`, sha256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`) | conversation (`sample_id`) | 10 conversations, 1,986 questions | 4 conversations: conv-42, conv-44, conv-47, conv-48 (847 questions) | 6 conversations: conv-26, conv-30, conv-41, conv-43, conv-49, conv-50 (1,139 questions) | [`splits/locomo.json`](splits/locomo.json) |
| LongMemEval-S (`longmemeval_s_cleaned.json`, sha256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`) | question (`question_id`), stratified by `question_type` | 500 questions | 150 | 350 | [`splits/longmemeval_s.json`](splits/longmemeval_s.json) |

- LoCoMo is split by whole conversation, so no conversation is scored on both
  sides. Category-5 (adversarial) questions stay outside positive metrics, as
  in an unsplit run.
- LongMemEval-S is grouped by type in the source file, so the split is
  stratified: TUNE takes 150 × |type| / 500 of each type, rounded by largest
  remainder (ties by type name). TUNE per type: knowledge-update 23,
  multi-session 40, single-session-assistant 17, single-session-preference 9,
  single-session-user 21, temporal-reasoning 40. HOLDOUT gets the rest
  (55, 93, 39, 21, 49, 93).
- The 30 `_abs` (unanswerable) questions are split like any other (7 TUNE,
  23 HOLDOUT) and stay excluded from positive metrics, as today.
- Each file lists the ids explicitly, plus the population they were drawn from
  and the sha256 of the corpus bytes. `src/evaluation/make-splits.ts`
  (`npm run benchmark:splits`, `-- --check` to verify) generates them;
  `tests/benchmark-splits.test.ts` asserts the committed files equal a
  regeneration from the recorded population, and that TUNE and HOLDOUT are
  disjoint and cover every id.
- Usage: `npm run benchmark:matched -- --split tune|holdout|all`. `all` (the
  default) is the unsplit behaviour. The split filter is applied to the source
  file before `--stride`, `--max-corpora` and `--max-questions`. The harness
  refuses a split file drawn from different corpus bytes or naming an id the
  corpus lacks. Output files are named `<corpus>-<split>-k<K>.json` and record
  the split name, file, file sha256 and seed under `matched.split`.
- A split run indexes only its own conversations or haystacks, so chunk
  identities are numbered within the split. A HOLDOUT row is therefore its own
  run, not a subset of an `all` run.

## 2. Seeds

Every stochastic step uses seed **20261029**: the split shuffles above
(`mulberry32` + Fisher-Yates, `src/evaluation/splits.ts`) and any later
sampling. Retrieval itself is deterministic; there is no other random step in
the harness. Competitor sessions receive `seed = corpus index`, as today.

## 3. Metrics

Retrieval only; no reader and no judge. All metrics are computed by the
harness's own code, at one K per run (`--top-k`), on the same chunk set
(4,096-byte chunks) for every system. recall@5, @10 and @20 are three runs at
K = 5, 10 and 20; MRR is reported at the K of its run.

Per question, over the top-K list (`src/evaluation/corpus-benchmark.ts:118-127`):

- target = the question's evidence groups (empty for unanswerable questions);
  matched = targets present in the top K.
- recall = matched / |target|.
- allHit = 1 when every target is in the top K, else 0. anyHit = 1 when at
  least one is.
- reciprocal rank = 1 / (1-based rank of the first chunk carrying any target),
  0 when none is in the top K.

Per condition (`src/evaluation/corpus-benchmark.ts:136-153`): each mean is over
**all annotated questions** (questions with at least one positive target), and
a question whose retrieval failed counts as 0, so the denominator never shrinks.
MRR is the mean reciprocal rank on that denominator.

Latency: `retrievalMs` times only the search call for a question (query
embedding, retrieval and reranking included; ingestion and indexing excluded),
`src/evaluation/corpus-benchmark.ts:349-360`. p50 and p95 are nearest-rank
percentiles over every question whose retrieval ran
(`src/evaluation/corpus-benchmark.ts:146-147`). Latency is measured only on a
GitHub Actions `ubuntu-latest` runner or on an idle machine, and the report
names the runner or machine, CPU, Node version and thread settings.

Per-question raw results are already written by `--out`: `attempts[]` holds,
per question and condition, `questionId`, `status`, `retrieval.reciprocalRank`
(rank of the first hit = 1 / reciprocalRank; 0 = no hit in the top K),
`retrieval.matchedGroups` / `targetGroups` (hits at K), `anyHit`, `allHit`,
`recall` and `retrievalMs`. These files are the artifacts for section 5.

## 4. Success bars

All bars are judged on HOLDOUT and stated with their numbers whether met or
not. Mem0 OSS runs with `infer:false` and the same embedder as our rows
(`Xenova/bge-small-en-v1.5`, int8 ONNX, 384 dimensions, injected into Mem0 by
`src/evaluation/matched-mem0.ts`); the report states this.

1. **Fast path** (hybrid dense + BM25 RRF, no rerank): at least Mem0
   `infer:false` on recall@5, recall@10, recall@20 **and** MRR, on HOLDOUT of
   both LoCoMo and LongMemEval-S.
2. **Reranked path**: MRR at least Mem0's on LongMemEval-S HOLDOUT, and no
   LoCoMo HOLDOUT regression against the pre-change reranked baseline.
3. **Rerank latency**: p95 at most 300 ms on LongMemEval-S-sized inputs.

## 5. Reporting rule

- Headline numbers come **only** from HOLDOUT and from the full-corpus rerun
  (`--split all`). TUNE numbers may appear only in an appendix labelled TUNE.
- Every configuration choice is frozen, and written in the report, **before**
  HOLDOUT is run. HOLDOUT is run once per frozen configuration.
- Every remaining loss is published, in the same table as the wins.

## 6. Baseline

Every before/after delta is measured on the current `main` tree
(3.0.0-rc.x) in the same harness and environment, not against the
2.0.0-rc.8 numbers in `COMPARISON.md`.
