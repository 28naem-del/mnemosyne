import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLocalMemory } from '../src/local/index.js';

/**
 * The `replay` and `bisect` CLI routes.
 *
 * Both are new, both are read-only, and neither may exist for a caller who does
 * not ask for it: the surface here is exactly the surface the docs promise, and
 * nothing else changes shape.
 */

const cli = resolve('dist/cli/index.js');
const directories: string[] = [];
const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
const iso = (millis: number): string => new Date(millis).toISOString();

afterEach(() => { for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { db: string; scope: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-cli-replay-'));
  directories.push(root);
  const db = join(root, 'memory.sqlite');
  const clock = { value: T0 };
  const memory = createLocalMemory({ path: db, workspaceId: 'replay-cli', agentId: 'controller', now: () => new Date(clock.value) });
  try {
    const policy = memory.store({ text: 'the deployment window is Tuesday', kind: 'decision', source: { uri: 'doc://runbook-v1' } });
    // Held across both cut points, so the diff below has to be about the correction alone.
    memory.store({ text: 'an unrelated observation', source: { uri: 'doc://notes' } });
    clock.value = T0 + 20 * DAY;
    memory.correct(policy.id, { text: 'the deployment window is Thursday', source: { uri: 'doc://runbook-v2' }, reason: 'schedule change' });
  } finally { memory.close(); }
  return { db, scope: ['--db', db, '--workspace', 'replay-cli', '--agent', 'controller'] };
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  expect(result.error).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Every case here spawns real CLI processes; under a fully parallel `npm run
// check` on a shared machine that is seconds, not milliseconds.
describe('mnemosy replay', { timeout: 60_000 }, () => {
  it('reconstructs a belief state and reports the hash with its exclusions', () => {
    const f = fixture();
    const result = run(['replay', ...f.scope, '--known-at', iso(T0 + DAY)]);
    expect(result.status, result.stderr).toBe(0);
    const state = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(state.algorithm).toBe('mnemosyne-replay-state-v1');
    expect(state.cut).toEqual({ asOf: iso(T0 + DAY), knownAt: iso(T0 + DAY) });
    expect(state.stateSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(state.records).toBe(2);
    expect(state.excluded).toContain('local_ledger');
    // The record bodies are not printed unless asked for: a 10k state is not console output.
    expect(state.items).toBeUndefined();
  });

  it('prints the digest alone under --hash, for scripting', () => {
    const f = fixture();
    const full = run(['replay', ...f.scope, '--known-at', iso(T0 + DAY)]);
    const bare = run(['replay', ...f.scope, '--known-at', iso(T0 + DAY), '--hash']);
    expect(bare.status, bare.stderr).toBe(0);
    expect(bare.stdout.trim()).toBe((JSON.parse(full.stdout) as { stateSha256: string }).stateSha256);
    expect(bare.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same hash for the same cut point on a second invocation', () => {
    const f = fixture();
    const args = ['replay', ...f.scope, '--known-at', iso(T0 + 30 * DAY), '--as-of', iso(T0 + 10 * DAY), '--hash'];
    expect(run(args).stdout).toBe(run(args).stdout);
  });

  it('reads the belief held at a past cut point, not the current one', () => {
    const f = fixture();
    const before = JSON.parse(run(['replay', ...f.scope, '--known-at', iso(T0 + DAY), '--records']).stdout) as { items: { text: string }[] };
    const after = JSON.parse(run(['replay', ...f.scope, '--known-at', iso(T0 + 30 * DAY), '--records']).stdout) as { items: { text: string }[] };
    expect(before.items.map(item => item.text)).toContain('the deployment window is Tuesday');
    expect(before.items.map(item => item.text)).not.toContain('the deployment window is Thursday');
    expect(after.items.map(item => item.text)).toContain('the deployment window is Thursday');
    expect(after.items.map(item => item.text)).not.toContain('the deployment window is Tuesday');
  });

  it('diffs two cut points and names the source of each change', () => {
    const f = fixture();
    const result = run(['replay', ...f.scope, '--known-at', iso(T0 + DAY), '--diff', iso(T0 + 30 * DAY),
      '--json', JSON.stringify({ knownAt: iso(T0 + 30 * DAY) })]);
    expect(result.status, result.stderr).toBe(0);
    const diff = JSON.parse(result.stdout) as {
      from: { stateSha256: string }; to: { stateSha256: string };
      added: { text: string; source: { uri: string }; ledger: { event: string }[] }[];
      removed: { text: string; source: { uri: string } }[];
    };
    expect(diff.from.stateSha256).not.toBe(diff.to.stateSha256);
    const correction = diff.added.find(entry => entry.text === 'the deployment window is Thursday');
    expect(correction?.source.uri).toBe('doc://runbook-v2');
    expect(correction?.ledger.map(entry => entry.event)).toContain('correction');
    expect(diff.removed.find(entry => entry.text === 'the deployment window is Tuesday')?.source.uri).toBe('doc://runbook-v1');
  });

  it('requires --known-at and rejects a malformed cut point', () => {
    const f = fixture();
    const missing = run(['replay', ...f.scope]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('--known-at');
    const malformed = run(['replay', ...f.scope, '--known-at', 'last tuesday']);
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain('ISO timestamp');
    expect(malformed.stdout).toBe('');
  });

  it('is refused under --no-recall and never treated as a write', () => {
    const f = fixture();
    const denied = run(['replay', ...f.scope, '--known-at', iso(T0 + DAY), '--no-recall']);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('disabled by --no-recall');
    // read-only is a read route's normal mode, not a denial.
    expect(run(['replay', ...f.scope, '--known-at', iso(T0 + DAY), '--read-only', '--hash']).status).toBe(0);
  });

  it('appears in --help', () => {
    const help = run(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('mnemosy replay [scope]');
    expect(help.stdout).toContain('mnemosy bisect [scope]');
  });
});
