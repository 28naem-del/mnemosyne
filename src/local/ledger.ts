import type { LedgerEntry, LedgerEvent } from './types.js';

export const LEDGER_EVENTS: readonly LedgerEvent[] = ['store', 'correction', 'recall', 'outcome', 'erasure'];

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
`;

export interface LedgerRow { sequence: number; id: string; workspace_id: string; agent_id: string; event: string; recorded_at: string; memory_id: string | null; data: string }

/** Rebuilds an entry, restoring retrieval results from the surviving references. */
export function decodeLedgerRow(row: LedgerRow, results: { memoryId: string; rank: number; score: number }[]): LedgerEntry {
  const payload = JSON.parse(row.data) as Omit<LedgerEntry, 'id' | 'sequence' | 'event' | 'recordedAt' | 'workspaceId' | 'agentId' | 'memoryId'>;
  const entry: LedgerEntry = {
    id: row.id, sequence: row.sequence, event: row.event as LedgerEvent, recordedAt: row.recorded_at,
    workspaceId: row.workspace_id, agentId: row.agent_id, ...(row.memory_id === null ? {} : { memoryId: row.memory_id }), ...payload,
  };
  if (entry.retrieval) entry.retrieval = { ...entry.retrieval, results: [...results].sort((a, b) => a.rank - b.rank) };
  return entry;
}
