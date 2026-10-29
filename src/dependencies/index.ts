/**
 * Undeclared-dependency inference, rule `co-use-success-v1`.
 *
 * A correction cascades only through DECLARED dependencies (`correct()` walks the
 * dependency table). Agents build procedures and skills on premises they never
 * declared, so correcting such a premise leaves those procedures executable. The
 * runtime traces and the retrieval ledger already record which records were used
 * together when a task succeeded. This module turns that co-use into proposals a
 * reviewer can accept or reject. It never mutates silently: inference and the
 * premise guard only read, and the only write path is `reviewDependency`, which
 * appends a `dependency` ledger receipt and, on accept, links the edge through a
 * ledgered `correct()` (or `MemoryRuntime.linkPremise` for a skill) in the same
 * transaction. Accepted edges are ordinary declared dependencies afterwards, so
 * the kernel's own cascade does the invalidation.
 *
 * Deterministic and model-free: no embedding, no model call, no randomness. Every
 * scan is bounded by `maxRecords` and `maxLedgerPages`.
 */
import { createHash } from 'node:crypto';
import type { JsonValue, LedgerDependency, LocalMemory, MemoryKind, MemoryRecord } from '../local/index.js';
import * as v from '../local/validation.js';
import { MemoryRuntime, type RuntimeSkill } from '../runtime/index.js';
import type {
  DependencyDecision, DependencyReceipt, DependencyReview, DependencyRule, InferDependenciesOptions, InferenceEvidence,
  HoldContext, InferenceRejection, InferenceResult, InferenceThresholds, InferredDependency, PremiseGuard, PremiseGuardOptions, PremiseHold,
  PremiseHoldList, ReviewDependencyOptions,
} from './types.js';
export type * from './types.js';

export const DEPENDENCY_RULE: DependencyRule = 'co-use-success-v1';
/** Defaults chosen on development seeds of the synthetic corpus, never on the gate
 * seed; see docs/DEPENDENCIES.md. */
export const DEFAULT_INFERENCE_THRESHOLDS: Readonly<InferenceThresholds> = Object.freeze({ minSupport: 2, minReliance: 0.4, minLift: 1.5, minConfidence: 0.25, z: 1 });
// Never release on statistics by default: see PremiseGuardOptions.holdReliance.
const DEFAULT_HOLD_RELIANCE = 0;
const DEFAULT_DEPENDENT_KINDS: readonly MemoryKind[] = ['procedure'];
const DEFAULT_PREMISE_KINDS: readonly MemoryKind[] = ['decision', 'fact', 'preference'];
const EVIDENCE_IDS = 16;
const CLOSURE_LIMIT = 4096;
const PAGE = 1000;
const OPTION_KEYS = ['minSupport', 'minReliance', 'minLift', 'minConfidence', 'z', 'maxLedgerPages', 'maxRecords', 'dependentKinds', 'premiseKinds', 'maxProposals'] as const;
const PROPOSAL_KEYS = ['rule', 'from', 'to', 'fromKind', 'toKind', 'skillId', 'support', 'runs', 'premiseRuns', 'tasks', 'reliance', 'lift', 'pmi', 'confidence', 'ignored', 'returnedSupport', 'candidateOnly', 'failedCoUse', 'taskIds', 'ledgerIds', 'traceIds', 'hold', 'digest'] as const;
const HOLD_KEYS = ['reason', 'premiseStatus', 'changedAt', 'correctionId', 'correctionReason', 'linkTo'] as const;
const COUNT_KEYS = ['support', 'runs', 'premiseRuns', 'tasks', 'ignored', 'returnedSupport', 'candidateOnly', 'failedCoUse'] as const;
const RATIO_KEYS = ['reliance', 'lift', 'pmi', 'confidence'] as const;
const ID_KEYS = ['taskIds', 'ledgerIds', 'traceIds'] as const;
const REJECTIONS: readonly InferenceRejection[] = ['reviewed', 'inactive', 'declared', 'cycle', 'incompatible', 'support', 'reliance', 'lift', 'confidence'];

interface Settings {
  thresholds: InferenceThresholds;
  maxLedgerPages: number;
  maxRecords: number;
  dependentKinds: MemoryKind[];
  premiseKinds: MemoryKind[];
  maxProposals: number;
  holdReliance: number;
}

