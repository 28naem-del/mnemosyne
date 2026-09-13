import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalMemory } from '../src/local/index.js';
import { runEvidenceBenchmark } from '../src/evaluation/evidence-benchmark.js';

afterEach(() => vi.restoreAllMocks());
describe('evidence lifecycle measurement', () => {
  it('retains unresolved facts without counting them as retirement and discloses conservative over-retirement', () => {
    const report = runEvidenceBenchmark();
    const conflict = report.probes.find(row => row.scenario === 'unresolved-conflict-visible' && row.condition === 'compiled-context')!;
    expect(conflict).toMatchObject({ status: 'pass', wronglyRetired: 0, expectedEligible: 0, retainedValid: 2, conflictSurfaced: true });
    const precision = report.probes.find(row => row.scenario === 'unrelated-field-edit-retention' && row.condition === 'compiled-context')!;
    expect(precision).toMatchObject({ status: 'fail', wronglyRetired: 1, expectedValid: 2, retainedValid: 1 });
    expect(report.summary['compiled-context']).toMatchObject({ probes: 16, passed: 15, errors: 0, exposedObsolete: 0 });
    expect(report.unsupported[0].scenario).toBe('alternative-independent-support');
    expect(report.harnessSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('detects corruption in the actual rendered model context', () => {
    const original = LocalMemory.prototype.compile;
    vi.spyOn(LocalMemory.prototype, 'compile').mockImplementation(function (this: LocalMemory, input) {
      const packet = original.call(this, input);
      if (packet.text && packet.items.length) {
        const rendered = JSON.parse(packet.text); rendered.memories[0].text = 'Tampered model-visible text'; packet.text = JSON.stringify(rendered);
      }
      return packet;
    });
    const report = runEvidenceBenchmark();
    expect(report.probes.filter(row => row.condition === 'compiled-context' && row.returned > 0).every(row => row.status === 'fail' && row.integrityFailures > 0)).toBe(true);
  });
  it('does not call absent citations perfectly valid', () => {
    const original = LocalMemory.prototype.compile;
    vi.spyOn(LocalMemory.prototype, 'compile').mockImplementation(function (this: LocalMemory, input) {
      return { ...original.call(this, input), citations: [] };
    });
    const report = runEvidenceBenchmark();
    expect(report.summary['compiled-context'].citationIdentityPrecision).toBeNull();
    expect(report.probes.filter(row => row.condition === 'compiled-context' && row.returned > 0).every(row => row.status === 'fail')).toBe(true);
  });
  it('keeps failures in completion counts and makes unknown precision rates unavailable', () => {
    vi.spyOn(LocalMemory.prototype, 'compile').mockImplementationOnce(() => { throw new Error('Injected renderer failure'); });
    const report = runEvidenceBenchmark();
    expect(report.summary['compiled-context']).toMatchObject({ probes: 16, errors: 1, falseRetirementRate: null, citationIdentityPrecision: null });
    expect(report.probes[1]).toMatchObject({ status: 'error', expectedValid: 2, retainedValid: 0 });
  });
  it('rejects citation identity claims with a substituted source URI', () => {
    const original = LocalMemory.prototype.compile;
    vi.spyOn(LocalMemory.prototype, 'compile').mockImplementation(function (this: LocalMemory, input) {
      const packet = original.call(this, input);
      return { ...packet, citations: packet.citations.map(citation => ({ ...citation, uri: 'fixture:wrong-source' })) };
    });
    const report = runEvidenceBenchmark();
    expect(report.summary['compiled-context'].citationIdentityPrecision).toBe(0);
    expect(report.probes.filter(row => row.condition === 'compiled-context' && row.returned > 0)
      .every(row => row.status === 'fail' && row.validCitationIds === 0 && row.integrityFailures > 0)).toBe(true);
  });
  it('checks direct historical erasure and both private-agent and workspace boundaries', () => {
    const report = runEvidenceBenchmark();
    expect(report.probes.filter(row => /erasure|scope-isolation/.test(row.scenario)).every(row => row.status === 'pass')).toBe(true);
  });
});
