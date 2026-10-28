/**
 * Model-free proposal heuristics and candidate selection.
 *
 * The default proposer is deterministic: the same candidates always yield the
 * same proposals, so a pass is reproducible and its digest is stable. A caller
 * may supply its own synchronous proposer; nothing here loads a model or
 * touches the network.
 */
import { createHash } from 'node:crypto';
import type { LocalMemory } from '../local/index.js';
import { tokenize } from '../local/granularity.js';
import type { MemoryRecord, MemoryTrust } from '../local/types.js';
import { canonicalize } from '../local/replay.js';
import type { ConsolidationCaps, ConsolidationKind, ConsolidationProposal, ConsolidationProposerInput } from './types.js';

export const TRUST_LEVEL: Record<MemoryTrust, number> = { untrusted: 0, observed: 1, verified: 2 };
export const POLICY_KINDS = ['procedure', 'decision'] as const;

/** Defaults are small on purpose (P8): a pass the gate cannot attribute is a pass it cannot judge. */
export const DEFAULT_CONSOLIDATION_CAPS: Readonly<ConsolidationCaps> = Object.freeze({ merge: 8, abstract: 4, split: 4, supersede: 8, delete: 8 });

/** Maximum records one pass may create; also bounds the receipt size. */
export const MAX_CREATED = 64;

export const tokenSet = (text: string): Set<string> => new Set(tokenize(text));

/** Splits on sentence punctuation followed by space; keeps the punctuation. */
export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/u).map((part) => part.trim()).filter(Boolean);
}

const byAge = (a: MemoryRecord, b: MemoryRecord): number => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const isDerived = (record: MemoryRecord): boolean => typeof record.metadata.consolidationPass === 'string';

/** Why a record may never enter a candidate set, or null when it may. */
export function untouchable(record: MemoryRecord, agentId: string): string | null {
  if (record.agentId !== agentId) return 'not owned by this agent';
  if (record.status !== 'active') return 'not active';
  if (record.trust === 'verified') return 'verified';
  if (record.kind === 'checkpoint') return 'checkpoint';
  if (record.metadata.advisory === false) return 'advisory:false control record';
  if (isDerived(record)) return 'already a consolidation output';
  return null;
}

/**
 * Whether a record is usable as a source at the cut: visible, and not
 * withheld from recall for a reason consolidation must not launder away
 * (a recorded failure, an inactive dependency, a key conflict). Untrusted
 * records are allowed as sources, but their outputs stay untrusted.
 */
export function usableSource(memory: LocalMemory, record: MemoryRecord, cut: string): boolean {
  if (!memory.getAt(record.id, { knownAt: cut })) return false;
  if (record.trust !== 'untrusted') return memory.isEligible(record.id, { knownAt: cut });
  if (memory.getOutcomeSummary(record.id).failures > 0) return false;
  return record.dependencies.every((id) => { const dependency = memory.get(id); return dependency !== null && dependency.status === 'active'; });
}

/** Owned, active, usable records in a stable order. */
export function selectCandidates(memory: LocalMemory, cut: string): MemoryRecord[] {
  const records: MemoryRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = memory.list({ limit: 1000, includeUntrusted: true, ...(cursor === undefined ? {} : { cursor }) });
    for (const record of page.items) if (untouchable(record, memory.agentId) === null && usableSource(memory, record, cut)) records.push(record);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return records.sort(byAge);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  const union = a.size + b.size - shared;
  return union ? shared / union : 0;
}

const minTrust = (records: readonly MemoryRecord[]): MemoryTrust => records.reduce<MemoryTrust>((low, record) => (TRUST_LEVEL[record.trust] < TRUST_LEVEL[low] ? record.trust : low), 'verified');

/** Sentence-level union in source order: every source sentence survives, exact repeats once. */
function unionText(records: readonly MemoryRecord[]): string {
  const seen = new Set<string>(), kept: string[] = [];
  for (const record of records) for (const sentence of sentences(record.text)) {
    const normal = tokenize(sentence).join(' ');
    if (!seen.has(normal)) { seen.add(normal); kept.push(sentence); }
  }
  return kept.join(' ');
}

export interface DeterministicProposerOptions {
  /** Token Jaccard at or above which two same-kind, same-trust records merge. Default 0.6. */
  mergeThreshold?: number;
  /** Also emit supersede/delete. They are scored but never kept in v1 (no exact inverse in the kernel). Default false. */
  removals?: boolean;
}

