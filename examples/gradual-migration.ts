/** Offline coexistence simulation. This callback represents an existing memory SDK. */
import assert from 'node:assert/strict';
import { createLocalMemory } from '../dist/local/index.js';
import { MemoryRuntime } from '../dist/runtime/index.js';
import { MemoryBridge, type LegacyMemoryMatch } from '../dist/bridge/index.js';
import { MemoryAgent } from '../dist/agent/index.js';

const memory = createLocalMemory({ path: ':memory:', workspaceId: 'gradual-example', agentId: 'assistant' });
let oldMemories: LegacyMemoryMatch[] = [
  { id: 'region', revision: '1', text: 'Atlas deployment region is Dubai.' },
  { id: 'reviewers', revision: '1', text: 'Atlas deployment needs two reviewers.' },
];
const legacyCalls: string[] = [];
const runtime = new MemoryRuntime(memory);
const bridge = new MemoryBridge(runtime, {
  adapter: {
    id: 'offline-fixture-v1', family: 'mem0', sourceStore: 'existing-agent-store', sourceOwner: 'example-user',
    search: async ({ query, signal }) => {
      assert.equal(signal.aborted, false); legacyCalls.push(query);
      // Use your existing memory client's search here, mapping its stable ID,
      // revision and original text. The bridge never writes to that client.
      return structuredClone(oldMemories);
    },
  },
  trust: 'observed', // Explicit host assertion about these supplied fixtures.
  promotion: { assistAfter: 2, preferAfter: 4 },
});
const agent = new MemoryAgent(runtime, { contextProvider: bridge.contextProvider });
try {
  const query = { query: 'Atlas deployment', maxTokens: 8192 };
  const phases: string[] = [];
  const first = await bridge.recall(query); phases.push(first.status.phase);
  assert.equal(first.coverage.localMatches, 0); assert.equal(first.importedRevisions, 2);
  for (let count = 0; count < 4; count++) phases.push((await bridge.recall(query)).status.phase);
  const warm = await bridge.recall(query);
  assert.equal(warm.status.phase, 'prefer-mnemosyne'); assert.ok(warm.items.every(item => item.route === 'mnemosyne'));
  const regionId = warm.items.find(item => memory.get(item.memoryId)!.text.includes('Dubai'))!.memoryId;
  const derived = memory.store({ text: 'Use the Dubai region for the deployment.', trust: 'observed', dependencies: [regionId], source: { uri: 'fixture:derived-advice' } });

  oldMemories[0] = { id: 'region', revision: '2', text: 'Atlas deployment region is Paris.' };
  const corrected = await bridge.recall(query);
  assert.ok(corrected.context.text.includes('Paris')); assert.ok(!corrected.context.text.includes('Dubai'));
  assert.equal(memory.isEligible(derived.id), false); assert.throws(() => bridge.validate(warm.context));

  // An old-system semantic result the lexical local candidate search cannot
  // find must still survive as an explicitly reconciled legacy fallback.
  oldMemories.push({ id: 'contact', revision: '1', text: 'Emergency contact is Noor.' });
  const missing = await bridge.recall(query);
  const contact = missing.items.find(item => memory.get(item.memoryId)!.text.includes('Noor'))!;
  assert.equal(contact.route, 'legacy'); assert.ok(missing.context.text.includes('Noor'));
  assert.equal(missing.context.memoryIds.length, 3); assert.equal(missing.status.totalLegacyCoverage, 'unknown');

  bridge.setMode('legacy'); assert.throws(() => bridge.validate(missing.context));
  const rolledBack = await bridge.recall(query);
  assert.ok(rolledBack.items.every(item => item.route === 'legacy')); assert.equal(oldMemories.length, 3);
  const native = agent.afterTurn({ sessionId: 'new-host-session', trust: 'observed', messages: [{ id: 'canary', role: 'user', text: 'Atlas deployment also needs a canary stage.' }] }).records[0];
  const before = await agent.beforeTurn(query); assert.ok(before.context.text.includes('Paris'));
  assert.ok(before.context.memoryIds.includes(native.id)); assert.ok(before.context.text.includes('canary stage'));
  const forgotten = bridge.forget('contact'); assert.ok(forgotten.deletedCount > 0);
  const afterForget = await bridge.recall(query);
  assert.ok(!afterForget.context.text.includes('Noor')); assert.equal(oldMemories.length, 3);
  assert.equal(afterForget.excluded[0].reason, 'forgotten');
  console.log(JSON.stringify({ synthetic: true, phases, warmLocalRoutes: warm.items.length, correctedSourceInvalidatesAdvice: true,
    unseenLegacyMatchRetained: true, immediateRoutingRollback: true, agentProviderIntegrated: true, nativeCapturesRemainUsable: true, sharedForgetBlocksReplay: true,
    legacyCalls: legacyCalls.length, legacyWrites: 0, oldSystemMemoriesRetained: oldMemories.length, totalLegacyCoverage: 'unknown', externalModelCalls: 0 }, null, 2));
} finally { await agent.close(); memory.close(); }
