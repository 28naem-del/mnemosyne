import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLocalMemory } from '../src/local/index.js';
import type { MigrationInspection } from '../src/migration/service.js';
import type { FreshnessAssessment } from '../src/maintenance/index.js';

const directories: string[] = [], cli = resolve('dist/cli/index.js');
const base = { sourceStore: 'synthetic-store', sourceOwner: { allowedIds: ['alice'], assumeMissing: 'alice' }, destination: { workspaceId: 'project', agentId: 'assistant' }, evaluatedAt: '2026-09-13T00:00:00.000Z', acknowledgePartial: true };
type Applied = MigrationInspection & { replay: boolean };
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mnemosyne-migration-cli-'))); directories.push(root);
  return { root, db: join(root, 'memory.sqlite'), source: join(root, 'source.json'), manifest: join(root, 'manifest.json'), plan: join(root, 'plan.json') };
}
type Fixture = ReturnType<typeof fixture>;
function write(path: string, content: string | Uint8Array) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function sourceRecord(id = 'record-one', memory = 'SYNTHETIC_PRIVATE_SOURCE_TEXT', extra = {}) { return { id, memory, user_id: 'alice', ...extra }; }
function manifest(f: Fixture, source = f.source, configuration: object = base, profile = 'mem0-array') {
  write(f.manifest, JSON.stringify({ version: 1, files: [{ path: source, profile, ...(profile === 'markdown' ? { logicalPath: 'project/notes.md' } : {}) }], options: configuration }));
}
function result(args: string[], cwd?: string) {
  const output = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd, timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, MNEMOSYNE_TOKEN: '' } });
  expect(output.error).toBeUndefined(); expect(output.signal).toBeNull(); return output;
}
function json<T>(args: string[], cwd?: string): T { const output = result(args, cwd); expect(output.status, output.stderr).toBe(0); return JSON.parse(output.stdout) as T; }
const scope = (f: Fixture) => ['--db', f.db, '--workspace', 'project', '--agent', 'assistant'];
function plan(f: Fixture, configuration: object = base) {
  if (!existsSync(f.source)) write(f.source, JSON.stringify([sourceRecord()]));
  manifest(f, f.source, configuration);
  return json<{ planHash: string; readyToApply: boolean }>(['migrate', '--file', f.manifest, '--out', f.plan]);
}
function apply(f: Fixture, batch = 'first'): Applied { return json<Applied>(['migrate', '--action', 'apply', '--file', f.plan, '--db', f.db, '--batch', batch, '--confirm']); }
function inspect(f: Fixture, batch = 'first') { return json<MigrationInspection>(['migrate', '--action', 'inspect', ...scope(f), '--batch', batch]); }
function noDatabase(f: Fixture) { expect(existsSync(f.db)).toBe(false); expect(existsSync(`${f.db}-wal`)).toBe(false); expect(existsSync(`${f.db}-shm`)).toBe(false); }
function initialDatabase(f: Fixture) { const memory = createLocalMemory({ path: f.db, workspaceId: 'project', agentId: 'assistant' }); memory.close(); }
afterEach(() => { directories.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('migration CLI review and explicit one-file setup', () => {
  it('creates a private, complete redacted plan with absolute file descriptors and no destination DB', () => {
    const f = fixture(); write(f.source, JSON.stringify([sourceRecord()]));
    write(f.manifest, '\ufeff' + JSON.stringify({ version: 1, files: [{ path: 'source.json', profile: 'mem0-array' }], options: base }));
    const output = json<{ planHash: string; readyToApply: boolean }>(['migrate', '--file', 'manifest.json', '--out', 'plan.json'], f.root), saved = JSON.parse(readFileSync(f.plan, 'utf8'));
    expect(output.readyToApply).toBe(true); expect(output.planHash).toMatch(/^[a-f0-9]{64}$/); noDatabase(f);
    expect(saved).toMatchObject({ kind: 'mnemosyne-migration-plan', version: 1, manifestPath: f.manifest, planHash: output.planHash, files: [{ path: f.source }], options: base });
    expect(saved.review.records).toHaveLength(1); expect(saved.review.records[0]).not.toHaveProperty('rawText'); expect(saved.review.records[0]).not.toHaveProperty('text');
    expect(readFileSync(f.plan, 'utf8')).not.toContain('SYNTHETIC_PRIVATE_SOURCE_TEXT'); expect(statSync(f.plan).mode & 0o777).toBe(0o600);
    const before = readFileSync(f.plan); expect(result(['migrate', '--file', f.manifest, '--out', f.plan]).status).toBe(1); expect(readFileSync(f.plan)).toEqual(before);
    expect(readdirSync(f.root).sort()).toEqual(['manifest.json', 'plan.json', 'source.json']);
  });
  it('offers an explicit Mem0 one-file shortcut without guessing ownership or trust', () => {
    const f = fixture(); write(f.source, JSON.stringify([sourceRecord()]));
    const output = json<{ readyToApply: boolean }>(['migrate', '--file', f.source, '--profile', 'mem0-array', '--source-store', 'my-mem0', '--source-owner', 'alice', '--workspace', 'project', '--agent', 'assistant', '--acknowledge-partial', '--out', f.plan]);
    const saved = JSON.parse(readFileSync(f.plan, 'utf8')); expect(output.readyToApply).toBe(true); noDatabase(f);
    expect(saved.options).toMatchObject({ sourceStore: 'my-mem0', sourceOwner: { allowedIds: ['alice'] }, trust: 'untrusted', acknowledgePartial: true });
    expect(saved.options.sourceOwner).not.toHaveProperty('assumeMissing'); expect(saved).not.toHaveProperty('manifestPath'); expect(apply(f).createdCount).toBe(3);
  });
  it('requires the explicit missing-owner assertion for ownerless shortcut records', () => {
    const f = fixture(); write(f.source, JSON.stringify([{ id: 'ownerless', memory: 'Literal imported note.' }]));
    const flags = ['migrate', '--file', f.source, '--profile', 'mem0-array', '--source-store', 'my-mem0', '--source-owner', 'alice', '--workspace', 'project', '--agent', 'assistant', '--acknowledge-partial'];
    const denied = result(flags); expect(denied.status).toBe(2); expect(JSON.parse(denied.stdout).readyToApply).toBe(false); noDatabase(f);
    expect(json<{ readyToApply: boolean }>([...flags, '--assume-missing-owner', '--out', f.plan]).readyToApply).toBe(true);
    expect(JSON.parse(readFileSync(f.plan, 'utf8')).options.sourceOwner.assumeMissing).toBe('alice');
  });
  it.each([
    ['markdown', '\ufeff# Literal Markdown\r\n', ['--logical-path', 'project/notes.md', '--assume-missing-owner']],
    ['letta-blocks', JSON.stringify([{ id: 'block', value: 'Literal block.' }]), ['--assume-missing-owner']],
    ['mnemosyne-memcell-array', JSON.stringify([{ id: 'legacy', text: 'Literal legacy.', agentId: 'alice', memoryType: 'procedural' }]), ['--collection', 'legacy']],
    ['mnemosyne-qdrant-scroll', JSON.stringify({ result: { points: [{ id: 'point', payload: { summary: 'Literal custom field.', agent_id: 'alice' } }], next_page_offset: null } }), ['--collection', 'legacy', '--qdrant-text-field', 'summary']],
    ['mem0-results', JSON.stringify({ results: [sourceRecord()] }), []],
    ['mem0-page', JSON.stringify({ count: 1, next: null, previous: null, results: [sourceRecord()] }), []],
  ] as const)('uses explicit %s shortcut settings and produces an applicable saved plan', (profile, content, extra) => {
    const f = fixture(); write(f.source, content);
    json(['migrate', '--file', f.source, '--profile', profile, '--source-store', 'shortcut-store', '--source-owner', 'alice', '--workspace', 'project', '--agent', 'assistant', '--acknowledge-partial', '--trust', 'observed', '--out', f.plan, ...extra]);
    expect(apply(f).sourceCount).toBe(1);
  });
  it.each([
    ['--source-store', 'store'], ['--profile', 'automatic'], ['--profile', 'mem0-array'], ['--trust', 'verified'],
  ].map(extra => ({ extra })))('rejects incomplete, guessed or elevated shortcut settings %#', ({ extra }) => {
    const f = fixture(); write(f.source, JSON.stringify([sourceRecord()]));
    expect(result(['migrate', '--file', f.source, '--out', f.plan, ...extra]).status).toBe(1); noDatabase(f); expect(existsSync(f.plan)).toBe(false);
  });
  it('does not silently override manifest or saved-plan settings with shortcut flags', () => {
    const f = fixture(); plan(f);
    for (const extra of [['--trust', 'observed'], ['--source-owner', 'bob'], ['--collection', 'different'], ['--workspace', 'wrong']]) expect(result(['migrate', '--file', f.manifest, ...extra]).status).toBe(1);
    expect(result(['migrate', '--action', 'apply', '--file', f.plan, '--db', f.db, '--batch', 'first', '--confirm', '--trust', 'observed']).status).toBe(1);
    expect(result(['migrate', '--action', 'apply', '--file', f.plan, '--db', f.db, '--batch', 'first', '--confirm', '--profile', 'mem0-array']).status).toBe(1); noDatabase(f);
  });
  it('rejects an oversized redacted review before writing an unusable saved plan', () => {
    const f = fixture(), extra = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`unknown_${index}`, 'x']));
    write(f.source, JSON.stringify(Array.from({ length: 700 }, (_, index) => sourceRecord(String(index), 'Literal text.', extra)))); manifest(f);
    const output = result(['migrate', '--file', f.manifest, '--out', f.plan]);
    expect(output.status).toBe(1); expect(output.stderr).toContain('Saved review plan exceeds'); expect(existsSync(f.plan)).toBe(false); noDatabase(f);
  });
});

