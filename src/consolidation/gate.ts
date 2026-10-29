/**
 * The consolidation gate: propose a signed diff, replay the recorded outcomes
 * under S and S+D on scratch copies, keep only what does not regress and
 * breaks no invariant, apply kept passes as exact additions, and undo them
 * with one call. Every decision is a chained, signed ledger receipt.
 */
import { createHash } from 'node:crypto';
import { createLocalMemory, RollbackConflictError, type LocalMemory } from '../local/index.js';
import { canonicalize, replayState } from '../local/replay.js';
import type { LedgerConsolidation, MemoryRecord } from '../local/types.js';
import * as v from '../local/validation.js';
import { checkInvariants } from './invariants.js';
import { DEFAULT_CONSOLIDATION_CAPS, deterministicProposer, isDerived, proposalSha256, selectCandidates, tokenSet } from './proposer.js';
import { buildReplaySet, ledgerEntries, splitHoldout } from './replay-set.js';
import { diffSignatureMessage, receiptSignatureMessage, verifyConsolidationSignature, type ConsolidationSigner } from './signing.js';
import {
  CONSOLIDATION_KINDS,
  type ConsolidationCaps, type ConsolidationCreated, type ConsolidationDiff, type ConsolidationInvariant, type ConsolidationProposal,
  type ConsolidationProposer, type ConsolidationReceipt, type ConsolidationScores, type ConsolidationTaskScores, type ConsolidationVerdict, type ReplayTask,
} from './types.js';

export const CONSOLIDATION_GATE_VERSION = 'mnemosyne-consolidation-gate-v1';

/** Identity of the scoring code: change any rule below and this digest changes with it. */
export const CONSOLIDATION_VERIFIER_SHA256 = createHash('sha256').update([
  CONSOLIDATION_GATE_VERSION,
  'score: per task, gold ids covered by the lexical top-k minus harmful ids covered; a derived record covers a source whose tokens it contains',
  'replay: export -> fresh :memory: lexical store -> import -> (apply diff); recorded query, limit and lexical scoring',
  'view: a task whose gold, harmful or recorded result ids include a record live recall can read but the export lacks is unreplayable',
  'apply: the replay set is rebuilt inside the apply transaction; any change to it since scoring is a conflict',
  'holdout: 20% by sha256(holdout\\n<sequence>\\n<taskId>) when at least 10 tasks; must not regress',
  'keep: invariants hold, at least 2 replayable tasks, delta >= 0, holdout delta >= 0, every proposal alone delta >= 0 over all tasks',
].join('\n')).digest('hex');

export const MIN_REPLAY_TASKS = 2;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const DIFF_PREFIX = 'mnemosyne-consolidation-diff-v1\n';
const RECEIPT_PREFIX = 'mnemosyne-consolidation-receipt-v1\n';

export function diffDigest(diff: Omit<ConsolidationDiff, 'digest' | 'signature'> & Partial<Pick<ConsolidationDiff, 'digest' | 'signature'>>): string {
  const { digest: _digest, signature: _signature, ...body } = diff;
  return sha256(DIFF_PREFIX + canonicalize(body));
}

export function receiptDigest(receipt: Omit<ConsolidationReceipt, 'digest' | 'receiptSignature'> & Partial<Pick<ConsolidationReceipt, 'digest' | 'receiptSignature'>>): string {
  const { digest: _digest, receiptSignature: _signature, ...body } = receipt;
  return sha256(RECEIPT_PREFIX + canonicalize(body));
}

const passIdFor = (prevDigest: string | null, material: string): string => `cpass_${sha256(`${prevDigest ?? 'genesis'}\n${material}`).slice(0, 32)}`;

function resolveCaps(caps: unknown): ConsolidationCaps {
  if (caps === undefined) return { ...DEFAULT_CONSOLIDATION_CAPS };
  const input = v.object(caps, 'caps');
  v.keys(input, CONSOLIDATION_KINDS, 'caps');
  const resolved = { ...DEFAULT_CONSOLIDATION_CAPS };
  for (const [kind, value] of Object.entries(input)) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 64) throw new TypeError(`caps.${kind} must be an integer between 0 and 64`);
    resolved[kind as keyof ConsolidationCaps] = value;
  }
  return resolved;
}

/** The store clock, read the only public way: a snapshot's export time. */
function snapshotAt(memory: LocalMemory) {
  const snapshot = memory.export();
  return { snapshot, cut: snapshot.exportedAt };
}

const stateAt = (memory: LocalMemory, knownAt: string): string => replayState(memory, { knownAt }).stateSha256;

export interface StoredReceipt { ledgerId: string; sequence: number; recordedAt: string; receipt: ConsolidationReceipt }

/**
 * The highest ledger sequence in this scope. The ledger reads oldest first
 * only, so this searches on "is there an entry after x" with one-row reads,
 * O(log n), instead of paging the whole ledger.
 */
