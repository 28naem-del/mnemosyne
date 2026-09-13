# LongMemEval retrieval evaluation

This adapter accepts caller-supplied JSON following the original LongMemEval format documented by its authors. It measures retrieval through Mnemosyne's local engine. It does **not** generate answers, run the official judge, download datasets, or establish a published benchmark score.

The upstream format associates questions with timestamped conversation sessions, identifies evidence through `answer_session_ids`, and marks abstention questions using a `_abs` question-ID suffix. The adapter reads that documented v1 format; it does not claim LongMemEval-V2 compatibility. [Official repository and dataset format](https://github.com/xiaowu0162/LongMemEval).

LongMemEval distinguishes retrieval evaluation from downstream answer evaluation. The paper reports retrieval recall and NDCG, while its answer evaluator uses a separate model judge. This runner implements the narrower metrics below and leaves answer quality and abstention accuracy unevaluated. [Paper, section 3.3](https://arxiv.org/html/2410.10813v2), [official answer evaluator](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py).

## Run a supplied batch

With the CLI, supply an existing dataset file explicitly:

```sh
mnemosy evaluate --file /absolute/path/to/supplied-batch.json \
  --limit 20 \
  --json '{"maxQuestions":100,"maxCandidates":1000,"timeoutMs":60000}' \
  --out /absolute/path/to/new-report.json
```

`--limit` sets K. Omit `--out` to print JSON to stdout; output files must be new. `--provider-config /path/to/config.json` explicitly enables the configured embedding adapter. Without that option the command makes no model calls. The CLI accepts bounded runner options through `--json`, while reserving adapters, cancellation, and temporary database placement for its controller. It uses fresh evaluation databases and does not open a live memory database or reuse a workspace scope. Interrupting with SIGINT or SIGTERM cancels the run and removes its temporary databases.

The installed SDK exposes the same functions through:

```ts
import { runLongMemEvalFile, runLongMemEval, parseLongMemEvalDataset } from 'mnemosy-ai/evaluation';
```

From a source checkout, after `npm run build`:

```sh
node --input-type=module - /absolute/path/to/supplied-batch.json <<'JS'
import { runLongMemEvalFile } from './dist/evaluation/longmemeval.js';
const report = await runLongMemEvalFile(process.argv[2], {
  datasetLabel: 'Describe the actual supplied variant or fixture',
  datasetRevision: 'Record its release or revision',
  topK: 20,
  maxQuestions: 100,
  timeoutMs: 60_000,
});
console.log(JSON.stringify(report, null, 2));
JS
```

`runLongMemEval(dataset, options)` accepts an official-style array or its JSON string. `parseLongMemEvalDataset(dataset, options)` exposes the normalized adapter result. `runLongMemEvalFile(path, options)` additionally enforces a bounded regular UTF-8 file read. No CLI or package subpath is required by this source-checkout example.

The accepted fields are `question_id`, `question_type`, `question`, `question_date`, `haystack_session_ids`, `haystack_dates`, `haystack_sessions`, and `answer_session_ids`. Conversation turns require user/assistant roles and textual content. `answer`, `has_answer`, and extension annotations are discarded. The session arrays must align, and every labeled evidence ID must occur in the supplied history. Repeated session occurrences remain separate history entries; evidence metrics deduplicate their IDs.

## What runs

Each question gets a new temporary SQLite database. Only conversation text is indexed, in timestamp order. Role and timestamp provenance is retained. Original session IDs, question IDs, question types, reference answers, and evidence labels are not stored in the index or passed to an embedding adapter. Internal history references use ordinal session/turn positions, so an upstream `answer_` prefix cannot guide retrieval. The question text is supplied only when querying.

History records enter through the validated snapshot importer in batches of at most 128 turns. Their IDs derive only from session/turn ordinals in the ordered history. This makes tied retrieval cutoffs repeatable without using gold answers, evidence annotations, question IDs, or the question's position in a batch to determine retrieval order.

The default baselines are:

- `no-memory`: retrieve nothing.
- `lexical`: retrieve up to K turns using the local lexical engine.

An explicitly supplied `MemoryEmbedder` enables a third `hybrid` baseline. Its model/revision identifier, dimensions, call count, and input bytes appear in the report. The caller owns its provider choice and cost; no provider is selected from environment variables or defaults. `maxEmbeddingCalls` and `maxEmbeddingInputBytes` are enforced before adapter invocation. Generation and judge call counts remain zero.

`maxCandidates` defaults to 1,000 and can be set from 1 to 10,000. It bounds the local engine's lexical SQL candidate set and the hybrid engine's **most-recent vector window**. The effective value appears in `report.limits.maxCandidates`. Indexing the entire supplied history does not mean every vector is searched: older turns outside that window are excluded from the semantic channel. Hybrid fusion uses up to 100 ranked turns per channel before selecting K. Record this setting with results; neither baseline promises exhaustive full-history retrieval.

For retrieved unique session IDs R and labeled evidence session IDs G:

- Evidence-session recall is `|R ∩ G| / |G|`.
- Evidence-session precision is `|R ∩ G| / |R|`; it is zero when G exists but nothing is retrieved.
- Complete-evidence coverage requires every ID in G to be retrieved.
- When G is empty, evidence metrics are null and excluded from evidence averages.

K counts **turns**, so these results are not interchangeable with a system retrieving K entire sessions. Reports include individual retrieval references, macro/micro evidence metrics, and group summaries by question type and answerability. A nonempty context for an unanswerable question is merely retrieval coverage. An empty context does not prove correct semantic abstention. Labeled counterevidence for an unanswerable question is still scored as evidence retrieval.

## Bounds and reproducibility

Defaults: 100 questions, 1,000 sessions and 20,000 turns per question, 16 MiB per question, 64 MiB per dataset, 65,536 bytes per turn, and 60 seconds overall. Optional embedding work defaults to 20 calls and 16 MiB total input. Options can raise the documented numeric limits, up to 500 questions and 512 MiB per input dataset. Larger releases must be supplied in explicit batches. Oversized or malformed inputs fail; they are never silently sampled or truncated.

Benchmark dates in `YYYY/MM/DD (Day) HH:mm` form are interpreted as UTC solely for ordering; ISO 8601 timestamps are also accepted. Original date strings remain in the report. The default `timestampPolicy: "strict-instant"` rejects history after the question instant. An explicit `timestampPolicy: "question-day"` uses 23:59:59.999 on the normalized UTC question day. This compatibility mode admits same-day history later than the question time and still rejects later-day history. Original dates are preserved; the report records the policy, every retrieval cutoff and each count of sessions after the question instant. It is not strict temporal conformance. ISO timestamps with offsets use their normalized UTC day. Empty turns are counted but not indexed.

Temporary databases are closed and removed on success, cancellation, provider failure, and timeout. Every embedding callback has the remaining overall deadline and receives cancellation; late results cannot resume indexing. An adapter that ignores cancellation may continue its own external work after the runner stops waiting. The timeout is cooperative between bounded SQLite operations; it cannot interrupt a single synchronous database statement. Input files are preserved. File reports hash and count the exact source bytes, including an optional UTF-8 BOM; in-memory inputs use their supplied JSON string or JSON serialization. Reports also contain caller labels, effective limits, and provider metadata; matching the schema does not authenticate official dataset provenance. Ordinal record IDs stabilize local tie breaking; reproducible comparisons still require the same engine version, history order, options, and any explicitly supplied embedding implementation.

The tests use small synthetic fixtures approximating the documented schema. No official dataset or external model was used to produce those test results. Answer correctness requires a separate, explicitly authorized generation-and-evaluation run; retrieval results alone cannot justify comparative AI performance claims.

A subsequent [public cleaned S run](evaluation/LONGMEMEVAL-S-BASELINE.md) records 499 supported cases, one explicit exclusion, day-level timestamp compatibility, verified hashes and raw retrieval results. That run is separate from the synthetic tests above.
