import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLocalMemory, LocalMemory } from '../src/local/index.js';
import { canonical } from '../src/local/validation.js';
import { createMemoryRuntime } from '../src/runtime/index.js';
import { createAnthropicMemoryAdapter, type AnthropicMemoryAdapter, type AnthropicMemoryAdapterOptions, type AnthropicMemoryExecutionContext, type AnthropicMemoryPolicy, type AnthropicMemoryToolUse } from '../src/adapters/index.js';

const memories: LocalMemory[] = [], directories: string[] = [];
let sequence = 0;
function setup(options: Partial<AnthropicMemoryAdapterOptions> = {}, path = ':memory:', agentId = 'owner', workspaceId = 'workspace') {
  const memory = createLocalMemory({ path, workspaceId, agentId }); memories.push(memory);
  const runtime = createMemoryRuntime(memory);
  const adapter = createAnthropicMemoryAdapter({ memory, runtime, namespace: 'notes', writeTrust: 'observed', policy: () => ({ allowDestructive: true }), ...options });
  return { memory, runtime, adapter };
}
function database() { const directory = mkdtempSync(join(tmpdir(), 'mnemosyne-native-test-')); directories.push(directory); return join(directory, 'memory.sqlite'); }
function call(adapter: AnthropicMemoryAdapter, input: unknown, id = `tool-${++sequence}`, sessionId = 'session', signal?: AbortSignal) {
  return adapter.handleToolUse({ type: 'tool_use', id, name: 'memory', input }, { sessionId, signal });
}
function ok(adapter: AnthropicMemoryAdapter, input: unknown, id?: string, session?: string) {
  const result = call(adapter, input, id, session); expect(result.is_error, result.content).toBeUndefined(); return result;
}
function create(adapter: AnthropicMemoryAdapter, path: string, text: string, id?: string) { return ok(adapter, { command: 'create', path, file_text: text }, id); }
function view(adapter: AnthropicMemoryAdapter, path: string, session?: string) { return ok(adapter, { command: 'view', path }, undefined, session); }
function bindings(memory: LocalMemory) { return memory.list({ limit: 1000, includeUntrusted: true, metadata: { nativeType: 'manifest' } }).items.map(record => ({ record, data: JSON.parse(record.text) as { path: string; sourceId?: string; rootSourceId?: string; fileId: string; generation: number; blankBase64?: string } })); }
function file(memory: LocalMemory, path = '/memories/note.txt') { const binding = bindings(memory).find(value => value.data.path === path)!; return { ...binding, text: binding.data.blankBase64 === undefined ? memory.get(binding.data.sourceId!)!.text : Buffer.from(binding.data.blankBase64, 'base64').toString('utf8') }; }
function error(adapter: AnthropicMemoryAdapter, input: unknown, code: string, id?: string) { expect(call(adapter, input, id)).toMatchObject({ is_error: true, content: expect.stringContaining(code) }); }
afterEach(() => { vi.restoreAllMocks(); memories.splice(0).forEach(memory => memory.close()); directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })); });