function ledgerHighWater(memory: LocalMemory): number {
  const after = (sequence: number): boolean => memory.ledger({ after: sequence, limit: 1 }).entries.length > 0;
  if (!after(0)) return 0;
  let low = 0, high = 1, step = 1;
  while (after(high)) { low = high; step *= 2; high += step; }
  while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (after(mid)) low = mid; else high = mid; }
  return high;
}

/** Non-consolidation ledger writes in this scope after `sequence`, counted up to 1000. */
function writesAfter(memory: LocalMemory, sequence: number): { count: number; capped: boolean } {
  const page = memory.ledger({ after: sequence, limit: 1000 });
  return { count: page.entries.filter((entry) => entry.event !== 'consolidation').length, capped: page.nextCursor !== undefined };
}

/** Which keys a caller trusts: the caller's own signer unless it explicitly opts out with `'any'`. */
function trustedKeys(value: unknown, signer: ConsolidationSigner): readonly string[] | undefined {
  if (value === 'any') return undefined;
  if (value === undefined) return [signer.keyId];
  return v.strings(value, 'trustedKeyIds', 64, 64);
}

/** Null when a receipt's digest, its signature and the diff signature it carries all check out; otherwise what failed. */
export function receiptProblem(receipt: ConsolidationReceipt): string | null {
  if (receipt?.schema !== 'mnemosyne-consolidation-receipt-v1') return 'unknown receipt schema';
  if (receiptDigest(receipt) !== receipt.digest) return 'digest does not match the receipt';
  if (!verifyConsolidationSignature(receiptSignatureMessage(receipt.digest), receipt.receiptSignature)) return 'receipt signature does not verify';
  if (receipt.signature !== null && (receipt.candidateDiffSha256 === null || !verifyConsolidationSignature(diffSignatureMessage(receipt.candidateDiffSha256), receipt.signature))) return 'diff signature does not verify';
  return null;
}

/** Every consolidation receipt in this scope, oldest first. */
export function consolidationReceipts(memory: LocalMemory): StoredReceipt[] {
  return ledgerEntries(memory, ['consolidation']).map((entry) => ({ ledgerId: entry.id, sequence: entry.sequence, recordedAt: entry.recordedAt, receipt: entry.consolidation as unknown as ConsolidationReceipt }));
}

const chainHead = (memory: LocalMemory): string | null => {
  const receipts = consolidationReceipts(memory);
  const last = receipts[receipts.length - 1];
  return last && typeof last.receipt?.digest === 'string' ? last.receipt.digest : null;
};

export interface ProposeConsolidationOptions {
  signer: ConsolidationSigner;
  /** Defaults to the deterministic, model-free proposer. */
  proposer?: ConsolidationProposer;
  /** Recorded in the diff; defaults to `deterministic-v1` or `caller`. */
  proposerName?: string;
  caps?: Partial<ConsolidationCaps>;
  /** Skip proposals a rolled-back pass contained until the replay set has doubled (P8). Default true. */
  backoff?: boolean;
}

