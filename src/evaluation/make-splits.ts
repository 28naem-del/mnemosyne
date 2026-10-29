import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { makeLoCoMoSplit, makeLongMemEvalSplit, serializeSplit, SPLIT_FILES, type SplitFile } from './splits.js';

/**
 * Writes `benchmarks/splits/locomo.json` and `benchmarks/splits/longmemeval_s.json`
 * from the corpora in `benchmarks/data` (or `--data DIR`). Deterministic: the
 * same corpus bytes always produce the same files. `--check` regenerates and
 * fails if the committed files differ instead of writing them.
 *
 *   node dist/evaluation/make-splits.js [--data DIR] [--out DIR] [--check]
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

function read(file: string): { parsed: unknown; sha256: string; bytes: number } {
  const raw = readFileSync(file);
  return { parsed: JSON.parse(raw.toString('utf8')) as unknown, sha256: createHash('sha256').update(raw).digest('hex'), bytes: raw.byteLength };
}

export function buildSplits(dataDir: string): Record<'locomo' | 'longmemeval', SplitFile> {
  const locomo = read(join(dataDir, 'locomo10.json'));
  if (!Array.isArray(locomo.parsed)) throw new Error('locomo10.json is not an array.');
  const conversations = locomo.parsed.map(entry => {
    const id = (entry as Record<string, unknown>).sample_id;
    if (typeof id !== 'string') throw new Error('LoCoMo entry without a string sample_id.');
    return id;
  });
  const lme = read(join(dataDir, 'longmemeval_s_cleaned.json'));
  if (!Array.isArray(lme.parsed)) throw new Error('longmemeval_s_cleaned.json is not an array.');
  const strata: Record<string, string[]> = {};
  for (const entry of lme.parsed) {
    const { question_id: id, question_type: type } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || typeof type !== 'string') throw new Error('LongMemEval entry without string question_id/question_type.');
    (strata[type] ??= []).push(id);
  }
  return {
    locomo: makeLoCoMoSplit(conversations, { file: 'locomo10.json', sha256: locomo.sha256, bytes: locomo.bytes }),
    longmemeval: makeLongMemEvalSplit(strata, { file: 'longmemeval_s_cleaned.json', sha256: lme.sha256, bytes: lme.bytes }),
  };
}

export function makeSplits(args = process.argv.slice(2)): number {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { data: { type: 'string' }, out: { type: 'string' }, check: { type: 'boolean' } } });
  const dataDir = resolve(values.data ?? join(REPO, 'benchmarks', 'data'));
  const outDir = resolve(values.out ?? join(REPO, 'benchmarks', 'splits'));
  const splits = buildSplits(dataDir);
  let drift = 0;
  for (const kind of ['locomo', 'longmemeval'] as const) {
    const target = join(outDir, SPLIT_FILES[kind]), text = serializeSplit(splits[kind]);
    const { sizes } = splits[kind];
    if (values.check) {
      const same = existsSync(target) && readFileSync(target, 'utf8') === text;
      console.log(`${same ? 'ok   ' : 'DRIFT'} ${target} (tune ${sizes.tune}, holdout ${sizes.holdout})`);
      if (!same) drift++;
    } else {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(target, text);
      console.log(`wrote ${target} (population ${sizes.population}, tune ${sizes.tune}, holdout ${sizes.holdout})`);
    }
  }
  return drift ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = makeSplits(); }
  catch (error) { console.error(error instanceof Error ? error.message : 'make-splits failed.'); process.exitCode = 1; }
}
