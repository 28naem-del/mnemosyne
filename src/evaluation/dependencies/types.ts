import type { InferenceEvidence, InferenceThresholds } from '../../dependencies/index.js';

/** Synthetic dependency corpus v1. Every record, task and ground-truth edge is
 * generated from a seed; nothing is drawn from real agent data. Records are
 * addressed by stable keys (`F001`, `P017`, `S003`), never by store ids. */
export type CorpusPremiseKind = 'fact' | 'decision' | 'preference';

export interface CorpusPremise {
  key: string;
  kind: CorpusPremiseKind;
  text: string;
  /** Declared dependencies (premise keys); only decisions declare a fact. */
  declared: string[];
  /** Applied when the eval corrects this premise. */
  revision: string;
  /** Used incidentally by many dependents; never a true premise. */
  hub: boolean;
}

export interface CorpusDependent {
  key: string;
  type: 'procedure' | 'skill';
  text: string;
  /** Skill definition, present for `type: 'skill'`. */
  skill?: { name: string; steps: string[] };
  /** Declared premises: record dependencies of a procedure, evidence ids of a skill. */
  declared: string[];
  /** Successful runs planned for this dependent. */
  runs: number;
}

export type DecoyClass = 'retrieved-unused' | 'failed-only' | 'sibling' | 'incidental' | 'hub';

export interface CorpusEdge { dependent: string; premise: string }
export interface CorpusTrueEdge extends CorpusEdge { usage: number }
export interface CorpusDecoy extends CorpusEdge { class: DecoyClass }

/** One synthetic task. `trace` tasks recall, act and record a runtime trace;
 * `recall-only` tasks recall and receive a verifier verdict without a used set. */
export interface CorpusTask {
  id: string;
  dependent: string;
  mode: 'trace' | 'recall-only';
  query: string;
  retrieved: string[];
  used: string[];
  success: boolean;
  /** `trace`: the trace carries the outcome; `verifier`: recordRetrievalOutcome; `none`: unjudged. */
  judge: 'trace' | 'verifier' | 'none';
}

export interface CorpusParameters {
  facts: number;
  decisions: number;
  declaringDecisions: number;
  preferences: number;
  hubs: number;
  procedures: number;
  rareProcedures: number;
  /** Runs of each rare procedure. Two is the least a two-task support rule can
   * see; one run makes the class invisible to every such rule by construction. */
  rareRuns: number;
  skills: number;
  declaredRate: number;
  conditionalRate: number;
  conditionalUsage: [number, number];
  runs: [number, number];
  failureRate: number;
  dropoutRate: number;
  hubRate: number;
  incidentalRate: number;
  incidentalUsage: [number, number];
  siblingRate: number;
  recallOnlyRate: number;
  unjudgedRate: number;
  verifierShare: number;
}

export interface DependencyCorpus {
  suite: 'dependencies-v1';
  synthetic: true;
  seed: number;
  generator: string;
  parameters: CorpusParameters;
  premises: CorpusPremise[];
  dependents: CorpusDependent[];
  truth: CorpusTrueEdge[];
  decoys: CorpusDecoy[];
  tasks: CorpusTask[];
}

