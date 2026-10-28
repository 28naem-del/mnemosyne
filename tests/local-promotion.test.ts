import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions, type StoreMemoryInput } from '../src/local/index.js';
import { replayState } from '../src/local/replay.js';

/**
 * Promotion rule M3 (`ancestry-disjoint-v1`): a record's trust rises only when
 * at least two corroborators, each at the target trust, share no ancestor with
 * the candidate and at least two share none with each other. Every decision,
 * granted or not, is a `promotion` ledger event.
 */

const opened: LocalMemory[] = [];
const roots: string[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

/** One second per clock read, so cut points before and after a promotion are unambiguous. */
function ticking(): () => Date { let tick = 0; return () => new Date(Date.UTC(2026, 0, 1) + 1000 * tick++); }
function memory(options: Partial<LocalMemoryOptions> = {}): LocalMemory {
  const db = createLocalMemory({ path: ':memory:', workspaceId: 'project', agentId: 'alice', retrieval: 'lexical', ledger: {}, now: ticking(), ...options });
  opened.push(db); return db;
}
function sharedPath(): string { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-promotion-')); roots.push(root); return join(root, 'memory.sqlite'); }

const claim = (more: Partial<StoreMemoryInput> = {}): StoreMemoryInput => ({ text: 'The quillfern service rotates its signing key every 30 days.', trust: 'untrusted', source: { uri: 'web://paste/quillfern', author: 'stranger' }, ...more });
const witness = (n: number, more: Partial<StoreMemoryInput> = {}): StoreMemoryInput => ({ text: `Independent note ${n}: quillfern signing keys rotate every 30 days.`, trust: 'observed', source: { uri: `doc://witness/${n}`, author: `witness-${n}` }, ...more });
const verified = (n: number): StoreMemoryInput => witness(n, { trust: 'verified', evidence: `Checked against the key store, run ${n}.` });

describe('LocalMemory.promote (M3, ancestry-disjoint-v1)', () => {
  it('grants with two ancestry-disjoint corroborators, by superseding the candidate', () => {
    const db = memory();
    const candidate = db.store(claim());
    const k1 = db.store(witness(1)), k2 = db.store(witness(2));
    const decision = db.promote(candidate.id, { to: 'observed', corroboration: [k1.id, k2.id], reason: 'Two independent notes agree.' });
    expect(decision).toMatchObject({ memoryId: candidate.id, from: 'untrusted', to: 'observed', decision: 'promoted', rule: 'ancestry-disjoint-v1', disjointPairs: 1, promotedId: decision.record.id });
    expect(decision.verdict).toBe('promoted: 2 ancestry-disjoint corroborators (1 disjoint pair), untrusted -> observed');
    expect(decision.corroboration).toEqual([
      { id: k1.id, trust: 'observed', disjointFromCandidate: true, sharedAncestors: [] },
      { id: k2.id, trust: 'observed', disjointFromCandidate: true, sharedAncestors: [] },
    ]);
    expect(decision.record).toMatchObject({ trust: 'observed', status: 'active', supersedes: candidate.id, text: candidate.text, source: candidate.source });
    expect(decision.record.id).not.toBe(candidate.id);
    expect(decision.record.metadata.promotion).toMatchObject({ rule: 'ancestry-disjoint-v1', from: 'untrusted', to: 'observed', supersededId: candidate.id, corroboration: [k1.id, k2.id].sort() });
    expect(db.get(candidate.id)).toMatchObject({ status: 'superseded', trust: 'untrusted' });
    expect(db.recall({ query: 'quillfern signing key' }).map(result => result.memory.id)).toContain(decision.record.id);
  });

  it('logs every decision as a promotion ledger event with the decision payload', () => {
    const db = memory();
    const candidate = db.store(claim());
    const k1 = db.store(witness(1)), k2 = db.store(witness(2));
    const refused = db.promote(candidate.id, { to: 'observed', corroboration: [k1.id], reason: 'Only one note.' });
    const granted = db.promote(candidate.id, { to: 'observed', corroboration: [k1.id, k2.id], reason: 'Two notes.' });
    const { entries } = db.ledger({ event: 'promotion' });
    expect(entries.map(entry => [entry.event, entry.memoryId, entry.promotion?.decision])).toEqual([['promotion', candidate.id, 'quarantined'], ['promotion', candidate.id, 'promoted']]);
    expect(entries.map(entry => entry.id)).toEqual([refused.ledgerId, granted.ledgerId]);
    const { record: _record, ledgerId: _ledgerId, ...payload } = granted;
    expect(entries[1].promotion).toEqual(payload);
    expect(entries[1]).toMatchObject({ workspaceId: 'project', agentId: 'alice' });
    expect(db.ledger({ events: ['store'], event: 'promotion' }).entries.map(entry => entry.event).sort()).toEqual(['promotion', 'promotion', 'store', 'store', 'store', 'store']);
  });

  it('quarantines an echo of the candidate source and names the shared ancestor', () => {
    const db = memory();
    const candidate = db.store(claim());
    const echo = db.store(witness(1, { source: { uri: 'web://paste/quillfern', author: 'someone-else' } })), k2 = db.store(witness(2));
    const before = db.export().memories;
    const decision = db.promote(candidate.id, { to: 'observed', corroboration: [echo.id, k2.id], reason: 'Looks confirmed.' });
    expect(decision.decision).toBe('quarantined');
    expect(decision.verdict).toContain(`corroborator ${echo.id} shares ancestor source:web://paste/quillfern with the candidate`);
    expect(decision.corroboration[0]).toEqual({ id: echo.id, trust: 'observed', disjointFromCandidate: false, sharedAncestors: ['source:web://paste/quillfern'] });
    expect(decision.record).toEqual(candidate);
    expect(decision.promotedId).toBeUndefined();
    expect(db.export().memories).toEqual(before);
  });

  it('quarantines a corroborator that shares an author or a dependency with the candidate', () => {
    const db = memory();
    const base = db.store(witness(9, { text: 'Quillfern keys live in the vault.' }));
    const candidate = db.store(claim({ dependencies: [base.id] }));
    const derived = db.store(witness(1, { dependencies: [base.id] }));
    const sameAuthor = db.store(witness(2, { source: { uri: 'doc://other', author: 'stranger' } }));
    const decision = db.promote(candidate.id, { to: 'observed', corroboration: [derived.id, sameAuthor.id], reason: 'Agrees.' });
    expect(decision.decision).toBe('quarantined');
    expect(decision.verdict).toContain(`corroborator ${derived.id} shares ancestor`);
    expect(decision.verdict).toContain(`memory:${base.id}`);
    expect(decision.verdict).toContain(`corroborator ${sameAuthor.id} shares ancestor author:stranger with the candidate`);
  });

  it('requires two corroborators that are ancestry-disjoint from each other', () => {
    const db = memory();
    const candidate = db.store(claim());
    const k1 = db.store(witness(1, { source: { uri: 'doc://one', author: 'same-desk' } }));
    const k2 = db.store(witness(2, { source: { uri: 'doc://two', author: 'same-desk' } }));
    const refused = db.promote(candidate.id, { to: 'observed', corroboration: [k1.id, k2.id], reason: 'Two notes.' });
    expect(refused.decision).toBe('quarantined');
    expect(refused.verdict).toBe(`quarantined: no two corroborators are ancestry-disjoint from each other: corroborators ${k1.id} and ${k2.id} share ancestor author:same-desk`);
    const k3 = db.store(witness(3));
    const granted = db.promote(candidate.id, { to: 'observed', corroboration: [k1.id, k2.id, k3.id], reason: 'A third, independent note.' });
    expect(granted).toMatchObject({ decision: 'promoted', disjointPairs: 2 });
    expect(granted.verdict).toBe('promoted: 3 ancestry-disjoint corroborators (2 disjoint pairs), untrusted -> observed');
  });

  it('quarantines single, duplicate, below-target, superseded and hidden corroborators', () => {
    const path = sharedPath();
    const alice = memory({ path }), bob = memory({ path, agentId: 'bob' });
    const candidate = alice.store(claim());
    const k1 = alice.store(witness(1)), low = alice.store(witness(2, { trust: 'untrusted' }));
    expect(alice.promote(candidate.id, { to: 'observed', corroboration: [k1.id], reason: 'One.' }).verdict).toContain('at least 2 distinct corroborators are required, 1 named');
    expect(alice.promote(candidate.id, { to: 'observed', corroboration: [k1.id, k1.id], reason: 'Twice.' }).verdict).toContain('at least 2 distinct corroborators are required, 1 named');
    expect(alice.promote(candidate.id, { to: 'observed', corroboration: [k1.id, low.id], reason: 'Low.' }).verdict).toContain(`corroborator ${low.id} has trust untrusted, below observed`);
    const old = alice.store(witness(3));
    alice.correct(old.id, { text: 'Independent note 3, revised.', source: { uri: 'doc://witness/3b', author: 'witness-3' }, reason: 'Typo.' });
    expect(alice.promote(candidate.id, { to: 'observed', corroboration: [k1.id, old.id], reason: 'Old.' }).verdict).toContain(`corroborator ${old.id} is superseded, not active`);
    const hidden = bob.store(witness(4));
    expect(alice.promote(candidate.id, { to: 'observed', corroboration: [k1.id, hidden.id], reason: 'Hidden.' }).verdict).toContain(`corroborator ${hidden.id} is not found in this scope`);
    expect(alice.get(candidate.id)).toMatchObject({ trust: 'untrusted', status: 'active' });
    expect(alice.ledger({ event: 'promotion' }).entries.every(entry => entry.promotion?.decision === 'quarantined')).toBe(true);
  });

  it('quarantines checkpoints, candidates on low dependencies, candidates with dependents, and no-ops', () => {
    const db = memory();
    const k1 = db.store(verified(1)), k2 = db.store(verified(2));
    const base = db.store(witness(5, { text: 'Quillfern runbook.' }));
    const checkpoint = db.checkpoint({ taskId: 'rotate', dependencies: [base.id], goal: 'Rotate keys.', completed: [], pending: ['rotate'], decisions: [], constraints: [], artifacts: [], nextAction: 'Rotate.' });
    expect(db.promote(checkpoint.id, { to: 'verified', corroboration: [k1.id, k2.id], reason: 'Done.' }).verdict).toContain('checkpoints carry task state and are never promoted');
    const onLow = db.store(claim({ trust: 'observed', dependencies: [base.id] }));
    expect(db.promote(onLow.id, { to: 'verified', corroboration: [k1.id, k2.id], reason: 'Checked.' }).verdict).toContain(`dependency ${base.id} has trust observed, below verified`);
    const parent = db.store(claim({ text: 'Quillfern parent claim.', source: { uri: 'web://paste/parent', author: 'stranger-2' } }));
    db.store(claim({ text: 'Quillfern child claim.', dependencies: [parent.id], source: { uri: 'web://paste/child', author: 'stranger-3' } }));
    expect(db.promote(parent.id, { to: 'observed', corroboration: [k1.id, k2.id], reason: 'Checked.' }).verdict).toContain('candidate has 1 active dependent record(s)');
    expect(db.promote(k1.id, { to: 'observed', corroboration: [k2.id, base.id], reason: 'Already.' }).verdict).toContain('candidate trust verified is already at or above observed');
  });

  it('adds generated evidence when promoting to verified, and keeps existing evidence', () => {
    const db = memory();
    const k1 = db.store(verified(1)), k2 = db.store(verified(2));
    const bare = db.store(claim({ trust: 'observed' }));
    const granted = db.promote(bare.id, { to: 'verified', corroboration: [k1.id, k2.id], reason: 'Checked twice.' });
    expect(granted.record).toMatchObject({ trust: 'verified', evidence: `ancestry-disjoint-v1 promotion corroborated by ${[k1.id, k2.id].sort().join(', ')}` });
    const noted = db.store(claim({ text: 'Quillfern second claim.', trust: 'observed', evidence: 'Seen in the dashboard.', source: { uri: 'web://paste/noted', author: 'stranger-4' } }));
    expect(db.promote(noted.id, { to: 'verified', corroboration: [k1.id, k2.id], reason: 'Checked.' }).record.evidence).toBe('Seen in the dashboard.');
  });

  it('rejects malformed input and records that are not the caller\'s own', () => {
    const path = sharedPath();
    const alice = memory({ path }), bob = memory({ path, agentId: 'bob' });
    const candidate = alice.store(claim({ visibility: 'workspace' }));
    const k1 = alice.store(witness(1)), k2 = alice.store(witness(2));
    const input = { to: 'observed' as const, corroboration: [k1.id, k2.id], reason: 'Two.' };
    expect(() => bob.promote(candidate.id, input)).toThrow('Memory not found or not mutable');
    expect(() => alice.promote(candidate.id, { ...input, to: 'untrusted' as never })).toThrow();
    expect(() => alice.promote(candidate.id, { ...input, corroboration: 'k1' as never })).toThrow();
    expect(() => alice.promote(candidate.id, { ...input, extra: true } as never)).toThrow();
    expect(() => alice.promote(candidate.id, { ...input, corroboration: Array.from({ length: 17 }, (_, n) => `id-${n}`) })).toThrow();
    expect(alice.ledger({ event: 'promotion' }).entries).toEqual([]);
  });

  it('leaves the replayed state at a pre-promotion cut unchanged', () => {
    const db = memory();
    const candidate = db.store(claim());
    const k1 = db.store(witness(1)), k2 = db.store(witness(2));
    const cut = { knownAt: new Date(Date.parse(k2.createdAt) + 500).toISOString() };
    const before = replayState(db, cut);
    const decision = db.promote(candidate.id, { to: 'observed', corroboration: [k1.id, k2.id], reason: 'Two.' });
    expect(replayState(db, cut).stateSha256).toBe(before.stateSha256);
    const after = replayState(db, { knownAt: decision.record.createdAt }, { records: true });
    expect(after.items?.find(item => item.id === candidate.id)).toBeUndefined();
    expect(after.items?.find(item => item.id === decision.record.id)?.trust).toBe('observed');
  });

  it('round-trips a promoted state through export and import', () => {
    const db = memory();
    const candidate = db.store(claim());
    const k1 = db.store(witness(1)), k2 = db.store(witness(2));
    const decision = db.promote(candidate.id, { to: 'observed', corroboration: [k1.id, k2.id], reason: 'Two.' });
    const snapshot = db.export();
    const restored = memory();
    restored.import(snapshot);
    restored.import(snapshot);
    expect(restored.export().memories).toEqual(snapshot.memories);
    expect(restored.get(decision.record.id)).toMatchObject({ trust: 'observed', supersedes: candidate.id });
  });

  it('erases a promotion with its record, and redacts it when a corroborator is erased', () => {
    const db = memory();
    const candidate = db.store(claim());
    const k1 = db.store(witness(1)), k2 = db.store(witness(2, { source: { uri: 'doc://witness/secret-uri', author: 'whistleblower' } }));
    const decision = db.promote(candidate.id, { to: 'observed', corroboration: [k1.id, k2.id], reason: 'Two.' });
    db.forget(k2.id);
    const [entry] = db.ledger({ event: 'promotion' }).entries;
    expect(entry.promotion).toMatchObject({ decision: 'promoted', verdict: 'promoted: verdict redacted after erasure of a record it named' });
    // Input order is kept; the erased corroborator keeps its slot but not its id.
    expect(entry.promotion?.corroboration).toEqual([
      { id: k1.id, trust: 'observed', disjointFromCandidate: true, sharedAncestors: [] },
      { id: 'erased', trust: null, disjointFromCandidate: false, sharedAncestors: [] },
    ]);
    expect(JSON.stringify(db.ledger())).not.toContain(k2.id);
    expect(JSON.stringify(db.ledger())).not.toContain('secret-uri');
    // Known residue: the promoted record is immutable and keeps the opaque id of
    // the erased corroborator in metadata.promotion (no text, uri or author).
    expect(db.get(decision.record.id)?.metadata.promotion).toMatchObject({ corroboration: expect.arrayContaining([k2.id]) });
    expect(JSON.stringify(db.export())).not.toContain('secret-uri');
    expect(db.forget(decision.record.id).deletedIds.sort()).toEqual([candidate.id, decision.record.id].sort());
    expect(db.ledger({ event: 'promotion' }).entries).toEqual([]);
    expect(db.get(candidate.id)).toBeNull();
  });

  it('works with the ledger disabled and then returns no ledger id', () => {
    const db = memory({ ledger: false });
    const candidate = db.store(claim());
    const k1 = db.store(witness(1)), k2 = db.store(witness(2));
    const decision = db.promote(candidate.id, { to: 'observed', corroboration: [k1.id, k2.id], reason: 'Two.' });
    expect(decision.decision).toBe('promoted');
    expect(decision.ledgerId).toBeUndefined();
  });
});
