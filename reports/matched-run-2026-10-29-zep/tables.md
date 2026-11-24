| System | recall@5 | recall@10 | recall@20 |
|---|---:|---:|---:|
| Mnemosyne zero-model overlap | 33.73 | 40.49 | 46.84 |
| Mnemosyne zero-model BM25 | 44.95 | 52.47 | 57.98 |
| Mnemosyne hybrid (dense+BM25 RRF) | 54.68 | 62.99 | 71.18 |
| Mnemosyne hybrid + rerank | 67.23 | 73.57 | 77.70 |
| Mem0 OSS (extraction off) | 55.09 | 63.72 | 71.91 |
| Zep Cloud (graph search, episodes) | 41.95 | 52.83 | 61.18 |

**K = 5** — 1986 questions, 1531 with positive evidence labels, complete=true

| System | recall@5 | anyHit | allHit | MRR | p95 retrieval | completed / errors |
|---|---:|---:|---:|---:|---:|---:|
| Mnemosyne zero-model overlap | 33.73 | 37.62 | 31.09 | 0.2797 | 11 ms | 1986 / 0 |
| Mnemosyne zero-model BM25 | 44.95 | 49.90 | 41.28 | 0.3584 | 25 ms | 1986 / 0 |
| Mnemosyne hybrid (dense+BM25 RRF) | 54.68 | 60.68 | 49.71 | 0.4478 | 68 ms | 1986 / 0 |
| Mnemosyne hybrid + rerank | 67.23 | 74.00 | 61.66 | 0.6159 | 354 ms | 1986 / 0 |
| Mem0 OSS (extraction off) | 55.09 | 61.99 | 49.84 | 0.4633 | 512 ms | 1986 / 0 |
| Zep Cloud (graph search, episodes) | 41.95 | 46.70 | 38.41 | 0.2076 | 409 ms | 1986 / 0 |

**K = 10 (headline)** — 1986 questions, 1531 with positive evidence labels, complete=true

| System | recall@10 | anyHit | allHit | MRR | p95 retrieval | completed / errors |
|---|---:|---:|---:|---:|---:|---:|
| Mnemosyne zero-model overlap | 40.49 | 45.20 | 37.10 | 0.2899 | 11 ms | 1986 / 0 |
| Mnemosyne zero-model BM25 | 52.47 | 58.26 | 47.81 | 0.3696 | 25 ms | 1986 / 0 |
| Mnemosyne hybrid (dense+BM25 RRF) | 62.99 | 69.82 | 57.15 | 0.4606 | 69 ms | 1986 / 0 |
| Mnemosyne hybrid + rerank | 73.57 | 80.08 | 67.80 | 0.6240 | 342 ms | 1986 / 0 |
| Mem0 OSS (extraction off) | 63.72 | 70.93 | 57.54 | 0.4756 | 359 ms | 1986 / 0 |
| Zep Cloud (graph search, episodes) | 52.83 | 58.98 | 47.88 | 0.1705 | 413 ms | 1986 / 0 |

**K = 20** — 1986 questions, 1531 with positive evidence labels, complete=true

| System | recall@20 | anyHit | allHit | MRR | p95 retrieval | completed / errors |
|---|---:|---:|---:|---:|---:|---:|
| Mnemosyne zero-model overlap | 46.84 | 52.84 | 42.06 | 0.2952 | 11 ms | 1986 / 0 |
| Mnemosyne zero-model BM25 | 57.98 | 64.73 | 52.65 | 0.3740 | 26 ms | 1986 / 0 |
| Mnemosyne hybrid (dense+BM25 RRF) | 71.18 | 78.58 | 64.73 | 0.4667 | 68 ms | 1986 / 0 |
| Mnemosyne hybrid + rerank | 77.70 | 84.19 | 71.46 | 0.6269 | 350 ms | 1986 / 0 |
| Mem0 OSS (extraction off) | 71.91 | 79.03 | 65.25 | 0.4798 | 540 ms | 1986 / 0 |
| Zep Cloud (graph search, episodes) | 61.18 | 68.06 | 55.26 | 0.1289 | 413 ms | 1986 / 0 |

