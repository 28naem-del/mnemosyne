import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';

/**
 * `cacheSize` sets `PRAGMA cache_size`, a per-connection setting SQLite never
 * persists to the file — so unlike `user_version`, it cannot be observed by
 * reopening the database with a raw connection. It is asserted the same way
 * the rest of this engine's PRAGMA setup is exercised in `local-memory.test.ts`
 * (a spy on the actual pragma statement executed at open), which is also
 * the only way to prove the *value* reaching SQLite, not just that
 * `LocalMemory` accepted the option.
 */
const opened: LocalMemory[] = [];
afterEach(() => { vi.restoreAllMocks(); opened.splice(0).forEach(db => db.close()); });

function execCalls(): { calls: () => string[] } {
  const exec = DatabaseSync.prototype.exec; const seen: string[] = [];
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function(this: DatabaseSync, sql: string) {
    if (sql.includes('cache_size')) seen.push(sql);
    return exec.call(this, sql);
  });
  return { calls: () => seen };
}

describe('cacheSize (PRAGMA cache_size)', () => {
  it('defaults to -65536 (64 MiB, SQLite\'s KiB-budget convention) when unset', () => {
    const probe = execCalls();
    opened.push(createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical' }));
    expect(probe.calls()).toHaveLength(1);
    expect(probe.calls()[0]).toMatch(/PRAGMA cache_size=-65536;/);
  });

  it('passes an explicit positive value (a page count) straight through', () => {
    const probe = execCalls();
    opened.push(createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', cacheSize: 131072 }));
    expect(probe.calls()[0]).toMatch(/PRAGMA cache_size=131072;/);
  });

  it('passes an explicit negative value (a KiB budget) straight through', () => {
    const probe = execCalls();
    opened.push(createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', cacheSize: -131072 }));
    expect(probe.calls()[0]).toMatch(/PRAGMA cache_size=-131072;/);
  });

  it('applies the pragma on every open, not just the first', () => {
    const root = createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', cacheSize: 4096 });
    root.close();
    const probe = execCalls();
    opened.push(createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', cacheSize: 4096 }));
    expect(probe.calls()[0]).toMatch(/PRAGMA cache_size=4096;/);
  });

  it('rejects zero, non-integers, and magnitudes past the bound, without opening the database', () => {
    const bad = [0, 1.5, NaN, Infinity, 524_289, -2_097_153];
    for (const cacheSize of bad) {
      expect(() => createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', cacheSize })).toThrow('cacheSize');
    }
  });

  /**
   * The bound is 2 GiB, but `cache_size` encodes its unit in the sign, so a
   * single `Math.abs()` test cannot express that: 2_097_152 as a KiB budget is
   * 2 GiB, while the same magnitude as a *page count* is 2_097_152 * page_size
   * — 8 GiB at SQLite's 4 KiB default, four times the documented ceiling. The
   * positive boundary therefore tightened from 2_097_152 to 524_288; the
   * negative one is unchanged. Both signs are pinned here, on both sides.
   */
  it('bounds each sign in its own unit: 524288 pages and 2097152 KiB are both 2 GiB', () => {
    opened.push(createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', cacheSize: 524_288 }));
    opened.push(createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', cacheSize: -2_097_152 }));
    // One past each boundary, in each unit.
    expect(() => createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', cacheSize: 524_289 })).toThrow('cacheSize');
    expect(() => createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', cacheSize: -2_097_153 })).toThrow('cacheSize');
    // The old positive ceiling: accepted before this fix, 8 GiB of pages.
    expect(() => createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', cacheSize: 2_097_152 })).toThrow('cacheSize');
  });

  it('states both units and both ceilings in the error it throws', () => {
    expect(() => createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', cacheSize: 2_097_152 }))
      .toThrow(/positive = pages, at most 524288; negative = KiB, at most 2097152 in magnitude/);
  });

  it('opens at the default page size the page-count ceiling is derived from', () => {
    // 524288 pages is 2 GiB only while a page is 4 KiB. This engine sets no
    // `PRAGMA page_size`, so if that default ever moved the ceiling would mean
    // a different number of bytes and this test is the tripwire.
    const db = new DatabaseSync(':memory:');
    expect((db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size).toBe(4096);
    db.close();
  });

  it('rejects an unknown option the same way it always has, and still accepts cacheSize', () => {
    expect(() => createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', notAnOption: true } as never)).toThrow('Unknown options field');
    opened.push(createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', cacheSize: -8192 }));
  });
});
