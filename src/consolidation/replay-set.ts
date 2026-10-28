/**
 * The frozen replay set: the agent's own recorded retrievals that a verifier
 * judged, read back from the ledger. Labels come only from recorded outcomes
 * (the retrieval's verifier slot and `outcome` events for the same task),
 * never from the candidate diff and never from a model.
 */
import { createHash } from 'node:crypto';
import type { LocalMemory } from '../local/index.js';
import type { LedgerEntry, LedgerEvent } from '../local/types.js';
import { canonicalize } from '../local/replay.js';
import type { ReplaySet, ReplayTask } from './types.js';

/** Pages through the whole scoped ledger for the given events, oldest first. */
export function ledgerEntries(memory: LocalMemory, events: LedgerEvent[]): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  let after: number | undefined;
  for (;;) {
    const page = memory.ledger({ events, limit: 1000, ...(after === undefined ? {} : { after }) });
    entries.push(...page.entries);
    if (page.nextCursor === undefined) return entries;
    after = page.nextCursor;
  }
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * One task per judged retrieval. Gold ids are the ids an `outcome` event for
 * the same task marked successful; without such events a successful
 * retrieval's own returned ids are gold. Harmful ids are the ids an `outcome`
 * event for the task marked failed. A retrieval without query text (the
 * ledger's default `queries: 'digest'`) or without any labelled id is counted
 * as unreplayable instead of being guessed.
 */
export function buildReplaySet(memory: LocalMemory): ReplaySet {
  const entries = ledgerEntries(memory, ['recall', 'outcome']);
  const outcomes = new Map<string, { success: Set<string>; failure: Set<string> }>();
  for (const entry of entries) {
    if (entry.event !== 'outcome' || !entry.outcome || !entry.memoryId) continue;
    const slot = outcomes.get(entry.outcome.taskId) ?? { success: new Set<string>(), failure: new Set<string>() };
    (entry.outcome.success ? slot.success : slot.failure).add(entry.memoryId);
    outcomes.set(entry.outcome.taskId, slot);
  }
  const tasks: ReplayTask[] = [];
  let unreplayable = 0;
  for (const entry of entries) {
    const retrieval = entry.retrieval;
    if (entry.event !== 'recall' || !retrieval?.verifier) continue;
    const labelled = outcomes.get(retrieval.verifier.taskId);
    const harmful = sorted(labelled?.failure ?? []);
    const gold = sorted(labelled?.success.size ? labelled.success : retrieval.verifier.success ? retrieval.results.map((result) => result.memoryId) : []);
    if (typeof retrieval.query !== 'string' || !retrieval.query.trim() || (!gold.length && !harmful.length)) { unreplayable++; continue; }
    tasks.push({
      ledgerId: entry.id, sequence: entry.sequence, taskId: retrieval.verifier.taskId, success: retrieval.verifier.success, query: retrieval.query,
      lexicalScoring: retrieval.lexicalScoring, limit: retrieval.limit, gold, harmful,
    });
  }
  tasks.sort((a, b) => a.sequence - b.sequence);
  const digest = createHash('sha256').update('mnemosyne-consolidation-replay-set-v1\n')
    .update(canonicalize(tasks.map((task) => ({ ledgerId: task.ledgerId, taskId: task.taskId, success: task.success, gold: task.gold, harmful: task.harmful, limit: task.limit, lexicalScoring: task.lexicalScoring }))))
    .update(`\n${unreplayable}`).digest('hex');
  return { tasks, unreplayable, sha256: digest };
}

/** Deterministic 20% hold-out by digest order of (sequence, taskId), used only when the set has at least 10 tasks. */
export function splitHoldout(tasks: readonly ReplayTask[]): { main: ReplayTask[]; holdout: ReplayTask[] } {
  if (tasks.length < 10) return { main: [...tasks], holdout: [] };
  const rank = (task: ReplayTask): string => createHash('sha256').update(`holdout\n${task.sequence}\n${task.taskId}`).digest('hex');
  const ordered = [...tasks].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
  const size = Math.floor(tasks.length / 5);
  const held = new Set(ordered.slice(0, size).map((task) => task.ledgerId));
  return { main: tasks.filter((task) => !held.has(task.ledgerId)), holdout: tasks.filter((task) => held.has(task.ledgerId)) };
}
