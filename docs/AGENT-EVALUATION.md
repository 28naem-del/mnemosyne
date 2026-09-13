# Matched agent-memory experiments

The `mnemosy-ai/evaluation` module runs the same reader against isolated memory conditions. It measures answer correctness, action/abstention decisions, provenance, stale actions and harmful memory separately. This fills the evaluation plumbing gap; running the harness on synthetic fixtures does **not** establish superior model performance.

## What is controlled

- One explicit reader/model revision, the same trial seed and output allowance for every condition.
- Fresh memory state for each condition, episode and trial; updates and erasure arrive in the same order.
- Rotated condition order to reduce systematic ordering effects.
- The complete memory envelope, including citation keys and JSON escaping, fits the context allowance. Default units are UTF-8 **bytes**, not estimated model tokens. A named exact tokenizer can be supplied through the SDK.
- Answer labels, source labels used by the grader, categories and task identities are withheld from the reader callback.
- Failed, cancelled and budget-exhausted attempts remain in the success denominator. Cleanup failures make a report incomplete.

The four shipped conditions are no memory, current facts in recency order, Mnemosyne lexical retrieval and Mnemosyne adaptive context. The recency condition is a plain-history baseline; it is not an LLM summarizer. Adaptive selection uses no extra model calls in this experiment. Supply additional `BenchmarkCondition` factories for a strong summary baseline or a particular competitor version. Those integrations and their external computation must be recorded by the experiment owner; the harness cannot authenticate a callback's model or hidden spending.

## Run with an explicitly chosen model

Create a local provider configuration containing `baseUrl`, `model` and `revision`. An optional `apiKeyEnv` names the one environment variable to read; no provider, credential or account is discovered automatically. HTTPS is required except for local endpoints. Requests reject redirects. Constructing an adapter makes no request.

```json
{
  "baseUrl": "http://127.0.0.1:8000/v1",
  "model": "your-served-model",
  "revision": "your-exact-model-revision"
}
```

```sh
mnemosy benchmark-agent --file held-out-tasks.json \
  --provider-config provider.json --out results.json \
  --json '{"trials":3,"maxContextUnits":8192,"maxOutputTokens":512,"maxReaderCalls":600,"timeoutMs":600000}'
```

This command calls the chosen model. The output is created exclusively with private permissions before any reader request, so an existing report is never replaced. No live memory database is opened. Keep the dataset, configuration, model revision and report together. `includeResponses` defaults to false: reports retain answer hashes and scores, not source text or returned answers. Queries and memory still reach the explicitly selected provider.

## Dataset format

```json
{
  "protocol": "mnemosyne-agent-benchmark-v1",
  "name": "Deployment updates",
  "revision": "1",
  "split": "test",
  "episodes": [{
    "id": "project",
    "category": "updates",
    "events": [
      {"operation":"remember","key":"region","text":"Deployment region: Oslo."},
      {"operation":"correct","key":"region","text":"Deployment region: Bern."},
      {"operation":"task","id":"current","query":"Deployment region?","answers":["Bern"],"action":"act","evidenceKeys":["region"],"staleAnswers":["Oslo"]},
      {"operation":"forget","key":"region"},
      {"operation":"task","id":"erased","query":"Deployment region?","answers":["unknown"],"action":"abstain","evidenceKeys":[]}
    ]
  }]
}
```

Use distinct immutable identities and explicit update events. Source keys cannot be silently reused after erasure. The parser bounds bytes, depth through the declared schema, event counts and planned attempts. Calling a dataset `test` does not make it held out: freeze it before tuning and keep reference labels out of the implementation workflow.

## Reading the result

`successRate` requires a correct normalized exact answer and the correct act/abstain decision. `groundedSuccessRate` additionally requires valid citations that cover the labeled evidence. A no-memory reader can succeed without citations; otherwise provenance would manufacture an apparent memory advantage. `positiveTransferRate` measures success where the paired no-memory attempt failed; `negativeTransferRate` measures failure where that baseline succeeded.

`staleActionRate`, `unsupportedAnswerRate`, answer accuracy, action accuracy, context units and latency are separate measurements. Provider failures are reported, not guessed to be stale answers. `observedAnyTrialSuccessRate` and `allTrialsSuccessRate` describe observed repeated trials; neither is an unbiased pass@k estimate. Provider-reported token usage comes from the response envelope, never a usage field generated inside the answer.

This is a text-answer/decision harness, not a browser or shell task executor. The exact-match grader does not measure arbitrary open-ended work. There is no learned judge, automatically running competitor service, billing meter or hardware-controlled latency benchmark. Callbacks must honor cancellation and clean up their own external resources; the harness bounds waiting but cannot forcibly stop arbitrary external code.

The [scripted example](../examples/agent-benchmark.ts) checks the experiment machinery without a network or model. Public evaluations such as [LongMemEval](https://github.com/xiaowu0162/LongMemEval), [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) and [LoCoMo](https://github.com/snap-research/locomo) have their own datasets and evaluation protocols. This harness is not an official implementation of those protocols. Mnemosyne's existing LongMemEval retrieval result remains a retrieval measurement, not an answer-quality or competitor score.
