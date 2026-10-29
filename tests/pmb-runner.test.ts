import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * benchmarks/precisionmembench/run.mjs must publish only reports its own run
 * produced. The harness is replaced by a fake `ava` that either writes a fresh
 * report or fails without writing one, next to a stale report from an earlier run.
 */

const runner = resolve('benchmarks/precisionmembench/run.mjs');
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

const FAKE_AVA = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs');
const test = process.argv[2];
if (process.env.FAKE_AVA === 'crash') { console.error('harness crashed before writing a report'); process.exit(1); }
mkdirSync('test-results', { recursive: true });
const name = test.includes('session') ? 'session-retrieval-report-mnemosyne.json' : 'retrieval-report-mnemosyne.json';
writeFileSync('test-results/' + name, JSON.stringify({ fresh: true, retrieval: { totalPassed: 70, totalCases: 77, passRate: 0.9091, meanPrecision: 0.871, meanRecall: 1, activeRetrievalPasses: 1, passTypes: {}, p50LatencyMs: 1 } }));
console.log('  ✘ 7 tests failed');
process.exit(1);
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-pmb-runner-'));
  roots.push(root);
  const clone = join(root, 'clone'), reports = join(root, 'reports');
  mkdirSync(join(clone, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(clone, 'node_modules/.bin/ava'), FAKE_AVA);
  chmodSync(join(clone, 'node_modules/.bin/ava'), 0o755);
  // A report left in the clone by an earlier run.
  mkdirSync(join(clone, 'test-results'));
  writeFileSync(join(clone, 'test-results/retrieval-report-mnemosyne.json'), JSON.stringify({ stale: true, retrieval: { totalPassed: 12, totalCases: 77 } }));
  return { clone, reports };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function run(clone: string, reports: string, mode: 'ok' | 'crash') {
  const port = await freePort();
  const result = spawnSync(process.execPath, [runner, '--label', 'probe', '--port', String(port)], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, MNEMOSYNE_PMB_CLONE: clone, MNEMOSYNE_PMB_REPORTS: reports, MNEMOSYNE_PMB_DB: join(clone, 'pmb.sqlite'), FAKE_AVA: mode },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('PrecisionMemBench runner', () => {
  it('fails loudly and publishes nothing when the harness wrote no report, even with an old one in the clone', { timeout: 150_000 }, async () => {
    const { clone, reports } = fixture();
    // A previously published result for this label must survive the failed run.
    mkdirSync(join(reports, 'probe'), { recursive: true });
    writeFileSync(join(reports, 'probe/retrieval-report-mnemosyne.json'), 'published earlier');
    const { status, output } = await run(clone, reports, 'crash');
    expect(status, output).toBe(1);
    expect(output).toMatch(/FAILED, nothing published/);
    expect(readFileSync(join(reports, 'probe/retrieval-report-mnemosyne.json'), 'utf8')).toBe('published earlier');
    expect(readdirSync(reports)).toEqual(['probe']);
    // The stale clone report was removed rather than copied.
    expect(existsSync(join(clone, 'test-results/retrieval-report-mnemosyne.json'))).toBe(false);
  });

  it('publishes the fresh report with its run id, inputs hash and digest', { timeout: 150_000 }, async () => {
    const { clone, reports } = fixture();
    const { status, output } = await run(clone, reports, 'ok');
    // 3: the fresh report records failing cases, as every published configuration does.
    expect(status, output).toBe(3);
    const runId = /\[run\] runId (\S+)/.exec(output)?.[1];
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    const published = readFileSync(join(reports, 'probe/retrieval-report-mnemosyne.json'));
    expect(JSON.parse(published.toString('utf8'))).toMatchObject({ fresh: true });
    const summary = JSON.parse(readFileSync(join(reports, 'probe/run-summary.json'), 'utf8'));
    expect(summary.runId).toBe(runId);
    expect(summary.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(summary.inputFiles)).toContain('server.mjs');
    expect(summary.runs).toHaveLength(1);
    expect(summary.runs[0]).toMatchObject({ report: 'retrieval-report-mnemosyne.json', reportRunId: runId, reportSha256: createHash('sha256').update(published).digest('hex'), scores: { passed: 70, cases: 77 } });
    expect(readdirSync(reports)).toEqual(['probe']);
  });
});
