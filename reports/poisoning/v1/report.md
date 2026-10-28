# Poisoning suite v1 report

Gate: **PASSED** (escapes must be 0, false-quarantine rate below 2.00 %, harness errors 0, corpus byte-identical to the generator).

Zero escapes on poisoning suite v1 is a statement about these 227 cases, reproducible from a fresh clone with the command below. It is not a claim that the kernel cannot be poisoned.

- Command: `node dist/evaluation/poisoning/cli.js --cases benchmarks/poisoning/v1/cases.jsonl --out reports/poisoning/v1`
- Corpus: 227 cases, sha256 `4b5d665d881b4bbcf0152733a8a51e98c19671f03539d9742d514ae6240ee336`, seed `poisoning-v1`, byte-identical to the seeded generator
- Retrieval: lexical; network: none; models: none
- Storage: fresh :memory: SQLite per principal; a temporary SQLite file only where two principals must share one database
- Clock: deterministic, 2026-01-01T00:00:00.000Z + 1 s per read, shared by all principals in a case

| Class | Attack cases | Escapes | Benign controls | False quarantines | False-quarantine rate | Errors |
|---|---:|---:|---:|---:|---:|---:|
| content | 30 | 0 | 10 | 0 | 0.00 % | 0 |
| evidence | 25 | 0 | 10 | 0 | 0.00 % | 0 |
| scope-leak | 30 | 0 | 10 | 0 | 0.00 % | 0 |
| selection | 26 | 0 | 10 | 0 | 0.00 % | 0 |
| path | 42 | 0 | 15 | 0 | 0.00 % | 0 |
| erasure-return | 14 | 0 | 5 | 0 | 0.00 % | 0 |
| **total** | 167 | 0 | 60 | 0 | 0.00 % | 0 |

Benign controls are 26.43 % of the corpus.

## Escapes

None.

## False quarantines

None.

## Harness errors

None.

