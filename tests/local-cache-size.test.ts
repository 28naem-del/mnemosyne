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
    const bad = [0, 1.5, NaN, Infinity, 2_097_153, -2_097_153];
    for (const cacheSize of bad) {
      expect(() => createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', cacheSize })).toThrow('cacheSize');
    }
  });

  it('accepts the boundary magnitude in both directions', () => {
    opened.push(createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', cacheSize: 2_097_152 }));
    opened.push(createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', cacheSize: -2_097_152 }));
  });

  it('rejects an unknown option the same way it always has, and still accepts cacheSize', () => {
    expect(() => createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', notAnOption: true } as never)).toThrow('Unknown options field');
    opened.push(createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', cacheSize: -8192 }));
  });
});
