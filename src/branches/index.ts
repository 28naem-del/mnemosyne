import { createHash, randomUUID } from 'node:crypto';
import type { LocalMemory, MemoryRecord, MemorySource, StoreMemoryInput } from '../local/index.js';
import * as v from '../local/validation.js';

export type BranchChange = { operation: 'add'; input: StoreMemoryInput } | {
  operation: 'correct'; id: string; text: string; source: MemorySource; reason: string;
};
interface BranchState {
  name: string;
  base: { id: string; fingerprint: string }[];
  changes: BranchChange[];
  status: 'draft' | 'merged';
  resultIds?: string[];
}
export interface BranchPreview {
  branchId: string; name: string; status: 'draft' | 'merged'; changes: BranchChange[];
  conflicts: { id: string; reason: string }[]; canMerge: boolean;
}

/** Branches are isolated proposals. Merge rechecks source state inside one transaction. */
export class MemoryBranches {
  constructor(readonly memory: LocalMemory) {}

  #receipt(id: string): MemoryRecord | undefined {
    let cursor: string | undefined;
    do {
      const page = this.memory.list({ limit: 1000, cursor, includeInactive: true, includeUntrusted: true, metadata: { component: 'branch', mergedFrom: id } });
      const owned = page.items.find(item => item.agentId === this.memory.agentId);
      if (owned) return owned;
      cursor = page.nextCursor;
    } while (cursor);
    return undefined;
  }

  #fingerprint(record: MemoryRecord): string {
    return createHash('sha256').update(v.canonical({ record, outcomes: this.memory.getOutcomeSummary(record.id) })).digest('hex');
  }

  #read(id: string): { record: MemoryRecord; state: BranchState } {
    const record = this.memory.get(id);
    if (!record || record.agentId !== this.memory.agentId || record.metadata.component !== 'branch') throw new Error('Branch not found');
    const state = JSON.parse(record.text) as BranchState;
    v.string(state.name, 'branch name', 160);
    if (!Array.isArray(state.base) || state.base.length > 64 || !Array.isArray(state.changes) || state.changes.length > 32 || !['draft', 'merged'].includes(state.status)) throw new Error('Invalid branch state');
    for (const base of state.base) {
      v.string(base.id, 'base id', 160);
      if (typeof base.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(base.fingerprint)) throw new Error('Invalid base fingerprint');
    }
    if (new Set(state.base.map(base => base.id)).size !== state.base.length) throw new Error('Duplicate base IDs');
    if (state.resultIds !== undefined) v.strings(state.resultIds, 'resultIds', 32);
    return { record, state };
  }

  create(input: { name: string; baseIds: string[] }): MemoryRecord {
    const name = v.string(input.name, 'name', 160);
    const ids = v.strings(input.baseIds, 'baseIds', 64);
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate base IDs');
    return this.memory.atomic(() => {
      const base = ids.map(id => {
        const record = this.memory.get(id);
        if (!record || !this.memory.isEligible(id)) throw new Error('Branch base is unavailable or conflicted');
        return { id, fingerprint: this.#fingerprint(record) };
      });
      const state: BranchState = { name, base, changes: [], status: 'draft' };
      return this.memory.store({ kind: 'observation', text: JSON.stringify(state), trust: 'observed',
        source: { uri: `mnemosyne:branch:${randomUUID()}` }, dependencies: ids,
        metadata: { component: 'branch', advisory: false } });
    });
  }

  stage(id: string, changes: BranchChange[]): MemoryRecord {
    if (!Array.isArray(changes) || changes.length > 32) throw new Error('A branch accepts at most 32 changes');
    return this.memory.atomic(() => {
      const { record, state } = this.#read(id);
      if (record.status !== 'active' || state.status !== 'draft' || this.#receipt(id)) throw new Error('Branch is not editable');
      const baseIds = new Set(state.base.map(base => base.id));
      const targets = new Set<string>();
      const normalized = changes.map(change => {
        const obj = v.object(change, 'branch change');
        if (change.operation === 'add') {
          v.keys(obj, ['operation', 'input'], 'branch change');
          const input = v.storeInput(change.input);
          if (input.trust === 'verified' || input.kind === 'checkpoint') throw new Error('Branches cannot self-certify evidence or replace typed checkpoints');
          if (input.dependencies.some(dependency => !baseIds.has(dependency))) throw new Error('Every dependency must be in the captured branch base');
          return { operation: 'add' as const, input };
        }
        if (change.operation !== 'correct') throw new Error('Unknown branch operation');
        v.keys(obj, ['operation', 'id', 'text', 'source', 'reason'], 'branch change');
        if (!baseIds.has(change.id) || targets.has(change.id)) throw new Error('Correction target must be unique and present in the branch base');
        targets.add(change.id);
        const target = this.memory.get(change.id);
        if (!target || target.agentId !== this.memory.agentId || target.trust === 'verified' || target.metadata.advisory === false || ['skill', 'model'].includes(String(target.metadata.runtimeType))) throw new Error('Correction requires owned ordinary, non-verified evidence');
        return { operation: 'correct' as const, id: change.id, text: v.string(change.text, 'text', 16_000), source: v.source(change.source), reason: v.string(change.reason, 'reason', 4096) };
      });
      // An addition depending on a source corrected in this merge would be stale at birth.
      for (const change of normalized) if (change.operation === 'add' && change.input.dependencies?.some(dependency => targets.has(dependency))) throw new Error('Split corrections and dependent additions into separate branches');
      return this.memory.correct(id, { text: JSON.stringify({ ...state, changes: normalized }), source: record.source, reason: 'Staged branch changes' });
    });
  }

  preview(id: string): BranchPreview {
    const receipt = this.#receipt(id);
    if (receipt) return this.preview(receipt.id);
    const { record, state } = this.#read(id);
    const conflicts: BranchPreview['conflicts'] = [];
    if (state.status !== 'merged') {
      if (record.status !== 'active') conflicts.push({ id, reason: 'Branch was superseded or its evidence changed' });
      for (const base of state.base) {
        const current = this.memory.get(base.id);
        if (!current || !this.memory.isEligible(base.id) || this.#fingerprint(current) !== base.fingerprint) conflicts.push({ id: base.id, reason: 'Source revision, eligibility or outcome changed' });
      }
    }
    return { branchId: id, name: state.name, status: state.status, changes: state.changes, conflicts,
      canMerge: state.status === 'draft' && state.changes.length > 0 && conflicts.length === 0 };
  }

  merge(id: string): { branch: MemoryRecord; memories: MemoryRecord[]; replayed: boolean } {
    return this.memory.atomic(() => {
      const receipt = this.#receipt(id);
      if (receipt) {
        const completed = this.#read(receipt.id);
        return { branch: receipt, memories: (completed.state.resultIds ?? []).map(result => this.memory.get(result)).filter((item): item is MemoryRecord => item !== null), replayed: true };
      }
      const { record, state } = this.#read(id);
      if (state.status === 'merged') return { branch: record, memories: (state.resultIds ?? []).map(result => this.memory.get(result)).filter((item): item is MemoryRecord => item !== null), replayed: true };
      if (!this.preview(id).canMerge) throw new Error('Branch has conflicts, is empty or is no longer active');
      const baseIds = new Set(state.base.map(base => base.id));
      const targets = new Set<string>();
      // Persisted control state is data too. Never rely on stage() being its only writer.
      for (const change of state.changes) {
        const obj = v.object(change, 'branch change');
        if (change.operation === 'add') {
          v.keys(obj, ['operation', 'input'], 'branch change');
          const input = v.storeInput(change.input);
          if (input.trust === 'verified' || input.kind === 'checkpoint' || input.dependencies.some(dependency => !baseIds.has(dependency))) throw new Error('Invalid branch addition');
        } else if (change.operation === 'correct') {
          v.keys(obj, ['operation', 'id', 'text', 'source', 'reason'], 'branch change');
          const target = this.memory.get(change.id);
          if (!baseIds.has(change.id) || targets.has(change.id) || !target || target.agentId !== this.memory.agentId || target.trust === 'verified' || target.kind === 'checkpoint' || target.metadata.advisory === false || ['skill', 'model'].includes(String(target.metadata.runtimeType))) throw new Error('Invalid branch correction');
          targets.add(change.id);
          v.string(change.text, 'text', 16_000); v.source(change.source); v.string(change.reason, 'reason', 4096);
        } else throw new Error('Unknown branch operation');
      }
      for (const change of state.changes) if (change.operation === 'add' && change.input.dependencies?.some(dependency => targets.has(dependency))) throw new Error('Dependent additions require a subsequent branch');
      // Closing the draft is durable even if a result is later forgotten together
      // with its receipt. An old draft can never recreate forgotten merge output.
      this.memory.correct(id, { text: JSON.stringify({ ...state, status: 'merged' }), source: record.source, reason: 'Branch committed' });
      const memories = state.changes.map((change, index) => change.operation === 'add'
        ? this.memory.store({ ...change.input, idempotencyKey: `branch:${id}:${index}` })
        : this.memory.correct(change.id, { text: change.text, source: change.source, reason: change.reason }));
      // Correcting a base invalidates this branch. Store its merge receipt separately,
      // with links to resulting evidence, instead of mutating invalid history.
      const mergeReceipt = this.memory.store({ kind: 'observation', trust: memories.some(item => item.trust === 'untrusted') ? 'untrusted' : 'observed',
        text: JSON.stringify({ ...state, status: 'merged', resultIds: memories.map(item => item.id) }),
        source: record.source, dependencies: memories.map(item => item.id),
        metadata: { component: 'branch', advisory: false, mergedFrom: id }, idempotencyKey: `branch-receipt:${id}` });
      return { branch: mergeReceipt, memories, replayed: false };
    });
  }
}
