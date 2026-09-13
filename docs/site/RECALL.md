# Mnemosyne Recall

Retrieve useful evidence while preserving ownership and source validity. Mnemosyne's default lexical ranking considers term rarity, frequency and document length. Ranking statistics are computed within the caller's eligible scope, so another owner's private corpus does not change those scores. Explicit overlap scoring remains available for compatibility and controlled comparisons.

## Meaning and exact matches

Hybrid retrieval combines lexical candidates with semantic similarity through an explicitly selected embedder. The semantic channel searches eligible indexed history before retaining its best candidates; an older memory is not discarded simply because it falls outside a recent-record window. An optional reranker can refine the retained candidates. This local search is exact scanning, not an approximate index with a service-latency guarantee.

## Evidence before advice

Retrieving a candidate and authorizing it as context are separate operations. Context compilation rechecks trust, source dependencies, conflicting facts, failures and the requested time view before returning advisory text. Missing or unusable evidence is withheld rather than filled with an invented answer. [Adaptive Context](/docs/reference/CONTEXT.html) controls how selected material fits the host's budget.

## Measure the right outcome

[Evaluation](/docs/#evaluation) publishes the measured retrieval comparison, source provenance and context-budget limitations. Source coverage is not generated-answer accuracy. Use [Local Intelligence](/docs/reference/LOCAL-INTELLIGENCE.html) for local embedding and reranking, and [Timeline](/docs/reference/TIMELINE.html) when the question depends on what was true or known at a particular time.
