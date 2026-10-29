# Whole-database recovery

`mnemosy-ai/operations` provides consistent local SQLite backups, integrity verification and restoration into a new database path. A plain backup holds the SQLite database file only and never the consolidation signing key. An [encrypted backup](#encrypted-bundles) also carries that key, so a restore brings back both ([see below](#the-consolidation-signing-key)). This is an **operator filesystem capability**: a backup contains every workspace, agent, private record, version, control, pending job, idempotency receipt and forgetting tombstone in that database. It is not a scoped agent export or a way to bypass an application's authorization.

Use scoped `memory.export()` when you want that agent's portable export. Use this module when you deliberately need full database recovery. Unknown options—including attempted workspace or agent filters—are rejected rather than silently producing an unfiltered backup.

## Backup, verify and restore

```ts
import {
  backupLocalDatabase, verifyLocalBackup, restoreLocalBackup,
} from 'mnemosy-ai/operations';

const backup = await backupLocalDatabase({
  sourcePath: './memory.sqlite',
  backupPath: './backups/2026-09-13.mnemo-backup',
  maxBytes: 256 * 1024 * 1024,
  timeoutMs: 60000,
  signal: shutdown.signal,
});
const verified = await verifyLocalBackup({ backupPath: backup.backupPath });
const restored = await restoreLocalBackup({
  backupPath: backup.backupPath,
  targetPath: './recovery/memory.sqlite',
});
// Deliberately open restored.targetPath only after your application stops/chooses its old database.
```

The `backups` and `recovery` parent directories must already exist, be owned by the current operator, and not be writable by group or other users. The module does not create arbitrary parent directories, replace a running database, change application configuration, restart services or choose a recovery cutover for you. Output files use mode `0600`; staging directories use mode `0700` on supported POSIX filesystems. Use a local filesystem supporting hard links and normal SQLite locking semantics. POSIX permission checks are enforced; Windows recovery has not been validated.

`backupLocalDatabase` opens an independent read-only SQLite connection and uses the Node SQLite backup API to read a consistent snapshot, including committed state still in the WAL. A read transaction holds the snapshot while other connections can continue writing. It never copies just the live main file. Busy database locks fail within the bounded worker/deadline; ongoing writers can increase WAL retention until the snapshot finishes. SQLite may access/create its normal coordination sidecars even for a read-only SQL connection. The source main database is never intentionally modified.

The isolated worker normalizes its owned snapshot to rollback-journal mode, then checks SQLite integrity, foreign-key consistency, the supported user schema version and required Mnemosyne tables. It returns structural values only. A malformed source fails with a fixed diagnostic instead of returning SQL errors, row values or file paths. Verification does not attempt a full semantic audit of each stored memory or certify a maliciously fabricated database as trustworthy.

## Bundle and verification contract

Each plain (format 1) `.mnemo-backup` file contains a fixed magic/version header, a bounded JSON manifest and the complete standalone SQLite snapshot. The manifest records whole-database scope, creation time, database byte count, SHA-256, page count/size, schema version, and the integrity results. It contains no source path, workspace names, record text or credentials. The returned receipt also includes the SHA-256 of the entire bundle.

Verification checks the exact format, strict manifest shape, declared sizes, no trailing data, the database digest and SQLite integrity in an isolated worker. Restoration runs the same checks before publishing the extracted database, and checks its final digest again. It does not need backup WAL/SHM files and does not merge workspaces or restore over existing data. Tombstones present at the backup point continue to block replay after restore.

A digest proves consistency against the supplied manifest; it is **not an authenticity signature**. An attacker able to replace the bundle and its manifest can calculate new hashes. Keep the receipt in a separately trusted location if you need an independent comparison, and use your existing protected/encrypted backup storage. Plain bundles contain private data in plaintext; use [`--encrypt`](#encrypted-bundles) when the storage itself is not trusted with it. Forgetting a source later does not remotely erase older backups; retention and deletion of those backups remain operator responsibilities.

The backup covers the selected database only. A tombstone created after its snapshot cannot exist in that older snapshot. No system can infer those later deletions from the old backup alone; apply your operator's retained deletion policy before making restored data available.

## Encrypted bundles

```ts
const backup = await backupLocalDatabase({
  sourcePath: './memory.sqlite',
  backupPath: './backups/2026-10-29.mnemo-backup',
  encryption: { passphrase },          // from a secret store, never argv
});
await verifyLocalBackup({ backupPath: backup.backupPath, encryption: { passphrase } });
const restored = await restoreLocalBackup({
  backupPath: backup.backupPath, targetPath: './recovery/memory.sqlite', encryption: { passphrase },
});
// restored.signingKey?.path === './recovery/memory.sqlite.consolidation.key' (resolved), mode 0600
```

```sh
export MNEMOSYNE_BACKUP_PASSPHRASE=...      # or: --passphrase-file FILE (mode 0600)
mnemosy operations --action backup --db memory.sqlite --out archive.mnemo-backup --encrypt
mnemosy operations --action verify --file archive.mnemo-backup
mnemosy operations --action restore --file archive.mnemo-backup --out recovery/memory.sqlite
```

The passphrase comes from `encryption.passphrase` (1 to 4096 bytes; a string is used as its UTF-8 bytes, unnormalized). The CLI reads it from the `MNEMOSYNE_BACKUP_PASSPHRASE` environment variable or from `--passphrase-file FILE`, never from argv: `--passphrase` is refused, because the process list and shell history expose command lines. A passphrase file must be a regular file of at most 4096 bytes with no group or other permission bits (`chmod 600`; the check is skipped on Windows, which has no such bits), and one trailing `\n` or `\r\n` is removed. Giving both sources is an error. A plain backup ignores the environment variable, so encryption is never implicit; restore and verify use a supplied passphrase only for encrypted bundles.

With `encryption`, `backupLocalDatabase` includes the consolidation signing key `<sourcePath>.consolidation.key` when that file exists. `includeSigningKey: true` (CLI `--include-signing-key`) requires it, `false` leaves it out. The key must be a regular file holding a PKCS#8 PEM Ed25519 private key. Without `encryption`, `includeSigningKey` is rejected (`invalid-input`; the CLI says to add `--encrypt`). The receipt reports the key's public `keyId`, never the key.

Restoring an encrypted bundle needs its passphrase (`passphrase-required` otherwise). The bundle is decrypted into the private staging directory beside the target. Nothing is published until the GCM tag, the inner manifest, the database SHA-256, the key digest and `keyId`, and SQLite integrity in the isolated worker all pass. A wrong passphrase or any changed ciphertext, tag, salt, nonce or parameter byte fails with `decryption-failed` ("backup decryption failed: wrong passphrase or corrupted bundle"). The staging files are then removed and no database or key file is published. If the bundle carries the key, it is published at `<targetPath>.consolidation.key` (mode `0600`) by the same no-overwrite hard link, after the database. If a file already exists there, the restore fails with `target-exists` before decrypting and publishes nothing. If the key link fails after the database was published, the restore removes that database again (only if it is still the file this restore created), so you never get one without the other.

### Envelope (format 2)

All integers are big-endian. The design uses only Node's built-in `node:crypto`. **It is not [age](https://age-encryption.org)-compatible**: age uses X25519 or scrypt recipient stanzas with ChaCha20-Poly1305 in its STREAM construction, and it would need a dependency. Instead each field is documented here, so any scrypt + AES-256-GCM implementation can decrypt a bundle; the [test suite](../tests/operations-encrypted.test.ts) does so with plain `node:crypto` calls from these fields alone:

| Bytes | Field |
|---|---|
| 18 | `MNEMOSYNE-BACKUP2\n` |
| 4 | Length L of the plaintext manifest (1 to 4096) |
| L | Manifest, UTF-8 JSON (strict; unknown fields are rejected) |
| `payload.bytes` | AES-256-GCM ciphertext of the inner payload; the file ends exactly here |

The plaintext manifest is `{ format: 'mnemosyne-sqlite-backup', version: 2, scope: 'whole-database', createdAt, includes: ['database'] or ['database', 'consolidation-key'], encryption: { kdf: 'scrypt', params: { N, r, p }, salt, cipher: 'aes-256-gcm', nonce, tag }, payload: { bytes } }`. `salt` (16 random bytes), `nonce` (12 random bytes) and `tag` (16 bytes) are base64. The key is `scrypt(passphrase, salt, N, r, p, 32 bytes)` with N = 2^15, r = 8, p = 1 (32 MiB of memory) on write. On read, N from 2^14 to 2^17 is accepted, with r = 8 and p = 1, so a hostile manifest cannot request unbounded memory. GCM uses no additional authenticated data. Instead, `createdAt` and `includes` are repeated in the authenticated inner manifest and must match. The manifest holds no database digest, size or `keyId`; those are inside the ciphertext.

The decrypted payload is:

| Bytes | Field |
|---|---|
| 19 | `MNEMOSYNE-PAYLOAD2\n` |
| 4 | Length M of the inner manifest (1 to 4096) |
| M | Inner manifest JSON: `{ format: 'mnemosyne-sqlite-backup-payload', version: 2, createdAt, includes, database: { bytes, sha256, userVersion, pageCount, pageSize, integrity, foreignKeys }, consolidationKey?: { bytes, sha256, keyId } }` |
| `database.bytes` | The standalone SQLite snapshot (same as a plain bundle's) |
| `consolidationKey.bytes` | Only with `consolidation-key`: the key file's PEM bytes, unchanged |

Format 1 bundles keep their exact format, strict manifest and behaviour. Verify and restore read both formats.

The passphrase protects confidentiality and integrity against anyone who does not know it. It does not prove who made the bundle: anyone with the passphrase can make a valid one. scrypt slows guessing, but a short or reused passphrase can still be guessed offline from a stolen bundle. Use a long random passphrase kept in a secret manager. Losing the passphrase loses the bundle; there is no recovery path. During an encrypted backup the plaintext snapshot exists only in the private staging directory beside the output, as for a plain backup, and is removed before the call returns.

## The consolidation signing key

When consolidation runs on a file store, its Ed25519 private key lives in a separate file next to the database, `<db>.consolidation.key` (mode `0600`). **Only an [encrypted bundle](#encrypted-bundles) includes it.** A plain backup never does, and a plain restore never creates one. Restoring only the database does not restore the ability to verify and undo earlier passes:

- `mnemosy consolidate --verify-chain` pins receipts to the key file that sits next to the database it opens. With no key file there, nothing is pinned, and the CLI warns on stderr when the store has receipts.
- `mnemosy consolidate --rollback` trusts only that key by default. If the key file is missing, the command creates a new key, and receipts signed with the old key are refused.
- `mnemosy operations --action restore` warns on stderr when the restored database has consolidation receipts but no key file sits beside it.

If you use consolidation, prefer `--encrypt`: the restore then puts the key at `<new path>.consolidation.key` and `--verify-chain` passes with it pinned. If you keep plain bundles, back the key file up separately, in protected storage with the same care as any private key. After restoring to a new path, put the key at `<new path>.consolidation.key` before you run `--verify-chain` or `--rollback`. In both cases, also keep the public `keyId` from a receipt (and the expected chain head) in a separately trusted place, so you can check which key signed the chain. Never copy the key into a plain bundle or an export. The receipts are stored in the database, so every backup includes them.

## Filesystem safety and cancellation

Backup and restore outputs must not already exist, including dangling symlinks, directories or any adjacent `-wal`, `-shm` or `-journal` path. Journal-looking output filenames are rejected. Parent aliases are resolved before source/output comparisons. Source and its existing sidecars must be regular files, not symlinks; source sidecars with multiple hard links are rejected before SQLite opens them. Hard-linked aliases to existing targets are also rejected because the target already exists.

A private staging file is fully written, synchronized and verified before a hard-link operation atomically publishes it at the requested new path. Unlike a rename-overwrite, this operation refuses an existing file. The destination parent directory is synchronized before a successful receipt returns, to persist the new entry on supported POSIX filesystems. A filesystem/platform that cannot synchronize directories causes failure; the already-published file is preserved for operator verification, not deleted. No partial destination file is exposed. If another actor wins that destination name, its file is preserved. This requires a cooperative operator-owned directory: it is not a sandbox against a hostile process running under the same OS account or an administrator concurrently changing parent directories or staging files.

Each operation has a default snapshot bound of 256 MiB, configurable from 4 KiB through 4 GiB, and a default 60-second deadline, configurable from 1 millisecond through one hour. Staging and bundling require additional disk space, approximately twice the snapshot size during backup. Child SQLite work runs under `process.execPath` with no inherited environment, extensions disabled, and no network calls. Cancellation or timeout terminates the dedicated child and waits for its exit before cleanup. Hashing/copying yields between bounded chunks and checks the same deadline. OS filesystem calls and scheduling can introduce deadline overshoot; the checks prevent publication after an observed cancellation/deadline.

Cleanup only unlinks files whose device/inode identity still matches files this operation created. It does not recursively remove unexpected files or a replacement directory. A crash, killed SQLite journal, or unexpected entry can therefore leave a private `.mnemosyne-recovery-*` directory requiring operator inspection. The module never deletes an unknown entry merely to claim successful cleanup. Published backup or restored files are not deleted by a later cleanup failure.

`MemoryOperationError.code` gives a fixed failure category such as `target-exists`, `unsafe-path`, `invalid-backup`, `invalid-database`, `size-limit`, `cancelled`, `timeout`, `passphrase-required` or `decryption-failed`. No raw child stderr, SQLite exception, source content, user-supplied path, passphrase or key material is included in that error.

## Compatibility and evidence

Node's backup API is available from Node 22.16.0. The implementation was checked against the [Node 22.16 SQLite API](https://raw.githubusercontent.com/nodejs/node/v22.16.0/doc/api/sqlite.md) and its [backup implementation](https://raw.githubusercontent.com/nodejs/node/v22.16.0/src/node_sqlite.cc). Mnemosyne schema version 1 is accepted; an unfamiliar schema fails closed rather than being migrated by the operator tool.

Tests use fresh synthetic databases: live WAL, encrypted round trips with the signing key, wrong passphrases, tampered envelopes, multiple workspaces, pending observation jobs, forgotten-source replay, concurrent transactional writes, corruption, symlink/sidecar/alias paths, output races, cancellation and foreign cleanup entries. The [offline backup/restore example](../examples/backup-restore.ts) creates and removes only its own temporary database. Real production recovery and your storage platform's disaster-recovery process still require an operator rehearsal.
