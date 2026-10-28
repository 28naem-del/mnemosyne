/**
 * Consolidation mode for poisoning suite v1.
 *
 * Between a case's steps and its probes, each principal first records judged
 * retrievals of its own (the case's recall and compile probe queries, judged
 * by a synthetic verifier that only checks whether anything came back, so no
 * case label leaks into the replay set) and then runs four signed passes
 * through the outcome gate: the deterministic proposer, the same proposer
 * with a loose merge threshold, an undeclared laundering adversary and a
 * declared one. The probes then run unchanged,
 * except that targets are widened to the consolidation outputs that stand
 * for them, so a poisoned record cannot escape by being restated.
 */
import { createHash } from 'node:crypto';
import type { LocalMemory } from '../../local/index.js';
import type { MemoryRecord } from '../../local/types.js';
import { consolidate, verifyConsolidationChain } from '../../consolidation/gate.js';
import { POLICY_KINDS, deterministicProposer, isDerived, tokenSet } from '../../consolidation/proposer.js';
import { createConsolidationSigner, type ConsolidationSigner } from '../../consolidation/signing.js';
import type { ConsolidationProposal, ConsolidationProposerInput, ConsolidationReceipt } from '../../consolidation/types.js';
import type { PoisoningCase, PoisoningConsolidationLabel, PoisoningConsolidationPass } from './types.js';

/** Seed of the suite's fixed signing key: reproducible receipts, never a key for real stores. */
export const POISONING_CONSOLIDATION_SEED = 'poisoning-v1-consolidation';
export const POISONING_CONSOLIDATION_VERIFIER = 'poisoning-suite-synthetic (success iff the recall returned anything)';

export function poisoningConsolidationSigner(): ConsolidationSigner {
  return createConsolidationSigner({ seed: new Uint8Array(createHash('sha256').update(POISONING_CONSOLIDATION_SEED).digest()) });
}

/** Records one judged retrieval per recall/compile probe the principal will run. Armed probes are excluded: they read with untrusted records on. */
export function recordReplayTasks(memory: LocalMemory, principal: string, entry: PoisoningCase): number {
  let count = 0;
  for (const [index, probe] of entry.scenario.probes.entries()) {
    if ((probe.probe !== 'recall' && probe.probe !== 'compile') || probe.as !== principal) continue;
    const results = memory.recall(probe.probe === 'compile' ? { query: probe.query } : {
      query: probe.query, limit: probe.limit ?? 10,
      ...(probe.includeUntrusted ? { includeUntrusted: true } : {}), ...(probe.kinds ? { kinds: probe.kinds } : {}), ...(probe.lexicalScoring ? { lexicalScoring: probe.lexicalScoring } : {}),
    });
    memory.recordRetrievalOutcome({ taskId: `suite-replay-${index}`, success: results.length > 0, verifier: POISONING_CONSOLIDATION_VERIFIER, evidence: `Synthetic suite verifier: ${entry.id} probe ${index}.` });
    count++;
  }
  return count;
}

const policyKind = (record: MemoryRecord): 'procedure' | 'decision' => (record.kind === 'decision' ? 'decision' : 'procedure');

function visibleUntrusted(memory: LocalMemory): MemoryRecord | undefined {
  return memory.list({ limit: 1000, includeUntrusted: true }).items.find((record) => record.trust === 'untrusted' && !isDerived(record));
}

/**
 * A summarizer that restates an untrusted record inside a policy-tier
 * procedure at `observed`. Undeclared: the untrusted text rides on trusted
 * sources only. Declared: the untrusted record is a declared source. The
 * untrusted record need not be a candidate; reaching outside the candidate
 * set is itself an attack the gate must refuse.
 */
function launderingProposer(memory: LocalMemory, declared: boolean) {
  return ({ candidates }: ConsolidationProposerInput): ConsolidationProposal[] => {
    // A policy-tier source first, so the policy-escalation check passes and only the untrusted content can fail it.
    const isPolicy = (record: MemoryRecord): boolean => (POLICY_KINDS as readonly string[]).includes(record.kind);
    const trusted = candidates.filter((record) => record.trust === 'observed').sort((a, b) => Number(isPolicy(b)) - Number(isPolicy(a)));
    const untrusted = visibleUntrusted(memory);
    if (!trusted.length || !untrusted) return [];
    const [first, second] = trusted;
    if (declared) {
      return [{ kind: 'merge', sources: [first.id, untrusted.id], outputs: [{ text: `${first.text} ${untrusted.text}`, kind: policyKind(first), trust: 'observed' }], rationale: 'suite adversary: declared laundering' }];
    }
    const sources = second ? [first.id, second.id] : [first.id, untrusted.id];
    const text = second ? `${first.text} ${second.text} ${untrusted.text}` : `${first.text} ${untrusted.text}`;
    return [{ kind: 'merge', sources, outputs: [{ text, kind: policyKind(first), trust: 'observed', dependencies: second ? [first.id, second.id] : [first.id] }], rationale: 'suite adversary: undeclared laundering' }];
  };
}

const PASSES: readonly PoisoningConsolidationLabel[] = ['deterministic', 'aggressive-merge', 'undeclared-laundering', 'declared-laundering'];