/** Builds and signs a diff over the current state, or returns null when there is nothing to propose. */
export function proposeConsolidation(memory: LocalMemory, options: ProposeConsolidationOptions): ConsolidationDiff | null {
  const input = v.object(options, 'consolidation propose options');
  v.keys(input, ['signer', 'proposer', 'proposerName', 'caps', 'backoff'], 'consolidation propose options');
  if (!options.signer || typeof options.signer.sign !== 'function') throw new TypeError('A consolidation signer is required');
  if (options.proposer !== undefined && typeof options.proposer !== 'function') throw new TypeError('proposer must be a function');
  const caps = resolveCaps(options.caps);
  const backoff = v.boolean(options.backoff, true);
  const proposerName = options.proposerName === undefined ? (options.proposer ? 'caller' : 'deterministic-v1') : v.string(options.proposerName, 'proposerName', 160);
  const { cut } = snapshotAt(memory);
  const candidates = selectCandidates(memory, cut);
  const proposer = options.proposer ?? deterministicProposer();
  let proposals = proposer({ candidates: candidates.map((record) => structuredClone(record)), caps: Object.freeze({ ...caps }) });
  if (!Array.isArray(proposals)) throw new TypeError('A proposer must return an array of proposals');
  proposals = structuredClone(proposals);
  const allowed = new Map(candidates.map((record) => [record.id, record]));
  const fingerprints = new Map<string, string>();
  for (const proposal of proposals) for (const id of referenced(proposal)) {
    if (allowed.has(id) && !fingerprints.has(id)) fingerprints.set(id, memory.getRecordFingerprint(id)!);
  }
  const receipts = consolidationReceipts(memory);
  // A kept proposal still in force is not proposed again; after its rollback it may be.
  const undone = new Set(receipts.filter(({ receipt }) => receipt.action === 'rollback' && receipt.verdict === 'rolled_back').map(({ receipt }) => receipt.rollbackOf));
  const applied = new Set(receipts.filter(({ receipt }) => receipt.action === 'gate' && receipt.verdict === 'kept' && !undone.has(receipt.passId)).flatMap(({ receipt }) => receipt.proposals.map((proposal) => proposal.proposalSha256)));
  proposals = proposals.filter((proposal) => !applied.has(proposalSha256(proposal, fingerprints)));
  if (backoff) {
    const tasks = buildReplaySet(memory).tasks.length;
    const blocked = new Map<string, number>();
    for (const { receipt } of receipts) {
      if (receipt.action !== 'gate' || receipt.verdict !== 'rolled_back') continue;
      const evidence = (receipt.scores?.tasks ?? 0) + (receipt.scores?.holdout?.tasks ?? 0);
      for (const proposal of receipt.proposals) if (proposal.fault !== false) blocked.set(proposal.proposalSha256, Math.max(blocked.get(proposal.proposalSha256) ?? 0, evidence));
    }
    proposals = proposals.filter((proposal) => {
      const at = blocked.get(proposalSha256(proposal, fingerprints));
      return at === undefined || tasks >= 2 * Math.max(at, 1);
    });
  }
  if (!proposals.length) return null;
  const candidateSet = [...fingerprints].map(([id, fingerprint]) => ({ id, fingerprint })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const body: Omit<ConsolidationDiff, 'digest' | 'signature'> = {
    schema: 'mnemosyne-consolidation-diff-v1', workspaceId: memory.workspaceId, agentId: memory.agentId, cut,
    stateBefore: stateAt(memory, cut), candidateSet, proposals, proposer: proposerName,
  };
  const digest = diffDigest(body);
  return { ...body, digest, signature: options.signer.sign(diffSignatureMessage(digest)) };
}

function referenced(proposal: ConsolidationProposal): string[] {
  const ids = [...(Array.isArray(proposal?.sources) ? proposal.sources : []), ...(typeof proposal?.by === 'string' ? [proposal.by] : [])];
  for (const output of Array.isArray(proposal?.outputs) ? proposal.outputs : []) if (Array.isArray(output?.dependencies)) ids.push(...output.dependencies);
  return ids.filter((id) => typeof id === 'string');
}

/**
 * Applies a diff's additive proposals as new private records that declare
 * their sources as dependencies, so a later forget() or correct() of a source
 * reaches the output through the kernel's own cascade. On a scratch copy the
 * removal kinds are simulated with forget() so they can be scored; they never
 * reach a live store (the `reversible` invariant).
 */
function applyDiff(store: LocalMemory, diff: ConsolidationDiff, passId: string, scratch: boolean): ConsolidationCreated[] {
  const created: ConsolidationCreated[] = [];
  diff.proposals.forEach((proposal, index) => {
    if (proposal.kind === 'delete' || proposal.kind === 'supersede') {
      if (!scratch) throw new Error(`${proposal.kind} cannot be applied to a live store`);
      for (const id of proposal.sources) if (store.get(id)) store.forget(id);
      return;
    }
    for (const output of proposal.outputs) {
      const dependencies = output.dependencies ?? proposal.sources;
      const bounds = dependencies.map((id) => store.get(id)?.validUntil).filter((value): value is string => typeof value === 'string').sort();
      const record = store.store({
        text: output.text, kind: output.kind, trust: output.trust, visibility: 'private', dependencies: [...dependencies],
        source: { uri: `consolidation:${passId}`, revision: diff.digest },
        ...(output.key === undefined ? {} : { key: output.key }),
        // A consolidated record must not outlive the sources it restates.
        ...(bounds.length ? { validUntil: bounds[0] } : {}),
        metadata: { consolidationPass: passId, consolidationKind: proposal.kind, consolidationProposal: index },
      });
      created.push({ id: record.id, fingerprint: store.getRecordFingerprint(record.id)!, proposal: index });
    }
  });
  return created;
}

/** Gold ids covered by the top-k minus harmful ids covered. A derived record covers a source whose every token it carries. */
function scoreTask(store: LocalMemory, task: ReplayTask): number {
  const top = store.recall({ query: task.query, limit: task.limit, lexicalScoring: task.lexicalScoring }).map((result) => result.memory);
  const covered = new Set(top.map((record) => record.id));
  const carried = new Map<string, Set<string>>();
  for (const record of top) {
    if (!isDerived(record)) continue;
    const tokens = tokenSet(record.text);
    for (const id of record.dependencies) carried.set(id, new Set([...(carried.get(id) ?? []), ...tokens]));
  }
  for (const [id, tokens] of carried) {
    const source = store.get(id);
    if (source && [...tokenSet(source.text)].every((token) => tokens.has(token))) covered.add(id);
  }
  return task.gold.filter((id) => covered.has(id)).length - task.harmful.filter((id) => covered.has(id)).length;
}

const total = (store: LocalMemory, tasks: readonly ReplayTask[]): number => tasks.reduce((sum, task) => sum + scoreTask(store, task), 0);
const tasksTotal = (scores: ConsolidationScores): number => scores.tasks + (scores.holdout?.tasks ?? 0);

/**
 * Splits the replay set into the tasks a scratch copy can replay faithfully
 * and the rest. The scratch copy holds only this agent's exported records, so
 * a task whose gold, harmful or recorded result ids include a record that live
 * recall can read but the snapshot lacks (a record another agent shared with
 * the workspace, or an own record the export omitted because it depends on
 * one) was ranked live against records the replay cannot see. Such a task is
 * counted as unreplayable instead of being scored as a miss under S and S+D.
 */
function replayableTasks(memory: LocalMemory, snapshot: Snapshot, tasks: readonly ReplayTask[]): { tasks: ReplayTask[]; outside: number } {
  const present = new Set(snapshot.memories.map((record) => record.id));
  const missing = (id: string): boolean => !present.has(id) && memory.get(id) !== null;
  const replayable: ReplayTask[] = [];
  let outside = 0;
  for (const task of tasks) {
    const entry = memory.ledger({ after: task.sequence - 1, limit: 1 }).entries[0];
    if (entry?.id !== task.ledgerId) { outside++; continue; }
    const ids = [...task.gold, ...task.harmful, ...(entry.retrieval?.results ?? []).map((result) => result.memoryId)];
    if (ids.some(missing)) outside++; else replayable.push(task);
  }
  return { tasks: replayable, outside };
}

interface Replay { scores: ConsolidationScores | null; error?: string; applyError?: string }

type Snapshot = ReturnType<LocalMemory['export']>;

/** A fresh lexical store frozen at the cut, with the snapshot imported unless `empty`. */
function scratchStore(memory: LocalMemory, snapshot: Snapshot, cut: string, empty = false): LocalMemory {
  const scratch = createLocalMemory({ path: ':memory:', workspaceId: memory.workspaceId, agentId: memory.agentId, retrieval: 'lexical', ledger: false, now: () => new Date(cut) });
  try { if (!empty) scratch.import(structuredClone(snapshot)); return scratch; } catch (error) { scratch.close(); throw error; }
}

function withScratch<T>(memory: LocalMemory, snapshot: Snapshot, cut: string, empty: boolean, work: (scratch: LocalMemory) => T): T {
  const scratch = scratchStore(memory, snapshot, cut, empty);
  try { return work(scratch); } finally { scratch.close(); }
}

class ScratchApplyError extends Error {}

/**
 * Scores S and S+D on scratch copies, plus the no-memory control on an empty
 * store, plus each proposal alone when there is more than one, so a
 * regressing proposal cannot ride on an improving one.
 */
function replay(memory: LocalMemory, snapshot: Snapshot, cut: string, diff: ConsolidationDiff, passId: string, tasks: ReplayTask[], unreplayable: number): Replay {
  const { main, holdout } = splitHoldout(tasks);
  const apply = (scratch: LocalMemory, proposals: ConsolidationProposal[]): void => {
    try { applyDiff(scratch, { ...diff, proposals }, passId, true); } catch (error) { throw new ScratchApplyError(error instanceof Error ? error.message : String(error)); }
  };
  try {
    const noMemory = withScratch(memory, snapshot, cut, true, (scratch) => total(scratch, tasks));
    const [before, heldBefore, after, heldAfter] = withScratch(memory, snapshot, cut, false, (scratch) => {
      const scored = [total(scratch, main), total(scratch, holdout)];
      apply(scratch, diff.proposals);
      return [...scored, total(scratch, main), total(scratch, holdout)];
    });
    const perProposal = diff.proposals.length === 1 ? [after + heldAfter - before - heldBefore]
      : diff.proposals.map((proposal) => withScratch(memory, snapshot, cut, false, (scratch) => { apply(scratch, [proposal]); return total(scratch, tasks); }) - before - heldBefore);
    const held: ConsolidationTaskScores | null = holdout.length ? { tasks: holdout.length, before: heldBefore, after: heldAfter, delta: heldAfter - heldBefore } : null;
    return { scores: { tasks: main.length, before, after, delta: after - before, holdout: held, noMemory, unreplayable, perProposal } };
  } catch (error) {
    if (error instanceof ScratchApplyError) return { scores: null, applyError: error.message };
    return { scores: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface GateConsolidationOptions {
  signer: ConsolidationSigner;
  /**
   * Keys whose diffs may be judged. Defaults to `[signer.keyId]`, the gate's
   * own key, so a diff signed by any other key is an `invalid_run`.
   * `'any'` turns pinning off and accepts any diff whose signature verifies
   * against the key embedded in the diff itself. That is UNSAFE: anyone can
   * mint a key and sign a diff with it, so `'any'` proves only that the diff
   * was not altered after signing, never who wrote it.
   */
  trustedKeyIds?: string[] | 'any';
  caps?: Partial<ConsolidationCaps>;
}

export interface ConsolidationResult {
  verdict: ConsolidationVerdict;
  receipt: ConsolidationReceipt;
  ledgerId: string;
  created: ConsolidationCreated[];
}

function seal(body: Omit<ConsolidationReceipt, 'digest' | 'receiptSignature'>, signer: ConsolidationSigner): ConsolidationReceipt {
  const digest = receiptDigest(body);
  return { ...body, digest, receiptSignature: signer.sign(receiptSignatureMessage(digest)) };
}

function append(memory: LocalMemory, receipt: ConsolidationReceipt): string {
  const id = memory.appendLedgerReceipt({ event: 'consolidation', consolidation: receipt as unknown as LedgerConsolidation });
  if (!id) throw new Error('Consolidation requires an enabled ledger: every decision must leave a receipt');
  return id;
}

function verifyDiff(memory: LocalMemory, diff: ConsolidationDiff, trusted: readonly string[] | undefined): string | null {
  try {
    const input = v.object(diff, 'consolidation diff');
    v.keys(input, ['schema', 'workspaceId', 'agentId', 'cut', 'stateBefore', 'candidateSet', 'proposals', 'proposer', 'digest', 'signature'], 'consolidation diff');
    if (diff.schema !== 'mnemosyne-consolidation-diff-v1') return 'unsupported diff schema';
    if (diff.workspaceId !== memory.workspaceId || diff.agentId !== memory.agentId) return 'diff belongs to another scope';
    if (!Array.isArray(diff.candidateSet) || !Array.isArray(diff.proposals)) return 'diff is malformed';
    v.timestamp(diff.cut, 'diff cut');
    if (diffDigest(diff) !== diff.digest) return 'diff digest does not match its content';
    if (!verifyConsolidationSignature(diffSignatureMessage(diff.digest), diff.signature)) return 'diff signature does not verify';
    if (trusted && !trusted.includes(diff.signature.keyId)) return 'diff is signed by a key that is not trusted';
    return null;
  } catch (error) {
    return `diff is malformed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function changedCandidates(memory: LocalMemory, diff: ConsolidationDiff): number {
  return diff.candidateSet.filter((candidate) => memory.getRecordFingerprint(candidate.id) !== candidate.fingerprint).length;
}

/**
 * Judges one signed diff and records the decision. Kept passes are applied
 * live inside the same transaction as their receipt; every other verdict
 * leaves the records untouched and writes only the receipt.
 */
export function gateConsolidation(memory: LocalMemory, diff: ConsolidationDiff, options: GateConsolidationOptions): ConsolidationResult {
  const input = v.object(options, 'consolidation gate options');
  v.keys(input, ['signer', 'trustedKeyIds', 'caps'], 'consolidation gate options');
  if (!options.signer || typeof options.signer.sign !== 'function') throw new TypeError('A consolidation signer is required');
  const trusted = trustedKeys(options.trustedKeyIds, options.signer);
  const caps = resolveCaps(options.caps);
  // Taken before the snapshot, so any write that could be missing from it is after this mark.
  const scoringMark = ledgerHighWater(memory);
  const { snapshot, cut } = snapshotAt(memory);
  const stateNow = stateAt(memory, cut);
  const replaySet = buildReplaySet(memory);
  const view = replayableTasks(memory, snapshot, replaySet.tasks);
  let verdict: ConsolidationVerdict, reason: string;
  let invariants: ConsolidationInvariant[] = [];
  let scores: ConsolidationScores | null = null;
  let faults: boolean[] = [];
  const invalid = verifyDiff(memory, diff, trusted);
  const prior = consolidationReceipts(memory);
  const scoringHead = chainHead(memory);
  const provisional = passIdFor(scoringHead, typeof diff?.digest === 'string' ? diff.digest : 'invalid');
  // A signed diff is single-use: once kept, it is never judged again, even after its rollback restored the state it was signed over.
  const reused = invalid ? undefined : prior.find(({ receipt }) => receipt.action === 'gate' && receipt.verdict === 'kept' && receipt.candidateDiffSha256 === diff.digest);
  if (invalid) { verdict = 'invalid_run'; reason = invalid; }
  else if (reused) { verdict = 'conflict'; reason = `this signed diff was already kept as ${reused.receipt.passId}; a diff is single-use, propose a fresh one`; }
  else if (diff.stateBefore !== stateNow) { verdict = 'conflict'; reason = 'the diff was proposed over a different state than the current one'; }
  else if (changedCandidates(memory, diff)) { verdict = 'conflict'; reason = `${changedCandidates(memory, diff)} candidate record(s) changed since the diff was signed`; }
  else {
    const untrustedTokens = new Set<string>();
    for (const record of snapshot.memories) if (record.trust === 'untrusted') for (const token of tokenSet(record.text)) untrustedTokens.add(token);
    const report = checkInvariants(memory, diff, caps, untrustedTokens);
    invariants = report.invariants;
    faults = report.faults;
    const broken = invariants.filter((invariant) => !invariant.ok);
    const result = replay(memory, snapshot, cut, diff, provisional, view.tasks, replaySet.unreplayable + view.outside);
    scores = result.scores;
    const evidence = scores ? tasksTotal(scores) : view.tasks.length;
    const outside = view.outside ? `; ${view.outside} task(s) read records outside this agent's own records (shared by another agent, or omitted from its export) and were not replayed` : '';
    if (broken.length) { verdict = 'rolled_back'; reason = `invariant violated: ${broken.map((invariant) => invariant.name).join(', ')}`; }
    else if (result.error) { verdict = 'invalid_run'; reason = `scorer failed: ${result.error}`; }
    else if (result.applyError || !scores) { verdict = 'invalid_run'; reason = `scratch apply failed: ${result.applyError ?? 'no scores'}`; }
    else if (evidence < MIN_REPLAY_TASKS) { verdict = 'no_evidence'; reason = `${evidence} replayable task(s); at least ${MIN_REPLAY_TASKS} are required, and no evidence is not a keep${outside}`; }
    else if (scores.delta < 0) { verdict = 'rolled_back'; reason = `regression: outcome delta ${scores.delta} over ${scores.tasks} replayed task(s)`; }
    else if (scores.holdout && scores.holdout.delta < 0) { verdict = 'rolled_back'; reason = `hold-out regression: delta ${scores.holdout.delta} over ${scores.holdout.tasks} held-out task(s)`; }
    else if (scores.perProposal.some((delta) => delta < 0)) {
      const worst = scores.perProposal.map((delta, index) => ({ delta, index })).filter(({ delta }) => delta < 0);
      verdict = 'rolled_back';
      reason = `regression: ${worst.map(({ index, delta }) => `proposal ${index} alone delta ${delta}`).join(', ')} over ${tasksTotal(scores)} task(s)`;
    }
    else { verdict = 'kept'; reason = `outcome delta ${scores.delta} >= 0 over ${scores.tasks} replayed task(s)${scores.holdout ? `, hold-out delta ${scores.holdout.delta}` : ''}; all invariants hold${outside}`; }
  }
  const fingerprints = new Map(Array.isArray(diff?.candidateSet) ? diff.candidateSet.map((candidate) => [candidate.id, candidate.fingerprint] as const) : []);
  const regressed = (index: number): boolean => verdict === 'rolled_back' && scores !== null && (scores.perProposal[index] ?? 0) < 0;
  const anyAttributed = faults.some(Boolean) || (scores?.perProposal.some((delta) => delta < 0) ?? false);
  // A rollback no single proposal explains (an interaction, a hold-out veto) faults them all.
  const proposals = !invalid ? diff.proposals.map((proposal, index) => ({
    kind: proposal.kind, proposalSha256: proposalSha256(proposal, fingerprints),
    fault: verdict === 'rolled_back' ? (anyAttributed ? (faults[index] ?? false) || regressed(index) : true) : false,
  })) : [];
  return memory.atomic(() => {
    const head = chainHead(memory);
    const passId = passIdFor(head, typeof diff?.digest === 'string' ? diff.digest : 'invalid');
    let created: ConsolidationCreated[] = [];
    let stateAfter = stateNow;
    if (head !== scoringHead) { verdict = 'conflict'; reason = 'another consolidation receipt was written while this pass was scored'; }
    else if (verdict === 'kept') {
      // Any write after scoring, an insert included, voids the scores: a ledger entry after the mark, or a current state that differs from the scored one.
      const later = writesAfter(memory, scoringMark);
      const { cut: applyAt } = snapshotAt(memory);
      if (later.count) { verdict = 'conflict'; reason = `the store changed while this pass was scored: ${later.count}${later.capped ? '+' : ''} ledger write(s) after scoring`; }
      // A verifier outcome fills a recall entry in place and appends nothing, so only the rebuilt replay set shows it.
      else if (buildReplaySet(memory).sha256 !== replaySet.sha256) { verdict = 'conflict'; reason = 'the replay set changed while this pass was scored (a verifier outcome was recorded); the scores no longer describe it'; }
      else if (stateAt(memory, applyAt) !== stateNow || stateAt(memory, cut) !== stateNow || changedCandidates(memory, diff)) { verdict = 'conflict'; reason = 'the store changed while this pass was scored'; }
      else {
        created = applyDiff(memory, diff, passId, false);
        const latest = created.reduce((time, entry) => { const at = memory.get(entry.id)!.createdAt; return at > time ? at : time; }, cut);
        stateAfter = stateAt(memory, latest);
      }
    }
    const receipt = seal({
      schema: 'mnemosyne-consolidation-receipt-v1', action: 'gate', passId,
      replaySetSha256: replaySet.sha256, verifierSha256: CONSOLIDATION_VERIFIER_SHA256,
      stateBefore: stateNow, candidateDiffSha256: invalid ? null : diff.digest, signature: invalid ? null : diff.signature,
      stateAfter, scores, verdict, reason, invariants, proposals, created, prevDigest: head, recordedAt: cut,
    }, options.signer);
    return { verdict, receipt, ledgerId: append(memory, receipt), created };
  });
}

export interface ConsolidateOptions extends ProposeConsolidationOptions {
  /** As in {@link GateConsolidationOptions}: the signer's own key by default; `'any'` is unsafe. */
  trustedKeyIds?: string[] | 'any';
}

/** Proposes and gates in one step. Returns null when the proposer had nothing to offer (no receipt is written). */
export function consolidate(memory: LocalMemory, options: ConsolidateOptions): (ConsolidationResult & { diff: ConsolidationDiff }) | null {
  const input = v.object(options, 'consolidate options');
  v.keys(input, ['signer', 'proposer', 'proposerName', 'caps', 'backoff', 'trustedKeyIds'], 'consolidate options');
  const { trustedKeyIds, ...propose } = options;
  const diff = proposeConsolidation(memory, propose);
  if (!diff) return null;
  return { ...gateConsolidation(memory, diff, { signer: options.signer, ...(trustedKeyIds === undefined ? {} : { trustedKeyIds }), ...(options.caps ? { caps: options.caps } : {}) }), diff };
}

export interface RollbackConsolidationResult {
  verdict: 'rolled_back' | 'conflict';
  receipt: ConsolidationReceipt;
  ledgerId: string;
  /** The kept pass's state before it was applied. */
  stateBefore: string;
  /** The state after this rollback. */
  stateAfter: string;
  restored: boolean;
  deletedIds: string[];
}

/**
 * Undoes one kept pass exactly: deletes the records it created when each is
 * byte-identical to its recorded fingerprint and nothing later depends on it.
 * Anything else is a `conflict` receipt and nothing changes.
 *
 * The kept receipt is verified first (digest, receipt signature, diff
 * signature, and a receipt key in `trustedKeyIds`, the signer's own key by
 * default): a receipt edited in the database is refused, not acted on.
 * `restored` is true only when the records were removed AND the store is back
 * at the pass's exact `stateBefore`; when later writes make that impossible,
 * the reason says so.
 */
export function rollbackConsolidation(memory: LocalMemory, passId: string, options: { signer: ConsolidationSigner; trustedKeyIds?: string[] | 'any' }): RollbackConsolidationResult {
  v.string(passId, 'passId', 160);
  const input = v.object(options, 'consolidation rollback options');
  v.keys(input, ['signer', 'trustedKeyIds'], 'consolidation rollback options');
  if (!options.signer || typeof options.signer.sign !== 'function') throw new TypeError('A consolidation signer is required');
  const trusted = trustedKeys(options.trustedKeyIds, options.signer);
  const receipts = consolidationReceipts(memory);
  const stored = receipts.find(({ receipt }) => receipt?.action === 'gate' && receipt.passId === passId && receipt.verdict === 'kept');
  if (!stored) throw new Error(`No kept consolidation pass ${passId} in this scope`);
  const kept = stored.receipt;
  const problem = receiptProblem(kept) ?? (trusted && !trusted.includes(kept.receiptSignature.keyId) ? 'receipt is signed by a key that is not trusted' : null);
  if (problem) throw new Error(`The receipt of consolidation pass ${passId} does not verify (${problem}); nothing was rolled back`);
  if (receipts.some(({ receipt }) => receipt?.action === 'rollback' && receipt.rollbackOf === passId && receipt.verdict === 'rolled_back')) throw new Error(`Consolidation pass ${passId} is already rolled back`);
  const { cut } = snapshotAt(memory);
  const before = stateAt(memory, cut);
  return memory.atomic(() => {
    const head = chainHead(memory);
    let verdict: 'rolled_back' | 'conflict' = 'rolled_back', reason: string, deletedIds: string[] = [];
    try {
      deletedIds = memory.rollbackUnchangedRecords({ records: kept.created.map(({ id, fingerprint }) => ({ id, fingerprint })) }).deletedIds;
      reason = `rollback of ${passId}: ${deletedIds.length} created record(s) removed`;
    } catch (error) {
      if (!(error instanceof RollbackConflictError)) throw error;
      verdict = 'conflict';
      reason = `rollback of ${passId} refused: ${error.conflictCount} created record(s) changed or have later dependent work`;
    }
    const stateAfter = stateAt(memory, cut);
    const identical = stateAfter === kept.stateBefore;
    const restored = verdict === 'rolled_back' && identical;
    if (verdict === 'rolled_back' && !identical) {
      const later = writesAfter(memory, stored.sequence);
      reason += later.count
        ? `; the store is not back at the pass's stateBefore because ${later.count}${later.capped ? '+' : ''} later write(s) in this scope changed it after the pass`
        : '; the store is not back at the pass\'s stateBefore: it changed after the pass outside this scope\'s ledger';
    }
    if (verdict === 'conflict' && identical) reason += '; the store already matches the pass\'s stateBefore because its created record(s) were removed outside this rollback';
    const receipt = seal({
      schema: 'mnemosyne-consolidation-receipt-v1', action: 'rollback', passId: passIdFor(head, `rollback\n${passId}`), rollbackOf: passId,
      replaySetSha256: null, verifierSha256: CONSOLIDATION_VERIFIER_SHA256, stateBefore: before,
      candidateDiffSha256: kept.candidateDiffSha256, signature: kept.signature, stateAfter, scores: null, verdict, reason,
      invariants: [], proposals: [], created: [], restored, prevDigest: head, recordedAt: cut,
    }, options.signer);
    return { verdict, receipt, ledgerId: append(memory, receipt), stateBefore: kept.stateBefore, stateAfter, restored, deletedIds };
  });
}

export interface ConsolidationChainReport {
  ok: boolean;
  receipts: number;
  head: string | null;
  keyChanges: { sequence: number; from: string; to: string }[];
  errors: { sequence: number; passId: string | null; error: string }[];
}

/** Walks the receipts in ledger order and checks digests, links, signatures and rollback references. */
export function verifyConsolidationChain(memory: LocalMemory, options: { pinnedKeyIds?: string[] } = {}): ConsolidationChainReport {
  const input = v.object(options, 'consolidation chain options');
  v.keys(input, ['pinnedKeyIds'], 'consolidation chain options');
  const pinned = options.pinnedKeyIds === undefined ? undefined : v.strings(options.pinnedKeyIds, 'pinnedKeyIds', 64, 64);
  const errors: ConsolidationChainReport['errors'] = [];
  const keyChanges: ConsolidationChainReport['keyChanges'] = [];
  const kept = new Set<string>(), undone = new Set<string>();
  let previous: string | null = null, key: string | null = null, count = 0;
  for (const { sequence, receipt } of consolidationReceipts(memory)) {
    count++;
    const fail = (error: string): void => { errors.push({ sequence, passId: typeof receipt?.passId === 'string' ? receipt.passId : null, error }); };
    if (!receipt || receipt.schema !== 'mnemosyne-consolidation-receipt-v1') { fail('unknown receipt schema'); previous = null; continue; }
    if (receiptDigest(receipt) !== receipt.digest) fail('digest does not match the receipt');
    if (!verifyConsolidationSignature(receiptSignatureMessage(receipt.digest), receipt.receiptSignature)) fail('receipt signature does not verify');
    else {
      if (pinned && !pinned.includes(receipt.receiptSignature.keyId)) fail('receipt is signed by a key that is not pinned');
      if (key !== null && key !== receipt.receiptSignature.keyId) keyChanges.push({ sequence, from: key, to: receipt.receiptSignature.keyId });
      key = receipt.receiptSignature.keyId;
    }
    if (receipt.prevDigest !== previous) fail('prevDigest does not link to the previous receipt');
    if (receipt.signature !== null && (receipt.candidateDiffSha256 === null || !verifyConsolidationSignature(diffSignatureMessage(receipt.candidateDiffSha256), receipt.signature))) fail('diff signature does not verify');
    if (receipt.action === 'gate' && receipt.verdict === 'kept') kept.add(receipt.passId);
    if (receipt.action === 'rollback') {
      if (typeof receipt.rollbackOf !== 'string' || !kept.has(receipt.rollbackOf)) fail('rollback names no earlier kept pass');
      else if (receipt.verdict === 'rolled_back') {
        if (undone.has(receipt.rollbackOf)) fail('pass rolled back twice');
        undone.add(receipt.rollbackOf);
      }
    }
    previous = receipt.digest;
  }
  return { ok: errors.length === 0, receipts: count, head: previous, keyChanges, errors };
}

/** Records created by a pass that are still present, located by the pass tag (for inspection). */
export function passRecords(memory: LocalMemory, passId: string): MemoryRecord[] {
  v.string(passId, 'passId', 160);
  const records: MemoryRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = memory.list({ limit: 1000, includeInactive: true, includeUntrusted: true, metadata: { consolidationPass: passId }, ...(cursor === undefined ? {} : { cursor }) });
    records.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return records;
}
