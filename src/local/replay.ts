/**
 * Bitemporal replay: the belief state at a cut point, and the diff between two.
 *
 * This module adds no state and no schema. It reads the kernel's own bitemporal
 * gate — `LocalMemory.#at()`, reached through the public `list()` / `getAt()`
 * pair — so a replayed state is by construction the same projection retrieval
 * sees, not a second implementation of the same rules that can drift from it.
 *
 * What is in the state, and what is deliberately not, is documented on
 * {@link REPLAY_EXCLUSIONS} and reported next to every hash: derived lexical and
 * vector indexes, embedding blobs, the ledger, the audit and idempotency tables
 * and the outcome table are all excluded. They are either a pure function of the
 * records, model output whose bytes depend on an ONNX build, or a log *about*
 * the state rather than the state.
 */
import { createHash } from 'node:crypto';
import type { LedgerEntry, LedgerPage, LedgerQuery, ListMemoryInput, MemoryPage, MemoryRecord } from './types.js';

/** Bumped only when the hashed bytes change; an old hash must never silently mean a new thing. */
export const REPLAY_STATE_ALGORITHM = 'mnemosyne-replay-state-v1';

/** Named so a caller can see what the hash does not cover without reading this file. */
export const REPLAY_EXCLUSIONS: readonly string[] = [
  'local_search', 'local_terms', 'local_embeddings', 'local_embedding_models',
  'local_vec_labels', 'local_vec_index', 'local_settings',
  'local_ledger', 'local_ledger_results', 'local_ledger_candidates',
  'audit', 'idempotency', 'outcomes',
];

/** Both bounds are explicit: replay never reads a wall clock. */
export interface ReplayCut { asOf: string; knownAt: string }

export interface ReplayState {
  algorithm: typeof REPLAY_STATE_ALGORITHM;
  cut: ReplayCut;
  /** SHA-256 over the canonical serialization of the visible records. */
  stateSha256: string;
  /** Records visible at the cut. */
  records: number;
  /** Records in scope at all, visible or not. `scanned - records` were gated out. */
  scanned: number;
  /** Visible records carrying `trust: 'untrusted'`; they ARE part of the state. */
  untrusted: number;
  excluded: readonly string[];
  /** Present only when `records: true` was requested. */
  items?: MemoryRecord[];
}

export interface ReplayStateOptions {
  /** Return the projected records alongside the hash. Off by default: a 10k state is not console output. */
  records?: boolean;
  /** Page size for the underlying `list()` scan. 1–1000. */
  pageSize?: number;
}

export interface ReplaySource {
  list(options?: ListMemoryInput): MemoryPage;
  getAt(id: string, time?: { asOf?: string; knownAt?: string }): MemoryRecord | null;
  ledger?(query?: LedgerQuery): LedgerPage;
}

/**
 * Canonical JSON with **code-unit** key ordering.
 *
 * Deliberately not `validation.canonical()`, which sorts keys with
 * `String.prototype.localeCompare`. That is ICU- and locale-dependent
 * (`'Z'.localeCompare('a')` is 1 under en-US collation while code-unit order puts
 * `'Z'` first), which is harmless when one process compares two of its own
 * fingerprints and fatal for a hash two machines must agree on.
 *
 * Array order is preserved, not sorted: order is semantic in this schema
 * (`dependencies` above all) and is stored order, identical for both readers of
 * the same database. `undefined` entries are dropped, matching JSON.
 */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * SHA-256 over the canonical records, ordered by id in code-unit order.
 *
 * The cut point is NOT hashed. A state hash hashes the state: two different cut
 * points that produce the same beliefs should, and do, hash equal. The cut is
 * reported beside the hash instead.
 */
export function stateHash(records: readonly MemoryRecord[]): string {
  const ordered = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const digest = createHash('sha256').update(`${REPLAY_STATE_ALGORITHM}\n`);
  for (const record of ordered) digest.update(canonicalize(record)).update('\n');
  return digest.digest('hex');
}

/** Reads every record in scope, in a stable order, without trusting `list()`'s ordering. */
function scopeIds(memory: ReplaySource, pageSize: number): MemoryRecord[] {
  const all: MemoryRecord[] = [];
  let cursor: string | undefined;
  do {
    const page: MemoryPage = memory.list({ limit: pageSize, includeInactive: true, includeUntrusted: true, ...(cursor === undefined ? {} : { cursor }) });
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return all;
}

/**
 * The belief state at `(asOf, knownAt)`.
 *
 * `asOf` defaults to `knownAt`, exactly as `LocalMemory.#temporal()` does, so a
 * single-bound replay means the same thing here as it does at a recall.
 */
export function replayState(memory: ReplaySource, cut: { asOf?: string; knownAt: string }, options: ReplayStateOptions = {}): ReplayState {
  const resolved: ReplayCut = { knownAt: cut.knownAt, asOf: cut.asOf ?? cut.knownAt };
  const pageSize = Math.min(Math.max(options.pageSize ?? 1000, 1), 1000);
  const scope = scopeIds(memory, pageSize);
  const items: MemoryRecord[] = [];
  for (const stored of scope) {
    const visible = memory.getAt(stored.id, resolved);
    if (visible) items.push(visible);
  }
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    algorithm: REPLAY_STATE_ALGORITHM,
    cut: resolved,
    stateSha256: stateHash(items),
    records: items.length,
    scanned: scope.length,
    untrusted: items.filter((record) => record.trust === 'untrusted').length,
    excluded: REPLAY_EXCLUSIONS,
    ...(options.records ? { items } : {}),
  };
}

