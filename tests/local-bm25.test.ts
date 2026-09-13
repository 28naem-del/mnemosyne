import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createLocalMemory, type LocalMemory, type StoreMemoryInput } from '../src/local/index.js';

const opened: LocalMemory[] = [], roots: string[] = [];
const day = (value: number) => `2026-09-${String(value).padStart(2, '0')}T00:00:00.000Z`;
const fact = (text: string, extra: Partial<StoreMemoryInput> = {}): StoreMemoryInput => ({ text, trust: 'observed', source: { uri: 'test:bm25' }, ...extra });
function memory(path = ':memory:', agentId = 'alice', workspaceId = 'test', now?: () => Date) { const db = createLocalMemory({ path, agentId, workspaceId, now }); opened.push(db); return db; }
function location() { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-bm25-')); roots.push(root); return join(root, 'memory.sqlite'); }
afterEach(() => { opened.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('explicit scoped BM25 recall', () => {
  it('uses document rarity and term saturation by default while retaining explicit overlap', () => {
    const db = memory(); const rare = db.store(fact('orchid uncommon'));
    const repeated = db.store(fact('common common common common'));
    for (let index = 0; index < 12; index++) db.store(fact(`common background ${index}`));
    expect(db.recall({ query: 'orchid common' })).toEqual(db.recall({ query: 'orchid common', lexicalScoring: 'bm25' }));
    expect(db.recall({ query: 'orchid common', lexicalScoring: 'overlap' })[0].memory.id).toBe(rare.id);
    const scores = db.recall({ query: 'orchid common', lexicalScoring: 'bm25' });
    expect(scores[0].memory.id).toBe(rare.id);
    const justCommon = db.recall({ query: 'common', lexicalScoring: 'bm25' });
    expect(justCommon[0].memory.id).toBe(repeated.id);
    // Four occurrences saturate rather than contributing four full copies.
    const n = 14, averageLength = (2 + 4 + 12 * 3) / n;
    const expected = Math.log1p((n - 13 + 0.5) / (13 + 0.5)) * (4 * 2.2) / (4 + 1.2 * (0.25 + 0.75 * 4 / averageLength));
    expect(justCommon[0].score).toBeCloseTo(expected, 12);
  });

  it('scores all matches before retaining a limited result heap', () => {
    const db = memory(); const best = db.store(fact('needle needle needle'));
    db.atomic(() => { for (let index = 0; index < 1100; index++) db.store(fact(`needle long unrelated catalogue record ${index}`)); });
    expect(db.recall({ query: 'needle', lexicalScoring: 'bm25', maxCandidates: 1, limit: 1 })[0].memory.id).toBe(best.id);
  });

  it('keeps scores independent of hidden workspaces, private records, untrusted and control rows', () => {
    const path = location(), db = memory(path);
    db.store(fact('Café orchid')); db.store(fact('orchid common common'));
    const before = db.recall({ query: 'cafe orchid', lexicalScoring: 'bm25' });
    const hidden = memory(path, 'bob'), foreign = memory(path, 'alice', 'foreign');
    for (let i = 0; i < 100; i++) {
      hidden.store(fact(`cafe orchid ${i}`)); foreign.store(fact(`cafe orchid ${i}`, { visibility: 'workspace' }));
      db.store(fact(`cafe orchid ${i}`, { trust: 'untrusted' })); db.store(fact(`cafe orchid ${i}`, { metadata: { advisory: false } }));
    }
    expect(db.recall({ query: 'cafe orchid', lexicalScoring: 'bm25' })).toEqual(before);
  });

  it('uses validity and knowledge cutoffs for statistics and preserves visible conflicts', () => {
    let current = 2; const db = memory(':memory:', 'alice', 'test', () => new Date(day(current)));
    const original = db.store(fact('Port orchid', { key: 'port', validFrom: day(1) }));
    db.store(fact('Another orchid'));
    const before = db.recall({ query: 'orchid', lexicalScoring: 'bm25', asOf: day(3), knownAt: day(4) });
    current = 10;
    db.correct(original.id, { text: 'Port daisies', source: { uri: 'test:revision' }, reason: 'New port', validFrom: day(5) });
    db.store(fact('orchid orchid orchid', { validFrom: day(5) }));
    expect(db.recall({ query: 'orchid', lexicalScoring: 'bm25', asOf: day(3), knownAt: day(4) })).toEqual(before);
    db.store(fact('Port roses', { key: 'port', validFrom: day(5) }));
    const packet = db.compile({ query: 'Port', maxTokens: 10000, lexicalScoring: 'bm25' });
    expect(packet.conflicts[0].key).toBe('port'); expect(packet.items).toHaveLength(2);
  });

  it('rebuilds legacy frequency indexes and retains exact scores across reopen, import and erasure', () => {
    const path = location(), db = memory(path);
    const first = db.store(fact('orchid orchid blossom')); const second = db.store(fact('orchid stem'));
    const before = db.recall({ query: 'orchid', lexicalScoring: 'bm25' }); const snapshot = db.export(); db.close();
    const raw = new DatabaseSync(path);
    // A previous binary has only membership postings and no frequency lengths.
    raw.exec('DROP INDEX local_search_missing_bm25; ALTER TABLE local_terms DROP COLUMN frequency; ALTER TABLE local_search DROP COLUMN token_count;'); raw.close();
    const reopened = memory(path);
    expect(reopened.recall({ query: 'orchid', lexicalScoring: 'bm25' })).toEqual(before);
    const restored = memory(); restored.import(snapshot);
    expect(restored.recall({ query: 'orchid', lexicalScoring: 'bm25' })).toEqual(before);
    reopened.forget(first.id);
    const remaining = reopened.recall({ query: 'orchid', lexicalScoring: 'bm25' });
    expect(remaining.map(item => item.memory.id)).toEqual([second.id]);
    expect(remaining[0].score).toBeCloseTo(Math.log1p(0.5 / 1.5), 12);
  });
});
