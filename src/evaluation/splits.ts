import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * TUNE / HOLDOUT splits for the matched retrieval benchmark.
 *
 * A configuration is chosen on TUNE and frozen before HOLDOUT is read, so the
 * split itself has to be fixed in advance and impossible to re-draw quietly. It
 * is therefore written down as explicit id lists in `benchmarks/splits/*.json`,
 * produced by `make-splits` from a fixed seed, and a test asserts the committed
 * files equal a regeneration from the population recorded inside them.
 *
 * - LoCoMo is split by conversation (`sample_id`), so no conversation's turns
 *   are ever scored on both sides.
 * - LongMemEval-S is split by `question_id`, stratified by `question_type`, so
 *   each side keeps the benchmark's category mix. The `_abs` (unanswerable)
 *   questions are split like any other and stay out of positive metrics, as in
 *   an unsplit run.
 */

export const SPLIT_SEED = 20261029;
export const SPLIT_ALGORITHM = 'mulberry32(seed) Fisher-Yates shuffle; first n of the shuffled population = tune, rest = holdout; lists re-sorted to source order';
export type SplitName = 'tune' | 'holdout' | 'all';
export const SPLIT_NAMES: readonly SplitName[] = ['tune', 'holdout', 'all'];
export type SplitCorpus = 'locomo' | 'longmemeval';
export const SPLIT_FILES: Record<SplitCorpus, string> = { locomo: 'locomo.json', longmemeval: 'longmemeval_s.json' };

export interface SplitSource { file: string; sha256: string; bytes: number }
export interface LoCoMoSplitFile {
  corpus: 'locomo10'; unit: 'sample_id'; seed: number; algorithm: string; source: SplitSource;
  population: string[]; sizes: { population: number; tune: number; holdout: number };
  tune: string[]; holdout: string[];
}
export interface LongMemEvalSplitFile {
  corpus: 'longmemeval_s_cleaned'; unit: 'question_id'; stratifiedBy: 'question_type'; seed: number; algorithm: string; allocation: string; source: SplitSource;
  /** Every question id per type, in source order — the population the split was drawn from. */
  strata: Record<string, string[]>;
  sizes: { population: number; tune: number; holdout: number; tuneByType: Record<string, number>; holdoutByType: Record<string, number>; abstentionTune: number; abstentionHoldout: number };
  tune: string[]; holdout: string[];
}
export type SplitFile = LoCoMoSplitFile | LongMemEvalSplitFile;

/** Small, well-known 32-bit PRNG; deterministic across Node versions and platforms. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function inSourceOrder(chosen: Iterable<string>, population: readonly string[]): string[] {
  const set = new Set(chosen);
  return population.filter(id => set.has(id));
}

function assertUnique(ids: readonly string[], what: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${what} in split population.`);
}

export function makeLoCoMoSplit(population: readonly string[], source: SplitSource, tuneSize = 4, seed = SPLIT_SEED): LoCoMoSplitFile {
  assertUnique(population, 'sample_id');
  if (!Number.isSafeInteger(tuneSize) || tuneSize < 1 || tuneSize >= population.length) throw new Error('LoCoMo tune size must leave both sides non-empty.');
  const shuffled = seededShuffle(population, mulberry32(seed));
  const tune = inSourceOrder(shuffled.slice(0, tuneSize), population);
  const holdout = inSourceOrder(shuffled.slice(tuneSize), population);
  return { corpus: 'locomo10', unit: 'sample_id', seed, algorithm: SPLIT_ALGORITHM, source, population: [...population],
    sizes: { population: population.length, tune: tune.length, holdout: holdout.length }, tune, holdout };
}

/**
 * Largest-remainder allocation of `total` tune slots across strata in
 * proportion to their size; ties broken by type name, so it is reproducible.
 */
export function allocate(sizes: Record<string, number>, total: number): Record<string, number> {
  const types = Object.keys(sizes).sort();
  const population = types.reduce((sum, type) => sum + sizes[type], 0);
  if (!Number.isSafeInteger(total) || total < 1 || total >= population) throw new Error('Tune size must leave both sides non-empty.');
  const out: Record<string, number> = {};
  for (const type of types) out[type] = Math.floor(sizes[type] * total / population);
  let left = total - types.reduce((sum, type) => sum + out[type], 0);
  const order = [...types].sort((a, b) => ((sizes[b] * total) % population) - ((sizes[a] * total) % population) || (a < b ? -1 : a > b ? 1 : 0));
  for (const type of order) { if (left <= 0) break; out[type]++; left--; }
  return out;
}

