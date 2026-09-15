# Matched run — 14 September 2026

**Every number below was produced by one process, on one chunk set, at one K, under one
packing budget, scored by one evidence scorer.** No number here is quoted from a vendor.
No system that could not run has a number; it has a reason. Where we lose, the losing
number is in the same table, in the same font, as the winning one.

Reproduce it:

```sh
npm ci
npm approve-scripts onnxruntime-node       # see the note below — do not skip this
npm run build
npm run benchmark:matched:install          # competitor SDKs, kept out of the package deps
npm run benchmark:fetch -- --corpus locomo
npm run benchmark:matched -- --corpus locomo --top-k 10 --out reports/my-run
```

Two things a fresh clone will otherwise trip over, both found by actually doing it:

- **`npm approve-scripts onnxruntime-node` is required.** Recent npm blocks postinstall scripts by
  default, so the ONNX native binary never lands. The benchmark still runs and still prints correct
  numbers, but the process then aborts during native teardown — **exit code 134 on roughly one run
  in three**, which will read as a failed benchmark in CI. Measured: 1 of 3 runs aborted before
  approving the script, 0 of 5 after.
- **`npm ci` needs a lockfile that includes `onnxruntime-node`.** If it fails with
  `Missing: onnxruntime-node@… from lock file`, the committed lockfile predates the bundled-embedder
  dependency; refresh it with `npm install` once.

## The one rule that makes this a comparison

Published memory-system numbers are mostly not comparable: they use different corpora,
different chunking, different context budgets, different retrieval depths and different
judges. So the systems here are not run in their own harnesses and collected. They are run
**as conditions inside a single loop** — the same `runCorpusBenchmark` pass that produces
our own rows produces theirs. Identical for every row in this report:

| Parameter | Value |
|---|---|
| Retrieval depth K | 5 / 10 / 20 (each reported separately) |
| Context budget | 8192 units (`utf8-bytes-v1`) |
| Chunk size | 4096 bytes, contiguous UTF-8 spans |
| Envelope | `corpus-v1` |
| Reader / judge | none — this is retrieval coverage, not answer accuracy |
| Generative calls | 0 (`generation: 0`, `judge: 0` in every raw report) |

A competitor sees only `{id, text, role?, speaker?, date?}` on write, and a query plus a
limit on read. It never sees an evidence label, a question id, a category, a reference
answer or a condition name, and it is credited only for chunk identities it actually
returned — unknown, duplicate and over-limit identities are rejected.

## LoCoMo — 1986 questions, 10 conversations, 1531 with positive evidence labels

| System | recall@5 | recall@10 | recall@20 |
|---|---:|---:|---:|
| Mnemosyne zero-model overlap | 33.73 | 40.49 | 46.84 |
| Mnemosyne zero-model BM25 | 44.95 | 52.47 | 57.98 |
| Mnemosyne hybrid (dense+BM25 RRF) | 54.68 | 62.99 | 71.18 |
| Mnemosyne hybrid + rerank | 67.23 | 73.57 | 77.70 |
| Mem0 OSS (extraction off) | 55.09 | 63.72 | 71.91 |
| Zep / Graphiti | not run | not run | not run |

### Full metrics by K

**K = 5**

| System | recall@5 | anyHit | allHit | MRR | p95 retrieval |
|---|---:|---:|---:|---:|---:|
| Mnemosyne zero-model overlap | 33.73 | 37.62 | 31.09 | 0.2797 | 4 ms |
| Mnemosyne zero-model BM25 | 44.95 | 49.90 | 41.28 | 0.3584 | 13 ms |
| Mnemosyne hybrid (dense+BM25 RRF) | 54.68 | 60.68 | 49.71 | 0.4478 | 58 ms |
| Mnemosyne hybrid + rerank | 67.23 | 74.00 | 61.66 | 0.6159 | 248 ms |
| Mem0 OSS (extraction off) | 55.09 | 61.99 | 49.84 | 0.4633 | 199 ms |
| Zep / Graphiti | not run | not run | not run | not run | not run |

**K = 10 (headline)**

