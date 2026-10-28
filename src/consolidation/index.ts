/**
 * Outcome-gated, reversible consolidation: a signed diff is replayed against
 * the agent's own recorded outcomes and kept only when it does not regress,
 * breaks no invariant, and can be undone exactly. See docs/CONSOLIDATION.md.
 */
export * from './types.js';
export {
  createConsolidationSigner, verifyConsolidationSignature, diffSignatureMessage, receiptSignatureMessage,
  type ConsolidationSigner, type ConsolidationSignerOptions,
} from './signing.js';
export { buildReplaySet, splitHoldout } from './replay-set.js';
export { DEFAULT_CONSOLIDATION_CAPS, POLICY_KINDS, deterministicProposer, proposalSha256, selectCandidates, untouchable } from './proposer.js';
export { INVARIANT_NAMES, checkInvariants } from './invariants.js';
export {
  CONSOLIDATION_GATE_VERSION, CONSOLIDATION_VERIFIER_SHA256, MIN_REPLAY_TASKS,
  consolidate, consolidationReceipts, diffDigest, gateConsolidation, passRecords, proposeConsolidation, receiptDigest,
  rollbackConsolidation, verifyConsolidationChain,
  type ConsolidateOptions, type ConsolidationChainReport, type ConsolidationResult, type GateConsolidationOptions,
  type ProposeConsolidationOptions, type RollbackConsolidationResult, type StoredReceipt,
} from './gate.js';
