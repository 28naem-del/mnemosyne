import { afterEach, describe, expect, it } from 'vitest';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory } from '../src/local/index.js';
import { createConsolidationSigner, verifyConsolidationChain } from '../src/consolidation/index.js';
import { DEMO_AGENT, DEMO_WORKSPACE, runConsolidationDemo } from '../src/consolidation/demo.js';
import { backupLocalDatabase, restoreLocalBackup, verifyLocalBackup, MemoryOperationError } from '../src/operations/index.js';

/**
 * Encrypted whole-database bundles (format 2): the consolidation signing key
 * travels only inside an authenticated, passphrase-encrypted bundle, and a
 * restore brings back both the database and the key so the receipt chain still
 * verifies with the restored key pinned (audit S07).
 */

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// Synthetic test-only passphrases; never a real secret.
const PASSPHRASE = 'correct horse battery staple (test only)';
const WRONG = 'incorrect horse battery staple (test only)';
const MAGIC1 = Buffer.from('MNEMOSYNE-BACKUP1\n');
const MAGIC2 = Buffer.from('MNEMOSYNE-BACKUP2\n');
const PEM = Buffer.from('-----BEGIN PRIVATE KEY-----');

function consolidated() {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-encrypted-')); roots.push(root);
  const db = join(root, 'source.sqlite'), keyFile = `${db}.consolidation.key`;
  const signer = createConsolidationSigner({ keyFile });
  const demo = runConsolidationDemo({ path: db, signer });
  expect(demo.chain.ok).toBe(true);
  return { root, db, keyFile, keyId: signer.keyId, backup: join(root, 'archive.mnemo-backup'), target: join(root, 'restored.sqlite') };
}
function header(bundle: Buffer, magic: Buffer) {
  const length = bundle.readUInt32BE(magic.length), start = magic.length + 4;
  return { manifest: JSON.parse(bundle.subarray(start, start + length).toString('utf8')) as Record<string, any>, start, length, body: start + length };
}
function rewriteManifest(bundle: Buffer, update: (manifest: Record<string, any>) => void): Buffer {
  const { manifest, body } = header(bundle, MAGIC2); update(manifest);
  const text = Buffer.from(JSON.stringify(manifest)), head = Buffer.alloc(MAGIC2.length + 4); MAGIC2.copy(head); head.writeUInt32BE(text.length, MAGIC2.length);
  return Buffer.concat([head, text, bundle.subarray(body)]);
}
async function code(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(MemoryOperationError); return (error as MemoryOperationError).code; }
  throw new Error('expected the operation to fail');
}
const staging = (root: string) => readdirSync(root).filter(name => name.startsWith('.mnemosyne-recovery-'));

