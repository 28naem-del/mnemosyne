# Whole-database recovery

`mnemosy-ai/operations` provides consistent local SQLite backups, integrity verification and restoration into a new database path. This is an **operator filesystem capability**: a backup contains every workspace, agent, private record, version, control, pending job, idempotency receipt and forgetting tombstone in that database. It is not a scoped agent export or a way to bypass an application's authorization.

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

Each `.mnemo-backup` file contains a fixed magic/version header, a bounded JSON manifest and the complete standalone SQLite snapshot. The manifest records whole-database scope, creation time, database byte count, SHA-256, page count/size, schema version, and the integrity results. It contains no source path, workspace names, record text or credentials. The returned receipt also includes the SHA-256 of the entire bundle.

Verification checks the exact format, strict manifest shape, declared sizes, no trailing data, the database digest and SQLite integrity in an isolated worker. Restoration runs the same checks before publishing the extracted database, and checks its final digest again. It does not need backup WAL/SHM files and does not merge workspaces or restore over existing data. Tombstones present at the backup point continue to block replay after restore.

A digest proves consistency against the supplied manifest; it is **not an authenticity signature**. An attacker able to replace the bundle and its manifest can calculate new hashes. Keep the receipt in a separately trusted location if you need an independent comparison, and use your existing protected/encrypted backup storage. Bundles contain private data in plaintext. Forgetting a source later does not remotely erase older backups; retention and deletion of those backups remain operator responsibilities.

The backup covers the selected database only. A tombstone created after its snapshot cannot exist in that older snapshot. No system can infer those later deletions from the old backup alone; apply your operator's retained deletion policy before making restored data available.

## Filesystem safety and cancellation

Backup and restore outputs must not already exist, including dangling symlinks, directories or any adjacent `-wal`, `-shm` or `-journal` path. Journal-looking output filenames are rejected. Parent aliases are resolved before source/output comparisons. Source and its existing sidecars must be regular files, not symlinks; source sidecars with multiple hard links are rejected before SQLite opens them. Hard-linked aliases to existing targets are also rejected because the target already exists.

A private staging file is fully written, synchronized and verified before a hard-link operation atomically publishes it at the requested new path. Unlike a rename-overwrite, this operation refuses an existing file. The destination parent directory is synchronized before a successful receipt returns, to persist the new entry on supported POSIX filesystems. A filesystem/platform that cannot synchronize directories causes failure; the already-published file is preserved for operator verification, not deleted. No partial destination file is exposed. If another actor wins that destination name, its file is preserved. This requires a cooperative operator-owned directory: it is not a sandbox against a hostile process running under the same OS account or an administrator concurrently changing parent directories or staging files.

Each operation has a default snapshot bound of 256 MiB, configurable from 4 KiB through 4 GiB, and a default 60-second deadline, configurable from 1 millisecond through one hour. Staging and bundling require additional disk space, approximately twice the snapshot size during backup. Child SQLite work runs under `process.execPath` with no inherited environment, extensions disabled, and no network calls. Cancellation or timeout terminates the dedicated child and waits for its exit before cleanup. Hashing/copying yields between bounded chunks and checks the same deadline. OS filesystem calls and scheduling can introduce deadline overshoot; the checks prevent publication after an observed cancellation/deadline.

Cleanup only unlinks files whose device/inode identity still matches files this operation created. It does not recursively remove unexpected files or a replacement directory. A crash, killed SQLite journal, or unexpected entry can therefore leave a private `.mnemosyne-recovery-*` directory requiring operator inspection. The module never deletes an unknown entry merely to claim successful cleanup. Published backup or restored files are not deleted by a later cleanup failure.

`MemoryOperationError.code` gives a fixed failure category such as `target-exists`, `unsafe-path`, `invalid-backup`, `invalid-database`, `size-limit`, `cancelled`, or `timeout`. No raw child stderr, SQLite exception, source content or user-supplied path is included in that error.

## Compatibility and evidence

Node's backup API is available from Node 22.16.0. The implementation was checked against the [Node 22.16 SQLite API](https://raw.githubusercontent.com/nodejs/node/v22.16.0/doc/api/sqlite.md) and its [backup implementation](https://raw.githubusercontent.com/nodejs/node/v22.16.0/src/node_sqlite.cc). Mnemosyne schema version 1 is accepted; an unfamiliar schema fails closed rather than being migrated by the operator tool.

Tests use fresh synthetic databases: live WAL, multiple workspaces, pending observation jobs, forgotten-source replay, concurrent transactional writes, corruption, symlink/sidecar/alias paths, output races, cancellation and foreign cleanup entries. The [offline backup/restore example](../examples/backup-restore.ts) creates and removes only its own temporary database. Real production recovery and your storage platform's disaster-recovery process still require an operator rehearsal.
