# Memory-system comparison

The maintained feature comparison is [docs/comparison.md](docs/comparison.md): source-linked design
tradeoffs, not a blanket feature/novelty scorecard.

A **matched competitor benchmark was run** on 14 and 15 September 2026, on the 2.0.0-rc.8 source
tree; it has not been re-run on 3.0. Its numbers are below, losses included. Two runs exist, both scored inside a single process against a single chunk set at a single
K under a single packing budget — competitors are conditions in our own loop, not numbers quoted
from a vendor:

- **14 September 2026, full corpus** — LoCoMo, 1,986 questions, 10 conversations, 1,531 with positive
  evidence labels; plus LongMemEval-S, 50 questions (every 10th of 500, source order).
  Report: [`reports/matched-run-2026-09-14.md`](reports/matched-run-2026-09-14.md).
- **15 September 2026, Mem0 LLM extraction** — the LLM-calling `infer:true` write path (the
  `add()` default in mem0ai 3.1.8), on two whole LoCoMo conversations. Report:
  [`reports/matched-run-2026-09-15-llm-extraction.md`](reports/matched-run-2026-09-15-llm-extraction.md).

Both `reports/` links above are **repository paths, deliberately not shipped in the npm package**:
the raw artifacts behind them are 76 MB uncompressed (2.9 MB gzipped) of per-question benchmark
records, which do not belong in a package tarball. Every number a reader needs is reproduced on this
page, and this page *is* in the package. If you installed from npm, the reports, their SHA-256
fingerprints and the generators that produce them are at
<https://github.com/28naem-del/mnemosyne/tree/main/reports>.

## LoCoMo — 1,986 questions, K = 10 (headline), 14 September

| System | recall@10 | anyHit | allHit | MRR | p95 retrieval |
|---|---:|---:|---:|---:|---:|
| Mnemosyne zero-model overlap | 40.49 | 45.20 | 37.10 | 0.2899 | 3 ms |
| Mnemosyne zero-model BM25 | 52.47 | 58.26 | 47.81 | 0.3696 | 13 ms |
| Mnemosyne hybrid (dense+BM25 RRF) | 62.99 | 69.82 | 57.15 | 0.4606 | 57 ms |
| **Mnemosyne hybrid + rerank** | **73.57** | 80.08 | 67.80 | **0.6240** | 244 ms |
| Mem0 OSS (extraction off) | 63.72 | 70.93 | 57.54 | 0.4756 | 196 ms |
| Zep | not run — `ZEP_API_KEY` is not set | | | | |
| Graphiti | not run — this harness reaches it only through Zep Cloud | | | | |

recall at the other depths, same run: overlap 33.73 / 46.84, BM25 44.95 / 57.98, hybrid 54.68 /
71.18, hybrid + rerank 67.23 / 77.70, Mem0 OSS 55.09 / 71.91 (@5 / @20).

## Where we lose

On the headline row our reranked path scores higher than Mem0 OSS (recall@10 73.57 against 63.72).
That row compares our reranked pipeline with Mem0's unreranked vector search on our embedder. Our
**unreranked** path does not score higher: Mem0 OSS beats it on recall and on MRR at every K
measured. The margin comes from the cross-encoder reranker, not from the hybrid fusion.

| Comparison | K | Mem0 OSS | Mnemosyne | Mnemosyne config compared | Result |
|---|---:|---:|---:|---|---|
| LoCoMo recall@5 | 5 | 55.09 | 54.68 | hybrid, no rerank | **Mem0 wins by 0.41** |
| LoCoMo recall@10 | 10 | 63.72 | 62.99 | hybrid, no rerank | **Mem0 wins by 0.73** |
| LoCoMo recall@20 | 20 | 71.91 | 71.18 | hybrid, no rerank | **Mem0 wins by 0.74** |
| LoCoMo MRR | 5 | 0.4633 | 0.4478 | hybrid, no rerank | **Mem0 wins by 0.0155** |
| LoCoMo MRR | 10 | 0.4756 | 0.4606 | hybrid, no rerank | **Mem0 wins by 0.0149** |
| LoCoMo MRR | 20 | 0.4798 | 0.4667 | hybrid, no rerank | **Mem0 wins by 0.0131** |
| LongMemEval-S recall@20 | 20 | 96.67 | 96.67 | hybrid **+ rerank** | **Tie** |
| LongMemEval-S MRR | 20 | 0.9565 | 0.9415 | hybrid **+ rerank** | **Mem0 wins by 0.0150** |

