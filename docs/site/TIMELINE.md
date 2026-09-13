# Mnemosyne Timeline

Keep the difference between when a fact applied and when the system learned it. Mnemosyne records source revisions and supports separate `asOf` and `knownAt` query clocks. This lets a host ask what applied at an earlier date while controlling which recorded evidence was available to the agent.

## Two clocks, one traceable history

`asOf` selects real-world validity; `knownAt` limits recorded knowledge and outcome evidence. A correction closes the earlier source's current use while retaining an inspectable history until privacy erasure. Historical context validates dependencies against the requested view, so a later correction is not blindly applied to an earlier knowledge state.

## Conflicts and uncertain history

Different active assertions for an explicit fact identity remain conflicts. The system does not choose a convenient winner by similarity alone. Historical invalidations lacking enough recorded correction information remain conservative; a time query cannot manufacture missing provenance. Caller-supplied dates and source references are assertions, not authenticated external events.

## Forgetting still applies

Historical retrieval does not bypass privacy erasure. Forgetting removes live source content and its dependent records, including material that otherwise could have been inspected through an earlier view. Prior backups and context already delivered elsewhere remain separate copies. Use [Memory Freshness](/docs/reference/MAINTENANCE.html) for ongoing checks and [Recovery](/docs/reference/OPERATIONS.html) for snapshot boundaries.
