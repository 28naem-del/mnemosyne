/**
 * `mnemosy demo`: the breakthrough demo (MASTER-PLAN §11.7, the WOW contract).
 *
 * Walks a new user, offline, through five moments on bundled SYNTHETIC corpora,
 * and after each one prints the proof number it just measured live on this
 * machine. Nothing here is a recorded number: a moment either measures its proof
 * now, or says `pending`.
 *
 * Deterministic and model-free by construction: every store is `:memory:` or a
 * fresh temporary directory, retrieval is the zero-model `lexical` path, kernel
 * time comes from an injected clock, and every corpus and cut point comes from a
 * seeded PRNG. No module on this path opens a socket.
 *
 * ## Extension point
 *
 * The moments live in {@link BREAKTHROUGH_MOMENTS}. A pending moment has no
 * `run`; implementing it is writing one function
 * `(context: MomentContext) => MomentOutcome | Promise<MomentOutcome>` in
 * `src/evaluation/breakthrough/moment-<id>.ts` and setting it as that entry's
 * `run` (and deleting `pendingNote`). The framework already streams the moment's
 * lines through `context.say`, times it, turns a throw into a failed proof, prints
 * the PROOF line and counts it in the report.
 */
import { performance } from 'node:perf_hooks';
import * as v from '../local/validation.js';
import { momentRemembers } from './breakthrough/moment-1.js';
import { momentDownstream } from './breakthrough/moment-2.js';
import { momentBisect } from './breakthrough/moment-3.js';
import { momentPoisoning } from './breakthrough/moment-4.js';
import { momentConsolidation } from './breakthrough/moment-5.js';
import type { BreakthroughDemoOptions, BreakthroughDemoReport, Moment, MomentDefinition } from './breakthrough/types.js';

export type { BreakthroughDemoOptions, BreakthroughDemoReport, Moment, MomentContext, MomentDefinition, MomentOutcome, MomentProof, MomentId } from './breakthrough/types.js';

export const BREAKTHROUGH_DEMO_SEED = 20261028;
/** §11.7 floor for the bisect store. */
export const BREAKTHROUGH_MIN_RECORDS = 2000;

export const BREAKTHROUGH_MOMENTS: readonly MomentDefinition[] = [
  {
    id: 1, title: 'It remembers, and knows why',
    proofLabel: 'replay determinism', threshold: 'N/N identical stateSha256 in two readers, every as-of answer = ground truth',
    run: momentRemembers,
  },
  {
    id: 2, title: 'I corrected one fact and it fixed everything downstream, including things I never linked',
    proofLabel: 'downstream repair', threshold: 'X/X undeclared invalidated, Y/Y accepted edges true, 0 stale, decoy survives',
    run: momentDownstream,
  },
  {
    id: 3, title: 'It found the belief that made it wrong',
    proofLabel: 'blame precision / time-to-locate', threshold: 'culprit set == seeded record, < 60 s, >= 2000 records',
    run: momentBisect,
  },
  {
    id: 4, title: 'Someone tried to poison it, and it caught it, visibly',
    proofLabel: 'poisoning suite v1, live', threshold: '0 escapes, false-quarantine rate < 2 %, 0 harness errors',
    run: momentPoisoning,
  },
  {
    id: 5, title: 'It got better on its own, and handed me the receipt',
    proofLabel: 'consolidation receipts', threshold: 'kept >= 1 with delta >= 0 and hold-out >= 0, rolled back >= 1, rollback restores the identical stateSha256, chain verifies',
    run: momentConsolidation,
  },
];