describe('native Anthropic memory protocol and validation', () => {
  it('has the native descriptor, all six commands, correct result IDs and default untrusted provenance', () => {
    const { adapter, memory } = setup({ writeTrust: undefined });
    expect(adapter.definition).toEqual({ type: 'memory_20250818', name: 'memory' });
    expect(view(adapter, '/memories').content).toContain('/memories/_sources/');
    create(adapter, '/memories/note.txt', 'a\nb');
    expect(memory.get(file(memory).data.sourceId!)!.trust).toBe('untrusted');
    expect(view(adapter, '/memories/note.txt').content).toContain('trust=untrusted');
    ok(adapter, { command: 'str_replace', path: '/memories/note.txt', old_str: 'a', new_str: 'A' });
    ok(adapter, { command: 'insert', path: '/memories/note.txt', insert_line: 1, insert_text: 'middle' });
    ok(adapter, { command: 'rename', old_path: '/memories/note.txt', new_path: '/memories/new/name.txt' });
    expect(file(memory, '/memories/new/name.txt').text).toBe('A\nmiddle\nb');
    expect(ok(adapter, { command: 'delete', path: '/memories/new' }, 'delete-id')).toMatchObject({ type: 'tool_result', tool_use_id: 'delete-id' });
    expect(bindings(memory)).toEqual([]);
  });
  it('runs with current and legacy SDK contexts and throws errors instead of success-looking error strings', () => {
    const { adapter } = setup(); const runnable = adapter.asRunnable({ sessionId: 'sdk-session' });
    // Pinned SDK 0.125.0 BetaRunnableTool shape; no mandatory SDK dependency.
    const sdkShape: { type: 'memory_20250818'; name: 'memory'; parse: (input: unknown) => unknown; run: (input: unknown, context?: { toolUse: AnthropicMemoryToolUse; toolUseBlock: AnthropicMemoryToolUse; signal?: AbortSignal | null }) => string | Promise<string> } = runnable;
    const input = { command: 'create', path: '/memories/sdk.txt', file_text: 'hello' }, block: AnthropicMemoryToolUse = { type: 'tool_use', name: 'memory', id: 'sdk-id', input };
    expect(sdkShape.run(sdkShape.parse(input), { toolUse: block, toolUseBlock: block })).toContain('Created');
    expect(runnable.run(input, { toolUseBlock: block })).toContain('Previously committed');
    expect(() => runnable.run(input)).toThrow('trusted');
    expect(() => runnable.run(input, { toolUse: block, toolUseBlock: { ...block, id: 'other' } })).toThrow('consistent');
    expect(() => runnable.run({ ...input, file_text: 'different' }, { toolUse: block })).toThrow('differs');
    const abort = new AbortController(); abort.abort();
    expect(() => runnable.run({ command: 'view', path: '/memories' }, { toolUse: { id: 'aborted' }, signal: abort.signal })).toThrow('E_ABORTED');
    expect(call(adapter, { command: 'unknown' }, 'bad-id')).toMatchObject({ tool_use_id: 'bad-id', is_error: true });
  });
  it.each(['/memories-extra/a', '/MEMORIES/a', '/memories/../a', '/memories/./a', '/memories/a\\b', '/memories/%2e%2e/a', 'file:///memories/a', '/memories/a\u0001', '/memories/a:b'])('rejects virtual path escapes %j in all path positions', path => {
    const { adapter, memory } = setup();
    error(adapter, { command: 'create', path, file_text: 'no' }, 'E_PATH');
    error(adapter, { command: 'rename', old_path: path, new_path: '/memories/a' }, 'E_PATH');
    error(adapter, { command: 'rename', old_path: '/memories/a', new_path: path }, 'E_PATH');
    expect(memory.export().memories).toEqual([]);
  });
  it('rejects malformed inputs, scalar errors and privileged fields before storage', () => {
    const { adapter, memory } = setup();
    const inputs = [{ command: 'create', path: '/memories/a', file_text: null }, { command: 'create', path: '/memories/a', file_text: '\ud800' }, { command: 'create', path: '/memories/a', file_text: 'x\0y' }, { command: 'create', path: '/memories/a', file_text: 'x', trust: 'verified' }, { command: 'str_replace', path: '/memories/a', old_str: 'a', new_str: null }, Object.assign(Object.create({ dangerous: true }), { command: 'view', path: '/memories' }), { command: 'create', path: '/memories/a', file_text: 'x'.repeat(32001) }];
    for (const input of inputs) expect(call(adapter, input).is_error).toBe(true);
    for (const insert_line of [NaN, Infinity, 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) error(adapter, { command: 'insert', path: '/memories/a', insert_line, insert_text: 'x' }, 'E_RANGE');
    for (const view_range of [[0, 2], [2, 1], [1], [1, 2, 3], [1, 1.5], null]) error(adapter, { command: 'view', path: '/memories/a', view_range }, 'E_RANGE');
    const getter = vi.fn(() => 'view'); expect(call(adapter, Object.defineProperty({}, 'command', { get: getter })).is_error).toBe(true); expect(getter).not.toHaveBeenCalled();
    expect(memory.export().memories).toEqual([]);
  });
  it('protects canonical root and source aliases and never imports filesystem or network APIs', () => {
    const { adapter } = setup();
    for (const path of ['/memories', '/memories///', '//memories//', '/memories/_sources', '/memories//_sources/a.txt/']) {
      for (const command of ['delete', 'create']) error(adapter, { command, path, ...(command === 'create' ? { file_text: '' } : {}) }, 'E_PROTECTED');
      error(adapter, { command: 'rename', old_path: '/memories/a', new_path: path }, 'E_PROTECTED');
    }
    const source = readFileSync(new URL('../src/adapters/anthropic-memory.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/adapters/anthropic-memory-paths.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"](?:node:)?(?:fs|path|https?|net|child_process)|\bfetch\s*\(/);
  });
});

describe('exact virtual text and directory semantics', () => {
  it('preserves exact original bytes, ranges, CRLF and Unicode, and treats blank files honestly', () => {
    const { adapter, memory } = setup(); create(adapter, '/memories/note.txt', '  α\r\n😀 é\n');
    expect(file(memory).text).toBe('  α\r\n😀 é\n');
    const content = ok(adapter, { command: 'view', path: '/memories/note.txt', view_range: [2, 99] }).content;
    expect(content).toContain('     2\t😀 é\n'); expect(content).not.toContain('     3\t');
    expect(ok(adapter, { command: 'view', path: '/memories/note.txt', view_range: [1, -1] }).content).toContain('  α\r');
    error(adapter, { command: 'view', path: '/memories/note.txt', view_range: [3, -1] }, 'E_RANGE');
    create(adapter, '/memories/blank.txt', ''); expect(view(adapter, '/memories/blank.txt').content).toContain('source=blank');
    error(adapter, { command: 'view', path: '/memories/blank.txt', view_range: [1, -1] }, 'E_RANGE');
  });
  it.each([['', 0, 'x', 'x'], ['a\nb', 1, 'x', 'a\nx\nb'], ['a', 1, 'x', 'a\nx'], ['a\n', 1, 'x', 'a\nx\n'], ['a\r\nb', 1, 'x', 'a\r\nx\nb'], ['a\nb', 0, 'x\ny\n', 'x\ny\na\nb'], ['a\n\n', 2, 'x\n', 'a\n\nx\n']])('inserts with the declared LF convention %#', (original, insert_line, insert_text, expected) => {
    const { adapter, memory } = setup(); create(adapter, '/memories/note.txt', String(original));
    ok(adapter, { command: 'insert', path: '/memories/note.txt', insert_line, insert_text }); expect(file(memory).text).toBe(expected);
  });
  it('replaces exactly one literal including multiline and replacement metacharacters', () => {
    const { adapter, memory } = setup(); create(adapter, '/memories/note.txt', 'first\nsecond\nlast');
    const literal = '$& $1 $$ ` \\'; ok(adapter, { command: 'str_replace', path: '/memories/note.txt', old_str: 'first\nsecond', new_str: literal });
    expect(file(memory).text).toBe(`${literal}\nlast`);
    error(adapter, { command: 'str_replace', path: '/memories/note.txt', old_str: '' }, 'E_MATCH');
    error(adapter, { command: 'str_replace', path: '/memories/note.txt', old_str: 'missing' }, 'E_MATCH');
    create(adapter, '/memories/overlap', 'aaa'); error(adapter, { command: 'str_replace', path: '/memories/overlap', old_str: 'aa' }, 'E_AMBIGUOUS');
    create(adapter, '/memories/duplicate', 'same same'); error(adapter, { command: 'str_replace', path: '/memories/duplicate', old_str: 'same' }, 'E_AMBIGUOUS');
    const original = file(memory); ok(adapter, { command: 'insert', path: '/memories/note.txt', insert_line: 0, insert_text: '' });
    ok(adapter, { command: 'str_replace', path: '/memories/note.txt', old_str: literal, new_str: literal }); expect(file(memory).data.sourceId).toBe(original.data.sourceId);
  });
  it('lists two levels deterministically, hides listing names, allows explicit hidden access and has implicit directories', () => {
    const { adapter, memory } = setup();
    for (const path of ['/memories/z', '/memories/a/deep/note', '/memories/a/.hidden', '/memories/node_modules/item']) create(adapter, path, path);
    const listing = view(adapter, '/memories').content; expect(listing.indexOf('/memories/a/')).toBeLessThan(listing.indexOf('/memories/z'));
    expect(listing).toContain('/memories/a/deep/'); expect(listing).not.toContain('/memories/a/deep/note'); expect(listing).not.toContain('/memories/a/.hidden'); expect(listing).not.toContain('/memories/node_modules/item');
    expect(view(adapter, '/memories/a/.hidden').content).toContain('/memories/a/.hidden');
    error(adapter, { command: 'create', path: '/memories/a', file_text: 'collision' }, 'E_EXISTS');
    error(adapter, { command: 'create', path: '/memories/z/child', file_text: 'collision' }, 'E_EXISTS');
    view(adapter, '/memories/a'); const before = file(memory, '/memories/a/deep/note');
    ok(adapter, { command: 'rename', old_path: '/memories/a', new_path: '/memories/new/parent' });
    const after = file(memory, '/memories/new/parent/deep/note'); expect(after.data.fileId).toBe(before.data.fileId); expect(after.data.sourceId).toBe(before.data.sourceId);
    error(adapter, { command: 'view', path: '/memories/a' }, 'E_NOT_FOUND');
    error(adapter, { command: 'rename', old_path: '/memories/new/parent', new_path: '/memories/new/parent/sub' }, 'E_EXISTS');
    ok(adapter, { command: 'delete', path: '/memories/new' }); expect(bindings(memory).map(value => value.data.path)).not.toContain('/memories/new/parent/.hidden');
  });
  it('makes listing and text truncation explicit, rejects overlong lines and enforces post-edit budgets', () => {
    const { adapter, memory } = setup({ limits: { maxListingEntries: 1, maxViewChars: 512, maxFileBytes: 1024 } });
    create(adapter, '/memories/a', '😀'.repeat(8) + '\n' + 'line\n'.repeat(100)); create(adapter, '/memories/b', 'b');
    expect(view(adapter, '/memories').content).toContain('Listing truncated');
    const viewed = view(adapter, '/memories/a').content; expect(viewed).toContain('next unread line:'); expect(viewed).not.toContain('\ufffd');
    create(adapter, '/memories/long', 'x'.repeat(900)); error(adapter, { command: 'view', path: '/memories/long' }, 'E_LIMIT');
    create(adapter, '/memories/image.png', 'text'); error(adapter, { command: 'view', path: '/memories/image.png' }, 'E_UNSUPPORTED');
    const old = file(memory, '/memories/long').data.sourceId;
    error(adapter, { command: 'insert', path: '/memories/long', insert_line: 1, insert_text: 'x'.repeat(124) }, 'E_INPUT'); expect(file(memory, '/memories/long').data.sourceId).toBe(old);
  });
});

describe('provenance, correction, deletion and durable receipts', () => {
  it('invalidates source-derived advice on correction, handles blank transitions, and erases history on delete', () => {
    const { adapter, memory, runtime } = setup(); create(adapter, '/memories/note.txt', 'Original orchid guidance', 'original-create');
    const original = file(memory), source = memory.get(original.data.sourceId!)!;
    const derived = memory.store({ text: 'Derived orchid advice', kind: 'fact', trust: 'observed', dependencies: [source.id], source: { uri: 'fixture:derived' } });
    ok(adapter, { command: 'str_replace', path: '/memories/note.txt', old_str: original.text });
    const blank = file(memory); expect(blank.text).toBe(''); expect(memory.isEligible(blank.data.sourceId!)).toBe(false); expect(memory.isEligible(derived.id)).toBe(false);
    expect(view(adapter, `/memories/_sources/${source.id}.txt`).content).toContain(original.text);
    error(adapter, { command: 'view', path: `/memories/_sources/${blank.data.sourceId}.txt` }, 'E_NOT_FOUND');
    ok(adapter, { command: 'insert', path: '/memories/note.txt', insert_line: 0, insert_text: 'New orchid guidance' });
    const current = file(memory); expect(memory.isEligible(current.data.sourceId!)).toBe(true); expect(memory.get(current.data.sourceId!)!.metadata.advisory).toBeUndefined();
    ok(adapter, { command: 'delete', path: '/memories/note.txt' });
    for (const id of [source.id, blank.data.sourceId!, current.data.sourceId!, derived.id]) expect(memory.get(id)).toBeNull();
    expect(() => runtime.expandSource(source.id)).toThrow();
    expect(ok(adapter, { command: 'create', path: '/memories/note.txt', file_text: original.text }, 'original-create').content).toContain('Previously committed'); expect(bindings(memory)).toEqual([]);
    const receiptText = JSON.stringify(memory.list({ metadata: { nativeType: 'receipt' }, includeUntrusted: true }).items);
    expect(receiptText).not.toContain(original.text); expect(receiptText).not.toContain('/memories/note.txt');
  });
  it('preserves whitespace-only files, promotes an initially blank file, and fails closed after external forgetting', () => {
    const { adapter, memory, runtime } = setup(); create(adapter, '/memories/note.txt', ' \r\n\t');
    expect(file(memory).data.sourceId).toBeUndefined(); expect(file(memory).text).toBe(' \r\n\t');
    ok(adapter, { command: 'insert', path: '/memories/note.txt', insert_line: 0, insert_text: 'Content' });
    const populated = file(memory); expect(populated.data.rootSourceId).toBe(populated.data.sourceId);
    runtime.forgetSource(populated.data.sourceId!); error(adapter, { command: 'view', path: '/memories/note.txt' }, 'E_NOT_FOUND'); expect(bindings(memory)).toEqual([]);
    create(adapter, '/memories/blank', '\n\n'); ok(adapter, { command: 'delete', path: '/memories/blank' }); expect(bindings(memory)).toEqual([]);
  });
  it('stores maximum-size escaped whitespace within the core envelope across the complete blank lifecycle', () => {
    const { adapter, memory } = setup(), blank = '\u000b'.repeat(32000);
    create(adapter, '/memories/note.txt', blank); expect(file(memory).text).toBe(blank); expect(Buffer.byteLength(file(memory).record.text)).toBeLessThan(65536);
    ok(adapter, { command: 'str_replace', path: '/memories/note.txt', old_str: blank, new_str: 'populated' });
    const originalId = file(memory).data.sourceId!;
    ok(adapter, { command: 'str_replace', path: '/memories/note.txt', old_str: 'populated', new_str: blank }); expect(file(memory).text).toBe(blank); expect(memory.isEligible(file(memory).data.sourceId!)).toBe(false);
    ok(adapter, { command: 'str_replace', path: '/memories/note.txt', old_str: blank, new_str: 'restored' }); expect(file(memory).text).toBe('restored'); expect(memory.isEligible(file(memory).data.sourceId!)).toBe(true);
    ok(adapter, { command: 'delete', path: '/memories/note.txt' }); expect(memory.get(originalId)).toBeNull(); expect(bindings(memory)).toEqual([]);
  });
  it('rejects noncanonical or invalid persisted blank encoding even with a matching envelope hash', () => {
    const { adapter, memory } = setup(); create(adapter, '/memories/note.txt', ' '); const original = file(memory);
    const payload = { ...JSON.parse(original.record.text), blankBase64: 'IA==\n' };
    memory.forget(original.record.id);
    memory.store({ text: JSON.stringify(payload), source: { ...original.record.source, revision: createHash('sha256').update(canonical(payload)).digest('hex') }, trust: 'untrusted', metadata: original.record.metadata });
    error(adapter, { command: 'view', path: '/memories/note.txt' }, 'E_CONFLICT');
  });
  it('replays after restart, blocks conflicting IDs and never duplicates an insertion or resurrects a deleted identity', () => {
    const path = database(), first = setup({}, path); create(first.adapter, '/memories/note.txt', 'a', 'create-once');
    const insertion = { command: 'insert', path: '/memories/note.txt', insert_line: 1, insert_text: 'b' };
    ok(first.adapter, insertion, 'insert-once');
    const second = setup({}, path); expect(ok(second.adapter, insertion, 'insert-once').content).toContain('Previously committed'); expect(file(second.memory).text).toBe('a\nb');
    error(second.adapter, { ...insertion, insert_text: 'c' }, 'E_REPLAY', 'insert-once');
    error(second.adapter, { ...insertion, insert_text: 'c' }, 'E_CONFLICT');
    view(second.adapter, '/memories/note.txt'); ok(second.adapter, { command: 'delete', path: '/memories/note.txt' });
    create(second.adapter, '/memories/note.txt', 'independent', 'fresh-create');
    ok(second.adapter, { command: 'create', path: '/memories/note.txt', file_text: 'a' }, 'create-once'); expect(file(second.memory).text).toBe('independent');
  });
  it('keeps rename labels independent from content-derived eligibility', () => {
    const { memory, adapter } = setup(); create(adapter, '/memories/note.txt', 'Rename-safe orchid'); const initial = file(memory);
    const advice = memory.store({ text: 'Renamed-source advice', trust: 'observed', dependencies: [initial.data.sourceId!], source: { uri: 'fixture:advice' } });
    ok(adapter, { command: 'rename', old_path: '/memories/note.txt', new_path: '/memories/other.txt' });
    expect(memory.isEligible(advice.id)).toBe(true); expect(file(memory, '/memories/other.txt').data.sourceId).toBe(initial.data.sourceId);
  });
});

describe('scope, transactions, policy and concurrent writers', () => {
  it('requires the same runtime instance and isolates workspace, owner and namespace including hostile shared rows', () => {
    const path = database(), owner = setup({}, path), foreign = setup({}, path, 'foreign'), elsewhere = setup({}, path, 'owner', 'elsewhere');
    expect(() => createAnthropicMemoryAdapter({ memory: owner.memory, runtime: foreign.runtime, namespace: 'x' })).toThrow('runtime.memory');
    create(owner.adapter, '/memories/note.txt', 'owner secret'); const owned = file(owner.memory);
    const shadow = foreign.memory.store({ text: owned.record.text, trust: 'untrusted', visibility: 'workspace', source: owned.record.source, metadata: owned.record.metadata });
    expect(view(owner.adapter, '/memories/note.txt').content).toContain('owner secret');
    error(foreign.adapter, { command: 'view', path: `/memories/_sources/${owned.data.sourceId}.txt` }, 'E_NOT_FOUND');
    error(elsewhere.adapter, { command: 'view', path: '/memories/note.txt' }, 'E_NOT_FOUND');
    const another = createAnthropicMemoryAdapter({ memory: owner.memory, runtime: owner.runtime, namespace: 'another' }); error(another, { command: 'view', path: '/memories/note.txt' }, 'E_NOT_FOUND');
    ok(owner.adapter, { command: 'delete', path: '/memories/note.txt' }); expect(foreign.memory.get(shadow.id)).not.toBeNull();
  });
  it('rejects malformed persisted controls and source pointer mismatches', () => {
    const { memory, adapter } = setup(); create(adapter, '/memories/note.txt', 'secret'); const initial = file(memory);
    memory.store({ text: '{"version":999}', kind: 'observation', trust: 'untrusted', source: { uri: 'bad:state' }, metadata: initial.record.metadata });
    error(adapter, { command: 'view', path: '/memories/note.txt' }, 'E_CONFLICT');
    const other = setup(); create(other.adapter, '/memories/note.txt', 'other'); const binding = file(other.memory);
    other.memory.correct(binding.record.id, { text: JSON.stringify({ ...binding.data, sourceId: initial.data.sourceId }), source: binding.record.source, metadata: binding.record.metadata, reason: 'tamper fixture' });
    error(other.adapter, { command: 'view', path: '/memories/note.txt' }, 'E_CONFLICT');
  });
  it('detects stale views across independent SQLite connections and preserves create/destination exclusivity', () => {
    const path = database(), first = setup({}, path), second = setup({}, path); create(first.adapter, '/memories/note.txt', 'a\nb');
    view(second.adapter, '/memories/note.txt');
    ok(first.adapter, { command: 'insert', path: '/memories/note.txt', insert_line: 1, insert_text: 'first' });
    error(second.adapter, { command: 'insert', path: '/memories/note.txt', insert_line: 1, insert_text: 'stale' }, 'E_CONFLICT');
    view(second.adapter, '/memories/note.txt'); ok(second.adapter, { command: 'insert', path: '/memories/note.txt', insert_line: 1, insert_text: 'second' });
    expect(file(first.memory).text).toBe('a\nsecond\nfirst\nb');
    error(second.adapter, { command: 'create', path: '/memories/note.txt', file_text: 'new' }, 'E_EXISTS');
    create(first.adapter, '/memories/destination', 'occupied'); view(second.adapter, '/memories/note.txt');
    error(second.adapter, { command: 'rename', old_path: '/memories/note.txt', new_path: '/memories/destination' }, 'E_EXISTS');
    view(second.adapter, '/memories'); create(first.adapter, '/memories/new-child', 'new');
    // A subdirectory preview also conflicts if another writer adds a child.
    create(first.adapter, '/memories/dir/one', 'one'); view(second.adapter, '/memories/dir'); create(first.adapter, '/memories/dir/two', 'two');
    error(second.adapter, { command: 'rename', old_path: '/memories/dir', new_path: '/memories/moved' }, 'E_CONFLICT');
  });
  it('rolls back source, manifest and receipt together on injected failure, cancellation or a changed policy', () => {
    const { adapter, memory } = setup(); create(adapter, '/memories/note.txt', 'before'); const before = memory.export().memories;
    const originalStore = memory.store.bind(memory);
    const store = vi.spyOn(memory, 'store').mockImplementation(input => { if (input.metadata?.nativeType === 'receipt') throw new Error('SQLITE_BUSY secret /host/path'); return originalStore(input); });
    error(adapter, { command: 'str_replace', path: '/memories/note.txt', old_str: 'before', new_str: 'after' }, 'E_CONFLICT', 'retryable');
    expect(memory.export().memories).toEqual(before); store.mockRestore();
    ok(adapter, { command: 'str_replace', path: '/memories/note.txt', old_str: 'before', new_str: 'after' }, 'retryable');
    const cancelled = new AbortController(), stable = memory.export().memories;
    const cancellation = vi.spyOn(memory, 'store').mockImplementation(input => { const record = originalStore(input); if (input.metadata?.nativeType === 'receipt') cancelled.abort(); return record; });
    expect(call(adapter, { command: 'insert', path: '/memories/note.txt', insert_line: 0, insert_text: 'cancelled' }, undefined, undefined, cancelled.signal).content).toContain('E_ABORTED');
    expect(memory.export().memories).toEqual(stable); cancellation.mockRestore();
    let writable = true;
    const guarded = createAnthropicMemoryAdapter({ memory, runtime: createMemoryRuntime(memory), namespace: 'policy-change', policy: () => ({ readOnly: !writable }), authorize: () => { writable = false; } });
    error(guarded, { command: 'create', path: '/memories/no', file_text: 'no' }, 'E_POLICY'); expect(memory.export().memories).toEqual(stable);
  });
  it('enforces current policy even on replay and permits privacy deletion when capture and recall are disabled', async () => {
    let policy: Partial<AnthropicMemoryPolicy> = { allowDestructive: true };
    const { adapter, memory } = setup({ policy: () => policy }); create(adapter, '/memories/note.txt', 'private', 'retry');
    policy = { readOnly: true, allowDestructive: true }; error(adapter, { command: 'create', path: '/memories/note.txt', file_text: 'private' }, 'E_POLICY', 'retry'); error(adapter, { command: 'delete', path: '/memories/note.txt' }, 'E_POLICY');
    const disabled = createMemoryRuntime(memory, { captureEnabled: false, recallEnabled: false });
    const privacy = createAnthropicMemoryAdapter({ memory, runtime: disabled, namespace: 'notes', policy: () => ({ allowDestructive: true }) });
    error(privacy, { command: 'view', path: '/memories/note.txt' }, 'E_POLICY'); error(privacy, { command: 'create', path: '/memories/no', file_text: 'no' }, 'E_POLICY'); ok(privacy, { command: 'delete', path: '/memories/note.txt' });
    const asyncPolicy = setup({ policy: (async () => { throw new Error('Private reason'); }) as never }); error(asyncPolicy.adapter, { command: 'view', path: '/memories' }, 'E_POLICY');
    const asyncAuthorize = setup({ authorize: async () => { throw new Error('Private reason'); } }); error(asyncAuthorize.adapter, { command: 'create', path: '/memories/no', file_text: 'no' }, 'E_POLICY');
    await Promise.resolve(); expect(asyncAuthorize.memory.export().memories).toEqual([]);
  });
  it('checks complete projected capacity, live bytes, callback state changes and sanitized errors', () => {
    const limited = setup({ limits: { maxInventoryRecords: 1 } }); error(limited.adapter, { command: 'create', path: '/memories/a', file_text: 'a' }, 'E_LIMIT'); expect(limited.memory.export().memories).toEqual([]);
    view(limited.adapter, '/memories');
    const tiny = setup({ limits: { maxFiles: 1, maxLiveBytes: 3 } }); create(tiny.adapter, '/memories/a', 'abc'); error(tiny.adapter, { command: 'create', path: '/memories/b', file_text: '' }, 'E_LIMIT');
    const { memory, runtime } = setup();
    const nested = createAnthropicMemoryAdapter({ memory, runtime, namespace: 'nested' });
    const guarded = createAnthropicMemoryAdapter({ memory, runtime, namespace: 'nested', authorize: () => { create(nested, '/memories/race', 'nested'); } });
    error(guarded, { command: 'create', path: '/memories/race', file_text: 'outer' }, 'E_CONFLICT'); expect(bindings(memory)).toEqual([]);
  });
});

describe('provider-neutral execution and immutable capture provenance', () => {
  const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
  const execution = (operationId: string): AnthropicMemoryExecutionContext => ({ sessionId: 'shared-session', operationId });

  it('preserves the exact rc3 Claude namespace, source and receipt contract when the new option is omitted', () => {
    const { adapter, memory } = setup();
    const input = { command: 'create', path: '/memories/note.txt', file_text: 'Legacy Claude content' };
    ok(adapter, input, 'legacy-create');
    const bound = file(memory), source = memory.get(bound.data.sourceId!)!, namespace = digest(['workspace', 'owner', 'notes']);
    const session = `native-memory:${namespace}`;
    expect(adapter.captureAdapter).toBe('claude');
    expect(source.source.uri).toBe(`transcript://claude/${encodeURIComponent(session)}/${bound.data.fileId}`);
    expect(source.source.revision).toBe(digest({ id: bound.data.fileId, role: 'assistant', text: input.file_text }));
    expect(source.metadata).toEqual({ runtimeType: 'source', sessionId: session, adapter: 'claude', cursor: bound.data.fileId, role: 'assistant', ingestKey: `capture:${digest(['claude', session, bound.data.fileId])}` });
    expect(bound.record.metadata).toEqual({ nativeNamespace: namespace, nativeType: 'manifest', advisory: false });
    expect(bound.record.source.uri).toBe(`anthropic-memory:manifest:${namespace}:${bound.data.fileId}:1`);
    const receipt = memory.list({ includeUntrusted: true, metadata: { nativeType: 'receipt' } }).items[0];
    expect(receipt.metadata).toEqual({ nativeNamespace: namespace, nativeType: 'receipt', advisory: false });
    expect(JSON.parse(receipt.text)).toEqual({ version: 1, type: 'receipt', key: digest(['session', 'legacy-create']), commandHash: digest(input) });
    const before = memory.export().memories;
    expect(adapter.execute(input, { sessionId: 'session', operationId: 'legacy-create' })).toContain('Previously committed');
    expect(memory.export().memories).toEqual(before);
  });

  it('imports an unmarked rc3-style snapshot and reopens its files and receipts without mutation', () => {
    const original = setup(); create(original.adapter, '/memories/note.txt', 'Existing legacy record', 'rc3-receipt');
    const snapshot = original.memory.export();
    expect(snapshot.memories.every(record => !('nativeCaptureAdapter' in record.metadata))).toBe(true);
    const path = database(), restored = setup({}, path); restored.memory.import(snapshot);
    const reopened = setup({}, path);
    const before = reopened.memory.export().memories;
    expect(view(reopened.adapter, '/memories/note.txt').content).toContain('Existing legacy record');
    expect(ok(reopened.adapter, { command: 'create', path: '/memories/note.txt', file_text: 'Existing legacy record' }, 'rc3-receipt').content).toContain('Previously committed');
    expect(reopened.memory.export().memories).toEqual(before);
  });

  it('executes all integrations on one generic engine without manufacturing Claude source provenance', () => {
    const { adapter, memory, runtime } = setup({ captureAdapter: 'generic', namespace: 'neutral' });
    const created = { command: 'create', path: '/memories/note.txt', file_text: 'Generic original' };
    expect(adapter.execute(created, execution('create'))).toContain('Created');
    const original = file(memory), originalSource = memory.get(original.data.sourceId!)!;
    expect(originalSource.metadata.adapter).toBe('generic'); expect(originalSource.source.uri).toMatch(/^transcript:\/\/generic\//);
    expect(originalSource.metadata.ingestKey).toBe(`capture:${digest(['generic', originalSource.metadata.sessionId, original.data.fileId])}`);
    const replacement = { command: 'str_replace', path: '/memories/note.txt', old_str: 'original', new_str: 'changed' };
    ok(adapter, replacement, 'replace', 'shared-session');
    expect(adapter.execute(replacement, execution('replace'))).toContain('Previously committed');
    const runnable = adapter.asRunnable({ sessionId: 'shared-session' });
    const insertion = { command: 'insert', path: '/memories/note.txt', insert_line: 1, insert_text: 'New line' };
    expect(runnable.run(insertion, { toolUse: { id: 'insert', name: 'memory', input: insertion } })).toContain('Updated');
    const current = file(memory);
    expect(current.text).toBe('Generic changed\nNew line');
    for (const record of memory.list({ includeInactive: true, includeUntrusted: true, metadata: { runtimeType: 'source' } }).items) {
      expect(record.metadata.adapter).toBe('generic'); expect(record.source.uri).toBe(originalSource.source.uri); expect(record.metadata.ingestKey).toBe(originalSource.metadata.ingestKey);
    }
    adapter.execute({ command: 'str_replace', path: '/memories/note.txt', old_str: current.text, new_str: '' }, execution('blank'));
    expect(memory.isEligible(file(memory).data.sourceId!)).toBe(false);
    adapter.execute({ command: 'insert', path: '/memories/note.txt', insert_line: 0, insert_text: 'Restored' }, execution('restore'));
    expect(memory.isEligible(file(memory).data.sourceId!)).toBe(true);
    adapter.execute({ command: 'delete', path: '/memories/note.txt' }, execution('delete'));
    expect(memory.get(originalSource.id)).toBeNull();
    expect(adapter.execute(created, execution('create'))).toContain('Previously committed'); expect(bindings(memory)).toEqual([]);
    expect(() => runtime.capture({ adapter: 'generic', sessionId: String(originalSource.metadata.sessionId), messages: [{ id: original.data.fileId, role: 'assistant', text: created.file_text }], trust: 'observed' })).toThrow('forgotten');
    expect(memory.list({ includeUntrusted: true, metadata: { nativeType: 'receipt' } }).items.every(record => record.metadata.nativeCaptureAdapter === 'generic')).toBe(true);
  });

  it.each(['claude', 'generic'] as const)('rejects opposite-mode reuse for %s namespaces with files, blank bindings and receipts only', mode => {
    for (const text of ['existing text', '']) {
      const { adapter, memory, runtime } = setup({ captureAdapter: mode });
      const opposite = createAnthropicMemoryAdapter({ memory, runtime, namespace: 'notes', captureAdapter: mode === 'claude' ? 'generic' : 'claude', policy: () => ({ allowDestructive: true }) });
      const input = { command: 'create', path: '/memories/note.txt', file_text: text };
      adapter.execute(input, execution('create'));
      for (const command of [input, { command: 'view', path: '/memories' }, { command: 'delete', path: '/memories/note.txt' }]) expect(() => opposite.execute(command, execution('create'))).toThrow('E_CONFLICT');
      adapter.execute({ command: 'delete', path: '/memories/note.txt' }, execution('delete'));
      expect(bindings(memory)).toEqual([]);
      expect(() => opposite.execute({ command: 'view', path: '/memories' }, execution('view'))).toThrow('Namespace capture mode differs');
      expect(() => opposite.execute(input, execution('create'))).toThrow('E_CONFLICT');
      const fresh = createAnthropicMemoryAdapter({ memory, runtime, namespace: 'fresh', captureAdapter: mode === 'claude' ? 'generic' : 'claude' });
      expect(fresh.execute(input, execution('fresh-create'))).toContain('Created');
    }
  });

  it('reopens generic state, retains replay checks and requires a fresh observation before editing', () => {
    const path = database(), first = setup({ captureAdapter: 'generic' }, path);
    first.adapter.execute({ command: 'create', path: '/memories/note.txt', file_text: 'a' }, execution('create'));
    const insertion = { command: 'insert', path: '/memories/note.txt', insert_line: 1, insert_text: 'b' };
    first.adapter.execute(insertion, execution('insert'));
    const second = setup({ captureAdapter: 'generic' }, path);
    expect(second.adapter.execute(insertion, execution('insert'))).toContain('Previously committed');
    expect(() => second.adapter.execute({ ...insertion, insert_text: 'different' }, execution('insert'))).toThrow('E_REPLAY');
    expect(() => second.adapter.execute(insertion, execution('new-insert'))).toThrow('E_CONFLICT');
    second.adapter.execute({ command: 'view', path: '/memories/note.txt' }, execution('view'));
    second.adapter.execute(insertion, execution('new-insert')); expect(file(first.memory).text).toBe('a\nb\nb');
  });

  it('makes captureAdapter immutable in JavaScript and rejects invalid modes and model-supplied provenance', () => {
    const { adapter, memory, runtime } = setup({ captureAdapter: 'generic' });
    expect(Object.getOwnPropertyDescriptor(adapter, 'captureAdapter')).toMatchObject({ value: 'generic', writable: false, configurable: false });
    expect(() => { (adapter as { captureAdapter: string }).captureAdapter = 'claude'; }).toThrow(TypeError);
    expect(() => Object.defineProperty(adapter, 'captureAdapter', { value: 'claude' })).toThrow(TypeError);
    expect(adapter.captureAdapter).toBe('generic');
    for (const captureAdapter of [null, 'codex', '', true]) expect(() => createAnthropicMemoryAdapter({ memory, runtime, namespace: 'invalid', captureAdapter } as never)).toThrow('captureAdapter');
    expect(() => adapter.execute({ command: 'create', path: '/memories/a', file_text: 'x', captureAdapter: 'claude' }, execution('invalid-command'))).toThrow('E_INPUT');
    expect(memory.export().memories).toEqual([]);
  });

  it('validates direct execution identity and returns only typed, bounded errors before touching storage', () => {
    const { adapter, memory } = setup({ captureAdapter: 'generic' }), input = { command: 'create', path: '/memories/a', file_text: 'x' };
    for (const context of [null, {}, { sessionId: 's' }, { sessionId: 's', operationId: '' }, { sessionId: 's', operationId: 'x'.repeat(257) }, { sessionId: 's', operationId: 'id', signal: {} }, { sessionId: 's', operationId: 'id', namespace: 'foreign' }]) {
      try { adapter.execute(input, context as never); throw new Error('Expected rejection'); }
      catch (error) { expect(error).toMatchObject({ name: 'AnthropicMemoryError', code: 'E_INPUT' }); expect((error as Error).message.length).toBeLessThan(256); }
    }
    expect(memory.export().memories).toEqual([]);
  });

  it('retains scope and current policy for public execution, replay, cancellation and privacy deletion', () => {
    let readOnly = false;
    const path = database(), first = setup({ captureAdapter: 'generic', policy: () => ({ readOnly, allowDestructive: true }) }, path);
    const input = { command: 'create', path: '/memories/note.txt', file_text: 'scoped generic text' };
    first.adapter.execute(input, execution('same-id'));
    const foreign = setup({ captureAdapter: 'generic' }, path, 'other'), otherWorkspace = setup({ captureAdapter: 'generic' }, path, 'owner', 'other');
    expect(() => foreign.adapter.execute({ command: 'view', path: '/memories/note.txt' }, execution('view'))).toThrow('E_NOT_FOUND');
    expect(() => otherWorkspace.adapter.execute({ command: 'view', path: '/memories/note.txt' }, execution('view'))).toThrow('E_NOT_FOUND');
    const prior = first.memory.export().memories;
    readOnly = true; expect(() => first.adapter.execute(input, execution('same-id'))).toThrow('E_POLICY'); expect(first.memory.export().memories).toEqual(prior);
    readOnly = false; const abort = new AbortController(); abort.abort();
    expect(() => first.adapter.execute(input, { ...execution('same-id'), signal: abort.signal })).toThrow('E_ABORTED');
    const disabled = createAnthropicMemoryAdapter({ memory: first.memory, runtime: createMemoryRuntime(first.memory, { recallEnabled: false, captureEnabled: false }), namespace: 'notes', captureAdapter: 'generic', policy: () => ({ allowDestructive: true }) });
    expect(() => disabled.execute({ command: 'view', path: '/memories' }, execution('view'))).toThrow('E_POLICY');
    expect(disabled.execute({ command: 'delete', path: '/memories/note.txt' }, execution('delete'))).toContain('Deleted'); expect(bindings(first.memory)).toEqual([]);
  });
});