| System | recall@10 | anyHit | allHit | MRR | p95 retrieval |
|---|---:|---:|---:|---:|---:|
| Mnemosyne zero-model overlap | 40.49 | 45.20 | 37.10 | 0.2899 | 3 ms |
| Mnemosyne zero-model BM25 | 52.47 | 58.26 | 47.81 | 0.3696 | 13 ms |
| Mnemosyne hybrid (dense+BM25 RRF) | 62.99 | 69.82 | 57.15 | 0.4606 | 57 ms |
| Mnemosyne hybrid + rerank | 73.57 | 80.08 | 67.80 | 0.6240 | 244 ms |
| Mem0 OSS (extraction off) | 63.72 | 70.93 | 57.54 | 0.4756 | 196 ms |
| Zep / Graphiti | not run | not run | not run | not run | not run |

**K = 20**

| System | recall@20 | anyHit | allHit | MRR | p95 retrieval |
|---|---:|---:|---:|---:|---:|
| Mnemosyne zero-model overlap | 46.84 | 52.84 | 42.06 | 0.2952 | 4 ms |
| Mnemosyne zero-model BM25 | 57.98 | 64.73 | 52.65 | 0.3740 | 13 ms |
| Mnemosyne hybrid (dense+BM25 RRF) | 71.18 | 78.58 | 64.73 | 0.4667 | 58 ms |
| Mnemosyne hybrid + rerank | 77.70 | 84.19 | 71.46 | 0.6269 | 252 ms |
| Mem0 OSS (extraction off) | 71.91 | 79.03 | 65.25 | 0.4798 | 201 ms |
| Zep / Graphiti | not run | not run | not run | not run | not run |

## Where we lose

Our reranked path wins the headline. Our *unreranked* path does not — Mem0 OSS beats it on
recall and on MRR at every K we measured. The cross-encoder, not the hybrid fusion, is what
wins this comparison, and the fusion-only configuration is the weaker retriever of the two.

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

On LongMemEval-S our reranked path and Mem0 tie exactly on recall@20, and Mem0 takes MRR.

This is worth stating plainly: **on the retrieval task as scored here, Mem0's plain vector
search is a strong baseline that beats part of our stack.** Anyone choosing between these
systems on retrieval coverage alone, at these K values, should know that.

## LongMemEval-S — 50 questions (every 10th of 500, source order), K=20

| System | recall@20 | anyHit | allHit | MRR | p95 retrieval |
|---|---:|---:|---:|---:|---:|
| Mnemosyne zero-model overlap | 89.89 | 95.65 | 80.43 | 0.7157 | 7 ms |
| Mnemosyne zero-model BM25 | 96.30 | 100.00 | 89.13 | 0.9127 | 17 ms |
| Mnemosyne hybrid (dense+BM25 RRF) | 96.49 | 100.00 | 89.13 | 0.9410 | 60 ms |
| Mnemosyne hybrid + rerank | 96.67 | 100.00 | 91.30 | 0.9415 | 1896 ms |
| Mem0 OSS (extraction off) | 96.67 | 100.00 | 91.30 | 0.9565 | 210 ms |
| Zep / Graphiti | not run | not run | not run | not run | not run |

**This corpus does not discriminate at K=20 and should not be used to claim a win.** BM25
with no model of any kind reaches 96.30; the spread between the
worst and best non-trivial row is under two points. The run is published because it was
part of the matched protocol, not because it separates the systems.

The slice is **every 10th question in source order**, not the first 50: the published
release is grouped by question category, so a prefix would have been a single category
wearing the benchmark's name. Striding keeps all six categories in proportion. The full
500-question run was not performed — see *What this does not show*.

## Per-system configuration

Every configuration choice that changes what a number means is printed in the run output,
not hidden in a footnote.

**Mnemosyne** — four conditions from one ingestion and one embedding pass, so the reranker
delta is a within-run measurement rather than a comparison across two runs:

| Condition | Configuration |
|---|---|
| zero-model overlap | token overlap, no model of any kind |
| zero-model BM25 | BM25, no model of any kind |
| hybrid (dense+BM25 RRF) | `Xenova/bge-small-en-v1.5` int8, 384d, reciprocal rank fusion, **no reranker** |
| hybrid + rerank | the above plus `Xenova/ms-marco-MiniLM-L-6-v2` int8 cross-encoder, top-50 |