export interface ReplayProvenance {
  ledgerId: string;
  sequence: number;
  event: LedgerEntry['event'];
  recordedAt: string;
  /** Present on `store` entries. */
  provenance?: LedgerEntry['provenance'];
  /** Present on `correction` entries. */
  correction?: LedgerEntry['correction'];
  /** Present on `promotion` entries: the decision on this record, granted or quarantined. */
  promotion?: LedgerEntry['promotion'];
}

export interface ReplayDiffRecord {
  id: string;
  kind: MemoryRecord['kind'];
  text: string;
  source: MemoryRecord['source'];
  trust: MemoryRecord['trust'];
  validFrom?: string;
  validUntil?: string;
  createdAt: string;
  supersedes?: string;
  /** The ledger entries that put this record here, oldest first. Empty when the ledger is off. */
  ledger: ReplayProvenance[];
}

export interface ReplayDiffChange {
  id: string;
  fields: string[];
  before: ReplayDiffRecord;
  after: ReplayDiffRecord;
}

export interface ReplayDiff {
  algorithm: typeof REPLAY_STATE_ALGORITHM;
  from: { cut: ReplayCut; stateSha256: string; records: number };
  to: { cut: ReplayCut; stateSha256: string; records: number };
  added: ReplayDiffRecord[];
  removed: ReplayDiffRecord[];
  changed: ReplayDiffChange[];
}

/** Ledger entries naming this record, oldest first; silent when the ledger is disabled. */
function provenanceOf(memory: ReplaySource, id: string): ReplayProvenance[] {
  if (typeof memory.ledger !== 'function') return [];
  let page: LedgerPage;
  try {
    page = memory.ledger({ memoryId: id, events: ['store', 'correction', 'promotion'], limit: 100 });
  } catch {
    return [];
  }
  return page.entries.map((entry) => ({
    ledgerId: entry.id, sequence: entry.sequence, event: entry.event, recordedAt: entry.recordedAt,
    ...(entry.provenance === undefined ? {} : { provenance: entry.provenance }),
    ...(entry.correction === undefined ? {} : { correction: entry.correction }),
    ...(entry.promotion === undefined ? {} : { promotion: entry.promotion }),
  }));
}

function diffRecord(memory: ReplaySource, record: MemoryRecord): ReplayDiffRecord {
  return {
    id: record.id, kind: record.kind, text: record.text, source: record.source, trust: record.trust,
    ...(record.validFrom === undefined ? {} : { validFrom: record.validFrom }),
    ...(record.validUntil === undefined ? {} : { validUntil: record.validUntil }),
    createdAt: record.createdAt,
    ...(record.supersedes === undefined ? {} : { supersedes: record.supersedes }),
    ledger: provenanceOf(memory, record.id),
  };
}

/** Field-level comparison over the projected record, canonical value equality. */
function changedFields(before: MemoryRecord, after: MemoryRecord): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return keys.filter((key) => canonicalize((before as unknown as Record<string, unknown>)[key]) !== canonicalize((after as unknown as Record<string, unknown>)[key]));
}

/**
 * What changed between two cut points, with the source and the ledger entries
 * that caused each change. This is the "and knows why" half of moment 1.
 */
export function replayDiff(memory: ReplaySource, from: { asOf?: string; knownAt: string }, to: { asOf?: string; knownAt: string }): ReplayDiff {
  const before = replayState(memory, from, { records: true });
  const after = replayState(memory, to, { records: true });
  const beforeById = new Map((before.items ?? []).map((record) => [record.id, record]));
  const afterById = new Map((after.items ?? []).map((record) => [record.id, record]));
  const added: ReplayDiffRecord[] = [];
  const removed: ReplayDiffRecord[] = [];
  const changed: ReplayDiffChange[] = [];
  for (const [id, record] of afterById) if (!beforeById.has(id)) added.push(diffRecord(memory, record));
  for (const [id, record] of beforeById) if (!afterById.has(id)) removed.push(diffRecord(memory, record));
  for (const [id, record] of beforeById) {
    const next = afterById.get(id);
    if (!next) continue;
    const fields = changedFields(record, next);
    if (fields.length) changed.push({ id, fields, before: diffRecord(memory, record), after: diffRecord(memory, next) });
  }
  const order = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  added.sort(order); removed.sort(order); changed.sort(order);
  return {
    algorithm: REPLAY_STATE_ALGORITHM,
    from: { cut: before.cut, stateSha256: before.stateSha256, records: before.records },
    to: { cut: after.cut, stateSha256: after.stateSha256, records: after.records },
    added, removed, changed,
  };
}