export interface DependencyEvalMetrics {
  /** Micro: (correction, true undeclared dependent) pairs invalidated or retired. */
  recall: number;
  /** Macro over corrected premises that have at least one true undeclared dependent. */
  recallMacro: number;
  recallPairs: { invalidated: number; total: number };
  /** Accepted edges whose premise is in the dependent's true closure. */
  precision: number;
  acceptedEdges: { correct: number; total: number; falseByClass: Record<string, number> };
  /** Gate number: stale procedures or skills an executor would still run through
   * the documented path (kernel eligibility, compile, recall, getSkill, each
   * passed through the premise guard). */
  staleExecutions: number;
  /** Same executor without the premise guard: kernel and runtime state only. */
  kernelStaleExecutions: number;
  /** Kernel-only stale executions on dependents whose premise was declared or accepted. Must be 0. */
  kernelStaleOnLinked: number;
  staleChecks: number;
  corrections: number;
  /** Dependents invalidated by a correction although the premise is not in their true closure. */
  overInvalidated: number;
  /** Dependents the guard held although the premise is not in their true closure. */
  guardOverHolds: number;
  /** True undeclared pairs the kernel missed that the guard held. */
  guardHeldMisses: number;
  /** Misses whose carrying premise had fewer judged successful co-uses than
   * minSupport: invisible to any rule that requires two distinct tasks. */
  missesBelowMinSupport: number;
  /** Recall over the pairs whose carrying premise reached minSupport co-uses.
   * Diagnostic only; the gate is `recall`. */
  recallObservable: number;
  /** Decomposition of the stale gate. Inference plus accept-all with the guard
   * off: the same count as `kernelStaleExecutions`, named for what it isolates. */
  staleWithoutGuard: number;
  /** Guard on, zero accepted edges (`guardOnly.staleExecutions`): what the
   * guard prevents on its own, with no help from inference. */
  staleGuardOnly: number;
  /** (correction, dependent) checks the guard held, after accept-all. */
  guardHolds: number;
  /** Holds on a premise in the dependent's true closure. */
  guardTrueHolds: number;
  /** Holds on a premise outside the true closure (includes `guardOverHolds`,
   * plus holds on dependents a false edge had already invalidated). */
  guardFalseHolds: number;
  /** guardFalseHolds / guardHolds; 0 when nothing was held. */
  guardFalseHoldRate: number;
  guardOnly: GuardOnlyMetrics;
}

/** The guard alone: a fresh store, no inference, no accepted edge, the same
 * corrections and guarded executor as the main run. */
export interface GuardOnlyMetrics {
  staleExecutions: number;
  staleChecks: number;
  /** True undeclared pairs the kernel left active: what would run with neither inference nor guard (lower bound). */
  undeclaredLeftActive: number;
  holds: number;
  trueHolds: number;
  falseHolds: number;
  falseHoldRate: number;
}

export interface DependencyEvalResult {
  metrics: DependencyEvalMetrics;
  /** `skipped`: proposals whose eval-policy review threw, with the error. */
  inference: { proposals: number; accepted: number; skipped: { dependent: string; premise: string; error: string }[]; evidence: InferenceEvidence };
  /** Guarded stale executions, with the path that handed the stale dependent out. */
  escapes: { dependent: string; premise: string; via: string[] }[];
  /** `coUses`: judged successful tasks whose reported used set held the dependent
   * and the premise that carries the pair (corpus-side count). */
  misses: { dependent: string; premise: string; reason: string; coUses: number }[];
  falseEdges: { dependent: string; premise: string; class: string }[];
}

export interface DependencyReport {
  suite: 'dependencies-v1';
  synthetic: true;
  rule: 'co-use-success-v1';
  retrieval: 'lexical';
  corpus: { sha256: string; seed: number; matchesGenerator: boolean; records: number; premises: number; procedures: number; skills: number; tasks: number; trueEdges: number; declaredEdges: number; decoys: Record<DecoyClass, number> };
  thresholds: InferenceThresholds & { holdReliance: number };
  gate: { recall: { value: number; min: number }; precision: { value: number; min: number }; staleExecutions: { value: number; max: number }; passed: boolean };
  result: DependencyEvalResult;
  /** `tuning`: seeds the thresholds were chosen on; `held-out`: never looked at while tuning. */
  robustness: { seed: number; role: 'tuning' | 'held-out'; recall: number; precision: number; staleExecutions: number; kernelStaleExecutions: number; overInvalidated: number; guardOverHolds: number; staleWithoutGuard: number; staleGuardOnly: number; guardHolds: number; guardTrueHolds: number; guardFalseHolds: number; guardFalseHoldRate: number }[];
}