describe('migration CLI validates before database creation', () => {
  it.each([[], ['--batch', '\ninvalid'], ['--batch', 'x'.repeat(257)]].map(batch => ({ batch })))('requires a valid batch before opening SQLite %#', ({ batch }) => {
    const f = fixture(); plan(f);
    expect(result(['migrate', '--action', 'apply', '--file', f.plan, '--db', f.db, '--confirm', ...batch]).status).toBe(1); noDatabase(f);
  });
  it('rejects changed input bytes and destination scope before opening SQLite', () => {
    const changed = fixture(); plan(changed); write(changed.source, JSON.stringify([sourceRecord('record-one', 'CHANGED_TEXT')]));
    expect(result(['migrate', '--action', 'apply', '--file', changed.plan, '--db', changed.db, '--batch', 'first', '--confirm']).stderr).toContain('changed'); noDatabase(changed);
    const wrong = fixture(); plan(wrong);
    expect(result(['migrate', '--action', 'apply', '--file', wrong.plan, '--db', wrong.db, '--batch', 'first', '--confirm', '--workspace', 'different']).stderr).toContain('scope'); noDatabase(wrong);
    const saved = JSON.parse(readFileSync(wrong.plan, 'utf8')); saved.options.trust = 'observed'; write(wrong.plan, JSON.stringify(saved));
    expect(result(['migrate', '--action', 'apply', '--file', wrong.plan, '--db', wrong.db, '--batch', 'first', '--confirm']).status).toBe(1); noDatabase(wrong);
  });
  it.each([[], ['--confirm', '--read-only'], ['--confirm', '--no-capture']].map(authorization => ({ authorization })))('requires writable explicit capture authorization %#', ({ authorization }) => {
    const f = fixture(); plan(f);
    expect(result(['migrate', '--action', 'apply', '--file', f.plan, '--db', f.db, '--batch', 'first', ...authorization]).status).toBe(1); noDatabase(f);
  });
  it.each([
    ['inspect'], ['source', '--batch', 'first', '--id', 'bad'], ['source', '--batch', 'first', '--id', '0'.repeat(64), '--json', '{"offset":-1}'],
    ['source', '--batch', 'first', '--id', '0'.repeat(64), '--json', '{"offset":0,"offset":1}'],
    ['rollback', '--batch', 'first', '--revision', 'bad', '--confirm'], ['forget', '--id', 'bad', '--confirm'],
  ].map(([action, ...extra]) => ({ action, extra })))('rejects malformed action arguments without creating a DB %#', ({ action, extra }) => {
    const f = fixture(); expect(result(['migrate', '--action', action, ...scope(f), ...extra]).status).toBe(1); noDatabase(f);
  });
  it('rejects malformed, duplicate-key, oversized and unknown manifest configuration without mutation', () => {
    for (const content of ['{', '{"version":1,"version":1}', JSON.stringify({ version: 1, files: [], options: base, provider: 'unsupported' }), ' '.repeat(4 * 1024 * 1024 + 1)]) {
      const f = fixture(); write(f.manifest, content); expect(result(['migrate', '--file', f.manifest, '--out', f.plan]).status).toBe(1); expect(existsSync(f.plan)).toBe(false); noDatabase(f);
    }
    const f = fixture(); write(f.source, JSON.stringify([sourceRecord()])); manifest(f, f.source, { ...base, metadata: { advisory: true } });
    expect(result(['migrate', '--file', f.manifest]).status).toBe(1); noDatabase(f);
  });
  it('rejects manifest/source/saved-plan symlinks, binary input and source directories', () => {
    const f = fixture(); plan(f); const link = join(f.root, 'link.json'); symlinkSync(f.manifest, link);
    expect(result(['migrate', '--file', link]).status).toBe(1); rmSync(link); symlinkSync(f.source, link); manifest(f, link);
    expect(result(['migrate', '--file', f.manifest]).status).toBe(1); rmSync(link); symlinkSync(f.plan, link);
    expect(result(['migrate', '--action', 'apply', '--file', link, '--db', f.db, '--batch', 'first', '--confirm']).status).toBe(1); noDatabase(f);
    manifest(f, f.root); expect(result(['migrate', '--file', f.manifest]).status).toBe(1);
    write(f.source, new Uint8Array([0xff, 0xfe])); manifest(f); expect(result(['migrate', '--file', f.manifest]).status).toBe(1); noDatabase(f);
  });
  it('rejects destination/source/plan aliases and final-component DB symlinks without clobbering files', () => {
    const f = fixture(); plan(f);
    for (const destination of [f.source, f.plan, f.manifest]) {
      const before = readFileSync(destination); expect(result(['migrate', '--action', 'apply', '--file', f.plan, '--db', destination, '--batch', 'first', '--confirm']).status).toBe(1); expect(readFileSync(destination)).toEqual(before);
    }
    symlinkSync(f.source, f.db); const original = readFileSync(f.source);
    expect(result(['migrate', '--action', 'apply', '--file', f.plan, '--db', f.db, '--batch', 'first', '--confirm']).status).toBe(1); expect(readFileSync(f.source)).toEqual(original);
    rmSync(f.db); linkSync(f.source, f.db); expect(result(['migrate', '--action', 'apply', '--file', f.plan, '--db', f.db, '--batch', 'first', '--confirm']).status).toBe(1); expect(readFileSync(f.source)).toEqual(original);
  });
  it.each(['-wal', '-shm'])('protects an explicit source occupying a SQLite %s sidecar path', suffix => {
    const f = fixture(), source = `${f.db}${suffix}`; write(source, JSON.stringify([sourceRecord()])); manifest(f, source);
    json(['migrate', '--file', f.manifest, '--out', f.plan]); const before = readFileSync(source);
    expect(result(['migrate', '--action', 'apply', '--file', f.plan, '--db', f.db, '--batch', 'first', '--confirm']).status).toBe(1); expect(readFileSync(source)).toEqual(before); expect(existsSync(f.db)).toBe(false);
  });
  it.each(['manifest', 'plan'] as const)('protects an original %s occupying an existing DB sidecar path', role => {
    const f = fixture(); initialDatabase(f); write(f.source, JSON.stringify([sourceRecord()]));
    if (role === 'manifest') f.manifest = `${f.db}-wal`; else f.plan = `${f.db}-wal`;
    manifest(f); json(['migrate', '--file', f.manifest, '--out', f.plan]); const target = f[role], before = readFileSync(target);
    expect(result(['migrate', '--action', 'apply', '--file', f.plan, '--db', f.db, '--batch', 'first', '--confirm']).status).toBe(1); expect(readFileSync(target)).toEqual(before);
  });
  it.each(['symlink', 'hardlink'] as const)('refuses an existing SQLite sidecar %s to unrelated data', kind => {
    const f = fixture(); plan(f); initialDatabase(f); const unrelated = join(f.root, 'unrelated.txt'); write(unrelated, 'PRESERVE_ME');
    if (kind === 'symlink') symlinkSync(unrelated, `${f.db}-shm`); else linkSync(unrelated, `${f.db}-shm`);
    expect(result(['migrate', '--action', 'apply', '--file', f.plan, '--db', f.db, '--batch', 'first', '--confirm']).status).toBe(1); expect(readFileSync(unrelated, 'utf8')).toBe('PRESERVE_ME');
  });
});

