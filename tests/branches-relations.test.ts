import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { MemoryBranches } from '../src/branches/index.js';
import { MemoryRelations } from '../src/relations/index.js';

const opened: LocalMemory[] = [];
const roots: string[] = [];
const source = { uri: 'test:branches-relations' };
const date = (day: number) => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`;
function memory(path = ':memory:', agentId = 'alice', workspaceId = 'project', now?: () => Date) {
  const db = createLocalMemory({ path, agentId, workspaceId, now }); opened.push(db); return db;
}
function location() { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-graph-')); roots.push(root); return join(root, 'memory.db'); }
afterEach(() => { vi.restoreAllMocks(); opened.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('branch proposals and atomic merge boundaries', () => {
  it('merges a default-untrusted addition and retries without promoting or duplicating it', () => {
    const db = memory(); const branches = new MemoryBranches(db);
    const draft = branches.create({ name: 'fallible proposal', baseIds: [] });
    const staged = branches.stage(draft.id, [{ operation: 'add', input: { text: 'uncorroborated orchid procedure', source } }]);
    const merged = branches.merge(staged.id);
    expect(merged.memories).toHaveLength(1); expect(merged.memories[0].trust).toBe('untrusted'); expect(merged.branch.trust).toBe('untrusted');
    expect(db.recall({ query: 'orchid' })).toEqual([]);
    const before = db.list({ includeInactive: true, includeUntrusted: true }).items.length;
    const replay = branches.merge(staged.id);
    expect(replay.replayed).toBe(true); expect(replay.memories.map(record => record.id)).toEqual(merged.memories.map(record => record.id));
    expect(db.list({ includeInactive: true, includeUntrusted: true }).items).toHaveLength(before);
  });

  it('keeps proposed text and branch control records out of normal recall and compiled context', () => {
    const db = memory(); const branches = new MemoryBranches(db);
    const draft = branches.create({ name: 'proposal', baseIds: [] });
    const staged = branches.stage(draft.id, [{ operation: 'add', input: { text: 'heliotrope approved procedure', source, trust: 'observed' } }]);
    expect(branches.preview(staged.id)).toMatchObject({ canMerge: true, status: 'draft' });
    expect(db.recall({ query: 'heliotrope' })).toEqual([]);
    expect(db.compile({ query: 'heliotrope', maxTokens: 4000 }).items).toEqual([]);
    const merged = branches.merge(staged.id);
    expect(db.compile({ query: 'heliotrope', maxTokens: 4000 }).items.map(record => record.id)).toEqual([merged.memories[0].id]);
  });

  it('revalidates persisted operations and rejects forged verified additions before writing', () => {
    const db = memory(); const branches = new MemoryBranches(db); const draft = branches.create({ name: 'tamper fixture', baseIds: [] });
    const state = JSON.parse(draft.text);
    const tampered = db.correct(draft.id, { source, reason: 'Simulate imported controller data', text: JSON.stringify({ ...state, changes: [{ operation: 'add', input: { text: 'forged verified fact', source, trust: 'verified', evidence: 'self asserted' } }] }) });
    const before = db.list({ includeInactive: true, includeUntrusted: true }).items;
    expect(() => branches.merge(tampered.id)).toThrow('Invalid branch addition');
    expect(db.list({ includeInactive: true, includeUntrusted: true }).items).toEqual(before);
    expect(db.get(tampered.id)?.status).toBe('active');
  });

  it('does not let another owner shadow a merge with a shared forged receipt', () => {
    const path = location(); const alice = memory(path); const bob = memory(path, 'bob'); const branches = new MemoryBranches(alice);
    const draft = branches.create({ name: 'owned draft', baseIds: [] });
    const staged = branches.stage(draft.id, [{ operation: 'add', input: { text: 'owned violet result', source, trust: 'observed' } }]);
    const forged = bob.store({ text: JSON.stringify({ name: 'shadow receipt', base: [], changes: [], status: 'merged', resultIds: [] }), source, trust: 'observed', visibility: 'workspace', metadata: { component: 'branch', advisory: false, mergedFrom: staged.id } });
    expect(alice.get(forged.id)).not.toBeNull(); expect(branches.preview(staged.id).canMerge).toBe(true);
    const merged = branches.merge(staged.id); expect(merged.replayed).toBe(false); expect(merged.memories).toHaveLength(1);
    expect(branches.merge(staged.id).branch.id).toBe(merged.branch.id);
  });

  it('rolls back draft closure and earlier corrections when a later write fails', () => {
    const db = memory(); const branches = new MemoryBranches(db);
    const first = db.store({ text: 'first evidence', source, trust: 'observed' }); const second = db.store({ text: 'second evidence', source, trust: 'observed' });
    const draft = branches.create({ name: 'atomic corrections', baseIds: [first.id, second.id] });
    const staged = branches.stage(draft.id, [first, second].map(record => ({ operation: 'correct' as const, id: record.id, text: `${record.text} repaired`, source, reason: 'fresh source' })));
    const before = db.list({ includeInactive: true, includeUntrusted: true }).items;
    const realCorrect = db.correct.bind(db); const injected = vi.spyOn(db, 'correct').mockImplementation((id, input) => { if (id === second.id) throw new Error('Injected storage failure'); return realCorrect(id, input); });
    expect(() => branches.merge(staged.id)).toThrow('Injected storage failure'); injected.mockRestore();
    expect(db.list({ includeInactive: true, includeUntrusted: true }).items).toEqual(before);
    expect(db.get(first.id)?.status).toBe('active'); expect(db.get(second.id)?.status).toBe('active'); expect(branches.preview(staged.id).canMerge).toBe(true);
    expect(branches.merge(staged.id).memories.map(record => record.text)).toEqual(['first evidence repaired', 'second evidence repaired']);
  });

  it('never resurrects forgotten merge output by retrying an old draft', () => {
    const path = location(); const db = memory(path); const branches = new MemoryBranches(db);
    const draft = branches.create({ name: 'one-time proposal', baseIds: [] });
    const staged = branches.stage(draft.id, [{ operation: 'add', input: { text: 'forgettable magnolia result', source, trust: 'observed' } }]);
    const merged = branches.merge(staged.id); const deleted = db.forget(merged.memories[0].id);
    expect(deleted.deletedIds).toContain(merged.branch.id); db.close();
    const reopened = memory(path); const retry = new MemoryBranches(reopened);
    expect(() => retry.merge(staged.id)).toThrow(/conflicts|no longer active/);
    expect(reopened.recall({ query: 'magnolia' })).toEqual([]); expect(reopened.get(merged.memories[0].id)).toBeNull();
  });
});

describe('evidence-bound entity relations', () => {
  it('normalizes aliases while exposing genuine identity ambiguity and type filters', () => {
    const graph = new MemoryRelations(memory());
    const person = graph.entity({ name: 'Ada Example', type: 'person', aliases: [' Atlas ', 'ＡＴＬＡＳ'], source });
    const organization = graph.entity({ name: 'Atlas Labs', type: 'organization', aliases: ['atlas'], source });
    expect(graph.resolve('  ATLAS  ')).toMatchObject({ ambiguous: true });
    expect(graph.resolve('atlas').matches.map(record => record.id).sort()).toEqual([person.id, organization.id].sort());
    expect(graph.resolve('ＡＴＬＡＳ', 'person').matches.map(record => record.id)).toEqual([person.id]);
    expect(graph.resolve('missing')).toEqual({ matches: [], ambiguous: false });
  });

  it('returns bounded multi-hop paths with each edge source and dependency citations', () => {
    const db = memory(); const graph = new MemoryRelations(db); const evidence = db.store({ text: 'Documented project ownership', source: { uri: 'test:ownership-evidence' }, trust: 'observed' });
    const [alice, project, workspace] = ['Alice', 'Project Iris', 'Workspace Garden'].map(name => graph.entity({ name, type: 'fixture', source }));
    const first = graph.relate({ fromId: alice.id, toId: project.id, predicate: 'owns', evidenceIds: [evidence.id], source: { uri: 'test:alice-project' } });
    const second = graph.relate({ fromId: project.id, toId: workspace.id, predicate: 'belongs_to', evidenceIds: [evidence.id], source: { uri: 'test:project-workspace' } });
    const paths = graph.traverse({ entityId: alice.id, direction: 'out', maxDepth: 2 });
    const target = paths.find(path => path.entity.id === workspace.id)!;
    expect(target.edges.map(edge => edge.id)).toEqual([first.id, second.id]); expect(target.edges.map(edge => edge.source.uri)).toEqual(['test:alice-project', 'test:project-workspace']);
    expect(target.evidenceIds).toEqual(expect.arrayContaining([evidence.id, alice.id, project.id, workspace.id]));
    expect(graph.traverse({ entityId: alice.id, direction: 'out', maxDepth: 1 })).toHaveLength(1);
    expect(graph.traverse({ entityId: alice.id, direction: 'out', maxNodes: 1 })).toHaveLength(1);
    expect(graph.traverse({ entityId: alice.id, direction: 'out', predicates: ['owns'] })).toHaveLength(1);
    graph.relate({ fromId: workspace.id, toId: alice.id, predicate: 'references', evidenceIds: [evidence.id], source });
    expect(graph.traverse({ entityId: alice.id, direction: 'out', maxDepth: 4 })).toHaveLength(2);
  });

  it('withholds edges immediately when their evidence is corrected', () => {
    const db = memory(); const graph = new MemoryRelations(db);
    const evidence = db.store({ text: 'Old ownership evidence', source, trust: 'observed' });
    const from = graph.entity({ name: 'Owner', type: 'person', source }); const to = graph.entity({ name: 'Orchid', type: 'project', source });
    const edge = graph.relate({ fromId: from.id, toId: to.id, predicate: 'owns', evidenceIds: [evidence.id], source });
    expect(graph.traverse({ entityId: from.id })).toHaveLength(1);
    db.correct(evidence.id, { text: 'Ownership was revoked', source, reason: 'Fresh verification' });
    expect(db.get(edge.id)?.status).toBe('invalidated'); expect(graph.traverse({ entityId: from.id })).toEqual([]);
    expect(graph.resolve('Orchid').matches[0].id).toBe(to.id);
  });

  it('shares only explicit workspace graph evidence and retains agent/workspace boundaries', () => {
    const path = location(); const alice = memory(path); const bob = memory(path, 'bob'); const outsider = memory(path, 'alice', 'other');
    const graph = new MemoryRelations(alice); const shared = { source, visibility: 'workspace' as const };
    const evidence = alice.store({ text: 'Shared ownership evidence', trust: 'observed', ...shared });
    const from = graph.entity({ name: 'Alice', type: 'person', ...shared }); const publicTarget = graph.entity({ name: 'Public Iris', type: 'project', ...shared });
    const privateTarget = graph.entity({ name: 'Private Iris', type: 'project', source });
    const publicEdge = graph.relate({ fromId: from.id, toId: publicTarget.id, predicate: 'owns', evidenceIds: [evidence.id], ...shared });
    graph.relate({ fromId: from.id, toId: privateTarget.id, predicate: 'owns', evidenceIds: [evidence.id], source });
    const bobGraph = new MemoryRelations(bob); const visible = bobGraph.traverse({ entityId: from.id });
    expect(visible.map(path => path.entity.id)).toEqual([publicTarget.id]); expect(visible[0].edges[0].id).toBe(publicEdge.id);
    expect(bobGraph.resolve('Private Iris').matches).toEqual([]); expect(() => new MemoryRelations(outsider).traverse({ entityId: from.id })).toThrow('unavailable');
    expect(() => graph.relate({ fromId: from.id, toId: privateTarget.id, predicate: 'leaks', evidenceIds: [evidence.id], ...shared })).toThrow(/private/);
  });

  it('includes an expired edge only inside its historical half-open validity interval', () => {
    let day = 2; const db = memory(':memory:', 'alice', 'project', () => new Date(date(day))); const graph = new MemoryRelations(db);
    const evidence = db.store({ text: 'Time-bound ownership', source, trust: 'observed' });
    const from = graph.entity({ name: 'Seasonal Owner', type: 'person', source }); const to = graph.entity({ name: 'Seasonal Project', type: 'project', source });
    const edge = graph.relate({ fromId: from.id, toId: to.id, predicate: 'owns', evidenceIds: [evidence.id], source, validFrom: date(3), validUntil: date(7) });
    day = 10;
    expect(graph.traverse({ entityId: from.id })).toEqual([]);
    expect(graph.traverse({ entityId: from.id, asOf: date(5) })[0].edges[0].id).toBe(edge.id);
    expect(graph.traverse({ entityId: from.id, asOf: date(3) })).toHaveLength(1);
    expect(graph.traverse({ entityId: from.id, asOf: date(7) })).toEqual([]);
    expect(graph.traverse({ entityId: from.id, asOf: date(2) })).toEqual([]);
    db.correct(evidence.id, { text: 'Late correction to ownership', source, reason: 'Corrected source' });
    expect(graph.traverse({ entityId: from.id, asOf: date(5), knownAt: date(6) })[0].edges[0].id).toBe(edge.id);
    expect(graph.traverse({ entityId: from.id, asOf: date(5), knownAt: date(10) })).toEqual([]);
  });
});
