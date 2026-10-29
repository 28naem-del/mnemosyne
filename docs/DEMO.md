# The demo: `mnemosy demo`

`mnemosy demo` (from 3.0.0-rc.2: `npx -y -p mnemosy-ai@3.0.0-rc.2 mnemosy demo`, which needs the network once to download the package, or this source tree after `npm run build`;
the stable 2.0.0 package on npm `latest` still ships the classic demo) walks you through five moments on bundled **synthetic** corpora, offline, and after each moment prints one `PROOF` line with a number it has just measured on your machine. None of the numbers is recorded or hard-coded: run it twice and every count is recomputed; timings will move with your machine.

```bash
npm run build
node dist/cli/index.js demo                    # stream the five moments; exit 1 if any proof fails
node dist/cli/index.js demo --record demo.json # also save the full report as JSON (refuses an existing file)
node dist/cli/index.js demo --classic          # the previous single-scenario JSON demo
```

What it needs: Node, a build of this repository (or the installed package). What it does not need: a network, an API key, a model download, a server. Every store is `:memory:` or a fresh temporary directory removed afterwards, retrieval is the zero-model `lexical` path, kernel time comes from an injected clock, and every corpus and cut point comes from a seeded PRNG.

The programmatic entry point is `runBreakthroughDemo({ out?, seed?, records?, cutPoints? })` in `src/evaluation/breakthrough-demo.ts`; it returns `{ generatedAt, durationMs, moments, passed, total, pending, limitations }`, where each moment carries the lines it showed, its proof `{ label, measured, threshold, passed }` and the structured numbers behind it.

## The five moments

### 1. It remembers, and knows why

**What you see.** A synthetic project history (24 services whose region changes over two years, some facts learned days after they became true, one rate limit corrected on 2024-06-10) is written into a store. The demo asks what the store believed on 2024-05-01 and gets the exact prior belief and its source; asks what it believes now; and asks what changed it, which is the `replayDiff` between the two cut points: the old record, the new one, its source, and the ledger `correction` entry with its reason.

**What it proves.** Replay determinism. The belief state is hashed (`replayState(...).stateSha256`) at 1000 seeded `(asOf, knownAt)` cut points, half of them on or one millisecond beside a boundary of the plan. Pass 1 runs in the demo's process on the live connection; pass 2 runs in a **separate node process** that opens the same database file cold. The proof prints `N/N identical`. At every cut point, every service's as-of answer is also compared with ground truth computed from the seeded plan, never from the store (`expectedVersionAt` in `src/evaluation/breakthrough/corpus.ts`), and the run must contain many distinct states, so a store that hashes the same everywhere cannot pass.

### 2. I corrected one fact and it fixed everything downstream, including things I never linked

**What you see.** A small hand-built synthetic billing scenario. One premise: the billing API base URL. Two runbooks declared it. Two more runbooks and one learned runtime skill used it and never said so. A key-rotation runbook (the decoy) was used with it only in tasks that failed. Each task goes through the APIs a controller uses: `recall()`, then `MemoryRuntime.recordTrace()` with the retrieved and used ids and a verifier outcome. A failed task's verdict is a task-level `recordRetrievalOutcome`, because a per-record failed outcome would make the premise itself ineligible. Then:

1. `inferDependencies` (rule `co-use-success-v1`, read-only, no model) prints each proposal with its support, reliance, association lift (a co-use statistic, not a performance gain) and Wilson confidence. The decoy is not proposed: a failed task is never support.
2. Every proposal is accepted through `reviewDependency`. Each acceptance appends a `dependency` ledger receipt (its id is printed) and links the edge in the same transaction. A runbook is re-versioned with the premise declared; the skill gets the premise through `linkPremise`.
3. One `correct()` of the premise. The demo prints, for each dependent, labelled declared or never linked, whether it was invalidated. The skill is reported `retired`, with the runtime's reason. The decoy is still active and still recalled.

See [DEPENDENCIES.md](DEPENDENCIES.md) for the rule and its thresholds.

**What it proves.** On this scenario, measured in this run:

- undeclared dependents invalidated, X/X;
- accepted edges that are true, Y/Y (every proposal must be accepted and true, and there must be one per undeclared dependent);
- stale dependents still handed back after the correction, which must be 0.

