import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { MemoryRuntime } from '../src/runtime/index.js';
import { backupLocalDatabase, restoreLocalBackup, verifyLocalBackup, MemoryOperationError } from '../src/operations/index.js';

const roots: string[] = [], databases: LocalMemory[] = [];
function root() { const directory = mkdtempSync(join(tmpdir(), 'mnemosyne-operations-')); roots.push(directory); return directory; }
function memory(path: string, workspaceId = 'workspace-A', agentId = 'alice') { const value = createLocalMemory({ path, workspaceId, agentId }); databases.push(value); return value; }
function fixture(directory = root()) {
  const sourcePath = join(directory, 'source.sqlite'), backupPath = join(directory, 'archive.mnemo-backup'), targetPath = join(directory, 'restored.sqlite');
  const first = memory(sourcePath), runtime = new MemoryRuntime(first);
  const forgottenInput = { sessionId: 'session-secret', trust: 'observed' as const, messages: [{ id: 'forgotten-event', role: 'user' as const, text: 'PRIVATE_ERASED_TOKEN' }] };
  const gone = runtime.capture(forgottenInput).records[0]; runtime.enqueue({ kind: 'observe', sourceIds: [gone.id] }); runtime.forgetSource(gone.id);
  const captured = runtime.capture({ sessionId: 'visible-session', trust: 'observed', messages: [{ id: 'kept', role: 'user', text: '  Café 😀 exact bytes\n\tPRIVATE_A  ' }] }).records[0];
  runtime.enqueue({ kind: 'observe', sourceIds: [captured.id] });
  const second = memory(sourcePath, 'workspace-B', 'bob');
  const sourceB = second.store({ text: 'PRIVATE_B lives in a different workspace.', trust: 'observed', source: { uri: 'fixture:second-workspace' }, idempotencyKey: 'B-once' });
  return { directory, sourcePath, backupPath, targetPath, first, second, runtime, forgottenInput, captured, sourceB };
}
afterEach(() => { databases.splice(0).forEach(db => db.close()); roots.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const magic = Buffer.from('MNEMOSYNE-BACKUP1\n'), headerLength = magic.length + 4;
function alterManifest(bundle: Buffer, update: (manifest: Record<string, unknown>) => void) {
  const length = bundle.readUInt32BE(magic.length), parsed = JSON.parse(bundle.subarray(headerLength, headerLength + length).toString('utf8')) as Record<string, unknown>;
  update(parsed); const text = Buffer.from(JSON.stringify(parsed)); const header = Buffer.alloc(headerLength); magic.copy(header); header.writeUInt32BE(text.length, magic.length);
  return Buffer.concat([header, text, bundle.subarray(headerLength + length)]);
}

describe('whole database online backup and clean restore', () => {
  it('includes live WAL, two workspaces, pending jobs and forgetting tombstones without content in the manifest', async () => {
    const f = fixture(); expect(lstatSync(`${f.sourcePath}-wal`).size).toBeGreaterThan(0);
    const beforeA = f.first.export(), beforeB = f.second.export();
    const receipt = await backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.backupPath });
    expect(receipt.sha256).toBe(hash(readFileSync(f.backupPath))); expect(receipt.manifest.scope).toBe('whole-database');
    expect(JSON.stringify(receipt.manifest)).not.toMatch(/PRIVATE_|workspace-A|workspace-B|source.sqlite/);
    expect(lstatSync(f.backupPath).mode & 0o777).toBe(0o600);
    expect(await verifyLocalBackup({ backupPath: f.backupPath })).toEqual(receipt);
    const restored = await restoreLocalBackup({ backupPath: f.backupPath, targetPath: f.targetPath });
    expect(restored.sha256).toBe(hash(readFileSync(f.targetPath))); expect(lstatSync(f.targetPath).mode & 0o777).toBe(0o600);
    for (const suffix of ['-wal', '-shm', '-journal']) expect(existsSync(f.targetPath + suffix)).toBe(false);
    const restoredA = memory(f.targetPath), restoredB = memory(f.targetPath, 'workspace-B', 'bob'), runtime = new MemoryRuntime(restoredA);
    expect(restoredA.export().memories).toEqual(beforeA.memories); expect(restoredB.export().memories).toEqual(beforeB.memories);
    expect(restoredA.export().idempotency).toEqual(beforeA.idempotency); expect(restoredB.export().idempotency).toEqual(beforeB.idempotency);
    expect(runtime.jobs()).toHaveLength(1); expect(runtime.jobs()[0].state).toBe('queued');
    expect(() => runtime.capture(f.forgottenInput)).toThrow('forgotten');
    expect(restoredA.get(f.captured.id)?.text).toBe('  Café 😀 exact bytes\n\tPRIVATE_A  '); expect(restoredB.get(f.sourceB.id)?.text).toContain('PRIVATE_B');
    expect(readFileSync(f.targetPath).includes(Buffer.from('PRIVATE_ERASED_TOKEN'))).toBe(false);
    expect(readdirSync(f.directory).some(name => name.startsWith('.mnemosyne-recovery-'))).toBe(false);
  });

  it('does not change the source database contents while backing it up', async () => {
    const f = fixture(); f.first.close(); f.second.close(); const before = readFileSync(f.sourcePath);
    await backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.backupPath }); expect(readFileSync(f.sourcePath)).toEqual(before);
  });

  it('lets separate connections keep writing while the snapshot remains transactionally consistent', async () => {
    const f = fixture(); const writer = new DatabaseSync(f.sourcePath);
    try {
      writer.exec('CREATE TABLE fixture_pair (k INTEGER PRIMARY KEY, value INTEGER NOT NULL); INSERT INTO fixture_pair VALUES (1,0),(2,0); CREATE TABLE fixture_bulk (data BLOB); INSERT INTO fixture_bulk VALUES (zeroblob(8388608));');
      let generation = 0;
      const timer = setInterval(() => { generation++; writer.exec(`BEGIN; UPDATE fixture_pair SET value=${generation}; COMMIT;`); }, 2);
      try { await backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.backupPath }); }
      finally { clearInterval(timer); }
      await restoreLocalBackup({ backupPath: f.backupPath, targetPath: f.targetPath });
      const restored = new DatabaseSync(f.targetPath, { readOnly: true });
      try { const values = restored.prepare('SELECT value FROM fixture_pair ORDER BY k').all(); expect(values[0].value).toBe(values[1].value); }
      finally { restored.close(); }
    } finally { writer.close(); }
  });
});

