/**
 * Publishes every pass the gate rolled back, in the offline demo and in the
 * poisoning suite's consolidation mode, as one JSONL artifact: each line names
 * why (regression or which invariant), the outcome delta and the verdict
 * digest, and carries the full signed receipt so it can be checked offline.
 * Every line is re-verified (receipt digest, receipt signature, diff
 * signature) before it is written; an unverifiable line fails the run.
 * `--verify FILE` re-checks a published file: each line's receipt, and every
 * line field derived from it (rejection, reason, deltas, invariants, digests),
 * so an edit to a line outside its receipt is caught too. The context fields
 * (source, label, caseId, attack, principal) are not in the receipt and are
 * not bound by it; a deleted line is not detected (lines are not chained).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runConsolidationDemo } from './demo.js';
import { canonicalize } from '../local/replay.js';
import { receiptProblem } from './gate.js';
import type { ConsolidationReceipt } from './types.js';

export { receiptProblem };

export const REJECTED_PASSES_SCHEMA = 'mnemosyne-consolidation-rejected-pass-v1';

export interface RejectedPassLine {
  schema: typeof REJECTED_PASSES_SCHEMA;
  source: string;
  /** `regression` and `hold-out regression` come from the replay gate; `invariant` from the checks that run before it. */
  rejection: 'regression' | 'hold-out regression' | 'invariant';
  /** True when the pass tried to put untrusted content into a policy-tier record. */
  laundering: boolean;
  caseId: string | null;
  attack: boolean | null;
  principal: string | null;
  label: string;
  passId: string;
  verdict: 'rolled_back';
  reason: string;
  delta: number | null;
  holdoutDelta: number | null;
  perProposal: number[];
  failedInvariants: string[];
  digest: string;
  prevDigest: string | null;
  receipt: ConsolidationReceipt;
}

export function rejectedPass(source: string, label: string, receipt: ConsolidationReceipt, context: { caseId?: string; attack?: boolean; principal?: string } = {}): RejectedPassLine {
  if (receipt.action !== 'gate' || receipt.verdict !== 'rolled_back') throw new Error(`${receipt.passId} is not a pass the gate rolled back`);
  const problem = receiptProblem(receipt);
  if (problem) throw new Error(`${receipt.passId}: ${problem}`);
  const failedInvariants = receipt.invariants.filter((invariant) => !invariant.ok).map((invariant) => invariant.name);
  const rejection = receipt.reason.startsWith('invariant violated') ? 'invariant' : receipt.reason.startsWith('hold-out regression') ? 'hold-out regression' : 'regression';
  if (rejection === 'regression' && !receipt.reason.startsWith('regression')) throw new Error(`${receipt.passId}: unrecognized rollback reason`);
  return {
    schema: REJECTED_PASSES_SCHEMA, source, rejection, laundering: failedInvariants.includes('no-untrusted-to-policy'),
    caseId: context.caseId ?? null, attack: context.attack ?? null, principal: context.principal ?? null, label,
    passId: receipt.passId, verdict: 'rolled_back', reason: receipt.reason,
    delta: receipt.scores?.delta ?? null, holdoutDelta: receipt.scores?.holdout?.delta ?? null, perProposal: receipt.scores?.perProposal ?? [],
    failedInvariants, digest: receipt.digest, prevDigest: receipt.prevDigest, receipt,
  };
}

const CONTEXT_FIELDS = ['source', 'label', 'caseId', 'attack', 'principal'] as const;

/**
 * Null when a published line checks out: its receipt verifies and every field
 * derived from the receipt equals what the receipt says. The context fields
 * are taken as given.
 */
