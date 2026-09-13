# Corpus retrieval evaluation

This runner measures whether source evidence is retrieved and survives context packing. It does not generate answers, evaluate abstention behavior, call a judge, or produce official LongMemEval, LoCoMo or BEAM scores. The [measurement index](BENCHMARKS.md) links the actual reports; the [manifest](corpus-manifest.json) pins their SHA256 digests, source provenance, runtime fingerprints and settings.

## What is compared

Every condition receives the same original history and the same question. All context is rendered with the same JSON evidence envelope and measured using the same accounting function.

| Condition | Behavior |
|---|---|
| `no-memory` | Empty evidence envelope. |
| `full-context` | Complete original history, only when the complete envelope fits. Overflow supplies no evidence and remains in the packed-coverage denominator. |
| `lexical` | Existing overlap retrieval, with an explicit top-K and candidate budget. |
| `bm25` | Optional paired BM25 retrieval, enabled with `includeBm25: true`. It does not replace or change the overlap baseline. |
| `hybrid` | Optional lexical/vector retrieval, enabled only when the caller supplies an embedder. `hybridLexicalScoring` selects `overlap` or `bm25`. |

The default context budget is **8,192 UTF-8 bytes, not tokens**. SDK callers can supply an exact model tokenizer as `countContext` with an explicit `accountingId`; all conditions then use that same function. The budget covers the full evidence envelope, not a hypothetical model's system prompt, question or output allocation. Those additional allocations must be reserved separately before a generated-answer experiment.

The default K is 20 chunks of at most 4,096 UTF-8 bytes. Splitting is deterministic, lossless and Unicode safe; selected output records retain each original turn ID and byte span. This resolves the oversized-turn exclusion in the old LongMemEval adapter without silently shortening the history or changing that adapter's existing contract. Context packing selects whole chunks in rank order, skipping a chunk when it does not fit; it never uses gold answers to choose passages.

## Protocol and label isolation

`CorpusDataset` contains distinct `corpora`, `questions` and evaluator-only `labels` arrays. The [synthetic fixture](fixtures/synthetic-corpus.json) is a complete small example.

- Corpus turns contain original text, source identity and optional original speaker/date. Generated summaries, observations, answer labels and `has_answer` fields are excluded by the adapters.
- Questions contain a query, corpus reference, question ID and category. Only the query reaches retrieval or query embedding.
- Labels contain source evidence groups, answerability, answer-schema status and optional reference answers/rubrics. The runner does not even copy reference answers into its runtime snapshot.
- An opaque, deterministic chunk ID is stored in the temporary index. Original evidence IDs are resolved only by the scorer. The embedder receives source text and query text, without grading IDs, categories or reference answers.
- Every corpus uses a fresh in-memory database and fixed ingestion timestamps. No user database or configured agent memory is opened. Original dates are delivered as context but this retrieval experiment does not test temporal mutation semantics.

The normalized input digest covers the evaluation structure, questions, source content and evidence labels used by the scorer, while excluding unused reference answers. CLI adapters record the original raw-file SHA256 and revision. A runtime implementation digest records the sorted relative paths and bytes of the JS files under `dist` (or TS under `src` when executed from source). Do not rebuild those files during a run. Revision, license and provider identity are caller declarations, not independent attestations.

## Interpret results correctly

Raw retrieval and packed-context coverage are reported separately. A group hit means at least one selected chunk belongs to an annotated original turn or session. For LongMemEval, retrieving any passage from an annotated session counts as a session hit; this is weaker than delivering the answer-bearing passage. Precision is over unique source groups, while reciprocal rank uses chunk order. Neither is answer correctness or citation entailment.

Unanswerable and unannotated questions retain attempts and schema status but have null positive-evidence metrics. They are not silently counted as correct. Failures remain visible and contribute zero when positive evidence was annotated. Full-context overflow contributes zero packed evidence; its raw retrieval coverage can still be 100% because it starts with all history. `complete: true` means every condition finished or explicitly overflowed, not that all contexts fit.

Retrieval timing reports p50/p95 over completed and overflow attempts. It excludes ingestion, embedding indexing and packing, which are measured separately. Conditions run in a fixed order; these are descriptive local timings, not controlled service-latency benchmarks. The provider call counter measures requests and UTF-8 input bytes, not token usage or monetary cost.

The full500 paired report uses 470 positive-evidence questions and retains all 30 abstention questions. BM25 improved all-evidence retrieval on 47 questions, regressed on 8 and tied on 415. After packing it improved 32, regressed on 17 and tied on 421. It is a measured improvement under these settings, not a universal win or a comparison against another vendor's system. The old 499-question runner and its differently defined denominators are not a matched comparison.

## Reproduce without model calls