export function makeLongMemEvalSplit(strata: Record<string, string[]>, source: SplitSource, tuneSize = 150, seed = SPLIT_SEED): LongMemEvalSplitFile {
  const types = Object.keys(strata).sort();
  const all = types.flatMap(type => strata[type]);
  assertUnique(all, 'question_id');
  const quota = allocate(Object.fromEntries(types.map(type => [type, strata[type].length])), tuneSize);
  // One generator, consumed stratum by stratum in sorted type order.
  const random = mulberry32(seed);
  const tuneSet = new Set<string>(), tuneByType: Record<string, number> = {}, holdoutByType: Record<string, number> = {};
  for (const type of types) {
    const picked = seededShuffle(strata[type], random).slice(0, quota[type]);
    for (const id of picked) tuneSet.add(id);
    tuneByType[type] = picked.length;
    holdoutByType[type] = strata[type].length - picked.length;
  }
  const ordered = types.flatMap(type => strata[type]);
  const tune = ordered.filter(id => tuneSet.has(id)), holdout = ordered.filter(id => !tuneSet.has(id));
  const abs = (ids: string[]) => ids.filter(id => id.endsWith('_abs')).length;
  return { corpus: 'longmemeval_s_cleaned', unit: 'question_id', stratifiedBy: 'question_type', seed, algorithm: SPLIT_ALGORITHM,
    allocation: 'largest remainder of tuneSize * |type| / |population|, ties by type name; one generator consumed per type in type-name order',
    source, strata: Object.fromEntries(types.map(type => [type, [...strata[type]]])),
    sizes: { population: all.length, tune: tune.length, holdout: holdout.length, tuneByType, holdoutByType, abstentionTune: abs(tune), abstentionHoldout: abs(holdout) },
    tune, holdout };
}

/** Rebuilds a split from the population recorded inside it — what the drift test compares against. */
export function regenerateSplit(file: SplitFile): SplitFile {
  return file.unit === 'sample_id'
    ? makeLoCoMoSplit(file.population, file.source, file.sizes.tune, file.seed)
    : makeLongMemEvalSplit(file.strata, file.source, file.sizes.tune, file.seed);
}

export function populationOf(file: SplitFile): string[] {
  return file.unit === 'sample_id' ? [...file.population] : Object.keys(file.strata).sort().flatMap(type => file.strata[type]);
}

export function serializeSplit(file: SplitFile): string { return `${JSON.stringify(file, null, 2)}\n`; }

export function parseSplitName(value: string | undefined): SplitName {
  const name = value ?? 'all';
  if (!(SPLIT_NAMES as readonly string[]).includes(name)) throw new Error('--split must be tune, holdout or all');
  return name as SplitName;
}

export interface LoadedSplit { name: Exclude<SplitName, 'all'>; file: string; sha256: string; seed: number; ids: Set<string>; sourceSha256: string }

export function loadSplit(path: string, name: Exclude<SplitName, 'all'>): LoadedSplit {
  const raw = readFileSync(path);
  const parsed = JSON.parse(raw.toString('utf8')) as SplitFile;
  const ids = name === 'tune' ? parsed.tune : parsed.holdout;
  if (!Array.isArray(ids) || !ids.length) throw new Error(`Split file ${path} has no ${name} ids.`);
  return { name, file: path, sha256: createHash('sha256').update(raw).digest('hex'), seed: parsed.seed, ids: new Set(ids), sourceSha256: parsed.source.sha256 };
}

/**
 * Keeps only the raw source entries named by the split, in source order. Every
 * listed id must be present, so a split file can never silently select fewer
 * questions than it says it does.
 */
export function filterSourceBySplit<T>(kind: SplitCorpus, entries: readonly T[], split: LoadedSplit): T[] {
  const key = (entry: T): string => {
    const record = entry as Record<string, unknown>;
    const value = kind === 'locomo' ? record.sample_id : record.question_id;
    if (typeof value !== 'string') throw new Error(`Split filter: source entry without a string ${kind === 'locomo' ? 'sample_id' : 'question_id'}.`);
    return value;
  };
  const kept = entries.filter(entry => split.ids.has(key(entry)));
  const found = new Set(kept.map(key));
  if (found.size !== split.ids.size) throw new Error(`Split ${split.name} lists ${split.ids.size} ids but the corpus contains ${found.size} of them; the split file does not match this corpus.`);
  return kept;
}
