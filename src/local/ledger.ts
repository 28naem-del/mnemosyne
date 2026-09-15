import { createHash } from 'node:crypto';
import type { LedgerCandidate, LedgerEntry, LedgerEvent, LedgerRetrievalConfig, RetrievalStage } from './types.js';

export const LEDGER_EVENTS: readonly LedgerEvent[] = ['store', 'correction', 'recall', 'outcome', 'erasure'];

/** Ordered so a decoded candidate set reads in the order the stages actually ran. */
export const RETRIEVAL_STAGES: readonly RetrievalStage[] = ['lexical', 'dense', 'fused', 'reranked'];

/**
 * Digest of the retrieval configuration, over canonically ordered keys so the
 * hash depends on the values and not on property insertion order.
 *
 * Two retrievals are only comparable when this matches: it is what lets a later
 * training or bisect pass separate "the ranking changed" from "the configuration
 * changed underneath us".
 */
export function retrievalConfigSha256(config: LedgerRetrievalConfig): string {
  const canonical = JSON.stringify(Object.keys(config).sort().map(key => [key, config[key as keyof LedgerRetrievalConfig]]));
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Schema for the provenance and outcome ledger.
 *
 * `sequence` is the SQLite rowid, so it is monotonic per database and doubles as
 * the pagination cursor. `memory_id` cascades, which is what keeps erasure whole:
 * forgetting a record removes its store, correction and outcome entries.
 * Retrieval entries name no record directly — the records they returned live in
 * `local_ledger_results`, which cascades per record, so an erased memory
 * disappears from past retrievals while the fact that a retrieval happened
 * remains auditable.
 *
 * `local_ledger_candidates` holds the same relationship for everything a
 * retrieval *considered*, one row per (stage, candidate). Recording the rejected
 * candidates alongside the returned ones is what makes a retrieval replayable and
 * an outcome attributable to a ranking decision rather than to the result set
 * alone. It cascades on the same two foreign keys, so widening what the ledger
 * remembers does not widen what survives `forget()`.
 */
export const LEDGER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS local_ledger(
    sequence INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    event TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS local_ledger_scope ON local_ledger(workspace_id,agent_id,sequence);
  CREATE INDEX IF NOT EXISTS local_ledger_event ON local_ledger(event,sequence);
  CREATE INDEX IF NOT EXISTS local_ledger_memory ON local_ledger(memory_id);
  CREATE TABLE IF NOT EXISTS local_ledger_results(
    ledger_id TEXT NOT NULL REFERENCES local_ledger(id) ON DELETE CASCADE,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    rank INTEGER NOT NULL,
    score REAL NOT NULL,
    PRIMARY KEY(ledger_id,memory_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS local_ledger_results_memory ON local_ledger_results(memory_id);
  CREATE TABLE IF NOT EXISTS local_ledger_candidates(
    ledger_id TEXT NOT NULL REFERENCES local_ledger(id) ON DELETE CASCADE,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    rank INTEGER NOT NULL,
    score REAL NOT NULL,
    PRIMARY KEY(ledger_id,stage,memory_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS local_ledger_candidates_memory ON local_ledger_candidates(memory_id);
`;

export interface LedgerRow { sequence: number; id: string; workspace_id: string; agent_id: string; event: string; recorded_at: string; memory_id: string | null; data: string }

/**
 * Rebuilds an entry, restoring retrieval results and the per-stage candidate set
 * from the surviving references.
 *
 * Entries written before the candidate-set schema carry no `schema` marker. They
 * are reported as schema 1 with an empty candidate set and a null verifier, which
 * is the truth about them — they are never dressed up as schema 2 by inventing a
 * configuration they did not record.
 */
export function decodeLedgerRow(row: LedgerRow, results: { memoryId: string; rank: number; score: number }[], candidates: LedgerCandidate[] = []): LedgerEntry {
  const payload = JSON.parse(row.data) as Omit<LedgerEntry, 'id' | 'sequence' | 'event' | 'recordedAt' | 'workspaceId' | 'agentId' | 'memoryId'>;
  const entry: LedgerEntry = {
    id: row.id, sequence: row.sequence, event: row.event as LedgerEvent, recordedAt: row.recorded_at,
    workspaceId: row.workspace_id, agentId: row.agent_id, ...(row.memory_id === null ? {} : { memoryId: row.memory_id }), ...payload,
  };
  if (entry.retrieval) {
    const order = new Map(RETRIEVAL_STAGES.map((stage, index) => [stage, index]));
    entry.retrieval = {
      ...entry.retrieval,
      schema: entry.retrieval.schema ?? 1,
      results: [...results].sort((a, b) => a.rank - b.rank),
      candidates: [...candidates].sort((a, b) => (order.get(a.stage) ?? RETRIEVAL_STAGES.length) - (order.get(b.stage) ?? RETRIEVAL_STAGES.length) || a.rank - b.rank),
      candidateCounts: entry.retrieval.candidateCounts ?? [],
      verifier: entry.retrieval.verifier ?? null,
    };
  }
  return entry;
}
