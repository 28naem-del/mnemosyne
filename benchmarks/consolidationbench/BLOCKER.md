# ConsolidationBench — not attempted (artifacts not public)

ConsolidationBench is Phase 3 of arXiv [2609.33013](https://arxiv.org/abs/2609.33013),
"The Epistemics of Agent Memory: Measuring, and Governing, the Consolidation Decision in
Long-Horizon LLM Agents" (v1 2026-09-26). Checked 2026-10-28: the arXiv page carries no code,
data or benchmark link; its comments say "per-phase result files and preregistrations available
to reviewers on request" and that "certain mechanism internals [are] held under controlled
release (see Section 7)". The brief for this sprint allowed an attempt only if the artifacts
were public, so none was made.

## What is needed to run it

1. The benchmark corpus and the oracle-by-construction optimum per task (the paper scores
   consolidation decisions "against a known optimum on three non-circular axes"; the axes are
   not named on the abstract page). Request from the authors.
2. The scoring code or an exact specification of the three axes and of "cross-level transfer",
   the metric on which the paper reports production retrieval systems at zero.
3. A statement of whether an LLM judge is involved (the abstract does not say); if it is, a
   cost estimate like `benchmarks/memsecbench/README.md`.

## What Mnemosyne would plug in

The kernel's consolidation path is `reflect()` → `commitVerifiedLesson()` (outcome-gated:
a lesson is stored only after its trial passed) plus `promote()` (ancestry-disjoint
corroboration, every decision in the ledger). A ConsolidationBench adapter would drive those
two calls from the benchmark's episode stream and hand the resulting record set to the scorer.
No part of this has been run; this file records the blocker only.
