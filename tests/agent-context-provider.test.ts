import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { MemoryRuntime } from '../src/runtime/index.js';
import { MemoryAgent, type AgentContext, type AgentContextProvider } from '../src/agent/index.js';

const memories: LocalMemory[] = [], agents: MemoryAgent[] = [];
const turn = { input: 'Read my memory', query: 'Atlas', sessionId: 'synthetic', turnId: 'first', maxTokens: 1024 };
function setup(options: ConstructorParameters<typeof MemoryAgent>[1] = {}, runtimeOptions = {}) {
  const memory = createLocalMemory({ path: ':memory:', workspaceId: 'provider-fixture', agentId: 'client' });
  memories.push(memory);
  const runtime = new MemoryRuntime(memory, runtimeOptions);
  const agent = new MemoryAgent(runtime, options); agents.push(agent);
  return { memory, runtime, agent };
}
function packet(): AgentContext { return { text: '', tokens: 0, tokenBudget: 1024, memoryIds: [], abstained: true }; }
afterEach(async () => { await Promise.all(agents.splice(0).map(agent => agent.close())); memories.splice(0).forEach(memory => memory.close()); });

describe('validated external context providers', () => {
  it('binds the provider and validates after build and again before the host receives it', async () => {
    const context = packet();
    const provider = { marker: 'original', build: vi.fn(async function (this: { marker: string }) { expect(this.marker).toBe('original'); return context; }), validate: vi.fn(() => undefined) };
    const { agent } = setup({ contextProvider: provider });
    provider.build = vi.fn(async () => { throw new Error('Replaced method must not run.'); });
    const host = vi.fn(async request => { expect(provider.validate).toHaveBeenCalledTimes(2); expect(request.context).toBe(context); return 'Visible answer'; });
    await agent.runTurn(turn, host);
    expect(host).toHaveBeenCalledTimes(1);
  });

  it('blocks a provider whose external source confirmation was revoked after construction', async () => {
    let current = true;
    const { agent, memory } = setup({ contextProvider: { build: async () => packet(), validate: () => { if (!current) throw new Error('PRIVATE_SOURCE_DETAILS'); } } });
    const before = agent.beforeTurn.bind(agent);
    vi.spyOn(agent, 'beforeTurn').mockImplementation(async input => { const result = await before(input); current = false; return result; });
    const host = vi.fn(async () => 'Never dispatched');
    await expect(agent.runTurn(turn, host)).rejects.toMatchObject({ code: 'context-failed' });
    expect(host).not.toHaveBeenCalled();
    expect(memory.list({ includeUntrusted: true }).items).toEqual([]);
  });

  it('binds the complete rendered context even if a provider forgets to detect packet tampering', async () => {
    const context = packet();
    const { agent } = setup({ contextProvider: { build: async () => context, validate: () => undefined } });
    const before = agent.beforeTurn.bind(agent);
    vi.spyOn(agent, 'beforeTurn').mockImplementation(async input => { const result = await before(input); context.text = 'Injected after validation'; return result; });
    const host = vi.fn(async () => 'Never dispatched');
    await expect(agent.runTurn(turn, host)).rejects.toMatchObject({ code: 'context-failed' });
    expect(host).not.toHaveBeenCalled();
  });

  it('rejects async validation instead of treating its pending promise as permission to dispatch', async () => {
    const provider: AgentContextProvider = { build: async () => packet(), validate: async () => { throw new Error('Private asynchronous validation failure'); } };
    const { agent } = setup({ contextProvider: provider });
    const host = vi.fn(async () => 'Never dispatched');
    await expect(agent.runTurn(turn, host)).rejects.toMatchObject({ code: 'context-failed' });
    expect(host).not.toHaveBeenCalled();
  });

  it('rejects a validator that changes the packet during validation', async () => {
    const { agent } = setup({ contextProvider: { build: async () => packet(), validate: context => { context.text = 'Changed during validation'; } } });
    await expect(agent.beforeTurn({ query: 'Atlas', maxTokens: 1024 })).rejects.toMatchObject({ code: 'context-failed' });
  });

  it.each(['read-only', 'capture-disabled', 'recall-disabled'])('preflights %s before a source-staging provider can invoke its adapter', async policy => {
    const build = vi.fn(async () => packet());
    const { agent } = setup({ readOnly: policy === 'read-only', contextProvider: { build, validate: () => undefined, requiresCapture: true } }, { captureEnabled: policy !== 'capture-disabled', recallEnabled: policy !== 'recall-disabled' });
    if (policy === 'recall-disabled') expect(await agent.beforeTurn({ query: 'Atlas', maxTokens: 1024 })).toMatchObject({ enabled: false });
    else await expect(agent.beforeTurn({ query: 'Atlas', maxTokens: 1024 })).rejects.toMatchObject({ code: 'context-failed' });
    expect(build).not.toHaveBeenCalled();
  });

  it('permits a pure read-only provider and preserves ordinary source eligibility checks', async () => {
    const context = packet(), build = vi.fn(async () => context);
    const { agent, memory } = setup({ readOnly: true, contextProvider: { build, validate: () => undefined } });
    const source = memory.store({ text: 'Untrusted Atlas claim', trust: 'untrusted', source: { uri: 'fixture:untrusted' } });
    expect((await agent.beforeTurn({ query: 'Atlas', maxTokens: 1024 })).context).toBe(context);
    context.text = source.text; context.tokens = Buffer.byteLength(source.text); context.memoryIds = [source.id]; context.abstained = false;
    await expect(agent.beforeTurn({ query: 'Atlas', maxTokens: 1024 })).rejects.toMatchObject({ code: 'context-failed' });
  });

  it('rejects an ambiguous builder and provider without invoking either', () => {
    const build = vi.fn(async () => packet());
    expect(() => setup({ contextProvider: { build, validate: () => undefined }, contextBuilder: build })).toThrow('ambiguous');
    expect(build).not.toHaveBeenCalled();
  });
});
