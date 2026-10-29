import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { consolidate, createConsolidationSigner, rollbackConsolidation, verifyConsolidationChain } from '../src/consolidation/index.js';

/**
 * Sol S06: prevDigest links catch a receipt deleted from the middle of the
 * chain, but deleting the last receipt, or every receipt, leaves a shorter chain
 * that still verifies, even with the key pinned. An externally retained
 * `expectedHead` checkpoint is what detects that tail truncation. Fixtures are
 * synthetic.
 */

const roots: string[] = [];
const opened: LocalMemory[] = [];
afterEach(() => {
  opened.splice(0).forEach((db) => db.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const signer = createConsolidationSigner({ seed: new Uint8Array(32).fill(11) });
const pinnedKeyIds = [signer.keyId];

function open(path: string): LocalMemory {
  let tick = Date.UTC(2026, 0, 1);
  const db = createLocalMemory({ path, workspaceId: 'w', agentId: 'agent', retrieval: 'lexical', ledger: { queries: 'text' }, now: () => new Date(tick += 1000) });
  opened.push(db);
  return db;
}

/** A kept merge and its rollback: two chained receipts. Returns the database path. */
function history(): string {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-chain-head-'));
  roots.push(root);
  const path = join(root, 'memory.sqlite');
  const db = open(path);
  const a = db.store({ text: 'Deploys run from the release branch after the smoke suite passes.', kind: 'procedure', trust: 'observed', source: { uri: 'note://a' } });
  const b = db.store({ text: 'Deploys run from the release branch once the smoke suite passes.', kind: 'procedure', trust: 'observed', source: { uri: 'note://b' } });
  for (const [taskId, query] of [['t1', 'deploys after once smoke suite'], ['t2', 'release branch after once passes']]) {
    db.recall({ query, limit: 1 });
    db.recordRetrievalOutcome({ taskId, success: true, verifier: 'test-ci (synthetic)', evidence: taskId });
    for (const id of [a.id, b.id]) db.recordOutcome({ memoryId: id, taskId, success: true, verifier: 'test-ci (synthetic)', evidence: `${taskId}:${id}` });
  }
  const kept = consolidate(db, { signer })!;
  expect(kept.verdict).toBe('kept');
  rollbackConsolidation(db, kept.receipt.passId, { signer });
  opened.splice(opened.indexOf(db), 1);
  db.close();
  return path;
}

/** Deletes the last `count` consolidation receipts straight from the database file. */
function truncate(path: string, count: number): void {
  const raw = new DatabaseSync(path);
  try {
    const rows = raw.prepare("SELECT sequence FROM local_ledger WHERE event='consolidation' ORDER BY sequence DESC LIMIT ?").all(count) as { sequence: number }[];
    for (const row of rows) raw.prepare('DELETE FROM local_ledger WHERE sequence=?').run(row.sequence);
  } finally { raw.close(); }
}

describe('consolidation chain completeness', () => {
  it('passes the full chain against its retained head', () => {
    const path = history();
    const full = verifyConsolidationChain(open(path), { pinnedKeyIds });
    expect(full.ok).toBe(true);
    expect(full.receipts).toBe(2);
    expect(verifyConsolidationChain(open(path), { pinnedKeyIds, expectedHead: full.head! })).toMatchObject({ ok: true, receipts: 2, errors: [] });
  });

  it('fails when the last receipt is deleted, which links alone cannot see', () => {
    const path = history();
    const head = verifyConsolidationChain(open(path), { pinnedKeyIds }).head!;
    truncate(path, 1);
    // The limitation the checkpoint exists for: a valid prefix verifies without one.
    expect(verifyConsolidationChain(open(path), { pinnedKeyIds })).toMatchObject({ ok: true, receipts: 1 });
    const report = verifyConsolidationChain(open(path), { pinnedKeyIds, expectedHead: head });
    expect(report.ok).toBe(false);
    expect(report.errors.map((error) => error.error)).toEqual([expect.stringMatching(/expected head is not in the chain/)]);
  });

  it('fails when every receipt is deleted', () => {
    const path = history();
    const head = verifyConsolidationChain(open(path), { pinnedKeyIds }).head!;
    truncate(path, 2);
    expect(verifyConsolidationChain(open(path), { pinnedKeyIds })).toMatchObject({ ok: true, receipts: 0 });
    const report = verifyConsolidationChain(open(path), { pinnedKeyIds, expectedHead: head });
    expect(report).toMatchObject({ ok: false, receipts: 0, head: null });
  });

  it('accepts receipts appended after the checkpoint, and rejects a malformed checkpoint', () => {
    const path = history();
    const db = open(path);
    const first = verifyConsolidationChain(db, { pinnedKeyIds });
    const firstReceiptHead = db.ledger({ events: ['consolidation'], limit: 10 }).entries
      .map((entry) => (entry.consolidation as { digest: string }).digest)[0];
    expect(firstReceiptHead).not.toBe(first.head);
    // A checkpoint taken after the first receipt is still satisfied once the chain has grown.
    expect(verifyConsolidationChain(db, { pinnedKeyIds, expectedHead: firstReceiptHead }).ok).toBe(true);
    expect(() => verifyConsolidationChain(db, { expectedHead: 'not-a-digest' })).toThrow(/expectedHead/);
  });
});
