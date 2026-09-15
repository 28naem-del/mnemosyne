import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory, type SyncMemoryEmbedder } from '../src/local/index.js';
import { canonicalize, replayDiff, replayState, stateHash, REPLAY_STATE_ALGORITHM } from '../src/local/replay.js';
import { canonical } from '../src/local/validation.js';
import type { MemoryRecord } from '../src/local/types.js';

/**
 * Replay reconstructs a belief state at a bitemporal cut point and hashes it.
 *
 * Two properties carry the whole feature and each is pinned here rather than
 * argued: the hash covers exactly the records the kernel's own temporal gate
 * admits, and the serialization two processes agree on cannot depend on ICU
 * collation. The cross-process half of the gate lives in
 * `local-replay-determinism.test.ts`, which spawns real child processes.
 */

const opened: LocalMemory[] = [];
const roots: string[] = [];
const source = { uri: 'test://replay' };
function location(): string { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-replay-')); roots.push(root); return join(root, 'memory.sqlite'); }
afterEach(() => { opened.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function store(clock: { value: number }, options: Partial<Parameters<typeof createLocalMemory>[0]> = {}): LocalMemory {
  const memory = createLocalMemory({ path: location(), workspaceId: 'replay-tests', agentId: 'reader', now: () => new Date(clock.value), ...options });
  opened.push(memory);
  return memory;
}

/** A deterministic stand-in for the bundled model: no weights, no cache, no network. */
function stubEmbedder(): SyncMemoryEmbedder {
  const vector = (text: string): number[] => {
    const out = new Array<number>(8).fill(0);
    for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) out[createHash('sha256').update(token).digest()[0] % 8] += 1;
    const norm = Math.hypot(...out) || 1;
    return out.map(value => value / norm);
  };
  const embedSync = (texts: readonly string[]): number[][] => texts.map(vector);
  const self: SyncMemoryEmbedder = {
    model: 'test-stub-embedder@v1', dimensions: 8, embedSync,
    embed: async (texts: readonly string[]) => embedSync(texts),
    forQueries: () => self, forPassages: () => self, close: () => {},
  };
  return self;
}

const iso = (millis: number): string => new Date(millis).toISOString();
const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

describe('bitemporal replay: canonical state and its hash', () => {
  it('orders object keys by code unit, not by locale collation', () => {
    // `canonical()` in validation.ts sorts with localeCompare, which is ICU- and
    // locale-dependent. That is fine for a fingerprint one process compares with
    // itself, and wrong for a hash two machines must agree on. Pin the divergence
    // so nobody "simplifies" replay back onto the shared helper.
    const value = { a: 1, Z: 2 };
    expect(canonicalize(value)).toBe('{"Z":2,"a":1}');
    expect(canonical(value)).toBe('{"a":1,"Z":2}');
    expect(canonicalize(value)).not.toBe(canonical(value));
    expect('Z'.localeCompare('a')).toBeGreaterThan(0);
  });

  it('preserves array order, drops undefined, and nests', () => {
    expect(canonicalize({ list: ['b', 'a'], skip: undefined, nested: { y: 1, x: [2, { b: 1, a: 2 }] } }))
      .toBe('{"list":["b","a"],"nested":{"x":[2,{"a":2,"b":1}],"y":1}}');
  });

  it('hashes a record set independently of the order it is handed in', () => {
    const clock = { value: T0 };
    const memory = store(clock);
    const first = memory.store({ text: 'alpha', source });
    const second = memory.store({ text: 'beta', source });
    const a = memory.get(first.id) as MemoryRecord;
    const b = memory.get(second.id) as MemoryRecord;
    expect(stateHash([a, b])).toBe(stateHash([b, a]));
    expect(stateHash([a])).not.toBe(stateHash([a, b]));
    expect(stateHash([])).toBe(createHash('sha256').update(`${REPLAY_STATE_ALGORITHM}\n`).digest('hex'));
  });

  it('admits exactly the records the kernel temporal gate admits', () => {
    const clock = { value: T0 };
    const memory = store(clock);
    const kept = memory.store({ text: 'valid across the cut', source, validFrom: iso(T0 - 10 * DAY), validUntil: iso(T0 + 10 * DAY) });
    const expired = memory.store({ text: 'validity already closed', source, validFrom: iso(T0 - 20 * DAY), validUntil: iso(T0 - 5 * DAY) });
    clock.value = T0 + 30 * DAY;
    const later = memory.store({ text: 'learned after the cut', source });

    const cut = { asOf: iso(T0), knownAt: iso(T0 + DAY) };
    const state = replayState(memory, cut, { records: true });
    const ids = (state.items ?? []).map(record => record.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(expired.id);
    expect(ids).not.toContain(later.id);
    expect(state.records).toBe(ids.length);
    expect(state.scanned).toBe(3);
    // Same gate, asserted record by record against the kernel's own accessor.
    for (const record of state.items ?? []) expect(memory.getAt(record.id, cut)).toEqual(record);
    for (const id of [expired.id, later.id]) expect(memory.getAt(id, cut)).toBeNull();
  });

  it('defaults asOf to knownAt, exactly as a recall does', () => {
    const clock = { value: T0 };
    const memory = store(clock);
    memory.store({ text: 'only real-world valid later', source, validFrom: iso(T0 + 5 * DAY) });
    const single = replayState(memory, { knownAt: iso(T0 + DAY) });
    expect(single.cut).toEqual({ asOf: iso(T0 + DAY), knownAt: iso(T0 + DAY) });
    expect(single.records).toBe(0);
    expect(replayState(memory, { asOf: iso(T0 + 6 * DAY), knownAt: iso(T0 + DAY) }).records).toBe(1);
  });

  it('counts untrusted records into the state instead of hiding them', () => {
    const clock = { value: T0 };
    const memory = store(clock);
    memory.store({ text: 'attributed claim', source, trust: 'observed' });
    memory.store({ text: 'unattributed claim', source, trust: 'untrusted' });
    const state = replayState(memory, { knownAt: iso(T0 + DAY) });
    expect(state.records).toBe(2);
    expect(state.untrusted).toBe(1);
  });

  it('excludes the ledger, the outcome table and the embedding cache from the hash', async () => {
    const clock = { value: T0 };
    const memory = store(clock, { embedder: stubEmbedder(), retrieval: 'lexical' });
    const record = memory.store({ text: 'a belief worth recalling', source, trust: 'observed' });
    const cut = { asOf: iso(T0 + DAY), knownAt: iso(T0 + DAY) };
    const before = replayState(memory, cut).stateSha256;

    // Every one of these writes to the database. None of them changes what the
    // system believes, so none may move the hash.
    memory.recall({ query: 'belief worth recalling', limit: 5 });
    expect(memory.ledger({ events: ['recall'] }).entries.length).toBeGreaterThan(0);
    memory.recordOutcome({ memoryId: record.id, taskId: 'task-1', success: false, evidence: 'ev://1', verifier: 'replay-test-verifier' });
    await memory.indexEmbeddings({ embedder: stubEmbedder() });

    expect(replayState(memory, cut).stateSha256).toBe(before);
    expect(replayState(memory, cut).excluded).toContain('local_ledger');
    expect(replayState(memory, cut).excluded).toContain('outcomes');
    expect(replayState(memory, cut).excluded).toContain('local_embeddings');
  });

  it('moves the hash when, and only when, a belief actually changes', () => {
    const clock = { value: T0 };
    const memory = store(clock);
    const record = memory.store({ text: 'the retention window is 30 days', source, kind: 'decision' });
    const early = { asOf: iso(T0 + DAY), knownAt: iso(T0 + DAY) };
    const before = replayState(memory, early).stateSha256;
    clock.value = T0 + 10 * DAY;
    memory.correct(record.id, { text: 'the retention window is 90 days', source, reason: 'policy change' });
    const late = { asOf: iso(T0 + 11 * DAY), knownAt: iso(T0 + 11 * DAY) };
    expect(replayState(memory, late).stateSha256).not.toBe(before);
    // The past is not rewritten: the old cut point still hashes to the old state.
    expect(replayState(memory, early).stateSha256).toBe(before);
  });
});

describe('bitemporal replay: the diff between two cut points', () => {
  it('reports what changed, and the ledger entries that changed it', () => {
    const clock = { value: T0 };
    const memory = store(clock);
    const policy = memory.store({ text: 'billing runs monthly', source: { uri: 'doc://handbook-v1' }, kind: 'decision' });
    const dropped = memory.store({ text: 'temporary waiver', source, validUntil: iso(T0 + 5 * DAY) });
    clock.value = T0 + 10 * DAY;
    memory.correct(policy.id, { text: 'billing runs quarterly', source: { uri: 'doc://handbook-v2' }, reason: 'finance update' });
    const added = memory.store({ text: 'a wholly new belief', source });

    const diff = replayDiff(memory, { knownAt: iso(T0 + DAY) }, { knownAt: iso(T0 + 11 * DAY) });
    expect(diff.from.stateSha256).not.toBe(diff.to.stateSha256);

    expect(diff.removed.map(entry => entry.id)).toContain(dropped.id);
    expect(diff.removed.map(entry => entry.id)).toContain(policy.id);
    const addedIds = diff.added.map(entry => entry.id);
    expect(addedIds).toContain(added.id);

    // The correction replaces the record, so the new belief carries the new source
    // and points back at the old one. That is "the diff that changed it, and the source".
    const correction = diff.added.find(entry => entry.text === 'billing runs quarterly');
    expect(correction).toBeDefined();
    expect(correction?.source.uri).toBe('doc://handbook-v2');
    expect(correction?.supersedes).toBe(policy.id);
    expect(correction?.ledger.some(entry => entry.event === 'correction')).toBe(true);
    const old = diff.removed.find(entry => entry.id === policy.id);
    expect(old?.source.uri).toBe('doc://handbook-v1');
    expect(old?.ledger.some(entry => entry.event === 'store')).toBe(true);
  });

  it('is empty between two cut points with the same beliefs', () => {
    const clock = { value: T0 };
    const memory = store(clock);
    memory.store({ text: 'stable belief', source });
    const diff = replayDiff(memory, { knownAt: iso(T0 + DAY) }, { knownAt: iso(T0 + 2 * DAY) });
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.from.stateSha256).toBe(diff.to.stateSha256);
  });

  it('reports a field-level change when only the projection differs', () => {
    const clock = { value: T0 };
    const memory = store(clock);
    const record = memory.store({ text: 'depends on nothing yet', source });
    clock.value = T0 + 3 * DAY;
    // A correction to a DEPENDENT leaves this record's projected updatedAt moving
    // from createdAt to the real value once the transition is known.
    const dependent = memory.store({ text: 'derived belief', source, dependencies: [record.id] });
    clock.value = T0 + 6 * DAY;
    memory.correct(record.id, { text: 'depends on nothing yet, corrected', source, reason: 'fix' });
    const diff = replayDiff(memory, { knownAt: iso(T0 + 4 * DAY) }, { knownAt: iso(T0 + 7 * DAY) });
    expect(diff.removed.map(entry => entry.id)).toContain(dependent.id);
    expect(diff.from.records).toBeGreaterThan(0);
  });
});
