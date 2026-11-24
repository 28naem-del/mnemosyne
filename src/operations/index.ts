import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, scrypt } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmdirSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { z } from 'zod';
import type { BackupContent, BackupDatabase, BackupEncryption, BackupManifest, BackupReceipt, EncryptedBackupManifest, EncryptedBackupReceipt, EncryptedRestoreReceipt, OperationLimits, RestoreReceipt } from './types.js';
export type { BackupContent, BackupDatabase, BackupEncryption, BackupManifest, BackupReceipt, EncryptedBackupManifest, EncryptedBackupReceipt, EncryptedRestoreReceipt, OperationLimits, RestoreReceipt } from './types.js';

const MAGIC = Buffer.from('MNEMOSYNE-BACKUP1\n');
const HEADER_BYTES = MAGIC.length + 4;
// Format 2 (encrypted) shares the header shape: magic, u32 manifest length, manifest JSON, then ciphertext.
const MAGIC2 = Buffer.from('MNEMOSYNE-BACKUP2\n');
// Inside the ciphertext: payload magic, u32 inner-manifest length, inner manifest JSON, SQLite bytes, PEM key bytes.
const PAYLOAD_MAGIC = Buffer.from('MNEMOSYNE-PAYLOAD2\n');
const PAYLOAD_HEADER_BYTES = PAYLOAD_MAGIC.length + 4;
const MANIFEST_BYTES = 4096, MAX_KEY_BYTES = 4096, MAX_PASSPHRASE_BYTES = 4096;
/** scrypt N=2^15, r=8, p=1 (32 MiB, the cost Node and RFC 7914 examples use for interactive keys); 32-byte key. */
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const;
const SALT_BYTES = 16, NONCE_BYTES = 12, TAG_BYTES = 16;
/** The CLI's and docs' key location: `<database>.consolidation.key`, beside the database (docs/CONSOLIDATION-SIGNING.md). */
const KEY_SUFFIX = '.consolidation.key';
const DECRYPTION_FAILED = 'backup decryption failed: wrong passphrase or corrupted bundle';
const KEY_EXISTS = 'Memory database operation target-exists: the restore target\'s <database>.consolidation.key already exists; restore never overwrites a consolidation signing key. Move it aside or restore to a new path.';
const SUFFIXES = ['', '-wal', '-shm', '-journal'];
const integer = z.number().int().nonnegative();
// 1 (JSON embeddings) and 2 (packed float32, local/index.ts's SCHEMA_VERSION)
// are both databases this build reads, writes and backs up correctly.
const userVersionSchema = z.union([z.literal(1), z.literal(2)]);
const databaseSchema = z.object({ bytes: integer.min(4096).max(4_294_967_296), sha256: z.string().regex(/^[a-f0-9]{64}$/), userVersion: userVersionSchema, pageCount: integer.min(1), pageSize: integer.min(512).max(65536), integrity: z.literal('ok'), foreignKeys: z.literal('ok') }).strict();
const isoTime = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const manifestSchema = z.object({ format: z.literal('mnemosyne-sqlite-backup'), version: z.literal(1), scope: z.literal('whole-database'), createdAt: isoTime, database: databaseSchema }).strict();
const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const base64Bytes = (length: number) => z.string().refine(value => { const bytes = Buffer.from(value, 'base64'); return bytes.length === length && bytes.toString('base64') === value; });
const contentSchema = z.union([z.tuple([z.literal('database')]), z.tuple([z.literal('database'), z.literal('consolidation-key')])]);
// The cost is bounded so a hostile manifest cannot demand unbounded memory: N in 2^14..2^17, r=8, p=1.
const scryptParamsSchema = z.object({ N: z.number().int().min(16384).max(131072).refine(value => (value & (value - 1)) === 0), r: z.literal(8), p: z.literal(1) }).strict();
const encryptedManifestSchema = z.object({
  format: z.literal('mnemosyne-sqlite-backup'), version: z.literal(2), scope: z.literal('whole-database'), createdAt: isoTime, includes: contentSchema,
  encryption: z.object({ kdf: z.literal('scrypt'), params: scryptParamsSchema, salt: base64Bytes(SALT_BYTES), cipher: z.literal('aes-256-gcm'), nonce: base64Bytes(NONCE_BYTES), tag: base64Bytes(TAG_BYTES) }).strict(),
  payload: z.object({ bytes: integer.min(1) }).strict(),
}).strict();
const payloadManifestSchema = z.object({
  format: z.literal('mnemosyne-sqlite-backup-payload'), version: z.literal(2), createdAt: isoTime, includes: contentSchema, database: databaseSchema,
  consolidationKey: z.object({ bytes: integer.min(1).max(MAX_KEY_BYTES), sha256: hex64, keyId: hex64 }).strict().optional(),
}).strict();
type PayloadManifest = z.infer<typeof payloadManifestSchema>;
type SigningKey = { pem: Buffer; sha256: string; keyId: string };
type Identity = { dev: number; ino: number };
type OwnedFile = Identity & { path: string };
type Stage = { path: string; identity: Identity; files: OwnedFile[] };
type Control = { maxBytes: number; deadline: number; signal?: AbortSignal; check(): void };
export type MemoryOperationErrorCode = 'invalid-input' | 'unsafe-path' | 'target-exists' | 'changed-path' | 'invalid-backup' | 'invalid-database' | 'size-limit' | 'cancelled' | 'timeout' | 'operation-failed' | 'passphrase-required' | 'decryption-failed';
const MESSAGES: Partial<Record<MemoryOperationErrorCode, string>> = {
  'decryption-failed': DECRYPTION_FAILED,
  'passphrase-required': 'Memory database operation passphrase-required: this bundle is encrypted; supply its passphrase.',
};
export class MemoryOperationError extends Error {
  /** Messages are fixed per code (one fixed variant for an existing signing key); never paths, SQL errors or secrets. */
  constructor(readonly code: MemoryOperationErrorCode, message?: string) {
    super(message ?? MESSAGES[code] ?? `Memory database operation ${code}.`); this.name = 'MemoryOperationError';
  }
}
const fail = (code: MemoryOperationErrorCode, message?: string): never => { throw new MemoryOperationError(code, message); };
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
function vacant(path: string, message?: string): void { for (const suffix of SUFFIXES) if (stat(path + suffix)) fail('target-exists', message); }
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
function worker(request: Record<string, unknown>, limits: Control): Promise<{ userVersion: 1 | 2; pageCount: number; pageSize: number; integrity: 'ok'; foreignKeys: 'ok' }> {
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
        resolveResult(z.object({ userVersion: userVersionSchema, pageCount: integer.min(1), pageSize: integer.min(512).max(65536), integrity: z.literal('ok'), foreignKeys: z.literal('ok') }).strict().parse(value.result));
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
function publish(source: OwnedFile, target: string, parent: Identity, limits: Control, existsMessage?: string): void {
  limits.check(); if (!same(dirname(target), parent) || !same(source.path, source)) fail('changed-path'); vacant(target, existsMessage);
  try { linkSync(source.path, target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('target-exists', existsMessage); throw error; }
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

function encryptionSecret(value: unknown): Buffer {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'passphrase')) return fail('invalid-input');
  const raw = (value as { passphrase?: unknown }).passphrase;
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw instanceof Uint8Array ? Buffer.from(raw) : fail('invalid-input');
  if (!bytes.length || bytes.length > MAX_PASSPHRASE_BYTES) fail('invalid-input');
  return bytes;
}
async function deriveKey(secret: Buffer, salt: Buffer, params: { N: number; r: number; p: number }, limits: Control): Promise<Buffer> {
  limits.check();
  const key = await new Promise<Buffer>((resolveKey, reject) => scrypt(secret, salt, 32, { ...params, maxmem: 256 * params.N * params.r }, (error, derived) => { if (error) reject(new MemoryOperationError('operation-failed')); else resolveKey(derived); }));
  limits.check(); return key;
}
/** Parses a PKCS#8 PEM Ed25519 private key and returns its public key id (signing.ts: SHA-256 of the raw public key). */
function signingKeyId(pem: Buffer): string | undefined {
  try {
    const key = createPrivateKey({ key: pem, format: 'pem' });
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') return undefined;
    const x = (createPublicKey(key).export({ format: 'jwk' }) as { x?: string }).x;
    return typeof x === 'string' ? createHash('sha256').update(Buffer.from(x, 'base64url')).digest('hex') : undefined;
  } catch { return undefined; }
}
function readSigningKey(path: string): SigningKey {
  if (!stat(path)) fail('invalid-input');
  const before = regular(path); if (before.size < 1 || before.size > MAX_KEY_BYTES) fail('invalid-input');
  const fd = readonly(path), buffer = Buffer.alloc(MAX_KEY_BYTES + 1); let size = 0;
  try { for (;;) { const read = readSync(fd, buffer, size, buffer.length - size, size); if (!read) break; size += read; if (size > MAX_KEY_BYTES) fail('invalid-input'); } } finally { closeSync(fd); }
  const pem = Buffer.from(buffer.subarray(0, size)); buffer.fill(0);
  const keyId = signingKeyId(pem); if (!keyId) { pem.fill(0); return fail('invalid-input'); }
  return { pem, keyId, sha256: createHash('sha256').update(pem).digest('hex') };
}
function writeOwned(file: OwnedFile, data: Buffer): void {
  const fd = openSync(file.path, constants.O_WRONLY | constants.O_NOFOLLOW);
  try { if (fstatSync(fd).ino !== file.ino || fstatSync(fd).dev !== file.dev) fail('changed-path'); writeAll(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}
function payloadHeader(inner: PayloadManifest): Buffer {
  const data = Buffer.from(JSON.stringify(inner)); if (data.length > MANIFEST_BYTES) fail('invalid-backup');
  const header = Buffer.alloc(PAYLOAD_HEADER_BYTES); PAYLOAD_MAGIC.copy(header); header.writeUInt32BE(data.length, PAYLOAD_MAGIC.length);
  return Buffer.concat([header, data]);
}
function bundleHeader(manifest: EncryptedBackupManifest): Buffer {
  const data = Buffer.from(JSON.stringify(manifest)); if (data.length > MANIFEST_BYTES) fail('invalid-backup');
  const header = Buffer.alloc(HEADER_BYTES); MAGIC2.copy(header); header.writeUInt32BE(data.length, MAGIC2.length);
  return Buffer.concat([header, data]);
}
/**
 * Streams the inner payload (header, owned SQLite snapshot, PEM) through AES-256-GCM into the bundle.
 * The tag is known only at the end, so the header is first written with a same-length placeholder tag
 * and then rewritten in place before the bundle is synced.
 */
async function writeEncryptedBundle(database: OwnedFile, bundle: OwnedFile, inner: PayloadManifest, key: SigningKey | undefined, secret: Buffer, limits: Control): Promise<EncryptedBackupManifest> {
  const salt = randomBytes(SALT_BYTES), nonce = randomBytes(NONCE_BYTES), derived = await deriveKey(secret, salt, SCRYPT_PARAMS, limits);
  const prefix = payloadHeader(inner);
  const manifest: EncryptedBackupManifest = {
    format: 'mnemosyne-sqlite-backup', version: 2, scope: 'whole-database', createdAt: inner.createdAt, includes: [...inner.includes],
    encryption: { kdf: 'scrypt', params: { ...SCRYPT_PARAMS }, salt: salt.toString('base64'), cipher: 'aes-256-gcm', nonce: nonce.toString('base64'), tag: Buffer.alloc(TAG_BYTES).toString('base64') },
    payload: { bytes: prefix.length + inner.database.bytes + (key?.pem.length ?? 0) },
  };
  const placeholder = bundleHeader(manifest);
  const source = readonly(database.path), target = openSync(bundle.path, constants.O_WRONLY | constants.O_NOFOLLOW);
  const cipher = createCipheriv('aes-256-gcm', derived, nonce, { authTagLength: TAG_BYTES });
  try {
    if (!same(bundle.path, bundle) || fstatSync(target).ino !== bundle.ino || fstatSync(target).dev !== bundle.dev) fail('changed-path');
    writeAll(target, placeholder); writeAll(target, cipher.update(prefix));
    const chunk = Buffer.alloc(262144), copiedHash = createHash('sha256'); let read = 0;
    for (;;) { limits.check(); const size = readSync(source, chunk, 0, chunk.length, read); if (!size) break; read += size; if (read > limits.maxBytes) fail('size-limit'); copiedHash.update(chunk.subarray(0, size)); writeAll(target, cipher.update(chunk.subarray(0, size))); await yieldLoop(); }
    chunk.fill(0);
    if (copiedHash.digest('hex') !== inner.database.sha256 || read !== inner.database.bytes) fail('changed-path');
    if (key) writeAll(target, cipher.update(key.pem));
    writeAll(target, cipher.final());
    manifest.encryption.tag = cipher.getAuthTag().toString('base64');
    const final = bundleHeader(manifest); if (final.length !== placeholder.length) fail('operation-failed');
    let offset = 0; while (offset < final.length) offset += writeSync(target, final, offset, final.length - offset, offset);
    fsyncSync(target);
    return manifest;
  } finally { derived.fill(0); closeSync(source); closeSync(target); }
}
/** Routes decrypted (not yet authenticated) plaintext: inner header to memory, SQLite bytes to the owned file, PEM to memory. */
function payloadSink(target: number, maxBytes: number) {
  let head = Buffer.alloc(0), inner: PayloadManifest | undefined, malformed = false, written = 0;
  const key: Buffer[] = []; let keyBytes = 0;
  const hash = createHash('sha256');
  return {
    write(plain: Buffer): void {
      if (malformed || !plain.length) return;
      let rest = plain;
      if (!inner) {
        head = Buffer.concat([head, rest]); rest = Buffer.alloc(0);
        if (head.length < PAYLOAD_HEADER_BYTES) return;
        const length = head.readUInt32BE(PAYLOAD_MAGIC.length);
        if (!head.subarray(0, PAYLOAD_MAGIC.length).equals(PAYLOAD_MAGIC) || !length || length > MANIFEST_BYTES) { malformed = true; return; }
        if (head.length < PAYLOAD_HEADER_BYTES + length) return;
        try { inner = payloadManifestSchema.parse(JSON.parse(head.subarray(PAYLOAD_HEADER_BYTES, PAYLOAD_HEADER_BYTES + length).toString('utf8'))); } catch { malformed = true; return; }
        if (inner.database.bytes > maxBytes) { malformed = true; return; }
        rest = head.subarray(PAYLOAD_HEADER_BYTES + length);
      }
      const database = Math.min(rest.length, inner.database.bytes - written);
      if (database > 0) { const part = rest.subarray(0, database); hash.update(part); writeAll(target, part); written += database; rest = rest.subarray(database); }
      if (rest.length) {
        keyBytes += rest.length;
        if (!inner.consolidationKey || keyBytes > inner.consolidationKey.bytes) { malformed = true; return; }
        key.push(Buffer.from(rest)); rest.fill(0);
      }
    },
    finish(): { inner: PayloadManifest; sha256: string; key?: Buffer } {
      if (malformed || !inner || written !== inner.database.bytes || keyBytes !== (inner.consolidationKey?.bytes ?? 0)) { key.forEach(part => part.fill(0)); return fail('invalid-backup'); }
      const pem = inner.consolidationKey ? Buffer.concat(key) : undefined; key.forEach(part => part.fill(0));
      return { inner, sha256: hash.digest('hex'), ...(pem ? { key: pem } : {}) };
    },
    discard(): void { key.forEach(part => part.fill(0)); },
  };
}
type Extracted = { database: OwnedFile; sha256: string; bytes: number } & (
  { version: 1; manifest: BackupManifest } |
  { version: 2; manifest: EncryptedBackupManifest; inner: PayloadManifest; key?: { pem: Buffer; keyId: string } });
function readHeader(source: number): { magic: Buffer; header: Buffer; raw: Buffer } {
  const header = Buffer.alloc(HEADER_BYTES); if (readSync(source, header, 0, header.length, 0) !== header.length) fail('invalid-backup');
  const magic = header.subarray(0, MAGIC.length); if (!magic.equals(MAGIC) && !magic.equals(MAGIC2)) fail('invalid-backup');
  const length = header.readUInt32BE(MAGIC.length); if (!length || length > MANIFEST_BYTES) fail('invalid-backup');
  const raw = Buffer.alloc(length); if (readSync(source, raw, 0, length, header.length) !== length) fail('invalid-backup');
  return { magic, header, raw };
}
/** Peeks at the format so restore can check key-path vacancy and the passphrase requirement before any work. */
function bundleFormat(backupPath: string): { version: 1 } | { version: 2; manifest: EncryptedBackupManifest } {
  const source = readonly(backupPath);
  try {
    // Anything that is not format 2 takes the unchanged format-1 path, with its existing checks and error order.
    const magic = Buffer.alloc(MAGIC2.length); if (readSync(source, magic, 0, magic.length, 0) !== magic.length || !magic.equals(MAGIC2)) return { version: 1 };
    const { raw } = readHeader(source);
    try { return { version: 2, manifest: encryptedManifestSchema.parse(JSON.parse(raw.toString('utf8'))) as EncryptedBackupManifest }; } catch { return fail('invalid-backup'); }
  } finally { closeSync(source); }
}
async function extractEncrypted(backupPath: string, owner: Stage, limits: Control, secret: Buffer | undefined): Promise<Extracted> {
  const source = readonly(backupPath); const initial = fstatSync(source); let target: number | undefined, sink: ReturnType<typeof payloadSink> | undefined;
  try {
    const overhead = PAYLOAD_HEADER_BYTES + MANIFEST_BYTES + MAX_KEY_BYTES;
    if (initial.size > limits.maxBytes + HEADER_BYTES + MANIFEST_BYTES + overhead) fail('size-limit');
    const { header, raw } = readHeader(source);
    let manifest: EncryptedBackupManifest; try { manifest = encryptedManifestSchema.parse(JSON.parse(raw.toString('utf8'))) as EncryptedBackupManifest; } catch { return fail('invalid-backup'); }
    if (manifest.payload.bytes > limits.maxBytes + overhead || initial.size !== HEADER_BYTES + raw.length + manifest.payload.bytes) fail('invalid-backup');
    if (!secret) return fail('passphrase-required');
    const { salt, nonce, tag, params } = manifest.encryption;
    const derived = await deriveKey(secret, Buffer.from(salt, 'base64'), params, limits);
    const decipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(nonce, 'base64'), { authTagLength: TAG_BYTES }); derived.fill(0);
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const database = createFile(owner, 'snapshot.sqlite'); target = openSync(database.path, constants.O_WRONLY | constants.O_NOFOLLOW);
    sink = payloadSink(target, limits.maxBytes);
    const full = createHash('sha256').update(header).update(raw), chunk = Buffer.alloc(262144); let position = HEADER_BYTES + raw.length, copied = 0;
    while (copied < manifest.payload.bytes) {
      limits.check(); const size = readSync(source, chunk, 0, Math.min(chunk.length, manifest.payload.bytes - copied), position); if (!size) fail('invalid-backup');
      const part = chunk.subarray(0, size); full.update(part); sink.write(decipher.update(part)); position += size; copied += size; await yieldLoop();
    }
    // GCM authenticates only at final(): nothing decrypted is trusted or published before this passes.
    try { sink.write(decipher.final()); } catch { return fail('decryption-failed'); }
    const current = fstatSync(source); if (!same(backupPath, initial) || initial.size !== current.size || initial.mtimeMs !== current.mtimeMs) fail('changed-path');
    const payload = sink.finish(); sink = undefined; const inner = payload.inner;
    const pem = payload.key;
    try {
      // The plaintext manifest is not GCM associated data; every field it shares with the authenticated inner manifest must agree.
      if (inner.createdAt !== manifest.createdAt || JSON.stringify(inner.includes) !== JSON.stringify(manifest.includes) || (manifest.includes.includes('consolidation-key') !== !!inner.consolidationKey)) fail('invalid-backup');
      if (inner.database.pageCount * inner.database.pageSize !== inner.database.bytes || payload.sha256 !== inner.database.sha256) fail('invalid-backup');
      let key: { pem: Buffer; keyId: string } | undefined;
      if (pem && inner.consolidationKey) {
        if (createHash('sha256').update(pem).digest('hex') !== inner.consolidationKey.sha256 || signingKeyId(pem) !== inner.consolidationKey.keyId) fail('invalid-backup');
        key = { pem, keyId: inner.consolidationKey.keyId };
      }
      fsyncSync(target); closeSync(target); target = undefined;
      const checked = await worker({ mode: 'verify', sourcePath: database.path, sourceIdentity: database, maxBytes: limits.maxBytes }, limits);
      if (checked.pageSize !== inner.database.pageSize || checked.pageCount !== inner.database.pageCount) fail('invalid-backup');
      return { version: 2, database, manifest, inner, ...(key ? { key } : {}), sha256: full.digest('hex'), bytes: initial.size };
    } catch (error) { pem?.fill(0); throw error; }
  } finally { sink?.discard(); closeSync(source); if (target !== undefined) closeSync(target); }
}
function encryptedReceipt(backupPath: string, manifest: EncryptedBackupManifest, inner: PayloadManifest, sha256: string, bytes: number): EncryptedBackupReceipt {
  return { backupPath, manifest, sha256, bytes, database: { ...inner.database } as BackupDatabase, ...(inner.consolidationKey ? { signingKey: { keyId: inner.consolidationKey.keyId } } : {}) };
}

/**
 * Privileged operator export: includes every workspace, agent, history and tombstone in the SQLite database.
 *
 * With `encryption`, writes an encrypted format-2 bundle (scrypt + AES-256-GCM, docs/OPERATIONS.md#encrypted-bundles)
 * that also carries the consolidation signing key `<sourcePath>.consolidation.key` when it exists
 * (`includeSigningKey: true` requires it; `false` leaves it out). A plain bundle never carries the key.
 */
export function backupLocalDatabase(input: OperationLimits & { sourcePath: string; backupPath: string }): Promise<BackupReceipt>;
export function backupLocalDatabase(input: OperationLimits & { sourcePath: string; backupPath: string; encryption: BackupEncryption; includeSigningKey?: boolean }): Promise<EncryptedBackupReceipt>;
export async function backupLocalDatabase(input: OperationLimits & { sourcePath: string; backupPath: string; encryption?: BackupEncryption; includeSigningKey?: boolean }): Promise<BackupReceipt | EncryptedBackupReceipt> {
  let owner: Stage | undefined, key: SigningKey | undefined, secret: Buffer | undefined;
  try {
    const encrypted = !!input && typeof input === 'object' && Object.hasOwn(input, 'encryption');
    keys(input, ['sourcePath', 'backupPath', ...(encrypted ? ['encryption', 'includeSigningKey'] : [])]);
    if (input.includeSigningKey !== undefined && typeof input.includeSigningKey !== 'boolean') fail('invalid-input');
    if (encrypted) secret = encryptionSecret(input.encryption);
    const limits = control(input), sourcePath = filename(input.sourcePath), backupPath = filename(input.backupPath);
    const source = regular(sourcePath); if (source.size > limits.maxBytes) fail('size-limit');
    for (const suffix of SUFFIXES.slice(1)) { const sidecar = stat(sourcePath + suffix); if (sidecar && (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1 || (sidecar.dev === source.dev && sidecar.ino === source.ino))) fail('unsafe-path'); }
    const keyPath = sourcePath + KEY_SUFFIX;
    if (secret && input.includeSigningKey !== false && (input.includeSigningKey === true || stat(keyPath))) key = readSigningKey(keyPath);
    const parent = destination(backupPath, secret ? [sourcePath, keyPath] : [sourcePath]); owner = stage(backupPath);
    const database = createFile(owner, 'snapshot.sqlite');
    const checked = await worker({ mode: 'backup', sourcePath, sourceIdentity: identity(source), targetPath: database.path, targetIdentity: database, maxBytes: limits.maxBytes }, limits);
    const digest = await digestFile(database.path, limits); if (digest.bytes > limits.maxBytes || digest.bytes !== checked.pageCount * checked.pageSize) fail('size-limit');
    if (secret) {
      const includes: BackupContent[] = key ? ['database', 'consolidation-key'] : ['database'];
      const inner: PayloadManifest = { format: 'mnemosyne-sqlite-backup-payload', version: 2, createdAt: new Date().toISOString(), includes: includes as PayloadManifest['includes'], database: { ...digest, ...checked }, ...(key ? { consolidationKey: { bytes: key.pem.length, sha256: key.sha256, keyId: key.keyId } } : {}) };
      const bundle = createFile(owner, 'bundle.mnemo-backup'); const manifest = await writeEncryptedBundle(database, bundle, inner, key, secret, limits);
      const bundleDigest = await digestFile(bundle.path, limits); publish(bundle, backupPath, parent, limits);
      return encryptedReceipt(backupPath, manifest, inner, bundleDigest.sha256, bundleDigest.bytes);
    }
    const manifest: BackupManifest = { format: 'mnemosyne-sqlite-backup', version: 1, scope: 'whole-database', createdAt: new Date().toISOString(), database: { ...digest, ...checked } };
    const bundle = createFile(owner, 'bundle.mnemo-backup'); await writeBundle(database, bundle, manifest, limits);
    const bundleDigest = await digestFile(bundle.path, limits); publish(bundle, backupPath, parent, limits);
    return { backupPath, manifest, ...bundleDigest };
  } catch (error) { return safe(error); } finally { key?.pem.fill(0); secret?.fill(0); cleanup(owner); }
}
/** Verifies a plain bundle, or (with `encryption`) an encrypted one: GCM tag, inner digests and SQLite integrity. */
export function verifyLocalBackup(input: OperationLimits & { backupPath: string }): Promise<BackupReceipt>;
export function verifyLocalBackup(input: OperationLimits & { backupPath: string; encryption: BackupEncryption }): Promise<BackupReceipt | EncryptedBackupReceipt>;
export async function verifyLocalBackup(input: OperationLimits & { backupPath: string; encryption?: BackupEncryption }): Promise<BackupReceipt | EncryptedBackupReceipt> {
  let owner: Stage | undefined, secret: Buffer | undefined, extracted: Extracted | undefined;
  try {
    keys(input, ['backupPath', 'encryption']);
    if (Object.hasOwn(input, 'encryption')) secret = encryptionSecret(input.encryption);
    const limits = control(input), backupPath = filename(input.backupPath); regular(backupPath); privateParent(backupPath);
    const format = bundleFormat(backupPath);
    if (format.version === 2 && !secret) fail('passphrase-required');
    owner = stage(backupPath);
    extracted = format.version === 1 ? { version: 1, ...await extract(backupPath, owner, limits) } : await extractEncrypted(backupPath, owner, limits, secret);
    if (extracted.version === 2) return encryptedReceipt(backupPath, extracted.manifest, extracted.inner, extracted.sha256, extracted.bytes);
    return { backupPath, manifest: extracted.manifest, sha256: extracted.sha256, bytes: extracted.bytes };
  } catch (error) { return safe(error); } finally { if (extracted?.version === 2) extracted.key?.pem.fill(0); secret?.fill(0); cleanup(owner); }
}
/**
 * Restores into a new database path. An encrypted bundle (needs `encryption`) that carries the consolidation
 * signing key also restores it to `<targetPath>.consolidation.key` (0600); an existing key file there is never
 * overwritten and fails the whole restore with nothing published.
 */
export function restoreLocalBackup(input: OperationLimits & { backupPath: string; targetPath: string }): Promise<RestoreReceipt>;
export function restoreLocalBackup(input: OperationLimits & { backupPath: string; targetPath: string; encryption: BackupEncryption }): Promise<RestoreReceipt | EncryptedRestoreReceipt>;
export async function restoreLocalBackup(input: OperationLimits & { backupPath: string; targetPath: string; encryption?: BackupEncryption }): Promise<RestoreReceipt | EncryptedRestoreReceipt> {
  let owner: Stage | undefined, secret: Buffer | undefined, extracted: Extracted | undefined;
  try {
    keys(input, ['backupPath', 'targetPath', 'encryption']);
    if (Object.hasOwn(input, 'encryption')) secret = encryptionSecret(input.encryption);
    const limits = control(input), backupPath = filename(input.backupPath), targetPath = filename(input.targetPath); regular(backupPath);
    const parent = destination(targetPath, [backupPath]);
    const format = bundleFormat(backupPath);
    if (format.version === 2 && !secret) fail('passphrase-required');
    const keyTarget = format.version === 2 && format.manifest.includes.includes('consolidation-key') ? targetPath + KEY_SUFFIX : undefined;
    if (keyTarget && (stat(keyTarget) || keyTarget === backupPath)) fail('target-exists', KEY_EXISTS);
    owner = stage(targetPath);
    extracted = format.version === 1 ? { version: 1, ...await extract(backupPath, owner, limits) } : await extractEncrypted(backupPath, owner, limits, secret);
    const expected = extracted.version === 1 ? extracted.manifest.database : extracted.inner.database;
    const final = await digestFile(extracted.database.path, limits);
    if (final.sha256 !== expected.sha256 || final.bytes !== expected.bytes) fail('changed-path');
    if (extracted.version === 1) {
      publish(extracted.database, targetPath, parent, limits);
      return { targetPath, manifest: extracted.manifest, sha256: expected.sha256, bytes: expected.bytes };
    }
    let keyFile: OwnedFile | undefined;
    if (extracted.key) {
      if (!keyTarget) fail('invalid-backup');
      keyFile = createFile(owner, 'consolidation.key'); writeOwned(keyFile, extracted.key.pem);
    }
    publish(extracted.database, targetPath, parent, limits);
    if (keyFile && keyTarget) {
      // Both or neither: if the key cannot be published, withdraw the database just published (only if it is still ours).
      try { publish(keyFile, keyTarget, parent, limits, KEY_EXISTS); } catch (error) {
        try { if (same(targetPath, extracted.database)) unlinkSync(targetPath); } catch { /* Preserve anything not recognizably ours. */ }
        throw error;
      }
    }
    return { targetPath, manifest: extracted.manifest, sha256: expected.sha256, bytes: expected.bytes, ...(extracted.key && keyTarget ? { signingKey: { keyId: extracted.key.keyId, path: keyTarget } } : {}) };
  } catch (error) { return safe(error); } finally { if (extracted?.version === 2) extracted.key?.pem.fill(0); secret?.fill(0); cleanup(owner); }
}
