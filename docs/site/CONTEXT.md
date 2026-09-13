# Mnemosyne Adaptive Context

Turn a growing memory store into a bounded context with inspectable evidence. `AdaptiveContext` can use source-linked overviews, detailed projections, observations or exact original excerpts. When a generated representation's evidence changes, the builder withholds it and tries current originals instead.

## Budget and selection contract

The context budget covers the complete rendered evidence envelope, including its instructions, identities and citations. The default counter is a conservative UTF-8 byte estimate, not a model tokenizer. A host can supply an explicit tokenizer and identity. Selection is a deterministic packing method; fitting the budget does not guarantee that every fact needed for an answer was selected.

## Durable incremental compaction

Optional compaction uses an explicitly selected proposal callback and finite budgets. Stable source batches can reuse existing projections without another call, while changed batches produce new generations. Generated text remains private, observed advice with source dependencies. The library does not silently promote it to verified knowledge or start a model job during a normal context read.

## Freshness and exact expansion

Context construction checks source lineage, recorded outcomes, conflicts and watched-source freshness. Exact-source expansion lets the host inspect an original passage behind a representation. Correction or forgetting invalidates old projections and expansion handles. Unknown sources can be withheld when the host requires fresh confirmation; no source is fetched automatically.

## Structured projections

[Evidence Profiles](/docs/reference/PROFILES.html) apply the same lifecycle to typed fields, including unknown and conflicting values. Use [Memory Freshness](/docs/reference/MAINTENANCE.html) for explicit verification policies and [Evidence Gate](/docs/reference/EVIDENCE-GATE.html) when a host action depends on the selected context.
