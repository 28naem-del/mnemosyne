import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BREAKTHROUGH_MOMENTS, runBreakthroughDemo, type BreakthroughDemoReport } from '../src/evaluation/breakthrough-demo.js';
import { generatePoisoningCases } from '../src/evaluation/poisoning/generator.js';
import { buildTimelinePlan, expectedVersionAt } from '../src/evaluation/breakthrough/corpus.js';

/**
 * The §11.7 WOW contract, as a gate: all five moments prove their numbers live,
 * none is pending, and the whole run is well inside the five-minute budget. The assertions read the structured details behind each PROOF
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
  it('registers five moments in order and proves every one of them', () => {
    expect(report.moments.map(entry => entry.id)).toEqual([1, 2, 3, 4, 5]);
    expect(BREAKTHROUGH_MOMENTS.map(entry => entry.id)).toEqual([1, 2, 3, 4, 5]);
    expect(BREAKTHROUGH_MOMENTS.every(entry => typeof entry.run === 'function' && entry.pendingNote === undefined)).toBe(true);
    for (const id of [1, 2, 3, 4, 5]) expect(moment(id).proof.passed, `moment ${id}: ${moment(id).lines.join('\n')}`).toBe(true);
    expect(report.passed).toBe(5);
    expect(report.total).toBe(5);
    expect(report.pending).toEqual([]);
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

  it('moment 2 repaired everything downstream, inferred edges included, and left the decoy alone', () => {
    const details = moment(2).details as { undeclared: number; undeclaredInvalidated: number; declared: number; declaredInvalidated: number; accepted: number; truePositives: number; stale: number; probes: number; liveBefore: number; decoySurvived: boolean; decoyProposed: boolean; receipts: number; published: { recall: string; precision: string; stale: string } | null };
    expect(details).toMatchObject({ undeclared: 3, undeclaredInvalidated: 3, declared: 2, declaredInvalidated: 2, accepted: 3, truePositives: 3, stale: 0, decoySurvived: true, decoyProposed: false, receipts: 3 });
    // The stale probes found every dependent before the correction, so the zero after it is not vacuous.
    expect(details.liveBefore).toBe(5);
    expect(details.probes).toBe(11);
    expect(details.published).toEqual({ recall: '96.05%', precision: '98.06%', stale: '0' });
    expect(moment(2).proof.measured).toBe('undeclared invalidated 3/3, accepted edges true 3/3, stale after correction 0 (11 probes)');
    const text = moment(2).lines.join('\n');
    expect(text).toMatch(/proposal: refunds \(never linked\) relies on the premise {3}support 3\/3 runs/);
    expect(text.match(/accepted: receipt [0-9a-f-]{36} /g)).toHaveLength(3);
    expect(text).toContain('skill retired: Linked premise was corrected or is no longer eligible.');
    expect(text).toMatch(/survived {5}key rotation \(decoy\)/);
    expect(text).toContain('recall 96.05%, precision 98.06%, stale 0');
  });

  it('moment 5 kept a dream that helped, rolled back the ones that did not, and undid the kept one exactly', () => {
    const details = moment(5).details as { replayTasks: number; kept: number; rolledBack: number; keptDelta: number; restored: boolean; chain: { ok: boolean; receipts: number; head: string }; passes: { verdict: string; reason: string; digest: string; prevDigest: string | null; delta: number | null; holdoutDelta: number | null }[] };
    expect(details.replayTasks).toBe(10);
    expect(details.passes.map(pass => pass.verdict)).toEqual(['rolled_back', 'kept', 'rolled_back']);
    expect(details.passes[0].reason).toMatch(/^regression:/);
    expect(details.passes[2].reason).toMatch(/^invariant violated: .*no-untrusted-to-policy/);
    expect(details.kept).toBe(1);
    expect(details.keptDelta).toBeGreaterThanOrEqual(0);
    expect(details.passes[1].holdoutDelta).toBeGreaterThanOrEqual(0);
    expect(details.rolledBack).toBe(2);
    expect(details.restored).toBe(true);
    // Three gate receipts plus the rollback receipt, chained by digest.
    expect(details.chain).toMatchObject({ ok: true, receipts: 4 });
    expect(details.passes[0].prevDigest).toBeNull();
    expect(details.passes[1].prevDigest).toBe(details.passes[0].digest);
    expect(details.passes[2].prevDigest).toBe(details.passes[1].digest);
    expect(moment(5).proof.measured).toBe(`kept 1 (delta +${details.keptDelta}), rolled back 2 (regression, invariant violated), rollback identical hash true, chain verified 4 receipts`);
    const text = moment(5).lines.join('\n');
    expect(text).toMatch(/identical: true; [1-9]\d* created record\(s\) removed/);
    expect(text.match(/signature verifies/g)).toHaveLength(3);
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
      expect(run.stdout.match(/^PROOF {2}.*\[PASS;/gm)).toHaveLength(5);
      expect(run.stdout).not.toMatch(/PENDING|FAIL;/);
      expect(run.stdout).toMatch(/5\/5 moments proved\. Total \d+\.\d s\./);
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      expect(saved).toMatchObject({ mode: 'recorded', passed: 5, total: 5, pending: [] });
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
