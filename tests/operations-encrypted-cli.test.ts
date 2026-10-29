import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEMO_AGENT, DEMO_WORKSPACE } from '../src/consolidation/demo.js';

/**
 * `mnemosy operations` with `--encrypt`: the passphrase comes only from
 * MNEMOSYNE_BACKUP_PASSPHRASE or --passphrase-file, never argv; an encrypted
 * bundle restores the database and its consolidation key so `consolidate
 * --verify-chain` passes with the restored key pinned.
 */

const cli = resolve('dist/cli/index.js');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// Synthetic test-only passphrases; never a real secret.
const PASSPHRASE = 'cli test passphrase (synthetic)';
const ENV = 'MNEMOSYNE_BACKUP_PASSPHRASE';

function run(args: string[], env: Record<string, string> = {}) {
  const base = { ...process.env }; delete base[ENV];
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000, env: { ...base, ...env } });
  expect(result.error).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function ok(args: string[], env: Record<string, string> = {}) {
  const result = run(args, env); expect(result.status, result.stderr).toBe(0); return result;
}
function store() {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-encrypted-cli-')); roots.push(root);
  const db = join(root, 'demo.sqlite');
  ok(['consolidate', '--demo', '--db', db]);
  expect(existsSync(`${db}.consolidation.key`)).toBe(true);
  return { root, db, backup: join(root, 'demo.mnemo-backup'), target: join(root, 'restored.sqlite') };
}
const scope = (db: string) => ['--db', db, '--workspace', DEMO_WORKSPACE, '--agent', DEMO_AGENT];