describe('migration CLI lifecycle', () => {
  it('applies, replays, inspects exact source, rolls back and explicitly applies a fresh batch', () => {
    const f = fixture(), original = '\ufeff# Notes\r\nα 😀 exact\r\n'; write(f.source, original); manifest(f, f.source, base, 'markdown');
    json(['migrate', '--file', f.manifest, '--out', f.plan]); const first = apply(f); expect(first.replay).toBe(false); expect(apply(f)).toEqual({ ...first, replay: true });
    expect(inspect(f).manifestRevision).toBe(first.manifestRevision);
    let restored = '', offset = 0;
    do {
      const page = json<{ text: string; nextOffset?: number }>(['migrate', '--action', 'source', ...scope(f), '--batch', 'first', '--id', first.sources[0].identity, '--json', JSON.stringify({ offset, maxBytes: 8 })]);
      restored += page.text; if (page.nextOffset === undefined) break; offset = page.nextOffset;
    } while (true);
    expect(restored).toBe(original);
    expect(json<{ state: string; deletedCount: number }>(['migrate', '--action', 'rollback', ...scope(f), '--batch', 'first', '--revision', first.manifestRevision, '--confirm'])).toMatchObject({ state: 'rolled-back', deletedCount: 3 });
    expect(inspect(f).state).toBe('rolled-back'); expect(result(['migrate', '--action', 'apply', '--file', f.plan, '--db', f.db, '--batch', 'first', '--confirm']).status).toBe(1);
    expect(apply(f, 'fresh').createdCount).toBe(3);
  });
  it('refuses a guarded rollback after later work and preserves that work', () => {
    const f = fixture(); plan(f, { ...base, trust: 'observed' }); const first = apply(f), memory = createLocalMemory({ path: f.db, workspaceId: 'project', agentId: 'assistant' });
    const source = memory.list({ metadata: { runtimeType: 'source' } }).items[0]; const later = memory.store({ text: 'Later dependent work.', source: { uri: 'fixture:later' }, dependencies: [source.id] }); memory.close();
    expect(result(['migrate', '--action', 'rollback', ...scope(f), '--batch', 'first', '--revision', first.manifestRevision, '--confirm']).stderr).toContain('E_CONFLICT');
    expect(json<{ text: string }>(['inspect', ...scope(f), '--id', later.id]).text).toBe('Later dependent work.'); expect(inspect(f).state).toBe('applied');
  });
  it('forgets raw-only NUL originals permanently and refuses a changed download filename', () => {
    const f = fixture(); write(f.source, 'first\0secret\r\n'); manifest(f, f.source, base, 'markdown'); json(['migrate', '--file', f.manifest, '--out', f.plan]); const first = apply(f);
    expect(first.counts.quarantine).toBe(1);
    expect(json<{ text: string }>(['migrate', '--action', 'source', ...scope(f), '--batch', 'first', '--id', first.sources[0].identity]).text).toBe('first\0secret\r\n');
    expect(json<{ forgotten: boolean }>(['migrate', '--action', 'forget', ...scope(f), '--id', first.sources[0].identity, '--confirm']).forgotten).toBe(true);
    expect(inspect(f).sources[0].state).toBe('forgotten');
    expect(result(['migrate', '--action', 'source', ...scope(f), '--batch', 'first', '--id', first.sources[0].identity]).stderr).toContain('E_FORGOTTEN');
    const renamed = join(f.root, 'new-download.txt'); write(renamed, readFileSync(f.source)); manifest(f, renamed, base, 'markdown'); const newPlan = join(f.root, 'new-plan.json'); json(['migrate', '--file', f.manifest, '--out', newPlan]);
    expect(result(['migrate', '--action', 'apply', '--file', newPlan, '--db', f.db, '--batch', 'new', '--confirm']).stderr).toContain('E_FORGOTTEN');
    const memory = createLocalMemory({ path: f.db, workspaceId: 'project', agentId: 'assistant' }); expect(JSON.stringify(memory.export())).not.toContain('secret'); memory.close();
  });
  it('allows moving the saved plan and deleting its original manifest without changing source selection', () => {
    const f = fixture(); plan(f); const moved = join(f.root, 'moved', 'review.json'); write(moved, readFileSync(f.plan)); rmSync(f.manifest);
    expect(json<Applied>(['migrate', '--action', 'apply', '--file', moved, '--db', f.db, '--batch', 'first', '--confirm']).sourceCount).toBe(1);
  });
});

