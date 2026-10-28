import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory, type LocalMemory, type MemoryRecord } from '../src/local/index.js';
import { MemoryRuntime } from '../src/runtime/index.js';
import { createPremiseGuard, inferDependencies } from '../src/dependencies/index.js';

/**
 * A failure attributed to the dependent itself, through a trace outcome on a
 * task whose used set holds it, is not support: the premise guard does not
 * count it, and inference does not propose the pair. The kernel also withholds
 * a dependent with a failed traced outcome, so inference rejects its pairs as
 * inactive and no executor path hands it out. The synthetic suite records
 * failures only through a verifier on the retrieval, so this path is pinned
 * here (synthetic records).
 */

const opened: LocalMemory[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); });

function world() {
  let tick = Date.parse('2026-10-28T00:00:00.000Z');
  const now = () => new Date(tick += 1000);
  const db = createLocalMemory({ path: ':memory:', agentId: 'alice', workspaceId: 'project', now, retrieval: 'lexical' }); opened.push(db);
  const runtime = new MemoryRuntime(db, { now });
  const store = (text: string, kind: 'fact' | 'procedure') => db.store({ text, kind, trust: 'observed', source: { uri: `test:${text.slice(0, 16)}` } });
  let serial = 0;
  const task = (used: MemoryRecord[], success: boolean) => {
    const taskId = `task-${++serial}`;
    db.recall({ query: used.map(record => record.text).join(' '), limit: 10 });
    runtime.recordTrace({ taskId, query: 'synthetic', retrievedIds: used.map(record => record.id), usedIds: used.map(record => record.id), outcome: { success, evidence: `Synthetic evidence for ${taskId}.`, verifier: 'harness' } });
    return taskId;
  };
  return { db, store, task };
}

describe('a failed trace outcome on the dependent itself', () => {
  it('is never counted as support by inference or by the premise guard', () => {
    const w = world();
    const other = w.store('Rotate the service credentials with the vault tool.', 'procedure');
    for (let index = 0; index < 6; index++) w.task([other], true);
    // Two successes, then one traced failure of the same dependent with the same premise.
    const backup = w.store('Back up the ledger database to the archive bucket nightly.', 'procedure');
    const bucket = w.store('The archive bucket is named ledger-archive-7.', 'fact');
    const okA = w.task([backup, bucket], true), okB = w.task([backup, bucket], true);
    const failedBackup = w.task([backup, bucket], false);
    // One success and one traced failure: the failure must not lift support to the two-task floor.
    const deploy = w.store('Deploy the web service with the blue green script.', 'procedure');
    const region = w.store('Production runs in the eu-west-1 region.', 'fact');
    w.task([deploy, region], true);
    const failedDeploy = w.task([deploy, region], false);
    // Only a traced failure: no support at all.
    const migrate = w.store('Migrate the orders schema with the online tool.', 'procedure');
    const flag = w.store('The online schema tool needs the copy flag.', 'fact');
    w.task([migrate, flag], false);

    const result = inferDependencies(w.db);
    expect(result.proposals).toEqual([]);
    // Two pairs had a success; the failure-only pair is not even a candidate.
    expect(result.evidence.tasks).toMatchObject({ successful: 9, failed: 3, traced: 12 });
    expect(result.evidence.pairs).toMatchObject({ considered: 2, proposed: 0 });
    expect(result.evidence.pairs.rejected).toMatchObject({ inactive: 2, support: 0 });
    for (const dependent of [backup, deploy, migrate]) expect(w.db.isEligible(dependent.id)).toBe(false);
    expect(w.db.isEligible(other.id)).toBe(true);

    const guard = createPremiseGuard(w.db);
    w.db.correct(bucket.id, { text: 'The archive bucket is named ledger-archive-8.', source: { uri: 'test:bucket-v2' }, reason: 'Bucket renamed.' });
    w.db.correct(region.id, { text: 'Production runs in the us-east-1 region.', source: { uri: 'test:region-v2' }, reason: 'Region moved.' });
    w.db.correct(flag.id, { text: 'The online schema tool no longer needs the copy flag.', source: { uri: 'test:flag-v2' }, reason: 'Tool changed.' });
    // The guard counts the successes only: 2 of 2 runs, not 3 of 3; 1 of 1, not 2 of 2.
    expect(guard.holds(backup.id)).toEqual([{ premiseId: bucket.id, reason: 'premise-changed', support: 2, runs: 2, reliance: 1 }]);
    expect(guard.holds(deploy.id)).toEqual([{ premiseId: region.id, reason: 'premise-changed', support: 1, runs: 1, reliance: 1 }]);
    // A pair co-used only in a failed traced task is never watched.
    expect(guard.allows(migrate.id)).toBe(true);
    expect([okA, okB, failedBackup, failedDeploy]).toEqual(['task-7', 'task-8', 'task-9', 'task-11']);
  });
});
