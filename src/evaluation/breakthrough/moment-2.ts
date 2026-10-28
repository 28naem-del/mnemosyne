/**
 * Moment 2 — "I corrected one fact and it fixed everything downstream, including
 * things I never linked."
 *
 * A SYNTHETIC billing scenario: one premise (the billing API base URL), two
 * procedures that declared it, two procedures and one runtime skill that relied
 * on it without declaring it, and one decoy procedure that was used with the
 * premise only in tasks that failed. Every task goes through the public APIs a
 * controller uses (`recall`, then `MemoryRuntime.recordTrace` with the used set
 * and a verifier outcome; a failed task's verdict is `recordRetrievalOutcome`), which is exactly the evidence `inferDependencies`
 * reads. Inference proposes the undeclared edges with their statistics, a
 * reviewer accepts them through `reviewDependency` (one ledger receipt each, the
 * edge linked in the same transaction), and then one `correct()` of the premise
 * cascades through declared and accepted edges alike.
 *
 * Proof (measured live on this scenario): undeclared dependents invalidated X/X,
 * accepted edges that are true Y/Y, and stale dependents still handed back as
 * active by `recall()`, `compile()` or `runtime.getSkill()` after the correction
 * = 0. The premise guard (`createPremiseGuard`) is deliberately NOT used here:
 * the zero is the kernel cascade alone. The same probes are run before the
 * correction, and must return every dependent, so a zero cannot come from probes
 * that never matched. The published suite-v1 numbers are read from
 * `reports/dependencies/v1/report.md` when the file ships with the checkout and
 * are printed as a pointer, never as this moment's proof.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLocalMemory, type MemoryRecord } from '../../local/index.js';
import { MemoryRuntime } from '../../runtime/index.js';
import { inferDependencies, reviewDependency } from '../../dependencies/index.js';
import type { MomentContext, MomentOutcome } from './types.js';

const CLOCK = Date.UTC(2026, 0, 12, 9);
/** Package-root relative, so it resolves from `src/` and `dist/` alike. */
const PUBLISHED = fileURLToPath(new URL('../../../reports/dependencies/v1/report.md', import.meta.url));
const REVIEWER = 'ops-lead (synthetic reviewer)';
const VERIFIER = 'orion-ci (synthetic)';

const PREMISE = 'The Orion billing API base URL is https://billing.orion.example/v1.';
const CORRECTED = 'The Orion billing API base URL is https://billing.orion.example/v2; v1 was retired on 2026-01-19.';

interface Dependent { label: string; text: string; ids: string[]; declared: boolean; skillId?: string }

/** The published suite-v1 gate, read from the committed report; null when the report is not in this checkout. */
export function publishedDependencyNumbers(path = PUBLISHED): { recall: string; precision: string; stale: string; staleInferenceOnly: string; staleChecks: string } | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const recall = /Invalidation recall[^|]*\|\s*([\d.]+%)/.exec(text)?.[1];
  const precision = /Precision of accepted edges[^|]*\|\s*([\d.]+%)/.exec(text)?.[1];
  const stale = /Stale-procedure executions[^|]*\|\s*(\d+)\s*\|/.exec(text)?.[1];
  // The suite's stale 0 is the premise guard's; the report states what inference alone leaves.
  const inferenceOnly = /Inference alone leaves (\d+) stale of (\d+)/.exec(text);
  return recall && precision && stale && inferenceOnly
    ? { recall, precision, stale, staleInferenceOnly: inferenceOnly[1]!, staleChecks: inferenceOnly[2]! }
    : null;
}

