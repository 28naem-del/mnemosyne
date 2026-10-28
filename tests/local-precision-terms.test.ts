import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { selectTerms } from '../src/local/precision.js';

/**
 * P5: IDF-aware query term selection. A query longer than the term cap keeps
 * its rarest terms (by document frequency in scope) rather than its first ones,
 * so a long preamble cannot push the one discriminating term out.
 */

const opened: LocalMemory[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); });

describe('selectTerms', () => {
  const df = new Map([['common', 50], ['usual', 20], ['rare', 1], ['absent', 0], ['also', 20]]);
  const frequency = (term: string) => df.get(term) ?? 0;

  it('returns the terms unchanged at or below the cap', () => {
    expect(selectTerms(['common', 'rare'], 2, frequency)).toEqual(['common', 'rare']);
  });

  it('keeps the rarest terms, in query order, ties broken by first occurrence', () => {
    expect(selectTerms(['common', 'usual', 'rare', 'also'], 2, frequency)).toEqual(['usual', 'rare']);
    expect(selectTerms(['common', 'also', 'rare', 'usual'], 2, frequency)).toEqual(['also', 'rare']);
  });

  it('ranks a term no record contains after every term that does', () => {
    expect(selectTerms(['absent', 'common', 'rare'], 2, frequency)).toEqual(['common', 'rare']);
  });
});

describe('long queries in recall', () => {
  it('still reaches the record named by a rare term at the end of a query past the cap', () => {
    const db = createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical' });
    opened.push(db);
    const filler = Array.from({ length: 70 }, (_, i) => `filler${i}`);
    const source = { uri: 'test://precision/terms' };
    for (let i = 0; i < 3; i++) db.store({ text: `${filler.join(' ')} copy ${i}`, source, trust: 'observed' });
    // The target shares no term with the 70-word preamble: it is reachable only
    // if "zirconium", the 71st distinct term, survives selection.
    const target = db.store({ text: 'The zirconium crucible is in bay four.', source, trust: 'observed' });
    for (const lexicalScoring of ['overlap', 'bm25'] as const) {
      expect(db.recall({ query: `${filler.join(' ')} zirconium`, lexicalScoring }).map(r => r.memory.id)).toContain(target.id);
    }
  });
});
