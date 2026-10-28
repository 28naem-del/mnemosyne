/**
 * Diff invariants (P9), checked before the replay gate and recorded in the
 * receipt whatever the verdict. A failed invariant is a rollback even when the
 * recorded outcomes would improve: an outcome delta alone cannot tell a useful
 * summary from a laundered instruction.
 */
import type { LocalMemory } from '../local/index.js';
import { KINDS } from '../local/validation.js';
import type { MemoryRecord } from '../local/types.js';
import { ADDITIVE_KINDS, CONSOLIDATION_KINDS, type ConsolidationCaps, type ConsolidationDiff, type ConsolidationInvariant } from './types.js';
import { MAX_CREATED, POLICY_KINDS, TRUST_LEVEL, tokenSet, untouchable, usableSource } from './proposer.js';

/** Invariant names in the order they are reported. */
export const INVARIANT_NAMES = [
  'menu', 'caps', 'candidate-set', 'untouchable', 'sources-usable', 'no-trust-raise', 'declared-content',
  'no-untrusted-to-policy', 'no-policy-escalation', 'source-budget', 'reversible',
] as const;
type InvariantName = (typeof INVARIANT_NAMES)[number];

const TRUSTS = ['untrusted', 'observed', 'verified'];
const isPolicy = (kind: string): boolean => (POLICY_KINDS as readonly string[]).includes(kind);

export interface InvariantReport {
  invariants: ConsolidationInvariant[];
  /** Per proposal: whether it broke an invariant itself (or read a candidate that did). Pass-level failures fault every proposal. */
  faults: boolean[];
}

/**
 * Candidates are re-read from the store, never trusted from the diff.
 * `untrustedTokens` is the token set of every untrusted record the owner can
 * read, used to tell undeclared content that came from an untrusted record
 * apart from content that came from nowhere.
 */
