/**
 * `node dist/evaluation/poisoning/cli.js --cases benchmarks/poisoning/v1/cases.jsonl --out reports/poisoning/v1`
 *
 * Offline: lexical retrieval, no network, no model, no API key. Writes
 * `report.json` and `report.md` into `--out` and exits non-zero when the gate
 * fails. `--write-cases PATH` regenerates the corpus from the seed instead.
 * `--consolidation` runs the suite in consolidation mode and also writes
 * `rejected-passes.jsonl`: every pass the gate rolled back, with its receipt.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { generatePoisoningCases, serializeCases } from './generator.js';
import { corpusSha256, parsePoisoningCases, renderPoisoningReport, runPoisoningSuite } from './runner.js';
import type { PoisoningConsolidationReceipt } from './types.js';

const USAGE = 'Usage: node dist/evaluation/poisoning/cli.js --cases <cases.jsonl> --out <directory> [--consolidation [--ungated-control]]\n       node dist/evaluation/poisoning/cli.js --write-cases <cases.jsonl>';

/** One rejected-passes line: the decision's numbers up front, the full receipt for verification. */
export function rejectedPassLine(source: string, item: PoisoningConsolidationReceipt): string {
  const { receipt } = item;
  return JSON.stringify({
    source, caseId: item.caseId, attack: item.attack, principal: item.principal, label: item.label,
    passId: receipt.passId, verdict: receipt.verdict, reason: receipt.reason,
    delta: receipt.scores?.delta ?? null, holdoutDelta: receipt.scores?.holdout?.delta ?? null, perProposal: receipt.scores?.perProposal ?? [],
    failedInvariants: receipt.invariants.filter((invariant) => !invariant.ok).map((invariant) => invariant.name),
    digest: receipt.digest, prevDigest: receipt.prevDigest, receipt,
  });
}

export async function poisoningCli(args = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    cases: { type: 'string' }, out: { type: 'string' }, 'write-cases': { type: 'string' }, consolidation: { type: 'boolean' }, 'ungated-control': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(USAGE); return 0; }
  const generated = serializeCases(generatePoisoningCases());
  if (values['write-cases']) {
    const path = resolve(values['write-cases']);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, generated);
    console.log(JSON.stringify({ file: path, cases: generated.split('\n').filter(Boolean).length, sha256: corpusSha256(generated) }));
    return 0;
  }
  if (!values.cases || !values.out || (values['ungated-control'] && !values.consolidation)) { console.error(USAGE); return 2; }
  const text = readFileSync(resolve(values.cases), 'utf8');
  const cases = parsePoisoningCases(text);
  const started = Date.now();
  const rejected: string[] = [];
  const report = await runPoisoningSuite(cases, { sha256: corpusSha256(text), matchesGenerator: text === generated }, values.consolidation
    ? { consolidation: true, ...(values['ungated-control'] ? { ungatedControl: true } : {}), onReceipt: (item) => { if (item.receipt.verdict === 'rolled_back') rejected.push(rejectedPassLine('poisoning-suite-v1-consolidation', item)); } }
    : {});
  const seconds = (Date.now() - started) / 1000;
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const command = `node dist/evaluation/poisoning/cli.js --cases ${values.cases} --out ${values.out}${values.consolidation ? ' --consolidation' : ''}${values['ungated-control'] ? ' --ungated-control' : ''}`;
  // The control applies refused passes anyway, so it has no rejected passes to publish.
  if (values.consolidation && !values['ungated-control']) writeFileSync(join(out, 'rejected-passes.jsonl'), rejected.map((line) => `${line}\n`).join(''));
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(out, 'report.md'), `${renderPoisoningReport(report, command)}\n`);
  console.log(JSON.stringify({ out, gate: report.gate.passed, corpus: report.corpus, totals: report.totals, ...(report.consolidation ? { consolidation: report.consolidation, rejectedPasses: rejected.length } : {}), seconds }));
  return report.gate.passed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  poisoningCli().then((code) => { process.exitCode = code; }, (error: unknown) => { console.error(`Poisoning suite failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
