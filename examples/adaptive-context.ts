/** Synthetic adaptive context demonstration. No model provider or network is used. */
import assert from 'node:assert/strict';
import { createLocalMemory } from '../dist/local/index.js';
import { MemoryRuntime } from '../dist/runtime/index.js';
import { MemoryMaintenance } from '../dist/maintenance/index.js';
import { AdaptiveContext, type ContextProposer } from '../dist/context/index.js';

const memory = createLocalMemory({ path: ':memory:', workspaceId: 'adaptive-example', agentId: 'assistant' });
try {
  const runtime = new MemoryRuntime(memory);
  const maintenance = new MemoryMaintenance(runtime);
  const context = new AdaptiveContext(runtime, { maintenance });
  const sources = runtime.capture({ sessionId: 'synthetic-release', trust: 'observed', messages: Array.from({ length: 16 }, (_, index) => ({ id: String(index), role: 'user' as const,
    text: `Synthetic Atlas event ${index}: validate preview before publishing. ${'Fixture narrative with no additional decision. '.repeat(30)}` })) }).records;
  // This deterministic fixture callback tests orchestration, not model quality.
  const proposer: ContextProposer = async request => ({
    text: request.tier === 'detail' ? 'Atlas batch: validate preview before publishing; evidence retained.' : 'Atlas: validate preview before publishing.',
    sourceIds: request.sources.map(source => source.id),
  });
  const job = { key: 'atlas-release', sourceIds: sources.map(source => source.id), proposerId: 'scripted-example-v1', proposer, maxCalls: 4 };
  const initial = await context.compact(job);
  const replay = await context.compact(job);
  assert.equal(initial.modelCalls, 3); assert.equal(replay.modelCalls, 0);
  const packet = await context.build({ query: 'Atlas release', taskId: 'preview', maxTokens: 2000, modelId: 'example-no-model' });
  assert.ok(packet.tokens <= packet.tokenBudget); assert.ok(packet.accounting.selectedTextBytes < packet.accounting.fullSourceBytes);
  assert.ok(context.validate(packet).valid);
  const original = context.expand(packet.handles.find(handle => handle.id === sources[0].id)!);
  assert.equal(original.text, sources[0].text);
  const replayPacket = await context.build({ query: 'Atlas release', taskId: 'preview', maxTokens: 2000, modelId: 'example-no-model' });
  assert.equal(replayPacket.cache.status, 'hit');
  memory.forget(sources[0].id);
  assert.equal(context.validate(packet).valid, false);
  assert.throws(() => context.expand(packet.handles.find(handle => handle.id === sources[0].id)!), /unavailable/);
  const after = await context.build({ query: 'Atlas release', maxTokens: 2000 });
  assert.ok(!after.memoryIds.includes(initial.overview!.id));
  console.log(JSON.stringify({ synthetic: true, projectionFixtureCalls: initial.modelCalls, replayProjectionCalls: replay.modelCalls,
    promptTokens: packet.tokens, tokenCounter: packet.accounting.counter, originalSourceBytes: packet.accounting.fullSourceBytes,
    selectedTextBytes: packet.accounting.selectedTextBytes, exactOriginalExpansion: true, selectionCache: replayPacket.cache.status,
    forgottenSourceInvalidatesPacket: true, survivingContextItems: after.items.length, externalModelCalls: 0 }, null, 2));
} finally { memory.close(); }
