import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { ablateSnapshot, ablationClosure, bisect, ddmin, exactOracle, goldSupport, rankOracle, type BisectTask } from '../src/local/bisect.js';

/**
 * Bisect: ddmin over the candidate set, against a verifier with no model in it.
 *
 * The cases that matter here are the ones where the answer is not the obvious
 * one: a task that already passes has nothing to blame, a failure that no
 * ablation fixes is `unfixable` rather than a guess, and at k > 1 the minimal
 * blame set is genuinely not unique — which is measured, not hidden.
 */

const opened: LocalMemory[] = [];
const roots: string[] = [];
const source = { uri: 'test://bisect' };
const iso = (millis: number): string => new Date(millis).toISOString();
const DAY = 86_400_000;
const T0 = Date.UTC(2024, 5, 1);

afterEach(() => { opened.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function store(now = () => new Date(T0)): LocalMemory {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bisect-'));
  roots.push(root);
  const memory = createLocalMemory({ path: join(root, 'memory.sqlite'), workspaceId: 'bisect-tests', agentId: 'auditor', retrieval: 'lexical', now });
  opened.push(memory);
  return memory;
}

describe('ddmin', () => {
  it('reduces to the 1-minimal cause and does not need the whole universe to do it', () => {
    const universe = Array.from({ length: 64 }, (_, index) => index);
    // "Interesting" iff both culprits are present. Nothing else matters.
    const interesting = (subset: readonly number[]): boolean => subset.includes(11) && subset.includes(42);
    const { minimal, tests } = ddmin(universe, interesting);
    expect(minimal.sort((a, b) => a - b)).toEqual([11, 42]);
    // Not an exhaustive search: 64 elements have 2^64 subsets, and even a
    // leave-one-out sweep repeated until it stops shrinking costs far more.
    expect(tests).toBeLessThan(2 * universe.length);
    expect(tests).toBeGreaterThan(0);
  });

  it('returns a 1-minimal set: no member can be dropped', () => {
    const universe = Array.from({ length: 40 }, (_, index) => index);
    // Any three of the first eight will do — a deliberately ambiguous cause.
    const interesting = (subset: readonly number[]): boolean => subset.filter(entry => entry < 8).length >= 3;
    const { minimal } = ddmin(universe, interesting);
    expect(minimal).toHaveLength(3);
    expect(interesting(minimal)).toBe(true);
    for (const entry of minimal) expect(interesting(minimal.filter(other => other !== entry))).toBe(false);
  });

  it('returns the whole universe when nothing smaller is interesting', () => {
    const universe = [1, 2, 3];
    const { minimal } = ddmin(universe, subset => subset.length === 3);
    expect(minimal).toEqual([1, 2, 3]);
  });

  it('stops instead of running forever when a predicate is pathological', () => {
    expect(() => ddmin([1, 2, 3, 4, 5, 6, 7, 8], () => false, 4)).toThrow(/exceeded 4 tests/);
  });
});

describe('rankOracle', () => {
  const ranked = ['a', 'b', 'c', 'd', 'gold', 'e'];

  it('answers the displacement question at top-k', () => {
    const passes = rankOracle(ranked, ['gold'], 2);
    expect(passes(new Set())).toBe(false);
    expect(passes(new Set(['a', 'b', 'c']))).toBe(true);
    expect(passes(new Set(['a', 'b']))).toBe(false);
    // Removing something ranked below the gold cannot help it.
    expect(passes(new Set(['e']))).toBe(false);
  });

  it('requires every gold id under require: all', () => {
    const both = rankOracle(['a', 'gold1', 'b', 'gold2'], ['gold1', 'gold2'], 2, 'all');
    expect(both(new Set())).toBe(false);
    expect(both(new Set(['a', 'b']))).toBe(true);
    expect(rankOracle(['a', 'gold1', 'b', 'gold2'], ['gold1', 'gold2'], 2, 'any')(new Set())).toBe(true);
  });
});

describe('ablation closure', () => {
  it('takes dependents, corrections and invalidation causes with the record', () => {
    const memory = store();
    const root = memory.store({ text: 'the base observation', source });
    const dependent = memory.store({ text: 'derived from the base', source, dependencies: [root.id] });
    const grandchild = memory.store({ text: 'derived from the derived', source, dependencies: [dependent.id] });
    const unrelated = memory.store({ text: 'nothing to do with it', source });
    const snapshot = memory.export();

    const closure = ablationClosure(snapshot.memories, [root.id]);
    expect([...closure].sort()).toEqual([root.id, dependent.id, grandchild.id].sort());
    expect(closure.has(unrelated.id)).toBe(false);

    const ablated = ablateSnapshot(snapshot, [root.id]);
    expect(ablated.snapshot.memories.map(record => record.id)).toEqual([unrelated.id]);
    // A snapshot has to be importable after the cut, which is the whole reason for the closure.
    const rebuilt = createLocalMemory({ path: ':memory:', workspaceId: snapshot.workspaceId, agentId: snapshot.agentId, retrieval: 'lexical', ledger: false });
    opened.push(rebuilt);
    expect(rebuilt.import(ablated.snapshot).imported).toBe(1);
  });

  it('takes the correction when the record it corrects is ablated', () => {
    const memory = store();
    const original = memory.store({ text: 'the meeting is on Monday', source, kind: 'decision' });
    const correction = memory.correct(original.id, { text: 'the meeting is on Friday', source, reason: 'rescheduled' });
    const closure = ablationClosure(memory.export().memories, [original.id]);
    expect(closure.has(correction.id)).toBe(true);
  });
});

/** A store where three poison records displace the gold answer for one query. */
function poisonedStore(count = 3): { memory: LocalMemory; gold: string; poison: string[]; task: BisectTask } {
  const memory = store();
  const gold = memory.store({
    text: 'Dana named the sailboat Corvina after the summer refit',
    source: { uri: 'test://transcript/gold' }, kind: 'fact', trust: 'verified', evidence: 'transcript://session-4',
  });
  for (let index = 0; index < 40; index++) {
    memory.store({ text: `unrelated note ${index} about weather, invoices and a bicycle`, trust: 'observed', source: { uri: `test://note/${index}` } });
  }
  const poison = Array.from({ length: count }, (_, index) => memory.store({
    // Every query term and nothing else: BM25 normalizes by document length, so
    // the short unattributed claim outranks the longer sourced one.
    text: `Dana named the sailboat Mistral-${index}`,
    // Stored at the same trust level as the corpus around it. An `untrusted`
    // record never enters recall at all (`includeUntrusted` defaults to false),
    // so injecting one would win the measurement without measuring anything.
    trust: 'observed', source: { uri: `test://rumour/${index}` },
  }).id);
  const task: BisectTask = { id: 'sailboat', query: 'Dana named the sailboat', k: 1, gold: [gold.id], depth: 100 };
  return { memory, gold: gold.id, poison, task };
}

describe('bisect', () => {
  it('blames exactly the records that displaced the gold evidence', () => {
    const { memory, gold, poison, task } = poisonedStore();
    // The fixture has to actually be poisoned, or the case proves nothing.
    expect(memory.recall({ query: task.query, limit: 1 })[0].memory.id).not.toBe(gold);

    const result = bisect(memory, task);
    expect(result.outcome).toBe('blamed');
    expect([...result.blame].sort()).toEqual([...poison].sort());
    expect(result.goldRank).toBe(poison.length + 1);
    expect(result.tests).toBeGreaterThan(0);
    expect(result.widenings).toBe(0);
    // At k = 1 every record above the gold must go, so the minimal set is unique.
    expect(result.minimalUnique).toBe(true);
    expect(result.alternatives).toBe(0);
    // And Oracle B re-executed the whole thing without the blame set and agreed.
    expect(result.exactConfirmed).toBe(true);
    expect(result.exactRetrieval).toBe('lexical');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('confirms 1-minimality by real re-execution under confirm: minimal', () => {
    const { memory, task } = poisonedStore(2);
    const result = bisect(memory, task, { confirm: 'minimal' });
    expect(result.exactConfirmed).toBe(true);
    expect(result.exactMinimal).toBe(true);
  });

  it('agrees with a search driven entirely by exact re-execution', () => {
    const { memory, poison, task } = poisonedStore(2);
    const cheap = bisect(memory, task);
    const exact = bisect(memory, task, { exact: true });
    expect([...exact.blame].sort()).toEqual([...poison].sort());
    expect([...exact.blame].sort()).toEqual([...cheap.blame].sort());
    // The swap scan is not run under exact, and says so rather than reporting a cheaper oracle's answer.
    expect(exact.minimalUnique).toBeNull();
    expect(exact.alternatives).toBeNull();
  });

  it('reports ambiguity instead of hiding it when several minimal sets exist', () => {
    const { memory, task } = poisonedStore(3);
    // At k = 3 only one of the three poisons has to go, and any of them will do.
    const result = bisect(memory, { ...task, k: 3 });
    expect(result.outcome).toBe('blamed');
    expect(result.blame).toHaveLength(1);
    expect(result.minimalUnique).toBe(false);
    expect(result.alternatives).toBe(2);
  });

  it('says a passing task is passing and blames nothing', () => {
    const { memory, gold, task } = poisonedStore();
    const result = bisect(memory, { ...task, k: 10 });
    expect(result.outcome).toBe('passing');
    expect(result.blame).toEqual([]);
    expect(result.goldRank).toBeGreaterThan(0);
    expect(memory.recall({ query: task.query, limit: 10 }).map(hit => hit.memory.id)).toContain(gold);
  });

  it('reports unfixable when no ablation can surface the gold', () => {
    const { memory, gold, task } = poisonedStore();
    // Ask at a cut point before the gold was ever written: nothing to remove will bring it back.
    const cut = { asOf: iso(T0 - DAY), knownAt: iso(T0 - DAY) };
    const result = bisect(memory, { ...task, ...cut });
    expect(result.outcome).toBe('unfixable');
    expect(result.blame).toEqual([]);
    expect(result.reason).toBe('gold-not-retrievable');
    expect(result.goldRank).toBeNull();
    // Nothing deeper to widen into: the whole store is shallower than one page.
    expect(result.widenings).toBe(0);
    expect(result.ranking).toBe('single-recall');
    expect(memory.getAt(gold, cut)).toBeNull();
    // A cut point was given, so the blame report is anchored to a replayable state hash.
    expect(result.stateSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('widens past the recall depth ceiling by real re-execution', () => {
    const memory = store();
    // More matching records than one recall can return: `limit` is capped at 100
    // by the kernel, so the gold at rank ~130 is invisible to the first ranking.
    for (let index = 0; index < 130; index++) {
      memory.store({ text: `the harbour report mentions a sailboat ${index}`, trust: 'observed', source: { uri: `test://harbour/${index}` } });
    }
    const gold = memory.store({
      text: 'the sailboat inspection was signed off by the harbour master',
      trust: 'verified', evidence: 'harbour://signoff', source: { uri: 'test://harbour/signoff' },
    });
    const task: BisectTask = { id: 'harbour', query: 'sailboat', k: 5, gold: [gold.id], depth: 100 };
    expect(memory.recall({ query: 'sailboat', limit: 100 }).map(hit => hit.memory.id)).not.toContain(gold.id);

    const result = bisect(memory, task);
    expect(result.widenings).toBeGreaterThan(0);
    expect(result.ranking).toBe('stacked');
    expect(result.candidates).toBeGreaterThan(100);
    expect(result.goldRank).toBeGreaterThan(100);
    expect(result.outcome).toBe('blamed');
    expect(result.blame.length).toBe(result.goldRank! - task.k);
    expect(result.exactConfirmed).toBe(true);
  });

  it('never proposes removing the gold evidence itself', () => {
    const { memory, gold, task } = poisonedStore();
    const oracle = exactOracle(memory, task);
    expect(oracle(new Set([gold]))).toBe(false);
    expect(bisect(memory, task).blame).not.toContain(gold);
  });

  it('never proposes removing a record the gold evidence hangs off', () => {
    const memory = store();
    const prior = memory.store({ text: 'Dana named the sailboat', trust: 'observed', source: { uri: 'test://rumour/0' } });
    // The gold DEPENDS on the record that outranks it. Ablating that record
    // takes the gold with it (`ablationClosure`), so removing it cannot make the
    // task pass — the cheap oracle, which walks a flat id list, cannot see that.
    const gold = memory.store({
      // Same trust as what it depends on: the kernel refuses a record whose
      // trust exceeds its dependency's ("Memory trust cannot exceed dependency trust").
      text: 'Dana named the sailboat Corvina after the summer refit that the yard finished late',
      trust: 'observed', source: { uri: 'test://transcript/gold' }, dependencies: [prior.id],
    });
    const task: BisectTask = { id: 'sailboat-dep', query: 'Dana named the sailboat', k: 1, gold: [gold.id], depth: 100 };
    expect(memory.recall({ query: task.query, limit: 1 })[0].memory.id).toBe(prior.id);
    expect(ablationClosure(memory.export().memories, [prior.id]).has(gold.id)).toBe(true);

    const result = bisect(memory, task);
    expect(result.blame).toEqual([]);
    expect(result.outcome).toBe('unfixable');
    expect(result.reason).toBe('ablation-insufficient');
    expect(result.goldRank).toBe(2);
    expect(goldSupport(memory, task)).toEqual(new Set([gold.id, prior.id]));
  });

  it('refuses the result outright when the exact oracle will not stand behind it', () => {
    const { memory, task } = poisonedStore(2);
    // Oracle B rebuilt as a store that never surfaces the gold, whatever is
    // ablated — the shape of a cheap-oracle answer that re-execution rejects.
    const result = bisect(memory, task, {
      createStore: () => ({ recall: () => [], close: () => {} }),
    });
    expect(result.outcome).toBe('unconfirmed');
    expect(result.reason).toBe('blame-not-confirmed');
    expect(result.exactConfirmed).toBe(false);
    // The set is still reported so it can be looked at. It is just not an answer.
    expect(result.blame).toHaveLength(2);
  });
});
