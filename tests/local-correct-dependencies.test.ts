import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';

/**
 * `correct()` may ADD declared dependencies to the successor. This is the only
 * after-the-fact way to declare a dependency, and it is a correction (ledgered,
 * with a reason), so an inferred dependency a reviewer accepts is never a
 * silent mutation. The previous record's dependencies are always inherited.
 */

const opened: LocalMemory[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); });
function memory(): LocalMemory {
  const db = createLocalMemory({ path: ':memory:', workspaceId: 'project', agentId: 'alice', retrieval: 'lexical', ledger: {} });
  opened.push(db); return db;
}

describe('correct() with added dependencies', () => {
  it('adds the dependency, inherits the old ones, and the cascade now reaches the successor', () => {
    const db = memory();
    const premise = db.store({ text: 'The API base URL is https://api.example.com/v1', source: { uri: 'spec://v1' } });
    const declared = db.store({ text: 'Rate limit is 100 requests per minute', source: { uri: 'spec://v1' } });
    const procedure = db.store({ text: 'Procedure: call GET /v1/items and back off at 100 rpm', kind: 'procedure', dependencies: [declared.id], source: { uri: 'agent://lesson' } });

    const linked = db.correct(procedure.id, { text: procedure.text, source: procedure.source, reason: 'inferred dependency accepted', dependencies: [premise.id] });
    expect(linked.supersedes).toBe(procedure.id);
    expect([...linked.dependencies].sort()).toEqual([declared.id, premise.id].sort());
    expect(db.get(procedure.id)?.status).toBe('superseded');

    db.correct(premise.id, { text: 'The API base URL is https://api.example.com/v2', source: { uri: 'spec://v2' }, reason: 'spec changed' });
    expect(db.get(linked.id)?.status).toBe('invalidated');
  });

  it('rejects duplicates and unknown dependency ids, and leaves dependencies alone when omitted', () => {
    const db = memory();
    const a = db.store({ text: 'fact a', source: { uri: 'x://a' } });
    const b = db.store({ text: 'lesson b', dependencies: [a.id], source: { uri: 'x://b' } });
    expect(() => db.correct(b.id, { text: 'lesson b', source: b.source, reason: 'r', dependencies: [a.id, a.id] })).toThrow(/Duplicate dependency/);
    expect(() => db.correct(b.id, { text: 'lesson b', source: b.source, reason: 'r', dependencies: ['missing-id'] })).toThrow();
    const same = db.correct(b.id, { text: 'lesson b v2', source: b.source, reason: 'r' });
    expect(same.dependencies).toEqual([a.id]);
  });
});
