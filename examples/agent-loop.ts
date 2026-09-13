/** Offline host integration. The host reply and proposal are explicit synthetic fixtures. */
import { createLocalMemory } from '../dist/local/index.js';
import { MemoryRuntime } from '../dist/runtime/index.js';
import { MemoryAgent, AgentOperationError } from '../dist/agent/index.js';

const memory = createLocalMemory({ path: ':memory:', workspaceId: 'agent-example', agentId: 'assistant' });
const agent = new MemoryAgent(new MemoryRuntime(memory), {
  captureTrust: 'observed', // Host witnessed the supplied message; this does not verify its claims.
  proposer: async request => ({ observations: [{
    text: `The supplied conversation records this release constraint: ${request.sources[0].text}`,
    sourceIds: [request.sources[0].id],
  }] }),
  jobBudgets: { maxJobs: 2, maxCalls: 2, timeoutMs: 1000 },
});
try {
  const turn = await agent.runTurn({ sessionId: 'conversation', turnId: 'turn-1', input: 'Atlas release requires two reviewers.', query: 'Atlas release' }, async ({ context, signal }) => {
    if (signal.aborted) throw new Error('Host cancelled.');
    // Your existing model call belongs here. Pass context.text as reference data.
    if (context.memoryIds.length !== 0) throw new Error('Expected a new account.');
    return 'I will check the Atlas review policy before releasing.';
  });
  const learning = await agent.start({ maxCycles: 1, maxCalls: 2 }).done;
  const recalled = await agent.beforeTurn({ query: 'Atlas release reviewers', maxTokens: 8192 });
  if (!recalled.context.memoryIds.length || learning.completed !== 2) throw new Error('Lifecycle fixture failed.');
  const source = turn.after.records[0];
  const action = agent.prepareAction({ name: 'release', args: { project: 'Atlas', reviewers: 2 }, memoryIds: [source.id], dependenciesComplete: true });
  const correction = memory.correct(source.id, { text: 'Atlas now requires three reviewers.', source: { uri: 'fixture:revised-policy' }, reason: 'Synthetic policy update.' });
  let dispatched = false, rejected = false;
  try { await agent.executeAction(action, async () => { dispatched = true; return 'release'; }); }
  catch (error) { rejected = error instanceof AgentOperationError && error.code === 'action-rejected'; }
  if (dispatched || !rejected) throw new Error('Stale action was not rejected.');
  agent.forgetSource(correction.id);
  console.log(JSON.stringify({ externalModelCalls: 0, scriptedProposalCalls: learning.modelCalls, captured: turn.after.records.length, recalled: recalled.context.memoryIds.length, staleActionRejected: rejected, forgotten: memory.get(correction.id) === null }));
} finally { await agent.close(); memory.close(); }