describe('health CLI uses explicit existing databases and controller checks', () => {
  it.each([
    ['--action', 'typo'], ['--action', 'watch'], ['--action', 'watch', '--id', 'id', '--json', '{}'],
    ['--action', 'check', '--id', 'id', '--json', '{"expectedStateHash":"bad"}'], ['--action', 'recall'],
    ['--action', 'scan'], ['--action', 'recall', '--query', 'fixture'],
    ['--action', 'watch', '--id', 'id', '--json', '{"maxAgeMs":60000}'],
  ].map(extra => ({ extra })))('never creates a DB for invalid or nonexistent health input %#', ({ extra }) => {
    const f = fixture(); expect(result(['health', ...scope(f), ...extra]).status).toBe(1); noDatabase(f);
  });
  it('watches, checks, scans and filters recall using fresh controller-supplied evidence', () => {
    const f = fixture(), stored = json<{ id: string }>(['store', ...scope(f), '--text', 'Fixture operational release source.', '--source', 'fixture:health']);
    expect(json<{ items: unknown[]; modelCalls: number }>(['health', ...scope(f), '--action', 'scan'])).toMatchObject({ items: [], modelCalls: 0 });
    const watched = json<FreshnessAssessment>(['health', ...scope(f), '--action', 'watch', '--id', stored.id, '--json', '{"maxAgeMs":600000,"priority":8}']); expect(watched.status).toBe('needs-check');
    expect(json<{ items: unknown[]; excluded: unknown[] }>(['health', ...scope(f), '--action', 'recall', '--query', 'operational release']).items).toEqual([]);
    const checked = json<FreshnessAssessment>(['health', ...scope(f), '--action', 'check', '--id', stored.id, '--json', JSON.stringify({ expectedStateHash: watched.stateHash, observation: { status: 'confirmed', evidence: 'Synthetic source rechecked unchanged.', verifier: 'fixture-controller' } })]); expect(checked.status).toBe('fresh');
    const scan = json<{ items: FreshnessAssessment[]; modelCalls: number }>(['health', ...scope(f), '--action', 'scan']); expect(scan.items[0].status).toBe('fresh'); expect(scan.modelCalls).toBe(0);
    const recalled = json<{ items: { memory: { id: string } }[]; modelCalls: number }>(['health', ...scope(f), '--action', 'recall', '--query', 'operational release', '--json', '{"requireWatched":true}']); expect(recalled.items[0].memory.id).toBe(stored.id); expect(recalled.modelCalls).toBe(0);
    const changed = json<FreshnessAssessment>(['health', ...scope(f), '--action', 'check', '--id', stored.id, '--json', JSON.stringify({ expectedStateHash: checked.stateHash, observation: { status: 'changed', evidence: 'Synthetic external revision changed.', verifier: 'fixture-controller' } })]); expect(changed.status).toBe('source-changed');
    expect(json<{ items: unknown[] }>(['health', ...scope(f), '--action', 'recall', '--query', 'operational release']).items).toEqual([]);
    expect(json<{ text: string }>(['inspect', ...scope(f), '--id', stored.id]).text).toBe('Fixture operational release source.');
  });
  it('rejects stale checks, privileged JSON overrides and disabled policies without changing health state', () => {
    const f = fixture(), stored = json<{ id: string }>(['store', ...scope(f), '--text', 'Fixture health source.', '--source', 'fixture:health']);
    const watch = json<FreshnessAssessment>(['health', ...scope(f), '--action', 'watch', '--id', stored.id, '--json', '{"maxAgeMs":600000}']);
    const check = ['health', ...scope(f), '--action', 'check', '--id', stored.id, '--json', JSON.stringify({ expectedStateHash: '0'.repeat(64), observation: { status: 'confirmed', evidence: 'Unaccepted.', verifier: 'fixture' } })]; expect(result(check).status).toBe(1);
    for (const extra of [['--read-only'], ['--no-capture'], ['--no-recall']]) expect(result(['health', ...scope(f), '--action', 'watch', '--id', stored.id, '--json', '{"maxAgeMs":600000}', ...extra]).status).toBe(1);
    expect(result(['health', ...scope(f), '--action', 'watch', '--id', stored.id, '--json', '{"maxAgeMs":600000,"memoryId":"override"}']).status).toBe(1);
    expect(result(['health', ...scope(f), '--action', 'recall', '--query', 'health', '--json', '{"query":"override"}']).status).toBe(1);
    expect(result(['health', ...scope(f), '--action', 'scan', '--provider-config', 'not-selected.json']).status).toBe(1);
    const scanned = json<{ items: FreshnessAssessment[] }>(['health', ...scope(f), '--action', 'scan']); expect(scanned.items[0].stateHash).toBe(watch.stateHash);
  });
});
