# Consolidation gate

A consolidation pass rewrites memory, for example by merging two near-duplicate procedures into one. In Mnemosyne such a pass is a **signed diff**. The diff is replayed against the agent's own recorded outcomes. It is kept only when the outcomes do not get worse and no invariant breaks, and a kept pass can be undone exactly. The gate is outcome-gated and reversible. It is not a quality judge: no model scores the result, and the verdict is computed from what the ledger recorded.

The design of the signature and the receipt chain is in [the signing design note](CONSOLIDATION-SIGNING.md).

## Try it offline

```bash
npm run build
node dist/cli/index.js consolidate --demo                       # in memory, synthetic data
node dist/cli/index.js consolidate --demo --db ./demo.sqlite    # the same, in a new file you can continue
```

The demo seeds a synthetic store with 11 records and 10 recorded tasks, then runs four passes. Pass 1 is rolled back because one merge regresses a task. Pass 2 is kept: backoff drops the faulted merge. Pass 3 is a laundering attempt and is rolled back. Pass 4 runs on a store with no outcomes and gets `no_evidence`. The demo then undoes the kept pass and prints the state hash before the pass, after it was applied, and after the rollback. The first and the last are identical. To continue with the file store, use these commands:

```bash
S="--db ./demo.sqlite --workspace demo --agent ops-agent"
mnemosy consolidate $S --propose --out diff.json   # signed diff, nothing applied
mnemosy consolidate $S --apply --file diff.json    # gate it; applied only when kept
mnemosy consolidate $S --apply                     # propose and gate in one step
mnemosy consolidate $S --rollback PASS_ID          # one command; prints stateBefore/stateAfter/restored
mnemosy consolidate $S --verify-chain              # digests, links and signatures of every receipt
```

The route needs `read` and `write`, so `--read-only`, `--no-capture` and `--no-recall` refuse it. It signs with the store's own Ed25519 key in `<db>.consolidation.key`, which is created `0600` on first use. `--apply --file` accepts only a diff signed by that key. `--verify-chain` never creates a key.

From code, the same API is available from `mnemosy-ai` or `mnemosy-ai/consolidation`: `proposeConsolidation`, `gateConsolidation`, `consolidate`, `rollbackConsolidation`, `verifyConsolidationChain` and `createConsolidationSigner`. A host may also pass its own `proposer` function. Nothing in the module calls a model or the network.

## A pass

1. **Propose.** The proposer reads a candidate set: live, visible, usable records, excluding the untouchable ones. It returns proposals from a closed menu: `merge | supersede | split | delete | abstract`, with a cap per kind. The bundled `deterministicProposer` is model-free: it merges lexical near-duplicates of the same kind. The diff binds `{ workspaceId, agentId, cut, stateBefore, candidateSet (id + fingerprint), proposals, proposer }`. It is digested and signed.
2. **Invariants.** These run before any scoring and are recorded in the receipt:

   | Invariant | Rule |
   |---|---|
   | `menu`, `caps` | Closed menu and per-kind caps. |
   | `candidate-set` | Sources and dependencies stay inside the candidate set. |
   | `untouchable` | No `verified`, `checkpoint` or `advisory: false` record is touched. |
   | `sources-usable` | Every source is usable. |
   | `no-trust-raise` | An output is never more trusted than its sources. |
   | `declared-content` | Every output token comes from a declared source. |
   | `no-untrusted-to-policy` | No `procedure` or `decision` at trust `observed` or higher draws on an untrusted source or on content found only in untrusted records. |
   | `no-policy-escalation` | A policy-tier output needs a source of the same kind. |
   | `source-budget` | Outputs are not larger than their sources. |
   | `reversible` | Only additive kinds are applied live. |

3. **Replay.** The replay set is the ledger's judged retrievals: `recall` entries whose verifier slot was filled by `recordRetrievalOutcome`.
   - Gold ids are the ids that `recordOutcome` marked as used for that task. When there are none, a successful retrieval's own results are gold. Ids marked failed count as harmful.
   - Each task is replayed with its recorded query, `limit` and lexical scoring. This happens twice, on two fresh lexical scratch stores made with `export()` and `import()`: one is the current state S, the other is S plus the diff.
   - A task's score is the gold ids covered by the top-k minus the harmful ids covered. A derived record covers a source when it carries every token of that source.
   - The gate also scores an empty store (`noMemory`) and each proposal alone (`perProposal`).
   - When there are at least 10 tasks, a deterministic 20% hold-out is kept aside. It must not regress either.
4. **Verdict.** The verdict is one of the following, and every verdict writes a signed receipt:

   | Verdict | When |
   |---|---|
   | `kept` | Invariants hold, there are at least 2 replayable tasks, `delta >= 0`, the hold-out delta is `>= 0`, and every proposal alone is `>= 0`. The pass is applied in the same transaction as its receipt. |
   | `rolled_back` | An invariant failed, or there was a regression, a hold-out regression or a single-proposal regression. Nothing is applied. |
   | `no_evidence` | Fewer than 2 replayable tasks. This is **not** a keep. |
   | `invalid_run` | The digest or signature does not verify, the key is not trusted, the diff is malformed, or the scorer failed. |
   | `conflict` | The diff was signed over a different state, a candidate record changed, or another receipt was written while the pass was scored. |

