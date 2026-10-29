# Mnemosyne Recovery

Recover a complete local database through consistent backups, integrity checks and restoration into a new path. The operations module is an operator capability: a full backup includes every workspace, agent, private record, history version, pending job and deletion tombstone in that database. Use a scoped export when only one agent's portable records are intended. A plain backup holds the SQLite database file only. The consolidation signing key is a separate file and is not included; from 3.0.0-rc.4 an encrypted backup (`--encrypt`) includes it ([see below](#the-consolidation-signing-key)).

## Backup, verify and restore

The backup operation captures committed database state consistently, including active journal state. Verification checks the bundle format, sizes, digests and database integrity. Restoration verifies before publishing a new database file; it does not replace a running database, merge owners or choose an application cutover.

## Bundle and verification contract

Plain backup bundles contain memory content in **plaintext**. Protect them with your own storage access controls and encryption. From 3.0.0-rc.4, `--encrypt` (library: `encryption: { passphrase }`) writes a passphrase-encrypted bundle instead (AES-256-GCM with a scrypt-derived key). A digest detects changes relative to a manifest; it is not an authenticity signature. Keep an independently trusted receipt when that comparison matters. Structural integrity does not certify the truth of stored memories.

## The consolidation signing key

A plain backup does **not** include the consolidation signing key. When consolidation runs on a file store, its Ed25519 private key lives in a separate file next to the database, `<db>.consolidation.key` (mode `0600`). A plain `backupLocalDatabase` or `restoreLocalBackup` never copies it. From 3.0.0-rc.4, an encrypted backup (`--encrypt`, or `encryption: { passphrase }`) includes `<db>.consolidation.key` when it exists, and restore writes it to `<new path>.consolidation.key` (mode `0600`). Restoring only the database therefore does not restore the ability to verify and undo earlier passes:

- `mnemosy consolidate --verify-chain` pins receipts to the key file that sits next to the database it opens. With no key file there, nothing is pinned.
- `mnemosy consolidate --rollback` trusts only that key by default. If the key file is missing, the command creates a new key, and receipts signed with the old key are refused.

If you use consolidation and keep plain bundles, back up the key file separately, in protected storage with the same care as any private key. Also keep the public `keyId` from a receipt in a separately trusted place, so you can check which key signed the chain. After restoring to a new path, put the key at `<new path>.consolidation.key` before you run `--verify-chain` or `--rollback`. Do not copy the key into a plain backup bundle or an export. The receipts are stored in the database, so they are included.

## Filesystem safety and cancellation

Outputs must be new, and the operator controls the containing directories. Operations have explicit size and deadline bounds and reject unsafe path collisions. The process does not restart services or alter application configuration. Check available storage and verify recovery in an isolated location before a cutover.

## Compatibility and evidence

A backup preserves the state at its snapshot time. Deletion tombstones already present remain effective after restore; later deletions cannot be inferred from an older backup. Apply your retained deletion policy before exposing restored data. Forgetting live memory does not erase previous bundles, exports or copies delivered to an agent.
