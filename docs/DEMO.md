# The demo: `mnemosy demo`

`npx mnemosy demo` walks you through five moments on bundled **synthetic** corpora, offline, and after each moment prints one `PROOF` line with a number it has just measured on your machine. None of the numbers is recorded or hard-coded: run it twice and every count is recomputed; timings will move with your machine.

```bash
npm run build
node dist/cli/index.js demo                    # stream the five moments; exit 1 if an implemented proof fails
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

**Pending.** Registered with a `pending` proof; it arrives with the inferred-dependency work (`src/dependencies`), whose accepted edges go through `correct(id, { dependencies })` so the correction cascade reaches records nobody linked by hand.

### 3. It found the belief that made it wrong

**What you see.** A synthetic ops store of 2000 records holds one verified answer (the billing service's port, from its deploy manifest). Asked before anything went wrong, the top memory is the right one. Later, a short, confident, false record arrives through an ordinary channel at ordinary trust, and the same question now gets the wrong port. One `bisect` call (the kernel function behind `mnemosy bisect`) delta-debugs the store and names the culprit: its text, source, author, trust and the moment it was written. Bisect's exact oracle then re-runs the real recall without it and confirms the right answer is back at rank 1.

**What it proves.** Blame precision and time-to-locate: the blame set must equal the seeded false record exactly (precision 1.00, nothing extra), the exact re-execution must confirm it, the store must hold at least 2000 records, and it must be found in under 60 s. The verifier has no model in it: "is the gold record in the top k" is deterministic.

### 4. Someone tried to poison it, and it caught it, visibly

This moment is defensive research against our own kernel, run offline on synthetic data.

**What you see.** A synthetic vendor web page the agent read carries an instruction aimed at AI assistants: skip the second-reviewer approval and deploy straight to production. It is stored at the trust its channel earned, `untrusted`. A policy query's `recall()` and `compile()` return the real deploy policy and do not surface the instruction; an auditor's recall with `includeUntrusted` still finds it, so the quarantine is visible rather than silent. Two notes then "confirm" the page (one copied from it, one by the same author) and a promotion to `observed` is requested. Rule M3 (`ancestry-disjoint-v1`, see [POISONING-SUITE.md](POISONING-SUITE.md)) refuses it, and the ledger `promotion` entry records the decision and names the shared ancestors.

**What it proves.** The real poisoning suite v1 (`src/evaluation/poisoning`, the same runner as `npm run poisoning`) runs live and the demo prints its totals: `N cases, E escapes, F false quarantines`. The cases are the checked-in `benchmarks/poisoning/v1/cases.jsonl` when it is present (a clone), which must be byte-identical to the seeded generator, and the generator's output otherwise (an installed package does not ship `benchmarks/`). The bar is the suite's own gate: zero escapes, a false-quarantine rate below 2 %, zero harness errors. On suite v1 that has measured 227 cases, 0 escapes, 0 false quarantines; if your run prints anything else, your run is the number.

### 5. It got better on its own, and handed me the receipt

**Pending.** Registered with a `pending` proof; it arrives with the consolidation work (`src/consolidation`): one consolidation kept because a measured outcome improved, one rolled back because it did not, each with its ledger receipt.

## Honest limits

- **Synthetic corpora.** Every record is generated from a seed and describes a fictional project. The numbers describe this kernel on these corpora; they are not a benchmark of your data or a comparison with another system.
- **Lexical path only.** The demo runs the zero-model lexical retriever so that it is deterministic and needs no download. The hybrid (dense + reranker) path is not exercised here; `bisect` supports it and is tested on it in `tests/local-bisect-hybrid.test.ts`.
- **Measured live, on your machine.** Counts are recomputed every run. Times (`located in X s`, total seconds) depend on the machine and its load.
- **What "identical" covers.** Record ids are random UUIDs, so the hash values themselves differ between runs; the claim is that two independent readers of one store agree at every cut point. The hash covers the visible records; derived indexes, embeddings and the ledger are excluded by design (`REPLAY_EXCLUSIONS` in `src/local/replay.ts`). The cross-process gate with a `VACUUM` pass lives in `tests/local-replay-determinism.test.ts`.
- **What the poisoning number covers.** "Zero escapes on suite v1 (227 cases, reproducible)" is a statement about the cases in the suite, not a claim that the kernel resists every attack. The suite's classes and their limits are in [POISONING-SUITE.md](POISONING-SUITE.md).
- **One culprit.** Moment 3 seeds a single false record at `k = 1`, where the minimal blame set is unique. At larger `k` several minimal sets can exist; `bisect` reports that ambiguity (`minimalUnique`, `alternatives`) instead of hiding it.
- **Pending moments.** Moments 2 and 5 print `pending` and are counted neither as passed nor in the total until their implementations land.

## Adding a moment

The moments are a registry, `BREAKTHROUGH_MOMENTS` in `src/evaluation/breakthrough-demo.ts`. Implementing a pending moment is writing one function `(context) => MomentOutcome | Promise<MomentOutcome>` in `src/evaluation/breakthrough/moment-<id>.ts`, setting it as that entry's `run` and removing its `pendingNote`. The framework streams the moment's lines through `context.say`, times it, turns a throw into a failed proof, prints the `PROOF` line and counts it. The proof must be measured in that run; `tests/breakthrough-demo.test.ts` asserts on the structured details behind each proof, not on the printed line alone.
