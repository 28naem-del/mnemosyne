# Mnemosyne Recovery

Recover a complete local database through consistent backups, integrity checks and restoration into a new path. The operations module is an operator capability: a full backup includes every workspace, agent, private record, history version, pending job and deletion tombstone in that database. Use a scoped export when only one agent's portable records are intended.

## Backup, verify and restore

The backup operation captures committed database state consistently, including active journal state. Verification checks the bundle format, sizes, digests and database integrity. Restoration verifies before publishing a new database file; it does not replace a running database, merge owners or choose an application cutover.

## Bundle and verification contract

Backup bundles contain memory content in **plaintext**. Protect them with your own storage access controls and encryption. A digest detects changes relative to a manifest; it is not an authenticity signature. Keep an independently trusted receipt when that comparison matters. Structural integrity does not certify the truth of stored memories.

## Filesystem safety and cancellation

Outputs must be new, and the operator controls the containing directories. Operations have explicit size and deadline bounds and reject unsafe path collisions. The process does not restart services or alter application configuration. Check available storage and verify recovery in an isolated location before a cutover.

## Compatibility and evidence

A backup preserves the state at its snapshot time. Deletion tombstones already present remain effective after restore; later deletions cannot be inferred from an older backup. Apply your retained deletion policy before exposing restored data. Forgetting live memory does not erase previous bundles, exports or copies delivered to an agent.