On LongMemEval-S our reranked path and Mem0 tie exactly on recall@20, and **Mem0 takes MRR**. On the
retrieval task as scored here, Mem0's plain vector search is a strong baseline that beats part of
our stack. Anyone choosing between these systems on retrieval coverage alone, at these K values,
should know that.

## LongMemEval-S — 50 questions (every 10th of 500, source order), K = 20, 14 September

| System | recall@20 | anyHit | allHit | MRR | p95 retrieval |
|---|---:|---:|---:|---:|---:|
| Mnemosyne zero-model overlap | 89.89 | 95.65 | 80.43 | 0.7157 | 7 ms |
| Mnemosyne zero-model BM25 | 96.30 | 100.00 | 89.13 | 0.9127 | 17 ms |
| Mnemosyne hybrid (dense+BM25 RRF) | 96.49 | 100.00 | 89.13 | 0.9410 | 60 ms |
| Mnemosyne hybrid + rerank | 96.67 | 100.00 | 91.30 | 0.9415 | 1896 ms |
| Mem0 OSS (extraction off) | 96.67 | 100.00 | 91.30 | **0.9565** | 210 ms |
| Zep / Graphiti | not run | not run | not run | not run | not run |

## Mem0 with its LLM extraction on — 15 September

The 14 September run measured Mem0 with extraction **off**. `infer:true` is the `add()` default in
mem0ai 3.1.8, so it was rerun on that path over OpenRouter. Two whole LoCoMo conversations, K = 10; denominators
are 79 and 43 annotated questions and are small — they are stated, not buried.

**Part A** — conversation 0, 10/19 sessions, 215 turns, 104 questions (79 annotated):

| System | recall@10 | anyHit | allHit | MRR | p95 | ingest |
|---|---:|---:|---:|---:|---:|---:|
| Mnemosyne zero-model overlap | 47.47 | 49.37 | 45.57 | 0.3158 | 2.2 ms | — |
| Mnemosyne zero-model BM25 | 56.33 | 60.76 | 53.16 | 0.4104 | 6.7 ms | — |
| Mnemosyne hybrid (dense+BM25 RRF) | 67.93 | 72.15 | 63.29 | 0.4956 | 38.4 ms | — |
| **Mnemosyne hybrid + rerank** | **77.85** | 84.81 | 70.89 | **0.6568** | 877.4 ms | — |
| Mem0 OSS (extraction off) | 73.42 | 78.48 | 68.35 | 0.5373 | 191.5 ms | 6.0 s |
| Mem0 OSS, LLM extraction (`infer:true`) | 76.58 | 81.01 | **72.15** | 0.5648 | 237.5 ms | 402.9 s |
| Zep / Graphiti | not run | not run | not run | not run | not run | not run |

**Mem0's paid extraction path takes `allHit` here** — 72.15 against our reranked 70.89.

**Part B** — conversation 1, 11/19 sessions, 212 turns, 57 questions (43 annotated):

