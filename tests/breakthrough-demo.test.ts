import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BREAKTHROUGH_MOMENTS, runBreakthroughDemo, type BreakthroughDemoReport } from '../src/evaluation/breakthrough-demo.js';
import { generatePoisoningCases } from '../src/evaluation/poisoning/generator.js';
import { buildTimelinePlan, expectedVersionAt } from '../src/evaluation/breakthrough/corpus.js';

/**
 * The §11.7 WOW contract, as a gate: moments 1, 3 and 4 prove their numbers live,
 * moments 2 and 5 are registered as pending, and the whole run is well inside the
 * five-minute budget. The assertions read the structured details behind each PROOF
 * line, so a moment that printed a plausible constant would fail here.
 */

const BUDGET = 300_000;
let report: BreakthroughDemoReport;
const streamed: string[] = [];
const moment = (id: number) => report.moments.find(entry => entry.id === id)!;

beforeAll(async () => {
  report = await runBreakthroughDemo({ out: line => streamed.push(line) });
}, BUDGET);

describe('breakthrough demo', () => {
  it('registers five moments in order and proves the three implemented ones', () => {
    expect(report.moments.map(entry => entry.id)).toEqual([1, 2, 3, 4, 5]);
    expect(BREAKTHROUGH_MOMENTS.map(entry => entry.id)).toEqual([1, 2, 3, 4, 5]);
    for (const id of [1, 3, 4]) expect(moment(id).proof.passed, `moment ${id}: ${moment(id).lines.join('\n')}`).toBe(true);
    for (const id of [2, 5]) {
      expect(moment(id).proof.passed).toBe('pending');
      expect(moment(id).proof.measured).toBe('pending');
    }
    expect(report.passed).toBe(3);
    expect(report.total).toBe(3);
    expect(report.pending).toHaveLength(2);
    expect(report.pending[0]).toMatch(/unit C/);
    expect(report.pending[1]).toMatch(/unit B/);
    expect(report.durationMs).toBeLessThan(BUDGET);
    expect(report.limitations.join(' ')).toMatch(/synthetic/);
  });

  it('streams every moment line and ends each moment with a PROOF line carrying the measured value', () => {
    for (const entry of report.moments) {
      const proof = entry.lines[entry.lines.length - 1];
      expect(proof).toMatch(/^PROOF {2}/);
      expect(proof).toContain(String(entry.proof.measured));
      expect(streamed).toContain(proof);
    }
    expect(streamed.join('\n')).toMatch(/Total \d+\.\d s\./);
  });

  it('moment 1 hashed every cut point in two readers and matched the plan, not a constant', () => {
    const details = moment(1).details as { cutPoints: number; identical: number; distinctStates: number; secondPass: string; groundTruth: { checked: number; matched: number }; headlineCorrect: boolean };
    expect(details.cutPoints).toBe(1000);
    expect(details.identical).toBe(1000);
    // dist/ is built by `pretest`, so the second reader is a real child process.
    expect(details.secondPass).toBe('separate process');
    // A store whose every cut point had the same state would pass trivially.
    expect(details.distinctStates).toBeGreaterThan(50);
    expect(details.groundTruth.matched).toBe(details.groundTruth.checked);
    expect(details.groundTruth.checked).toBe(1000 * buildTimelinePlan(20261028).facts.length);
    expect(details.headlineCorrect).toBe(true);
    expect(moment(1).proof.measured).toBe(`1000/1000 identical, ${details.groundTruth.checked}/${details.groundTruth.checked} as-of answers = ground truth`);
    expect(moment(1).lines.join('\n')).toContain('100 requests per second');
    expect(moment(1).lines.join('\n')).toContain('synthetic://orion/changes/CHG-2291');
  });

  it('moment 3 blamed exactly the seeded record in a 2000-record store within the time bar', () => {
    const details = moment(3).details as { records: number; precision: number; exact: boolean; seconds: number; outcome: string; exactConfirmed: boolean; universe: number };
    expect(details.records).toBeGreaterThanOrEqual(2000);
    expect(details.outcome).toBe('blamed');
    expect(details.precision).toBe(1);
    expect(details.exact).toBe(true);
    expect(details.exactConfirmed).toBe(true);
    expect(details.seconds).toBeLessThan(60);
    expect(details.universe).toBeGreaterThan(1);
  });

  it('moment 4 caught the scene and ran the real suite: as many cases as the generator makes', () => {
    const details = moment(4).details as { scene: boolean; suite: { cases: number; escapes: number; falseQuarantines: number; errors: number; gate: boolean; matchesGenerator: boolean } };
    expect(details.scene).toBe(true);
    expect(details.suite.cases).toBe(generatePoisoningCases().length);
    expect(details.suite.cases).toBe(227);
    expect(details.suite).toMatchObject({ escapes: 0, falseQuarantines: 0, errors: 0, gate: true, matchesGenerator: true });
    expect(moment(4).proof.measured).toBe(`${details.suite.cases} cases, ${details.suite.escapes} escapes, ${details.suite.falseQuarantines} false quarantines`);
    expect(moment(4).lines.join('\n')).toMatch(/quarantined by rule ancestry-disjoint-v1/);
  });

  it('ground truth comes from the plan: a late-learned version is invisible before it was known', () => {
    const plan = buildTimelinePlan(20261028);
    const fact = plan.facts.find(entry => entry.versions.some(version => version.knownFrom > version.validFrom))!;
    const late = fact.versions.find(version => version.knownFrom > version.validFrom)!;
    expect(expectedVersionAt(fact, late.validFrom, late.knownFrom - 1)?.text).not.toBe(late.text);
    expect(expectedVersionAt(fact, late.validFrom, late.knownFrom)?.text).toBe(late.text);
  });

  it('validates its options', async () => {
    await expect(runBreakthroughDemo({ records: 10 })).rejects.toThrow(/records must be an integer/);
    await expect(runBreakthroughDemo({ colour: true } as never)).rejects.toThrow(/Unknown breakthrough demo option field: colour/);
    await expect(runBreakthroughDemo({ cutPoints: 0 })).rejects.toThrow(/cutPoints/);
  });
});

