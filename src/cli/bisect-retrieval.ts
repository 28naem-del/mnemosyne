/**
 * Which retrieval path `mnemosy bisect` re-executes.
 *
 * Bisect's Oracle B must run the store's own retriever (`src/local/bisect.ts`),
 * so the CLI has to open its auditor on the path the store actually retrieves
 * with. The retrieval mode is an option a store is opened with, not a setting
 * the database keeps, so `auto` reads it off the data a hybrid recall leaves
 * behind: the first hybrid recall embeds every visible record of the scope with
 * the bundled model and stores the vectors in `local_embeddings`. Stored vectors
 * for that model on this agent's records — exactly the rows Oracle B carries
 * into every rebuild — mean the store has been retrieving on hybrid; none mean
 * it has only ever retrieved lexically (or never recalled at all). The dense
 * index it last served hybrid recall with is recorded beside them.
 */
import { DatabaseSync } from 'node:sqlite';
import { BUNDLED_EMBEDDING_ID } from '../local/embedding/index.js';
import { readIdentity, resolveDenseIndexMode } from '../local/vector/index.js';

export const BISECT_RETRIEVAL_MODES = ['auto', 'lexical', 'hybrid'] as const;
export type BisectRetrievalRequest = typeof BISECT_RETRIEVAL_MODES[number];

/** What `mnemosy bisect` reports beside the result: what was asked for, the path chosen, and why. */
export interface BisectRetrievalSelection {
  requested: BisectRetrievalRequest;
  mode: 'lexical' | 'hybrid';
  signal: string;
}

/** Validates `--retrieval`; runs before any database is opened. */
export function bisectRetrievalRequest(value: string | boolean | undefined): BisectRetrievalRequest {
  if (value === undefined) return 'auto';
  if (typeof value !== 'string' || !(BISECT_RETRIEVAL_MODES as readonly string[]).includes(value)) throw new Error('--retrieval must be auto, lexical or hybrid.');
  return value as BisectRetrievalRequest;
}

/** Read-only probe of the store's own data. Never writes, never loads a model or an extension. */
function storedRetrieval(path: string, workspaceId: string, agentId: string): { vectors: number; index: string | null } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(`SELECT count(*) AS count FROM local_embeddings e JOIN memories m ON m.id=e.memory_id
      WHERE m.workspace_id=? AND m.agent_id=? AND e.model=?`).get(workspaceId, agentId, BUNDLED_EMBEDDING_ID) as { count: number | bigint };
    return { vectors: Number(row.count), index: readIdentity(db)?.kind ?? null };
  } finally { db.close(); }
}

/**
 * Resolves the path, and refuses an hnsw store before opening it: bisect cannot
 * reproduce an hnsw index, and opening a store whose recorded index is hnsw with
 * the default index mode would rebuild that index as sqlite-vec.
 */
export function selectBisectRetrieval(requested: BisectRetrievalRequest, store: { path: string; workspaceId: string; agentId: string }, hnswRefusal: string): BisectRetrievalSelection {
  if (requested === 'lexical') return { requested, mode: 'lexical', signal: '--retrieval lexical' };
  const stored = storedRetrieval(store.path, store.workspaceId, store.agentId);
  const mode = requested === 'hybrid' || stored.vectors > 0 ? 'hybrid' : 'lexical';
  if (mode === 'hybrid') {
    const indexMode = resolveDenseIndexMode(undefined);
    if (indexMode === 'hnsw' || (indexMode !== 'exact' && stored.index === 'hnsw')) throw new Error(hnswRefusal);
  }
  const signal = requested === 'hybrid' ? '--retrieval hybrid'
    : stored.vectors > 0 ? `${stored.vectors} stored vector(s) for ${BUNDLED_EMBEDDING_ID} on this agent's records`
      : `no stored vectors for ${BUNDLED_EMBEDDING_ID} on this agent's records`;
  return { requested, mode, signal };
}