5. **Apply and rollback.** A kept pass only adds records. Each output is a new private record that declares its sources as dependencies, has the source URI `consolidation:<passId>`, and is valid no longer than its sources. Because outputs declare their sources, a later `forget()` or `correct()` of a source reaches them through the kernel's own cascade. The receipt lists every created id with its fingerprint. `rollbackConsolidation` calls `rollbackUnchangedRecords` on exactly that set, so `replayState(...).stateSha256` after the rollback equals the pass's `stateBefore`. If any created record changed or gained dependent work, the rollback is a `conflict` and changes nothing.
6. **Backoff.** A rolled-back receipt marks which proposals were at fault. `proposeConsolidation` drops a faulted proposal, from any proposer, until the replay set has doubled; `backoff: false` turns this off. A kept proposal still in force is not proposed again. Pass 2 of the demo is pass 1 without its faulted merge.

Receipts form a hash chain: each `prevDigest` is the previous receipt's `digest` in the same workspace and agent. `verifyConsolidationChain` recomputes the chain and lists every key change.

## Poisoning suite with consolidation on

```bash
node dist/evaluation/poisoning/cli.js --cases benchmarks/poisoning/v1/cases.jsonl --out reports/poisoning/v1-consolidation --consolidation
```

Consolidation mode runs consolidation passes between each case's attack steps and its probes, for every principal. The [poisoning suite](POISONING-SUITE.md) cases stay byte-identical. The mode makes three changes:

- The ledger keeps query text.
- Each non-armed recall or compile probe is recorded once as a judged task. The synthetic verifier counts a recall as a success if it returned anything.
- Probes also consider records a kept pass derived from their targets. An attack probe counts any derived record that depends on a target or carries all of its tokens. A benign probe accepts a derived record that does both, but only as a stand-in after a miss. Armed probes are never widened.

Four proposers run per principal:

| Proposer | Behaviour |
|---|---|
| `deterministic` | The bundled proposer. |
| `aggressive-merge` | Jaccard 0.2. |
| `undeclared-laundering` | Policy text that carries an untrusted record's content without declaring it. |
| `declared-laundering` | The same content with the untrusted record declared as a source. |

Result on suite v1 (227 cases, synthetic, reproducible, report in [`reports/poisoning/v1-consolidation/`](../reports/poisoning/v1-consolidation/report.md)):

- **0 / 167 escapes, 0 / 60 false quarantines, 0 errors.**
- 294 passes: 11 kept, 184 rolled back by invariants (every laundering pass), 99 `no_evidence`, 0 laundering passes kept.
- Every receipt chain verifies against the pinned suite key.

The default mode is unchanged: it still blocks 167 of 167 attacks with 0 of 60 false quarantines, byte-identical to `reports/poisoning/v1`.

The negative control, `--consolidation --ungated-control`, applies every pass the gate did not keep. In this mode the kernel's dependency-trust rule refused 92 stores, and 85 of the 167 attacks escape ([control report](../reports/poisoning/v1-consolidation/ungated-control/report.md)). These escapes come from the passes the gate rejects.

## Rejected passes

```bash
node dist/consolidation/rejected-passes.js --suite reports/poisoning/v1-consolidation/rejected-passes.jsonl --out reports/consolidation
```

[`reports/consolidation/rejected-passes.jsonl`](../reports/consolidation/rejected-passes.jsonl) lists every pass the gate rolled back, in the demo and in the suite run: 186 lines.

- 2 come from the demo: one regression, with per-proposal deltas `[2, -1]`, and one untrusted-to-policy laundering.
- 184 come from the suite, all of them laundering.

Each line has the rejection class, the reason, the outcome deltas, the failed invariants, the verdict digest and `prevDigest`, and the full signed receipt. The publisher re-verifies every receipt before writing it. A summary is in `rejected-passes.summary.json`.

## Honest limits

- The replay set is the agent's own recorded outcomes, and nothing else. A pass can only be judged on the tasks the agent actually did and a verifier judged. A store with default ledger settings (`queries: 'digest'`) records no query text, so every pass on it is `no_evidence`. Recording query text (`ledger: { queries: 'text' }`) is an explicit host choice.
- `no_evidence` is not a keep. In the suite, 99 of 294 passes had too few judged tasks.
- Scoring is lexical replay of recorded queries. It cannot see dense or hybrid ranking. The ledger records neither `kinds` filters nor `includeUntrusted`, so they are not replayed.
- The scratch copy is built from `export()`. Records shared from other agents are absent from it, and the export size cap bounds the store size the gate can judge.
- `supersede` and `delete` are scored on the scratch copy but never kept: the kernel has no exact inverse for them yet. Live passes only add records.
- The suite, the demo and their keys are synthetic. The demo and suite keys are fixed public seeds and must never sign a real store. The result is stated as "zero escapes on suite v1 (227 cases, reproducible)" and says nothing about attacks outside the suite.
- A signature binds the gate's inputs to its output. It says nothing about the truth of a merged text. See the [design note](CONSOLIDATION-SIGNING.md#what-a-signature-means).