const LIMITATIONS = [
  'Every corpus is synthetic and generated from a seed; the numbers describe this kernel on these corpora, not on your data.',
  'Retrieval is the zero-model lexical path; the hybrid (dense + reranker) path is not exercised here.',
  'Every number is measured live on this machine during this run; wall-clock timings vary with the machine.',
  'Poisoning results are "zero escapes on suite v1" for the cases in the suite, reproducible; not a claim about attacks outside it.',
  'Moments 2 and 5 run on small hand-built synthetic scenarios (a few records, tens of tasks); their PROOF is about this scenario. Suite-level numbers live in reports/dependencies/v1 and docs/CONSOLIDATION.md.',
  'Moment 2 accepts every proposal as the reviewer would after checking; in production each acceptance is a human decision, and the premise guard is not used in the demo.',
  'Moment 5 signs receipts with the consolidation module\'s fixed demo key, so receipts are reproducible; never sign a real store with it.',
  'A moment registered without an implementation reports `pending` and is counted neither as passed nor in the total.',
];

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${label} must be an integer between ${min} and ${max}`);
  return value;
}

/** The PROOF line every moment ends with; the measured value is whatever the moment measured. */
function proofLine(moment: Pick<Moment, 'proof'>): string {
  const verdict = moment.proof.passed === 'pending' ? 'PENDING' : moment.proof.passed ? 'PASS' : 'FAIL';
  return `PROOF  ${moment.proof.label}: ${moment.proof.measured}   [${verdict}; bar: ${moment.proof.threshold}]`;
}

export async function runBreakthroughDemo(options: BreakthroughDemoOptions = {}): Promise<BreakthroughDemoReport> {
  const input = v.object(options, 'breakthrough demo options');
  v.keys(input, ['out', 'seed', 'records', 'cutPoints'], 'breakthrough demo option');
  if (input.out !== undefined && typeof input.out !== 'function') throw new TypeError('out must be a function');
  const out = options.out ?? (() => {});
  const seed = integer(input.seed, BREAKTHROUGH_DEMO_SEED, 0, 0xffff_ffff, 'seed');
  const records = integer(input.records, BREAKTHROUGH_MIN_RECORDS, BREAKTHROUGH_MIN_RECORDS, 50_000, 'records');
  const cutPoints = integer(input.cutPoints, 1000, 1, 10_000, 'cutPoints');

  const generatedAt = new Date().toISOString();
  const started = performance.now();
  out('Mnemosyne breakthrough demo: five moments, synthetic corpora, offline, zero-model lexical path.');
  out('Every PROOF number below is measured now, on this machine.');
  const moments: Moment[] = [];
  for (const definition of BREAKTHROUGH_MOMENTS) {
    const lines: string[] = [];
    const say = (line: string): void => { lines.push(line); out(line ? `  ${line}` : ''); };
    out('');
    out(`[${definition.id}/${BREAKTHROUGH_MOMENTS.length}] ${definition.title}`);
    const momentStarted = performance.now();
    let moment: Moment;
    if (!definition.run) {
      say(`(pending: ${definition.pendingNote ?? 'not implemented yet'})`);
      moment = { id: definition.id, title: definition.title, lines, proof: { label: definition.proofLabel, measured: 'pending', threshold: definition.threshold, passed: 'pending' }, durationMs: 0 };
    } else {
      try {
        const outcome = await definition.run({ say, seed, records, cutPoints });
        moment = { id: definition.id, title: definition.title, lines, proof: outcome.proof, durationMs: 0, ...(outcome.details ? { details: outcome.details } : {}) };
      } catch (error) {
        // A moment that cannot finish has not proved anything: report it as a failed proof, never skip it.
        say(`error: ${error instanceof Error ? error.message : String(error)}`);
        moment = { id: definition.id, title: definition.title, lines, proof: { label: definition.proofLabel, measured: 'error', threshold: definition.threshold, passed: false }, durationMs: 0 };
      }
    }
    moment.durationMs = Math.round(performance.now() - momentStarted);
    const line = proofLine(moment);
    lines.push(line);
    out(line);
    moments.push(moment);
  }
  const implemented = moments.filter((moment) => moment.proof.passed !== 'pending');
  const passed = implemented.filter((moment) => moment.proof.passed === true).length;
  const pending = moments.filter((moment) => moment.proof.passed === 'pending')
    .map((moment) => `${moment.id}. ${moment.title} (${BREAKTHROUGH_MOMENTS.find((entry) => entry.id === moment.id)?.pendingNote ?? 'pending'})`);
  const durationMs = Math.round(performance.now() - started);
  out('');
  if (!pending.length) out(`${passed}/${implemented.length} moments proved. Total ${(durationMs / 1000).toFixed(1)} s.`);
  else out(`${passed}/${implemented.length} implemented moments proved, ${pending.length} pending (${moments.filter((moment) => moment.proof.passed === 'pending').map((moment) => moment.id).join(', ') || 'none'}). Total ${(durationMs / 1000).toFixed(1)} s.`);
  return { generatedAt, durationMs, moments, passed, total: implemented.length, pending, limitations: LIMITATIONS };
}
