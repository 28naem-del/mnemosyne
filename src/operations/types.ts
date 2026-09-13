export interface OperationLimits {
  /** Snapshot size limit. Default 256 MiB; maximum 4 GiB. */
  maxBytes?: number;
  /** Deadline across preparation, SQLite work, hashing and publication. */
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface BackupManifest {
  format: 'mnemosyne-sqlite-backup';
  version: 1;
  scope: 'whole-database';
  createdAt: string;
  database: {
    bytes: number;
    sha256: string;
    userVersion: 1;
    pageCount: number;
    pageSize: number;
    integrity: 'ok';
    foreignKeys: 'ok';
  };
}
export interface BackupReceipt {
  backupPath: string;
  manifest: BackupManifest;
  /** SHA-256 of the entire published bundle; not a cryptographic signature. */
  sha256: string;
  bytes: number;
}
export interface RestoreReceipt {
  targetPath: string;
  manifest: BackupManifest;
  sha256: string;
  bytes: number;
}