describe('mnemosy demo (CLI)', () => {
  const cli = resolve('dist/cli/index.js');

  it('streams the breakthrough demo, records its report, and refuses to overwrite a record file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mnemosyne-breakthrough-cli-'));
    try {
      const file = join(directory, 'demo.json');
      const run = spawnSync(process.execPath, [cli, 'demo', '--record', file], { encoding: 'utf8', timeout: BUDGET });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toMatch(/\[1\/5\] It remembers/);
      expect(run.stdout.match(/^PROOF {2}.*\[PASS;/gm)).toHaveLength(3);
      expect(run.stdout.match(/^PROOF {2}.*\[PENDING;/gm)).toHaveLength(2);
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      expect(saved).toMatchObject({ mode: 'recorded', passed: 3, total: 3 });
      expect(saved.moments).toHaveLength(5);
      writeFileSync(join(directory, 'keep.json'), 'keep this');
      const refused = spawnSync(process.execPath, [cli, 'demo', '--record', join(directory, 'keep.json')], { encoding: 'utf8', timeout: 10_000 });
      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe('');
      expect(readFileSync(join(directory, 'keep.json'), 'utf8')).toBe('keep this');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, BUDGET);

  it('keeps the classic demo behind --classic', () => {
    const run = spawnSync(process.execPath, [cli, 'demo', '--classic'], { encoding: 'utf8', timeout: 30_000 });
    expect(run.status, run.stderr).toBe(0);
    const classic = JSON.parse(run.stdout);
    expect(classic.steps).toHaveLength(6);
    expect(classic.checksPassed).toBe(classic.checksTotal);
  });
});