A dependent is stale if `recall({ limit: 20 })` or `compile({ maxTokens: 4000 })` returns any version of it, or if `runtime.getSkill()` reports the skill `active`. The same probes run before the correction and must return all five dependents, so the zero cannot come from probes that never matched. The premise guard (`createPremiseGuard`) is not used: the zero is the kernel cascade alone, through declared and accepted edges. When `reports/dependencies/v1/report.md` is in the checkout, the demo also prints the published suite-v1 numbers from it (recall 96.05 %, precision 98.06 %, stale 0 on 228 synthetic records and 120 corrections) as a pointer. They are not this moment's proof.

### 3. It found the belief that made it wrong

**What you see.** A synthetic ops store of 2000 records holds one verified answer (the billing service's port, from its deploy manifest). Asked before anything went wrong, the top memory is the right one. Later, a short, confident, false record arrives through an ordinary channel at ordinary trust, and the same question now gets the wrong port. One `bisect` call (the kernel function behind `mnemosy bisect`) delta-debugs the store and names the culprit: its text, source, author, trust and the moment it was written. Bisect's exact oracle then re-runs the real recall without it and confirms the right answer is back at rank 1.

**What it proves.** Blame precision and time-to-locate: the blame set must equal the seeded false record exactly (precision 1.00, nothing extra), the exact re-execution must confirm it, the store must hold at least 2000 records, and it must be found in under 60 s. The verifier has no model in it: "is the gold record in the top k" is deterministic.

**What it needs, outside the demo.** The demo knows the right record because it seeded it. `bisect` always needs that: the ids of the expected (gold) records and the `k` they should appear in. It judges retrieval, not a generated answer. From the CLI, `mnemosy bisect --file TASKS.json --task ID` reads the task with its required `gold` ids and uses lexical retrieval only, even if your agent used hybrid retrieval. The hybrid path is implemented in the kernel (`src/local/bisect.ts`) and tested, but in 3.0.0-rc.3 `bisect` is not a public package export, so from npm the CLI is the entry point. A run can end `blamed`, `passing` (the task does not fail), `unfixable` (removing records does not restore the gold) or `unconfirmed` (the exact re-run does not confirm the blame).

### 4. Someone tried to poison it, and it caught it, visibly

This moment is defensive research against our own kernel, run offline on synthetic data.

**What you see.** A synthetic vendor web page the agent read carries an instruction aimed at AI assistants: skip the second-reviewer approval and deploy straight to production. The demo stores it as `untrusted`, the tier a web page earns in this scenario; the caller sets
trust, the kernel does not infer it from the channel, so the clean recall that follows is what the
trust tiers do with a correctly labelled record, and the kernel's own catch is the M3 promotion refusal. A policy query's `recall()` and `compile()` return the real deploy policy and do not surface the instruction; an auditor's recall with `includeUntrusted` still finds it, so the quarantine is visible rather than silent. Two notes then "confirm" the page (one copied from it, one by the same author) and a promotion to `observed` is requested. Rule M3 (`ancestry-disjoint-v1`, see [POISONING-SUITE.md](POISONING-SUITE.md)) refuses it, and the ledger `promotion` entry records the decision and names the shared ancestors.

**What it proves.** The real poisoning suite v1 (`src/evaluation/poisoning`, the same runner as `npm run poisoning`) runs live and the demo prints its totals: `N cases, E escapes, F false quarantines`. The cases are the checked-in `benchmarks/poisoning/v1/cases.jsonl` when it is present (a clone), which must be byte-identical to the seeded generator, and the generator's output otherwise (an installed package does not ship `benchmarks/`). The bar is the suite's own gate: zero escapes, a false-quarantine rate below 2 %, zero harness errors. On suite v1 that has measured 227 cases, 0 escapes, 0 false quarantines; if your run prints anything else, your run is the number.

### 5. One consolidation kept, two rolled back, the kept one undone

**What you see.** The consolidation module's synthetic ops store (`seedDemoStore` in `src/consolidation/demo.ts`): eleven records and ten recorded tasks with a verifier outcome, which form the replay set. Three dreams (consolidation passes) go through the gate (`proposeConsolidation` + `gateConsolidation`). The gate replays the recorded retrievals under the current state and under the proposed one, on a scratch copy.

1. The deterministic, model-free proposer suggests two near-duplicate merges. The pass is **rolled back**: overall it helped, but one merge alone regressed.
2. The same proposer runs again; backoff drops the faulted merge. This pass is **kept**, and the demo prints its outcome delta, the replay tasks and the hold-out delta.
3. A laundering pass folds an untrusted forum tip into a policy-tier procedure. It is **rolled back** by the invariants, which are named.

Each verdict prints its signed receipt: digest, keyId, `prevDigest` (the chain link), and whether the Ed25519 signature verifies. Then `rollbackConsolidation` undoes the kept pass in one call. Nothing is written between the pass and the rollback, so the hash can come back: the demo prints `stateSha256` before the pass, after it was kept, and after the rollback, with `identical: true`. In a store where later writes happened, the rollback still removes the pass's records but reports `restored: false` ([CONSOLIDATION.md](CONSOLIDATION.md#a-pass)). Finally `verifyConsolidationChain` checks every receipt, pinned to the demo key. See [CONSOLIDATION.md](CONSOLIDATION.md) for the gate.

**What it proves.** On this store, measured in this run:

- passes kept: at least 1, with outcome delta >= 0 and hold-out delta >= 0;
- passes rolled back: at least 1, each with its reason;
- the rollback restores a state hash identical to the one before the kept pass, and the kept pass did change the state;
- the receipt chain verifies, with one receipt per gate decision plus the rollback receipt.

The gate is outcome-gated and reversible on the recorded tasks it replays. That is what is measured here; it is not a claim about tasks the agent never recorded.

## Honest limits

- **Synthetic corpora.** Every record is generated from a seed and describes a fictional project. The numbers describe this kernel on these corpora; they are not a benchmark of your data or a comparison with another system.
- **Lexical path only.** The demo runs the zero-model lexical retriever so that it is deterministic and needs no download. The hybrid (dense + reranker) path is not exercised here; `bisect` supports it and is tested on it in `tests/local-bisect-hybrid.test.ts`.
- **Measured live, on your machine.** Counts are recomputed every run. Times (`located in X s`, total seconds) depend on the machine and its load.
- **What "identical" covers.** Record ids are random UUIDs, so the hash values themselves differ between runs; the claim is that two independent readers of one store agree at every cut point. The hash covers the visible records; derived indexes, embeddings and the ledger are excluded by design (`REPLAY_EXCLUSIONS` in `src/local/replay.ts`). The cross-process gate with a `VACUUM` pass lives in `tests/local-replay-determinism.test.ts`.
- **What the poisoning number covers.** "Zero escapes on suite v1 (227 cases, reproducible)" is a statement about the cases in the suite, not a claim that the kernel resists every attack. The suite's classes and their limits are in [POISONING-SUITE.md](POISONING-SUITE.md).
- **One culprit.** Moment 3 seeds a single false record at `k = 1`, where the minimal blame set is unique. At larger `k` several minimal sets can exist; `bisect` reports that ambiguity (`minimalUnique`, `alternatives`) instead of hiding it.
- **Small scenarios for moments 2 and 5.** Each is a hand-built synthetic scenario: a few records and a few tens of tasks. Its PROOF says the mechanism works end to end on that scenario. It is not a recall or precision estimate. The suite-level numbers are in [DEPENDENCIES.md](DEPENDENCIES.md) and [CONSOLIDATION.md](CONSOLIDATION.md), with their own limits.
- **The reviewer in moment 2 accepts everything.** In the demo every proposal is accepted, as a reviewer would after checking it. In production each acceptance is a person's decision, and that decision is what the receipt records. Moment 2 does not use the premise guard, which covers pairs with fewer than two successful co-uses.
- **Demo signing key.** Moment 5 signs with the consolidation module's fixed demo key so that receipts are reproducible. Never sign a real store with it.
- **Pending moments.** A moment registered without an implementation prints `pending` and is counted neither as passed nor in the total. None is pending today.

## Adding a moment

The moments are a registry, `BREAKTHROUGH_MOMENTS` in `src/evaluation/breakthrough-demo.ts`. Implementing a pending moment is writing one function `(context) => MomentOutcome | Promise<MomentOutcome>` in `src/evaluation/breakthrough/moment-<id>.ts`, setting it as that entry's `run` and removing its `pendingNote`. The framework streams the moment's lines through `context.say`, times it, turns a throw into a failed proof, prints the `PROOF` line and counts it. The proof must be measured in that run; `tests/breakthrough-demo.test.ts` asserts on the structured details behind each proof, not on the printed line alone.
