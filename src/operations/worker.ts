/** Internal isolated SQLite worker. No user code, extensions, network or raw diagnostics. */
import { backup, DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';

interface Request {
  mode: 'backup' | 'verify'; sourcePath: string; targetPath?: string;
  sourceIdentity: { dev: number; ino: number }; targetIdentity?: { dev: number; ino: number };
  maxBytes: number;
}
function regular(path: string, identity: { dev: number; ino: number }): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) throw new Error();
}
function information(db: DatabaseSync, maxBytes: number) {
  const userVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  const pageCount = Number(db.prepare('PRAGMA page_count').get()?.page_count);
  const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size);
  if (userVersion !== 1 || !Number.isSafeInteger(pageCount) || !Number.isSafeInteger(pageSize) || pageCount <= 0 || pageSize < 512 || pageCount * pageSize > maxBytes) throw new Error();
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('memories','dependencies','outcomes','idempotency','audit')").all();
  if (tables.length !== 5) throw new Error();
  // Preparing verifies the core columns without exporting any row values.
  db.prepare('SELECT id, workspace_id, agent_id, data FROM memories LIMIT 0').all();
  return { userVersion, pageCount, pageSize };
}
async function main(request: Request) {
  regular(request.sourcePath, request.sourceIdentity);
  let source: DatabaseSync | undefined, target: DatabaseSync | undefined;
  try {
    source = new DatabaseSync(request.sourcePath, { readOnly: true, allowExtension: false, timeout: 100 });
    source.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;');
    const sourceInfo = information(source, request.maxBytes);
    regular(request.sourcePath, request.sourceIdentity);
    if (request.mode === 'backup') {
      if (!request.targetPath || !request.targetIdentity) throw new Error();
      regular(request.targetPath, request.targetIdentity);
      await backup(source, request.targetPath, { rate: 32, progress: ({ totalPages }) => {
        if (totalPages * sourceInfo.pageSize > request.maxBytes) throw new Error();
        regular(request.targetPath!, request.targetIdentity!);
      } });
      source.close(); source = undefined;
      regular(request.targetPath, request.targetIdentity);
      target = new DatabaseSync(request.targetPath, { allowExtension: false, timeout: 100 });
      // Normalize the owned snapshot to a standalone file: restoration needs no WAL sidecars.
      if (target.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode !== 'delete') throw new Error();
      target.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    }
    const checked = target ?? source!;
    const meta = information(checked, request.maxBytes);
    if (checked.prepare('PRAGMA integrity_check(1)').get()?.integrity_check !== 'ok') throw new Error();
    if (checked.prepare('PRAGMA foreign_key_check').get() !== undefined) throw new Error();
    return { ...meta, integrity: 'ok' as const, foreignKeys: 'ok' as const };
  } finally { if (target?.isOpen) target.close(); if (source?.isOpen) source.close(); }
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => { input += chunk; if (Buffer.byteLength(input) > 16384) process.exit(2); });
process.stdin.on('end', () => {
  void (async () => {
    try {
      const request = JSON.parse(input) as Request;
      if (!['backup', 'verify'].includes(request.mode) || typeof request.sourcePath !== 'string' || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 4096 || request.maxBytes > 4_294_967_296) throw new Error();
      const result = await main(request); process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch { process.stdout.write(JSON.stringify({ ok: false, code: 'invalid-database' })); process.exitCode = 1; }
  })();
});