| Comparison | K | Zep | Other | Other system | Result |
|---|---:|---:|---:|---|---|
| LoCoMo recall@5 | 5 | 41.95 | 67.23 | Mnemosyne hybrid + rerank | **Mnemosyne hybrid + rerank wins by 25.28** |
| LoCoMo MRR@5 | 5 | 0.2076 | 0.6159 | Mnemosyne hybrid + rerank | **Mnemosyne hybrid + rerank wins by 0.4084** |
| LoCoMo recall@5 | 5 | 41.95 | 54.68 | Mnemosyne hybrid, no rerank | **Mnemosyne hybrid, no rerank wins by 12.73** |
| LoCoMo MRR@5 | 5 | 0.2076 | 0.4478 | Mnemosyne hybrid, no rerank | **Mnemosyne hybrid, no rerank wins by 0.2403** |
| LoCoMo recall@5 | 5 | 41.95 | 55.09 | Mem0 OSS (infer:false) | **Mem0 OSS wins by 13.14** |
| LoCoMo MRR@5 | 5 | 0.2076 | 0.4633 | Mem0 OSS (infer:false) | **Mem0 OSS wins by 0.2557** |
| LoCoMo recall@5 | 5 | 41.95 | 44.95 | Mnemosyne zero-model BM25 | **Mnemosyne zero-model BM25 wins by 3.00** |
| LoCoMo MRR@5 | 5 | 0.2076 | 0.3584 | Mnemosyne zero-model BM25 | **Mnemosyne zero-model BM25 wins by 0.1508** |
| LoCoMo recall@10 | 10 | 52.83 | 73.57 | Mnemosyne hybrid + rerank | **Mnemosyne hybrid + rerank wins by 20.74** |
| LoCoMo MRR@10 | 10 | 0.1705 | 0.6240 | Mnemosyne hybrid + rerank | **Mnemosyne hybrid + rerank wins by 0.4535** |
| LoCoMo recall@10 | 10 | 52.83 | 62.99 | Mnemosyne hybrid, no rerank | **Mnemosyne hybrid, no rerank wins by 10.15** |
| LoCoMo MRR@10 | 10 | 0.1705 | 0.4606 | Mnemosyne hybrid, no rerank | **Mnemosyne hybrid, no rerank wins by 0.2901** |
| LoCoMo recall@10 | 10 | 52.83 | 63.72 | Mem0 OSS (infer:false) | **Mem0 OSS wins by 10.89** |
| LoCoMo MRR@10 | 10 | 0.1705 | 0.4756 | Mem0 OSS (infer:false) | **Mem0 OSS wins by 0.3051** |
| LoCoMo recall@10 | 10 | 52.83 | 52.47 | Mnemosyne zero-model BM25 | **Zep wins by 0.37** |
| LoCoMo MRR@10 | 10 | 0.1705 | 0.3696 | Mnemosyne zero-model BM25 | **Mnemosyne zero-model BM25 wins by 0.1991** |
| LoCoMo recall@20 | 20 | 61.18 | 77.70 | Mnemosyne hybrid + rerank | **Mnemosyne hybrid + rerank wins by 16.52** |
| LoCoMo MRR@20 | 20 | 0.1289 | 0.6269 | Mnemosyne hybrid + rerank | **Mnemosyne hybrid + rerank wins by 0.4981** |
| LoCoMo recall@20 | 20 | 61.18 | 71.18 | Mnemosyne hybrid, no rerank | **Mnemosyne hybrid, no rerank wins by 9.99** |
| LoCoMo MRR@20 | 20 | 0.1289 | 0.4667 | Mnemosyne hybrid, no rerank | **Mnemosyne hybrid, no rerank wins by 0.3379** |
| LoCoMo recall@20 | 20 | 61.18 | 71.91 | Mem0 OSS (infer:false) | **Mem0 OSS wins by 10.73** |
| LoCoMo MRR@20 | 20 | 0.1289 | 0.4798 | Mem0 OSS (infer:false) | **Mem0 OSS wins by 0.3510** |
| LoCoMo recall@20 | 20 | 61.18 | 57.98 | Mnemosyne zero-model BM25 | **Zep wins by 3.21** |
| LoCoMo MRR@20 | 20 | 0.1289 | 0.3740 | Mnemosyne zero-model BM25 | **Mnemosyne zero-model BM25 wins by 0.2452** |

| Raw file | bytes | SHA-256 |
|---|---:|---|
| `locomo-k10.json` | 27440493 | `f94119ccc7d232b99c8e3eb5d8bdb8226297875eb73f5888584668948db33ec4` |
| `locomo-k20.json` | 39467962 | `b338dd0be081f5616bb0b467b034b3541fe3ff8ce95b78aaaf7d43ee4988b788` |
| `locomo-k5.json` | 21364652 | `ae97e2ad180daa73a810370fd9147a3ca9edab41d786eea62f807c02002df82a` |