export async function momentDownstream(context: MomentContext): Promise<MomentOutcome> {
  const { say } = context;
  let tick = CLOCK;
  const now = () => new Date(tick += 1000);
  const memory = createLocalMemory({ path: ':memory:', workspaceId: 'demo-orion', agentId: 'operator', retrieval: 'lexical', now });
  const runtime = new MemoryRuntime(memory, { now });
  try {
    const source = (path: string) => ({ uri: `synthetic://orion/${path}`, author: 'platform-team' });
    const fact = (text: string, path: string) => memory.store({ text, kind: 'fact', trust: 'observed', source: source(path) });
    const procedure = (text: string, path: string, dependencies: string[] = []) => memory.store({ text, kind: 'procedure', trust: 'observed', source: source(path), dependencies });

    const premise = fact(PREMISE, 'infra/billing-api.md');
    const declaredA = procedure('Run the nightly invoice export against the billing API base URL.', 'runbooks/invoice-export.md', [premise.id]);
    const declaredB = procedure('Point the payments webhook at the billing API base URL.', 'runbooks/payments-webhook.md', [premise.id]);
    const refunds = procedure('Refund a customer: POST /refunds on the billing API with the order id and the amount.', 'runbooks/refunds.md');
    const reconcile = procedure('Reconcile the ledger: page through GET /invoices on the billing API every hour.', 'runbooks/reconcile.md');
    const decoy = procedure('Rotate the billing API key in the team vault every quarter.', 'runbooks/key-rotation.md');
    const approval = fact('Credit notes above 500 EUR need a manager approval code.', 'policy/credit-notes.md');
    const skill = runtime.createSkill({ name: 'Issue a credit note', prerequisites: [], steps: ['POST /credit-notes on the billing API', 'Email the credit note PDF to the customer'], parameters: {}, evidenceIds: [approval.id] });
    const trial = { passed: true, evidence: 'Synthetic trial: credit note issued in the sandbox.', verifier: VERIFIER, taskId: 'trial-credit-note', prerequisitesSatisfied: true };
    const activeSkill = await runtime.trialSkill({ id: skill.id, validation: trial });
    const skillRecord = memory.get(activeSkill.recordId)!;
    const background = [
      procedure('Triage new support tickets by severity before standup.', 'runbooks/triage.md'),
      procedure('Write the weekly status report from the merged pull requests.', 'runbooks/status.md'),
      procedure('Review open pull requests older than two days.', 'runbooks/reviews.md'),
    ];
    const noise = fact('The standup starts at 09:30 UTC.', 'team/standup.md');

    let serial = 0, decoyFailedCoUse = 0, decoySuccessCoUse = 0;
    const task = (query: string, retrieved: MemoryRecord[], used: MemoryRecord[], success: boolean): void => {
      if (used.includes(decoy) && used.includes(premise)) { if (success) decoySuccessCoUse++; else decoyFailedCoUse++; }
      const taskId = `orion-task-${String(++serial).padStart(2, '0')}`;
      const evidence = `${taskId}: ${success ? 'passed' : 'failed'}`;
      memory.recall({ query, limit: 10 });
      const ids = { retrievedIds: retrieved.map((record) => record.id), usedIds: used.map((record) => record.id) };
      // A failure is judged on the retrieval (task-level verifier verdict), not as a
      // per-record failed outcome: one failed outcome makes a record ineligible in
      // the kernel, which would pull the premise itself out of the scenario.
      if (success) runtime.recordTrace({ taskId, query, ...ids, outcome: { success, verifier: VERIFIER, evidence } });
      else { runtime.recordTrace({ taskId, query, ...ids }); memory.recordRetrievalOutcome({ taskId, success, verifier: VERIFIER, evidence }); }
    };
    for (let round = 0; round < 3; round++) {
      task('refund customer order billing api', [refunds, premise, noise], [refunds, premise], true);
      task('reconcile ledger invoices billing api', [reconcile, premise], [reconcile, premise], true);
      task('issue credit note billing api', [skillRecord, premise], [skillRecord, premise], true);
      for (const other of background) task(other.text, [other, noise], [other], true);
    }
    for (const declared of [declaredA, declaredB]) task(declared.text, [declared, premise], [declared, premise], true);
    // The decoy touched the premise only in tasks that failed (and once, successfully, alone).
    task('rotate billing api key vault', [decoy, premise], [decoy, premise], false);
    task('rotate billing api key vault quarterly', [decoy, premise], [decoy, premise], false);
    task('rotate billing api key', [decoy], [decoy], true);

    const dependents: Dependent[] = [
      { label: 'invoice export (declared)', text: declaredA.text, ids: [declaredA.id], declared: true },
      { label: 'payments webhook (declared)', text: declaredB.text, ids: [declaredB.id], declared: true },
      { label: 'refunds (never linked)', text: refunds.text, ids: [refunds.id], declared: false },
      { label: 'ledger reconcile (never linked)', text: reconcile.text, ids: [reconcile.id], declared: false },
      { label: 'skill "Issue a credit note" (never linked)', text: 'Issue a credit note billing api credit-notes', ids: [skillRecord.id], declared: false, skillId: skill.id },
    ];
    const truth = new Set(dependents.filter((dependent) => !dependent.declared).flatMap((dependent) => dependent.ids));
    const labelOf = (id: string) => dependents.find((dependent) => dependent.ids.includes(id))?.label ?? (id === decoy.id ? 'key rotation (decoy)' : id.slice(0, 8));

    say(`Premise: "${PREMISE}"`);
    say('Two runbooks declared it. Two more runbooks and one learned skill used it in their tasks and never said so;');
    say(`a key-rotation runbook touched it only in tasks that failed. ${serial} synthetic tasks were recorded through recall() + recordTrace().`);
    say('');
    say('> inferDependencies(memory)   (rule co-use-success-v1: read-only, no model)');
    const inference = inferDependencies(memory);
    const { tasks, pairs } = inference.evidence;
    say(`  ${tasks.successful} successful and ${tasks.failed} failed tasks read; ${pairs.considered} co-used pairs considered, ${pairs.proposed} proposed (declared ${pairs.rejected.declared}, support ${pairs.rejected.support}, association lift ${pairs.rejected.lift} rejected)`);
    for (const proposal of inference.proposals) {
      say(`  proposal: ${labelOf(proposal.from)} relies on the premise   support ${proposal.support}/${proposal.runs} runs, reliance ${proposal.reliance.toFixed(2)}, association lift ${proposal.lift.toFixed(2)}, confidence ${proposal.confidence.toFixed(2)}`);
    }
    const decoyProposed = inference.proposals.some((proposal) => proposal.from === decoy.id);
    say(`  key rotation (decoy): ${decoyFailedCoUse} co-uses in failed tasks, ${decoySuccessCoUse} in successful ones; a failure is never support -> ${decoyProposed ? 'PROPOSED' : 'not proposed'}`);
    say('');
    say(`> reviewDependency(memory, proposal, 'accept', '${REVIEWER}')   for each proposal`);
    const accepted: { from: string; to: string; true: boolean }[] = [];
    for (const proposal of inference.proposals) {
      const review = reviewDependency(memory, proposal, 'accept', REVIEWER, { runtime, now, note: 'Checked the runbook against the billing API.' });
      const dependent = dependents.find((entry) => entry.ids.includes(proposal.from));
      dependent?.ids.push(review.dependentId);
      accepted.push({ from: proposal.from, to: proposal.to, true: truth.has(proposal.from) && proposal.to === premise.id });
      say(`  accepted: receipt ${review.receiptId} -> ${labelOf(proposal.from)} re-versioned ${review.supersededId?.slice(0, 8)}... -> ${review.dependentId.slice(0, 8)}... now declaring the premise`);
    }
    const receipts = memory.ledger({ events: ['dependency'] }).entries.length;

    // The probes an executor would use to hand a procedure back; run before and after the correction.
    const probe = (dependent: Dependent): string[] => {
      const lineage = new Set(dependent.ids);
      const found: string[] = [];
      if (memory.recall({ query: dependent.text, limit: 20 }).some((hit) => lineage.has(hit.memory.id))) found.push('recall');
      if (memory.compile({ query: dependent.text, maxTokens: 4000 }).items.some((item) => lineage.has(item.id))) found.push('compile');
      if (dependent.skillId !== undefined && runtime.getSkill(dependent.skillId)?.state === 'active') found.push('getSkill');
      return found;
    };
    const live = dependents.filter((dependent) => probe(dependent).length > 0).length;
    say(`  before the correction: ${live}/${dependents.length} dependents handed back as active by recall()/compile()/getSkill()`);
    say('');
    say(`> correct(premise, "${CORRECTED}")`);
    memory.correct(premise.id, { text: CORRECTED, source: source('infra/billing-api.md#v2'), reason: 'Billing API v1 was retired; v2 is the live base URL.' });

    let undeclaredInvalidated = 0, declaredInvalidated = 0, stale = 0, probes = 0;
    for (const dependent of dependents) {
      const head = memory.get(dependent.ids.at(-1)!)!;
      const retired = dependent.skillId === undefined ? null : runtime.getSkill(dependent.skillId);
      const invalidated = dependent.skillId === undefined ? head.status === 'invalidated' && !memory.isEligible(head.id) : retired?.state === 'retired';
      if (invalidated) { if (dependent.declared) declaredInvalidated++; else undeclaredInvalidated++; }
      const found = probe(dependent);
      probes += dependent.skillId === undefined ? 2 : 3;
      if (found.length) stale++;
      const why = dependent.skillId === undefined ? `status ${head.status}` : `skill ${retired?.state}: ${retired?.reason ?? 'no reason'}`;
      say(`  ${invalidated ? 'invalidated' : 'STILL ACTIVE'}  ${dependent.label}: ${why}${found.length ? `; STALE via ${found.join(', ')}` : ''}`);
    }
    const decoyHead = memory.get(decoy.id)!;
    const decoySurvived = decoyHead.status === 'active' && memory.isEligible(decoy.id) && memory.recall({ query: decoy.text, limit: 5 }).some((hit) => hit.memory.id === decoy.id);
    say(`  ${decoySurvived ? 'survived' : 'WRONGLY INVALIDATED'}     key rotation (decoy): status ${decoyHead.status}, still recalled`);

    const undeclared = dependents.filter((dependent) => !dependent.declared).length;
    const declared = dependents.length - undeclared;
    const truePositives = accepted.filter((edge) => edge.true).length;
    say('');
    say(`  undeclared dependents invalidated ${undeclaredInvalidated}/${undeclared}, declared ${declaredInvalidated}/${declared}; ${receipts} dependency receipt(s) in the ledger; premise guard not used`);
    const published = publishedDependencyNumbers();
    if (published) say(`  published, synthetic dependency suite v1 (reports/dependencies/v1/report.md): recall ${published.recall}, precision ${published.precision}, stale ${published.stale} with the premise guard (inference alone leaves ${published.staleInferenceOnly} of ${published.staleChecks} stale)`);

    const passed = live === dependents.length && undeclared > 0 && undeclaredInvalidated === undeclared && declaredInvalidated === declared
      && accepted.length > 0 && truePositives === accepted.length && accepted.length === undeclared && stale === 0 && decoySurvived && !decoyProposed;
    return {
      proof: {
        label: 'downstream repair',
        measured: `undeclared invalidated ${undeclaredInvalidated}/${undeclared}, accepted edges true ${truePositives}/${accepted.length}, stale after correction ${stale} (${probes} probes)`,
        threshold: 'X/X undeclared invalidated, Y/Y accepted edges true, 0 stale, decoy survives',
        passed,
      },
      details: { undeclared, undeclaredInvalidated, declared, declaredInvalidated, accepted: accepted.length, truePositives, stale, probes, liveBefore: live, decoySurvived, decoyProposed, receipts, tasks: serial, published },
    };
  } finally {
    memory.close();
  }
}