describe('encrypted backups carry the consolidation signing key', { timeout: 60_000 }, () => {
  it('round-trips the database and the key, and the restored key verifies the receipt chain', async () => {
    const f = consolidated(); const originalKey = readFileSync(f.keyFile);
    const receipt = await backupLocalDatabase({ sourcePath: f.db, backupPath: f.backup, encryption: { passphrase: PASSPHRASE } });
    expect(receipt.manifest).toMatchObject({ format: 'mnemosyne-sqlite-backup', version: 2, scope: 'whole-database', includes: ['database', 'consolidation-key'] });
    expect(receipt.manifest.encryption).toMatchObject({ kdf: 'scrypt', cipher: 'aes-256-gcm', params: { N: 32768, r: 8, p: 1 } });
    expect(receipt.signingKey).toEqual({ keyId: f.keyId });
    expect(lstatSync(f.backup).mode & 0o777).toBe(0o600);
    const bundle = readFileSync(f.backup);
    expect(bundle.subarray(0, MAGIC2.length).equals(MAGIC2)).toBe(true);
    // Neither the PEM, the raw key nor any plaintext SQLite page is visible in the bundle.
    expect(bundle.includes(PEM)).toBe(false); expect(bundle.includes(originalKey.subarray(28, 60))).toBe(false);
    expect(bundle.includes(Buffer.from('SQLite format 3'))).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain(PASSPHRASE);

    const verified = await verifyLocalBackup({ backupPath: f.backup, encryption: { passphrase: PASSPHRASE } });
    expect(verified).toEqual(receipt);

    const restored = await restoreLocalBackup({ backupPath: f.backup, targetPath: f.target, encryption: { passphrase: PASSPHRASE } });
    const restoredKey = `${f.target}.consolidation.key`;
    expect(restored.signingKey).toEqual({ keyId: f.keyId, path: restoredKey });
    expect(restored.sha256).toBe(receipt.database.sha256);
    expect(lstatSync(f.target).mode & 0o777).toBe(0o600); expect(lstatSync(restoredKey).mode & 0o777).toBe(0o600);
    expect(readFileSync(restoredKey).equals(originalKey)).toBe(true);
    expect(staging(f.root)).toEqual([]);

    const memory = createLocalMemory({ path: f.target, workspaceId: DEMO_WORKSPACE, agentId: DEMO_AGENT, retrieval: 'lexical' });
    try {
      const pinned = createConsolidationSigner({ keyFile: restoredKey }).keyId;
      expect(pinned).toBe(f.keyId);
      const chain = verifyConsolidationChain(memory, { pinnedKeyIds: [pinned] });
      expect(chain).toMatchObject({ ok: true, errors: [] }); expect(chain.receipts).toBeGreaterThan(0);
      // Control: a different key must not verify the same restored chain.
      const other = createConsolidationSigner({ ephemeral: true }).keyId;
      expect(verifyConsolidationChain(memory, { pinnedKeyIds: [other] }).ok).toBe(false);
    } finally { memory.close(); }
  });

  it('documents an envelope a standard scrypt + AES-256-GCM implementation can open', async () => {
    const f = consolidated();
    await backupLocalDatabase({ sourcePath: f.db, backupPath: f.backup, encryption: { passphrase: PASSPHRASE } });
    const bundle = readFileSync(f.backup), { manifest, body } = header(bundle, MAGIC2);
    const e = manifest.encryption, key = scryptSync(PASSPHRASE, Buffer.from(e.salt, 'base64'), 32, { N: e.params.N, r: e.params.r, p: e.params.p, maxmem: 256 * 1024 * 1024 });
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.nonce, 'base64')); decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
    const payload = Buffer.concat([decipher.update(bundle.subarray(body)), decipher.final()]);
    expect(bundle.length - body).toBe(manifest.payload.bytes);
    const innerMagic = Buffer.from('MNEMOSYNE-PAYLOAD2\n'); expect(payload.subarray(0, innerMagic.length).equals(innerMagic)).toBe(true);
    const length = payload.readUInt32BE(innerMagic.length), start = innerMagic.length + 4;
    const inner = JSON.parse(payload.subarray(start, start + length).toString('utf8')) as Record<string, any>;
    expect(inner).toMatchObject({ format: 'mnemosyne-sqlite-backup-payload', version: 2, createdAt: manifest.createdAt, includes: manifest.includes });
    const database = payload.subarray(start + length, start + length + inner.database.bytes), pem = payload.subarray(start + length + inner.database.bytes);
    expect(database.subarray(0, 15).toString()).toBe('SQLite format 3');
    expect(pem.equals(readFileSync(f.keyFile))).toBe(true); expect(pem.length).toBe(inner.consolidationKey.bytes);
  });

  it('fails cleanly on a wrong passphrase and publishes nothing', async () => {
    const f = consolidated();
    await backupLocalDatabase({ sourcePath: f.db, backupPath: f.backup, encryption: { passphrase: PASSPHRASE } });
    for (const run of [
      () => restoreLocalBackup({ backupPath: f.backup, targetPath: f.target, encryption: { passphrase: WRONG } }),
      () => verifyLocalBackup({ backupPath: f.backup, encryption: { passphrase: WRONG } }),
    ]) {
      const error = await run().then(() => undefined, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(MemoryOperationError);
      expect((error as MemoryOperationError).code).toBe('decryption-failed');
      expect((error as Error).message).toBe('backup decryption failed: wrong passphrase or corrupted bundle');
    }
    expect(existsSync(f.target)).toBe(false); expect(existsSync(`${f.target}.consolidation.key`)).toBe(false);
    expect(staging(f.root)).toEqual([]);
  });

  it('requires a passphrase to verify or restore an encrypted bundle', async () => {
    const f = consolidated();
    await backupLocalDatabase({ sourcePath: f.db, backupPath: f.backup, encryption: { passphrase: PASSPHRASE } });
    expect(await code(verifyLocalBackup({ backupPath: f.backup }))).toBe('passphrase-required');
    expect(await code(restoreLocalBackup({ backupPath: f.backup, targetPath: f.target }))).toBe('passphrase-required');
    expect(existsSync(f.target)).toBe(false);
  });

  it('rejects a tampered ciphertext byte, tag, salt, nonce or plaintext manifest field', async () => {
    const f = consolidated();
    await backupLocalDatabase({ sourcePath: f.db, backupPath: f.backup, encryption: { passphrase: PASSPHRASE } });
    const bundle = readFileSync(f.backup), { body } = header(bundle, MAGIC2);
    const flip = (offset: number) => { const copy = Buffer.from(bundle); copy[offset] ^= 0x01; return copy; };
    const flipBase64 = (value: string) => { const bytes = Buffer.from(value, 'base64'); bytes[0] ^= 0x01; return bytes.toString('base64'); };
    const cases: Array<[string, Buffer, string]> = [
      ['first ciphertext byte', flip(body), 'decryption-failed'],
      ['middle ciphertext byte', flip(body + Math.floor((bundle.length - body) / 2)), 'decryption-failed'],
      ['last ciphertext byte', flip(bundle.length - 1), 'decryption-failed'],
      ['tag', rewriteManifest(bundle, m => { m.encryption.tag = flipBase64(m.encryption.tag); }), 'decryption-failed'],
      ['salt', rewriteManifest(bundle, m => { m.encryption.salt = flipBase64(m.encryption.salt); }), 'decryption-failed'],
      ['nonce', rewriteManifest(bundle, m => { m.encryption.nonce = flipBase64(m.encryption.nonce); }), 'decryption-failed'],
      ['createdAt', rewriteManifest(bundle, m => { m.createdAt = new Date(0).toISOString(); }), 'invalid-backup'],
      ['includes', rewriteManifest(bundle, m => { m.includes = ['database']; }), 'invalid-backup'],
      ['kdf cost', rewriteManifest(bundle, m => { m.encryption.params.N = 2 ** 30; }), 'invalid-backup'],
      ['unknown field', rewriteManifest(bundle, m => { m.extra = true; }), 'invalid-backup'],
      ['trailing byte', Buffer.concat([bundle, Buffer.from([0])]), 'invalid-backup'],
      ['truncated', bundle.subarray(0, bundle.length - 1), 'invalid-backup'],
    ];
    for (const [name, bytes, expected] of cases) {
      const path = join(f.root, `tampered-${name.replace(/\s+/g, '-')}.mnemo-backup`); writeFileSync(path, bytes, { mode: 0o600 });
      expect(await code(restoreLocalBackup({ backupPath: path, targetPath: f.target, encryption: { passphrase: PASSPHRASE } })), name).toBe(expected);
      expect(existsSync(f.target), name).toBe(false); expect(existsSync(`${f.target}.consolidation.key`), name).toBe(false);
    }
    expect(staging(f.root)).toEqual([]);
  });

  it('refuses to overwrite an existing key file at the restore target and publishes nothing', async () => {
    const f = consolidated();
    await backupLocalDatabase({ sourcePath: f.db, backupPath: f.backup, encryption: { passphrase: PASSPHRASE } });
    const existing = `${f.target}.consolidation.key`; writeFileSync(existing, 'operator key placeholder\n', { mode: 0o600 });
    const error = await restoreLocalBackup({ backupPath: f.backup, targetPath: f.target, encryption: { passphrase: PASSPHRASE } }).then(() => undefined, (failure: unknown) => failure);
    expect((error as MemoryOperationError).code).toBe('target-exists');
    expect((error as Error).message).toMatch(/consolidation\.key already exists/);
    expect(readFileSync(existing, 'utf8')).toBe('operator key placeholder\n');
    expect(existsSync(f.target)).toBe(false); expect(staging(f.root)).toEqual([]);
  });

  it('encrypts a database without a key file and then carries only the database', async () => {
    const f = consolidated(); unlinkSync(f.keyFile);
    const receipt = await backupLocalDatabase({ sourcePath: f.db, backupPath: f.backup, encryption: { passphrase: PASSPHRASE } });
    expect(receipt.manifest.includes).toEqual(['database']); expect(receipt.signingKey).toBeUndefined();
    expect(await code(backupLocalDatabase({ sourcePath: f.db, backupPath: join(f.root, 'required.mnemo-backup'), encryption: { passphrase: PASSPHRASE }, includeSigningKey: true }))).toBe('invalid-input');
    const restored = await restoreLocalBackup({ backupPath: f.backup, targetPath: f.target, encryption: { passphrase: PASSPHRASE } });
    expect(restored.signingKey).toBeUndefined(); expect(existsSync(`${f.target}.consolidation.key`)).toBe(false);
  });

  it('can exclude the key from an encrypted bundle on request', async () => {
    const f = consolidated();
    const receipt = await backupLocalDatabase({ sourcePath: f.db, backupPath: f.backup, encryption: { passphrase: PASSPHRASE }, includeSigningKey: false });
    expect(receipt.manifest.includes).toEqual(['database']);
    expect(readFileSync(f.backup).includes(PEM)).toBe(false);
  });

  it('rejects empty passphrases and malformed encryption options', async () => {
    const f = consolidated();
    for (const encryption of [{ passphrase: '' }, { passphrase: 'x'.repeat(4097) }, { passphrase: PASSPHRASE, cost: 1 }, {}]) {
      expect(await code(backupLocalDatabase({ sourcePath: f.db, backupPath: f.backup, encryption } as never))).toBe('invalid-input');
    }
    expect(existsSync(f.backup)).toBe(false);
  });
});

