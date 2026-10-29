import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { bisect, exactOracle, type BisectTask } from '../src/local/bisect.js';
import type { LocalMemoryOptions } from '../src/local/types.js';

/**
 * Sol S03: Oracle B must re-execute the store's own retriever. A snapshot does
 * not carry the instance precision defaults (`requireNamedMatch`, `minScores`,
 * `fuzzy`) and `retrieval` does not report them, so a default rebuild used to
 * drop them and answer a different question while calling itself exact. The
 * rebuild now has to reproduce the source's own unablated ranking before any
 * ablation is judged; when it cannot, bisect throws instead of answering.
 * Fixtures are synthetic.
 */

const opened: LocalMemory[] = [];
afterEach(() => { opened.splice(0).forEach(memory => memory.close()); });
const source = { uri: 'test://bisect-parity' };

function open(options: Partial<LocalMemoryOptions>): LocalMemory {
  const memory = createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', ...options });
  opened.push(memory);
  return memory;
}

describe('bisect Oracle B keeps the source precision defaults', () => {
  it('refuses, rather than passing, when the rebuild drops requireNamedMatch (audit fixture)', () => {
    const memory = open({ requireNamedMatch: 'auto' });
    const gold = memory.store({ text: 'Orion service port 8443.', kind: 'fact', trust: 'observed', source, metadata: { names: ['Orion'] } });
    // The source's own retriever: the record declares a name the query does not use, so it is not returned.
    expect(memory.recall({ query: 'service port', limit: 1 })).toHaveLength(0);
    const task: BisectTask = { id: 'precision-default', query: 'service port', k: 1, gold: [gold.id] };
    // Before the fix the default rebuild had no names gate and answered `true`
    // with nothing removed: "exact" said the task passes on a store where it fails.
    expect(() => exactOracle(memory, task)(new Set())).toThrow(/cannot reproduce the store's retrieval/);
    // With the same default supplied, Oracle B is the source's retriever again.
    expect(exactOracle(memory, task, { storeOptions: { requireNamedMatch: 'auto' } })(new Set())).toBe(false);
  });

  it('refuses when the rebuild drops the score floors', () => {
    const memory = open({ minScores: { finalRelative: 0.9 } });
    memory.store({ text: 'Harbour crane schedule: harbour crane maintenance on the harbour crane.', trust: 'observed', source });
    const weak = memory.store({ text: 'The harbour office opens at nine.', trust: 'observed', source });
    const task: BisectTask = { id: 'floors', query: 'harbour crane', k: 2, gold: [weak.id] };
    expect(memory.recall({ query: task.query, limit: 2 }).map(hit => hit.memory.id)).not.toContain(weak.id);
    expect(() => exactOracle(memory, task)(new Set())).toThrow(/cannot reproduce the store's retrieval/);
    expect(exactOracle(memory, task, { storeOptions: { minScores: { finalRelative: 0.9 } } })(new Set())).toBe(false);
  });

  it('refuses when the rebuild drops fuzzy matching', () => {
    const memory = open({ fuzzy: true });
    const gold = memory.store({ text: 'The gateway timeout is ninety seconds.', trust: 'observed', source });
    const task: BisectTask = { id: 'fuzzy', query: 'gatway', k: 1, gold: [gold.id] };
    expect(memory.recall({ query: task.query, limit: 1 }).map(hit => hit.memory.id)).toEqual([gold.id]);
    expect(() => exactOracle(memory, task)(new Set())).toThrow(/cannot reproduce the store's retrieval/);
    expect(exactOracle(memory, task, { storeOptions: { fuzzy: true } })(new Set())).toBe(true);
  });

  it('does not report a cheap-oracle blame set as unconfirmed by a different retriever', () => {
    const memory = open({ requireNamedMatch: 'auto' });
    const gold = memory.store({ text: 'The service port is 8443.', trust: 'observed', source });
    const d1 = memory.store({ text: 'service port service port service port notes', trust: 'observed', source });
    const d2 = memory.store({ text: 'service port service port configuration', trust: 'observed', source });
    // Gated out by the source (it declares a name the query does not use); a rebuild without the gate ranks it first.
    memory.store({ text: 'service port service port service port service port', trust: 'observed', source, metadata: { names: ['Orion'] } });
    const task: BisectTask = { id: 'gated', query: 'service port', k: 1, gold: [gold.id] };
    const ranked = memory.recall({ query: task.query, limit: 10 }).map(hit => hit.memory.id);
    expect(ranked.slice(0, 3)).toEqual([d1.id, d2.id, gold.id]);

    // Before the fix this came back `unconfirmed` / `blame-not-confirmed`: the
    // rebuild ran without the names gate, so the gated record outranked the
    // gold and "exact re-execution" rejected a correct blame set.
    expect(() => bisect(memory, task)).toThrow(/cannot reproduce the store's retrieval/);

    const result = bisect(memory, task, { storeOptions: { requireNamedMatch: 'auto' } });
    expect(result.outcome).toBe('blamed');
    expect([...result.blame].sort()).toEqual([d1.id, d2.id].sort());
    expect(result.exactConfirmed).toBe(true);
  });

  it('still bisects a store with no precision defaults exactly as before', () => {
    const memory = open({});
    const gold = memory.store({ text: 'The service port is 8443.', trust: 'observed', source });
    const d1 = memory.store({ text: 'service port service port service port notes', trust: 'observed', source });
    const task: BisectTask = { id: 'plain', query: 'service port', k: 1, gold: [gold.id] };
    const result = bisect(memory, task);
    expect(result.outcome).toBe('blamed');
    expect(result.blame).toEqual([d1.id]);
    expect(result.exactConfirmed).toBe(true);
  });
});
