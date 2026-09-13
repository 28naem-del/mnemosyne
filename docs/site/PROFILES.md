# Mnemosyne Evidence Profiles

Keep a structured view of what an agent knows while preserving uncertainty. `MemoryProfiles` builds private, source-backed profiles from a host-defined schema. Each field is known, unknown or conflicted. Known values cite supporting sources; conflicting values keep their separate evidence instead of silently selecting a winner.

## Explicit refresh

The host selects sources and a proposal callback for `profiles.refresh()`. Fields, values and citations are validated before persistence, and supplied inputs become dependencies. Reusing an unchanged, valid projection can avoid another proposal call. A profile cannot recursively refresh itself from an earlier version of the same definition.

## Freshness, correction and forgetting

Reads revalidate the stored profile and its source state. A correction, erasure, expiry or failed outcome can make the old projection stale, in which case old field values are withheld. Refresh is explicit; reconfirming a source does not automatically certify an earlier interpretation. Use source watches when fresh confirmation is required.

## Definitions, scope and limits

Profile definitions carry stable keys, versions and schema identities. They are private to the creating workspace and agent, with bounded fields, inputs and output sizes. A schema-valid, attributed value is still an advisory claim, not authenticated truth. The host controls source access, proposal execution and any sharing.