describe('plain backups are unchanged and never carry the key', { timeout: 60_000 }, () => {
  it('writes the exact v1 format with no PEM bytes even when a key file sits beside the database', async () => {
    const f = consolidated(); const key = readFileSync(f.keyFile);
    const receipt = await backupLocalDatabase({ sourcePath: f.db, backupPath: f.backup });
    const bundle = readFileSync(f.backup), { manifest, body } = header(bundle, MAGIC1);
    expect(bundle.subarray(0, MAGIC1.length).equals(MAGIC1)).toBe(true);
    expect(Object.keys(manifest)).toEqual(['format', 'version', 'scope', 'createdAt', 'database']);
    expect(manifest).toEqual(receipt.manifest); expect(manifest.version).toBe(1);
    expect(Object.keys(receipt)).toEqual(['backupPath', 'manifest', 'sha256', 'bytes']);
    expect(bundle.length).toBe(body + manifest.database.bytes);
    expect(bundle.includes(PEM)).toBe(false); expect(bundle.includes(key.subarray(28, 60))).toBe(false);
    const restored = await restoreLocalBackup({ backupPath: f.backup, targetPath: f.target });
    expect(Object.keys(restored)).toEqual(['targetPath', 'manifest', 'sha256', 'bytes']);
    expect(existsSync(`${f.target}.consolidation.key`)).toBe(false);
    // A passphrase supplied for a plain bundle is not needed and changes nothing.
    expect(await verifyLocalBackup({ backupPath: f.backup, encryption: { passphrase: PASSPHRASE } })).toEqual(receipt);
  });

  it('refuses includeSigningKey without encryption', async () => {
    const f = consolidated();
    expect(await code(backupLocalDatabase({ sourcePath: f.db, backupPath: f.backup, includeSigningKey: true } as never))).toBe('invalid-input');
    expect(existsSync(f.backup)).toBe(false);
  });
});