| System | recall@10 | anyHit | allHit | MRR | p95 | ingest |
|---|---:|---:|---:|---:|---:|---:|
| Mnemosyne zero-model overlap | 49.81 | 53.49 | 46.51 | 0.3775 | 2.2 ms | — |
| Mnemosyne zero-model BM25 | 62.60 | 65.12 | 60.47 | 0.4467 | 7.6 ms | — |
| Mnemosyne hybrid (dense+BM25 RRF) | 75.39 | 79.07 | 72.09 | 0.5436 | 29.2 ms | — |
| **Mnemosyne hybrid + rerank** | **79.07** | 81.40 | **76.74** | **0.6772** | 272.3 ms | — |
| Mem0 OSS (extraction off) | 78.29 | 81.40 | 74.42 | 0.5886 | 190.0 ms | 6.4 s |
| Mem0 OSS, LLM extraction (`infer:true`) | 77.13 | 81.40 | 72.09 | 0.6401 | 258.8 ms | 391.2 s |
| Zep / Graphiti | not run | not run | not run | not run | not run | not run |

Our unreranked hybrid loses to Mem0 in both parts and in both of Mem0's extraction modes — by 8.65
and 5.49 in part A, 1.74 and 2.91 in part B. Our reranked margin is thin: +1.27 and +1.94 over
Mem0's paid path, and only **+0.78** over Mem0's free path in part B. On these two
conversations, extraction was not consistently better than no extraction: +3.16 in part A,
**−1.16** in part B, at roughly 65× the ingest time; it did lift MRR in both.

## Exactly what each competitor was

Mem0's full mode strings, carried on the raw reports rather than hand-typed:

```
mem0-oss      mem0-oss@3.1.8, extraction=off(infer:false), retrieval=vector-cosine(exact),
              vectorStore=memory(sqlite,isolated),
              embedder=injected:onnxruntime-node|Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3|int8|cls|l2|512|bge-query-prefix-v1,
              history=disabled, telemetry=disabled, overfetch=1x

mem0-oss-llm  mem0-oss@3.1.8, extraction=llm(openrouter/openai/gpt-4o-mini),
              retrieval=vector-cosine(exact), vectorStore=memory(sqlite,isolated),
              embedder=injected:onnxruntime-node|Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3|int8|cls|l2|512|bge-query-prefix-v1,
              history=disabled, telemetry=disabled, overfetch=4x
```

Mem0 is given **our** embedder in both rows, disclosed in the string. `extraction=off` means Mem0's
LLM fact-extraction write path is switched off; `extraction=llm` is the `add()` default in mem0ai
3.1.8. The extraction model (`openai/gpt-4o-mini` over OpenRouter) was our choice, not part of Mem0's
default configuration.

**Zep — not run.** `ZEP_API_KEY` is not set. The harness reaches Zep only through Zep Cloud, which
needs an account and a `ZEP_API_KEY`. When the run was made (14 September 2026) we found no working
self-hosted alternative: Zep Community Edition was marked deprecated upstream and its compose file
pointed at `zepai/zep:latest`, which we could not pull from Docker Hub (details in the 14 September
report). That may have changed since. No Zep number appears anywhere in these reports — the cell
carries the reason, never an estimate.

**Graphiti — not run.** This repository has no standalone Graphiti adapter:
`benchmarks/competitors/package.json` pins `mem0ai` and `@getzep/zep-cloud` and nothing else, so
Graphiti is reachable from this harness only *through* Zep Cloud, so it did not run either. That is
a limit of this harness, not a statement about Graphiti. No Graphiti number is estimated into a table.

## What these numbers are not

Retrieval coverage, scored by one evidence scorer with **no reader and no judge** (`generation: 0`,
`judge: 0` in every raw report). Not answer accuracy. Not the official LoCoMo category-F1 evaluator
and not an official LongMemEval score. A competitor sees only `{id, text, role?, speaker?, date?}` on
write and a query plus a limit on read; it is credited only for chunk identities it actually
returned.

## Compare on the workload you care about

For retrieval, use the same corpus, questions, ownership rules, temporal cutoff, candidate count,
tokenizer and context budget. Report evidence coverage both before and after packing, plus
exclusions, overflows, provider cost and latency. A matching session ID can still miss the
answer-bearing passage.
