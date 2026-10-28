/**
 * Ed25519 signing for consolidation diffs and receipts (docs/CONSOLIDATION-SIGNING.md).
 *
 * The key cannot live inside the database from this module: `local_settings`
 * is reachable only through the kernel's private handle. A file store keeps
 * its key in a 0600 PKCS#8 file next to the database instead; `:memory:`
 * stores and tests use an ephemeral or seeded key.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import * as v from '../local/validation.js';
import type { ConsolidationSignature } from './types.js';

/** DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows it. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface ConsolidationSigner {
  readonly algorithm: 'ed25519';
  readonly keyId: string;
  readonly publicKey: string;
  /** Where the key came from, for disclosure: never the key itself. */
  readonly origin: 'file' | 'supplied' | 'ephemeral' | 'seed';
  sign(message: string): ConsolidationSignature;
}

export type ConsolidationSignerOptions =
  | { keyFile: string }
  | { privateKey: KeyObject | string }
  | { ephemeral: true }
  | { seed: Uint8Array };

function rawPublicKey(key: KeyObject): Buffer {
  const jwk = createPublicKey(key).export({ format: 'jwk' }) as { x?: string };
  if (typeof jwk.x !== 'string') throw new TypeError('Consolidation key must be Ed25519');
  return Buffer.from(jwk.x, 'base64url');
}

function signer(privateKey: KeyObject, origin: ConsolidationSigner['origin']): ConsolidationSigner {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('Consolidation key must be an Ed25519 private key');
  const raw = rawPublicKey(privateKey);
  const keyId = createHash('sha256').update(raw).digest('hex');
  const publicKey = raw.toString('base64url');
  return Object.freeze({
    algorithm: 'ed25519' as const, keyId, publicKey, origin,
    sign: (message: string): ConsolidationSignature => ({ algorithm: 'ed25519', keyId, publicKey, value: sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url') }),
  });
}

/** Creates the key file exclusively (0600) on first use, so two processes cannot race to different keys. */
function loadKeyFile(path: string): KeyObject {
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeSync(fd, pem); } finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error('Consolidation key path must be a regular file');
  chmodSync(path, 0o600);
  return createPrivateKey({ key: readFileSync(path, 'utf8'), format: 'pem' });
}

export function createConsolidationSigner(options: ConsolidationSignerOptions): ConsolidationSigner {
  const input = v.object(options, 'consolidation signer');
  v.keys(input, ['keyFile', 'privateKey', 'ephemeral', 'seed'], 'consolidation signer');
  if (Object.keys(input).length !== 1) throw new TypeError('Consolidation signer takes exactly one of keyFile, privateKey, ephemeral or seed');
  if ('keyFile' in options) return signer(loadKeyFile(v.string(options.keyFile, 'keyFile', 4096)), 'file');
  if ('privateKey' in options) {
    const key = typeof options.privateKey === 'string' ? createPrivateKey({ key: options.privateKey, format: 'pem' }) : options.privateKey;
    return signer(key, 'supplied');
  }
  if ('seed' in options) {
    if (!(options.seed instanceof Uint8Array) || options.seed.length !== 32) throw new TypeError('Consolidation seed must be 32 bytes');
    return signer(createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(options.seed)]), format: 'der', type: 'pkcs8' }), 'seed');
  }
  if (options.ephemeral !== true) throw new TypeError('ephemeral must be true');
  return signer(generateKeyPairSync('ed25519').privateKey, 'ephemeral');
}

/** Checks the key id against the embedded key, then the signature. Never throws on malformed input. */
export function verifyConsolidationSignature(message: string, signature: unknown): boolean {
  try {
    const value = v.object(signature, 'signature') as Partial<ConsolidationSignature>;
    if (value.algorithm !== 'ed25519' || typeof value.publicKey !== 'string' || typeof value.value !== 'string' || typeof value.keyId !== 'string') return false;
    const raw = Buffer.from(value.publicKey, 'base64url');
    if (raw.length !== 32 || raw.toString('base64url') !== value.publicKey) return false;
    if (createHash('sha256').update(raw).digest('hex') !== value.keyId) return false;
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: value.publicKey }, format: 'jwk' });
    return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(value.value, 'base64url'));
  } catch {
    return false;
  }
}

/** Domain-separated messages, so a diff signature can never be replayed as a receipt signature. */
export const diffSignatureMessage = (digest: string): string => `mnemosyne-consolidation-diff-signature-v1\n${digest}`;
export const receiptSignatureMessage = (digest: string): string => `mnemosyne-consolidation-receipt-signature-v1\n${digest}`;
