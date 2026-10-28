/**
 * Types for the outcome-gated, reversible consolidation gate.
 *
 * A consolidation pass is a signed diff over the owner's records. The gate
 * replays the agent's own recorded retrievals that carry a verifier outcome
 * under the current state S and under S+D (on a scratch copy), and keeps D only
 * when the recorded outcomes do not regress and every invariant holds. Every
 * decision is a receipt in the ledger, chained by digest.
 */
import type { MemoryKind, MemoryRecord, MemoryTrust } from '../local/types.js';

/** The closed proposal menu (P8). Nothing outside it can be expressed. */
export const CONSOLIDATION_KINDS = ['merge', 'supersede', 'split', 'delete', 'abstract'] as const;
export type ConsolidationKind = (typeof CONSOLIDATION_KINDS)[number];

/** Kinds whose live application is an exact, reversible addition under the public kernel API. */
export const ADDITIVE_KINDS: readonly ConsolidationKind[] = ['merge', 'split', 'abstract'];

export const CONSOLIDATION_VERDICTS = ['kept', 'rolled_back', 'no_evidence', 'invalid_run', 'conflict'] as const;
export type ConsolidationVerdict = (typeof CONSOLIDATION_VERDICTS)[number];

/** A record a proposal would create. Visibility is always private and the source is the pass. */
export interface ConsolidationOutput {
  text: string;
  kind: MemoryKind;
  trust: MemoryTrust;
  /** Defaults to the proposal's sources. Every id must be in the candidate set. */
  dependencies?: string[];
  key?: string;
}

export interface ConsolidationProposal {
  kind: ConsolidationKind;
  /** Candidate ids the proposal reads. merge/abstract: at least 2; split/supersede: exactly 1; delete: at least 1. */
  sources: string[];
  /** merge/abstract: exactly 1; split: at least 2; supersede/delete: none. */
  outputs: ConsolidationOutput[];
  /** supersede only: the candidate that replaces the source. */
  by?: string;
  rationale: string;
}

export interface ConsolidationCandidate { id: string; fingerprint: string }

export interface ConsolidationSignature {
  algorithm: 'ed25519';
  /** SHA-256 (hex) of the raw 32-byte public key. */
  keyId: string;
  /** Raw 32-byte Ed25519 public key, base64url. */
  publicKey: string;
  /** Signature, base64url. */
  value: string;
}

/** The signed diff. `digest` covers everything except `digest` and `signature`. */
export interface ConsolidationDiff {
  schema: 'mnemosyne-consolidation-diff-v1';
  workspaceId: string;
  agentId: string;
  /** Gate cut: the store-clock time the state hash and candidate fingerprints were read at. */
  cut: string;
  stateBefore: string;
  candidateSet: ConsolidationCandidate[];
  proposals: ConsolidationProposal[];
  proposer: string;
  digest: string;
  signature: ConsolidationSignature;
}

export type ConsolidationCaps = Record<ConsolidationKind, number>;

export interface ConsolidationInvariant {
  name: string;
  ok: boolean;
  /** Present on a failure: which proposal and why. Never record text. */
  detail?: string;
}

export interface ConsolidationTaskScores { tasks: number; before: number; after: number; delta: number }

export interface ConsolidationScores extends ConsolidationTaskScores {
  /** Tasks held out of the keep decision's main set (20% when the replay set has at least 10 tasks). */
  holdout: ConsolidationTaskScores | null;
  /** The same replay set scored against an empty store: memory's own contribution is `before - noMemory`. */
  noMemory: number;
  /** Recorded retrievals that had a verifier outcome but could not be replayed (no query text or no labelled ids). */
  unreplayable: number;
}

export interface ConsolidationCreated { id: string; fingerprint: string; proposal: number }

/** The ledger payload for one gate decision or one rollback (P7). Holds ids and digests, never record text. */
export interface ConsolidationReceipt {
  schema: 'mnemosyne-consolidation-receipt-v1';
  action: 'gate' | 'rollback';
  passId: string;
  /** rollback only: the kept pass this receipt undoes. */
  rollbackOf?: string;
  replaySetSha256: string | null;
  verifierSha256: string;
  stateBefore: string;
  candidateDiffSha256: string | null;
  signature: ConsolidationSignature | null;
  stateAfter: string;
  scores: ConsolidationScores | null;
  verdict: ConsolidationVerdict;
  reason: string;
  invariants: ConsolidationInvariant[];
  proposals: { kind: ConsolidationKind; proposalSha256: string }[];
  created: ConsolidationCreated[];
  /** rollback only: whether the state after rollback hashes equal to the kept pass's stateBefore. */
  restored?: boolean;
  prevDigest: string | null;
  recordedAt: string;
  digest: string;
  /** Signature over `digest` by the gate's key, so a verdict cannot be rewritten without it. */
  receiptSignature: ConsolidationSignature;
}

/** One replayable task: a recorded retrieval with its verifier outcome. */
export interface ReplayTask {
  ledgerId: string;
  /** Ledger sequence: deterministic for a deterministic history, unlike the id. */
  sequence: number;
  taskId: string;
  success: boolean;
  query: string;
  lexicalScoring: 'overlap' | 'bm25';
  limit: number;
  gold: string[];
  harmful: string[];
}

export interface ReplaySet { tasks: ReplayTask[]; unreplayable: number; sha256: string }

/** Read-only view a caller-supplied proposer receives. It never sees the replay set. */
export interface ConsolidationProposerInput {
  candidates: readonly MemoryRecord[];
  caps: Readonly<ConsolidationCaps>;
}

/** Synchronous and model-free by contract: no bundled model, no network. */
export type ConsolidationProposer = (input: ConsolidationProposerInput) => ConsolidationProposal[];
