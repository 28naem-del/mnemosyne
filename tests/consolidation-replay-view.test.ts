import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { buildReplaySet, consolidationReceipts, createConsolidationSigner, gateConsolidation, proposeConsolidation } from '../src/consolidation/index.js';

/**
 * Regressions for Sol audit findings S01 and S02. The consolidation gate must
 * not issue a normal keep when its scratch replay cannot see what live recall
 * saw (S01), or when the replay set changed between scoring and apply through
 * a verifier outcome written by another connection (S02). Synthetic fixtures.
 */

const opened: LocalMemory[] = [];
const dirs: string[] = [];
afterEach(() => {
  opened.splice(0).forEach((db) => db.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mnemosyne-replay-view-'));
  dirs.push(dir);
  return join(dir, 'memory.sqlite');
}

function open(path: string, agentId: string, ledger = true): LocalMemory {
  const db = createLocalMemory({ path, workspaceId: 'w', agentId, retrieval: 'lexical', ...(ledger ? { ledger: { queries: 'text' as const } } : {}) });
  opened.push(db);
  return db;
}

const regions = (db: LocalMemory): void => {
  for (const text of ['Orion service region is west.', 'Orion service region is west coast.']) {
    db.store({ text, kind: 'fact', trust: 'observed', source: { uri: 'test:regions' } });
  }
};

describe('S01: the replay sees the same records live recall saw', () => {
  it('does not keep a pass scored on tasks whose gold is a record shared by another agent', () => {
    const path = file();
    const a = open(path, 'a');
    const b = open(path, 'b', false);
    const shared = b.store({ text: 'Zephyr service port 8443.', kind: 'fact', trust: 'observed', visibility: 'workspace', source: { uri: 'test:shared' } });
    regions(a);
    for (let i = 0; i < 2; i++) {
      const found = a.recall({ query: 'Zephyr service port', limit: 1 });
      expect(found[0]?.memory.id).toBe(shared.id);
      a.recordRetrievalOutcome({ taskId: `shared-${i}`, success: true, verifier: 'test (synthetic)', evidence: `e${i}` });
    }
    expect(a.export().memories.some((record) => record.id === shared.id)).toBe(false);
    const signer = createConsolidationSigner({ seed: new Uint8Array(32).fill(8) });
    const diff = proposeConsolidation(a, { signer });
    expect(diff).not.toBeNull();
    const result = gateConsolidation(a, diff!, { signer });
    // Live recall covered the gold twice; a scratch copy without the shared
    // record would score it 0 before and after and call that a keep.
    expect(result.verdict).toBe('no_evidence');
    expect(result.created).toEqual([]);
    expect(result.receipt.scores?.unreplayable).toBe(2);
    expect(result.receipt.reason).toMatch(/outside this agent's own records/);
  });

  it('does not replay a task whose recorded results included a shared record, even when its gold is the agent\'s own', () => {
    const path = file();
    const a = open(path, 'a');
    const b = open(path, 'b', false);
    const shared = b.store({ text: 'Zephyr service port 8443.', kind: 'fact', trust: 'observed', visibility: 'workspace', source: { uri: 'test:shared' } });
    regions(a);
    const own = a.store({ text: 'Zephyr service port is set in the gateway file.', kind: 'fact', trust: 'observed', source: { uri: 'test:own' } });
    for (let i = 0; i < 2; i++) {
      expect(a.recall({ query: 'Zephyr service port', limit: 2 }).map((result) => result.memory.id).sort()).toEqual([shared.id, own.id].sort());
      a.recordRetrievalOutcome({ taskId: `mixed-${i}`, success: true, verifier: 'test (synthetic)', evidence: `e${i}` });
      a.recordOutcome({ memoryId: own.id, taskId: `mixed-${i}`, success: true, verifier: 'test (synthetic)', evidence: `used-${i}` });
    }
    expect(buildReplaySet(a).tasks.map((task) => task.gold)).toEqual([[own.id], [own.id]]);
    const signer = createConsolidationSigner({ seed: new Uint8Array(32).fill(8) });
    const result = gateConsolidation(a, proposeConsolidation(a, { signer })!, { signer });
    expect(result.verdict).toBe('no_evidence');
    expect(result.receipt.scores?.unreplayable).toBe(2);
  });

  it('still scores and keeps tasks whose records are all the agent\'s own', () => {
    const path = file();
    const a = open(path, 'a');
    const b = open(path, 'b', false);
    const shared = b.store({ text: 'Zephyr listens on port 8443.', kind: 'fact', trust: 'observed', visibility: 'workspace', source: { uri: 'test:shared' } });
    regions(a);
    for (let i = 0; i < 2; i++) {
      expect(a.recall({ query: 'Orion service region', limit: 3 }).map((result) => result.memory.id)).not.toContain(shared.id);
      a.recordRetrievalOutcome({ taskId: `own-${i}`, success: true, verifier: 'test (synthetic)', evidence: `e${i}` });
    }
    const signer = createConsolidationSigner({ seed: new Uint8Array(32).fill(8) });
    const result = gateConsolidation(a, proposeConsolidation(a, { signer })!, { signer });
    expect(result.verdict).toBe('kept');
    expect(result.receipt.scores?.tasks).toBe(2);
    expect(result.receipt.scores?.unreplayable).toBe(0);
  });
});

describe('S02: a verifier outcome written while a pass is scored voids the scores', () => {
  /** Two judged tasks and one pending retrieval; `late` runs on a second connection right before the apply transaction. */
  function race(late: ((other: LocalMemory, pending: string) => void) | null) {
    const path = file();
    const a = open(path, 'a');
    const other = open(path, 'a');
    regions(a);
    for (let i = 0; i < 2; i++) {
      a.recall({ query: 'Orion service region', limit: 3 });
      a.recordRetrievalOutcome({ taskId: `t${i}`, success: true, verifier: 'test (synthetic)', evidence: `e${i}` });
    }
    a.recall({ query: 'Orion service region', limit: 3 });
    const pending = a.lastRetrievalId!;
    const signer = createConsolidationSigner({ seed: new Uint8Array(32).fill(13) });
    const diff = proposeConsolidation(a, { signer })!;
    expect(diff).not.toBeNull();
    const before = a.export().memories.length;
    const atomic = a.atomic.bind(a);
    let injected = false;
    a.atomic = <T>(work: () => T): T => {
      if (!injected) { injected = true; late?.(other, pending); }
      return atomic(work);
    };
    const result = gateConsolidation(a, diff, { signer });
    expect(injected).toBe(true);
    return { a, result, before };
  }

  it('returns conflict when another connection records a successful verdict before apply', () => {
    const { a, result, before } = race((other, pending) => {
      other.recordRetrievalOutcome({ retrievalId: pending, taskId: 'late-success', success: true, verifier: 'test (synthetic)', evidence: 'late' });
    });
    expect(buildReplaySet(a).tasks).toHaveLength(3);
    expect(result.receipt.scores?.tasks).toBe(2);
    expect(result.verdict).toBe('conflict');
    expect(result.receipt.reason).toMatch(/replay set changed/);
    expect(result.created).toEqual([]);
    expect(a.export().memories).toHaveLength(before);
  });

  it('returns conflict when another connection records a failed verdict before apply', () => {
    const { a, result, before } = race((other, pending) => {
      other.recordRetrievalOutcome({ retrievalId: pending, taskId: 'late-failure', success: false, verifier: 'test (synthetic)', evidence: 'late' });
    });
    expect(buildReplaySet(a).unreplayable).toBe(1);
    expect(result.verdict).toBe('conflict');
    expect(result.created).toEqual([]);
    expect(a.export().memories).toHaveLength(before);
  });

  it('keeps the pass when nothing is written between scoring and apply', () => {
    const { a, result, before } = race(null);
    expect(result.verdict).toBe('kept');
    expect(result.created.length).toBeGreaterThan(0);
    expect(a.export().memories.length).toBeGreaterThan(before);
    expect(consolidationReceipts(a)).toHaveLength(1);
  });
});
