# Benchmarks and trust evidence (draft for 3.0.0-rc.2)

**Status: draft.** The rc.2 numbers on this page were produced on 2026-10-28 on branch
`feat/breakthrough`, which merges the precision, consolidation, dependency and demo work (merge
commit `64ec27c`; the PrecisionMemBench reports were committed in `c87b17c`). They were run
offline, with no API key, no paid model and no LLM judge, and each one comes with the command
that reproduces it from a fresh clone. The rc.1 numbers (branch `feat/unit1-proof-sprint`, commit
range `e0bbb47..c97270c`, based on 2.0.0) are kept in their own subsections and marked as
history. Losses are listed next to wins. Nothing here compares Mnemosyne with another product
unless that product was run through the same harness commit by us, and so far none has been.

The page follows the project's wording rules:

- A poisoning result is stated as zero escapes on a named, versioned case set, and nothing more.
- Consolidation is described as outcome-gated and reversible. That is a mechanism, not a guarantee.
- No result is described as learning in the weight-update sense, or as general intelligence.
- Every synthetic ledger, corpus or case set is labelled synthetic.

## 0. rc.2 at a glance

| What | Result | Protocol | Report |
|---|---|---|---|
| PrecisionMemBench, single-turn | **70/77** lexical, **70/77** hybrid | protocol-exact, **no wrapper-side filter**, retrieval mode, no LLM judge; mean precision 0.871, recall 1.000 | `reports/precisionmembench/merged-{lexical,hybrid}/` |
| PrecisionMemBench, session | **12/12** turns (lexical and hybrid) | same | same |
| Poisoning suite v1, consolidation on | **0/167 escapes, 0/60 false quarantines**, 0 errors; 294 gate decisions | 227 synthetic cases, lexical path; four signed passes per principal | `reports/poisoning/v1-consolidation/` |
| Poisoning suite v1, default mode | 0/167 escapes, 0/60 false quarantines (unchanged from rc.1) | `npm run poisoning` | `reports/poisoning/v1/` |
| Dependency suite v1 (synthetic) | invalidation recall **96.05 %** (170/177), precision **98.06 %** (152/155), **0** stale-procedure executions with the premise guard (inference alone: 7/248; guard false-hold rate 92.78 %) | seed 20261028, accept-all eval reviewer, guarded executor, lexical path | `reports/dependencies/v1/` |
| `mnemosy demo` | five moments, each with a PROOF line measured live | offline, synthetic corpora, zero-model lexical path | printed per run ([DEMO.md](DEMO.md)) |
| LoCoMo and LongMemEval-S retrieval | unchanged before vs after (largest delta: LoCoMo MRR +0.0014) | zero-model and hybrid, same commands before and after | section 6 |
| Full test suite | 92 files, 1,545 tests passed | `npm run check` on the merged tree | — |

## 1. PrecisionMemBench (retrieval mode, no LLM judge)

