import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory, type StoreMemoryInput } from '../src/local/index.js';

const opened: LocalMemory[] = []; const roots: string[] = [];
function memory(path = ':memory:', agentId = 'alice', workspaceId = 'project', now?: () => Date) {
  const db = createLocalMemory({ path, agentId, workspaceId, now }); opened.push(db); return db;
}
const fact = (text: string, input: Partial<StoreMemoryInput> = {}): StoreMemoryInput => ({ text, trust: 'observed', source: { uri: 'test:postings' }, ...input });
afterEach(() => { vi.restoreAllMocks(); opened.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('posting-driven lexical retrieval regression', () => {
  it('uses indexed term matches before record hydration for rare and broad queries, without a workspace scan', () => {
    const db = memory(); const expected = db.store(fact('NeedleIdentifier approval'));
    db.atomic(() => { for (let index = 0; index < 5000; index++) db.store(fact(`Ordinary catalogue approval record ${index}`)); });
    const prepare = DatabaseSync.prototype.prepare; const plans: string[][] = [];
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (sql.includes('SELECT data,successes,failures,lexical')) {
        const all = statement.all.bind(statement);
        statement.all = ((...args: SQLInputValue[]) => {
          const plan = prepare.call(this, `EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[];
          plans.push(plan.map(row => row.detail)); return all(...args);
        }) as typeof statement.all;
      }
      return statement;
    });
    expect(db.recall({ query: 'NeedleIdentifier' }).map(result => result.memory.id)).toEqual([expected.id]);
    expect(db.recall({ query: 'catalogue approval', limit: 5 })).toHaveLength(5);
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan.some(step => step.includes('local_terms_term') && step.includes('(term=?)'))).toBe(true);
      expect(plan.some(step => /SEARCH m .*\(id=\?\)/.test(step))).toBe(true);
      expect(plan.some(step => /SCAN m\b|SEARCH m USING INDEX memories_page/.test(step))).toBe(false);
    }
  });

  it('keeps visible scores, token coverage and candidate limits independent of private/foreign postings', () => {
    const root = mkdtempSync(join(tmpdir(), 'mnemosyne-posting-scope-')); roots.push(root); const path = join(root, 'memory.db');
    const db = memory(path); const winner = db.store(fact('Café release APPROVAL'));
    const partial = db.store(fact('Release and additional descriptive words'));
    db.store(fact('café release approval', { metadata: { advisory: false } }));
    const initial = db.recall({ query: 'cafe release approval', limit: 10 });
    expect(initial.map(result => result.memory.id)).toEqual([winner.id, partial.id]);
    expect(initial[0].score).toBeCloseTo(2 / (1 + Math.log1p(3) * 0.1), 12);
    expect(initial[1].score).toBeCloseTo((1 + 1 / 3) / (1 + Math.log1p(5) * 0.1), 12);
    const bob = memory(path, 'bob'), other = memory(path, 'alice', 'other');
    bob.atomic(() => { for (let i = 0; i < 300; i++) bob.store(fact(`Café release APPROVAL ${i}`)); });
    other.store(fact('Café release APPROVAL', { visibility: 'workspace' }));
    expect(db.recall({ query: 'cafe release approval', limit: 10 })).toEqual(initial);
    expect(db.recall({ query: 'cafe release approval', limit: 1, maxCandidates: 1 }).map(result => result.memory.id)).toEqual([winner.id]);
    const untrusted = db.store(fact('Café release APPROVAL', { trust: 'untrusted', kind: 'decision' }));
    expect(db.recall({ query: 'approval', kinds: ['decision'] })).toEqual([]);
    expect(db.recall({ query: 'approval', kinds: ['decision'], includeUntrusted: true }).map(result => result.memory.id)).toEqual([untrusted.id]);
  });

  it('preserves two-clock correction visibility, outcome time and derived-source invalidation', () => {
    let day = 2; const date = (value: number) => `2026-09-${String(value).padStart(2, '0')}T00:00:00.000Z`;
    const db = memory(':memory:', 'alice', 'project', () => new Date(date(day)));
    const original = db.store(fact('ReleaseIdentifier first condition', { validFrom: date(1) }));
    const derived = db.store(fact('ReleaseIdentifier derived recommendation', { dependencies: [original.id] }));
    day = 8;
    const revised = db.correct(original.id, { text: 'ReleaseIdentifier revised condition', source: { uri: 'test:revision' }, reason: 'Late correction', validFrom: date(5) });
    expect(db.recall({ query: 'ReleaseIdentifier', asOf: date(6), knownAt: date(7) }).map(result => result.memory.id).sort()).toEqual([original.id, derived.id].sort());
    expect(db.recall({ query: 'ReleaseIdentifier', asOf: date(6), knownAt: date(8) }).map(result => result.memory.id)).toEqual([revised.id]);
    expect(db.recall({ query: 'ReleaseIdentifier', asOf: date(3), knownAt: date(8) }).map(result => result.memory.id)).toEqual([original.id]);
    expect(db.compile({ query: 'ReleaseIdentifier', maxTokens: 4096 }).items.map(item => item.id)).toEqual([revised.id]);
    day = 9; db.recordOutcome({ memoryId: revised.id, success: false, evidence: 'Explicit failing replay', verifier: 'test', taskId: 'trial' });
    expect(db.recall({ query: 'ReleaseIdentifier', knownAt: date(8) })[0].outcomes.failures).toBe(0);
    expect(db.recall({ query: 'ReleaseIdentifier' })[0].outcomes.failures).toBe(1);
    expect(db.compile({ query: 'ReleaseIdentifier', maxTokens: 4096 }).items).toEqual([]);
  });
});
