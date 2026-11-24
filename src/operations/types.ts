export interface OperationLimits {
  /** Snapshot size limit. Default 256 MiB; maximum 4 GiB. */
  maxBytes?: number;
  /** Deadline across preparation, SQLite work, hashing and publication. */
  timeoutMs?: number;
  signal?: AbortSignal;
}
/** Structural facts about the SQLite snapshot inside a bundle. */
export interface BackupDatabase {
  bytes: number;
  sha256: string;
  /** 1 (JSON embeddings) or 2 (packed float32, local/index.ts's SCHEMA_VERSION). */
  userVersion: 1 | 2;
  pageCount: number;
  pageSize: number;
  integrity: 'ok';
  foreignKeys: 'ok';
}
/** Manifest of a plain (format 1) bundle. Plain bundles never carry the consolidation signing key. */
export interface BackupManifest {
  format: 'mnemosyne-sqlite-backup';
  version: 1;
  scope: 'whole-database';
  createdAt: string;
  database: BackupDatabase;
}
/** What an encrypted (format 2) bundle carries, in payload order. */
export type BackupContent = 'database' | 'consolidation-key';
/**
 * Plaintext manifest of an encrypted (format 2) bundle (docs/OPERATIONS.md#encrypted-bundles).
 * It deliberately omits the database digest and sizes: those are inside the ciphertext.
 */
export interface EncryptedBackupManifest {
  format: 'mnemosyne-sqlite-backup';
  version: 2;
  scope: 'whole-database';
  createdAt: string;
  includes: BackupContent[];
  encryption: {
    kdf: 'scrypt';
    /** scrypt cost parameters; the derived key is 32 bytes. */
    params: { N: number; r: number; p: number };
    /** Base64, 16 random bytes. */
    salt: string;
    cipher: 'aes-256-gcm';
    /** Base64, 12 random bytes. */
    nonce: string;
    /** Base64, the 16-byte GCM authentication tag. */
    tag: string;
  };
  /** Ciphertext length; the bundle ends exactly after it. */
  payload: { bytes: number };
}
/** Passphrase for an encrypted bundle. Keep it out of argv, logs and the bundle's storage. */
export interface BackupEncryption {
  /** 1 to 4096 bytes; a string is used as its UTF-8 bytes, without normalization. */
  passphrase: string | Uint8Array;
}
export interface BackupReceipt {
  backupPath: string;
  manifest: BackupManifest;
  /** SHA-256 of the entire published bundle; not a cryptographic signature. */
  sha256: string;
  bytes: number;
}
export interface EncryptedBackupReceipt {
  backupPath: string;
  manifest: EncryptedBackupManifest;
  /** SHA-256 of the entire published (encrypted) bundle. */
  sha256: string;
  bytes: number;
  /** The authenticated inner database facts. */
  database: BackupDatabase;
  /** Present when the bundle carries the consolidation signing key: its public key id only. */
  signingKey?: { keyId: string };
}
export interface RestoreReceipt {
  targetPath: string;
  manifest: BackupManifest;
  sha256: string;
  bytes: number;
}
export interface EncryptedRestoreReceipt {
  targetPath: string;
  manifest: EncryptedBackupManifest;
  /** SHA-256 and size of the restored database file. */
  sha256: string;
  bytes: number;
  /** Present when the key was restored, to `<targetPath>.consolidation.key` (mode 0600). */
  signingKey?: { keyId: string; path: string };
}
