# Retrieval benchmark protocol, October 2026

This protocol is fixed before any tuning. It governs every retrieval number
produced by the October 2026 retrieval work: TUNE/HOLDOUT splits, seeds,
metrics, success bars and how results may be reported. A change to it is a
reviewed pull request made before HOLDOUT is run, never after.

Harness: `src/evaluation/matched-benchmark.ts` (`npm run benchmark:matched`),
scorer `src/evaluation/corpus-benchmark.ts`.

**Amendment 1 (2026-10-29), made before any HOLDOUT run.** It adds the fixes
the independent G0 verification asked for: "includes TUNE" labels on
full-corpus rows, a stated tie tolerance, the reranker label, a protocol entry
for Mem0 `infer:true`, a fully specified latency bar, the Mem0 embedder
disclosure, a pinned baseline, a HOLDOUT audit log and the LongMemEval-S
distractor-overlap disclosure (sections 4 to 8). It also records how tuning
is done without new harness flags (section 9).

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
GitHub Actions `ubuntu-latest` runner, and the report names the runner image,
CPU model, core count, Node version, ONNX thread settings and rerank top-N.
The latency bar (section 4, bar 3) has its own, stricter setup.

Per-question raw results are already written by `--out`: `attempts[]` holds,
per question and condition, `questionId`, `status`, `retrieval.reciprocalRank`
(rank of the first hit = 1 / reciprocalRank; 0 = no hit in the top K),
`retrieval.matchedGroups` / `targetGroups` (hits at K), `anyHit`, `allHit`,
`recall` and `retrievalMs`. These files are the artifacts for section 5.

## 4. Success bars

All bars are judged on HOLDOUT and stated with their numbers whether met or
not. Mem0 OSS 3.1.8 runs with `infer:false` and the same embedder as our rows
(`Xenova/bge-small-en-v1.5`, int8 ONNX, 384 dimensions, injected into Mem0 by
`src/evaluation/matched-mem0.ts`); the report states this. Mem0's own default
embedder is not run; see section 8.

**Tie rule.** Recall is compared in percentage points and MRR on its 0-1
scale. A difference of at most **0.5 recall points** or **0.005 MRR** either
way is a **tie**, and the report calls it a tie, never a win. A difference
larger than that in Mem0's favour is a **loss** and is reported as one. A
difference larger than that in our favour is a win. The same tolerance
defines "no regression": a drop of at most 0.5 recall points or 0.005 MRR
against the baseline is no regression, and a larger drop is a regression.
For each HOLDOUT delta the report also gives a paired per-question bootstrap
95% interval (10,000 resamples of the question set, seed 20261029), so a
reader can see the noise; the interval does not change the verdict.

1. **Fast path** (hybrid dense + BM25 RRF, no rerank): a win or a tie against
   Mem0 `infer:false` on recall@5, recall@10, recall@20 **and** MRR, on
   HOLDOUT of both LoCoMo and LongMemEval-S. This is the like-for-like row:
   neither system reranks.
2. **Reranked path**: MRR a win or a tie against Mem0 `infer:false` on
   LongMemEval-S HOLDOUT, and no LoCoMo HOLDOUT regression (recall@5/10/20
   and MRR) against the pinned baseline's reranked row (section 6). Every
   reranked row is labelled **"with reranker; Mem0 has none"**. We do not add
   a cross-encoder to Mem0. Bar 2 compares each product's full retrieval path
   as run here: the reranker is part of ours and is not part of Mem0's, so
   this bar measures the products, not a matched component. Bar 1 is the
   matched-component comparison.
3. **Rerank latency**: p95 of the reranked path at most 300 ms, measured as
   follows and in no other way:
   - corpus LongMemEval-S HOLDOUT, `--stride 3` (every third HOLDOUT question
     in source order, 117 of 350), K = 10;
   - our fast path, our reranked path and Mem0 `infer:false` measured in the
     **same** process, in **one** unsharded GitHub Actions job
     (`benchmark-matched` with `split=holdout`, `stride=3`, `top_k=10`,
     `modes=hybrid,hybrid+rerank`, `competitors=mem0`), so all three p50/p95
     values come from one machine. The full HOLDOUT does not fit one job's
     6-hour limit (the pinned baseline needed about 12.4 compute-hours for all
     500 haystacks), so the stride is what makes one job possible;
   - the report quotes that job's CPU model (from `/proc/cpuinfo`), core
     count and runner image, and the rerank top-N, reranker and embedder ONNX
     batch sizes and thread counts from the raw report
     (`matched.engineConfig`; an unset thread count is recorded as
     `onnxruntime-default`);
   - p50 and p95 of all three rows are published, met or not.
   The accuracy bars use the full sharded HOLDOUT runs, not this subset.

## 5. Reporting rule

- HOLDOUT is the primary table. Headline numbers come **only** from HOLDOUT
  and from the full-corpus rerun (`--split all`). TUNE numbers may appear only
  in an appendix labelled TUNE.
- Every full-corpus row is labelled **"includes TUNE"**: it contains the
  TUNE questions the configuration was chosen on (LoCoMo 847 of 1,986;
  LongMemEval-S 150 of 500), so it favours our tuned rows over Mem0.
