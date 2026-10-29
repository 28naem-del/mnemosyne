import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions } from '../src/local/index.js';
import type { SyncMemoryEmbedder } from '../src/local/types.js';
import { loadSqliteVec, SQLITE_VEC_MAX_K, SqliteVecIndex } from '../src/local/vector/index.js';

/**
 * sqlite-vec at its edges: a KNN query deeper than vec0 allows, and a rebuild
 * after the embedding model (and with it the vector width) changes.
 */

const opened: LocalMemory[] = [];
const roots: string[] = [];
function location(): string { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-vec-limits-')); roots.push(root); return join(root, 'memory.sqlite'); }
afterEach(() => { opened.splice(0).forEach(db => { try { db.close(); } catch { /* already closed */ } }); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function embedder(dimensions: number, model: string): SyncMemoryEmbedder {
  const encode = (text: string): number[] => {
    const vector = new Array<number>(dimensions).fill(0);
    for (let index = 0; index < text.length; index++) vector[(text.charCodeAt(index) * 7 + index) % dimensions] += 1;
    vector[0] += 1;
    const norm = Math.hypot(...vector);
    return vector.map(value => value / norm);
  };
  const self: SyncMemoryEmbedder = { model, dimensions, embedSync: (texts) => texts.map(encode), embed: async (texts) => texts.map(encode), forQueries: () => self, forPassages: () => self, close: () => {} };
  return self;
}
function memory(options: Partial<LocalMemoryOptions>): LocalMemory {
  const db = createLocalMemory({ path: ':memory:', workspaceId: 'project', agentId: 'alice', rerank: false, ...options });
  opened.push(db); return db;
}
const source = { uri: 'test://vector-limits' };

describe('sqlite-vec search depth', () => {
  it('clamps a direct search to the engine limit instead of failing', () => {
    const db = new DatabaseSync(':memory:', { allowExtension: true });
    loadSqliteVec(db);
    const index = new SqliteVecIndex(db, 4);
    index.upsert(Array.from({ length: SQLITE_VEC_MAX_K + 10 }, (_, label) => ({ label: label + 1, vector: Float32Array.from([1, (label % 7) / 7, (label % 11) / 11, 0.5]) })));
    expect(index.maxK).toBe(SQLITE_VEC_MAX_K);
    expect(index.search(Float32Array.from([1, 0, 0, 0]), SQLITE_VEC_MAX_K + 10)).toHaveLength(SQLITE_VEC_MAX_K);
    db.close();
  });

  it('answers a recall that must look deeper than 4096 neighbours exactly as the exact scan does', { timeout: 120_000 }, () => {
    const count = SQLITE_VEC_MAX_K + 300;
    const texts = Array.from({ length: count }, (_, index) => `record ${index} about topic ${index % 97} and detail ${(index * 31) % 89}`);
    // ONE database opened twice, so identifiers (which break score ties) agree.
    const path = location();
    const writer = memory({ path, embedder: embedder(16, 'limits@v1'), indexMode: 'exact' });
    writer.atomic(() => { for (const text of texts) writer.store({ text, source, trust: 'observed' }); });
    writer.close();
    const vec = memory({ path, embedder: embedder(16, 'limits@v1'), indexMode: 'sqlite-vec' });
    const exact = memory({ path, embedder: embedder(16, 'limits@v1'), indexMode: 'exact' });
    const ranked = (db: LocalMemory, maxCandidates: number) => db.recall({ query: 'topic 42 detail 17', limit: 20, maxCandidates }).map(result => [result.memory.id, result.score]);
    // 3000 candidates means a first shortlist of 6000, past what vec0 allows.
    expect(ranked(vec, 3000)).toEqual(ranked(exact, 3000));
    expect(vec.retrieval.index).toMatchObject({ mode: 'sqlite-vec', size: count });
    // A shallow request still goes through the index and agrees too.
    expect(ranked(vec, 64)).toEqual(ranked(exact, 64));
  });
});

describe('sqlite-vec rebuild after an embedding model change', () => {
  it('drops and recreates the index at the new width when the model and dimension change', () => {
    const path = location();
    const first = memory({ path, embedder: embedder(16, 'model-a@v1'), indexMode: 'sqlite-vec' });
    for (const text of ['alpha notes on caching', 'beta notes on indexing', 'gamma notes on erasure']) first.store({ text, source, trust: 'observed' });
    expect(first.recall({ query: 'notes on caching', limit: 3 })).toHaveLength(3);
    first.close();

    const second = memory({ path, embedder: embedder(8, 'model-b@v1'), indexMode: 'sqlite-vec' });
    const results = second.recall({ query: 'notes on caching', limit: 3 });
    expect(results).toHaveLength(3);
    // The forget trigger still reaches the recreated table.
    second.forget(results[0].memory.id);
    expect(second.recall({ query: 'notes on caching', limit: 3 })).toHaveLength(2);
    second.close();

    const raw = new DatabaseSync(path, { allowExtension: true });
    loadSqliteVec(raw);
    expect(raw.prepare("SELECT value FROM local_settings WHERE key='vec-index'").get()).toEqual({ value: JSON.stringify({ kind: 'sqlite-vec', model: 'model-b@v1', dimensions: 8 }) });
    expect((raw.prepare('SELECT count(*) AS n FROM local_vec_index').get() as { n: number }).n).toBe(2);
    raw.close();
  });
});