/**
 * merge: near-duplicate records of one kind and trust; abstract: three or more
 * records from one source URI, as an observation; split: one long multi-sentence
 * record into its sentences. Outputs reuse source sentences verbatim, so every
 * output token is covered by its declared sources.
 */
export function deterministicProposer(options: DeterministicProposerOptions = {}): (input: ConsolidationProposerInput) => ConsolidationProposal[] {
  const threshold = options.mergeThreshold ?? 0.6;
  if (typeof threshold !== 'number' || !(threshold > 0 && threshold <= 1)) throw new TypeError('mergeThreshold must be in (0, 1]');
  const removals = options.removals === true;
  return ({ candidates, caps }) => {
    const proposals: ConsolidationProposal[] = [];
    const count: Record<ConsolidationKind, number> = { merge: 0, abstract: 0, split: 0, supersede: 0, delete: 0 };
    const push = (proposal: ConsolidationProposal): void => { if (count[proposal.kind] < caps[proposal.kind]) { count[proposal.kind]++; proposals.push(proposal); } };
    const ordered = [...candidates].sort(byAge);
    const tokens = new Map(ordered.map((record) => [record.id, tokenSet(record.text)]));
    const merged = new Set<string>();
    for (let i = 0; i < ordered.length; i++) {
      const seed = ordered[i];
      if (merged.has(seed.id)) continue;
      const group = [seed];
      for (let j = i + 1; j < ordered.length && group.length < 8; j++) {
        const other = ordered[j];
        if (merged.has(other.id) || other.kind !== seed.kind || other.trust !== seed.trust) continue;
        if (group.every((member) => jaccard(tokens.get(member.id)!, tokens.get(other.id)!) >= threshold)) group.push(other);
      }
      if (group.length < 2) continue;
      for (const member of group) merged.add(member.id);
      push({ kind: 'merge', sources: group.map((record) => record.id), outputs: [{ text: unionText(group), kind: seed.kind, trust: minTrust(group) }], rationale: `near-duplicate ${seed.kind} records (token Jaccard >= ${threshold})` });
      if (removals) for (const member of group.slice(0, -1)) {
        if (tokenize(member.text).join(' ') === tokenize(group[group.length - 1].text).join(' ')) push({ kind: 'supersede', sources: [member.id], outputs: [], by: group[group.length - 1].id, rationale: 'exact duplicate of a newer record' });
      }
    }
    const bySource = new Map<string, MemoryRecord[]>();
    for (const record of ordered) if (!merged.has(record.id)) bySource.set(record.source.uri, [...(bySource.get(record.source.uri) ?? []), record]);
    for (const group of bySource.values()) {
      if (group.length < 3) continue;
      const members = group.slice(0, 8);
      push({ kind: 'abstract', sources: members.map((record) => record.id), outputs: [{ text: unionText(members), kind: 'observation', trust: minTrust(members) }], rationale: 'three or more records from one source' });
    }
    for (const record of ordered) {
      const parts = sentences(record.text);
      if (parts.length < 3 || Buffer.byteLength(record.text) < 240) continue;
      push({ kind: 'split', sources: [record.id], outputs: parts.slice(0, 8).map((text) => ({ text, kind: record.kind, trust: record.trust })), rationale: 'long multi-sentence record' });
    }
    if (removals) {
      const depended = new Set(ordered.flatMap((record) => record.dependencies));
      for (const record of ordered) if (record.trust === 'untrusted' && !depended.has(record.id)) push({ kind: 'delete', sources: [record.id], outputs: [], rationale: 'untrusted record nothing depends on' });
    }
    return proposals;
  };
}

/** Stable identity of a proposal for backoff: kind, sources and outputs. */
export function proposalSha256(proposal: ConsolidationProposal, fingerprints: ReadonlyMap<string, string>): string {
  return createHash('sha256').update('mnemosyne-consolidation-proposal-v1\n').update(canonicalize({
    kind: proposal.kind, sources: proposal.sources.map((id) => fingerprints.get(id) ?? id), by: proposal.by === undefined ? undefined : fingerprints.get(proposal.by) ?? proposal.by,
    outputs: proposal.outputs.map((output) => ({ text: output.text, kind: output.kind, trust: output.trust, key: output.key, dependencies: output.dependencies?.map((id) => fingerprints.get(id) ?? id) })),
  })).digest('hex');
}
