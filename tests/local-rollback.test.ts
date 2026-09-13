import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalMemory, RollbackConflictError, type LocalMemory, type MemoryRecord, type RollbackRecordExpectation } from '../src/local/index.js';

const source = { uri: 'fixture://rollback' };
const opened: LocalMemory[] = [], directories: string[] = [];
function open(path = ':memory:', agentId = 'alice', workspaceId = 'fixture') {
  const memory = createLocalMemory({ path, agentId, workspaceId }); opened.push(memory); return memory;
}
function disk() { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-undo-')); directories.push(root); return join(root, 'memory.sqlite'); }
function save(memory: LocalMemory, text: string, dependencies: string[] = []) { return memory.store({ text, source, kind: 'observation', dependencies }); }
function revision(memory: LocalMemory, record: MemoryRecord): RollbackRecordExpectation { return { id: record.id, fingerprint: memory.getRecordFingerprint(record.id)! }; }
afterEach(() => { for (const memory of opened.splice(0)) memory.close(); for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('conditional private record rollback', () => {
  it('deletes the exact unchanged set while preserving unrelated and reused provenance', () => {
    const memory = open(), reused = save(memory, 'prior batch source');
    const raw = save(memory, 'new raw source'), projection = save(memory, 'new mapped observation', [raw.id, reused.id]);
    const unrelated = save(memory, 'unrelated work');
    const records = [raw, projection].map(record => revision(memory, record));
    expect(memory.rollbackUnchangedRecords({ records }).deletedIds).toEqual([raw.id, projection.id]);
    expect(memory.get(raw.id)).toBeNull(); expect(memory.get(projection.id)).toBeNull();
    expect(memory.get(reused.id)).toEqual(reused); expect(memory.get(unrelated.id)).toEqual(unrelated);
  });

  it('rolls back deletion and receipt writes together if outer journal work fails', () => {
    const memory = open(), raw = save(memory, 'raw'); const expected = revision(memory, raw);
    expect(() => memory.atomic(() => {
      memory.rollbackUnchangedRecords({ records: [expected] });
      save(memory, 'undo receipt'); throw new Error('journal failure');
    })).toThrow('journal failure');
    expect(memory.get(raw.id)).toEqual(raw);
    expect(memory.list({ includeUntrusted: true }).items).toEqual([raw]);
    memory.atomic(() => { memory.rollbackUnchangedRecords({ records: [expected] }); save(memory, 'successful receipt'); });
    expect(memory.get(raw.id)).toBeNull();
    expect(memory.list({ includeUntrusted: true }).items.map(record => record.text)).toEqual(['successful receipt']);
  });

  it('refuses any later dependency without deleting other batch records', () => {
    const memory = open(), raw = save(memory, 'raw'), peer = save(memory, 'peer');
    const records = [raw, peer].map(record => revision(memory, record));
    const later = save(memory, 'later plan', [raw.id]);
    expect(() => memory.rollbackUnchangedRecords({ records })).toThrow(RollbackConflictError);
    expect([raw, peer, later].every(record => memory.get(record.id) !== null)).toBe(true);
  });

  it('checks outcomes even when record fingerprint is unchanged', () => {
    const memory = open(), raw = save(memory, 'raw'); const expected = revision(memory, raw);
    memory.recordOutcome({ memoryId: raw.id, success: true, taskId: 'later', verifier: 'fixture', evidence: 'used in later work' });
    expect(memory.getRecordFingerprint(raw.id)).toBe(expected.fingerprint);
    expect(() => memory.rollbackUnchangedRecords({ records: [expected] })).toThrow(RollbackConflictError);
    expect(memory.getOutcomeSummary(raw.id).successes).toBe(1);
  });

  it('refuses corrections and keeps the complete history', () => {
    const memory = open(), raw = save(memory, 'original'); const expected = revision(memory, raw);
    const replacement = memory.correct(raw.id, { text: 'corrected', source, reason: 'new evidence' });
    expect(() => memory.rollbackUnchangedRecords({ records: [expected] })).toThrow(RollbackConflictError);
    // Even a controller taking a new fingerprint cannot discard a successor it omitted.
    expect(() => memory.rollbackUnchangedRecords({ records: [revision(memory, raw)] })).toThrow(RollbackConflictError);
    expect(memory.get(raw.id)?.status).toBe('superseded'); expect(memory.get(replacement.id)).toEqual(replacement);
  });

  it('rejects shared records, foreign owners and another workspace', () => {
    const path = disk(), alice = open(path), bob = open(path, 'bob'), other = open(path, 'alice', 'other');
    const shared = alice.store({ text: 'shared', source, visibility: 'workspace' });
    const privateRecord = save(alice, 'private');
    expect(() => alice.rollbackUnchangedRecords({ records: [revision(alice, shared)] })).toThrow(RollbackConflictError);
    expect(() => bob.rollbackUnchangedRecords({ records: [revision(alice, shared)] })).toThrow(RollbackConflictError);
    expect(bob.getRecordFingerprint(privateRecord.id)).toBeNull();
    expect(() => other.rollbackUnchangedRecords({ records: [revision(alice, privateRecord)] })).toThrow(RollbackConflictError);
  });

  it('inspects hidden descendants in the kernel without disclosing their identity', () => {
    const path = disk(), alice = open(path), bob = open(path, 'bob');
    const raw = save(alice, 'raw'), hidden = save(bob, 'private later note');
    // Synthetic database fixture exercises a hidden edge; ordinary API writes
    // forbid creating a foreign dependency on an already-private record.
    const fixtureDb = new DatabaseSync(path);
    fixtureDb.prepare('INSERT INTO dependencies(workspace_id,from_id,to_id) VALUES(?,?,?)').run('fixture', hidden.id, raw.id);
    fixtureDb.close();
    expect(alice.get(hidden.id)).toBeNull();
    let caught: unknown;
    try { alice.rollbackUnchangedRecords({ records: [revision(alice, raw)] }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(RollbackConflictError);
    expect(JSON.stringify(caught)).not.toContain(hidden.id); expect(String(caught)).not.toContain(hidden.text);
    expect(alice.get(raw.id)).toEqual(raw); expect(bob.get(hidden.id)).toEqual(hidden);
  });

  it('rechecks work written through a second connection after preview', () => {
    const path = disk(), first = open(path), second = open(path);
    const raw = save(first, 'raw'); const expected = revision(first, raw);
    const later = save(second, 'work committed after preview', [raw.id]);
    expect(() => first.rollbackUnchangedRecords({ records: [expected] })).toThrow(RollbackConflictError);
    expect(second.get(later.id)).toEqual(later);
  });

  it('does not resurrect or partly delete a set after a source was forgotten', () => {
    const memory = open(), raw = save(memory, 'raw'), peer = save(memory, 'peer');
    const records = [raw, peer].map(record => revision(memory, record)); memory.forget(raw.id);
    expect(() => memory.rollbackUnchangedRecords({ records })).toThrow(RollbackConflictError);
    expect(memory.get(raw.id)).toBeNull(); expect(memory.get(peer.id)).toEqual(peer);
  });

  it('undo is reversible through a new store and clears old idempotency mappings', () => {
    const memory = open(); const input = { text: 'raw', source, idempotencyKey: 'fixture-import' };
    const raw = memory.store(input); memory.rollbackUnchangedRecords({ records: [revision(memory, raw)] });
    const again = memory.store(input); expect(again.id).not.toBe(raw.id); expect(again.text).toBe(raw.text);
  });

  it('snapshots bounded indexed expectations without honoring changing collections or iterators', () => {
    const memory = open(), raw = save(memory, 'raw'); const expected = revision(memory, raw);
    let reads = 0;
    const changing = { get records() { reads++; return reads === 1 ? [] : Array(10001).fill(expected); } };
    expect(memory.rollbackUnchangedRecords(changing).deletedIds).toEqual([]); expect(reads).toBe(1);
    const custom: RollbackRecordExpectation[] = [];
    custom[Symbol.iterator] = function* () { for (let index = 0; index < 10001; index++) yield expected; };
    expect(memory.rollbackUnchangedRecords({ records: custom }).deletedIds).toEqual([]);
    let fingerprintReads = 0;
    const entry = { id: raw.id, get fingerprint() { fingerprintReads++; return fingerprintReads === 1 ? expected.fingerprint : '0'.repeat(64); } };
    expect(memory.rollbackUnchangedRecords({ records: [entry] }).deletedIds).toEqual([raw.id]);
    expect(fingerprintReads).toBe(1);
  });

  it('checks mutations made by expectation getters before the transaction validates any record', () => {
    const memory = open(), first = save(memory, 'first'), second = save(memory, 'second');
    const initial = revision(memory, first), latter = revision(memory, second);
    const mutating = { id: second.id, get fingerprint() {
      memory.recordOutcome({ memoryId: first.id, success: false, taskId: 'callback', verifier: 'fixture', evidence: 'late evidence' });
      return latter.fingerprint;
    } };
    expect(() => memory.rollbackUnchangedRecords({ records: [initial, mutating] })).toThrow(RollbackConflictError);
    expect(memory.get(first.id)).toEqual(first); expect(memory.get(second.id)).toEqual(second);
  });

  it('indexes outcome checks and cascading child keys instead of scanning unrelated records', () => {
    const path = disk(); open(path);
    const inspect = new DatabaseSync(path);
    try {
      const outcome = inspect.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM outcomes WHERE workspace_id=? AND memory_id=? LIMIT 1').all('fixture', 'id');
      expect(JSON.stringify(outcome)).toContain('outcomes_memory_workspace');
      const deletion = inspect.prepare('EXPLAIN QUERY PLAN DELETE FROM memories WHERE id=? AND workspace_id=? AND agent_id=?').all('id', 'fixture', 'alice');
      const plan = JSON.stringify(deletion);
      for (const table of ['outcomes', 'audit', 'idempotency', 'dependencies']) expect(plan).not.toContain(`SCAN ${table}`);
      for (const index of ['outcomes_memory_workspace', 'audit_memory', 'idempotency_memory', 'dependencies_target']) expect(plan).toContain(index);
    } finally { inspect.close(); }
  });

  it('bounds and validates expectations and refuses closed or asynchronous transaction use', async () => {
    const memory = open(), raw = save(memory, 'raw'), expected = revision(memory, raw);
    expect(() => memory.rollbackUnchangedRecords({ records: [expected, expected] })).toThrow('Duplicate');
    expect(() => memory.rollbackUnchangedRecords({ records: [{ ...expected, fingerprint: 'invalid' }] })).toThrow('fingerprint');
    expect(() => memory.rollbackUnchangedRecords({ records: Array(10001).fill(expected) })).toThrow('10000');
    expect(() => memory.rollbackUnchangedRecords({ records: [{ ...expected, fingerprint: '0'.repeat(64) }] })).toThrow(RollbackConflictError);
    let delayed!: Promise<unknown>;
    expect(() => memory.atomic(() => { delayed = Promise.resolve().then(() => memory.rollbackUnchangedRecords({ records: [expected] })); return delayed; })).toThrow('synchronous');
    await expect(delayed).rejects.toThrow(); expect(memory.get(raw.id)).toEqual(raw);
    memory.close(); expect(() => memory.rollbackUnchangedRecords({ records: [] })).toThrow();
  });
});
