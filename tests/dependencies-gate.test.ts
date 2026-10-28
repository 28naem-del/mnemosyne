import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEPENDENCY_CORPUS_SEED, corpusSha256, generateDependencyCorpus, serializeDependencyCorpus } from '../src/evaluation/dependencies/generator.js';
import { DEPENDENCY_GATE, DEPENDENCY_TUNING_SEEDS, parseDependencyCorpus, runDependencyCorpus } from '../src/evaluation/dependencies/runner.js';

/**
 * Dependency inference suite v1 (synthetic), as a gate: invalidation recall of
 * true undeclared dependents >= 90 %, precision of accepted inferred edges
 * >= 95 %, and zero stale procedures or skills handed out by the guarded
 * executor after any premise correction, on the checked-in corpus, which must
 * be byte-identical to what the seeded generator produces. Offline, lexical,
 * model-free and deterministic. One run replays 717 tasks and 120 corrections,
 * so it gets a long timeout.
 */

const root = join(import.meta.dirname, '..');
const corpusPath = join(root, 'benchmarks/dependencies/v1/corpus.json');

describe('dependency inference suite v1', () => {
  const text = readFileSync(corpusPath, 'utf8');
  const corpus = parseDependencyCorpus(text);

  it('regenerates the checked-in corpus byte for byte, and its sha256 is the documented one', () => {
    expect(serializeDependencyCorpus(generateDependencyCorpus())).toBe(text);
    expect(corpus).toMatchObject({ suite: 'dependencies-v1', synthetic: true, seed: DEPENDENCY_CORPUS_SEED });
    expect(DEPENDENCY_TUNING_SEEDS).not.toContain(DEPENDENCY_CORPUS_SEED);
    const sha = corpusSha256(text);
    expect(readFileSync(join(root, 'benchmarks/dependencies/README.md'), 'utf8')).toContain(sha);
    expect(readFileSync(join(root, 'reports/dependencies/v1/report.json'), 'utf8')).toContain(sha);
  });

  it('has at least 200 records, true undeclared edges and every decoy class', () => {
    expect(corpus.premises.length + corpus.dependents.length).toBeGreaterThanOrEqual(200);
    expect(corpus.dependents.some(item => item.type === 'skill')).toBe(true);
    expect(corpus.truth.length).toBeGreaterThan(100);
    expect(new Set(corpus.decoys.map(item => item.class))).toEqual(new Set(['retrieved-unused', 'failed-only', 'sibling', 'incidental', 'hub']));
    // No true edge is also declared: truth is what inference has to find.
    const declared = new Map(corpus.dependents.map(item => [item.key, new Set(item.declared)]));
    expect(corpus.truth.filter(edge => declared.get(edge.dependent)!.has(edge.premise))).toEqual([]);
  });

  it('meets recall >= 90 %, precision >= 95 % and zero stale executions', async () => {
    const result = await runDependencyCorpus(corpus);
    const { metrics } = result;
    expect(metrics.recall).toBeGreaterThanOrEqual(DEPENDENCY_GATE.recall);
    expect(metrics.precision).toBeGreaterThanOrEqual(DEPENDENCY_GATE.precision);
    expect(metrics.staleExecutions).toBe(DEPENDENCY_GATE.staleExecutions);
    expect(result.escapes).toEqual([]);
    // The kernel alone never runs a dependent whose premise is declared or accepted.
    expect(metrics.kernelStaleOnLinked).toBe(0);
    expect(metrics.corrections).toBe(corpus.premises.length);
    // The committed report is this run.
    const report = JSON.parse(readFileSync(join(root, 'reports/dependencies/v1/report.json'), 'utf8'));
    expect(report.result.metrics).toEqual(metrics);
    expect(report.gate.passed).toBe(true);
  }, 600_000);
});