function number(value: unknown, fallback: number, min: number, max: number, label: string, integer = false): number {
  const actual = value === undefined ? fallback : value;
  if (typeof actual !== 'number' || !Number.isFinite(actual) || actual < min || actual > max || (integer && !Number.isSafeInteger(actual))) {
    throw new TypeError(`${label} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  }
  return actual;
}

function kinds(value: unknown, fallback: readonly MemoryKind[], label: string): MemoryKind[] {
  if (value === undefined) return [...fallback];
  return [...new Set(v.strings(value, label, 6).map(kind => v.enumeration(kind, v.KINDS, label)))].sort();
}

function parseSettings(options: unknown, guard: boolean): Settings {
  const input = v.object(options, guard ? 'premise guard options' : 'dependency inference options');
  v.keys(input, guard ? [...OPTION_KEYS, 'holdReliance'] : OPTION_KEYS, guard ? 'premise guard option' : 'dependency inference option');
  const thresholds: InferenceThresholds = {
    minSupport: number(input.minSupport, DEFAULT_INFERENCE_THRESHOLDS.minSupport, 2, 1_000_000, 'minSupport', true),
    minReliance: number(input.minReliance, DEFAULT_INFERENCE_THRESHOLDS.minReliance, 0, 1, 'minReliance'),
    minLift: number(input.minLift, DEFAULT_INFERENCE_THRESHOLDS.minLift, 0, 1_000_000, 'minLift'),
    minConfidence: number(input.minConfidence, DEFAULT_INFERENCE_THRESHOLDS.minConfidence, 0, 1, 'minConfidence'),
    z: number(input.z, DEFAULT_INFERENCE_THRESHOLDS.z, 0, 4, 'z'),
  };
  const dependentKinds = kinds(input.dependentKinds, DEFAULT_DEPENDENT_KINDS, 'dependentKinds');
  const premiseKinds = kinds(input.premiseKinds, DEFAULT_PREMISE_KINDS, 'premiseKinds');
  // Checkpoints change only through checkpoint(); correct() refuses them.
  if (!dependentKinds.length || !premiseKinds.length || dependentKinds.some(kind => premiseKinds.includes(kind)) || [...dependentKinds, ...premiseKinds].includes('checkpoint')) {
    throw new TypeError('dependentKinds and premiseKinds must be nonempty, disjoint and exclude checkpoint');
  }
  return {
    thresholds, dependentKinds, premiseKinds,
    maxLedgerPages: number(input.maxLedgerPages, 50, 1, 1000, 'maxLedgerPages', true),
    maxRecords: number(input.maxRecords, 50_000, 1, 1_000_000, 'maxRecords', true),
    maxProposals: number(input.maxProposals, 1000, 1, 100_000, 'maxProposals', true),
    holdReliance: guard ? number(input.holdReliance, DEFAULT_HOLD_RELIANCE, 0, 1, 'holdReliance') : DEFAULT_HOLD_RELIANCE,
  };
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const pairKey = (dependent: string, premise: string) => `${dependent}\u0000${premise}`;

/** Wilson score lower bound: what reliance the evidence supports at `z` standard
 * deviations. Two co-uses out of two runs is not the same claim as 20 of 20. */
function wilsonLower(successes: number, trials: number, z: number): number {
  if (trials <= 0) return 0;
  const p = successes / trials, z2 = z * z;
  return Math.max(0, (p + z2 / (2 * trials) - z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / (1 + z2 / trials));
}

/** Wilson score upper bound: the most reliance the evidence still allows. The
 * guard releases a co-used premise only when even this bound is low. */
function wilsonUpper(successes: number, trials: number, z: number): number {
  if (trials <= 0) return 1;
  const p = successes / trials, z2 = z * z;
  return Math.min(1, (p + z2 / (2 * trials) + z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / (1 + z2 / trials));
}

/** The review handle: sha256 over the canonical proposal without its digest. */
export function proposalDigest(proposal: Omit<InferredDependency, 'digest'> | Record<string, unknown>): string {
  const { digest: _digest, ...body } = proposal as Record<string, unknown>;
  return createHash('sha256').update(v.canonical(body)).digest('hex');
}

interface Task { taskId: string; success: boolean; used: string[]; pool: string[]; traceId?: string; ledgerIds: string[] }
interface Verdict { success: boolean; ledgerId: string; results: string[]; candidates: string[] }
interface Pair {
  dependent: string; premise: string;
  support: number; ignored: number; returnedSupport: number; candidateOnly: number; failedCoUse: number;
  taskIds: Set<string>; ledgerIds: Set<string>; traceIds: Set<string>;
}

/**
 * Everything one bounded read pass learns: records by lineage node, judged tasks
 * and co-use statistics per (dependent, premise) node pair.
 *
 * A node is a lineage, not a record id. Accepting an edge re-versions the
 * dependent (same text, new id), a promotion re-versions a premise, and a skill
 * gets a new record per generation; evidence recorded against any version must
 * keep counting for the same procedure. A text change starts a new node: a
 * corrected premise is a different claim, and a revised procedure has no history.
 */
class EvidenceIndex {
  readonly evidence: Omit<InferenceEvidence, 'pairs'>;
  readonly pairs = new Map<string, Pair>();
  readonly runs = new Map<string, number>();
  readonly premiseRuns = new Map<string, number>();
  readonly reviewed = new Set<string>();
  tasks = 0;
  readonly #memory: LocalMemory;
  readonly #settings: Settings;
  readonly #records = new Map<string, MemoryRecord | null>();
  readonly #successors = new Map<string, MemoryRecord[]>();
  readonly #skills = new Map<string, MemoryRecord>();
  readonly #nodes = new Map<string, string | null>();
  readonly #nodeKinds = new Map<string, MemoryKind>();
  readonly #closures = new Map<string, Set<string>>();

  constructor(memory: LocalMemory, settings: Settings) {
    this.#memory = memory;
    this.#settings = settings;
    let truncated = false, scannedRecords = 0;
    const list = (filter: { kinds: MemoryKind[]; metadata?: Record<string, string> }, visit: (record: MemoryRecord) => void) => {
      let cursor: string | undefined;
      do {
        if (scannedRecords >= settings.maxRecords) { truncated = true; return; }
        const page = memory.list({ ...filter, includeInactive: true, includeUntrusted: true, limit: Math.min(PAGE, settings.maxRecords - scannedRecords), ...(cursor === undefined ? {} : { cursor }) });
        scannedRecords += page.items.length;
        page.items.forEach(visit);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
    };
    list({ kinds: [...settings.dependentKinds, ...settings.premiseKinds] }, record => {
      this.#records.set(record.id, record);
      if (record.supersedes) this.#successors.set(record.supersedes, [...(this.#successors.get(record.supersedes) ?? []), record]);
      const skillId = record.metadata.skillId;
      if (record.metadata.runtimeType === 'skill' && typeof skillId === 'string' && record.agentId === memory.agentId) {
        const previous = this.#skills.get(skillId);
        if (!previous || Number(record.metadata.generation ?? 0) > Number(previous.metadata.generation ?? 0)) this.#skills.set(skillId, record);
      }
    });
    const traces: { id: string; taskId: string; used: string[]; retrieved: string[]; success?: boolean }[] = [];
    let traceRecords = 0;
    list({ kinds: ['observation'], metadata: { runtimeType: 'trace' } }, record => {
      traceRecords++;
      if (record.agentId !== memory.agentId || !record.source.uri.startsWith('runtime:trace:')) return;
      const trace = parseTrace(record.text);
      if (trace) traces.push({ id: record.id, ...trace });
    });

    // Ledger: recall verdicts, attributed outcomes and earlier review decisions.
    const verdicts = new Map<string, Verdict[]>();
    const outcomes = new Map<string, { memoryId: string; success: boolean; ledgerId: string }[]>();
    const receipts: { from: string; to: string; skillId?: string }[] = [];
    let after: number | undefined, pages = 0, ledgerEntries = 0;
    for (;;) {
      if (pages >= settings.maxLedgerPages) { truncated = true; break; }
      const page = memory.ledger({ events: ['recall', 'outcome', 'dependency'], limit: PAGE, ...(after === undefined ? {} : { after }) });
      pages++;
      ledgerEntries += page.entries.length;
      for (const entry of page.entries) {
        if (entry.event === 'recall' && entry.retrieval?.verifier) {
          const verdict = entry.retrieval.verifier;
          verdicts.set(verdict.taskId, [...(verdicts.get(verdict.taskId) ?? []), { success: verdict.success, ledgerId: entry.id, results: entry.retrieval.results.map(result => result.memoryId), candidates: entry.retrieval.candidates.map(candidate => candidate.memoryId) }]);
        } else if (entry.event === 'outcome' && entry.outcome && entry.memoryId) {
          outcomes.set(entry.outcome.taskId, [...(outcomes.get(entry.outcome.taskId) ?? []), { memoryId: entry.memoryId, success: entry.outcome.success, ledgerId: entry.id }]);
        } else if (entry.event === 'dependency' && entry.dependency) {
          const { from, to, skillId, decision } = entry.dependency;
          if (typeof from === 'string' && typeof to === 'string' && (decision === 'accept' || decision === 'reject')) receipts.push({ from, to, ...(typeof skillId === 'string' ? { skillId } : {}) });
        }
      }
      if (page.nextCursor === undefined) break;
      after = page.nextCursor;
    }
    for (const receipt of receipts) {
      const dependent = receipt.skillId === undefined ? this.nodeOf(receipt.from) : `skill:${receipt.skillId}`, premise = this.nodeOf(receipt.to);
      if (dependent && premise) this.reviewed.add(pairKey(dependent, premise));
    }

    // Judge tasks. A trace is the authoritative used set; its own outcome and any
    // verifier verdict on the retrieval it came from must agree, or the task is
    // dropped as conflicting. Unjudged tasks carry no evidence either way.
    const counts = { successful: 0, failed: 0, unjudged: 0, conflicting: 0, traced: 0, attributed: 0, recallOnly: 0 };
    const tasks: Task[] = [];
    const judged = (values: boolean[]): boolean | 'conflict' | undefined => values.length === 0 ? undefined : values.every(value => value === values[0]) ? values[0] : 'conflict';
    const taskCounts = new Map<string, number>();
    for (const trace of traces) taskCounts.set(trace.taskId, (taskCounts.get(trace.taskId) ?? 0) + 1);
    for (const trace of traces) {
      if (taskCounts.get(trace.taskId)! > 1) { counts.conflicting++; continue; }
      const verdict = verdicts.get(trace.taskId) ?? [];
      const success = judged([...(trace.success === undefined ? [] : [trace.success]), ...verdict.map(entry => entry.success)]);
      if (success === undefined) { counts.unjudged++; continue; }
      if (success === 'conflict') { counts.conflicting++; continue; }
      counts.traced++;
      tasks.push({ taskId: trace.taskId, success, used: trace.used, pool: [...trace.retrieved, ...verdict.flatMap(entry => [...entry.results, ...entry.candidates])], traceId: trace.id, ledgerIds: [...verdict.map(entry => entry.ledgerId), ...(outcomes.get(trace.taskId) ?? []).map(entry => entry.ledgerId)] });
    }
    // Without a trace, outcomes the controller attributed to two or more records
    // for one task are its used set. A single attribution (a skill trial, a
    // retirement) carries no co-use information and is not counted as a run.
    const attributed = new Set<string>();
    for (const [taskId, group] of [...outcomes].sort(([a], [b]) => a.localeCompare(b))) {
      if (taskCounts.has(taskId)) continue;
      const members = sorted(group.map(entry => entry.memoryId));
      if (members.length < 2) continue;
      const verdict = verdicts.get(taskId) ?? [];
      const success = judged([...group.map(entry => entry.success), ...verdict.map(entry => entry.success)]);
      if (success === 'conflict' || success === undefined) { counts.conflicting++; continue; }
      attributed.add(taskId);
      counts.attributed++;
      tasks.push({ taskId, success, used: members, pool: verdict.flatMap(entry => [...entry.results, ...entry.candidates]), ledgerIds: [...group.map(entry => entry.ledgerId), ...verdict.map(entry => entry.ledgerId)] });
    }
    const recallOnly: { results: string[]; candidates: string[] }[] = [];
    for (const [taskId, verdict] of [...verdicts].sort(([a], [b]) => a.localeCompare(b))) {
      if (taskCounts.has(taskId) || attributed.has(taskId)) continue;
      const success = judged(verdict.map(entry => entry.success));
      if (success === 'conflict') { counts.conflicting++; continue; }
      counts.recallOnly++;
      if (success) recallOnly.push({ results: sorted(verdict.flatMap(entry => entry.results)), candidates: sorted(verdict.flatMap(entry => entry.candidates)) });
    }

    // Signal 1: explicit used sets of successful tasks (support), with failures
    // and retrieved-but-unused premises recorded against the pair, never for it.
    const increment = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
    for (const task of tasks.sort((a, b) => a.taskId.localeCompare(b.taskId))) {
      const used = new Set(task.used.map(id => this.nodeOf(id)).filter((node): node is string => node !== null));
      if (!used.size) continue;
      const dependents = [...used].filter(node => this.#role(node) === 'dependent');
      const premises = [...used].filter(node => this.#role(node) === 'premise');
      if (!task.success) {
        counts.failed++;
        for (const dependent of dependents) for (const premise of premises) this.#pair(dependent, premise).failedCoUse++;
        continue;
      }
      counts.successful++;
      this.tasks++;
      dependents.forEach(node => increment(this.runs, node));
      premises.forEach(node => increment(this.premiseRuns, node));
      const ignored = new Set(task.pool.map(id => this.nodeOf(id)).filter((node): node is string => node !== null && !used.has(node) && this.#role(node) === 'premise'));
      for (const dependent of dependents) {
        for (const premise of premises) {
          const pair = this.#pair(dependent, premise);
          pair.support++;
          pair.taskIds.add(task.taskId);
          task.ledgerIds.forEach(id => pair.ledgerIds.add(id));
          if (task.traceId) pair.traceIds.add(task.traceId);
        }
        for (const premise of ignored) this.#pair(dependent, premise).ignored++;
      }
    }
    // Signals 2 and 3: successful retrievals without a used set. Both returned is
    // corroboration; the premise only among candidates is evidence against.
    for (const entry of recallOnly) {
      const returned = new Set(entry.results.map(id => this.nodeOf(id)).filter((node): node is string => node !== null));
      const candidates = new Set(entry.candidates.map(id => this.nodeOf(id)).filter((node): node is string => node !== null && !returned.has(node)));
      for (const dependent of [...returned].filter(node => this.#role(node) === 'dependent')) {
        for (const premise of [...returned].filter(node => this.#role(node) === 'premise')) this.#pair(dependent, premise).returnedSupport++;
        for (const premise of [...candidates].filter(node => this.#role(node) === 'premise')) this.#pair(dependent, premise).candidateOnly++;
      }
    }
    this.evidence = {
      rule: DEPENDENCY_RULE, thresholds: { ...settings.thresholds },
      scanned: { records: scannedRecords, traces: traceRecords, ledgerEntries, ledgerPages: pages, truncated },
      tasks: counts,
    };
  }

  #pair(dependent: string, premise: string): Pair {
    const key = pairKey(dependent, premise);
    let pair = this.pairs.get(key);
    if (!pair) {
      pair = { dependent, premise, support: 0, ignored: 0, returnedSupport: 0, candidateOnly: 0, failedCoUse: 0, taskIds: new Set(), ledgerIds: new Set(), traceIds: new Set() };
      this.pairs.set(key, pair);
    }
    return pair;
  }

  get(id: string): MemoryRecord | null {
    if (!this.#records.has(id)) this.#records.set(id, this.#memory.get(id));
    return this.#records.get(id)!;
  }

  #role(node: string): 'dependent' | 'premise' | null {
    const kind = this.#nodeKinds.get(node);
    if (kind === undefined) return null;
    return this.#settings.dependentKinds.includes(kind) ? 'dependent' : this.#settings.premiseKinds.includes(kind) ? 'premise' : null;
  }

  /** Lineage node of a record, or null when it cannot take part in an inferred
   * edge (unknown, wrong kind, or a runtime artifact other than a skill). */
  nodeOf(id: string): string | null {
    const cached = this.#nodes.get(id);
    if (cached !== undefined) return cached;
    const record = this.get(id);
    let node: string | null = null;
    if (record && (this.#settings.dependentKinds.includes(record.kind) || this.#settings.premiseKinds.includes(record.kind))) {
      const runtimeType = record.metadata.runtimeType, skillId = record.metadata.skillId;
      if (runtimeType === 'skill') {
        if (this.#settings.dependentKinds.includes(record.kind) && typeof skillId === 'string') node = `skill:${skillId}`;
      } else if (runtimeType === undefined) {
        let root = record;
        for (let step = 0; root.supersedes && step < CLOSURE_LIMIT; step++) {
          const previous = this.get(root.supersedes);
          if (!previous || previous.text !== root.text || previous.kind !== root.kind) break;
          root = previous;
        }
        node = `memory:${root.id}`;
      }
      if (node) this.#nodeKinds.set(node, record.kind);
    }
    this.#nodes.set(id, node);
    return node;
  }

  /** The current record of a node: the highest skill generation, or the newest
   * same-text successor of the lineage root. */
  headOf(node: string): MemoryRecord | null {
    if (node.startsWith('skill:')) return this.#skills.get(node.slice('skill:'.length)) ?? null;
    let current = this.get(node.slice('memory:'.length));
    for (let step = 0; current && step < CLOSURE_LIMIT; step++) {
      const from: MemoryRecord = current;
      const next = (this.#successors.get(from.id) ?? []).filter(record => record.text === from.text && record.kind === from.kind).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
      if (!next) break;
      current = next;
    }
    return current;
  }

  /** The current version of a record whatever its text: itself while active, else
   * its newest active successor over `supersedes`, else null. */
  versionOf(record: MemoryRecord): MemoryRecord | null {
    return newestVersion(record, id => this.successorsOf(id));
  }

  successorsOf(id: string): MemoryRecord[] {
    return this.#successors.get(id) ?? [];
  }

  /** Declared dependency closure of a record (ids), bounded. */
  closure(record: MemoryRecord): Set<string> {
    const cached = this.#closures.get(record.id);
    if (cached) return cached;
    const seen = new Set<string>(), pending = [...record.dependencies];
    while (pending.length && seen.size < CLOSURE_LIMIT) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(this.get(id)?.dependencies ?? []));
    }
    this.#closures.set(record.id, seen);
    return seen;
  }

  closureNodes(record: MemoryRecord): Set<string> {
    return new Set([...this.closure(record)].map(id => this.nodeOf(id)).filter((node): node is string => node !== null));
  }
}

function parseTrace(text: string): { taskId: string; used: string[]; retrieved: string[]; success?: boolean } | null {
  try {
    const value = JSON.parse(text) as { taskId?: unknown; usedIds?: unknown; retrievedIds?: unknown; outcome?: { success?: unknown } };
    const strings = (list: unknown) => Array.isArray(list) && list.every(item => typeof item === 'string') ? list as string[] : null;
    const used = strings(value.usedIds), retrieved = strings(value.retrievedIds);
    if (typeof value.taskId !== 'string' || !used || !retrieved) return null;
    const success = value.outcome?.success;
    return { taskId: value.taskId, used, retrieved, ...(typeof success === 'boolean' ? { success } : {}) };
  } catch { return null; }
}

function statistics(index: EvidenceIndex, pair: Pair, z: number) {
  const runs = index.runs.get(pair.dependent) ?? 0, premiseRuns = index.premiseRuns.get(pair.premise) ?? 0;
  const reliance = pair.support / runs, lift = (pair.support * index.tasks) / (runs * premiseRuns);
  return { runs, premiseRuns, reliance, lift, confidence: wilsonLower(pair.support, runs + pair.candidateOnly, z) };
}

/** The reviewable body of one pair, shared by inference and the hold listing. */
function proposalBody(index: EvidenceIndex, pair: Pair, dependent: MemoryRecord, premise: MemoryRecord, skillId: string | undefined, z: number): Omit<InferredDependency, 'digest'> {
  const { runs, premiseRuns, reliance, lift, confidence } = statistics(index, pair, z);
  return {
    rule: DEPENDENCY_RULE, from: dependent.id, to: premise.id, fromKind: dependent.kind, toKind: premise.kind, ...(skillId === undefined ? {} : { skillId }),
    support: pair.support, runs, premiseRuns, tasks: index.tasks,
    reliance: round(reliance), lift: round(lift), pmi: round(Math.log2(lift)), confidence: round(confidence),
    ignored: pair.ignored, returnedSupport: pair.returnedSupport, candidateOnly: pair.candidateOnly, failedCoUse: pair.failedCoUse,
    taskIds: sorted(pair.taskIds).slice(0, EVIDENCE_IDS), ledgerIds: sorted(pair.ledgerIds).slice(0, EVIDENCE_IDS), traceIds: sorted(pair.traceIds).slice(0, EVIDENCE_IDS),
  };
}

/** Newest active version over `supersedes`, whatever its text; null if none. */
function newestVersion(record: MemoryRecord, successors: (id: string) => MemoryRecord[]): MemoryRecord | null {
  let current = record;
  for (let step = 0; current.status !== 'active' && step < CLOSURE_LIMIT; step++) {
    const next = [...successors(current.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
    if (!next) return null;
    current = next;
  }
  return current.status === 'active' ? current : null;
}

/**
 * Infers undeclared dependencies from successful co-use. A pair (dependent,
 * premise) is proposed only when, over distinct successful tasks with an explicit
 * used set, it has at least `minSupport` co-uses, the dependent used the premise
 * in at least `minReliance` of its runs, co-use beats the base rate by `minLift`,
 * and the Wilson lower bound on reliance clears `minConfidence`. Retrieval
 * without use, failed tasks, and candidacy are never support. Pairs already in
 * the declared closure, pairs a reviewer decided, inactive or ineligible
 * premises, private premises of shared dependents, and cycles are excluded, so
 * every proposal adds an edge `correct()`'s cascade does not already follow.
 * Reads only; returns proposals best first.
 */
export function inferDependencies(memory: LocalMemory, options: InferDependenciesOptions = {}): InferenceResult {
  const settings = parseSettings(options, false);
  const index = new EvidenceIndex(memory, settings);
  const { thresholds } = settings;
  const rejected = Object.fromEntries(REJECTIONS.map(reason => [reason, 0])) as Record<InferenceRejection, number>;
  const proposals: InferredDependency[] = [];
  // Ties are broken by record age before ids: ids are random, ages replay, so a
  // replayed store reviews proposals in the same order.
  const age = new Map<InferredDependency, string>();
  const premiseOk = new Map<string, boolean>();
  let considered = 0;
  for (const key of [...index.pairs.keys()].sort()) {
    const pair = index.pairs.get(key)!;
    if (pair.support < 1) continue;
    considered++;
    const reject = (reason: InferenceRejection) => { rejected[reason]++; };
    if (index.reviewed.has(key)) { reject('reviewed'); continue; }
    const dependent = index.headOf(pair.dependent), premise = index.headOf(pair.premise);
    const skillId = pair.dependent.startsWith('skill:') ? pair.dependent.slice('skill:'.length) : undefined;
    if (!premiseOk.has(pair.premise)) premiseOk.set(pair.premise, !!premise && premise.status === 'active' && premise.trust !== 'untrusted' && memory.isEligible(premise.id));
    if (!dependent || !premise || dependent.status !== 'active' || dependent.agentId !== memory.agentId || (skillId !== undefined && dependent.metadata.skillState === 'retired') || !premiseOk.get(pair.premise)) { reject('inactive'); continue; }
    if (index.closureNodes(dependent).has(pair.premise)) { reject('declared'); continue; }
    if (index.closureNodes(premise).has(pair.dependent)) { reject('cycle'); continue; }
    if (dependent.visibility === 'workspace' && premise.visibility !== 'workspace') { reject('incompatible'); continue; }
    const { reliance, lift, confidence } = statistics(index, pair, thresholds.z);
    if (pair.support < thresholds.minSupport) { reject('support'); continue; }
    if (reliance < thresholds.minReliance) { reject('reliance'); continue; }
    if (lift < thresholds.minLift) { reject('lift'); continue; }
    if (confidence < thresholds.minConfidence) { reject('confidence'); continue; }
    const body = proposalBody(index, pair, dependent, premise, skillId, thresholds.z);
    const proposal = { ...body, digest: proposalDigest(body) };
    proposals.push(proposal);
    age.set(proposal, `${dependent.createdAt}\u0000${premise.createdAt}`);
  }
  proposals.sort((a, b) => b.confidence - a.confidence || b.support - a.support || b.lift - a.lift || age.get(a)!.localeCompare(age.get(b)!) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const kept = proposals.slice(0, settings.maxProposals);
  return { proposals: kept, evidence: { ...index.evidence, pairs: { considered, proposed: kept.length, rejected } } };
}

/** Successors over `supersedes` among records of one kind, bounded. */
function successorMap(memory: LocalMemory, kind: MemoryKind, maxRecords: number): Map<string, MemoryRecord[]> {
  const successors = new Map<string, MemoryRecord[]>();
  let cursor: string | undefined, scanned = 0;
  do {
    const page = memory.list({ kinds: [kind], includeInactive: true, includeUntrusted: true, limit: Math.min(PAGE, maxRecords - scanned), ...(cursor === undefined ? {} : { cursor }) });
    scanned += page.items.length;
    for (const item of page.items) if (item.supersedes) successors.set(item.supersedes, [...(successors.get(item.supersedes) ?? []), item]);
    cursor = scanned < maxRecords ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  return successors;
}

/** Follows same-text successors (a re-versioned dependent) to the current record. */
function currentHead(memory: LocalMemory, record: MemoryRecord, maxRecords: number): MemoryRecord {
  if (record.status === 'active') return record;
  const successors = successorMap(memory, record.kind, maxRecords);
  let current = record;
  for (let step = 0; step < CLOSURE_LIMIT; step++) {
    const from = current;
    const next = (successors.get(from.id) ?? []).filter(item => item.text === from.text && item.kind === from.kind).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
    if (!next) break;
    current = next;
  }
  return current;
}

function closureIds(memory: LocalMemory, record: MemoryRecord): Set<string> {
  const seen = new Set<string>(), pending = [...record.dependencies];
  while (pending.length && seen.size < CLOSURE_LIMIT) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(memory.get(id)?.dependencies ?? []));
  }
  return seen;
}

function parseProposal(proposal: unknown): InferredDependency {
  const input = v.object(proposal, 'dependency proposal');
  v.keys(input, PROPOSAL_KEYS, 'dependency proposal');
  if (input.rule !== DEPENDENCY_RULE) throw new TypeError('Unsupported dependency rule');
  v.string(input.from, 'from', 160); v.string(input.to, 'to', 160);
  v.enumeration(input.fromKind, v.KINDS, 'fromKind'); v.enumeration(input.toKind, v.KINDS, 'toKind');
  if (input.skillId !== undefined) v.string(input.skillId, 'skillId', 64);
  for (const key of COUNT_KEYS) number(input[key], Number.NaN, 0, Number.MAX_SAFE_INTEGER, key, true);
  for (const key of RATIO_KEYS) number(input[key], Number.NaN, -1e9, 1e9, key);
  for (const key of ID_KEYS) v.strings(input[key], key, EVIDENCE_IDS, 160);
  if (input.hold !== undefined) {
    const hold = v.object(input.hold, 'hold');
    v.keys(hold, HOLD_KEYS, 'hold');
    v.enumeration(hold.reason, ['premise-changed', 'premise-ineligible'] as const, 'hold reason');
    v.enumeration(hold.premiseStatus, ['active', 'superseded', 'invalidated'] as const, 'hold premiseStatus');
    if (hold.changedAt !== undefined) v.string(hold.changedAt, 'changedAt', 64);
    if (hold.correctionId !== undefined) v.string(hold.correctionId, 'correctionId', 160);
    if (hold.correctionReason !== undefined) v.string(hold.correctionReason, 'correctionReason', 4096);
    if (hold.linkTo !== undefined) v.string(hold.linkTo, 'linkTo', 160);
  }
  const digest = v.string(input.digest, 'digest', 64);
  if (digest !== proposalDigest(input)) throw new Error('Proposal digest does not match its content; re-run inferDependencies.');
  return input as unknown as InferredDependency;
}

/**
 * Records a review decision on one proposal, and on accept links the edge, in a
 * single transaction: the `dependency` receipt and the link commit together or not
 * at all. A plain dependent is re-versioned by `correct()` with the same text and
 * source and the premise added to its declared dependencies (the successor has a
 * new id and supersedes the reviewed one); a skill gets the premise through
 * `MemoryRuntime.linkPremise`. Rejecting writes only the receipt, which keeps the
 * pair out of later proposals. The digest binds the receipt to exactly the
 * proposal the reviewer saw; the dependent, the premise and the declared graph
 * are re-checked here, so a stale proposal is refused instead of applied.
 *
 * A proposal from `listPremiseHolds` (it carries `hold`) is decided the same way,
 * and its receipt releases the guard's hold. Its premise has changed, so accept
 * links the premise's current version (`hold.linkTo`, re-derived and compared
 * here), and reject needs a `note`.
 */
export function reviewDependency(memory: LocalMemory, proposal: InferredDependency, decision: DependencyDecision, reviewer: string, options: ReviewDependencyOptions = {}): DependencyReview {
  const parsed = parseProposal(proposal);
  const verdict = v.enumeration(decision, ['accept', 'reject'] as const, 'decision');
  const by = v.string(reviewer, 'reviewer', 160);
  const settings = v.object(options, 'review options');
  v.keys(settings, ['runtime', 'now', 'note', 'maxRecords'], 'review option');
  const note = settings.note === undefined ? undefined : v.string(settings.note, 'note', 1024);
  const maxRecords = number(settings.maxRecords, 50_000, 1, 1_000_000, 'maxRecords', true);
  if (options.now !== undefined && typeof options.now !== 'function') throw new TypeError('now must be a function');
  if (options.runtime !== undefined && (!(options.runtime instanceof MemoryRuntime) || options.runtime.memory !== memory)) throw new TypeError('runtime must wrap the same memory');
  const time = (options.now ?? (() => new Date()))();
  if (!(time instanceof Date) || !Number.isFinite(time.getTime())) throw new TypeError('now must return a valid Date');
  const hold = parsed.hold;
  if (hold && verdict === 'reject' && note === undefined) throw new Error('Releasing a guard hold requires a note: why the dependent does not rely on the premise.');
  const receipt: DependencyReceipt = { ...parsed, decision: verdict, reviewer: by, recordedAt: time.toISOString(), ...(note === undefined ? {} : { note }) };
  const append = (memoryId: string) => {
    const id = memory.appendLedgerReceipt({ event: 'dependency', dependency: receipt as unknown as LedgerDependency, memoryId });
    if (!id) throw new Error('Dependency review requires the ledger; nothing was recorded.');
    return id;
  };
  const premise = () => {
    if (hold) return linkTarget(hold);
    const record = memory.get(parsed.to);
    if (!record || record.status !== 'active' || record.trust === 'untrusted' || record.kind !== parsed.toKind || !memory.isEligible(record.id)) throw new Error('Premise changed or is no longer eligible; re-run inferDependencies.');
    return record;
  };
  // A held premise has changed, so accept links its current version: the reviewer
  // states the dependent relies on this premise as it now stands, and the next
  // correction of it cascades. An ineligible current version stays linked as is,
  // so the kernel itself then withholds the dependent.
  const linkTarget = (context: HoldContext) => {
    if (context.linkTo === undefined) throw new Error('The held premise has no current version to link; reject the hold, or revise the dependent with correct().');
    const held = memory.get(parsed.to);
    if (!held || held.kind !== parsed.toKind) throw new Error('Held premise not found in this scope; list holds again.');
    const successors = successorMap(memory, held.kind, maxRecords);
    const current = newestVersion(held, id => successors.get(id) ?? []);
    if (!current || current.id !== context.linkTo) throw new Error('The held premise changed again; list holds again.');
    return current;
  };
  const original = memory.get(parsed.from);
  if (!original || original.agentId !== memory.agentId || original.kind !== parsed.fromKind) throw new Error('Dependent not found in this scope; re-run inferDependencies.');

  if (parsed.skillId !== undefined) {
    if (original.metadata.runtimeType !== 'skill' || original.metadata.skillId !== parsed.skillId) throw new Error('Proposal does not describe this skill.');
    const runtime = options.runtime ?? new MemoryRuntime(memory, options.now ? { now: options.now } : {});
    const skill = runtime.getSkill(parsed.skillId);
    if (!skill || skill.state === 'retired') throw new Error('Skill is missing, retired or has stale evidence.');
    if (verdict === 'reject') return memory.atomic(() => ({ receiptId: append(skill.recordId), decision: verdict, digest: parsed.digest, dependentId: skill.recordId, skillId: parsed.skillId }));
    const target = premise();
    return memory.atomic(() => {
      const receiptId = append(skill.recordId);
      const linked = runtime.linkPremise(parsed.skillId!, target.id, receiptId);
      if (linked.recordId === skill.recordId) throw new Error('Premise is already linked to this skill.');
      return { receiptId, decision: verdict, digest: parsed.digest, dependentId: linked.recordId, supersededId: skill.recordId, skillId: parsed.skillId };
    });
  }

  if (original.metadata.runtimeType !== undefined) throw new Error('Runtime artifacts require their controller interface.');
  const head = currentHead(memory, original, maxRecords);
  if (head.status !== 'active') throw new Error('Dependent is no longer active; re-run inferDependencies.');
  if (verdict === 'reject') return memory.atomic(() => ({ receiptId: append(head.id), decision: verdict, digest: parsed.digest, dependentId: head.id }));
  const target = premise();
  if (closureIds(memory, head).has(target.id)) throw new Error('Dependency is already declared.');
  const upstream = closureIds(memory, target);
  if (upstream.has(head.id) || upstream.has(original.id)) throw new Error('Accepting this dependency would create a cycle.');
  if (head.visibility === 'workspace' && target.visibility !== 'workspace') throw new Error('Shared memory cannot depend on private memory');
  return memory.atomic(() => {
    const receiptId = append(head.id);
    const successor = memory.correct(head.id, { text: head.text, source: head.source, reason: `inferred dependency accepted (receipt ${receiptId})`, dependencies: [target.id] });
    return { receiptId, decision: verdict, digest: parsed.digest, dependentId: successor.id, supersededId: head.id };
  });
}

/**
 * Builds the read-only premise guard from one bounded evidence pass (see
 * `PremiseGuard`). Premise state is read live on every check, so one guard built
 * before a correction reflects it; rebuild after new tasks to see their co-use.
 * A held pair is released by a review receipt, by a declared edge (the kernel
 * then handles it), by a dependent version created after the premise changed,
 * or, only when the caller opts in with `holdReliance` above 0, by evidence of
 * independence (the Wilson upper bound on reliance, at `z`, below it: the
 * dependent ran successfully often enough without the premise). One co-use in a
 * few runs is never evidence of independence.
 */
export function createPremiseGuard(memory: LocalMemory, options: PremiseGuardOptions = {}): PremiseGuard {
  const { holds } = buildGuard(memory, options);
  const allows = (input: MemoryRecord | string) => holds(input).length === 0;
  return {
    holds, allows,
    filter: <T extends MemoryRecord | { memory: MemoryRecord }>(items: T[]) => items.filter(item => allows('memory' in item && typeof item.memory === 'object' ? item.memory : item as MemoryRecord)),
    skill: (skill: RuntimeSkill | null) => {
      if (!skill || skill.state === 'retired') return skill;
      return holds(skill.recordId).length ? { ...skill, state: 'retired', reason: 'Held for review: a premise this skill was used with changed.' } : skill;
    },
  };
}

function buildGuard(memory: LocalMemory, options: PremiseGuardOptions) {
  const settings = parseSettings(options, true);
  const index = new EvidenceIndex(memory, settings);
  const watched = new Map<string, { premise: string; premiseId: string; support: number; runs: number; reliance: number }[]>();
  for (const [key, pair] of [...index.pairs].sort(([a], [b]) => a.localeCompare(b))) {
    if (pair.support < 1 || index.reviewed.has(key)) continue;
    const head = index.headOf(pair.premise);
    if (!head) continue;
    const runs = index.runs.get(pair.dependent) ?? 0, reliance = pair.support / runs;
    if (wilsonUpper(pair.support, runs, settings.thresholds.z) < settings.holdReliance) continue;
    watched.set(pair.dependent, [...(watched.get(pair.dependent) ?? []), { premise: pair.premise, premiseId: head.id, support: pair.support, runs, reliance: round(reliance) }]);
  }
  const holds = (input: MemoryRecord | string): PremiseHold[] => {
    const record = typeof input === 'string' ? memory.get(input) : input;
    if (!record) return [];
    const node = index.nodeOf(record.id);
    const entries = node ? watched.get(node) : undefined;
    if (!entries) return [];
    const declared = index.closureNodes(record);
    const result: PremiseHold[] = [];
    for (const entry of entries) {
      if (declared.has(entry.premise)) continue;
      const premise = memory.get(entry.premiseId);
      const active = premise?.status === 'active';
      if (active && memory.isEligible(premise.id)) continue;
      if (premise && !active && record.createdAt > premise.updatedAt) continue;
      result.push({ premiseId: entry.premiseId, reason: active ? 'premise-ineligible' : 'premise-changed', support: entry.support, runs: entry.runs, reliance: entry.reliance });
    }
    return result;
  };
  return { settings, index, watched, holds };
}

/**
 * Lists every hold the premise guard (built with the same options) would apply to
 * a current dependent this agent owns, as a reviewable proposal: the pair's
 * co-use statistics and evidence ids, a `hold` context naming the change and what
 * `accept` would link, and a digest. Reads only. Support may be 1: these are pairs
 * the guard holds, not inference results, and each stays the reviewer's decision.
 * `reviewDependency` decides one; its receipt releases the hold either way.
 */
export function listPremiseHolds(memory: LocalMemory, options: PremiseGuardOptions = {}): PremiseHoldList {
  const { settings, index, watched, holds } = buildGuard(memory, options);
  const listed: (InferredDependency & { hold: HoldContext })[] = [];
  const age = new Map<InferredDependency, string>();
  for (const [node, entries] of watched) {
    const dependent = index.headOf(node);
    const skillId = node.startsWith('skill:') ? node.slice('skill:'.length) : undefined;
    if (!dependent || dependent.status !== 'active' || dependent.agentId !== memory.agentId || (skillId !== undefined && dependent.metadata.skillState === 'retired')) continue;
    for (const held of holds(dependent)) {
      const entry = entries.find(item => item.premiseId === held.premiseId)!;
      const premise = memory.get(held.premiseId);
      if (!premise) continue;
      const body = { ...proposalBody(index, index.pairs.get(pairKey(node, entry.premise))!, dependent, premise, skillId, settings.thresholds.z), hold: holdContext(memory, index, premise, held.reason) };
      const proposal = { ...body, digest: proposalDigest(body) };
      listed.push(proposal);
      age.set(proposal, `${dependent.createdAt}\u0000${premise.createdAt}`);
    }
  }
  listed.sort((a, b) => age.get(a)!.localeCompare(age.get(b)!) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { holds: listed, evidence: index.evidence };
}

function holdContext(memory: LocalMemory, index: EvidenceIndex, premise: MemoryRecord, reason: PremiseHold['reason']): HoldContext {
  const context: HoldContext = { reason, premiseStatus: premise.status };
  const correction = premise.status === 'superseded' ? [...index.successorsOf(premise.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]
    : premise.status === 'invalidated' && premise.invalidation ? memory.get(premise.invalidation.correctionId) ?? undefined : undefined;
  if (premise.status !== 'active') context.changedAt = premise.updatedAt;
  if (correction) {
    context.correctionId = correction.id;
    if (typeof correction.metadata.correctionReason === 'string') context.correctionReason = correction.metadata.correctionReason;
  }
  const current = index.versionOf(premise);
  if (current) context.linkTo = current.id;
  return context;
}

/** Narrow JSON view of a proposal for tables and CLIs. */
export function summarizeProposal(proposal: InferredDependency): Record<string, JsonValue> {
  const { taskIds: _taskIds, ledgerIds: _ledgerIds, traceIds: _traceIds, ...summary } = proposal;
  return summary as unknown as Record<string, JsonValue>;
}
