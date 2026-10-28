import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions } from '../src/local/index.js';
import { boundedOsaDistance, fuzzyEligible, fuzzyMatch, singleEditCandidates } from '../src/local/fuzzy.js';

/**
 * P3: guarded typo tolerance. A one-edit match is accepted only behind a shared
 * two-letter prefix and on letter-only terms long and varied enough that one edit
 * cannot turn one real word into another (mango/mongo, k8s/k9s). Lexical recall
 * expands only query terms the store does not contain, so a correctly spelled
 * query ranks exactly as it does without the flag.
 */

const opened: LocalMemory[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); });
const source = { uri: 'test://precision/fuzzy' };
function memory(options: Partial<LocalMemoryOptions> = {}): LocalMemory {
  const db = createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', ...options });
  opened.push(db); return db;
}

describe('fuzzy matcher', () => {
  it('accepts one edit behind the guards and rejects the rest', () => {
    for (const [a, b] of [['eror', 'error'], ['reedis', 'redis'], ['mongod', 'mongo'], ['moongoose', 'mongoose'], ['typscript', 'typescript'], ['typsecript', 'typescript']]) expect(fuzzyMatch(a, b), `${a}/${b}`).toBe(true);
    for (const [a, b] of [['mango', 'mongo'], ['k9s', 'k8s'], ['aaaa', 'aaab'], ['redis', 'redis'], ['postgres', 'mongo'], ['xredis', 'redis']]) expect(fuzzyMatch(a, b), `${a}/${b}`).toBe(false);
  });

  it('bounds the distance and the eligibility of a term', () => {
    expect(boundedOsaDistance('abcd', 'abdc')).toBe(1);
    expect(boundedOsaDistance('abcd', 'wxyz')).toBeGreaterThan(1);
    expect(fuzzyEligible('k8s')).toBe(false);
    expect(fuzzyEligible('abc')).toBe(false);
    expect(fuzzyEligible('aaaa')).toBe(false);
    expect(fuzzyEligible('redis')).toBe(true);
  });

  it('enumerates single-edit neighbours deterministically and only past the prefix', () => {
    const neighbours = singleEditCandidates('reedis');
    expect(neighbours).toContain('redis');
    expect(neighbours).toEqual([...neighbours].sort());
    expect(neighbours.every(term => term.startsWith('re') && fuzzyMatch('reedis', term))).toBe(true);
    expect(singleEditCandidates('reedis')).toEqual(neighbours);
  });
});

describe('fuzzy expansion in recall', () => {
  it('finds a typo only when asked, and records that it was asked', () => {
    const db = memory();
    const redis = db.store({ text: 'Redis is the session cache.', source, trust: 'observed' });
    db.store({ text: 'Postgres holds the orders.', source, trust: 'observed' });
    expect(db.recall({ query: 'reedis cache size' }).map(r => r.memory.id)).toEqual([redis.id]);
    expect(db.recall({ query: 'reedis eviction' })).toEqual([]);
    expect(db.recall({ query: 'reedis eviction', fuzzy: true }).map(r => r.memory.id)).toEqual([redis.id]);
    const config = db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!.config;
    expect(config.fuzzy).toBe(true);
  });

  it('leaves a correctly spelled query unchanged', () => {
    const plain = memory(), fuzzy = memory({ fuzzy: true });
    for (const db of [plain, fuzzy]) {
      db.store({ text: 'Redis is the session cache.', source, trust: 'observed' });
      db.store({ text: 'Reddit threads are not a source.', source, trust: 'observed' });
    }
    const strip = (db: LocalMemory) => db.recall({ query: 'redis session' }).map(r => [r.memory.text, r.score]);
    expect(strip(fuzzy)).toEqual(strip(plain));
  });

  it('never expands a short or digit-bearing identifier', () => {
    const db = memory({ fuzzy: true });
    db.store({ text: 'k8s runs the workers.', source, trust: 'observed' });
    expect(db.recall({ query: 'k9s' })).toEqual([]);
  });

  it('validates the option', () => {
    expect(() => memory({ fuzzy: 'yes' as unknown as boolean })).toThrow(TypeError);
    expect(() => memory().recall({ query: 'x', fuzzy: 1 as unknown as boolean })).toThrow(TypeError);
  });
});