Build with a supported Node version (the checked-in full500 report used Node 22.16.0 on macOS arm64):

```sh
npm ci
npm run build
node dist/evaluation/corpus-cli.js --format normalized \
  --file docs/evaluation/fixtures/synthetic-corpus.json \
  --json '{"includeBm25":true}' --out /tmp/synthetic-corpus-report.json
```

Output paths must be new: the CLI refuses overwrites and symlink inputs. It makes no automatic provider choice and does not search environment variables for API keys.

The generated index can be checked in CI without changing any files:

```sh
node scripts/benchmark-index.mjs --check --out docs/evaluation/BENCHMARKS.md \
  docs/evaluation/reports/longmemeval-s500-corpus-paired-bm25.json \
  docs/evaluation/reports/synthetic-corpus-smoke.json
```

Use the same command without `--check` to regenerate the index from those reports. A check fails when the index differs, including its relative report links.

Acquire the cleaned LongMemEval-S file separately from its [pinned source](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json), respecting the upstream license. Its SHA256 is `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.

```sh
node --max-old-space-size=6144 dist/evaluation/corpus-cli.js \
  --format longmemeval --file /path/to/longmemeval_s_cleaned.json \
  --dataset-label LongMemEval-S-cleaned-full500 \
  --dataset-revision 98d7416c24c778c2fee6e6f3006e7a073259d48f --license MIT \
  --source-url https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json \
  --timestamp-policy question-day \
  --json '{"topK":20,"chunkBytes":4096,"maxContextUnits":8192,"maxCandidates":10000,"timeoutMs":600000,"includeBm25":true}' \
  --out /tmp/longmemeval-s500-corpus.json
```

The explicit `question-day` policy admits source sessions later on the question's stated calendar day and reports their count. Default `strict-instant` rejects any later session instead. Neither silently drops data. Histories and questions are processed in dataset order; there is no random sample or question-specific tuning.

## Additional dataset adapters

The adapters ingest official repository JSON shapes, but do not run those projects' official answer evaluators:

- **LoCoMo:** [pinned original dialogue](https://raw.githubusercontent.com/snap-research/locomo/3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376/data/locomo10.json). `--format locomo --file DATA.json --dataset-revision REV --license 'CC BY-NC 4.0' --out NEW.json`. All five categories remain present. Category 5's adversarial answer is never used as truth. Raw dates with no timezone remain raw. Generated observations/session summaries are excluded. No raw LoCoMo dataset is bundled or relicensed by this repository; its noncommercial restriction still applies to users acquiring it.
- **BEAM:** pinned revision `b2da22eac88bb0874c64665f13457eb99835774a` of [the dataset repository](https://github.com/mohammadtavakoli78/BEAM/tree/b2da22eac88bb0874c64665f13457eb99835774a). `--format beam --file chat.json --questions probing_questions.json --dataset-revision REV --license 'CC BY-SA 4.0' --out NEW.json`. Supply the normalized repository JSON, not Python-literal question strings. Numeric chat ID zero and recursively nested evidence-ID objects are supported. Answers, ideal responses, expected compliance and rubrics stay private; unknown schemas are reported without removing their questions. Conflicting answer/rubric values remain intact and unscored.

## Optional embedding condition and SDK

An SDK caller can use `adaptLongMemEvalCorpus`, `adaptLoCoMoCorpus` or `adaptBeamCorpus`, then `runCorpusBenchmark(dataset, options)`. They are exported by `src/evaluation/corpus-benchmark.ts` and compile to `dist/evaluation/corpus-benchmark.js`. Source histories and private labels should be prepared before invoking any model callbacks.

```js
import { runCorpusBenchmark } from './dist/evaluation/corpus-benchmark.js';
const report = await runCorpusBenchmark(dataset, {
  includeBm25: true,
  maxContextUnits: 8192,
  maxCandidates: 10000,
});
```

The CLI enables hybrid only with `--embedding-config FILE.json`, containing an explicit compatible endpoint, model, revision, dimensions and optional `apiKeyEnv` variable name. An example configuration shape is `{"baseUrl":"http://127.0.0.1:1234/v1","model":"your-embedding-model","revision":"your-pinned-revision","dimensions":768}`. Providing this option authorizes that run to contact the endpoint; use a locally hosted model for an offline model experiment. The checked-in full500 report used no embedding endpoint. Embedding input/call limits, timeout and cancellation apply, and failures remain in the report. There is no generation or judge endpoint in this runner.

A credible generated-answer comparison is a separate experiment: pin the reader, tokenizer, prompts, output budget and official evaluator per dataset; keep private labels outside the reader; score abstention and unsupported schemas explicitly; disclose costs and all exclusions. No such result is claimed here.
