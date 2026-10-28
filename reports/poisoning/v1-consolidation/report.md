# Poisoning suite v1 report (consolidation mode)

Gate: **PASSED** (escapes must be 0, false-quarantine rate below 2.00 %, harness errors 0, corpus byte-identical to the generator, no laundering pass kept, every verdict chain verifies).

Zero escapes on poisoning suite v1 is a statement about these 227 cases, reproducible from a fresh clone with the command below. It is not a claim that the kernel cannot be poisoned.

- Command: `node dist/evaluation/poisoning/cli.js --cases benchmarks/poisoning/v1/cases.jsonl --out reports/poisoning/v1-consolidation --consolidation`
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

## Consolidation mode

Between the steps and the probes, every principal recorded judged retrievals of its own (its recall and compile probe queries, judged by a synthetic verifier that only checks whether anything came back) and ran four signed passes through the outcome gate: the deterministic proposer, the same proposer with a loose merge threshold, an undeclared laundering adversary and a declared laundering adversary (both synthetic). Probe targets then widen to consolidation outputs: on an attack, an output that depends on a poisoned record or carries all of its tokens counts as the poison; on a benign control, an output that depends on the legitimate record and carries all of its tokens may stand in for it.

- Signing key: ed25519 keyId `700792c1c68a5c2d0f0b7be283cdb979e78dbf364b08a08e6649c7ea5b74f390` (fixed suite seed); ledger queries: text; verifier: poisoning-suite-synthetic (success iff the recall returned anything)
- Judged retrievals recorded: 283; gate decisions: 294
- Verdicts: kept 11, rolled_back 184 (invariant 184, outcome regression 0), no_evidence 99, invalid_run 0, conflict 0
- Laundering passes kept: 0 (must be 0); cases with a kept pass: 11; verdict-chain failures: 0 (must be 0)
- Benign probes that surfaced only through a stand-in output: 0

### Kept passes

- `v1-selection-attack-004` a/deterministic: 1 record(s), delta 0 over 2 task(s)
- `v1-selection-attack-005` a/deterministic: 1 record(s), delta 0 over 2 task(s)
- `v1-selection-attack-012` a/deterministic: 1 record(s), delta 0 over 2 task(s)
- `v1-selection-attack-017` a/deterministic: 1 record(s), delta 0 over 2 task(s)
- `v1-selection-attack-018` a/deterministic: 1 record(s), delta 0 over 2 task(s)
- `v1-selection-attack-025` a/deterministic: 1 record(s), delta 0 over 2 task(s)
- `v1-selection-benign-028` a/aggressive-merge: 1 record(s), delta 0 over 2 task(s)
- `v1-selection-benign-029` a/aggressive-merge: 1 record(s), delta 0 over 2 task(s)
- `v1-selection-benign-030` a/deterministic: 1 record(s), delta 0 over 2 task(s)
- `v1-selection-benign-033` a/aggressive-merge: 1 record(s), delta 0 over 2 task(s)
- `v1-selection-benign-036` a/deterministic: 1 record(s), delta 0 over 2 task(s)

## Escapes

None.

## False quarantines

None.

## Harness errors

None.

