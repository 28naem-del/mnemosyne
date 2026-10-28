import type { MemoryKind, MemoryRecord } from '../local/types.js';
import type { MemoryRuntime, RuntimeSkill } from '../runtime/index.js';

/** The only inference rule this module implements. Recorded on every proposal and
 * receipt, so a later rule can never be mistaken for this one. */
export type DependencyRule = 'co-use-success-v1';

/** The gate a co-use pair must clear before it is surfaced for review. */
export interface InferenceThresholds {
  /** Distinct SUCCESSFUL tasks whose used set held both records. Never below 2:
   * a single co-use cannot tell a premise from a coincidence. */
  minSupport: number;
  /** support / runs: the share of the dependent's successful runs that used the premise. */
  minReliance: number;
  /** Co-use against the base rate of both records; rejects records used everywhere. */
  minLift: number;
  /** Wilson lower bound on reliance; small samples need a stronger signal. */
  minConfidence: number;
  /** Width of that bound in standard deviations. */
  z: number;
}

export interface InferDependenciesOptions extends Partial<InferenceThresholds> {
  /** Ledger pages of at most 1000 entries each that one pass may read. Default 50. */
  maxLedgerPages?: number;
  /** Memory records (traces, dependents and premises) one pass may list. Default 50 000. */
  maxRecords?: number;
  /** Kinds that may depend on an inferred premise. Default `['procedure']`. */
  dependentKinds?: MemoryKind[];
  /** Kinds that may be an inferred premise. Default `['fact', 'decision', 'preference']`.
   * Disjoint from `dependentKinds`, so no inferred edge can close a cycle between kinds. */
  premiseKinds?: MemoryKind[];
  /** Upper bound on returned proposals, best first. Default 1000. */
  maxProposals?: number;
}

/**
 * One undeclared dependency, surfaced for review and stored nowhere. `from` relies
 * on `to`. Every count is over distinct task identifiers; `support`, `runs` and
 * `premiseRuns` count successful tasks with an explicit used set only.
 */
export interface InferredDependency {
  rule: DependencyRule;
  /** The dependent: the current record of its lineage when inferred. */
  from: string;
  /** The premise: its current record when inferred. */
  to: string;
  fromKind: MemoryKind;
  toKind: MemoryKind;
  /** Present when the dependent is a `MemoryRuntime` skill; acceptance links the
   * premise to the skill instead of correcting the record directly. */
  skillId?: string;
  support: number;
  runs: number;
  premiseRuns: number;
  /** Successful tasks with an explicit used set in this pass (the base for lift). */
  tasks: number;
  reliance: number;
  lift: number;
  /** log2(lift). */
  pmi: number;
  /** Wilson lower bound on reliance; candidate-only retrievals widen the denominator. */
  confidence: number;
  /** Successful runs in which the premise was retrieved or a ledger candidate but not used. */
  ignored: number;
  /** Successful untraced retrievals that returned both records. Corroboration only:
   * returned is not used, so it never counts toward support. */
  returnedSupport: number;
  /** Successful untraced retrievals that returned the dependent while the premise
   * was only a candidate. Negative-only evidence. */
  candidateOnly: number;
  /** Failed tasks that used both. Reported; a failure is never support. */
  failedCoUse: number;
  /** Up to 16 supporting task identifiers, sorted. */
  taskIds: string[];
  /** Up to 16 ledger entries (recall verdicts, outcomes) behind the support, sorted. */
  ledgerIds: string[];
  /** Up to 16 runtime trace records behind the support, sorted. */
  traceIds: string[];
  /** sha256 of the canonical proposal without this field; the review handle. */
  digest: string;
}

export type InferenceRejection = 'reviewed' | 'declared' | 'support' | 'reliance' | 'lift' | 'confidence' | 'inactive' | 'incompatible' | 'cycle';

export interface InferenceEvidence {
  rule: DependencyRule;
  thresholds: InferenceThresholds;
  scanned: { records: number; traces: number; ledgerEntries: number; ledgerPages: number; truncated: boolean };
  tasks: { successful: number; failed: number; unjudged: number; conflicting: number; traced: number; attributed: number; recallOnly: number };
  /** Pairs with at least one successful co-use, and why each was not proposed. */
  pairs: { considered: number; proposed: number; rejected: Record<InferenceRejection, number> };
}

export interface InferenceResult {
  proposals: InferredDependency[];
  evidence: InferenceEvidence;
}

export type DependencyDecision = 'accept' | 'reject';

/** The `dependency` ledger receipt: the reviewed proposal and the decision on it. */
export type DependencyReceipt = Omit<InferredDependency, 'skillId'> & {
  skillId?: string;
  decision: DependencyDecision;
  reviewer: string;
  recordedAt: string;
  note?: string;
};

export interface ReviewDependencyOptions {
  /** Required for skill dependents when the caller already holds a runtime;
   * otherwise one is created over the same memory. */
  runtime?: MemoryRuntime;
  /** Receipt clock. Defaults to the system clock. */
  now?: () => Date;
  /** Free-text reviewer note, at most 1024 bytes. */
  note?: string;
  /** Lineage scan bound used to follow a dependent that was re-versioned. Default 50 000. */
  maxRecords?: number;
}

export interface DependencyReview {
  receiptId: string;
  decision: DependencyDecision;
  digest: string;
  /** The record that now carries the edge (accept), or the reviewed dependent (reject). */
  dependentId: string;
  /** On accept: the dependent version the link superseded. */
  supersededId?: string;
  skillId?: string;
}

/** Why the premise guard is holding a dependent back from execution. */
export interface PremiseHold {
  /** The premise record that was used together with the dependent. */
  premiseId: string;
  reason: 'premise-changed' | 'premise-ineligible';
  support: number;
  runs: number;
  reliance: number;
}

export interface PremiseGuardOptions extends InferDependenciesOptions {
  /** A co-used premise is treated as independent, and never holds, only when the
   * Wilson upper bound (at `z`) on the dependent's reliance on it is below this:
   * the dependent ran successfully often enough without it. Default 0: every
   * successful co-use holds. A release on statistics can let a true premise that
   * the controller rarely reported through (the first v1 gate run did, at 0.34;
   * see docs/DEPENDENCIES.md), so raising it trades that risk for reviewer load. */
  holdReliance?: number;
}

/**
 * A read-only filter for executors. It never writes. It holds a procedure or skill
 * that was used together with a premise in a successful task when that premise has
 * since been corrected, invalidated or become ineligible, and no reviewer decided
 * the pair. It covers the pairs inference could not yet propose (for example a
 * single co-use), until a reviewer accepts, rejects or revises the dependent.
 */
export interface PremiseGuard {
  holds(record: MemoryRecord | string): PremiseHold[];
  allows(record: MemoryRecord | string): boolean;
  /** Drops held items from `recall()` results or `compile().items`. */
  filter<T extends MemoryRecord | { memory: MemoryRecord }>(items: T[]): T[];
  /** Reports a held skill as retired with a review reason; other skills unchanged. */
  skill(skill: RuntimeSkill | null): RuntimeSkill | null;
}
