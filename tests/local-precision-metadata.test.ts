import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory, type LocalMemory, type StoreMemoryInput } from '../src/local/index.js';

/**
 * The recall metadata predicate. The kernel evaluates it in the SQL of every
 * channel before ranking, so a caller's scope never becomes a post-filter that a
 * candidate budget can empty, and the ledger records which keys were in force.
 */

const opened: LocalMemory[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); });
const source = { uri: 'test://precision/metadata' };
const fact = (text: string, metadata: StoreMemoryInput['metadata']): StoreMemoryInput => ({ text, source, trust: 'observed', metadata });
function memory(): LocalMemory {
  const db = createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical' });
  opened.push(db); return db;
}

describe('metadata predicate in recall', () => {
  it('matches one value or any of several', () => {
    const db = memory();
    const api = db.store(fact('The deploy target is fly.', { scope: 'api' }));
    const web = db.store(fact('The deploy target is vercel.', { scope: 'web' }));
    db.store(fact('The deploy target is a VM.', { scope: 'ops' }));
    expect(db.recall({ query: 'deploy target', metadata: { scope: 'api' } }).map(r => r.memory.id)).toEqual([api.id]);
    expect(new Set(db.recall({ query: 'deploy target', metadata: { scope: ['web', 'api'] } }).map(r => r.memory.id))).toEqual(new Set([api.id, web.id]));
  });

  it('never matches a non-string value', () => {
    const db = memory();
    db.store(fact('Port is 8080.', { scope: 1 }));
    db.store(fact('Port is 9090.', { scope: ['api'] }));
    expect(db.recall({ query: 'port', metadata: { scope: '1' } })).toEqual([]);
    expect(db.recall({ query: 'port', metadata: { scope: 'api' } })).toEqual([]);
  });

  it('is applied before the candidate budget', () => {
    const db = memory();
    for (let i = 0; i < 6; i++) db.store(fact(`cache cache cache eviction note ${i}`, { scope: 'other' }));
    const mine = db.store(fact('cache eviction is LRU.', { scope: 'mine' }));
    for (const lexicalScoring of ['overlap', 'bm25'] as const) {
      expect(db.recall({ query: 'cache eviction', maxCandidates: 2, lexicalScoring, metadata: { scope: 'mine' } }).map(r => r.memory.id)).toEqual([mine.id]);
    }
  });

  it('gates the names channel too', () => {
    const db = memory();
    db.store(fact('Other team valkey notes.', { scope: 'other', names: ['valkey'] }));
    const mine = db.store(fact('Our cache notes.', { scope: 'mine', names: ['valkey'] }));
    expect(db.recall({ query: 'valkey', requireNamedMatch: true, metadata: { scope: 'mine' } }).map(r => r.memory.id)).toEqual([mine.id]);
  });

  it('records the keys and a digest of the predicate, not its values', () => {
    const db = memory();
    db.store(fact('The deploy target is fly.', { scope: 'api', team: 'core' }));
    db.recall({ query: 'deploy', metadata: { team: 'core', scope: ['web', 'api'] } });
    const config = db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!.config;
    const expected = createHash('sha256').update(JSON.stringify([['scope', ['api', 'web']], ['team', ['core']]])).digest('hex');
    expect(config.metadataFilter).toEqual({ keys: ['scope', 'team'], sha256: expected });
    expect(JSON.stringify(config)).not.toContain('core');
  });

  it('validates the predicate', () => {
    const db = memory();
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v']));
    expect(() => db.recall({ query: 'x', metadata: many })).toThrow(TypeError);
    expect(() => db.recall({ query: 'x', metadata: { scope: [] } })).toThrow(TypeError);
    expect(() => db.recall({ query: 'x', metadata: { scope: 3 as unknown as string } })).toThrow(TypeError);
  });
});
