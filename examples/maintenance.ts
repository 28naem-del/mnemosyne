/** Scripted freshness checks with a simulated clock; no live source or model is called. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory } from '../dist/local/index.js';
import { MemoryRuntime } from '../dist/runtime/index.js';
import { MemoryMaintenance } from '../dist/maintenance/index.js';

let clock = Date.parse('2026-09-13T00:00:00.000Z');
const now = () => new Date(clock);
const scope = { workspaceId: 'maintenance-example', agentId: 'assistant' };
const directory = mkdtempSync(join(tmpdir(), 'mnemosyne-maintenance-example-'));
const path = join(directory, 'memory.sqlite');
let memory: LocalMemory | undefined;
try {
  memory = createLocalMemory({ path, ...scope, now });
  let maintenance = new MemoryMaintenance(new MemoryRuntime(memory, { now }), { now });
  const source = memory.store({ text: 'Synthetic Atlas release window is Thursday.', trust: 'observed', source: { uri: 'example:release-policy', revision: 'r1' } });
  const advice = memory.store({ text: 'Synthetic Atlas release plan uses the Thursday window.', trust: 'observed', source: { uri: 'example:release-plan' }, dependencies: [source.id] });
  assert.equal(maintenance.watchMemory({ memoryId: source.id, maxAgeMs: 1000 }).status, 'needs-check');
  assert.ok(maintenance.recall({ query: 'Atlas release' }).excluded.some(item => item.memoryId === advice.id));

  const confirmed = maintenance.recordCheck({ memoryId: source.id, expectedStateHash: maintenance.assess(source.id).stateHash,
    observation: { status: 'confirmed', evidence: 'Scripted source r1 still says Thursday.', verifier: 'synthetic-fixture', sourceRevision: 'r1' } });
  assert.equal(confirmed.status, 'fresh');
  assert.ok(maintenance.recall({ query: 'Atlas release' }).items.some(item => item.memory.id === advice.id));

  // The host binds the intended action AND arguments and declares its dependency roots.
  // This ticket checks memory state; it does not authorize or lock an external action.
  const actionKey = JSON.stringify({ tool: 'preview_release', arguments: { project: 'synthetic-atlas', day: 'Thursday' } });
  const ticket = maintenance.createReadSet({ memoryIds: [advice.id], actionKey, dependenciesComplete: true });
  assert.deepEqual(maintenance.validateReadSet(ticket, actionKey), { valid: true });
  assert.deepEqual(maintenance.validateReadSet(ticket, `${actionKey}:different-arguments`), { valid: false, reason: 'invalid-ticket' });

  memory.close();
  memory = createLocalMemory({ path, ...scope, now });
  maintenance = new MemoryMaintenance(new MemoryRuntime(memory, { now }), { now });
  assert.equal(maintenance.assess(source.id).status, 'fresh');
  // Freshness evidence persists; the per-instance signing key deliberately does not.
  assert.deepEqual(maintenance.validateReadSet(ticket, actionKey), { valid: false, reason: 'invalid-ticket' });
  const reopenedTicket = maintenance.createReadSet({ memoryIds: [advice.id], actionKey, dependenciesComplete: true });

  clock += 1000;
  assert.equal(maintenance.assess(source.id).status, 'stale');
  const staleRecall = maintenance.recall({ query: 'Atlas release' });
  assert.ok(!staleRecall.items.some(item => item.memory.id === advice.id));
  assert.ok(staleRecall.excluded.some(item => item.memoryId === advice.id && item.statuses.includes('stale')));
  assert.deepEqual(maintenance.validateReadSet(reopenedTicket, actionKey), { valid: false, reason: 'expired' });
  assert.equal(memory.get(source.id)?.text, source.text);

  // Age triggers a need to check, not an automatic claim that the source changed.
  // Only this explicit call invokes the host-supplied, bounded probe.
  let scriptedProbeCalls = 0;
  const probeReport = await maintenance.probeDue({ maxChecks: 1, timeoutMs: 1000, probe: async (request, { signal }) => {
    signal.throwIfAborted();
    assert.equal(request.memory.id, source.id);
    scriptedProbeCalls++;
    return { status: 'confirmed', evidence: 'Scripted recheck still returns source r1.', verifier: 'synthetic-fixture', sourceRevision: 'r1' };
  } });
  assert.equal(scriptedProbeCalls, 1);
  assert.equal(probeReport.confirmed, 1);
  assert.equal(probeReport.failed, 0);
  assert.equal(maintenance.assess(source.id).status, 'fresh');
  const currentTicket = maintenance.createReadSet({ memoryIds: [advice.id], actionKey, dependenciesComplete: true });
  assert.deepEqual(maintenance.validateReadSet(currentTicket, actionKey), { valid: true });

  clock += 1;
  const changed = maintenance.recordCheck({ memoryId: source.id, expectedStateHash: maintenance.assess(source.id).stateHash,
    observation: { status: 'changed', evidence: 'Scripted source now reports Friday in r2.', verifier: 'synthetic-fixture', sourceRevision: 'r2' } });
  assert.equal(changed.status, 'source-changed');
  assert.deepEqual(maintenance.validateReadSet(currentTicket, actionKey), { valid: false, reason: 'dependencies-changed' });
  assert.ok(maintenance.recall({ query: 'Atlas release' }).excluded.some(item => item.memoryId === advice.id && item.statuses.includes('source-changed')));
  // A source check records evidence; it neither rewrites the assertion nor promotes trust.
  assert.equal(memory.get(source.id)?.text, source.text);
  assert.equal(memory.get(source.id)?.trust, 'observed');

  console.log(JSON.stringify({ kind: 'synthetic source maintenance', freshnessAfterReopen: 'fresh',
    priorInstanceTicketRejected: true, staleDependencyExcluded: true, expiredTicketRejected: true,
    explicitProbeCalls: scriptedProbeCalls, afterSourceCheck: changed.status, changedTicketRejected: true,
    sourceTextUnchanged: true, trust: memory.get(source.id)?.trust, externalModelCalls: 0 }, null, 2));
} finally {
  try { memory?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
}