The benchmark is [tenurehq/precisionMemBench](https://github.com/tenurehq/precisionMemBench) at
commit `61a712a1754e7d27b6dee42da32a2c214b003ece` (MIT). Its fixture has:

- 35 beliefs: 34 for the test user and 1 for another user;
- 77 single-turn retrieval cases;
- 2 session cases with 12 turns.

The harness scores pass/fail per case from the precision and recall of the returned belief ids.
No judge is involved.

### 1.1 rc.2: protocol-exact, no wrapper-side filter

The wrapper (`benchmarks/precisionmembench/server.mjs`) is translation only. After `recall()`
returns, it drops, reranks, thresholds or deduplicates nothing. Every exclusion is a kernel
decision recorded in the ledger. `run-summary.json` records `"wrapperFilter": "none"` and the kernel
options in force.

**Before and after.** Same fixture and harness commit throughout.

| Stage | Kernel | Wrapper-side filter | Single-turn | Mean P / R | Session turns |
|---|---|---|---|---|---|
| rc.1, unfiltered (`lexical-protocol-raw`) | `e0bbb47` | none | 22/77 (28.6 %) | 0.262 / 0.954 | not run |
| rc.1, comparable (`A-hybrid`) | `e0bbb47` | sweep-chosen: minSimilarity 0.65 + relative cutoff 0.5 | 48/77 (62.3 %) | 0.611 / 0.913 | 6/12 |
| **rc.2, lexical** (`merged-lexical`) | `64ec27c` | **none** | **70/77 (90.9 %)** | 0.871 / 1.000 | **12/12** |
| **rc.2, hybrid** (`merged-hybrid`) | `64ec27c` | **none** | **70/77 (90.9 %)** | 0.871 / 1.000 | **12/12** |

So the score goes from 22 unfiltered, to 48 with filters chosen on the fixture, to 70 with the
kernel's own controls and no filter. Both rc.2 runs have 42 active-retrieval passes, 19
structural passes and 9 trivially-empty passes.

**Ablations and variants.** These were run by unit A on the same wrapper with the kernel at
`7b1ab58` (or `4526dc4` where marked). The recall source did not change between those commits and
the merge.

| Label | Kernel option changed | Single-turn | Mean P / R | Session |
|---|---|---|---|---|
| `A2-base-lexical` | before this work (`84cb6c3`) | 22/77 | 0.262 / 0.954 | 0/12 |
| `A2-base-hybrid` | before this work (`84cb6c3`) | 11/77 | 0.066 / 1.000 | 0/12 |
| `A2-lexical` | none (names gate `auto` + fuzzy) | 70/77 | 0.871 / 1.000 | 12/12 |
| `A2-hybrid` | none, plus the bge-small dense channel | 70/77 | 0.871 / 1.000 | 12/12 |
| `A2-hybrid-rerank` (`4526dc4`) | plus the cross-encoder | 70/77 | 0.871 / 1.000 | 12/12 |
| `A2-ablate-nonames-lexical` (`4526dc4`) | `requireNamedMatch: false` | **20/77** | 0.249 / 1.000 | 0/12 |
| `A2-ablate-nofuzzy-lexical` (`4526dc4`) | `fuzzy: false` | **64/77** | 0.748 / 0.861 | 12/12 |

**The kernel controls that carry the number.** All of them are opt-in and off by default.

- **`requireNamedMatch: 'auto'` (names gate).** A record that declares `metadata.names` is
  returned only when one of its names occurs in the query as a whole token phrase. The names
  stage is also a candidate channel. Turning it off costs 50 cases (20/77), so the gate carries
  the result.
- **`fuzzy: true`.** A query term with no exact posting in scope also matches stored terms one
  edit away. The guard is: OSA distance 1, the same first two letters, at least four letters on
  both sides, no digits, and half weight. Turning it off costs 6 cases (64/77).
- **Metadata predicate and lifecycle prefilter before ranking.** The metadata predicate (here
  the PMB `scope`) is evaluated in the SQL of every channel. Records out of scope, superseded or
  expired therefore never take candidate budget from records that qualify.
- **Native abstention.** When nothing passes the gates, recall returns `[]` and the ledger records
  `no-candidates`, `no-named-match` or `below-floor`. 25 of the 77 cases expect an empty set.
- **Score floors.** `minScores: { keyword, semantic, reranker, final, finalRelative }` is
  available. The rc.2 runs set none.

Reproduce from the repository root, after `npm ci && npm run build`. The harness clone and the
provider-registration patch step need the network once; scoring is offline. Both steps are in
[`benchmarks/precisionmembench/README.md`](../benchmarks/precisionmembench/README.md).

```sh
node benchmarks/precisionmembench/run.mjs --label merged-lexical --retrieval lexical --metadata protocol --both
node benchmarks/precisionmembench/run.mjs --label merged-hybrid  --retrieval hybrid  --metadata protocol --both
node benchmarks/precisionmembench/run.mjs --label A2-ablate-nonames-lexical --retrieval lexical --metadata protocol --both --named false
node benchmarks/precisionmembench/run.mjs --label A2-ablate-nofuzzy-lexical --retrieval lexical --metadata protocol --both --no-fuzzy
```

`run.mjs` exits 3 on these runs, because the single-turn ava suite exits 1 on the 7 failing cases.

**The seven remaining failures are the single-turn protocol ceiling.** In every remaining failure,
one belief is returned that the case expects excluded. The reason for the exclusion is lifecycle
metadata that the single-turn protocol does not send: `type`, `superseded_by` or `resolved_at`.
Each query names the offending belief by one of its own aliases, so a names gate must admit it,
and nothing else on the wire tells it apart from a current belief. The kernel could match content
words such as "Previously", but that would be fixture-specific, so it does not.

The cases are:

- `conflict-mongodb-supersedes-sqlalchemy`
- `filter-resolved-at-excluded`
- `type-isolation-open-question-not-in-relevant`
- `multi-hop-supersession-chain-all-excluded`
- `relation-type-expands-participants`
- `pinned-plus-resolved-excluded-from-questions`
- `superseded-chain-query-terminal-only`

The per-case table, with the belief returned and the field that excludes it, is in the
[PrecisionMemBench README](../benchmarks/precisionmembench/README.md#the-seven-remaining-failures-and-why-configuration-a-cannot-pass-them).
The kernel does exclude superseded and expired records natively
(`tests/local-precision-lifecycle.test.ts`). It cannot do so when the protocol never tells it a
record is superseded.

**What 70/77 is not:**

- **It is not a held-out precision estimate.** The fixture is public and small (35 beliefs), and
  the kernel controls were designed against its failure classes: names in the query, typos and
  scope. Read it as "the kernel with its names gate, on this fixture".
- **The names gate abstains on implicit references by design.** A record that declares names
  cannot be reached by a query that never names it. The gate is opt-in for that reason.
- **The wrapper makes translation choices that a different wrapper could make differently.**
  - The canonical name is the first word of the belief text.
  - On `PUT /update`, inserted alias words become names one word at a time.
  - `kinds: ['fact','preference','decision']` leaves out `observation`.
- **The cross-encoder neither helped nor hurt.** The reranked run ties the unreranked one at
  70/77.
- **The latency effect is not established.** The runs were made on a machine at load average
  16–26. An interleaved before/after sample on 100 LongMemEval questions showed about +10–25 % p50
  recall latency, and a synthetic micro-benchmark was mixed. Rerun on an idle machine before
  quoting latency.

### 1.2 rc.1 results (history: kernel `e0bbb47`, wrapper-side filters)

| Label | Configuration | Single-turn | Precision | Recall | Active-retrieval passes | Session | Session P / R |
|---|---|---|---|---|---|---|---|
| lexical-protocol-raw | lexical BM25, protocol-exact, no wrapper filter | 22/77 (28.6 %) | 0.262 | 0.954 | 7 | not run | — |
| A-lexical | lexical BM25, protocol-exact, absolute floor 3 + relative cutoff 0.5 | 44/77 (57.1 %) | 0.595 | 0.841 | 24 | 5/12 | 0.662 / 0.758 |
| A-hybrid | hybrid (bge-small-en-v1.5 + BM25, RRF k=10), protocol-exact, minSimilarity 0.65 + relative cutoff 0.5 | 48/77 (62.3 %) | 0.611 | 0.913 | 31 | 6/12 | 0.694 / 0.955 |
| B-lexical | A-lexical + extended metadata (harness patch, **not comparable**) | 50/77 (64.9 %) | 0.631 | 0.786 | 24 | 5/12 | 0.735 / 0.848 |
| B-hybrid | A-hybrid + extended metadata (harness patch, **not comparable**) | 53/77 (68.8 %) | 0.666 | 0.913 | 31 | 7/12 | 0.781 / 0.955 |

In rc.1 the number to quote was A-hybrid, 48/77. Configuration B applies a disclosed patch to the
harness (`benchmarks/precisionmembench/patches/pmb-extended-metadata.patch`) so that the kernel
also receives `type`, `superseded_by`, `created_at` and `resolved_at`. B is not comparable with any
provider scored on the stock harness, and it has not been re-run on the rc.2 kernel.

How the rc.1 runs were produced:

- **Filter values.** The rc.1 wrapper-side filters were chosen by sweeping the public fixture
  (`reports/precisionmembench/sweep-*/sweep.json`, 29 configurations).
- **Removed flags.** The `--min-score`, `--min-sim` and `--cutoff` flags that applied those filters
  have been removed from `run.mjs`, which now rejects them. The rc.1 commands therefore reproduce
  only on the rc.1 branch. The raw rc.1 outputs stay in `reports/precisionmembench/<label>/`.
- **Recorded commit.** The `kernelCommit` recorded in the rc.1 run summaries is `e0bbb47`, because
  the wrapper was uncommitted when the runs were made. A verifier re-ran A-hybrid at `593cbae` and
  reproduced 48/77 exactly.

The rc.1 losses, and their status in rc.2:

| rc.1 loss | rc.2 status |
|---|---|
| No native abstention threshold in `recall()`/`compile()` (the reason for the wrapper filters) | Fixed in the kernel: native abstention, names gate, score floors and `ContextPacket.abstention`. |
| Fuzzy and typo queries failed 4 of 7 on the lexical path | Fixed: guarded single-edit fuzzy matching. The no-fuzzy ablation loses 6 cases. |
| Compound 6–8 entity queries lost true hits to the relative cutoff | No longer applies: there is no cutoff, and recall is 1.000. |
| "Nothing relevant" queries kept noise | Fixed on this fixture: they abstain natively. |
| The reranker never helped | Still true: it ties at 70/77. |
| Session mode 6/12 | 12/12. |

## 2. Adversarial poisoning suite v1 (ours, synthetic, offline)

The suite is `benchmarks/poisoning/v1/cases.jsonl`: **227 synthetic cases**, of which 167 are
attacks and 60 are benign controls (26.4 %).

- It is generated deterministically from seed `poisoning-v1`.
- Its sha256 is `4b5d665d881b4bbcf0152733a8a51e98c19671f03539d9742d514ae6240ee336`, and the test
  suite regenerates it byte-identical.
- The classes follow MemForm's five formation interfaces, plus one of ours: content, evidence,
  scope-leak, selection, path (consolidation order) and erasure-return.
- Each case runs in a fresh in-memory SQLite store on the lexical path with a fixed clock. There
  is no network and no model.

### 2.1 Default mode (unchanged since rc.1)

| Class | Attack cases | Escapes | Benign controls | False quarantines |
|---|---:|---:|---:|---:|
| content | 30 | 0 | 10 | 0 |
| evidence | 25 | 0 | 10 | 0 |
| scope-leak | 30 | 0 | 10 | 0 |
| selection | 26 | 0 | 10 | 0 |
| path | 42 | 0 | 15 | 0 |
| erasure-return | 14 | 0 | 5 | 0 |
| **total** | **167** | **0** | **60** | **0 (0.00 %)** |

The result is **zero escapes on poisoning suite v1 (227 cases), reproducible from a fresh clone**.
The false-quarantine gate is below 2 %. This is a statement about these 227 cases. It is not a
claim that the kernel cannot be poisoned.

```sh
npm run poisoning   # = node dist/evaluation/poisoning/cli.js --cases benchmarks/poisoning/v1/cases.jsonl --out reports/poisoning/v1
```

The report is in `reports/poisoning/v1/report.{json,md}`, and the run takes about 2 s.
`reports/poisoning/v1` is byte-identical before and after the consolidation work.

The suite's power was checked by switching off one kernel guard at a time in a scratch build.
Every mutant failed the gate. For example, there were 71 escapes without the untrusted-exclusion
rule, 22 without agent scope and 13 without the candidate ancestry check. The full table is in
`docs/POISONING-SUITE.md`.

### 2.2 Consolidation on (rc.2)

The same 227 cases run with consolidation passes between each case's attack steps and its probes.
Every principal records judged retrievals of its own and runs four signed passes through the
outcome gate:

- the deterministic proposer;
- an aggressive-merge proposer;
- an undeclared laundering adversary (synthetic);
- a declared laundering adversary (synthetic).

Probes also count consolidation outputs derived from a poisoned record as the poison.

| Mode | Attack escapes | False quarantines | Errors | Passes through the gate |
|---|---:|---:|---:|---|
| Default (`npm run poisoning`) | 0 / 167 | 0 / 60 | 0 | none |
| **Consolidation on** | **0 / 167** | **0 / 60** | **0** | **294**: 11 kept, 184 rolled back (all by invariant), 99 `no_evidence`, 0 `invalid_run`, 0 `conflict`; laundering passes kept: **0**; verdict-chain failures: 0 |
| Ungated negative control | 85 / 167 | 0 / 60 | 0 | every pass the gate did not keep is applied anyway: 195 stored, 92 refused by the kernel's dependency-trust rule |

The negative control shows that the probes would catch laundered content if the gate let it
through. Its 85 escapes are content 30, selection 24 and path 31. Every pass the gate rolled back
in the suite and the demo is published with its signed receipt in
`reports/consolidation/rejected-passes.jsonl`, 186 lines:

- 184 come from the suite, all laundering;
- 2 come from the demo, one regression and one laundering.

```sh
node dist/evaluation/poisoning/cli.js --cases benchmarks/poisoning/v1/cases.jsonl --out reports/poisoning/v1-consolidation --consolidation
node dist/evaluation/poisoning/cli.js --cases benchmarks/poisoning/v1/cases.jsonl --out reports/poisoning/v1-consolidation/ungated-control --consolidation --ungated-control
node dist/consolidation/rejected-passes.js --suite reports/poisoning/v1-consolidation/rejected-passes.jsonl --out reports/consolidation
```

### 2.3 Limits, stated plainly

- The content and selection classes test the **trust-label gate**, not content inspection. A
  record written as `observed` is served as observed. Trust is decided by channel and provenance.
- Only the **lexical** path is exercised. Dense and hybrid retrieval are not covered by v1, and
  the consolidation gate replays lexically.
- In consolidation mode the synthetic verifier counts any non-empty recall as a success. So the
  suite never exercises the regression rollback (0 regression rollbacks). The zero-escape result
  rests mostly on the invariants, not on the replay gate. 99 of 294 passes had too few judged tasks
  to be scored (`no_evidence`, which is not a keep), and only 11 were kept. The regression path is
  exercised by the consolidation demo and its tests (section 3).
- `import()` still accepts a hand-built snapshot's trust label when the record has no
  dependencies. v1 does not test this as an attack.
- A failed outcome removes a record from `compile()` but not from `recall()`.
- Decaying quarantine is not implemented.

### 2.4 M3 ancestry-disjoint promotion (enforced in code)

`LocalMemory.promote(id, { to, corroboration, reason })` raises a record's trust only when at
least two active corroborators of the target trust share **no provenance ancestor** with the
candidate or with each other. Ancestors are traced over dependencies, supersession, invalidation
source, source URI and author.

- Every decision, granted or quarantined, is a `promotion` ledger event with a readable verdict.
  When the rule refuses, the verdict names the shared node.
- Read the decisions with `memory.ledger({ event: 'promotion' })`.
- A grant supersedes rather than edits in place, so replay hashes stay stable.

Tests: `tests/local-promotion.test.ts` (13) and `tests/poisoning-suite.test.ts` (4).

## 3. Outcome-gated, reversible consolidation (rc.2)

A consolidation pass is a signed diff. It is replayed against the agent's own recorded outcomes,
and it is kept only when those outcomes do not regress and no invariant breaks. A kept pass can be
undone in one call. The design is in [CONSOLIDATION.md](CONSOLIDATION.md), and the signature and
receipt chain are in [CONSOLIDATION-SIGNING.md](CONSOLIDATION-SIGNING.md).

The demo runs offline, on synthetic data, with lexical replay:

```sh
node dist/cli/index.js consolidate --demo
```

It seeds a store with 11 records and 10 recorded tasks, then runs four passes:

| Pass | Verdict | Reason |
|---|---|---|
| 1 | `rolled_back` | Regression: proposal 1 alone has delta −1 over 10 tasks (per-proposal deltas [2, −1]). |
| 2 | `kept` | Delta 2 ≥ 0 over 8 replayed tasks, hold-out delta 0. Backoff dropped the faulted merge. |
| 3 | `rolled_back` | `no-trust-raise`, `declared-content` and `no-untrusted-to-policy` (laundering). |
| 4 | `no_evidence` | 0 replayable tasks. |

The demo then rolls back the kept pass in one call. The `replayState().stateSha256` after the
rollback equals the hash before the pass (`identical: true`), and the receipt chain verifies.

The same flow works on a file store through `mnemosy consolidate --propose | --apply | --rollback |
--verify-chain`. On that path:

- a re-applied diff is a `conflict`;
- a tampered diff is `invalid_run`;
- a second rollback is refused.

`tests/consolidation-{gate,signing,poisoning,cli,rejected-passes}.test.ts` assert these behaviours
and the hash equality. The CLI test checks the hash equality independently, through
`mnemosy replay --hash`.

Limits:

- The replay set is the agent's own judged retrievals. With the default ledger setting
  (`queries: 'digest'`) every pass is `no_evidence`. Recording query text is an explicit host
  choice.
- Replay is lexical. The `kinds` and `includeUntrusted` recall filters are not recorded, so they
  are not replayed.
- `supersede` and `delete` proposals are scored on a scratch copy but never applied live, because
  live passes only add records.
- The demo and suite keys are fixed public seeds.
- A signature binds the gate's inputs to its output. It says nothing about the truth of a merged
  text.
- **No improvement claim is made.** This is the mechanism for keeping only changes that do not
  regress recorded outcomes. Lift on held-out task families from the agent's own experience has
  not been measured.

## 4. Undeclared-dependency inference, dependency suite v1 (synthetic, rc.2)

`inferDependencies` proposes (dependent, premise) pairs from successful co-use in traces, the
retrieval ledger and outcome events (rule `co-use-success-v1`). A reviewer accepts or rejects each
proposal through `reviewDependency`. An accepted proposal becomes an ordinary declared dependency
through `correct(id, { dependencies })`, so the kernel's own cascade does the invalidation.
`MemoryRuntime.linkPremise` attaches an accepted premise to a runtime skill (M6).
`createPremiseGuard` holds a dependent whose co-used premise changed before anyone reviewed the
pair. Details are in [DEPENDENCIES.md](DEPENDENCIES.md).

The corpus is `benchmarks/dependencies/v1/corpus.json`. It is **synthetic**, generated from seed
`20261028` by generator `dependencies-v1-generator@1`, with sha256
`e56da493f548a94907b6f95b9f8c2c8d3a984b9ad7f079706921e3801aca0d6f`, and it regenerates
byte-identical. It contains:

- 228 records: 120 premises, 84 procedures and 24 runtime skills;
- 717 tasks;
- 160 true undeclared edges and 78 declared edges;
- five decoy classes: retrieved-unused, failed-only, sibling, incidental and hub.

| Metric | Value | Gate |
|---|---|---|
| Invalidation recall (micro) | **96.05 %** (170/177) | ≥ 90 % |
| Precision of accepted edges | **98.06 %** (152/155) | ≥ 95 % |
| Stale-procedure executions, guarded executor | **0** (248 checks, 120 corrections) | = 0 |

Ten robustness seeds were run with the same parameters: seeds 1–5 were used for tuning, and 11–15
were held out. Across them, recall was 92.4–96.8 % and precision 95.1–99.4 %, with 0 stale
executions through the guarded executor on every seed. The lead re-ran the gate seed on the merged
tree and got the same three numbers.

```sh
node dist/evaluation/dependencies/cli.js --corpus benchmarks/dependencies/v1/corpus.json --out reports/dependencies/v1 --seeds 1,2,3,4,5,11,12,13,14,15
```

The run takes about 5–8 minutes. `tests/dependencies-gate.test.ts` regenerates the corpus,
re-runs the gate seed and asserts the thresholds.

What these numbers rest on, stated plainly:

- **Stale = 0 depends on the premise guard.** It holds only if the executor filters `compile`,
  `recall`, `getSkill` and `isEligible` through `createPremiseGuard`. The kernel alone runs 7
  stale procedures on the gate seed. All 7 are true pairs that inference had not linked; there
  are 0 on declared or accepted pairs. The guard also over-holds 82–95 dependents per corpus,
  which is reviewer load, not invalidation.
- **Stale 0 with the premise guard; inference alone 7/248; guard false-hold rate 92.78 %.** The
  guard is a blanket hold on any dependent with one judged successful co-use with a changed
  premise, and it gives 0 on its own with zero accepted edges (84.54–93.14 % false holds across
  the robustness seeds). Inference adds the kernel-side links (170 of 177 pairs invalidated
  without the guard) and cuts guard holds from 272 to 97.
- **Stale = 0 also rests on the generator's observability floor.** Every true edge is forced into
  at least one judged successful task; without it (`--seed N --no-floor`) stale is 1 on the gate
  seed and 2 on seed 11. 295 of 405 decoys cannot count as support by construction, so precision
  is tested by the hub and incidental decoys only.
- **The eval accepts every proposal** (reviewer `eval-policy-accept-all`). In production each
  proposal is a reviewer's decision. Precision on real controller traces is unmeasured, and hub
  premises are the main source of false edges.
- **Some choices were made after seeing results.** All of them are disclosed in DEPENDENCIES.md:
  - the inference thresholds were swept on seeds 1–5;
  - the corpus parameter `rareRuns` was raised from 1 to 2 after seeds 1–10 (with 1, recall was
    85.8–92.2 %);
  - the guard default `holdReliance` was set to 0 after the first gate-seed run, which had 1 stale
    execution at 0.34.
- **A pair used together only once is invisible to inference.** Only the guard covers it.
- **Only the lexical path was measured.**

## 5. The five-moment demo (`mnemosy demo`, rc.2)

`npx mnemosy demo` runs five moments offline, on bundled synthetic corpora and the zero-model
lexical path. After each moment it prints a `PROOF` line with a number it has just measured. The
previous single-scenario JSON demo is `mnemosy demo --classic`. What each moment shows and does
not show is in [DEMO.md](DEMO.md).

| Moment | What it proves | Bar | Measured on the merged tree (one run, 2026-10-28) |
|---|---|---|---|
| 1. It remembers, and knows why | Replay determinism: two readers (this process and a separate cold-open process) at seeded `(asOf, knownAt)` cut points; as-of answers against ground truth taken from the plan | N/N identical hashes, every answer equal to ground truth | 1000/1000 identical (281 distinct states), 24000/24000 answers |
| 2. A correction fixes what nobody linked | Inferred dependencies accepted through `correct()`, then the premise is corrected | undeclared dependents invalidated X/X, accepted edges true Y/Y, 0 stale | measured live in each run |
| 3. It found the belief that made it wrong | `bisect` over a 2000-record synthetic store with one seeded false record | blame set equals the seeded record, under 60 s | precision 1.00, 1.53 s |
| 4. Someone tried to poison it, and it caught it | M3 refusal shown in the ledger, then suite v1 run live | 0 escapes, false quarantines below 2 %, 0 errors | 227 cases, 0 escapes, 0 false quarantines, 0 errors |
| 5. It got better on its own, and handed me the receipt | One consolidation pass kept, one rolled back, the kept one undone to the identical hash, chain verified | kept 1, rolled back 1, identical hash, chain ok | measured live in each run |

Counts are recomputed on every run, and times move with the machine. The demo's poisoning moment
is the same runner as `npm run poisoning`.

## 6. Retrieval regression check: LoCoMo and LongMemEval-S, before and after

The precision controls are opt-in. These runs confirm that the default retrieval path did not
move. Each was run before (`84cb6c3`) and after the precision work, with the same command.

| Benchmark | Condition | Before | After |
|---|---|---|---|
| LoCoMo, full set, zero-model | overlap recall@10 / MRR | 40.49 / 0.2899 | 40.49 / 0.2899 |
| LoCoMo, full set, zero-model | BM25 recall@10 / MRR | 52.47 / 0.3696 | 52.47 / 0.3696 |
| LoCoMo, conversations 0–2 (382 annotated) | hybrid recall@10 / MRR | 75.29 / 0.6325 | 75.29 / 0.6327 |
| LongMemEval-S cleaned, 470 annotated of 500 | lexical mean recall / MRR | 89.72 / 78.72 | 89.72 / 78.72 |
| LongMemEval-S cleaned, 470 annotated of 500 | BM25 mean recall / MRR | 95.08 / 89.57 | 95.08 / 89.57 |

```sh
node dist/evaluation/locomo-benchmark.js --lexical --out locomo-lexical.json
node --max-old-space-size=6144 dist/evaluation/corpus-cli.js --format longmemeval \
  --file benchmarks/data/longmemeval_s_cleaned.json --dataset-label LongMemEval-S-cleaned-full500 \
  --dataset-revision 98d7416c24c778c2fee6e6f3006e7a073259d48f --license MIT \
  --source-url https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json \
  --timestamp-policy question-day \
  --json '{"topK":20,"chunkBytes":4096,"maxContextUnits":8192,"maxCandidates":10000,"timeoutMs":600000,"includeBm25":true}' \
  --out lme-full500.json
```

The LoCoMo hybrid row ran on conversations 0–2 with the bundled models. These numbers are
retrieval coverage against a local scorer, not generated-answer accuracy.

## 7. What is not claimed

- **PrecisionMemBench 70/77 is not held out.** The public 35-belief fixture is the only data the
  benchmark has, and the kernel controls were designed against its failure classes.
- **The poisoning, consolidation, dependency and demo data are synthetic.** The labels come from
  generators we wrote, and real agent traces will not look like them.
- **The poisoning suite, the consolidation replay, the dependency eval and the demo use the
  lexical path only.** Hybrid retrieval was measured only on PrecisionMemBench and on the
  LoCoMo/LongMemEval regression check.
- **No comparison with another product is made on this page.** We have not run any other product
  through these harness commits.
- **MemSecBench is not scored and ConsolidationBench is not attempted** (sections 8 and 9).
- **No improvement-from-experience number exists yet.** The consolidation gate keeps only passes
  that do not regress recorded outcomes. Measured lift on held-out task families, with memory-off
  and shuffled-ledger controls, is future work, and no such lift is claimed.
- **Recall latency under the precision controls has not been measured on an idle machine.**

## 8. MemSecBench — not scored

[arXiv 2607.27080](https://arxiv.org/abs/2607.27080) has no public harness or case set, and it
scores with judge-model calls. `benchmarks/memsecbench/` holds:

- a four-operation backend adapter over the kernel;
- an offline self-test on **three synthetic cases of ours (6/6 checks; not a score)**;
- the exact cost arithmetic.

Under the assumptions written there, the costs are about US$31 for a local-agent run with one
Sonnet-class judge pass, about US$258 for one paid-agent run with three judge passes, and about
US$590 for three full paid-agent runs, each with a judge pass. The run is blocked on the authors'
310 cases and judge configuration.

## 9. ConsolidationBench — not attempted

[arXiv 2609.33013](https://arxiv.org/abs/2609.33013) releases its artifacts to reviewers on
request only. `benchmarks/consolidationbench/BLOCKER.md` records what is needed.

## 10. Engineering evidence in this release line

- **rc.2 test suite.** The full suite on the merged tree (`64ec27c`) passes: 92 files, 1,545
  tests (`npm run check`), with docs-link, public-metadata and example type checks green. The
  rc.1 tip (`6cb1342`) had 74 files and 1,434 tests, and the legacy package 8 files and 103
  tests.
- **Memory bisect on the default hybrid path (rc.1).** Oracle B rebuilds the exact retriever and
  carries stored vectors over, so a blame set is confirmed without re-embedding.
  `tests/local-bisect-hybrid.test.ts` runs end to end with the bundled models.
- **Issue #37 (rc.1).** Proposer and `runJobs` timeouts can be configured up to 300 s (lease up
  to 600 s, defaults unchanged). `tests/runtime-timeouts.test.ts` proves that a mock proposer
  answering after 90 s of fake time succeeds with `timeoutMs: 120000`.
- **Legacy engine removed from the public package (rc.1).** See `docs/MIGRATION-v3.md`. The blind
  legacy `dream()`/`consolidate()` consolidation no longer ships in `mnemosy-ai`. What remains is
  outcome-gated and reversible:
  - `reflect()` → `commitVerifiedLesson()`;
  - `promote()`;
  - in rc.2, the consolidation gate (`mnemosy-ai/consolidation`).

  The new `consolidate()` shares the old name, but it is a different function with a different
  signature (section 3).

## 11. Longer-standing measurements

Retrieval coverage on the project's own corpora, with fingerprints and protocol, lives in
[evaluation/BENCHMARKS.md](evaluation/BENCHMARKS.md). The same caveat applies there: it is
coverage against a local scorer, not generated-answer accuracy, and not superiority over other
systems.
