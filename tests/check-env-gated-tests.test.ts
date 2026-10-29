import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Sol S15: the env-gate guard (scripts/check-env-gated-tests.mjs) must not
 * certify a gate because one of its tests ran while the others were skipped.
 * Fed synthetic vitest JSON reports; never the real one.
 */

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'check-env-gated-tests.mjs');
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

type Status = 'passed' | 'failed' | 'skipped' | 'pending' | 'todo';
function check(tests: [string, Status][], env: Record<string, string> = {}): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-env-gate-'));
  roots.push(root);
  const report = join(root, 'report.json');
  writeFileSync(report, JSON.stringify({
    testResults: [{ assertionResults: tests.map(([fullName, status]) => ({ fullName, title: fullName, ancestorTitles: [], status })) }],
  }));
  const base = { ...process.env };
  delete base.MNEMOSYNE_ALLOW_BARE_TEST_ENV;
  const run = spawnSync(process.execPath, [SCRIPT, report], { encoding: 'utf8', env: { ...base, ...env } });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe('env-gated test guard', () => {
  it('passes when every gated test ran', () => {
    const result = check([['[env:model] embeds', 'passed'], ['[env:model] ranks', 'passed'], ['[env:hnsw] builds', 'passed'], ['plain test', 'skipped']]);
    expect(result.status).toBe(0);
    expect(result.output).toContain('3/3 ran');
  });

  it('fails a gate where every test was skipped', () => {
    const result = check([['[env:model] embeds', 'skipped'], ['[env:hnsw] builds', 'passed']]);
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/every test behind env:model \(1 tests\) was skipped/);
  });

  it('fails a gate where one test ran and another was skipped', () => {
    const result = check([['[env:model] embeds', 'passed'], ['[env:model] ranks', 'skipped'], ['[env:model] reranks', 'pending']]);
    // Before the fix one passing test certified the whole gate and this exited 0.
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/env:model skipped 2 of 3 tests/);
  });

  it('only warns about partial coverage when a bare host is declared', () => {
    const result = check([['[env:model] embeds', 'passed'], ['[env:model] ranks', 'skipped']], { MNEMOSYNE_ALLOW_BARE_TEST_ENV: '1' });
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/WARNING: env:model skipped 1 of 2 tests/);
  });
});
