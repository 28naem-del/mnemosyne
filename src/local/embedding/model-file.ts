import { randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Writes verified model bytes into a cache directory that another local user
 * might also be able to write to.
 *
 * The staging name is unpredictable and created exclusively (`O_CREAT|O_EXCL`,
 * plus `O_NOFOLLOW` where the platform has it), so a file or symlink planted in
 * advance makes the open fail instead of redirecting the write. The finished
 * file is renamed into place, which replaces a directory entry at the target,
 * including a symlink, rather than writing through it. Permissions are set on
 * the open descriptor, never by path.
 */
export function writeModelFile(target: string, bytes: Uint8Array): void {
  const staging = join(dirname(target), `.${basename(target)}.${randomBytes(16).toString('hex')}.partial`);
  const descriptor = openSync(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    try {
      fchmodSync(descriptor, 0o600);
      for (let offset = 0; offset < bytes.byteLength;) offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    renameSync(staging, target);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
}
