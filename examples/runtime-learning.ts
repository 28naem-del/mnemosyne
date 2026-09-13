/** Deterministic SDK example. No network, host histories, or model execution. */
import { createLocalMemory } from '../dist/local/index.js';
import { MemoryRuntime } from '../dist/runtime/index.js';

const memory = createLocalMemory({ path: ':memory:', workspaceId: 'runtime-example', agentId: 'controller' });
const runtime = new MemoryRuntime(memory);
try {
  const captured = runtime.capture({ sessionId: 'labels', adapter: 'generic', trust: 'observed',
    messages: [{ id: 'm1', role: 'user', text: 'Trim surrounding whitespace from Atlas export labels.' }] }).records[0];
  runtime.enqueue({ kind: 'observe', sourceIds: [captured.id] });
  const processed = await runtime.runJobs({ maxCalls: 1, maxJobs: 1, timeoutMs: 1000,
    // This is an explicitly scripted fixture, not a production summarizer.
    proposer: async request => ({ observations: [{ text: 'The Atlas label procedure removes surrounding whitespace from a plain text label.', sourceIds: [request.sources[0].id] }] }),
  });
  if (processed.completed.length !== 1) throw new Error('The fixture observation job did not complete.');
  const observationId = runtime.jobs()[0].resultIds[0];
  const candidate = runtime.createSkill({ name: 'Atlas export labels', prerequisites: ['Input is a string.'],
    steps: ['Trim surrounding whitespace.'], parameters: { label: { description: 'Label text.', required: true } }, evidenceIds: [observationId] });

  const active = await runtime.trialSkill({ id: candidate.id, timeoutMs: 1000, verifier: async ({ skill, signal }) => {
    if (signal.aborted) throw new Error('Trial cancelled.');
    const input = '  Atlas  '; const actual = input.trim(); const expected = 'Atlas';
    const prerequisitesSatisfied = skill.definition.prerequisites.includes('Input is a string.') && skill.definition.steps.length === 1 && skill.definition.steps[0] === 'Trim surrounding whitespace.';
    return { passed: actual === expected, prerequisitesSatisfied, taskId: 'trim-trial-1', verifier: 'example-fixture-controller',
      evidence: JSON.stringify({ input, actual, expected }) };
  } });
  if (active.state !== 'active') throw new Error('The fixture skill did not pass its trial.');

  const context = memory.compile({ query: 'Atlas export labels', maxTokens: 8192 });
  if (!context.items.some(item => item.id === active.recordId)) throw new Error('The active skill was not supplied as context.');
  // A second actual fixture use supplies independent outcome evidence.
  const secondInput = '  Beta  '; const secondResult = secondInput.trim();
  runtime.recordTrace({ taskId: 'trim-use-2', query: 'Atlas export labels', retrievedIds: context.items.map(item => item.id), usedIds: [active.recordId],
    outcome: { success: secondResult === 'Beta', evidence: JSON.stringify({ input: secondInput, actual: secondResult, expected: 'Beta' }), verifier: 'example-fixture-controller' } });

  const correction = memory.correct(captured.id, { text: 'Atlas labels now preserve surrounding whitespace.', source: { uri: 'example:corrected-policy' }, reason: 'Updated fixture policy.' });
  const retired = runtime.getSkill(candidate.id);
  if (retired?.state !== 'retired') throw new Error('The changed evidence did not retire the skill.');
  const original = runtime.expandSource(captured.id, { maxBytes: 4096 });
  const forgotten = runtime.forgetSource(correction.id);
  console.log(JSON.stringify({ kind: 'deterministic runtime SDK example', externalModelCalls: 0, scriptedProposerCalls: processed.modelCalls,
    promoted: active.state, afterCorrection: retired.state, originalSource: original.source.uri, originalStatus: original.status,
    forgottenRecords: forgotten.deletedIds.length }, null, 2));
} finally { memory.close(); }
