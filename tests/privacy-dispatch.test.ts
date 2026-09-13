import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory, type MemoryRecord } from '../src/local/index.js';
import { MemoryRuntime } from '../src/runtime/index.js';
import { MemoryMaintenance } from '../src/maintenance/index.js';
import { MigrationService, planMigration, type MigrationPlanOptions } from '../src/migration/index.js';

const opened: LocalMemory[] = [], directories: string[] = [];
function setup(path = ':memory:', agentId = 'alice', workspaceId = 'privacy') {
  let tick = Date.parse('2026-09-13T00:00:00.000Z');
  const memory = createLocalMemory({ path, agentId, workspaceId, now: () => new Date(tick++) }); opened.push(memory);
  const runtime = new MemoryRuntime(memory);
  const capture = (text = 'PRIVATE_SENTINEL', messageId = 'one', visibility: 'private' | 'workspace' = 'private') => runtime.capture({ sessionId: 's', trust: 'observed', visibility, messages: [{ id: messageId, role: 'user', text }] }).records[0];
  return { memory, runtime, capture };
}
function change(memory: LocalMemory, record: MemoryRecord, action: string) {
  if (action === 'forget') memory.forget(record.id);
  else if (action === 'correct') memory.correct(record.id, { text: 'Replacement reference', source: { uri: 'fixture:replacement' }, reason: 'New source revision' });
  else memory.recordOutcome({ memoryId: record.id, taskId: 'failed', success: false, evidence: 'Fixture task failed', verifier: 'test' });
}
afterEach(() => { opened.splice(0).forEach(memory => memory.close()); directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });

describe('no fresh provider dispatch of interveningly invalidated source data', () => {
  it.each(['forget', 'correct', 'failure'])('rechecks a later embedding batch after %s', async action => {
    const f = setup(), first = f.capture('First reference'), second = f.capture('SECOND_PRIVATE_SENTINEL', 'two');
    const sent: string[][] = [];
    const embed = vi.fn(async (texts: readonly string[]) => {
      sent.push([...texts]);
      if (texts.includes(first.text)) change(f.memory, second, action);
      return texts.map(() => [1, 0]);
    });
    const result = await f.memory.indexEmbeddings({ embedder: { model: 'fixture', dimensions: 2, embed }, batchSize: 1 });
    expect(sent).toEqual([[first.text]]); expect(result).toMatchObject({ indexed: 1, skipped: 1 });
  });

  it('rechecks embedding at the queued dispatch boundary and after provider work', async () => {
    const f = setup(), source = f.capture(), embed = vi.fn(async (texts: readonly string[]) => texts.map(() => [1, 0]));
    const pending = f.memory.indexEmbeddings({ embedder: { model: 'fixture', dimensions: 2, embed } });
    f.memory.forget(source.id);
    expect(await pending).toEqual({ indexed: 0, skipped: 1, remaining: 0 }); expect(embed).not.toHaveBeenCalled();
    const next = f.capture('New source', 'next');
    expect(await f.memory.indexEmbeddings({ embedder: { model: 'fixture', dimensions: 2, embed: async () => { change(f.memory, next, 'failure'); return [[1, 0]]; } } })).toMatchObject({ indexed: 0, skipped: 1 });
  });

  it('preserves incremental indexing of historical evidence without starving later records', async () => {
    const f = setup(), failed = f.capture('Historical failed evidence'), current = f.capture('Current evidence', 'current'); change(f.memory, failed, 'failure');
    const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => [1, 0]));
    const options = { embedder: { model: 'fixture', dimensions: 2, embed }, limit: 1 };
    expect(await f.memory.indexEmbeddings(options)).toMatchObject({ indexed: 1, remaining: 1 });
    expect(await f.memory.indexEmbeddings(options)).toMatchObject({ indexed: 1, remaining: 0 });
    expect(embed.mock.calls.map(call => call[0])).toEqual([[failed.text], [current.text]]);
  });

  it.each(['forget', 'correct', 'failure'])('rehydrates reranker input after query embedding and %s', async action => {
    const f = setup(), source = f.capture(), rerank = vi.fn(async (_query: string, candidates: MemoryRecord[]) => candidates.map(memory => ({ id: memory.id, score: 1 })));
    const results = await f.memory.recallHybrid({ query: 'PRIVATE_SENTINEL' }, { embedder: { model: 'fixture', dimensions: 2, embed: async () => { change(f.memory, source, action); return [[1, 0]]; } }, reranker: { rerank } });
    expect(rerank).not.toHaveBeenCalled(); expect(results).toEqual([]);
  });

  it.each(['forget', 'correct', 'failure'])('rechecks queued proposer and freshness probe before %s disclosure', async action => {
    const f = setup(), source = f.capture(); f.runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    const maintenance = new MemoryMaintenance(f.runtime); maintenance.watchMemory({ memoryId: source.id, maxAgeMs: 1000 });
    const proposer = vi.fn(async () => ({ observations: [] }));
    const probe = vi.fn(async () => ({ status: 'confirmed' as const, evidence: 'Fixture confirmation', verifier: 'test' }));
    const pendingJob = f.runtime.runJobs({ proposer }); const pendingProbe = maintenance.probeDue({ probe });
    change(f.memory, source, action);
    expect(await pendingJob).toMatchObject({ failed: [{ jobId: expect.any(String), error: expect.any(String) }], modelCalls: 0, inputBytes: 0 }); expect((await pendingProbe).failed).toBe(1);
    expect(proposer).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled();
  });
});