export function checkInvariants(memory: LocalMemory, diff: Pick<ConsolidationDiff, 'proposals' | 'candidateSet' | 'cut'>, caps: Readonly<ConsolidationCaps>, untrustedTokens: ReadonlySet<string>): InvariantReport {
  const failures = new Map<InvariantName, string>();
  const faults = diff.proposals.map(() => false);
  const badCandidates = new Set<string>();
  let passFault = false;
  let current: number | undefined;
  const fail = (name: InvariantName, detail: string): void => {
    if (!failures.has(name)) failures.set(name, detail);
    if (current === undefined) passFault = true; else faults[current] = true;
  };
  const candidates = new Map<string, MemoryRecord>();
  // Details name positions, never ids or text, so a receipt stays stable across runs and leaks nothing.
  diff.candidateSet.forEach((candidate, position) => {
    const record = memory.get(candidate.id);
    const flag = (name: InvariantName, detail: string): void => { if (!failures.has(name)) failures.set(name, detail); badCandidates.add(candidate.id); };
    if (!record) { flag('candidate-set', `candidate ${position} does not exist`); return; }
    candidates.set(candidate.id, record);
    const reason = untouchable(record, memory.agentId);
    if (reason) flag('untouchable', `candidate ${position}: ${reason}`);
    else if (!usableSource(memory, record, diff.cut)) flag('sources-usable', `candidate ${position} is withheld from recall at the cut`);
  });
  const counts = new Map<string, number>();
  let created = 0;
  diff.proposals.forEach((proposal, index) => {
    current = index;
    const at = `proposal ${index}`;
    if (!proposal || typeof proposal !== 'object' || !(CONSOLIDATION_KINDS as readonly string[]).includes(proposal.kind)) { fail('menu', `${at}: kind outside the closed menu`); return; }
    const sources = Array.isArray(proposal.sources) ? proposal.sources : [];
    const outputs = Array.isArray(proposal.outputs) ? proposal.outputs : [];
    const shape = { merge: sources.length >= 2 && outputs.length === 1, abstract: sources.length >= 2 && outputs.length === 1, split: sources.length === 1 && outputs.length >= 2, supersede: sources.length === 1 && outputs.length === 0 && typeof proposal.by === 'string', delete: sources.length >= 1 && outputs.length === 0 }[proposal.kind];
    if (!shape || new Set(sources).size !== sources.length || typeof proposal.rationale !== 'string' || (proposal.kind !== 'supersede' && proposal.by !== undefined)) fail('menu', `${at}: malformed ${proposal.kind}`);
    counts.set(proposal.kind, (counts.get(proposal.kind) ?? 0) + 1);
    created += outputs.length;
    if (!ADDITIVE_KINDS.includes(proposal.kind)) fail('reversible', `${at}: ${proposal.kind} has no exact inverse in the kernel API`);
    const read = [...sources, ...(typeof proposal.by === 'string' ? [proposal.by] : [])];
    read.forEach((id, position) => { if (!candidates.has(id)) fail('candidate-set', `${at}: source ${position} is outside the candidate set`); });
    for (const output of outputs) if (Array.isArray(output?.dependencies)) read.push(...output.dependencies);
    if (read.some((id) => badCandidates.has(id))) faults[index] = true;
    const sourceRecords = sources.map((id) => candidates.get(id)).filter((record): record is MemoryRecord => record !== undefined);
    let outputBytes = 0;
    outputs.forEach((output, position) => {
      const where = `${at} output ${position}`;
      if (!output || typeof output.text !== 'string' || !output.text.trim() || !KINDS.includes(output.kind) || output.kind === 'checkpoint' || !TRUSTS.includes(output.trust)) { fail('menu', `${where}: malformed output`); return; }
      outputBytes += Buffer.byteLength(output.text);
      const dependencies = output.dependencies ?? sources;
      if (!Array.isArray(dependencies) || !dependencies.length || new Set(dependencies).size !== dependencies.length) { fail('menu', `${where}: dependencies must be a nonempty unique list`); return; }
      const declared: MemoryRecord[] = [];
      dependencies.forEach((id, slot) => {
        const record = candidates.get(id);
        if (!record) fail('candidate-set', `${where}: dependency ${slot} leaves the candidate set`);
        else declared.push(record);
      });
      if (!declared.length) return;
      const floor = Math.min(...declared.map((record) => TRUST_LEVEL[record.trust]), ...sourceRecords.map((record) => TRUST_LEVEL[record.trust]));
      if (TRUST_LEVEL[output.trust] > floor) fail('no-trust-raise', `${where}: ${output.trust} exceeds its sources' trust`);
      const covered = new Set(declared.flatMap((record) => [...tokenSet(record.text)]));
      const undeclared = [...tokenSet(output.text)].filter((token) => !covered.has(token));
      if (undeclared.length) fail('declared-content', `${where}: ${undeclared.length} token(s) not found in its declared sources`);
      if (isPolicy(output.kind) && TRUST_LEVEL[output.trust] >= TRUST_LEVEL.observed) {
        if ([...declared, ...sourceRecords].some((record) => record.trust === 'untrusted')) fail('no-untrusted-to-policy', `${where}: ${output.kind} at ${output.trust} from an untrusted source`);
        else if (undeclared.some((token) => untrustedTokens.has(token))) fail('no-untrusted-to-policy', `${where}: ${output.kind} at ${output.trust} carries content found only in untrusted records`);
        if (!declared.some((record) => record.kind === output.kind)) fail('no-policy-escalation', `${where}: ${output.kind} output from sources of other kinds`);
      }
    });
    // One separator byte per source: a union of N texts joined by spaces is not growth.
    const sourceBytes = sourceRecords.reduce((total, record) => total + Buffer.byteLength(record.text), 0) + sourceRecords.length;
    if (outputBytes > sourceBytes) fail('source-budget', `${at}: outputs (${outputBytes} B) exceed sources plus separators (${sourceBytes} B)`);
  });
  current = undefined;
  for (const [kind, count] of counts) if (count > (caps[kind as keyof ConsolidationCaps] ?? 0)) fail('caps', `${count} ${kind} proposal(s) exceed the cap of ${caps[kind as keyof ConsolidationCaps] ?? 0}`);
  if (created > MAX_CREATED) fail('caps', `${created} outputs exceed the per-pass maximum of ${MAX_CREATED}`);
  if (!diff.proposals.length) fail('menu', 'the diff proposes nothing');
  return {
    invariants: INVARIANT_NAMES.map((name) => (failures.has(name) ? { name, ok: false, detail: failures.get(name)! } : { name, ok: true })),
    faults: faults.map((fault) => fault || passFault),
  };
}
