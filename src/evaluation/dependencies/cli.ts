/**
 * `node dist/evaluation/dependencies/cli.js --corpus benchmarks/dependencies/v1/corpus.json --out reports/dependencies/v1 --seeds 1,2,3,4,5`
 *
 * Offline: lexical retrieval, no network, no model, no API key. Writes
 * `report.json` and `report.md` into `--out` and exits non-zero when the gate
 * fails. `--seeds` adds a robustness table over other seeds (not gated), each labelled tuning or held-out.
 * `--write-corpus PATH` regenerates the committed corpus from the fixed seed.
 * `--seed N` alone runs a generated corpus for seed N and prints its metrics,
 * which is how thresholds are tuned without touching the gate seed.
 * `--rare-runs N` (with `--seed`) reruns that corpus with N runs per rare
 * procedure; `--rare-runs 1` is the harder variant docs/DEPENDENCIES.md reports.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEPENDENCY_CORPUS_SEED, corpusSha256, generateDependencyCorpus, serializeDependencyCorpus } from './generator.js';
import { buildDependencyReport, parseDependencyCorpus, renderDependencyReport, runDependencyCorpus } from './runner.js';

const USAGE = [
  'Usage: node dist/evaluation/dependencies/cli.js --corpus <corpus.json> --out <directory> [--seeds 1,2,3]',
  '       node dist/evaluation/dependencies/cli.js --write-corpus <corpus.json>',
  '       node dist/evaluation/dependencies/cli.js --seed <n> [--rare-runs <n>]',
].join('\n');

function seeds(value: string | undefined): number[] {
  if (value === undefined) return [];
  const list = value.split(',').map(item => Number(item.trim()));
  if (!list.length || list.some(seed => !Number.isSafeInteger(seed) || seed < 0)) throw new Error('--seeds must be a comma-separated list of non-negative integers');
  if (list.includes(DEPENDENCY_CORPUS_SEED)) throw new Error('--seeds are robustness seeds and must not include the gate seed');
  return list;
}

export async function dependenciesEvalCli(args = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    corpus: { type: 'string' }, out: { type: 'string' }, 'write-corpus': { type: 'string' }, seeds: { type: 'string' }, seed: { type: 'string' }, 'rare-runs': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(USAGE); return 0; }
  const generated = serializeDependencyCorpus(generateDependencyCorpus());
  if (values['write-corpus']) {
    const path = resolve(values['write-corpus']);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, generated);
    console.log(JSON.stringify({ file: path, seed: DEPENDENCY_CORPUS_SEED, sha256: corpusSha256(generated) }));
    return 0;
  }
  if (values.seed !== undefined) {
    const [seed] = seeds(values.seed);
    const rareRuns = values['rare-runs'] === undefined ? undefined : Number(values['rare-runs']);
    if (rareRuns !== undefined && (!Number.isSafeInteger(rareRuns) || rareRuns < 1 || rareRuns > 8)) throw new Error('--rare-runs must be an integer from 1 to 8');
    const started = Date.now();
    const result = await runDependencyCorpus(generateDependencyCorpus(seed, rareRuns === undefined ? {} : { rareRuns }));
    console.log(JSON.stringify({ seed, ...(rareRuns === undefined ? {} : { rareRuns }), metrics: result.metrics, misses: result.misses, falseEdges: result.falseEdges, seconds: (Date.now() - started) / 1000 }));
    return 0;
  }
  if (values['rare-runs'] !== undefined) throw new Error('--rare-runs applies to --seed runs only');
  if (!values.corpus || !values.out) { console.error(USAGE); return 2; }
  const text = readFileSync(resolve(values.corpus), 'utf8');
  const corpus = parseDependencyCorpus(text);
  const started = Date.now();
  const report = await buildDependencyReport(corpus, text, { matchesGenerator: text === generated, robustnessSeeds: seeds(values.seeds) });
  const seconds = (Date.now() - started) / 1000;
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const command = `node dist/evaluation/dependencies/cli.js --corpus ${values.corpus} --out ${values.out}${values.seeds ? ` --seeds ${values.seeds}` : ''}`;
  writeFileSync(join(out, 'report.json'), `${JSON.stringify({ command, ...report }, null, 2)}\n`);
  writeFileSync(join(out, 'report.md'), `${renderDependencyReport(report, command)}\n`);
  console.log(JSON.stringify({ out, gate: report.gate, corpus: { sha256: report.corpus.sha256, records: report.corpus.records, tasks: report.corpus.tasks }, seconds }));
  return report.gate.passed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  dependenciesEvalCli().then((code) => { process.exitCode = code; }, (error: unknown) => { console.error(`Dependency eval failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