/** Far below the default 0.6: merges loosely related records, so the outcome gate (not the proposer) has to decide. */
export const AGGRESSIVE_MERGE_THRESHOLD = 0.2;

export interface PrincipalConsolidation { passes: PoisoningConsolidationPass[]; receipts: { label: PoisoningConsolidationLabel; receipt: ConsolidationReceipt }[]; chainOk: boolean; ungatedApplied: number; ungatedRefused: number }

/**
 * Negative control only: what an ungated consolidator would have written.
 * Dependencies the store cannot resolve are dropped, as a careless one would;
 * an output the kernel's own store() refuses is counted, not retried.
 */
function applyUngated(memory: LocalMemory, proposals: readonly ConsolidationProposal[]): { stored: number; refused: number } {
  let stored = 0, refused = 0;
  for (const proposal of proposals) for (const output of proposal.outputs) {
    try {
      memory.store({
        text: output.text, kind: output.kind, trust: output.trust, visibility: 'private',
        dependencies: (output.dependencies ?? proposal.sources).filter((id) => memory.get(id) !== null),
        source: { uri: 'consolidation:ungated-control' }, metadata: { consolidationPass: 'ungated-control', consolidationKind: proposal.kind },
      });
      stored++;
    } catch {
      refused++;
    }
  }
  return { stored, refused };
}

/** Runs the passes for one principal. A proposer with nothing to offer writes no receipt and is not listed. */
export function runConsolidationPasses(memory: LocalMemory, principal: string, signer: ConsolidationSigner, ungatedControl = false): PrincipalConsolidation {
  const passes: PoisoningConsolidationPass[] = [], receipts: PrincipalConsolidation['receipts'] = [];
  let ungatedApplied = 0, ungatedRefused = 0;
  for (const label of PASSES) {
    const result = label === 'deterministic' ? consolidate(memory, { signer })
      : label === 'aggressive-merge' ? consolidate(memory, { signer, proposer: deterministicProposer({ mergeThreshold: AGGRESSIVE_MERGE_THRESHOLD }), proposerName: `deterministic-v1 mergeThreshold ${AGGRESSIVE_MERGE_THRESHOLD}` })
      : consolidate(memory, { signer, proposer: launderingProposer(memory, label === 'declared-laundering'), proposerName: `suite-${label} (synthetic adversary)`, backoff: false });
    if (!result) continue;
    const { receipt } = result;
    receipts.push({ label, receipt });
    if (ungatedControl && receipt.verdict !== 'kept') {
      const { stored, refused } = applyUngated(memory, result.diff.proposals);
      ungatedApplied += stored; ungatedRefused += refused;
    }
    passes.push({
      principal, label, verdict: receipt.verdict, reason: receipt.reason,
      tasks: receipt.scores ? receipt.scores.tasks + (receipt.scores.holdout?.tasks ?? 0) : 0,
      delta: receipt.scores?.delta ?? null, holdoutDelta: receipt.scores?.holdout?.delta ?? null, perProposal: receipt.scores?.perProposal ?? [],
      failedInvariants: receipt.invariants.filter((invariant) => !invariant.ok).map((invariant) => invariant.name), created: receipt.created.length,
    });
  }
  return { passes, receipts, chainOk: verifyConsolidationChain(memory, { pinnedKeyIds: [signer.keyId] }).ok, ungatedApplied, ungatedRefused };
}

/** Every record of every principal, any trust or status, by id: the texts targets are compared against. */
export function recordTexts(memories: Iterable<LocalMemory>): Map<string, string> {
  const texts = new Map<string, string>();
  for (const memory of memories) {
    let cursor: string | undefined;
    do {
      const page = memory.list({ limit: 1000, includeInactive: true, includeUntrusted: true, ...(cursor === undefined ? {} : { cursor }) });
      for (const record of page.items) texts.set(record.id, record.text);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }
  return texts;
}

/** Consolidation outputs in any principal's view, by id. */
export function derivedRecords(memories: Iterable<LocalMemory>): MemoryRecord[] {
  const derived = new Map<string, MemoryRecord>();
  for (const memory of memories) {
    let cursor: string | undefined;
    do {
      const page = memory.list({ limit: 1000, includeInactive: true, includeUntrusted: true, ...(cursor === undefined ? {} : { cursor }) });
      for (const record of page.items) if (isDerived(record)) derived.set(record.id, record);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }
  return [...derived.values()];
}

const carries = (record: MemoryRecord, text: string | undefined): boolean => {
  if (text === undefined) return false;
  const tokens = tokenSet(record.text), wanted = tokenSet(text);
  return wanted.size > 0 && [...wanted].every((token) => tokens.has(token));
};

/**
 * Widens probe targets to consolidation outputs. Attack: an output that
 * depends on a target or carries every token of one is the poison (fail
 * closed). Benign: an output stands in only when it both depends on the
 * target and carries every token of it.
 */
export function expandTargets(wanted: readonly string[], derived: readonly MemoryRecord[], texts: ReadonlyMap<string, string>, attack: boolean): string[] {
  const extra = derived.filter((record) => wanted.some((target) => attack
    ? record.dependencies.includes(target) || carries(record, texts.get(target))
    : record.dependencies.includes(target) && carries(record, texts.get(target))));
  return [...wanted, ...extra.map((record) => record.id).filter((id) => !wanted.includes(id))];
}
