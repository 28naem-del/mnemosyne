/** Synthetic whole-database recovery; never opens an existing user database. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory } from '../dist/local/index.js';
import { MemoryRuntime } from '../dist/runtime/index.js';
import { backupLocalDatabase, restoreLocalBackup, verifyLocalBackup } from '../dist/operations/index.js';

const directory = mkdtempSync(join(tmpdir(), 'mnemosyne-recovery-example-'));
const source = join(directory, 'source.sqlite');
const alice = createLocalMemory({ path: source, workspaceId: 'first-workspace', agentId: 'alice' });
const bob = createLocalMemory({ path: source, workspaceId: 'second-workspace', agentId: 'bob' });
let restored: ReturnType<typeof createLocalMemory> | undefined;
try {
  const runtime = new MemoryRuntime(alice);
  const input = { sessionId: 'example', trust: 'observed' as const, messages: [{ id: 'forgotten-message', role: 'user' as const, text: 'Synthetic text that must remain forgotten.' }] };
  runtime.forgetSource(runtime.capture(input).records[0].id);
  const kept = bob.store({ text: 'The second workspace survives recovery.', trust: 'observed', source: { uri: 'example:backup' } });
  const backup = await backupLocalDatabase({ sourcePath: source, backupPath: join(directory, 'archive.mnemo-backup') });
  const verified = await verifyLocalBackup({ backupPath: backup.backupPath });
  const result = await restoreLocalBackup({ backupPath: backup.backupPath, targetPath: join(directory, 'restored.sqlite') });
  restored = createLocalMemory({ path: result.targetPath, workspaceId: 'second-workspace', agentId: 'bob' });
  if (restored.get(kept.id)?.text !== kept.text || verified.sha256 !== backup.sha256) throw new Error('Recovery fixture failed.');
  console.log(JSON.stringify({ wholeDatabase: true, manifestVerified: true, secondWorkspaceRestored: true, networkCalls: 0 }));
} finally { restored?.close(); alice.close(); bob.close(); rmSync(directory, { recursive: true, force: true }); }
