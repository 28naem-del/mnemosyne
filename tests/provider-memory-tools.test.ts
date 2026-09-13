import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { createMemoryRuntime } from '../src/runtime/index.js';
import { createAnthropicMemoryAdapter, type AnthropicMemoryAdapterOptions, type AnthropicMemoryPolicy } from '../src/adapters/anthropic-memory.js';
import { createProviderMemoryTools, ProviderMemoryToolError, PROVIDER_MEMORY_LIMITS, type ProviderMemoryContext, type ProviderMemoryPayload, type ProviderMemoryTools } from '../src/adapters/provider-memory-tools.js';

const memories: LocalMemory[] = [], directories: string[] = [];
let sequence = 0;
function database() { const directory = mkdtempSync(join(tmpdir(), 'mnemosyne-provider-memory-')); directories.push(directory); return join(directory, 'test.sqlite'); }
function setup(options: Partial<AnthropicMemoryAdapterOptions> = {}, path = ':memory:', agentId = 'owner', workspaceId = 'workspace') {
  const memory = createLocalMemory({ path, workspaceId, agentId }); memories.push(memory);
  const runtime = createMemoryRuntime(memory);
  const engine = createAnthropicMemoryAdapter({ memory, runtime, namespace: 'shared-notes', captureAdapter: 'generic', policy: () => ({ allowDestructive: true }), ...options });
  return { memory, runtime, engine, tools: createProviderMemoryTools({ engine }) };
}
const context = (overrides: Partial<ProviderMemoryContext> = {}): ProviderMemoryContext => ({ sessionId: 'fixture-session', ...overrides });
function openAI(tools: ProviderMemoryTools, name: string, args: unknown, id = `call-${++sequence}`, extra: Record<string, unknown> = {}, ctx = context()) {
  const output = tools.handleOpenAIResponsesCall({ type: 'function_call', status: 'completed', name, call_id: id, id: `item-${id}`, arguments: JSON.stringify(args), ...extra }, ctx);
  expect(output).not.toBeNull(); expect(output!.call_id).toBe(id);
  return JSON.parse(output!.output) as ProviderMemoryPayload;
}
function gemini(tools: ProviderMemoryTools, name: string, args: unknown, id = `gem-${++sequence}`, ctx = context()) {
  const part = tools.handleGeminiFunctionCall({ name, id, args }, ctx);
  expect(part).not.toBeNull(); expect(part!.functionResponse.id).toBe(id); expect(part!.functionResponse.name).toBe(name);
  return part!.functionResponse.response;
}
function invoke(tools: ProviderMemoryTools, protocol: 'openai' | 'gemini', command: string, args: Record<string, unknown>, id?: string, ctx = context()) {
  return protocol === 'openai' ? openAI(tools, `memory_${command}`, { ...(command === 'view' ? { view_range: null } : command === 'str_replace' ? { new_str: null } : {}), ...args }, id, {}, ctx) : gemini(tools, `memory_${command}`, args, id, ctx);
}
function ok(payload: ProviderMemoryPayload): string { expect(payload.ok, JSON.stringify(payload)).toBe(true); if (!payload.ok) throw new Error(payload.error.message); return payload.result; }
function error(payload: ProviderMemoryPayload, code?: string): void { expect(payload).toMatchObject({ ok: false, error: { code: code ?? expect.stringMatching(/^E_/) } }); }
function file(memory: LocalMemory, path = '/memories/note.txt') {
  const record = memory.list({ includeUntrusted: true, metadata: { nativeType: 'manifest' }, limit: 1000 }).items.find(row => JSON.parse(row.text).path === path)!;
  expect(record).toBeDefined();
  const data = JSON.parse(record.text) as { fileId: string; sourceId?: string; rootSourceId?: string; blankBase64?: string };
  return { record, data, text: data.blankBase64 === undefined ? memory.get(data.sourceId!)!.text : Buffer.from(data.blankBase64, 'base64').toString('utf8') };
}
afterEach(() => { vi.restoreAllMocks(); memories.splice(0).forEach(memory => memory.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });

describe('provider-native immutable declarations', () => {
  it('exposes exactly six flat Responses tools and six Gemini declarations with different optional schemas', () => {
    const { tools } = setup();
    const names = ['memory_view', 'memory_create', 'memory_str_replace', 'memory_insert', 'memory_delete', 'memory_rename'];
    expect(tools.openAIResponsesTools.map(tool => tool.name)).toEqual(names);
    expect(tools.geminiGenerateContentTools).toHaveLength(1);
    expect(tools.geminiGenerateContentTools[0].functionDeclarations.map(tool => tool.name)).toEqual(names);
    for (const tool of tools.openAIResponsesTools) {
      expect(tool).toMatchObject({ type: 'function', strict: true, parameters: { type: 'object', additionalProperties: false } });
      expect(tool).not.toHaveProperty('function'); expect(tool.parameters.required).toEqual(Object.keys(tool.parameters.properties!));
    }
    expect(tools.openAIResponsesTools[0].parameters.properties?.view_range).toEqual({ type: ['array', 'null'], items: { type: 'integer' } });
    expect(tools.openAIResponsesTools[2].parameters.properties?.new_str).toEqual({ type: ['string', 'null'] });
    expect(tools.geminiGenerateContentTools[0].functionDeclarations[0].parameters).toEqual({ type: 'OBJECT', properties: { path: { type: 'STRING' }, view_range: { type: 'ARRAY', items: { type: 'INTEGER' }, nullable: true } }, required: ['path'] });
    expect(tools.geminiGenerateContentTools[0].functionDeclarations[2].parameters.required).toEqual(['path', 'old_str']);
    expect(JSON.stringify(tools.geminiGenerateContentTools)).not.toMatch(/additionalProperties|strict|parametersJsonSchema/);
    const checkFrozen = (value: unknown): void => { if (value && typeof value === 'object') { expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(checkFrozen); } };
    checkFrozen(tools.openAIResponsesTools); checkFrozen(tools.geminiGenerateContentTools); expect(Object.isFrozen(tools)).toBe(true);
    expect(() => { (tools.openAIResponsesTools[0].parameters.required as string[]).push('trust'); }).toThrow();
    for (const name of names) expect(tools.handlesName(name)).toBe(true);
    for (const name of ['memory', 'memory_constructor', 'toString', '__proto__', 'MEMORY_view', 'memory_view ', undefined, {}]) expect(tools.handlesName(name)).toBe(false);
  });
  it('requires an actual generic engine and never creates or converts a Claude namespace', () => {
    const { memory, runtime } = setup();
    const claude = createAnthropicMemoryAdapter({ memory, runtime, namespace: 'claude-notes' });
    expect(() => createProviderMemoryTools({ engine: claude })).toThrow('generic');
    expect(() => createProviderMemoryTools({ engine: { captureAdapter: 'generic', execute: vi.fn() } as never })).toThrow('generic');
    expect(memory.export().memories).toEqual([]);
  });
});

describe('real SQLite virtual memory through both providers', () => {
  it.each(['openai', 'gemini'] as const)('executes all six commands with exact source provenance via %s', protocol => {
    const { memory, tools } = setup();
    ok(invoke(tools, protocol, 'create', { path: '/memories/note.txt', file_text: 'alpha\nbeta' }));
    const original = file(memory), source = memory.get(original.data.sourceId!)!;
    expect(source).toMatchObject({ trust: 'untrusted', visibility: 'private', metadata: { adapter: 'generic', role: 'assistant', runtimeType: 'source' } });
    expect(source.source.uri).toMatch(/^transcript:\/\/generic\//); expect(JSON.stringify(source)).not.toContain('claude');
    expect(ok(invoke(tools, protocol, 'view', { path: '/memories/note.txt', view_range: [2, -1] }))).toContain('     2\tbeta');
    ok(invoke(tools, protocol, 'str_replace', { path: '/memories/note.txt', old_str: 'alpha', new_str: '$& $1 $$' }));
    ok(invoke(tools, protocol, 'insert', { path: '/memories/note.txt', insert_line: 1, insert_text: 'middle' }));
    const beforeRename = file(memory);
    ok(invoke(tools, protocol, 'rename', { old_path: '/memories/note.txt', new_path: '/memories/nested/new.txt' }));
    const moved = file(memory, '/memories/nested/new.txt');
    expect(moved.text).toBe('$& $1 $$\nmiddle\nbeta'); expect(moved.data.sourceId).toBe(beforeRename.data.sourceId); expect(moved.data.fileId).toBe(original.data.fileId);
    error(invoke(tools, protocol, 'create', { path: '/memories/nested/new.txt', file_text: 'overwrite' }), 'E_EXISTS');
    ok(invoke(tools, protocol, 'delete', { path: '/memories/nested' }));
    expect(memory.get(source.id)).toBeNull(); expect(memory.get(moved.data.sourceId!)).toBeNull();
    expect(memory.list({ includeUntrusted: true, metadata: { runtimeType: 'tombstone' } }).items).toHaveLength(1);
  });
  it('shares one generic engine across providers and preserves correction, original-source access and forget semantics', () => {
    const { memory, runtime, engine, tools } = setup({ writeTrust: 'observed' });
    ok(openAI(tools, 'memory_create', { path: '/memories/note.txt', file_text: 'Old orchid advice' }, 'original-create'));
    const original = file(memory), source = memory.get(original.data.sourceId!)!;
    const dependent = memory.store({ text: 'Derived orchid advice', trust: 'observed', dependencies: [source.id], source: { uri: 'fixture:derived' } });
    expect(memory.isEligible(dependent.id)).toBe(true);
    ok(gemini(tools, 'memory_view', { path: '/memories/note.txt' }));
    ok(gemini(tools, 'memory_str_replace', { path: '/memories/note.txt', old_str: 'Old', new_str: 'New' }));
    expect(memory.isEligible(dependent.id)).toBe(false);
    expect(ok(openAI(tools, 'memory_view', { path: `/memories/_sources/${source.id}.txt`, view_range: null }))).toContain('Old orchid advice');
    expect(engine.handleToolUse({ type: 'tool_use', id: 'anthropic-view', name: 'memory', input: { command: 'view', path: '/memories/note.txt' } }, context()).content).toContain('New orchid advice');
    const currentId = file(memory).data.sourceId!;
    ok(gemini(tools, 'memory_delete', { path: '/memories/note.txt' }));
    for (const id of [source.id, currentId, dependent.id]) expect(memory.get(id)).toBeNull();
    expect(() => runtime.expandSource(source.id)).toThrow();
    expect(ok(openAI(tools, 'memory_create', { path: '/memories/note.txt', file_text: 'Old orchid advice' }, 'original-create'))).toContain('Previously committed');
    expect(memory.list({ includeUntrusted: true, metadata: { nativeType: 'manifest' } }).items).toEqual([]);
    expect(JSON.stringify(memory.export())).not.toContain('orchid');
  });
  it('isolates owner, workspace and namespace on the same database', () => {
    const path = database(), owner = setup({}, path), foreign = setup({}, path, 'foreign'), elsewhere = setup({}, path, 'owner', 'elsewhere');
    ok(openAI(owner.tools, 'memory_create', { path: '/memories/note.txt', file_text: 'Private secret' }, 'same-id'));
    const sourceId = file(owner.memory).data.sourceId;
    const anotherNamespace = setup({ namespace: 'other-notes' }, path);
    for (const other of [foreign, elsewhere, anotherNamespace]) {
      error(gemini(other.tools, 'memory_view', { path: '/memories/note.txt' }), 'E_NOT_FOUND');
      if (other !== anotherNamespace) error(gemini(other.tools, 'memory_view', { path: `/memories/_sources/${sourceId}.txt` }), 'E_NOT_FOUND');
      ok(openAI(other.tools, 'memory_create', { path: '/memories/note.txt', file_text: 'Different note' }, 'same-id'));
    }
    // The protected mount follows the runtime's owner/workspace scope; virtual
    // file namespaces do not create separate source-access principals.
    expect(ok(gemini(anotherNamespace.tools, 'memory_view', { path: `/memories/_sources/${sourceId}.txt` }))).toContain('Private secret');
    expect(ok(gemini(owner.tools, 'memory_view', { path: '/memories/note.txt' }))).toContain('Private secret');
  });
  it('requires fresh views across sessions and concurrent engine instances', () => {
    const path = database(), first = setup({}, path), second = setup({}, path);
    ok(openAI(first.tools, 'memory_create', { path: '/memories/note.txt', file_text: 'a' }));
    error(gemini(second.tools, 'memory_insert', { path: '/memories/note.txt', insert_line: 1, insert_text: 'b' }), 'E_CONFLICT');
    ok(gemini(second.tools, 'memory_view', { path: '/memories/note.txt' }));
    ok(openAI(first.tools, 'memory_insert', { path: '/memories/note.txt', insert_line: 1, insert_text: 'c' }));
    error(gemini(second.tools, 'memory_insert', { path: '/memories/note.txt', insert_line: 1, insert_text: 'b' }), 'E_CONFLICT');
    error(gemini(first.tools, 'memory_insert', { path: '/memories/note.txt', insert_line: 1, insert_text: 'd' }, undefined, context({ sessionId: 'unobserved-session' })), 'E_CONFLICT');
    expect(file(first.memory).text).toBe('a\nc');
  });
  it('preserves live policy, authorization and cancellation checks including receipt replay', () => {
    let policy: Partial<AnthropicMemoryPolicy> = { allowDestructive: true };
    const authorize = vi.fn(), { tools, memory } = setup({ policy: () => policy, authorize });
    ok(openAI(tools, 'memory_create', { path: '/memories/note.txt', file_text: 'a' }, 'create'));
    policy = { captureEnabled: false, recallEnabled: false, allowDestructive: false };
    error(openAI(tools, 'memory_create', { path: '/memories/note.txt', file_text: 'a' }, 'create'), 'E_POLICY');
    error(gemini(tools, 'memory_view', { path: '/memories/note.txt' }), 'E_POLICY');
    error(gemini(tools, 'memory_delete', { path: '/memories/note.txt' }), 'E_POLICY');
    policy = { allowDestructive: true, readOnly: true };
    error(gemini(tools, 'memory_delete', { path: '/memories/note.txt' }), 'E_POLICY');
    policy = { allowDestructive: true };
    const abort = new AbortController(); abort.abort();
    error(openAI(tools, 'memory_create', { path: '/memories/cancelled', file_text: 'no' }, 'cancelled', {}, context({ signal: abort.signal })), 'E_ABORTED');
    authorize.mockImplementationOnce(() => { throw new Error('private-controller-detail'); });
    const denied = gemini(tools, 'memory_view', { path: '/memories/note.txt' }); error(denied, 'E_POLICY'); expect(JSON.stringify(denied)).not.toContain('private-controller-detail');
    policy = { captureEnabled: false, recallEnabled: false, allowDestructive: true };
    ok(gemini(tools, 'memory_delete', { path: '/memories/note.txt' }));
    expect(memory.list({ includeUntrusted: true, metadata: { nativeType: 'manifest' } }).items).toEqual([]);
  });
});

describe('provider call identities and durable replay', () => {
  it('correlates wire call IDs independently from item, generation and host identities', () => {
    const { tools } = setup();
    const output = tools.handleOpenAIResponsesCall({ type: 'function_call', status: 'completed', id: 'different-item', call_id: 'wire-call', name: 'memory_view', arguments: '{"path":"/memories","view_range":null}', response_id: 'different-generation' }, context({ operationId: 'unused-host-id' }));
    expect(output).toMatchObject({ type: 'function_call_output', call_id: 'wire-call' }); expect(output).not.toHaveProperty('is_error');
    const part = tools.handleGeminiFunctionCall({ id: 'gem-wire', name: 'memory_view', args: { path: '/memories' }, responseId: 'different-generation' }, context());
    expect(part?.functionResponse).toMatchObject({ id: 'gem-wire', name: 'memory_view', response: { ok: true } });
  });
  it('replays after reopening, rejects conflicting reuse and separates protocols and sessions', () => {
    const path = database(), first = setup({}, path), args = { path: '/memories/note.txt', file_text: 'once' };
    ok(openAI(first.tools, 'memory_create', args, 'shared-raw-id'));
    const second = setup({}, path);
    expect(ok(openAI(second.tools, 'memory_create', args, 'shared-raw-id'))).toContain('Previously committed');
    error(openAI(second.tools, 'memory_create', { ...args, file_text: 'different' }, 'shared-raw-id'), 'E_REPLAY');
    ok(gemini(second.tools, 'memory_create', { path: '/memories/gemini', file_text: 'different protocol' }, 'shared-raw-id'));
    ok(openAI(second.tools, 'memory_create', { path: '/memories/session', file_text: 'different session' }, 'shared-raw-id', {}, context({ sessionId: 'other-session' })));
    expect(second.memory.list({ includeUntrusted: true, metadata: { nativeType: 'manifest' } }).items).toHaveLength(3);
  });
  it('gives same-name parallel calls separate outputs and does not repeat insertions', () => {
    const { tools, memory } = setup();
    ok(gemini(tools, 'memory_create', { path: '/memories/note.txt', file_text: 'start' }, 'create'));
    const args = { path: '/memories/note.txt', insert_line: 1, insert_text: 'line' };
    ok(gemini(tools, 'memory_insert', args, 'parallel-a'));
    ok(gemini(tools, 'memory_insert', args, 'parallel-b'));
    expect(ok(gemini(tools, 'memory_insert', args, 'parallel-a'))).toContain('Previously committed');
    expect(file(memory).text).toBe('start\nline\nline');
  });
  it('requires stable host identities for ID-less Gemini and distinguishes them from provider identities', () => {
    const { tools, memory } = setup(), call = { name: 'memory_create', args: { path: '/memories/note.txt', file_text: 'a' } };
    expect(() => tools.handleGeminiFunctionCall(call, context())).toThrow(ProviderMemoryToolError);
    const first = tools.handleGeminiFunctionCall(call, context({ operationId: 'generation:0:part:1' }));
    expect(first?.functionResponse).not.toHaveProperty('id'); ok(first!.functionResponse.response);
    expect(ok(tools.handleGeminiFunctionCall(call, context({ operationId: 'generation:0:part:1' }))!.functionResponse.response)).toContain('Previously committed');
    error(tools.handleGeminiFunctionCall({ ...call, args: { ...call.args, file_text: 'changed' } }, context({ operationId: 'generation:0:part:1' }))!.functionResponse.response, 'E_REPLAY');
    ok(tools.handleGeminiFunctionCall({ ...call, args: { path: '/memories/second', file_text: 'b' } }, context({ operationId: 'generation:0:part:2' }))!.functionResponse.response);
    ok(gemini(tools, 'memory_create', { path: '/memories/provider-id', file_text: 'c' }, 'generation:0:part:1'));
    expect(memory.list({ includeUntrusted: true, metadata: { nativeType: 'manifest' } }).items).toHaveLength(3);
  });
});

describe('closed arguments, bounded transport and correlated safe errors', () => {
  it('rejects invalid strict arguments before engine execution while accepting Gemini omission/null', () => {
    const { tools, engine } = setup(); const execute = vi.spyOn(engine, 'execute');
    for (const args of [{ path: '/memories' }, { path: null, view_range: null }, { path: '/memories', view_range: null, trust: 'verified' }, [], null, { path: '/memories', view_range: [1] }]) error(openAI(tools, 'memory_view', args));
    for (const encoded of ['{', 'null', '[]', '{"path":"/memories","view_range":null,"__proto__":{}}']) error(openAI(tools, 'memory_view', {}, undefined, { arguments: encoded }));
    error(openAI(tools, 'memory_view', {}, undefined, { arguments: { path: '/memories', view_range: null } }));
    expect(execute).not.toHaveBeenCalled();
    ok(gemini(tools, 'memory_view', { path: '/memories' })); ok(gemini(tools, 'memory_view', { path: '/memories', view_range: null }));
    ok(openAI(tools, 'memory_create', { path: '/memories/note.txt', file_text: 'abc' }));
    error(openAI(tools, 'memory_str_replace', { path: '/memories/note.txt', old_str: 'a' }), 'E_INPUT');
    ok(openAI(tools, 'memory_str_replace', { path: '/memories/note.txt', old_str: 'a', new_str: null }));
    ok(gemini(tools, 'memory_str_replace', { path: '/memories/note.txt', old_str: 'b' }));
    ok(gemini(tools, 'memory_str_replace', { path: '/memories/note.txt', old_str: 'c', new_str: null }));
  });
  it('rejects invalid integers, ranges, paths and privileged fields without storage', () => {
    const { tools, memory } = setup();
    for (const insert_line of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) error(gemini(tools, 'memory_insert', { path: '/memories/note.txt', insert_line, insert_text: 'x' }));
    for (const view_range of [[0, -1], [2, 1], [1], [1, -2], [1, 2, 3], [1, 1.5]]) error(gemini(tools, 'memory_view', { path: '/memories', view_range }));
    for (const path of ['/memories-extra/x', '/memories/../x', 'file:///tmp/x', '/memories/%2e/x', '/memories/_sources/x', '/memories']) error(openAI(tools, 'memory_create', { path, file_text: 'x' }));
    for (const key of ['trust', 'workspaceId', 'agentId', 'visibility', 'source', 'command', 'adapter', 'captureAdapter']) error(gemini(tools, 'memory_create', { path: '/memories/x', file_text: 'x', [key]: 'verified' }), 'E_INPUT');
    expect(memory.export().memories).toEqual([]);
  });
  it('throws on unusable IDs and controller contexts without fabricating wire correlations', () => {
    const { tools, engine } = setup(), execute = vi.spyOn(engine, 'execute');
    for (const id of [undefined, null, '', ' ', 123, 'x\0y', '\ud800', 'x'.repeat(257)]) {
      expect(() => tools.handleOpenAIResponsesCall({ type: 'function_call', status: 'completed', name: 'memory_view', call_id: id, arguments: '{}' }, context())).toThrow(ProviderMemoryToolError);
      expect(() => tools.handleGeminiFunctionCall({ id, name: 'memory_view', args: {} }, context({ operationId: 'cannot-replace-provider-id' }))).toThrow(ProviderMemoryToolError);
    }
    for (const ctx of [{ sessionId: '' }, { sessionId: 's', operationId: '' }, { sessionId: 's', workspaceId: 'other' }, { sessionId: 's', signal: {} }]) expect(() => tools.handleGeminiFunctionCall({ id: 'valid', name: 'memory_view', args: { path: '/memories' } }, ctx as ProviderMemoryContext)).toThrow(ProviderMemoryToolError);
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not execute incomplete, async, programmatic or namespaced Responses calls', () => {
    const { tools, engine } = setup(), execute = vi.spyOn(engine, 'execute');
    for (const fields of [{ type: 'function_call_output' }, { status: 'in_progress' }, { status: 'incomplete' }, { status: null }, { async: true }, { namespace: 'other' }, { caller: { type: 'program', caller_id: 'parent' } }]) error(openAI(tools, 'memory_view', { path: '/memories', view_range: null }, undefined, fields), 'E_INPUT');
    expect(execute).not.toHaveBeenCalled();
    ok(openAI(tools, 'memory_view', { path: '/memories', view_range: null }, undefined, { caller: { type: 'direct' }, async: false, namespace: '', futureMetadata: { version: 1 } }));
  });
  it('leaves other tools unhandled and never uses dynamic function-name dispatch', () => {
    const { tools, engine } = setup(), execute = vi.spyOn(engine, 'execute');
    for (const name of ['weather', 'constructor', '__proto__', 'memory', 'memory_delete_all']) {
      expect(tools.handleOpenAIResponsesCall({ name, arguments: 'not-memory-arguments' }, context())).toBeNull();
      expect(tools.handleGeminiFunctionCall({ name, args: 'not-memory-arguments' }, context())).toBeNull();
    }
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects getters, cycles, sparse arrays and oversized/deep envelopes without invoking them', () => {
    const { tools, engine } = setup(), execute = vi.spyOn(engine, 'execute'), getter = vi.fn(() => '/memories');
    const args = Object.defineProperty({}, 'path', { get: getter, enumerable: true });
    error(gemini(tools, 'memory_view', args), 'E_INPUT'); expect(getter).not.toHaveBeenCalled();
    const outer = Object.defineProperty({}, 'name', { get: getter, enumerable: true });
    expect(() => tools.handleGeminiFunctionCall(outer, context())).toThrow(ProviderMemoryToolError); expect(getter).not.toHaveBeenCalled();
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    error(openAI(tools, 'memory_view', { path: '/memories', view_range: null }, undefined, { futureMetadata: cycle }), 'E_INPUT');
    error(gemini(tools, 'memory_view', { path: '/memories', view_range: new Array(2) }), 'E_INPUT');
    const toJSON = vi.fn(() => ({})); error(gemini(tools, 'memory_view', { path: '/memories', toJSON }), 'E_INPUT'); expect(toJSON).not.toHaveBeenCalled();
    error(openAI(tools, 'memory_view', {}, undefined, { arguments: 'x'.repeat(PROVIDER_MEMORY_LIMITS.maxArgumentBytes + 1) }), 'E_LIMIT');
    error(openAI(tools, 'memory_view', { path: '/memories', view_range: null }, undefined, { futureMetadata: 'x'.repeat(PROVIDER_MEMORY_LIMITS.maxEnvelopeBytes + 1) }), 'E_LIMIT');
    let deep: unknown = {}; for (let i = 0; i < 10; i++) deep = { nested: deep };
    error(openAI(tools, 'memory_view', { path: '/memories', view_range: null }, undefined, { futureMetadata: deep }), 'E_LIMIT');
    expect(execute).not.toHaveBeenCalled();
  });
  it('preserves maximum-size escaped blank edits and the full engine output budget', () => {
    const { tools, memory, engine } = setup();
    const before = '\u000b'.repeat(32000), after = '\u000c'.repeat(32000);
    ok(openAI(tools, 'memory_create', { path: '/memories/note.txt', file_text: before }));
    ok(openAI(tools, 'memory_str_replace', { path: '/memories/note.txt', old_str: before, new_str: after }));
    expect(file(memory).text).toBe(after);
    vi.spyOn(engine, 'execute').mockReturnValue('\u000b'.repeat(131072));
    const payload = openAI(tools, 'memory_view', { path: '/memories', view_range: null });
    expect(ok(payload)).toHaveLength(131072); expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(PROVIDER_MEMORY_LIMITS.maxResultBytes);
  });
  it('sanitizes unexpected errors and has no SDK, network, filesystem or configuration side effects', () => {
    const { tools, engine } = setup();
    vi.spyOn(engine, 'execute').mockImplementation(() => { throw Object.assign(new Error('/Users/private/file.sqlite secret-key'), { code: 'E_POLICY' }); });
    const payload = openAI(tools, 'memory_view', { path: '/memories', view_range: null }); error(payload, 'E_STATE'); expect(JSON.stringify(payload)).not.toMatch(/Users|sqlite|secret-key/);
    const source = readFileSync(new URL('../src/adapters/provider-memory-tools.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"](?:openai|@google\/genai|(?:node:)?(?:fs|path|https?|net|child_process))['"]|\bfetch\s*\(|process\.env/);
  });
});