**Mem0 OSS** — the full mode string, exactly as printed by the run:

```
mem0-oss@3.1.8, extraction=off(infer:false), retrieval=vector-cosine(exact), vectorStore=memory(sqlite,isolated), embedder=injected:onnxruntime-node|Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3|int8|cls|l2|512|bge-query-prefix-v1, history=disabled, telemetry=disabled, overfetch=1x
```

Two of those settings deserve to be read carefully, because they are the difference between
a fair comparison and a flattering one:

- `extraction=off(infer:false)` — Mem0's LLM fact-extraction write path is **switched off**.
  This is the free, offline path. It is *not* how Mem0 is normally sold or run.
- `embedder=injected:…bge-small-en-v1.5…` — Mem0 is running **our** embedder, not its default
  OpenAI one. This removes embedding quality as a confound so the comparison is between
  retrieval architectures, but it means this is not Mem0's out-of-the-box stack either.

## Systems that could not run, and exactly why

| System | Status | Reason |
|---|---|---|
| Mem0 OSS, extraction off | **scored** | Ran to completion. Cost: **$0**. |
| Mem0 OSS, LLM extraction (`infer:true`) | **not run here — spend not authorised on 14 September; measured since** | The write path calls an LLM per `add()`. Estimated below. No key was read for *this* run. The spend was authorised the next day and the path was measured on two LoCoMo parts: [matched-run-2026-09-15-llm-extraction.md](matched-run-2026-09-15-llm-extraction.md). |
| Zep Cloud | **not run — no credential** | ZEP_API_KEY is not set. Zep needs a Zep Cloud account and a ZEP_API_KEY. Zep Community Edition, the self-hostable server, is deprecated upstream and its own compose file points at zepai/zep:latest, which no longer exists on Docker Hub, so there is no free self-hosted path. Graphiti, the engine underneath Zep, additionally needs a graph store and a generative LLM for episode ingestion. |
| Graphiti (Zep's engine, self-hosted) | **not run** | `add_episode` always makes generative calls. Estimated below. Spend for it was authorised on 15 September and it still did not run: this repository has no standalone Graphiti adapter, and the only path to it from here is paid Zep Cloud, which remains unauthorised. |

### The cost estimates, with their arithmetic

These are **estimates, not measurements**, and they are the reason those rows are empty.
Nothing was spent; no metered API was called at any point in this run.

**Checked since.** The Mem0 estimate below was later tested against a measurement on two LoCoMo
parts ([matched-run-2026-09-15-llm-extraction.md](matched-run-2026-09-15-llm-extraction.md)):
measured **$0.0007 per chunk** against the $0.00048 assumed here, i.e. **≈ $4.27** for the full
corpus rather than ≈ $2.80 — the right order of magnitude, 1.5x low. The Graphiti estimate below
remains an estimate.

Measured inputs, from the raw reports: LoCoMo is **5,882 turns / 5,882 ingested chunks /
726,954 bytes** of turn text across 10 conversations.

- **Mem0 with `infer:true`** — roughly 2 generative calls per `add()` (fact extraction, then
  an update decision against retrieved neighbours): 5,882 × 2 ≈ **11,800 calls**. At ~1k input
  tokens and ~150 output tokens per call that is ~11.8M input and ~1.8M output, or
  **≈ $2.80 at gpt-4o-mini rates** ($0.15/$0.60 per 1M). Materially more on a larger model.
- **Graphiti** — `add_episode` runs entity extraction, entity resolution, edge extraction, edge
  dedup and temporal invalidation: call it 5 calls per episode, 5,882 × 5 ≈ **29,400 calls**,
  ~59M input and ~8.8M output tokens, **≈ $14 at gpt-4o-mini rates**. Running it free on a
  local Ollama model is possible in principle but is a multi-day run on this hardware.

Zep Community Edition — the free self-hostable server — is **not** an available path: it is
deprecated upstream and its own compose file references `zepai/zep:latest`, which no longer
exists on Docker Hub. Verified: unauthenticated and bogus-key requests to
`api.getzep.com/api/v2/threads` both return HTTP 401.

## What this does NOT show

1. **It is not answer accuracy.** No reader and no judge run. `generation: 0`, `judge: 0` in
   every raw report. This measures whether the evidence was retrieved, not whether a model
   then answered correctly with it. It is not the official LoCoMo category F1 evaluator and
   not an official LongMemEval score.
2. **Mem0 is evaluated as a vector store, not as the product it is.** To be scored identically
   it must ingest our chunks and return our chunk identities. Mem0's actual value proposition —
   LLM extraction of durable facts from conversation — is switched off. A matched protocol and
   a natural-configuration comparison are different experiments; this is the former.
3. **No vendor's hosted tier was tested.** Not Mem0 Platform, not Zep Cloud. Published vendor
   numbers for those tiers are not reproduced, disputed or endorsed here — they are simply a
   different thing than what this measures.
4. **The LLM-extraction cost asymmetry is real and is not in the table.** Our rows cost $0 in
   API spend. A production Mem0 or Graphiti deployment pays per ingested turn, forever. A
   table of recall says nothing about that difference in either direction.
5. **LongMemEval-S is a 50-question slice**, ~10% of the benchmark, and it is near-saturated at
   K=20. Treat it as a protocol check, not as a result.
6. **Latency is local, uncontrolled and not like-for-like.** Our reranked p95 includes a
   cross-encoder pass; Mem0's does not. Retrieval timing excludes ingestion and packing.
7. **Mode labels are attestations.** The harness records how each system says it was configured;
   it does not independently authenticate a third-party SDK's internals.
8. **One seed, one machine, one run.** No variance across seeds or repeats is reported, so small
   gaps — including the sub-point LongMemEval spreads — should not be read as separations.

## Provenance

| | LoCoMo | LongMemEval-S |
|---|---|---|
| Adapter | `locomo-original-dialogue-v1` | `longmemeval-cleaned-v1` |
| Source SHA-256 | `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4` | `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442` |
| Normalized SHA-256 | `69d74a91b0c381f2fe97eed17ca5bb5b8b65067ee9f1b54cbefef726e692c489` | `206cdf3cdac99d9057b0c6f307fe71c27c6ab0aa2e45786a8e2d7160d398621e` |
| Runtime | v26.4.0 darwin/arm64 | v26.4.0 darwin/arm64 |
| Complete | true | true |

### The implementation digests are not all identical, and that is checked rather than waved at

These runs were produced over several hours while partition, offset and stride support were
being added to the benchmark **command-line driver**. The implementation fingerprint covers
every compiled file, so it moved three times:

| Run | Implementation SHA-256 |
|---|---|
| LoCoMo (locomo10) K=5 | `5a69808fca29e655421d7228928cdad0cb52b61b44eb3e06a41ae61385579b38` |
| LoCoMo (locomo10) K=10 | `6a6594bb9c50710c728ece7ba5aad0913d56d4848e065e492f494883941c9638` |
| LoCoMo (locomo10) K=20 | `5a69808fca29e655421d7228928cdad0cb52b61b44eb3e06a41ae61385579b38` |
| LongMemEval-S (cleaned) K=20 | `c25dea57de327f110db7d25f6f6d06e65a015156ed4a254d2a0be0cb63c08650` |

The committed tree is `c25dea57de327f110db7d25f6f6d06e65a015156ed4a254d2a0be0cb63c08650`.

The honest question is whether those differences moved any number. That was **measured, not
assumed**. A 304-question, 2-conversation LoCoMo slice was re-scored under the committed tree at
each of K=5, 10 and 20 and compared per question against the corresponding published report:

**6,384 per-question attempt records compared — retrieval scores, packed scores, status and
chunk counts — with 0 mismatches.** The drift is confined to the CLI driver; the scorer and the
retrievers are unchanged across all three digests.

LoCoMo is externally supplied under CC BY-NC 4.0 and LongMemEval-S under its dataset card's MIT
terms. Neither is redistributed by this package; `npm run benchmark:fetch` retrieves them.

## Artifacts

Raw per-question records for every system and every run are in
[`reports/matched-run-2026-09-14/`](matched-run-2026-09-14/), stored gzipped (145 MB → 2.8 MB).
[`summary.json`](matched-run-2026-09-14/summary.json) holds the table above in machine-readable
form; **this document is generated from it**, so the prose and the measurements cannot drift apart.
