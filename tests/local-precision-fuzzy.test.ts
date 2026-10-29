import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions } from '../src/local/index.js';
import { boundedOsaDistance, fuzzyEligible, fuzzyMatch, FUZZY_MAX_LENGTH, singleEditCandidates } from '../src/local/fuzzy.js';

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

/** Unbanded reference OSA distance, for checking the banded one. */
function referenceOsa(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

describe('fuzzy cost bound', () => {
  const longToken = (length: number): string => Array.from({ length }, (_, index) => 'abcdefghijklmnopqrstuvwxyz'[(index * 7) % 26]).join('');

  it('agrees with the unbanded distance up to the limit', () => {
    let seed = 7;
    const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
    const word = (): string => Array.from({ length: 1 + (next() % 7) }, () => 'abc'[next() % 3]).join('');
    for (let round = 0; round < 3000; round++) {
      const a = word(), b = word();
      for (const limit of [1, 2]) expect(boundedOsaDistance(a, b, limit), `${a}/${b}/${limit}`).toBe(Math.min(referenceOsa(a, b), limit + 1));
    }
  });

  it('does not fuzz a token longer than the length cap', () => {
    expect(fuzzyEligible(longToken(FUZZY_MAX_LENGTH))).toBe(true);
    expect(fuzzyEligible(longToken(FUZZY_MAX_LENGTH + 1))).toBe(false);
    expect(singleEditCandidates(longToken(4096))).toEqual([]);
  });

  it('keeps distance work linear in the length of very long strings', () => {
    const a = longToken(200_000), b = `${a.slice(0, -1)}q`;
    const started = performance.now();
    expect(boundedOsaDistance(a, b)).toBe(1);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('answers a fuzzy recall of one very long token, and of a query full of capped ones, within budget on an empty store', () => {
    const db = memory();
    // One 4,000-letter token: before the cap this generated ~200k candidates and
    // checked each in O(n^2), which blocked the event loop for hours.
    let started = performance.now();
    expect(db.recall({ query: longToken(4000), fuzzy: true })).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
    // The worst case left: as many tokens of the maximum length as a 4,096-character query holds.
    let seed = 11;
    const letter = (): string => { seed = (seed * 1103515245 + 12345) % 2147483648; return 'abcdefghijklmnopqrstuvwxyz'[seed % 26]; };
    const words = Array.from({ length: Math.floor(4096 / (FUZZY_MAX_LENGTH + 1)) }, () => Array.from({ length: FUZZY_MAX_LENGTH }, letter).join(''));
    expect(new Set(words).size).toBe(words.length);
    expect(words.every(fuzzyEligible)).toBe(true);
    started = performance.now();
    expect(db.recall({ query: words.join(' ').slice(0, 4096), fuzzy: true })).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('expands at most sixteen unmatched terms per query, in query order', () => {
    const db = memory();
    const stored = db.store({ text: 'The mongoose cache is warmed at startup.', source, trust: 'observed' });
    let seed = 5;
    const letter = (): string => { seed = (seed * 1103515245 + 12345) % 2147483648; return 'bcdfghjklmnpqrstvwxz'[seed % 20]; };
    const filler = Array.from({ length: 16 }, () => Array.from({ length: 9 }, letter).join(''));
    expect(db.recall({ query: `moongoose ${filler.join(' ')}`, fuzzy: true }).map(result => result.memory.id)).toEqual([stored.id]);
    expect(db.recall({ query: `${filler.join(' ')} moongoose`, fuzzy: true })).toEqual([]);
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
