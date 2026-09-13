import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmdirSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { z } from 'zod';
import type { BackupManifest, BackupReceipt, OperationLimits, RestoreReceipt } from './types.js';
export type { BackupManifest, BackupReceipt, OperationLimits, RestoreReceipt } from './types.js';

const MAGIC = Buffer.from('MNEMOSYNE-BACKUP1\n');
const HEADER_BYTES = MAGIC.length + 4;
const SUFFIXES = ['', '-wal', '-shm', '-journal'];
const integer = z.number().int().nonnegative();
const databaseSchema = z.object({ bytes: integer.min(4096).max(4_294_967_296), sha256: z.string().regex(/^[a-f0-9]{64}$/), userVersion: z.literal(1), pageCount: integer.min(1), pageSize: integer.min(512).max(65536), integrity: z.literal('ok'), foreignKeys: z.literal('ok') }).strict();
const manifestSchema = z.object({ format: z.literal('mnemosyne-sqlite-backup'), version: z.literal(1), scope: z.literal('whole-database'), createdAt: z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value), database: databaseSchema }).strict();
type Identity = { dev: number; ino: number };
type OwnedFile = Identity & { path: string };
type Stage = { path: string; identity: Identity; files: OwnedFile[] };
type Control = { maxBytes: number; deadline: number; signal?: AbortSignal; check(): void };
export class MemoryOperationError extends Error {
  constructor(readonly code: 'invalid-input' | 'unsafe-path' | 'target-exists' | 'changed-path' | 'invalid-backup' | 'invalid-database' | 'size-limit' | 'cancelled' | 'timeout' | 'operation-failed') {
    super(`Memory database operation ${code}.`); this.name = 'MemoryOperationError';
  }
}
const fail = (code: MemoryOperationError['code']): never => { throw new MemoryOperationError(code); };
const safe = (error: unknown): never => { if (error instanceof MemoryOperationError) throw error; return fail('operation-failed'); };
function control(options: OperationLimits): Control {
  const parsed = z.object({ maxBytes: z.number().int().min(4096).max(4_294_967_296), timeoutMs: z.number().int().min(1).max(3_600_000) }).safeParse({ maxBytes: options.maxBytes ?? 268_435_456, timeoutMs: options.timeoutMs ?? 60000 });
  if (!parsed.success) return fail('invalid-input');
  const { maxBytes, timeoutMs } = parsed.data;
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) fail('invalid-input');
  const result: Control = { maxBytes, deadline: performance.now() + timeoutMs, signal: options.signal,
    check() { if (this.signal?.aborted) fail('cancelled'); if (performance.now() >= this.deadline) fail('timeout'); } };
  result.check(); return result;
}
function keys(value: unknown, allowed: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => ![...allowed, 'maxBytes', 'timeoutMs', 'signal'].includes(key))) fail('invalid-input');
}
function filename(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > 4096 || value === ':memory:' || value.startsWith('file:')) fail('invalid-input');
  const path = resolve(value), parent = realpathSync(dirname(path));
  return join(parent, basename(path));
}
function stat(path: string): Stats | undefined { try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }
function regular(path: string): Stats { const file = stat(path); if (!file || !file.isFile() || file.isSymbolicLink()) return fail('unsafe-path'); return file; }
function same(path: string, identity: Identity): boolean { const file = stat(path); return !!file && !file.isSymbolicLink() && file.dev === identity.dev && file.ino === identity.ino; }
function privateParent(path: string): Identity {
  const directory = lstatSync(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (process.getuid && directory.uid !== process.getuid()) || (directory.mode & 0o022) !== 0) fail('unsafe-path');
  return directory;
}
function vacant(path: string): void { for (const suffix of SUFFIXES) if (stat(path + suffix)) fail('target-exists'); }
function destination(path: string, sources: string[]): Identity {
  if (/-wal$|-shm$|-journal$/.test(path) || sources.some(source => SUFFIXES.some(suffix => path === source + suffix))) fail('unsafe-path');
  const parent = privateParent(path); vacant(path); return parent;
}
function stage(path: string): Stage {
  const directory = mkdtempSync(join(dirname(path), '.mnemosyne-recovery-'));
  return { path: directory, identity: lstatSync(directory), files: [] };
}
function createFile(owner: Stage, name: string): OwnedFile {
  if (!same(owner.path, owner.identity)) fail('changed-path');
  const path = join(owner.path, name), fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { const file = { path, ...identity(fstatSync(fd)) }; owner.files.push(file); return file; } finally { closeSync(fd); }
}
function identity(file: Stats): Identity { return { dev: file.dev, ino: file.ino }; }
function cleanup(owner: Stage | undefined): void {
  if (!owner || !same(owner.path, owner.identity)) return;
  for (const file of owner.files) {
    try { if (same(file.path, file)) unlinkSync(file.path); } catch { /* Never delete a replacement or an unrecognized entry. */ }
  }
  try { if (same(owner.path, owner.identity)) rmdirSync(owner.path); } catch { /* Unknown files are preserved; private leftovers may require operator cleanup. */ }
}
function readonly(path: string): number { const before = regular(path); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); if (!same(path, before) || fstatSync(fd).ino !== before.ino || fstatSync(fd).dev !== before.dev) { closeSync(fd); fail('changed-path'); } return fd; }
async function digestFile(path: string, limits: Control): Promise<{ sha256: string; bytes: number }> {
  const fd = readonly(path); const hash = createHash('sha256'); const chunk = Buffer.alloc(262144); let bytes = 0;
  try {
    const initial = fstatSync(fd);
    for (;;) { limits.check(); const size = readSync(fd, chunk, 0, chunk.length, bytes); if (!size) break; bytes += size; if (bytes > limits.maxBytes + 8192) fail('size-limit'); hash.update(chunk.subarray(0, size)); await yieldLoop(); }
    const current = fstatSync(fd); if (initial.size !== current.size || initial.mtimeMs !== current.mtimeMs || !same(path, initial)) fail('changed-path');
    return { sha256: hash.digest('hex'), bytes };
  } finally { closeSync(fd); }
}
function worker(request: Record<string, unknown>, limits: Control): Promise<{ userVersion: 1; pageCount: number; pageSize: number; integrity: 'ok'; foreignKeys: 'ok' }> {
  limits.check();
  let modulePath = fileURLToPath(new URL('./worker.js', import.meta.url));
  const args: string[] = [];
  if (!existsSync(modulePath)) { modulePath = fileURLToPath(new URL('./worker.ts', import.meta.url)); args.push('--experimental-strip-types'); }
  args.push(modulePath);
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'ignore'], env: {}, windowsHide: true });
    let output = '', failure: MemoryOperationError | undefined;
    const abort = () => { failure ??= new MemoryOperationError(limits.signal?.aborted ? 'cancelled' : 'timeout'); child.kill('SIGKILL'); };
    const timer = setTimeout(abort, Math.max(1, limits.deadline - performance.now()));
    limits.signal?.addEventListener('abort', abort, { once: true }); if (limits.signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => { if (output.length + chunk.length > 8192) { failure = new MemoryOperationError('operation-failed'); child.kill('SIGKILL'); } else output += chunk.toString('utf8'); });
    child.on('error', () => { failure = new MemoryOperationError('operation-failed'); });
    child.stdin.on('error', () => { /* close/error below is the single completion boundary. */ });
    child.on('close', code => {
      clearTimeout(timer); limits.signal?.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      try {
        limits.check(); const value = JSON.parse(output) as { ok?: unknown; result?: unknown };
        if (code !== 0 || value.ok !== true) fail('invalid-database');
        resolveResult(z.object({ userVersion: z.literal(1), pageCount: integer.min(1), pageSize: integer.min(512).max(65536), integrity: z.literal('ok'), foreignKeys: z.literal('ok') }).strict().parse(value.result));
      } catch (error) { reject(error instanceof MemoryOperationError ? error : new MemoryOperationError('operation-failed')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
async function writeBundle(database: OwnedFile, bundle: OwnedFile, manifest: BackupManifest, limits: Control): Promise<void> {
  const source = readonly(database.path), target = openSync(bundle.path, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    if (!same(bundle.path, bundle) || fstatSync(target).ino !== bundle.ino || fstatSync(target).dev !== bundle.dev) fail('changed-path');
    const data = Buffer.from(JSON.stringify(manifest)); if (data.length > 4096) fail('invalid-backup');
    const header = Buffer.alloc(HEADER_BYTES); MAGIC.copy(header); header.writeUInt32BE(data.length, MAGIC.length);
    writeAll(target, header); writeAll(target, data);
    const chunk = Buffer.alloc(262144), copiedHash = createHash('sha256'); let read = 0;
    for (;;) { limits.check(); const size = readSync(source, chunk, 0, chunk.length, read); if (!size) break; read += size; if (read > limits.maxBytes) fail('size-limit'); copiedHash.update(chunk.subarray(0, size)); writeAll(target, chunk.subarray(0, size)); await yieldLoop(); }
    if (copiedHash.digest('hex') !== manifest.database.sha256 || read !== manifest.database.bytes) fail('changed-path'); fsyncSync(target);
  } finally { closeSync(source); closeSync(target); }
}
function writeAll(fd: number, buffer: Buffer): void { let offset = 0; while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset); }
function publish(source: OwnedFile, target: string, parent: Identity, limits: Control): void {
  limits.check(); if (!same(dirname(target), parent) || !same(source.path, source)) fail('changed-path'); vacant(target);
  try { linkSync(source.path, target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('target-exists'); throw error; }
  // link is atomic and refuses any existing target. Never rename over a live database.
  // Persist the new directory entry before returning a successful receipt.
  const directory = openSync(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const current = fstatSync(directory);
    if (current.dev !== parent.dev || current.ino !== parent.ino || !same(dirname(target), parent)) fail('changed-path');
    fsyncSync(directory);
  } finally { closeSync(directory); }
}
async function extract(backupPath: string, owner: Stage, limits: Control): Promise<{ database: OwnedFile; manifest: BackupManifest; sha256: string; bytes: number }> {
  const source = readonly(backupPath); const initial = fstatSync(source); let target: number | undefined;
  try {
    if (initial.size > limits.maxBytes + 8192) fail('size-limit');
    const header = Buffer.alloc(HEADER_BYTES); if (readSync(source, header, 0, header.length, 0) !== header.length || !header.subarray(0, MAGIC.length).equals(MAGIC)) fail('invalid-backup');
    const length = header.readUInt32BE(MAGIC.length); if (!length || length > 4096) fail('invalid-backup');
    const raw = Buffer.alloc(length); if (readSync(source, raw, 0, length, header.length) !== length) fail('invalid-backup');
    let manifest: BackupManifest; try { manifest = manifestSchema.parse(JSON.parse(raw.toString('utf8'))); } catch { return fail('invalid-backup'); }
    if (manifest.database.bytes > limits.maxBytes || manifest.database.pageCount * manifest.database.pageSize !== manifest.database.bytes || initial.size !== HEADER_BYTES + length + manifest.database.bytes) fail('invalid-backup');
    const database = createFile(owner, 'snapshot.sqlite'); target = openSync(database.path, constants.O_WRONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256'), full = createHash('sha256').update(header).update(raw), chunk = Buffer.alloc(262144); let position = HEADER_BYTES + length, copied = 0;
    while (copied < manifest.database.bytes) {
      limits.check(); const size = readSync(source, chunk, 0, Math.min(chunk.length, manifest.database.bytes - copied), position); if (!size) fail('invalid-backup');
      hash.update(chunk.subarray(0, size)); full.update(chunk.subarray(0, size)); writeAll(target, chunk.subarray(0, size)); position += size; copied += size; await yieldLoop();
    }
    const current = fstatSync(source); if (!same(backupPath, initial) || initial.size !== current.size || initial.mtimeMs !== current.mtimeMs) fail('changed-path');
    if (hash.digest('hex') !== manifest.database.sha256) fail('invalid-backup'); fsyncSync(target); closeSync(target); target = undefined;
    const checked = await worker({ mode: 'verify', sourcePath: database.path, sourceIdentity: database, maxBytes: limits.maxBytes }, limits);
    if (checked.pageSize !== manifest.database.pageSize || checked.pageCount !== manifest.database.pageCount) fail('invalid-backup');
    return { database, manifest, sha256: full.digest('hex'), bytes: initial.size };
  } finally { closeSync(source); if (target !== undefined) closeSync(target); }
}

/** Privileged operator export: includes every workspace, agent, history and tombstone in the SQLite database. */
export async function backupLocalDatabase(input: OperationLimits & { sourcePath: string; backupPath: string }): Promise<BackupReceipt> {
  let owner: Stage | undefined;
  try {
    keys(input, ['sourcePath', 'backupPath']);
    const limits = control(input), sourcePath = filename(input.sourcePath), backupPath = filename(input.backupPath);
    const source = regular(sourcePath); if (source.size > limits.maxBytes) fail('size-limit');
    for (const suffix of SUFFIXES.slice(1)) { const sidecar = stat(sourcePath + suffix); if (sidecar && (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1 || (sidecar.dev === source.dev && sidecar.ino === source.ino))) fail('unsafe-path'); }
    const parent = destination(backupPath, [sourcePath]); owner = stage(backupPath);
    const database = createFile(owner, 'snapshot.sqlite');
    const checked = await worker({ mode: 'backup', sourcePath, sourceIdentity: identity(source), targetPath: database.path, targetIdentity: database, maxBytes: limits.maxBytes }, limits);
    const digest = await digestFile(database.path, limits); if (digest.bytes > limits.maxBytes || digest.bytes !== checked.pageCount * checked.pageSize) fail('size-limit');
    const manifest: BackupManifest = { format: 'mnemosyne-sqlite-backup', version: 1, scope: 'whole-database', createdAt: new Date().toISOString(), database: { ...digest, ...checked } };
    const bundle = createFile(owner, 'bundle.mnemo-backup'); await writeBundle(database, bundle, manifest, limits);
    const bundleDigest = await digestFile(bundle.path, limits); publish(bundle, backupPath, parent, limits);
    return { backupPath, manifest, ...bundleDigest };
  } catch (error) { return safe(error); } finally { cleanup(owner); }
}
export async function verifyLocalBackup(input: OperationLimits & { backupPath: string }): Promise<BackupReceipt> {
  let owner: Stage | undefined;
  try {
    keys(input, ['backupPath']);
    const limits = control(input), backupPath = filename(input.backupPath); regular(backupPath); privateParent(backupPath);
    owner = stage(backupPath); const verified = await extract(backupPath, owner, limits);
    return { backupPath, manifest: verified.manifest, sha256: verified.sha256, bytes: verified.bytes };
  } catch (error) { return safe(error); } finally { cleanup(owner); }
}
export async function restoreLocalBackup(input: OperationLimits & { backupPath: string; targetPath: string }): Promise<RestoreReceipt> {
  let owner: Stage | undefined;
  try {
    keys(input, ['backupPath', 'targetPath']);
    const limits = control(input), backupPath = filename(input.backupPath), targetPath = filename(input.targetPath); regular(backupPath);
    const parent = destination(targetPath, [backupPath]); owner = stage(targetPath); const verified = await extract(backupPath, owner, limits);
    const final = await digestFile(verified.database.path, limits);
    if (final.sha256 !== verified.manifest.database.sha256 || final.bytes !== verified.manifest.database.bytes) fail('changed-path');
    publish(verified.database, targetPath, parent, limits);
    return { targetPath, manifest: verified.manifest, sha256: verified.manifest.database.sha256, bytes: verified.manifest.database.bytes };
  } catch (error) { return safe(error); } finally { cleanup(owner); }
}
