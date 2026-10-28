import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions, type StoreMemoryInput } from '../src/local/index.js';
import { NameIndex } from '../src/local/precision.js';

/**
 * P1: the name/alias gate. A record declares `metadata.names`; with
 * `requireNamedMatch: true` a recall returns only records one of whose names
 * occurs in the query as a whole token phrase, and with `'auto'` that applies to
 * records that declare names while the rest compete on text. Every name hit goes
 * through the same scope, kind and temporal gates as the text channel.
 */

const opened: LocalMemory[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); });
const source = { uri: 'test://precision/names' };
const fact = (text: string, names?: string[], more: Partial<StoreMemoryInput> = {}): StoreMemoryInput => ({ text, source, trust: 'observed', ...(names ? { metadata: { names } } : {}), ...more });
function memory(options: Partial<LocalMemoryOptions> = {}, agentId = 'a', path = ':memory:'): LocalMemory {
  const db = createLocalMemory({ path, workspaceId: 'w', agentId, retrieval: 'lexical', ...options });
  opened.push(db); return db;
}

describe('name index', () => {
  it('matches whole contiguous phrases, reads underscores as spaces, and keeps query order on ties', () => {
    const index = new NameIndex();
    index.add('redis', ['redis', 'eviction policy']);
    index.add('auth', ['auth_strategy']);
    index.add('k8s', ['kubernetes']);
    expect(index.match('what is our eviction policy', false).map(m => m.id)).toEqual(['redis']);
    expect(index.match('a policy for eviction', false)).toEqual([]);
    expect(index.match('the auth strategy', false).map(m => m.id)).toEqual(['auth']);
    expect(index.match('kubernetes or redis', false).map(m => m.id)).toEqual(['k8s', 'redis']);
    expect(index.match('kubernetes or redis', false, id => id !== 'k8s').map(m => m.id)).toEqual(['redis']);
  });

  it('fuzzes only a query token that is not itself a name word', () => {
    const index = new NameIndex();
    index.add('mongo', ['mongodb']);
    index.add('mongoose', ['mongoose']);
    expect(index.match('mongose models', true).map(m => m.id)).toEqual(['mongoose']);
    expect(index.match('mongose models', false)).toEqual([]);
    expect(index.match('mongoose models', true).map(m => m.id)).toEqual(['mongoose']);
  });
});

describe('requireNamedMatch in recall', () => {
  it('returns only named records and explains an empty answer', () => {
    const db = memory();
    const redis = db.store(fact('Redis is the cache for sessions.', ['redis', 'cache layer']));
    db.store(fact('Postgres holds the orders and the sessions table.', ['postgres']));
    expect(db.recall({ query: 'how big is the redis cache', requireNamedMatch: true }).map(r => r.memory.id)).toEqual([redis.id]);
    expect(db.recall({ query: 'where do sessions live', requireNamedMatch: true })).toEqual([]);
    expect(db.lastAbstention).toMatchObject({ reason: 'no-named-match' });
    const retrieval = db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
    expect(retrieval.config.requireNamedMatch).toBe(true);
    expect(retrieval.abstained).toMatchObject({ reason: 'no-named-match' });
    expect(retrieval.candidateCounts.map(c => c.stage)).toEqual(['lexical', 'names', 'fused']);
  });

  it("'auto' gates only records that declare names", () => {
    const db = memory({ requireNamedMatch: 'auto' });
    db.store(fact('Redis is the cache for sessions.', ['redis']));
    const plain = db.store(fact('Sessions expire after one hour.'));
    expect(db.recall({ query: 'when do sessions expire' }).map(r => r.memory.id)).toEqual([plain.id]);
  });

  it('a name hit with no text overlap still passes every record gate', () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/mnemosyne-names-${process.pid}-${Date.now()}.sqlite`;
    const alice = memory({ requireNamedMatch: true }, 'alice', path), bob = memory({ requireNamedMatch: true }, 'bob', path);
    const shared = alice.store(fact('Shared cache notes.', ['valkey'], { visibility: 'workspace' }));
    alice.store(fact('Private cache notes.', ['valkey'], { visibility: 'private' }));
    alice.store(fact('Decision notes.', ['valkey'], { kind: 'decision' }));
    expect(bob.recall({ query: 'valkey' }).map(r => r.memory.id)).toEqual([shared.id]);
    expect(alice.recall({ query: 'valkey', kinds: ['decision'] }).map(r => r.memory.text)).toEqual(['Decision notes.']);
    expect(bob.recall({ query: 'valkey', asOf: '2000-01-01T00:00:00.000Z', knownAt: '2000-01-01T00:00:00.000Z' })).toEqual([]);
  });

  it('sees a name added by a correction without a rebuild call', () => {
    const db = memory({ requireNamedMatch: true });
    const first = db.store(fact('Redis is the cache.', ['redis']));
    expect(db.recall({ query: 'allkeys-lru' })).toEqual([]);
    const next = db.correct(first.id, { text: 'Redis is the cache.', source, reason: 'alias added', metadata: { names: ['redis', 'allkeys-lru'] } });
    expect(db.recall({ query: 'is allkeys-lru on' }).map(r => r.memory.id)).toEqual([next.id]);
  });

  it('gives each entity of a compound query a share of the answer', () => {
    const db = memory({ requireNamedMatch: true });
    const redis = db.store(fact('Redis Redis Redis cache cache cache tuning notes.', ['redis']));
    const kafka = db.store(fact('Kafka carries the event stream.', ['kafka']));
    expect(new Set(db.recall({ query: 'redis cache tuning and kafka', limit: 2 }).map(r => r.memory.id))).toEqual(new Set([redis.id, kafka.id]));
  });

  it('validates the option', () => {
    expect(() => memory({ requireNamedMatch: 'always' as unknown as true })).toThrow(TypeError);
    expect(() => memory().recall({ query: 'x', requireNamedMatch: 1 as unknown as true })).toThrow(TypeError);
  });
});