describe('exclusive paths, limits and corruption rejection', () => {
  it.each(['target', '-wal', '-shm', '-journal'])('never overwrites an existing %s output artifact', async suffix => {
    const f = fixture(), existing = f.backupPath + (suffix === 'target' ? '' : suffix); writeFileSync(existing, 'FOREIGN_EXISTING_FILE');
    await expect(backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.backupPath })).rejects.toMatchObject({ code: 'target-exists' }); expect(readFileSync(existing, 'utf8')).toBe('FOREIGN_EXISTING_FILE');
  });

  it('rejects source/output symlinks and aliases to the source journal even when it does not exist', async () => {
    const f = fixture(), alias = join(f.directory, 'link.sqlite'); symlinkSync(f.sourcePath, alias);
    await expect(backupLocalDatabase({ sourcePath: alias, backupPath: f.backupPath })).rejects.toMatchObject({ code: 'unsafe-path' });
    symlinkSync(f.sourcePath, f.backupPath); await expect(backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.backupPath })).rejects.toThrow();
    await expect(backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.sourcePath + '-journal' })).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(existsSync(f.sourcePath + '-journal')).toBe(false);
  });

  it('resolves parent directory aliases before refusing source and restore collisions', async () => {
    const f = fixture(), alias = join(f.directory, 'parent-alias'); symlinkSync(f.directory, alias);
    await expect(backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: join(alias, 'source.sqlite') })).rejects.toMatchObject({ code: 'unsafe-path' });
    await backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.backupPath });
    await expect(restoreLocalBackup({ backupPath: f.backupPath, targetPath: join(alias, 'archive.mnemo-backup') })).rejects.toMatchObject({ code: 'unsafe-path' });
    await expect(restoreLocalBackup({ backupPath: f.backupPath, targetPath: f.sourcePath })).rejects.toMatchObject({ code: 'target-exists' });
  });

  it('rejects writable-by-others destinations and source sidecar symlinks without changing them', async () => {
    const f = fixture(); f.first.close(); f.second.close(); symlinkSync(f.sourcePath, f.sourcePath + '-wal');
    await expect(backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.backupPath })).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(lstatSync(f.sourcePath + '-wal').isSymbolicLink()).toBe(true);
    const untrusted = join(f.directory, 'untrusted'); mkdirSync(untrusted, { mode: 0o777 });
    // Explicit chmod is unnecessary: umask may narrow this fixture, so create a group-writable mode through fs API.
    const { chmodSync } = await import('node:fs'); chmodSync(untrusted, 0o777);
    await expect(restoreLocalBackup({ backupPath: f.sourcePath, targetPath: join(untrusted, 'new.sqlite') })).rejects.toMatchObject({ code: 'unsafe-path' });
  });

  it.each(['magic', 'truncated', 'digest', 'scope', 'schema', 'extra', 'length'])('rejects %s corruption before publishing a restore', async failure => {
    const f = fixture(); await backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.backupPath }); let bundle = readFileSync(f.backupPath);
    if (failure === 'magic') bundle[0] ^= 1;
    if (failure === 'truncated') bundle = bundle.subarray(0, -1);
    if (failure === 'digest') bundle[bundle.length - 1] ^= 1;
    if (failure === 'scope') bundle = alterManifest(bundle, manifest => { manifest.scope = 'workspace'; });
    if (failure === 'schema') bundle = alterManifest(bundle, manifest => { (manifest.database as Record<string, unknown>).userVersion = 2; });
    if (failure === 'extra') bundle = alterManifest(bundle, manifest => { manifest.rawSource = 'PRIVATE_UNTRUSTED_MANIFEST'; });
    if (failure === 'length') bundle.writeUInt32BE(8192, magic.length);
    writeFileSync(f.backupPath, bundle);
    await expect(restoreLocalBackup({ backupPath: f.backupPath, targetPath: f.targetPath })).rejects.toMatchObject({ code: 'invalid-backup' }); expect(existsSync(f.targetPath)).toBe(false);
  });

  it('rejects malformed/non-Mnemosyne databases with fixed diagnostics', async () => {
    const directory = root(), sourcePath = join(directory, 'PRIVATE_PATH.sqlite'), backupPath = join(directory, 'new.backup'); writeFileSync(sourcePath, 'PRIVATE_MALFORMED_DATABASE');
    let error: unknown; try { await backupLocalDatabase({ sourcePath, backupPath }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(MemoryOperationError); expect(String(error)).not.toContain('PRIVATE_'); expect(existsSync(backupPath)).toBe(false);
    rmSync(sourcePath); const sqlite = new DatabaseSync(sourcePath); sqlite.exec('CREATE TABLE unrelated (x INTEGER);'); sqlite.close();
    await expect(backupLocalDatabase({ sourcePath, backupPath })).rejects.toMatchObject({ code: 'invalid-database' });
  });

  it('rejects sidecar hard links and unknown scope options before source access', async () => {
    const f = fixture(); f.first.close(); f.second.close(); linkSync(f.sourcePath, f.sourcePath + '-shm');
    const before = readFileSync(f.sourcePath);
    await expect(backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.backupPath })).rejects.toMatchObject({ code: 'unsafe-path' });
    expect(readFileSync(f.sourcePath)).toEqual(before);
    await expect(backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.backupPath, workspaceId: 'scope-is-not-supported' } as never)).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('allows only one concurrent publication for the same new path', async () => {
    const f = fixture();
    const results = await Promise.allSettled([backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.backupPath }), backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.backupPath })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await verifyLocalBackup({ backupPath: f.backupPath })).sha256).toBe(hash(readFileSync(f.backupPath)));
  });

  it('bounds size and cancellation and never publishes after a timeout', async () => {
    const f = fixture();
    await expect(backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.backupPath, maxBytes: 4096 })).rejects.toThrow();
    const controller = new AbortController(); controller.abort(); await expect(backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.backupPath, signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    await expect(backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.backupPath, timeoutMs: 1 })).rejects.toMatchObject({ code: 'timeout' });
    expect(existsSync(f.backupPath)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 30)); expect(existsSync(f.backupPath)).toBe(false);
  });

  it('preserves a target created by another actor during work and never cleans foreign staging replacements', async () => {
    const f = fixture(), control = new AbortController(); const operation = backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.backupPath, signal: control.signal });
    const stages = readdirSync(f.directory).filter(name => name.startsWith('.mnemosyne-recovery-')); expect(stages).toHaveLength(1);
    const active = join(f.directory, stages[0]), original = join(f.directory, 'original-stage'); renameSync(active, original); mkdirSync(active, { mode: 0o700 }); writeFileSync(join(active, 'foreign-file'), 'FOREIGN_STAGING_CONTENT');
    writeFileSync(f.backupPath, 'FOREIGN_TARGET_CONTENT'); control.abort(); await expect(operation).rejects.toMatchObject({ code: 'cancelled' });
    expect(readFileSync(f.backupPath, 'utf8')).toBe('FOREIGN_TARGET_CONTENT'); expect(readFileSync(join(active, 'foreign-file'), 'utf8')).toBe('FOREIGN_STAGING_CONTENT');
  });

  it('preserves unrelated entries placed inside its staging directory on failure', async () => {
    const f = fixture(), controller = new AbortController(); const operation = backupLocalDatabase({ sourcePath: f.sourcePath, backupPath: f.backupPath, signal: controller.signal });
    const name = readdirSync(f.directory).find(item => item.startsWith('.mnemosyne-recovery-'))!; const foreign = join(f.directory, name, 'foreign'); const fd = openSync(foreign, 'wx', 0o600); closeSync(fd);
    controller.abort(); await expect(operation).rejects.toMatchObject({ code: 'cancelled' }); expect(existsSync(foreign)).toBe(true);
  });
});
