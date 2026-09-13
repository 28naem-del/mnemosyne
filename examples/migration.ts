/** Synthetic offline migration. Run after npm run build; no existing user data is opened. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory } from '../dist/local/index.js';
import { MemoryRuntime } from '../dist/runtime/index.js';
import { MigrationService, MigrationServiceError, planMigration, type MigrationArtifact, type MigrationPlanOptions } from '../dist/migration/index.js';

const now = () => new Date('2026-09-13T00:00:00.000Z');
const destination = { workspaceId: 'migration-example', agentId: 'assistant' };
const options: MigrationPlanOptions = {
  sourceStore: 'synthetic-mem0-export', sourceOwner: { allowedIds: ['example-owner'] },
  destination, evaluatedAt: now().toISOString(),
  // Trust defaults to untrusted. Importing a claim does not verify it.
};
const raw = '{ "id":"preference-1", "memory":"Synthetic preference: café visits on Thursday.", "user_id":"example-owner", "metadata":{"label":"synthetic-only"} }';
const artifacts: MigrationArtifact[] = [{
  name: 'synthetic-export.json', profile: 'mem0-page',
  bytes: new TextEncoder().encode(`\ufeff {"count":1,"next":null,"previous":null,"results":[${raw}]}\r\n`),
  // The caller knows this fixture has one page; this does not discover remote pages.
  page: { index: 0, totalPages: 1 },
}];
const plan = planMigration(artifacts, options);
assert.equal(plan.report.destinationInspected, false);
assert.equal(plan.report.completeness.status, 'complete');
assert.equal(plan.report.readyToApply, true);
const request = { artifacts, options, planHash: plan.planHash, batchId: 'mem0-example' };
const hasCode = (code: string) => (error: unknown) => error instanceof MigrationServiceError && error.code === code;

const directory = mkdtempSync(join(tmpdir(), 'mnemosyne-migration-example-'));
const path = join(directory, 'memory.sqlite');
let memory: LocalMemory | undefined;
try {
  memory = createLocalMemory({ path, ...destination, now });
  let service = new MigrationService({ memory, runtime: new MemoryRuntime(memory, { now }) });
  const beforePreview = memory.export();
  assert.equal(service.inspectMigrationPlan({ artifacts, options, planHash: plan.planHash }).newSources, 1);
  assert.deepEqual(memory.export(), beforePreview);

  const applied = service.applyMigration(request);
  assert.equal(applied.counts.create, 1);
  assert.equal(applied.replay, false);
  const identity = applied.sources[0].identity;
  const original = service.inspectMigrationSource(applied.batchId, identity);
  // Exact JSON record bytes are retained; export framing and wrapper fields are not.
  assert.deepEqual(Buffer.from(original.text), Buffer.from(raw));
  assert.equal(original.totalBytes, Buffer.byteLength(raw));
  assert.ok(memory.export().memories.every(record => record.visibility === 'private' && record.trust === 'untrusted'));
  assert.deepEqual(memory.compile({ query: 'café Thursday', maxTokens: 500 }).items, []);

  const snapshot = memory.export();
  memory.close();
  memory = createLocalMemory({ path, ...destination, now });
  service = new MigrationService({ memory, runtime: new MemoryRuntime(memory, { now }) });
  const replay = service.applyMigration(request);
  assert.equal(replay.replay, true);
  assert.deepEqual(memory.export(), snapshot);

  // A separate Markdown import demonstrates undo when nothing depends on it yet.
  const markdown: MigrationArtifact[] = [{ name: 'draft.md', logicalPath: 'notes/draft.md', profile: 'markdown', bytes: new TextEncoder().encode('\ufeff# Synthetic draft\r\nDisposable import.\r\n') }];
  const markdownOptions: MigrationPlanOptions = {
    ...options, sourceStore: 'synthetic-notes',
    // Markdown has no owner field; this is the host's explicit scope attestation.
    sourceOwner: { allowedIds: ['example-owner'], assumeMissing: 'example-owner' },
  };
  const markdownPlan = planMigration(markdown, markdownOptions);
  assert.equal(markdownPlan.report.readyToApply, true);
  const markdownRequest = { artifacts: markdown, options: markdownOptions, planHash: markdownPlan.planHash, batchId: 'markdown-example' };
  const importedDraft = service.applyMigration(markdownRequest);
  assert.equal(service.inspectMigrationSource(importedDraft.batchId, importedDraft.sources[0].identity).text, '\ufeff# Synthetic draft\r\nDisposable import.\r\n');
  const rolledBack = service.rollbackMigration(importedDraft.batchId, importedDraft.manifestRevision);
  assert.equal(rolledBack.state, 'rolled-back');
  assert.equal(rolledBack.deletedCount, importedDraft.createdCount);
  assert.throws(() => service.applyMigration(markdownRequest), hasCode('E_CONFLICT'));

  const projection = memory.list({ includeUntrusted: true, metadata: { migrationRole: 'projection' } }).items.find(record => record.metadata.migrationIdentity === identity);
  assert.ok(projection);
  const later = memory.store({ text: 'Synthetic itinerary depends on the imported preference.', source: { uri: 'example:later-work' }, dependencies: [projection.id] });
  const beforeUndo = memory.export();
  assert.throws(() => service.rollbackMigration(applied.batchId, applied.manifestRevision), hasCode('E_CONFLICT'));
  assert.deepEqual(memory.export(), beforeUndo);
  assert.ok(memory.get(later.id));

  // Forget is deliberately stronger than undo: it removes dependent fixture work.
  const forgotten = service.forgetMigratedSource(identity);
  assert.equal(forgotten.forgotten, true);
  assert.equal(memory.get(projection.id), null);
  assert.equal(memory.get(later.id), null);
  assert.equal(service.inspectMigration(applied.batchId).sources[0].state, 'forgotten');
  assert.throws(() => service.inspectMigrationSource(applied.batchId, identity), hasCode('E_FORGOTTEN'));
  assert.ok(!JSON.stringify(memory.export()).includes('Synthetic preference:'));

  // A content-free identity tombstone survives restart and renamed-export retries.
  memory.close();
  memory = createLocalMemory({ path, ...destination, now });
  service = new MigrationService({ memory, runtime: new MemoryRuntime(memory, { now }) });
  const renamed = artifacts.map(artifact => ({ ...artifact, name: 'renamed-export.json' }));
  const retryPlan = planMigration(renamed, options);
  assert.equal(retryPlan.records[0].identity, identity);
  assert.throws(() => service.applyMigration({ artifacts: renamed, options, planHash: retryPlan.planHash, batchId: 'renamed-retry' }), hasCode('E_FORGOTTEN'));

  console.log(JSON.stringify({ kind: 'synthetic offline migration', privateImport: true, trust: original.trust,
    exactSourceBytes: original.totalBytes, replayAfterReopen: replay.replay, unchangedImportUndo: rolledBack.state,
    laterWorkProtected: true, sourceAndDependentsForgotten: true, renamedRetryBlockedAfterReopen: true,
    externalModelCalls: 0 }, null, 2));
} finally {
  try { memory?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
}