describe('mnemosy operations --encrypt', { timeout: 120_000 }, () => {
  it('documents the flags and round-trips database and key so --verify-chain passes on the restored store', () => {
    const help = run(['--help']).stdout;
    expect(help).toContain('--encrypt'); expect(help).toContain('--passphrase-file'); expect(help).toContain(ENV);
    const f = store();
    const backup = ok(['operations', '--action', 'backup', '--db', f.db, '--out', f.backup, '--encrypt'], { [ENV]: PASSPHRASE });
    const receipt = JSON.parse(backup.stdout);
    expect(receipt.manifest).toMatchObject({ version: 2, includes: ['database', 'consolidation-key'] });
    expect(backup.stdout + backup.stderr).not.toContain(PASSPHRASE);
    expect(readFileSync(f.backup).includes(Buffer.from('PRIVATE KEY'))).toBe(false);

    const file = join(f.root, 'passphrase.txt'); writeFileSync(file, `${PASSPHRASE}\n`, { mode: 0o600 });
    ok(['operations', '--action', 'verify', '--file', f.backup, '--passphrase-file', file]);
    const restored = JSON.parse(ok(['operations', '--action', 'restore', '--file', f.backup, '--out', f.target, '--passphrase-file', file]).stdout);
    expect(restored.signingKey.keyId).toBe(receipt.signingKey.keyId);
    expect(lstatSync(`${f.target}.consolidation.key`).mode & 0o777).toBe(0o600);
    const chain = JSON.parse(ok(['consolidate', ...scope(f.target), '--verify-chain']).stdout);
    expect(chain).toMatchObject({ ok: true, errors: [], pinnedKeyIds: [receipt.signingKey.keyId] });
    expect(chain.receipts).toBeGreaterThan(0);
  });

  it('rejects a passphrase on argv without echoing it', () => {
    const f = store();
    for (const args of [['--passphrase', 'argv-secret-value'], ['--passphrase=argv-secret-value']]) {
      const result = run(['operations', '--action', 'backup', '--db', f.db, '--out', f.backup, '--encrypt', ...args]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--passphrase-file'); expect(result.stderr).toContain(ENV);
      expect(result.stderr + result.stdout).not.toContain('argv-secret-value');
    }
    expect(existsSync(f.backup)).toBe(false);
  });

  it('refuses unsafe or missing passphrase sources and plain key bundling', () => {
    const f = store();
    const open = join(f.root, 'open.txt'); writeFileSync(open, PASSPHRASE, { mode: 0o644 });
    const cases: Array<[string[], Record<string, string>, RegExp]> = [
      [['--encrypt'], {}, /passphrase/i],
      [['--encrypt', '--passphrase-file', open], {}, /group or others/],
      [['--include-signing-key'], {}, /--encrypt/],
      [['--encrypt', '--include-signing-key', '--db', join(f.root, 'nokey.sqlite')], { [ENV]: PASSPHRASE }, /no consolidation key file/],
      [['--passphrase-file', open], {}, /--encrypt/],
      [['--encrypt', '--passphrase-file', open], { [ENV]: PASSPHRASE }, /not both|group or others/],
    ];
    for (const [extra, env, message] of cases) {
      const result = run(['operations', '--action', 'backup', '--db', f.db, '--out', f.backup, ...extra], env);
      expect(result.status, extra.join(' ')).toBe(1); expect(result.stderr, extra.join(' ')).toMatch(message);
    }
    const empty = join(f.root, 'empty.txt'); writeFileSync(empty, '\n', { mode: 0o600 });
    expect(run(['operations', '--action', 'backup', '--db', f.db, '--out', f.backup, '--encrypt', '--passphrase-file', empty]).status).toBe(1);
    expect(existsSync(f.backup)).toBe(false);
  });

  it('fails a wrong passphrase cleanly with nothing published', () => {
    const f = store();
    ok(['operations', '--action', 'backup', '--db', f.db, '--out', f.backup, '--encrypt'], { [ENV]: PASSPHRASE });
    const result = run(['operations', '--action', 'restore', '--file', f.backup, '--out', f.target], { [ENV]: 'not the passphrase' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('backup decryption failed: wrong passphrase or corrupted bundle');
    expect(existsSync(f.target)).toBe(false); expect(existsSync(`${f.target}.consolidation.key`)).toBe(false);
    expect(readdirSync(f.root).filter(name => name.startsWith('.mnemosyne-recovery-'))).toEqual([]);
    const missing = run(['operations', '--action', 'restore', '--file', f.backup, '--out', f.target]);
    expect(missing.status).toBe(1); expect(missing.stderr).toMatch(/encrypted/);
  });

  it('warns on stderr when a restored store has receipts but no consolidation key (plain bundle)', () => {
    const f = store();
    const plain = ok(['operations', '--action', 'backup', '--db', f.db, '--out', f.backup], { [ENV]: PASSPHRASE });
    expect(JSON.parse(plain.stdout).manifest.version).toBe(1);
    expect(readFileSync(f.backup).includes(Buffer.from('PRIVATE KEY'))).toBe(false);
    const restored = ok(['operations', '--action', 'restore', '--file', f.backup, '--out', f.target]);
    expect(restored.stderr).toMatch(/consolidation receipt/); expect(restored.stderr).toContain('consolidation.key');
    expect(existsSync(`${f.target}.consolidation.key`)).toBe(false);
    const chain = run(['consolidate', ...scope(f.target), '--verify-chain']);
    expect(chain.stderr).toMatch(/no consolidation key file/);
    // A store with no receipts gets no warning.
    const empty = join(f.root, 'empty.sqlite');
    ok(['store', '--db', empty, '--workspace', 'w', '--agent', 'a', '--text', 'hello', '--source', 'test:x']);
    const emptyBackup = join(f.root, 'empty.mnemo-backup');
    ok(['operations', '--action', 'backup', '--db', empty, '--out', emptyBackup]);
    // (stderr may carry Node 22's SQLite ExperimentalWarning, so assert the warning is absent rather than stderr empty)
    expect(ok(['operations', '--action', 'restore', '--file', emptyBackup, '--out', join(f.root, 'empty-restored.sqlite')]).stderr).not.toMatch(/consolidation receipt/);
  });
});
