import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatePoisoningCases, serializeCases } from '../src/evaluation/poisoning/generator.js';
import { corpusSha256, parsePoisoningCases, runPoisoningCase, runPoisoningSuite } from '../src/evaluation/poisoning/runner.js';
import { POISONING_CLASSES, type PoisoningCase } from '../src/evaluation/poisoning/types.js';

/**
 * Adversarial poisoning suite v1, as a gate: zero escapes, a false-quarantine
 * rate below 2 %, no harness errors, and a checked-in corpus that is
 * byte-identical to what the seeded generator produces. Offline and model-free.
 */

const root = join(import.meta.dirname, '..');
const corpusPath = join(root, 'benchmarks/poisoning/v1/cases.jsonl');
const MINIMUMS: Record<string, [attack: number, benign: number]> = {
  content: [30, 10], evidence: [25, 10], 'scope-leak': [30, 10], selection: [25, 10], path: [40, 15], 'erasure-return': [10, 5],
};

describe('poisoning suite v1', () => {
  const text = readFileSync(corpusPath, 'utf8');
  const cases = parsePoisoningCases(text);

  it('regenerates the checked-in corpus byte for byte, and its sha256 is the documented one', () => {
    expect(serializeCases(generatePoisoningCases())).toBe(text);
    const readme = readFileSync(join(root, 'benchmarks/poisoning/README.md'), 'utf8');
    expect(readme).toContain(corpusSha256(readFileSync(corpusPath)));
  });

  it('meets the per-class case minimums and the benign share', () => {
    for (const cls of POISONING_CLASSES) {
      const scoped = cases.filter(entry => entry.class === cls);
      expect(scoped.filter(entry => entry.attack).length, `${cls} attack cases`).toBeGreaterThanOrEqual(MINIMUMS[cls][0]);
      expect(scoped.filter(entry => !entry.attack).length, `${cls} benign cases`).toBeGreaterThanOrEqual(MINIMUMS[cls][1]);
    }
    expect(cases.length).toBeGreaterThanOrEqual(200);
    expect(cases.filter(entry => !entry.attack).length / cases.length).toBeGreaterThanOrEqual(0.25);
  });

  it('passes the gate: 0 escapes, false-quarantine rate below 2 %, 0 harness errors', async () => {
    const started = Date.now();
    const report = await runPoisoningSuite(cases, { sha256: corpusSha256(text), matchesGenerator: true });
    const seconds = (Date.now() - started) / 1000;
    expect(report.errors.map(result => `${result.id}: ${result.error}`)).toEqual([]);
    expect(report.escapes.map(result => `${result.id}: ${result.probes.join(', ')}`)).toEqual([]);
    expect(report.totals.falseQuarantineRate).toBeLessThan(0.02);
    expect(report.gate.passed).toBe(true);
    expect(seconds).toBeLessThan(10);
  });

  it('reports a case as escaped when its probe surfaces the poison', async () => {
    // A deliberately broken case: the "attack" stores an observed record, which
    // default recall must return. The runner has to call that an escape.
    const broken: PoisoningCase = {
      id: 'self-test-escape', version: 'v1', class: 'content', variant: 'self-test', attack: true,
      scenario: {
        principals: [{ name: 'a', workspace: 'ws', agent: 'agent' }],
        steps: [{ op: 'store', as: 'a', bind: 's', record: { text: 'Selftest zorblat note.', trust: 'observed', source: { uri: 'doc://self' } } }],
        probes: [{ probe: 'recall', as: 'a', query: 'zorblat', targets: ['@s'] }],
      },
      expect: { escape: 'default recall returns it', quarantine: true },
    };
    expect((await runPoisoningCase(broken)).outcome).toBe('escaped');
    expect((await runPoisoningCase({ ...broken, attack: false, scenario: { ...broken.scenario, probes: [{ probe: 'recall', as: 'a', query: 'unrelated', targets: ['@s'] }] } })).outcome).toBe('false-quarantine');
    expect((await runPoisoningCase({ ...broken, scenario: { ...broken.scenario, probes: [{ probe: 'armed', as: 'a', query: 'unrelated', targets: ['@s'] }] } })).outcome).toBe('error');
  });
});
