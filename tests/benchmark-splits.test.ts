import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adaptLoCoMoCorpus } from '../src/evaluation/corpus-benchmark.js';
import { matchedBenchmark } from '../src/evaluation/matched-benchmark.js';
import {
  allocate, filterSourceBySplit, loadSplit, makeLoCoMoSplit, makeLongMemEvalSplit, mulberry32, parseSplitName, populationOf,
  regenerateSplit, serializeSplit, SPLIT_SEED, type LoCoMoSplitFile, type LongMemEvalSplitFile,
} from '../src/evaluation/splits.js';

const SPLITS = join(__dirname, '..', 'benchmarks', 'splits');
const committedText = (name: string) => readFileSync(join(SPLITS, name), 'utf8');
const locomo = () => JSON.parse(committedText('locomo.json')) as LoCoMoSplitFile;
const lme = () => JSON.parse(committedText('longmemeval_s.json')) as LongMemEvalSplitFile;

describe('committed TUNE/HOLDOUT splits', () => {
  it('equal a regeneration from the population and seed recorded inside them, byte for byte', () => {
    expect(serializeSplit(regenerateSplit(locomo()))).toBe(committedText('locomo.json'));
    expect(serializeSplit(regenerateSplit(lme()))).toBe(committedText('longmemeval_s.json'));
  });

  it('use seed 20261029 and name the exact corpus bytes they were drawn from', () => {
    expect(SPLIT_SEED).toBe(20261029);
    expect(locomo().seed).toBe(SPLIT_SEED);
    expect(lme().seed).toBe(SPLIT_SEED);
    expect(locomo().source.sha256).toBe('79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4');
    expect(lme().source.sha256).toBe('d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442');
  });

  it('split LoCoMo by conversation: 4 tune, 6 holdout, disjoint, covering all 10 conversations', () => {
    const file = locomo();
    expect(file.population).toEqual(['conv-26', 'conv-30', 'conv-41', 'conv-42', 'conv-43', 'conv-44', 'conv-47', 'conv-48', 'conv-49', 'conv-50']);
    expect(file.tune).toHaveLength(4);
    expect(file.holdout).toHaveLength(6);
    expect(file.tune.filter(id => file.holdout.includes(id))).toEqual([]);
    expect([...file.tune, ...file.holdout].sort()).toEqual([...file.population].sort());
  });

  it('split LongMemEval-S by question, stratified by type: 150 tune, 350 holdout, disjoint, covering all 500 ids', () => {
    const file = lme();
    const population = populationOf(file);
    expect(population).toHaveLength(500);
    expect(new Set(population).size).toBe(500);
    expect(Object.fromEntries(Object.entries(file.strata).map(([type, ids]) => [type, ids.length]))).toEqual({
      'knowledge-update': 78, 'multi-session': 133, 'single-session-assistant': 56, 'single-session-preference': 30, 'single-session-user': 70, 'temporal-reasoning': 133 });
    expect(population.filter(id => id.endsWith('_abs'))).toHaveLength(30);
    expect(file.tune).toHaveLength(150);
    expect(file.holdout).toHaveLength(350);
    const holdout = new Set(file.holdout);
    expect(file.tune.filter(id => holdout.has(id))).toEqual([]);
    expect([...file.tune, ...file.holdout].sort()).toEqual([...population].sort());
    const quota = allocate(Object.fromEntries(Object.entries(file.strata).map(([type, ids]) => [type, ids.length])), 150);
    for (const [type, ids] of Object.entries(file.strata)) {
      expect(file.tune.filter(id => ids.includes(id))).toHaveLength(quota[type]);
      expect(file.sizes.tuneByType[type]).toBe(quota[type]);
    }
    expect(file.sizes.abstentionTune + file.sizes.abstentionHoldout).toBe(30);
  });
});