describe('privacy erasure includes source-bearing runtime job history', () => {
  it.each(['malformed', 'schema', 'provider'])('keeps %s private error content out of reports and history', async fault => {
    const f = setup(), source = f.capture(); f.runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    const report = await f.runtime.runJobs({ maxAttempts: 1, proposer: async () => {
      if (fault === 'provider') throw new Error(source.text);
      return fault === 'malformed' ? source.text : { observations: [], [source.text]: 'unrecognized key' };
    } });
    expect(report.failed).toHaveLength(1); expect(JSON.stringify(report)).not.toContain(source.text);
    expect(JSON.stringify(f.runtime.jobs())).not.toContain(source.text);
    f.runtime.forgetSource(source.id); expect(JSON.stringify(f.memory.export())).not.toContain(source.text); expect(f.runtime.jobs()).toEqual([]);
  });

  it('purges legacy failed-then-successful histories, derived job keys and correction ancestors', async () => {
    const f = setup(), source = f.capture(), job = f.runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    const { recordId: _, ...payload } = job;
    // Exact pre-fix persisted envelope: parser/provider error could quote source bytes.
    f.memory.correct(job.recordId, { text: JSON.stringify({ ...payload, attempts: 1, error: source.text }), source: { uri: `runtime:job:${job.jobId}` }, reason: 'Legacy retry fixture' });
    await f.runtime.runJobs({ proposer: async () => ({ observations: [{ text: 'Derived private reference', sourceIds: [source.id] }] }) });
    const derivedId = f.runtime.jobs()[0].resultIds[0];
    f.runtime.enqueue({ kind: 'model', sourceIds: [derivedId], key: 'PRIVATE_MODEL_LABEL' });
    const corrected = f.memory.correct(source.id, { text: 'Updated original', source: { uri: 'fixture:correction' }, reason: 'Fixture' });
    f.runtime.forgetSource(corrected.id);
    const serialized = JSON.stringify(f.memory.export());
    expect(serialized).not.toContain(source.text); expect(serialized).not.toContain('PRIVATE_MODEL_LABEL'); expect(serialized).not.toContain('Derived private reference'); expect(f.runtime.jobs()).toEqual([]);
  });

  it('removes running claims so delayed failure cannot recreate forgotten content', async () => {
    const f = setup(), source = f.capture(); f.runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    const result = await f.runtime.runJobs({ proposer: async () => { f.runtime.forgetSource(source.id); throw new Error(source.text); } });
    expect(result.failed).toHaveLength(1); expect(JSON.stringify(result)).not.toContain(source.text);
    expect(f.runtime.jobs()).toEqual([]); expect(JSON.stringify(f.memory.export())).not.toContain(source.text);
  });

  it('erases hidden job references in the same workspace without leaking IDs or affecting other workspaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'mnemosyne-erasure-')); directories.push(root); const path = join(root, 'memory.sqlite');
    const alice = setup(path), bob = setup(path, 'bob'), other = setup(path, 'bob', 'unrelated');
    const shared = alice.capture('Shared private label', 'shared', 'workspace');
    const hidden = bob.runtime.enqueue({ kind: 'model', key: 'HIDDEN_LABEL', sourceIds: [shared.id] });
    const otherSource = other.capture(), otherJob = other.runtime.enqueue({ kind: 'observe', sourceIds: [otherSource.id] });
    const result = alice.runtime.forgetSource(shared.id);
    expect(result.deletedIds).not.toContain(hidden.recordId); expect(bob.runtime.jobs()).toEqual([]); expect(other.runtime.jobs()[0].recordId).toBe(otherJob.recordId);
  });

  it('refuses exact rollback when later source-linked jobs exist', () => {
    const f = setup(), source = f.capture(), fingerprint = f.memory.getRecordFingerprint(source.id)!;
    const job = f.runtime.enqueue({ kind: 'observe', sourceIds: [source.id] });
    expect(() => f.memory.rollbackUnchangedRecords({ records: [{ id: source.id, fingerprint }] })).toThrow('later dependent work');
    expect(f.memory.get(job.recordId)).not.toBeNull(); expect(f.memory.get(source.id)).not.toBeNull();
  });

  it('also erases jobs created from competitor imports through migration forgetting', async () => {
    const f = setup(); const service = new MigrationService({ memory: f.memory, runtime: f.runtime });
    const artifacts = [{ name: 'export.json', profile: 'mem0-array' as const, bytes: new TextEncoder().encode(JSON.stringify([{ id: 'legacy', memory: 'MIGRATED_PRIVATE_SENTINEL', user_id: 'owner' }])) }];
    const options: MigrationPlanOptions = { sourceStore: 'fixture', sourceOwner: { allowedIds: ['owner'] }, destination: { workspaceId: 'privacy', agentId: 'alice' }, acknowledgePartial: true, trust: 'observed', evaluatedAt: '2026-09-13T00:00:00Z' };
    const applied = service.applyMigration({ artifacts, options, planHash: planMigration(artifacts, options).planHash, batchId: 'batch' });
    const projection = f.memory.export().memories.find(memory => memory.metadata.migrationRole === 'projection')!;
    f.runtime.enqueue({ kind: 'model', sourceIds: [projection.id], key: 'MIGRATED_PRIVATE_SENTINEL' });
    await f.runtime.runJobs({ proposer: async () => { throw new Error('MIGRATED_PRIVATE_SENTINEL'); } });
    service.forgetMigratedSource(applied.sources[0].identity);
    expect(f.runtime.jobs()).toEqual([]); expect(JSON.stringify(f.memory.export())).not.toContain('MIGRATED_PRIVATE_SENTINEL');
  });
});
