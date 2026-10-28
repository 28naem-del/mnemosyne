import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';

/**
 * P2: a current recall never surfaces a superseded record whose successor is
 * visible now, and the decision is made in SQL, before the candidate budget, so
 * a pile of superseded versions cannot crowd the current record out. A
 * historical recall still sees the old version, and a correction that only takes
 * effect later leaves the old version current until then.
 */

const opened: LocalMemory[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); });
const source = { uri: 'test://precision/lifecycle' };

function memory(clock: { now: Date }): LocalMemory {
  const db = createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', now: () => clock.now });
  opened.push(db); return db;
}

describe('lifecycle prefilter', () => {
  it('keeps superseded versions out of the candidate budget', () => {
    const clock = { now: new Date('2026-01-01T00:00:00.000Z') };
    const db = memory(clock);
    const current = db.store({ text: 'The linter of record is biome, configured in the repository root alongside the formatter.', source, trust: 'observed' });
    clock.now = new Date('2026-01-02T00:00:00.000Z');
    for (let index = 0; index < 8; index++) {
      const old = db.store({ text: `linter linter ${index}`, source, trust: 'observed' });
      db.correct(old.id, { text: `retired note ${index}`, source, reason: 'replaced' });
    }
    clock.now = new Date('2026-01-03T00:00:00.000Z');
    // Eight superseded records outscore the current one on "linter". The overlap
    // scorer truncates to the budget in SQL, so with a budget of three only an
    // SQL-side exclusion leaves room for it. (BM25 hydrates before its budget.)
    expect(db.recall({ query: 'linter', maxCandidates: 3, lexicalScoring: 'overlap' }).map(r => r.memory.id)).toEqual([current.id]);
    expect(db.recall({ query: 'linter', maxCandidates: 3 }).map(r => r.memory.id)).toEqual([current.id]);
  });

  it('shows the superseded version to a historical recall', () => {
    const clock = { now: new Date('2026-01-01T00:00:00.000Z') };
    const db = memory(clock);
    const old = db.store({ text: 'SQLAlchemy is the data layer.', source, trust: 'observed' });
    clock.now = new Date('2026-02-01T00:00:00.000Z');
    db.correct(old.id, { text: 'MongoDB with the raw driver is the data layer.', source, reason: 'stack replaced' });
    expect(db.recall({ query: 'sqlalchemy data layer' }).map(r => r.memory.text)).toEqual(['MongoDB with the raw driver is the data layer.']);
    expect(db.recall({ query: 'sqlalchemy', asOf: '2026-01-15T00:00:00.000Z', knownAt: '2026-01-15T00:00:00.000Z' }).map(r => r.memory.id)).toEqual([old.id]);
  });

  it('leaves the old version current while its correction is not yet valid', () => {
    const clock = { now: new Date('2026-01-01T00:00:00.000Z') };
    const db = memory(clock);
    const old = db.store({ text: 'Deploys go out on Fridays.', source, trust: 'observed' });
    clock.now = new Date('2026-01-02T00:00:00.000Z');
    db.correct(old.id, { text: 'Deploys go out on Tuesdays.', source, reason: 'schedule change', validFrom: '2026-03-01T00:00:00.000Z' });
    expect(db.recall({ query: 'fridays' }).map(r => r.memory.id)).toEqual([old.id]);
  });
});