export function rejectedPassLineProblem(line: RejectedPassLine): string | null {
  try {
    if (line?.schema !== REJECTED_PASSES_SCHEMA) return 'unknown line schema';
    const expected = rejectedPass(line.source, line.label, line.receipt, {
      ...(line.caseId === null ? {} : { caseId: line.caseId }), ...(line.attack === null ? {} : { attack: line.attack }), ...(line.principal === null ? {} : { principal: line.principal }),
    });
    const fields = Object.keys({ ...expected, ...line }).filter((key) => !(CONTEXT_FIELDS as readonly string[]).includes(key));
    const differs = fields.filter((key) => canonicalize((line as unknown as Record<string, unknown>)[key]) !== canonicalize((expected as unknown as Record<string, unknown>)[key]));
    return differs.length ? `line field(s) ${differs.join(', ')} do not match the receipt` : null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Every problem in a published rejected-passes JSONL file, by 1-based line number. */
export function verifyRejectedPasses(jsonl: string): { lines: number; problems: { line: number; problem: string }[] } {
  const problems: { line: number; problem: string }[] = [];
  const texts = jsonl.split('\n').filter(Boolean);
  texts.forEach((text, index) => {
    let problem: string | null;
    try { problem = rejectedPassLineProblem(JSON.parse(text) as RejectedPassLine); } catch (error) { problem = `not JSON: ${error instanceof Error ? error.message : String(error)}`; }
    if (problem) problems.push({ line: index + 1, problem });
  });
  return { lines: texts.length, problems };
}

export interface RejectedPassesSummary {
  schema: typeof REJECTED_PASSES_SCHEMA;
  command: string;
  lines: number;
  bySource: Record<string, number>;
  byRejection: Record<string, number>;
  laundering: number;
  signerKeyIds: string[];
  note: string;
}

/** Runs the demo (silently, on its fixed demo key) and joins its rolled-back passes with the suite's. */
export function collectRejectedPasses(suiteJsonl: string): RejectedPassLine[] {
  const demo = runConsolidationDemo({ log: () => {} });
  const lines = demo.passes.filter((pass) => pass.verdict === 'rolled_back').map((pass) => rejectedPass('consolidation-demo', pass.label, pass.receipt));
  for (const [index, text] of suiteJsonl.split('\n').filter(Boolean).entries()) {
    const item = JSON.parse(text) as { source: string; caseId: string; attack: boolean; principal: string; label: string; receipt: ConsolidationReceipt };
    try { lines.push(rejectedPass(item.source, item.label, item.receipt, { caseId: item.caseId, attack: item.attack, principal: item.principal })); }
    catch (error) { throw new Error(`suite line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return lines;
}

export function summarizeRejectedPasses(lines: RejectedPassLine[], command: string): RejectedPassesSummary {
  const count = (key: (line: RejectedPassLine) => string): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const line of lines) counts[key(line)] = (counts[key(line)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  };
  return {
    schema: REJECTED_PASSES_SCHEMA, command, lines: lines.length,
    bySource: count((line) => line.source), byRejection: count((line) => line.rejection), laundering: lines.filter((line) => line.laundering).length,
    signerKeyIds: [...new Set(lines.map((line) => line.receipt.receiptSignature.keyId))].sort(),
    note: 'Synthetic data only: the demo store and the poisoning suite v1 cases are synthetic. Both signing keys are fixed public seeds for reproducibility and must never sign a real store. Record ids, pass ids and digests differ between runs; verdicts, reasons and deltas do not.',
  };
}

const USAGE = 'Usage: node dist/consolidation/rejected-passes.js --suite reports/poisoning/v1-consolidation/rejected-passes.jsonl --out reports/consolidation\n       node dist/consolidation/rejected-passes.js --verify reports/consolidation/rejected-passes.jsonl';

export function rejectedPassesCli(args = process.argv.slice(2)): number {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: { suite: { type: 'string' }, out: { type: 'string' }, verify: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { console.log(USAGE); return 0; }
  if (values.verify !== undefined) {
    if (values.suite !== undefined || values.out !== undefined) { console.error(USAGE); return 2; }
    const report = verifyRejectedPasses(readFileSync(resolve(values.verify), 'utf8'));
    console.log(JSON.stringify({ file: resolve(values.verify), ok: report.problems.length === 0, ...report }));
    return report.problems.length ? 1 : 0;
  }
  if (!values.suite || !values.out) { console.error(USAGE); return 2; }
  const lines = collectRejectedPasses(readFileSync(resolve(values.suite), 'utf8'));
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const summary = summarizeRejectedPasses(lines, `node dist/consolidation/rejected-passes.js --suite ${values.suite} --out ${values.out}`);
  writeFileSync(resolve(out, 'rejected-passes.jsonl'), lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  writeFileSync(resolve(out, 'rejected-passes.summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify({ out, ...summary }));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = rejectedPassesCli(); } catch (error) { console.error(`Rejected passes failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
