# Matched run — 15 September 2026: Mem0's LLM-extraction path, measured

The [14 September matched run](matched-run-2026-09-14.md) published `Mem0 OSS, LLM extraction
(infer:true)` as **not run — spend not authorised**, with an estimate and its arithmetic. That spend
was later authorised. This report replaces the estimate with a measurement, on the same harness and
under the same rule: one process, one chunk set, one K, one packing budget, one evidence scorer, no
vendor-quoted numbers, and the losing number printed in the same table and the same font as the
winning one.

**It does not replace the 14 September numbers.** This run is scored on two LoCoMo *parts*, not on
the full 1,986-question corpus — see [Why parts and not the full corpus](#why-parts-and-not-the-full-corpus),
which is a wall-clock limit, not a money limit, with the measured arithmetic. Nothing here should be
read against the full-corpus table. The rows *inside* each part are comparable to each other, which
is the whole point of a matched run.

## What changed since 14 September

| Row | 14 September | 15 September (this run) |
|---|---|---|
| Mem0 OSS, extraction off (`infer:false`) | measured, full corpus | measured again, per part |
| **Mem0 OSS, LLM extraction (`infer:true`)** | **not run — spend not authorised** | **measured, per part** |
| Zep | not run — `ZEP_API_KEY` is not set | unchanged, same reason, printed by the harness |
| Graphiti | not run — reachable only through Zep | unchanged, same reason |

## Identical for every row

| Parameter | Value |
|---|---|
| Retrieval depth K | 10 |
| Context budget | 8192 units (`utf8-bytes-v1`) |
| Chunk size | 4096 bytes, contiguous UTF-8 spans |
| Reader / judge | none — this measures retrieval coverage, not answer accuracy |
| Generative calls made by the harness | 0 (`generation: 0`, `judge: 0` in both raw reports) |
| Embedder, every dense row including both of Mem0's | `onnxruntime-node \| Xenova/bge-small-en-v1.5@ea104dac \| int8 \| cls \| l2 \| 512` (384d) |
| Extraction LLM, Mem0 `infer:true` row only | `openai/gpt-4o-mini` via OpenRouter |

Mem0 is given **our** embedder in both of its rows, so the only difference between those two rows is
the extraction path. That substitution is a modification of Mem0's default configuration; it is
named in the row's mode string below, as it was on 14 September.

## Part A — LoCoMo conversation 0, 10 of 19 sessions, 215 turns, 104 questions (79 with positive evidence)

| System | recall@10 | anyHit | allHit | MRR | p95 retrieval | ingest |
|---|---:|---:|---:|---:|---:|---:|
| Mnemosyne zero-model overlap | 47.47 | 49.37 | 45.57 | 0.3158 | 2.2 ms | — |
| Mnemosyne zero-model BM25 | 56.33 | 60.76 | 53.16 | 0.4104 | 6.7 ms | — |
| Mnemosyne hybrid (dense+BM25 RRF) | 67.93 | 72.15 | 63.29 | 0.4956 | 38.4 ms | — |
| Mnemosyne hybrid + rerank | 77.85 | 84.81 | 70.89 | 0.6568 | 877.4 ms | — |
| Mem0 OSS (extraction off) | 73.42 | 78.48 | 68.35 | 0.5373 | 191.5 ms | 6.0 s |
| Mem0 OSS, LLM extraction (infer:true) | 76.58 | 81.01 | 72.15 | 0.5648 | 237.5 ms | 402.9 s |
| Zep / Graphiti | not run | not run | not run | not run | not run | not run |

## Part B — LoCoMo conversation 1, 11 of 19 sessions, 212 turns, 57 questions (43 with positive evidence)

| System | recall@10 | anyHit | allHit | MRR | p95 retrieval | ingest |
|---|---:|---:|---:|---:|---:|---:|
| Mnemosyne zero-model overlap | 49.81 | 53.49 | 46.51 | 0.3775 | 2.2 ms | — |
| Mnemosyne zero-model BM25 | 62.60 | 65.12 | 60.47 | 0.4467 | 7.6 ms | — |
| Mnemosyne hybrid (dense+BM25 RRF) | 75.39 | 79.07 | 72.09 | 0.5436 | 29.2 ms | — |
| Mnemosyne hybrid + rerank | 79.07 | 81.40 | 76.74 | 0.6772 | 272.3 ms | — |
| Mem0 OSS (extraction off) | 78.29 | 81.40 | 74.42 | 0.5886 | 190.0 ms | 6.4 s |
| Mem0 OSS, LLM extraction (infer:true) | 77.13 | 81.40 | 72.09 | 0.6401 | 258.8 ms | 391.2 s |
| Zep / Graphiti | not run | not run | not run | not run | not run | not run |

## Where we lose

Our reranked path wins both parts. Beyond that the result refuses to be tidy, so here is all of it.

- **Our unreranked path loses to Mem0 in both parts, in both of Mem0's extraction modes** — by as
  much as 8.65 points. This is the same finding the 14 September run published at full scale, and
  paying for extraction did not rescue it: the cross-encoder is what wins this comparison, not the
  RRF fusion.
- **The reranked margin is thin here.** +1.27 and +1.94 against Mem0's paid extraction path, and
  only **+0.78** against Mem0's *free* extraction-off row in part B. At full-corpus scale on
  14 September that margin was ~9.85 points against extraction-off. Two parts of 79 and 43 annotated
  questions cannot settle which figure is representative, and this report does not claim they can.
- **MRR is the one place the lead is comfortable** (+0.0920 and +0.0371), which is a reversal of the
  14 September LongMemEval result where Mem0 took MRR.

| Comparison | Part | Mem0 | Mnemosyne | Mnemosyne config compared | Result |
|---|---|---:|---:|---|---|
| recall@10 vs LLM extraction | A | 76.58 | 67.93 | hybrid, no rerank | **Mem0 wins by 8.65** |
| recall@10 vs LLM extraction | B | 77.13 | 75.39 | hybrid, no rerank | **Mem0 wins by 1.74** |
| recall@10 vs extraction off | A | 73.42 | 67.93 | hybrid, no rerank | **Mem0 wins by 5.49** |
| recall@10 vs extraction off | B | 78.29 | 75.39 | hybrid, no rerank | **Mem0 wins by 2.91** |
| recall@10 vs LLM extraction | A | 76.58 | 77.85 | hybrid **+ rerank** | Mnemosyne wins by 1.27 |
| recall@10 vs LLM extraction | B | 77.13 | 79.07 | hybrid **+ rerank** | Mnemosyne wins by 1.94 |
| recall@10 vs extraction off | A | 73.42 | 77.85 | hybrid **+ rerank** | Mnemosyne wins by 4.43 |
| recall@10 vs extraction off | B | 78.29 | 79.07 | hybrid **+ rerank** | Mnemosyne wins by 0.78 |
| MRR vs LLM extraction | A | 0.5648 | 0.6568 | hybrid **+ rerank** | Mnemosyne wins by 0.0920 |
| MRR vs LLM extraction | B | 0.6401 | 0.6772 | hybrid **+ rerank** | Mnemosyne wins by 0.0371 |

## Extraction on vs off, inside Mem0

**LLM extraction does not reliably beat no extraction.** It gained 3.16 points in part A and *lost*
1.16 points in part B, for ~65x the ingestion time and all of the cost. Where it clearly helps is
ordering rather than coverage: MRR rises in both parts (0.5373 → 0.5648 and 0.5886 → 0.6401) while
recall does not. On this retrieval task, at this K, the expensive path is not dependably the better
path — and that is a finding about *this* task, not a claim that extraction is useless in general.
A reader with a generative reader downstream would weigh the MRR gain differently.

| Part | extraction off | LLM extraction | Delta | Ingest off | Ingest LLM | Slowdown |
|---|---:|---:|---:|---:|---:|---:|
| A | 73.42 | 76.58 | +3.16 | 6.0 s | 402.9 s | 67x |
| B | 78.29 | 77.13 | -1.16 | 6.4 s | 391.2 s | 61x |

## Why parts and not the full corpus

Mem0's `infer:true` write path makes its LLM calls **one `add()` at a time, sequentially** — the
adapter deliberately does not batch, because memories extracted from a batch cannot be attributed
back to a source chunk and therefore cannot be scored. Measured on this run: 1.87 s/chunk in part A
and 1.85 s/chunk in part B, **1.86 s/chunk blended**. The full LoCoMo corpus is 5,882 chunks:

| | measured here | full corpus, projected |
|---|---:|---:|
| Chunks ingested with `infer:true` | 427 | 5,882 |
| Wall-clock ingestion | 794.1 s (13 min) | **≈ 3 h 2 min** |
| OpenRouter spend | $0.309895 | **≈ $4.27** |

The spend figure is the two scored parts plus the $0.009802 that posted after part B finished; using
only the two instantaneous post-run readings ($0.300) the projection would read $4.13, which would be
an artefact of OpenRouter's accounting lag rather than a cheaper run.

The binding limit is **time, not money** — the projected full-corpus cost sits well inside the
authorised ceiling. The 14 September estimate of ~$2.80 for this path had the right order of
magnitude; the measured rate is $0.000726 per chunk against that estimate's $0.00048.

## Spend

Read from the OpenRouter credits endpoint immediately before and after each scored run. The key was
supplied through the process environment; it appears in no argument, no log, and no file here.

| Point | `total_usage` | Delta |
|---|---:|---:|
| Before the wiring probe | 194.950806 | — |
| Before part A | 194.955088 | $0.004282 — 5-chunk wiring probe plus a 10-chunk end-to-end test |
| After part A | 195.114505 | **$0.159417** — 215 chunks |
| After part B | 195.255181 | **$0.140676** — 212 chunks |
| Settled, 46 s later | 195.264983 | $0.009802 posted late |
| **Total for this job** | | **$0.314177**, against a $30 ceiling |

That last row is worth knowing if you reproduce this: OpenRouter's usage accounting lags the
requests, so a reading taken the instant a run ends understates it. Every figure above is an
account-level `total_usage` delta, not an estimate derived from token counts.

## Systems that could not run, and exactly why

Printed by the harness itself, not written by hand:

```
zep    not run — ZEP_API_KEY is not set. Zep needs a Zep Cloud account and a ZEP_API_KEY.
       Zep Community Edition, the self-hostable server, is deprecated upstream and its own
       compose file points at zepai/zep:latest, which no longer exists on Docker Hub, so
       there is no free self-hosted path. Graphiti, the engine underneath Zep, additionally
       needs a graph store and a generative LLM for episode ingestion.
```

**Graphiti has no standalone adapter in this repository.** `benchmarks/competitors/package.json`
pins `mem0ai` and `@getzep/zep-cloud` and nothing else; Graphiti is reachable from here only
*through* Zep Cloud, which needs a paid Zep account. Graphiti spend was authorised for this pass and
Zep spend was not, so the path stays closed. That is a harness fact rather than a key problem, and
no Graphiti number is estimated into a table.

## What this does NOT show

- **Two parts, 427 turns of a 5,882-turn corpus.** Small denominators — 79 and 43 annotated
  questions. A one- or two-point difference here is not resolved by this data.
- **One run per part.** Mem0's extraction path is generative and is not deterministic across runs;
  the run-to-run spread was not measured. The Mnemosyne rows are deterministic and were not repeated
  either.
- **Retrieval coverage only.** No reader, no judge, no answer accuracy. A system that retrieves worse
  can still answer better.
- **Mem0 runs with our embedder injected**, in both of its rows. That is not Mem0's default.
- Category 5 (adversarial / unanswerable) questions are excluded from positive-retrieval metrics and
  remain visible in the raw reports.
- Nothing here re-measures Mnemosyne against 14 September: the merged tree's retrieval defaults
  changed in rc.10, and the rows above are the rc.10 tree scoring itself, not a regression check.

## Provenance

### Mode strings, exactly as the harness recorded them

Part A:

```
mem0-oss  mem0-oss@3.1.8, extraction=off(infer:false), retrieval=vector-cosine(exact), vectorStore=memory(sqlite,isolated), embedder=injected:onnxruntime-node|Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3|int8|cls|l2|512|bge-query-prefix-v1, history=disabled, telemetry=disabled, overfetch=1x
mem0-oss-llm  mem0-oss@3.1.8, extraction=llm(openrouter/openai/gpt-4o-mini), retrieval=vector-cosine(exact), vectorStore=memory(sqlite,isolated), embedder=injected:onnxruntime-node|Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3|int8|cls|l2|512|bge-query-prefix-v1, history=disabled, telemetry=disabled, overfetch=4x
```

Part B:

```
mem0-oss  mem0-oss@3.1.8, extraction=off(infer:false), retrieval=vector-cosine(exact), vectorStore=memory(sqlite,isolated), embedder=injected:onnxruntime-node|Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3|int8|cls|l2|512|bge-query-prefix-v1, history=disabled, telemetry=disabled, overfetch=1x
mem0-oss-llm  mem0-oss@3.1.8, extraction=llm(openrouter/openai/gpt-4o-mini), retrieval=vector-cosine(exact), vectorStore=memory(sqlite,isolated), embedder=injected:onnxruntime-node|Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3|int8|cls|l2|512|bge-query-prefix-v1, history=disabled, telemetry=disabled, overfetch=4x
```

### Corpus digests and generative call counts

| Part | Normalized corpus SHA256 | Questions | generation | judge |
|---|---|---:|---:|---:|
| A | `689b45320e1f2afbc1f4ca14d61b93d18d777868793c4fbbb2bcc8bdcc616530` | 104 | 0 | 0 |
| B | `6f552bc646a834b0099e435af581b479842476f5129d7f5fc890fed4ee9a5146` | 57 | 0 | 0 |

The two parts are derived rather than shipped: LoCoMo is CC BY-NC 4.0 and is not redistributed here.
`make-parts.mjs` rebuilds them from the licensed corpus, taking whole sessions in order up to a turn
budget and keeping only the questions whose every evidence turn survives the cut, so a missed hit is
a retrieval miss and never a corpus artefact.

Rebuilding the parts today reproduces the scored corpora exactly. The rebuilt files are not
byte-identical to the ones this run consumed — the originals were serialised with spaces after the
JSON separators and the committed script writes compact JSON — but they are deep-equal, and the
harness's own normalised digest, the one pinned in each raw report above, matches.

## Reproduce

```bash
npm ci
npm approve-scripts onnxruntime-node       # required; postinstall builds the ONNX binding
npm run build
npm run benchmark:matched:install          # npm ci --prefix benchmarks/competitors
npm run benchmark:fetch -- --corpus locomo # writes benchmarks/data/locomo10.json (CC BY-NC 4.0)

node reports/matched-run-2026-09-15-llm-extraction/make-parts.mjs --out /tmp/parts
OPENROUTER_API_KEY=… node reports/matched-run-2026-09-15-llm-extraction/run-matched-mem0-llm.mjs \
  --file /tmp/parts/locomo-partA.json --top-k 10 --out /tmp/partA.json
node reports/matched-run-2026-09-15-llm-extraction/make-tables.mjs   # regenerates every table above
```

`npm run benchmark:matched` refuses `--mem0-extraction llm` by design — the shipped command is wired
to no key, and that guard is why an unattended benchmark run cannot start billing anyone. The runner
above supplies the LLM configuration explicitly and differs in nothing else: same adapter, same
harness, same options, same shipped code. It was written for this run and the tree it measures was
not modified to accommodate it.

## Artifacts

| File | What it is |
|---|---|
| [`locomo-partA-k10.json.gz`](matched-run-2026-09-15-llm-extraction/locomo-partA-k10.json.gz) | Part A raw report, K=10, every system, per-question attempt records |
| [`locomo-partB-k10.json.gz`](matched-run-2026-09-15-llm-extraction/locomo-partB-k10.json.gz) | Part B raw report, K=10 |
| [`make-parts.mjs`](matched-run-2026-09-15-llm-extraction/make-parts.mjs) | Derives both parts from the licensed corpus |
| [`run-matched-mem0-llm.mjs`](matched-run-2026-09-15-llm-extraction/run-matched-mem0-llm.mjs) | The runner that produced the raw reports |
| [`make-tables.mjs`](matched-run-2026-09-15-llm-extraction/make-tables.mjs) | Regenerates every table in this report from the raw reports |
