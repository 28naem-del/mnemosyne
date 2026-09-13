# Mnemosyne Gradual Migration

Connect an existing memory store alongside Mnemosyne and bring across the records your agent actually uses. `MemoryBridge` accepts a host-supplied search adapter, preserves returned source text and revisions, and makes reconciled records available to the agent. The existing backend is read-only from the bridge's perspective: Mnemosyne never changes or deletes its records. [Full migration](/docs/reference/MIGRATION.html) remains available for a deliberate bulk transfer.

## How adoption works

Adoption moves through shadow, assist and prefer-Mnemosyne phases as repeated paired searches demonstrate local retrieval coverage. Newly copied results do not count immediately as successful local retrieval. The old search still runs on every query and supplies missing matches; the bridge never automatically disconnects it. Progress measures observed search coverage, not the fraction of an entire account migrated or the quality of an agent's answers.

## Corrections, concurrency and rollback

Revision changes update the local source and invalidate dependent advice. Stale callbacks cannot commit after a newer request, rollback or erasure. `bridge.setMode('legacy')` rolls routing back while retaining local copies; `bridge.setMode('auto')` restarts gradual adoption. The host supplies scoped access, stable source identities and trust. An unavailable backend is reported explicitly rather than presenting an old copy as freshly confirmed.

## Privacy across gradual and full migration

Local forgetting removes source generations and dependent content, and matching origin identities block reimport through both migration paths. It does not delete external copies. The bridge stages local source records, so it requires capture permission and cannot run through a read-only agent. Limits cover responses, source sizes, context, deadlines and cancellation. See [agent integration](/docs/reference/AGENT.html) for final context validation.
