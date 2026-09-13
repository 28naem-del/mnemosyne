import { afterEach, expect, it, vi } from 'vitest';
const fault = vi.hoisted(() => ({ directorySync: false, attempts: 0 }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fsyncSync(fd: number) {
    if (actual.fstatSync(fd).isDirectory()) {
      fault.attempts++;
      if (fault.directorySync) throw new Error('Synthetic directory persistence failure');
    }
    actual.fsyncSync(fd);
  } };
});
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory } from '../src/local/index.js';
import { backupLocalDatabase, verifyLocalBackup } from '../src/operations/index.js';
const directories: string[] = [];
afterEach(() => { fault.directorySync = false; fault.attempts = 0; directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
it('returns no success receipt after parent fsync failure but preserves the complete published backup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mnemosyne-operation-durability-')); directories.push(directory);
  const sourcePath = join(directory, 'source.sqlite'), backupPath = join(directory, 'backup.mnemo-backup');
  const source = createLocalMemory({ path: sourcePath, workspaceId: 'fixture', agentId: 'operator' });
  source.store({ text: 'Durable source fixture.', source: { uri: 'fixture:durability' }, trust: 'observed' }); source.close();
  fault.directorySync = true;
  await expect(backupLocalDatabase({ sourcePath, backupPath })).rejects.toMatchObject({ code: 'operation-failed' });
  expect(fault.attempts).toBe(1); expect(existsSync(backupPath)).toBe(true);
  expect((await verifyLocalBackup({ backupPath })).manifest.database.integrity).toBe('ok');
  await expect(backupLocalDatabase({ sourcePath, backupPath })).rejects.toMatchObject({ code: 'target-exists' });
});