- Every configuration choice is frozen, and written in the report, **before**
  HOLDOUT is run. HOLDOUT is run once per frozen configuration.
- **HOLDOUT audit log.** Nothing in the harness stops a second HOLDOUT run, so
  the GitHub Actions run history of `benchmark-matched` is the audit log. The
  report lists **every** run in that history with `split=holdout` (run URL,
  commit, inputs, date, and whether its numbers are reported), including
  failed, cancelled and smoke runs. HOLDOUT is not run locally, except
  wiring smokes of at most 5 questions whose numbers are not looked at for
  tuning; those are listed too. One such smoke ran before this amendment:
  the G0 verification's 5-question LoCoMo HOLDOUT smoke (`--systems none`,
  conv-26 questions 0-4), which checked the split filter only.
- Every remaining loss is published, in the same table as the wins, with the
  tie rule of section 4 applied as written.

## 6. Baseline

Every before/after delta is measured against one pinned tree, not against a
moving `main` and not against the 2.0.0-rc.8 numbers in `COMPARISON.md`:

- baseline commit `9afb98e991620a225551bb2c983da3913b402bb6` (3.0.0-rc.3
  tree), full-corpus run
  [40866695886](https://github.com/28naem-del/mnemosyne/actions/runs/40866695886)
  (`split=all`, K = 5, 10, 20, all four modes and Mem0 `infer:false`);
- the baseline's HOLDOUT rows come from the same commit run with
  `split=holdout` through the same workflow. That run is a HOLDOUT run and is
  listed in the audit log like any other;
- harness settings are the baseline's unless the report names a change:
  4,096-byte chunks, `maxContextUnits` 8,192, rerank top-N 50, turn
  granularity, `--engine-opts {}`.

## 7. Mem0 with LLM extraction (`infer:true`)

Mem0's earlier `infer:true` result beat our reranked allHit on one LoCoMo
part (2026-09-15), so it is in the protocol, not an aside.

- Scope: **LoCoMo only**, the full corpus (1,986 questions), K = 5, 10 and 20,
  scored by the same harness code and chunk set as every other row.
  Extraction uses `openai/gpt-4o-mini` through OpenRouter, as on 2026-09-15,
  with our injected embedder as for `infer:false`.
- Tables: it appears in the same LoCoMo tables as every other row, on the
  full corpus (labelled "includes TUNE") and as HOLDOUT-only and TUNE-only
  breakdowns computed from its per-question rows with
  `benchmarks/splits/locomo.json`. The denominators are the same annotated
  questions as every other row.
- Cost cap: **$25** total for this run. The cost is estimated before the run
  from the chunk count and the measured cost per chunk; if the estimate is
  over the cap the run does not start. The actual spend is reported.
- LongMemEval-S `infer:true` is **not run**: its estimate is far over the cap.
  The report publishes the estimate (chunks, cost per chunk, total cost and
  time) and its derivation instead of a number.
- It is never compared against a bar as if it were the `infer:false` row; the
  bars in section 4 are against `infer:false`.

## 8. Disclosures

- **Mem0's default embedder is not run.** Mem0 OSS 3.1.8's default embedder
  is OpenAI `text-embedding-3-small`, a remote, paid API. It is not run because (a) that would be a
  metered call outside the spend authorized for this work, and (b) a
  different embedder would make the rows differ in two things, embedder and
  retrieval, so the table could not attribute a difference to retrieval. Mem0
  with its own default embedder could score higher or lower than reported
  here; the report says so.
- **LongMemEval-S distractor overlap.** LongMemEval-S draws every question's
  haystack from a shared pool of sessions, so TUNE and HOLDOUT haystacks share
  text: 1,796 haystack session ids appear on both sides, 6 HOLDOUT answer
  sessions appear in TUNE haystacks (and 6 the other way), and 11 `_abs`/base
  question pairs straddle the split (the `_abs` questions are outside the
  positive metrics). No label crosses the split and every run builds its
  index per haystack, so ranking statistics never span the split; the overlap
  is text, not answers. It is disclosed because tuning on TUNE has seen the
  distractor text HOLDOUT is scored against.
- **Pre-protocol exposure.** The current defaults (rrfK 10, rerank top-N 50,
  4,096-byte chunks) were chosen while the full corpora were visible
  (2026-09-14/15 runs). HOLDOUT is fresh only for tuning done from this
  protocol on.

## 9. Tuning mechanics

Tuning changes engine configuration through one generic harness option,
`--engine-opts '<json>'` (workflow input `engine_opts`, default `{}`), merged
over the harness's engine configuration for every Mnemosyne row. Sections:
`memory` (`createLocalMemory` options such as `rrfK`, `minSimilarity`,
`granularity`), `hybrid` (`rrfK`, `fusionWeights` `{lexical, dense}`,
`rerankTopN`, `maxCandidates`), `embedder` and `reranker` (ONNX `batchSize`,
`threads`). `{}` is exactly the baseline configuration. The requested JSON and
the merged configuration are written to every raw report
(`matched.engineOpts`, `matched.engineConfig`), and parts with different
engine options refuse to merge. The frozen configuration in the report is
that JSON.
