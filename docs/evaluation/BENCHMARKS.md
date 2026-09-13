# Reproducible retrieval measurements

Generated from the linked reports. These are evidence-retrieval measurements, not generated-answer accuracy, judge scores, or proof of superiority to another memory system.

| Report / condition | Questions (positive labels) | All evidence before packing | All evidence after packing | Mean evidence recall after packing | Overflows / errors |
|---|---:|---:|---:|---:|---:|
| [longmemeval-s500-corpus-paired-bm25.json](reports/longmemeval-s500-corpus-paired-bm25.json) / no-memory | 500 (470) | 0/470 (0.00%) | 0/470 (0.00%) | 0.00% | 0 / 0 |
| [longmemeval-s500-corpus-paired-bm25.json](reports/longmemeval-s500-corpus-paired-bm25.json) / full-context | 500 (470) | 470/470 (100.00%) | 0/470 (0.00%) | 0.00% | 500 / 0 |
| [longmemeval-s500-corpus-paired-bm25.json](reports/longmemeval-s500-corpus-paired-bm25.json) / lexical | 500 (470) | 386/470 (82.13%) | 367/470 (78.09%) | 87.09% | 0 / 0 |
| [longmemeval-s500-corpus-paired-bm25.json](reports/longmemeval-s500-corpus-paired-bm25.json) / bm25 | 500 (470) | 425/470 (90.43%) | 382/470 (81.28%) | 89.60% | 0 / 0 |
| [synthetic-corpus-smoke.json](reports/synthetic-corpus-smoke.json) / no-memory | 3 (2) | 0/2 (0.00%) | 0/2 (0.00%) | 0.00% | 0 / 0 |
| [synthetic-corpus-smoke.json](reports/synthetic-corpus-smoke.json) / full-context | 3 (2) | 2/2 (100.00%) | 2/2 (100.00%) | 100.00% | 0 / 0 |
| [synthetic-corpus-smoke.json](reports/synthetic-corpus-smoke.json) / lexical | 3 (2) | 2/2 (100.00%) | 2/2 (100.00%) | 100.00% | 0 / 0 |
| [synthetic-corpus-smoke.json](reports/synthetic-corpus-smoke.json) / bm25 | 3 (2) | 2/2 (100.00%) | 2/2 (100.00%) | 100.00% | 0 / 0 |

## Interpretation

- Positive evidence metrics exclude unanswerable and unannotated questions, while attempts and failures remain visible. Read each raw report for category and schema coverage.
- Full-context overflow means the complete history did not fit. It contributes zero packed evidence; the runner does not silently truncate it.
- A group hit may be any chunk of an original turn/session. It is not proof that the answer-bearing passage was delivered or that a model answered correctly.
- Latency is descriptive local timing. Provider, tokenizer, packing and candidate settings must match for a meaningful comparison.

## Provenance

- **longmemeval-s500-corpus-paired-bm25.json:** dataset LongMemEval-S-cleaned-full500, revision 98d7416c24c778c2fee6e6f3006e7a073259d48f, license MIT. Source SHA256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`; normalized input SHA256 `62058b94ccabac4dccc64ca5873d578e98ff83d31588036eb8191aee7850f270`; runtime implementation SHA256 `781e7e538a49910d25673c3d8b1f8f5b40e29b912f57195417fe3a16e4d0eac3`. K=20 UTF-8 chunks, chunk bytes=4096, context budget=8192 utf8-bytes-v1. Complete=true. Timestamp policy: question-day; 1475 history sessions occur after the stated question instant. Source dates are preserved.
- **synthetic-corpus-smoke.json:** dataset Synthetic corpus smoke test; not a public benchmark, revision fixture-v1, license MIT; first-party synthetic fixture. Source SHA256 `caller did not supply original-file digest`; normalized input SHA256 `f637000c9db482dfd98b7fe2e648e1291f0fc5b7061c63ff31279cbcdf8b3691`; runtime implementation SHA256 `abf77547ac1bd51c872a7ee0d1c5d25d8c8f12061517b905e11c481df7ae645f`. K=20 UTF-8 chunks, chunk bytes=4096, context budget=8192 utf8-bytes-v1. Complete=true.

## Reproduce

Build the repository, then run `node dist/evaluation/corpus-cli.js --help`. Supply your locally acquired pinned dataset and its license; no raw third-party dataset is bundled. Omit `--embedding-config` for zero model calls. Use the same options and runtime implementation to reproduce a report.

See the repository corpus protocol guide for exact commands, label boundaries, optional embeddings, dataset licenses and denominator definitions.

Regenerate this index with `node scripts/benchmark-index.mjs --out docs/evaluation/BENCHMARKS.md REPORT.json [...]`.
