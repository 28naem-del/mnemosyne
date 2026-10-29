import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Sol S16: first-use key-file publication must be atomic and durable. Before
 * the fix the final key path was created empty and the PEM written into it
 * afterwards, with no fsync, so a concurrent initializer could read an empty
 * key and a failed or interrupted write stranded an unusable key file that every
 * later open tripped over. Fixtures are synthetic; failures are injected
 * through a mocked `node:fs`.
 */

const hooks = vi.hoisted(() => ({
  onWrite: null as null | ((fd: number) => void),
  fsyncs: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync: ((fd: number, ...rest: unknown[]) => {
      hooks.onWrite?.(fd);
      return (actual.writeSync as (...args: unknown[]) => number)(fd, ...rest);
    }) as typeof actual.writeSync,
    fsyncSync: ((fd: number) => { hooks.fsyncs++; return actual.fsyncSync(fd); }) as typeof actual.fsyncSync,
  };
});

const { createConsolidationSigner } = await import('../src/consolidation/signing.js');

const roots: string[] = [];
afterEach(() => {
  hooks.onWrite = null;
  hooks.fsyncs = 0;
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});
const dir = (): string => { const root = fs.mkdtempSync(join(tmpdir(), 'mnemosyne-keyfile-')); roots.push(root); return root; };

describe('consolidation key file first use', () => {
  it('never exposes the key path before the full PEM is written and synced', () => {
    const keyFile = join(dir(), 'memory.sqlite.consolidation.key');
    const visibleDuringWrite: boolean[] = [];
    hooks.onWrite = () => { visibleDuringWrite.push(fs.existsSync(keyFile)); };
    const signer = createConsolidationSigner({ keyFile });
    // A second initializer arriving mid-write would have read an empty file at the final path.
    expect(visibleDuringWrite.length).toBeGreaterThan(0);
    expect(visibleDuringWrite).not.toContain(true);
    expect(hooks.fsyncs).toBeGreaterThan(0);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    // No temporary file is left beside the key.
    expect(fs.readdirSync(join(keyFile, '..'))).toEqual(['memory.sqlite.consolidation.key']);
    expect(createConsolidationSigner({ keyFile }).keyId).toBe(signer.keyId);
  });

  it('gives two racing initializers the same valid key', () => {
    const keyFile = join(dir(), 'memory.sqlite.consolidation.key');
    let second: ReturnType<typeof createConsolidationSigner> | undefined;
    let secondError: unknown;
    // The first initializer pauses mid-write; a second one runs to completion in that window.
    hooks.onWrite = () => {
      hooks.onWrite = null;
      try { second = createConsolidationSigner({ keyFile }); } catch (error) { secondError = error; }
    };
    const first = createConsolidationSigner({ keyFile });
    expect(secondError).toBeUndefined();
    expect(second?.keyId).toBe(first.keyId);
    expect(createConsolidationSigner({ keyFile }).keyId).toBe(first.keyId);
    expect(fs.readdirSync(join(keyFile, '..'))).toEqual(['memory.sqlite.consolidation.key']);
  });

  it('leaves no unusable key behind when the first write fails', () => {
    const root = dir();
    const keyFile = join(root, 'memory.sqlite.consolidation.key');
    hooks.onWrite = () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); };
    expect(() => createConsolidationSigner({ keyFile })).toThrow(/ENOSPC/);
    hooks.onWrite = null;
    expect(fs.readdirSync(root)).toEqual([]);
    // The next initializer starts clean and gets a working key.
    const signer = createConsolidationSigner({ keyFile });
    expect(signer.origin).toBe('file');
    expect(createConsolidationSigner({ keyFile }).keyId).toBe(signer.keyId);
  });

  it('refuses a corrupt existing key file with an explicit error and never replaces it', () => {
    const keyFile = join(dir(), 'memory.sqlite.consolidation.key');
    fs.writeFileSync(keyFile, '', { mode: 0o600 });
    expect(() => createConsolidationSigner({ keyFile })).toThrow(/not a valid Ed25519 private key.*refusing to replace it/);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('');
  });
});
