import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runLearningDemo } from '../src/evaluation/learning-demo.js';
import { MemoryRuntime } from '../src/runtime/index.js';

const temporaryRuns = () => readdirSync(tmpdir()).filter(name => name.startsWith(`mnemosyne-learning-demo-${process.pid}-`)).sort();
afterEach(() => vi.restoreAllMocks());

describe('deterministic integrated learning demonstration', () => {
  it('executes the source-to-skill-to-peer lifecycle and cleans up its isolated store', async () => {
    const before = temporaryRuns(); const report = await runLearningDemo();
    expect(report.steps.filter(step => !step.passed)).toEqual([]);
    expect(report).toMatchObject({ kind: 'deterministic integration demonstration', passed: true, checksPassed: 13, checksTotal: 13, modelCalls: 0, externalModelCalls: 0, scriptedProposerCalls: 1, trialCasesPassed: 2 });
    expect(report.steps.map(step => step.id)).toEqual(['empty', 'capture', 'observe', 'candidate', 'trial', 'share', 'peer', 'isolation', 'retire', 'peer-retire', 'inspect', 'forget', 'restart']);
    expect(report.limitations.join(' ')).toContain('no LLM was invoked or trained');
    expect(temporaryRuns()).toEqual(before);
  });

  it('repeats with identical fixture outcomes and fresh database identities', async () => {
    const first = await runLearningDemo(); const second = await runLearningDemo();
    expect(first.passed).toBe(true); expect(second).toEqual(first);
  });

  it('reports failed promotion and unrun downstream checks instead of claiming success', async () => {
    const before = temporaryRuns();
    vi.spyOn(MemoryRuntime.prototype, 'trialSkill').mockImplementation(async function (this: MemoryRuntime, input) { return this.getSkill(input.id)!; });
    const report = await runLearningDemo();
    expect(report.passed).toBe(false); expect(report.checksPassed).toBe(4); expect(report.steps.find(step => step.id === 'trial')).toMatchObject({ passed: false, status: 'failed' });
    expect(report.steps.find(step => step.id === 'share')?.status).toBe('not-run'); expect(temporaryRuns()).toEqual(before);
  });
});
