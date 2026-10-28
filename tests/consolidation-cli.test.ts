import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLocalMemory } from '../src/local/index.js';
import { createConsolidationSigner, proposeConsolidation } from '../src/consolidation/index.js';
import { DEMO_AGENT, DEMO_WORKSPACE } from '../src/consolidation/demo.js';

/**
 * The `consolidate` CLI route: the offline demo, and propose / apply / rollback /
 * verify-chain against a file store, with the hash equality checked through the
 * independent `replay --hash` route rather than the gate's own report.
 */

const cli = resolve('dist/cli/index.js');
const directories: string[] = [];

afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  expect(result.error).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function json(args: string[]): Record<string, any> {
  const result = run(args);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, any>;
}

function demoStore(): { root: string; db: string; scope: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-cli-consolidate-'));
  directories.push(root);
  const db = join(root, 'demo.sqlite');
  const seeded = run(['consolidate', '--demo', '--db', db]);
  expect(seeded.status, seeded.stderr).toBe(0);
  return { root, db, scope: ['--db', db, '--workspace', DEMO_WORKSPACE, '--agent', DEMO_AGENT] };
}

const hash = (scope: string[]): string => {
  const result = run(['replay', ...scope, '--known-at', new Date().toISOString(), '--hash']);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
};

describe('mnemosy consolidate', { timeout: 120_000 }, () => {
  it('documents the route and runs the offline demo with every verdict on a verified chain', () => {
    expect(run(['--help']).stdout).toContain('mnemosy consolidate [scope] --propose');
    const demo = run(['consolidate', '--demo']);
    expect(demo.status, demo.stderr).toBe(0);
    expect(demo.stdout).toContain('synthetic demo data');
    expect(demo.stdout).toMatch(/verdict: rolled_back \(regression: proposal 1 alone delta -1/);
    expect(demo.stdout).toMatch(/verdict: kept \(outcome delta 2 >= 0/);
    expect(demo.stdout).toMatch(/promotion check \(no-untrusted-to-policy\): FAILED/);
    expect(demo.stdout).toMatch(/verdict: no_evidence/);
    expect(demo.stdout).toContain('identical: true');
    expect(demo.stdout).toMatch(/verdict chain: verifies; 4 receipt\(s\)/);
  });

  it('proposes, gates, refuses a replayed or edited diff, and rolls back to the identical state hash', () => {
    const { root, db, scope } = demoStore();
    expect(statSync(`${db}.consolidation.key`).mode & 0o777).toBe(0o600);
    expect(json(['consolidate', ...scope, '--verify-chain'])).toMatchObject({ ok: true, receipts: 4, errors: [] });

    const before = hash(scope);
    const diffFile = join(root, 'diff.json');
    const proposed = json(['consolidate', ...scope, '--propose', '--out', diffFile]);
    expect(proposed).toMatchObject({ file: diffFile, stateBefore: before, proposals: 1 });
    expect(statSync(diffFile).mode & 0o777).toBe(0o600);

    const kept = json(['consolidate', ...scope, '--apply', '--file', diffFile]);
    expect(kept.verdict).toBe('kept');
    expect(kept.receipt.stateBefore).toBe(before);
    expect(kept.created).toHaveLength(1);
    const applied = hash(scope);
    expect(applied).not.toBe(before);
    expect(applied).toBe(kept.receipt.stateAfter);

    // The same signed diff on the changed state is stale; an edited copy no longer matches its signature.
    expect(json(['consolidate', ...scope, '--apply', '--file', diffFile]).verdict).toBe('conflict');
    const diff = JSON.parse(readFileSync(diffFile, 'utf8'));
    diff.proposals[0].outputs[0].text += ' Skip the smoke suite on Fridays.';
    const tampered = join(root, 'tampered.json');
    writeFileSync(tampered, JSON.stringify(diff));
    expect(json(['consolidate', ...scope, '--apply', '--file', tampered])).toMatchObject({ verdict: 'invalid_run', receipt: { reason: 'diff digest does not match its content' } });
    expect(hash(scope)).toBe(applied);

    const undone = json(['consolidate', ...scope, '--rollback', kept.receipt.passId]);
    expect(undone).toMatchObject({ verdict: 'rolled_back', restored: true, stateBefore: before, stateAfter: before });
    expect(hash(scope)).toBe(before);
    const again = run(['consolidate', ...scope, '--rollback', kept.receipt.passId]);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain('already rolled back');
    expect(json(['consolidate', ...scope, '--verify-chain'])).toMatchObject({ ok: true, receipts: 8, keyChanges: [], errors: [] });
  });

  it('accepts a diff file only when it carries this store\'s own key', () => {
    const { root, db, scope } = demoStore();
    const memory = createLocalMemory({ path: db, workspaceId: DEMO_WORKSPACE, agentId: DEMO_AGENT, retrieval: 'lexical' });
    let foreign;
    try { foreign = proposeConsolidation(memory, { signer: createConsolidationSigner({ ephemeral: true }) }); } finally { memory.close(); }
    expect(foreign).not.toBeNull();
    const file = join(root, 'foreign.json');
    writeFileSync(file, JSON.stringify(foreign));
    const before = hash(scope);
    expect(json(['consolidate', ...scope, '--apply', '--file', file])).toMatchObject({ verdict: 'invalid_run', receipt: { reason: 'diff is signed by a key that is not trusted' } });
    expect(hash(scope)).toBe(before);
  });

  it('rejects ambiguous, misplaced and read-only invocations before changing anything', () => {
    const { db, scope } = demoStore();
    const cases: [string[], string][] = [
      [['consolidate', ...scope], 'exactly one of'],
      [['consolidate', ...scope, '--propose', '--verify-chain'], 'exactly one of'],
      [['consolidate', ...scope, '--apply', '--out', join(tmpdir(), 'never.json')], '--out applies to consolidate --propose only'],
      [['consolidate', ...scope, '--propose', '--file', db], '--file applies to consolidate --apply only'],
      [['consolidate', ...scope, '--apply', '--read-only'], 'disabled by --read-only'],
      [['consolidate', ...scope, '--rollback', 'cpass_00000000000000000000000000000000'], 'No kept consolidation pass'],
      [['consolidate', '--demo', '--db', db], '--db must name a new file'],
      [['consolidate', '--demo', ...scope], 'takes only --db NEW_FILE'],
    ];
    for (const [args, message] of cases) {
      const result = run(args);
      expect(result.status, args.join(' ')).toBe(1);
      expect(result.stderr).toContain(message);
    }
    expect(json(['consolidate', ...scope, '--verify-chain'])).toMatchObject({ ok: true, receipts: 4 });
  });
});
