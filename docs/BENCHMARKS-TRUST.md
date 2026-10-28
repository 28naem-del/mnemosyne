# Benchmarks and trust evidence (draft for 3.0.0-rc.1)

**Status: draft.** Every number on this page was produced on branch `feat/unit1-proof-sprint`
(commit range `e0bbb47..c97270c`, based on 2.0.0) on 2026-10-28, offline, with no API key and
no paid model, and reproduces from a fresh clone with the commands given. Losses are listed
next to wins. Nothing here compares Mnemosyne with another product unless that product was run
through the same harness commit by us; so far none has been.

Wording rules this page follows: no "immune to poisoning" (the suite shows zero escapes on a
named, versioned case set and nothing more); no "safe consolidation" (consolidation here is
outcome-gated and reversible, which is a mechanism, not a guarantee); every synthetic ledger or
case set is labelled synthetic.

## 1. PrecisionMemBench (retrieval mode, no LLM judge)

Benchmark: [tenurehq/precisionMemBench](https://github.com/tenurehq/precisionMemBench) at commit
`61a712a1754e7d27b6dee42da32a2c214b003ece` (MIT). Fixture: 35 beliefs (34 for the test user, 1
for another user), 77 single-turn retrieval cases, 2 session cases (12 turns). The harness
scores pass/fail per case from precision and recall of the returned belief ids; no judge.

| Label | Configuration | Single-turn | Precision | Recall | Active-retrieval passes | Session | Session P / R |
|---|---|---|---|---|---|---|---|
| lexical-protocol-raw | lexical BM25, protocol-exact, no wrapper filter | 22/77 (28.6 %) | 0.262 | 0.954 | 7 | not run | — |
| A-lexical | lexical BM25, protocol-exact, absolute floor 3 + relative cutoff 0.5 | 44/77 (57.1 %) | 0.595 | 0.841 | 24 | 5/12 | 0.662 / 0.758 |
| **A-hybrid** | hybrid (bge-small-en-v1.5 + BM25, RRF k=10), protocol-exact, minSimilarity 0.65 + relative cutoff 0.5 | **48/77 (62.3 %)** | 0.611 | 0.913 | 31 | 6/12 | 0.694 / 0.955 |
| B-lexical | A-lexical + extended metadata (harness patch, **not comparable**) | 50/77 (64.9 %) | 0.631 | 0.786 | 24 | 5/12 | 0.735 / 0.848 |
| B-hybrid | A-hybrid + extended metadata (harness patch, **not comparable**) | 53/77 (68.8 %) | 0.666 | 0.913 | 31 | 7/12 | 0.781 / 0.955 |

**The number to quote is A-hybrid, 48/77.** Configuration B applies a disclosed patch to the
harness (`benchmarks/precisionmembench/patches/pmb-extended-metadata.patch`) so the kernel also
receives `type`, `superseded_by`, `created_at` and `resolved_at`; the kernel then maps
supersession onto `correct()` and resolved open questions onto validity windows. It shows what
native supersession buys, and it is not comparable with any provider scored on the stock harness.

Reproduce (from the repository root, after `npm ci && npm run build`; the clone step and the
provider-registration patch are in `benchmarks/precisionmembench/README.md`):

```sh
node benchmarks/precisionmembench/run.mjs --label lexical-protocol-raw --retrieval lexical --metadata protocol
node benchmarks/precisionmembench/run.mjs --label A-lexical --retrieval lexical --metadata protocol --min-score 3 --cutoff 0.5 --both
node benchmarks/precisionmembench/run.mjs --label A-hybrid  --retrieval hybrid  --metadata protocol --min-sim 0.65 --cutoff 0.5 --both
node benchmarks/precisionmembench/run.mjs --label B-lexical --retrieval lexical --metadata extended --min-score 3 --cutoff 0.5 --both --extended-harness
node benchmarks/precisionmembench/run.mjs --label B-hybrid  --retrieval hybrid  --metadata extended --min-sim 0.65 --cutoff 0.5 --both --extended-harness
```

Raw output per label: `reports/precisionmembench/<label>/` (harness JSON reports, ava transcripts,
server log, `run-summary.json` with the harness and kernel commits). The sweeps that chose the
filter values: `reports/precisionmembench/sweep-*/sweep.json`, 29 configurations. Every run was
executed twice with identical results.

Where Mnemosyne loses, and what it means:

- **The unfiltered kernel scores 22/77.** `recall()` has no native abstention threshold: BM25
  returns weak matches for stopword-heavy queries and the dense path returns everything through
  RRF, so recall is 0.954 but precision 0.262. The two wrapper-side filters (absolute floor or
  dense similarity floor, plus a relative cutoff against the top in-scope score) were chosen by
  sweeping the public fixture, which is the only data this benchmark has. That is a product gap
  to fix in the kernel, not a benchmark artefact, and it is on the 3.x roadmap.
- **Fuzzy and typo queries: 4 of 7 fail.** There is no fuzzy matching.
- **Compound queries naming 6–8 entities** lose lower-ranked true hits to the relative cutoff.
- **"Nothing relevant" queries** keep noise when the top hit is itself noise.
- **The bundled cross-encoder reranker made every configuration worse** (best 35/77 with
  reranking against 48/77 without). It is off in the quoted run.
- **Session mode is weak**: 6/12 turns in the comparable configuration.

## 2. Adversarial poisoning suite v1 (ours, synthetic, offline)

Suite: `benchmarks/poisoning/v1/cases.jsonl`, **227 synthetic cases** (167 attacks, 60 benign
controls, 26.4 %) generated deterministically from seed `poisoning-v1`; sha256
`4b5d665d881b4bbcf0152733a8a51e98c19671f03539d9742d514ae6240ee336`, regenerated byte-identical by
the test suite. Classes follow MemForm's five formation interfaces plus one of ours: content,
evidence, scope-leak, selection, path (consolidation order), erasure-return. Each case runs in a
fresh in-memory SQLite store on the lexical path with a fixed clock; no network, no model.

| Class | Attack cases | Escapes | Benign controls | False quarantines |
|---|---:|---:|---:|---:|
| content | 30 | 0 | 10 | 0 |
| evidence | 25 | 0 | 10 | 0 |
| scope-leak | 30 | 0 | 10 | 0 |
| selection | 26 | 0 | 10 | 0 |
| path | 42 | 0 | 15 | 0 |
| erasure-return | 14 | 0 | 5 | 0 |
| **total** | **167** | **0** | **60** | **0 (0.00 %)** |

Result: **zero escapes on poisoning suite v1, 227 cases, reproducible from a fresh clone**; the
false-quarantine gate is < 2 %. This is a statement about these 227 cases. It is not a claim
that the kernel cannot be poisoned.

```sh
npm run poisoning   # = node dist/evaluation/poisoning/cli.js --cases benchmarks/poisoning/v1/cases.jsonl --out reports/poisoning/v1
```

Report: `reports/poisoning/v1/report.{json,md}`; runtime about 2 s. The suite's power was checked
by switching off one kernel guard at a time in a scratch build; every mutant failed the gate
(table in `docs/POISONING-SUITE.md`, e.g. 71 escapes without the untrusted-exclusion rule, 22
without agent scope, 13 without the candidate ancestry check).

Limits, stated plainly:

- The content and selection classes test the **trust-label gate**, not content inspection: a
  record written as `observed` is served as observed. Trust is decided by channel and provenance.
- Only the **lexical** path is exercised; dense and hybrid retrieval are not covered by v1.
- `import()` still accepts a hand-built snapshot's trust label when the record has no
  dependencies; v1 does not test this as an attack.
- A failed outcome removes a record from `compile()` but not from `recall()`.
- Decaying quarantine is not implemented.

### M3 ancestry-disjoint promotion (enforced in code)

`LocalMemory.promote(id, { to, corroboration, reason })` raises a record's trust only when at
least two active corroborators of the target trust share **no provenance ancestor** (over
dependencies, supersession, invalidation source, source URI and author) with the candidate or
with each other. Every decision, granted or quarantined, is a `promotion` ledger event with a
readable verdict naming the shared node when it refuses; read it with
`memory.ledger({ event: 'promotion' })`. A grant supersedes rather than edits in place so replay
hashes stay stable. Tests: `tests/local-promotion.test.ts` (13), `tests/poisoning-suite.test.ts` (4).

## 3. MemSecBench — not scored

[arXiv 2607.27080](https://arxiv.org/abs/2607.27080) has no public harness or case set and scores
with judge-model calls. `benchmarks/memsecbench/` holds a four-operation backend adapter over the
kernel, an offline self-test on **three synthetic cases of ours (6/6 checks; not a score)** and
the exact cost arithmetic: about US$31 for a local-agent run with one Sonnet-class judge pass,
about US$590 for a paid-agent run with three judge passes, under the assumptions written there.
Blocked on the authors' 310 cases and judge configuration.

## 4. ConsolidationBench — not attempted

[arXiv 2609.33013](https://arxiv.org/abs/2609.33013) releases its artifacts to reviewers on
request only. `benchmarks/consolidationbench/BLOCKER.md` records what is needed.

## 5. Engineering evidence in this release line

- **Memory bisect on the default hybrid path**: Oracle B rebuilds the exact retriever and carries
  stored vectors over, so a blame set is confirmed without re-embedding;
  `tests/local-bisect-hybrid.test.ts` runs end to end with the bundled models.
- **Issue #37**: proposer and `runJobs` timeouts configurable up to 300 s (lease up to 600 s,
  defaults unchanged); `tests/runtime-timeouts.test.ts` proves a mock proposer answering after 90 s
  of fake time succeeds with `timeoutMs: 120000`.
- **Legacy engine removed from the public package** (see `docs/MIGRATION-v3.md`): the blind
  `dream()`/`consolidate()` consolidation no longer ships in `mnemosy-ai`; what remains is the
  outcome-gated, reversible path (`reflect()` → `commitVerifiedLesson()`, `promote()`).
- Full test suite on the branch tip that carries the code changes (`6cb1342`): 74 files,
  1,434 tests passed; legacy package 8 files, 103 tests passed; docs-link, public-metadata and
  example type checks green.

## 6. Longer-standing measurements

Retrieval coverage on the project's own corpora, with fingerprints and protocol, lives in
[evaluation/BENCHMARKS.md](evaluation/BENCHMARKS.md). The same caveat applies there: coverage
against a local scorer, not generated-answer accuracy, not superiority over other systems.