describe('split generation', () => {
  const source = { file: 'x.json', sha256: 'a'.repeat(64), bytes: 1 };
  const ids = Array.from({ length: 10 }, (_, index) => `c-${index}`);

  it('is deterministic for a seed and changes with the seed', () => {
    expect(makeLoCoMoSplit(ids, source)).toEqual(makeLoCoMoSplit(ids, source));
    const a = mulberry32(SPLIT_SEED), b = mulberry32(SPLIT_SEED);
    for (let index = 0; index < 100; index++) expect(a()).toBe(b());
    const seeds = new Set([1, 2, 3, 4, 5, 6].map(seed => makeLoCoMoSplit(ids, source, 4, seed).tune.join(',')));
    expect(seeds.size).toBeGreaterThan(1);
  });

  it('allocates tune slots by largest remainder and keeps both sides non-empty', () => {
    expect(allocate({ a: 133, b: 133, c: 78, d: 70, e: 56, f: 30 }, 150)).toEqual({ a: 40, b: 40, c: 23, d: 21, e: 17, f: 9 });
    expect(() => allocate({ a: 2 }, 2)).toThrow(/non-empty/);
    expect(() => makeLoCoMoSplit(['x', 'y'], source, 2)).toThrow(/non-empty/);
    expect(() => makeLoCoMoSplit(['x', 'x', 'y'], source, 1)).toThrow(/Duplicate/);
    const split = makeLongMemEvalSplit({ t1: ['q1', 'q2', 'q3', 'q4'], t2: ['q5', 'q6'] }, source, 3);
    expect(split.sizes.tuneByType).toEqual({ t1: 2, t2: 1 });
    expect([...split.tune, ...split.holdout].sort()).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6']);
  });
});

describe('--split filter', () => {
  const provenance = { dataset: 'locomo-fixture', revision: 'fixture-1', license: 'CC BY-NC 4.0' };
  const conversation = (id: string) => ({ sample_id: id,
    conversation: { session_1_date_time: '2023/05/07 (Sun) 14:30', session_1: [{ dia_id: 'D1:1', speaker: 'A', text: `turn of ${id}` }] },
    qa: [{ question: `question about ${id}`, answer: 'x', evidence: ['D1:1'], category: 1 }] });

  function writeSplit(tune: string[], holdout: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'mnemo-split-'));
    const path = join(dir, 'split.json');
    writeFileSync(path, JSON.stringify({ seed: SPLIT_SEED, source: { sha256: 'b'.repeat(64) }, tune, holdout }));
    return path;
  }

  it('keeps only the listed conversations, in source order, and only their questions reach the harness', () => {
    const path = writeSplit(['conv-b'], ['conv-a', 'conv-c']);
    try {
      const raw = [conversation('conv-a'), conversation('conv-b'), conversation('conv-c')];
      const holdout = filterSourceBySplit('locomo', raw, loadSplit(path, 'holdout'));
      expect(holdout.map(entry => entry.sample_id)).toEqual(['conv-a', 'conv-c']);
      const dataset = adaptLoCoMoCorpus(holdout, provenance);
      expect(dataset.questions.map(question => question.id)).toEqual(['conv-a:0', 'conv-c:0']);
      expect(filterSourceBySplit('locomo', raw, loadSplit(path, 'tune')).map(entry => entry.sample_id)).toEqual(['conv-b']);
    } finally { rmSync(join(path, '..'), { recursive: true, force: true }); }
  });

  it('filters LongMemEval by question_id and refuses a split naming ids the corpus lacks', () => {
    const path = writeSplit(['q2'], ['q1', 'q9']);
    try {
      const raw = [{ question_id: 'q1' }, { question_id: 'q2' }, { question_id: 'q3' }];
      expect(filterSourceBySplit('longmemeval', raw, loadSplit(path, 'tune'))).toEqual([{ question_id: 'q2' }]);
      expect(() => filterSourceBySplit('longmemeval', raw, loadSplit(path, 'holdout'))).toThrow(/does not match this corpus/);
    } finally { rmSync(join(path, '..'), { recursive: true, force: true }); }
  });

  it('accepts tune|holdout|all (default all) and rejects anything else before loading a model or corpus', async () => {
    expect(parseSplitName(undefined)).toBe('all');
    expect(parseSplitName('tune')).toBe('tune');
    expect(parseSplitName('holdout')).toBe('holdout');
    expect(() => parseSplitName('test')).toThrow(/--split must be tune, holdout or all/);
    await expect(matchedBenchmark(['--split', 'everything'])).rejects.toThrow(/--split must be tune, holdout or all/);
  });
});
