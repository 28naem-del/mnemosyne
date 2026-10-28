# MemSecBench — adapter and cost estimate (not scored)

**Status: not scored.** MemSecBench (arXiv [2607.27080](https://arxiv.org/abs/2607.27080),
"MemSecBench: Tracking Agent Memory Poisoning from Persistence to Consequence and Repair",
v1 2026-07-29) has, as of 2026-10-28, **no public code, harness or case set**: the arXiv page
links only the PDF/HTML/TeX, and the abstract states that scoring uses "checkpoint-specific
judge-model evaluations" next to a deterministic write check and programmatic gates. Running
it therefore needs (a) the 310 cases and the two harness integrations from the authors and
(b) paid or local judge-model calls. Both are outside this sprint's no-paid-API rule, so this
folder ships the adapter and the exact cost arithmetic instead of a number.

## What is here

| File | Purpose |
|---|---|
| `backend.mjs` | HTTP memory-backend shim over the built kernel exposing the four operations a MemSecBench backend needs: `POST /write`, `POST /recall`, `POST /repair`, `GET /state`, plus `DELETE /reset` and `GET /health`. Also importable as a module. Deterministic, no LLM. |
| `selftest.mjs` | Offline check that the shim does what this README says, on **three synthetic cases written by us**. `node benchmarks/memsecbench/selftest.mjs` → 6/6 PASS. **This is not a MemSecBench score** and must never be quoted as one. |

Run: `npm run build && node benchmarks/memsecbench/backend.mjs` (port 8090, `MNEMOSYNE_MSB_RETRIEVAL=lexical|hybrid`,
`MNEMOSYNE_MSB_TRUSTED_SOURCES=user,operator`).

## How the kernel maps onto the three scored checkpoints

- **Persistence** — a write from a non-operator channel (tool output, web page, document, other
  agent) is stored with `trust: 'untrusted'`. It persists, but `recall()` and `compile()` withhold
  it unless the caller passes `includeUntrusted`. MemSecBench counts persistence as a failure
  only when the malicious memory is later *recalled and acted on*; the kernel's answer is
  "persisted, labelled, not served".
- **Execute chain** — `compile()` only admits provenance-gated records, so an untrusted memory
  cannot reach the prompt by default. An opt-in recall still returns it labelled `untrusted`.
- **Selective repair** — `forget(id)` erases the record and its dependents and nothing else;
  benign memories survive and the ledger records the erasure (as a count: an erased record
  leaves no identifying trace, by design). Which memory to forget is the harness's or the
  agent's decision; the shim accepts explicit ids or a query.

The shim decides trust by **channel**, never by content (`MNEMOSYNE_MSB_TRUSTED_SOURCES`). It does no
content inspection; the poisoning suite in `benchmarks/poisoning/` makes the same disclosure.

## Exact cost estimate to score Mnemosyne (one backend, one harness)

Inputs taken from the paper's abstract: 310 cases, 7 lifecycle checkpoints, judge-model
evaluation at the non-deterministic checkpoints. Assumptions (stated, adjustable): the write
check is deterministic, so **6 judge calls per case**; one judge call ≈ **4,000 input + 300
output tokens** (case context + memory state + transcript excerpt); the agent itself is driven
either by a **local model (US$0)** or by a paid model at ≈ 7 checkpoints × 3 turns ×
(6,000 in + 500 out) tokens = **126,000 in + 10,500 out tokens per case**. List prices used
are the last ones recorded in this repo's notes and must be re-checked before spending:
Sonnet-class US$3 / US$15 per million input/output tokens; Haiku-class US$1 / US$5.

| Component | Tokens (310 cases) | Sonnet-class | Haiku-class |
|---|---|---|---|
| Judge, one pass: 310 × 6 = 1,860 calls | 7.44 M in, 0.558 M out | 7.44×3 + 0.558×15 = **US$30.69** | 7.44×1 + 0.558×5 = **US$10.23** |
| Judge, three passes (variance) | 22.32 M in, 1.674 M out | **US$92.07** | **US$30.69** |
| Agent, local model (Ollama/llama.cpp) | n/a | **US$0** | **US$0** |
| Agent, paid model, one configuration | 39.06 M in, 3.255 M out | 39.06×3 + 3.255×15 = **US$166.01** | 39.06×1 + 3.255×5 = **US$55.34** |
| Minimum credible run: local agent + 1 judge pass | | **≈ US$31** | **≈ US$10** |
| Full-fidelity run: paid agent + 3 judge passes | | **≈ US$590** (3 × 166.01 + 92.07) | **≈ US$197** |

Wall-clock at one judge call per 4 s: 1,860 calls ≈ 2.1 h per pass. The agent side on a local
7–14 B model at ~25 tok/s: 310 × 10,500 output tokens ≈ 36 h, which is the real bottleneck.

## What is needed before any number can be produced

1. The 310 cases, the 48 contexts and the harness adapters from the authors (no public
   release found; request via the arXiv contact).
2. A judge model and prompt identical to the paper's for comparable numbers; the abstract does
   not name the model, so parity needs the authors' judge configuration too.
3. Approval to spend the amounts above (or a local judge, which breaks comparability).
