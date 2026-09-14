import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions, type StoreMemoryInput } from '../src/local/index.js';
import type { SyncMemoryEmbedder } from '../src/local/types.js';
import { hnswAvailable } from '../src/local/vector/index.js';

/**
 * The dense index, held against the exact scan it replaces.
 *
 * Every case here is written the same way: run the query twice, once through the
 * index and once through `indexMode: 'exact'`, and require the second to explain
 * the first. That is the only claim an index in this engine is allowed to make.
 */

const opened: LocalMemory[] = [];
const roots: string[] = [];
const source = { uri: 'test://vector-index' };
function location(): string { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-vec-')); roots.push(root); return join(root, 'memory.sqlite'); }
afterEach(() => { opened.splice(0).forEach(db => { try { db.close(); } catch { /* already closed */ } }); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

/** Deterministic, dependency-free, and nothing like a real model — which is the
 *  point: these cases are about the plumbing, not about retrieval quality. */
export function syntheticEmbedder(dimensions = 16, model = 'test-embedder@v1'): SyncMemoryEmbedder {
  const encode = (text: string): number[] => {
    const vector = new Array<number>(dimensions).fill(0);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      vector[code % dimensions] += 1;
      vector[(code * 7 + index) % dimensions] += 0.5;
    }
    vector[0] += 1; // the engine refuses a zero vector, and an empty string would make one
    const norm = Math.hypot(...vector);
    return vector.map(value => value / norm);
  };
  const embedder: SyncMemoryEmbedder = {
    model, dimensions,
    embedSync: (texts) => texts.map(encode),
    embed: async (texts) => texts.map(encode),
    forQueries: () => embedder, forPassages: () => embedder, close: () => {},
  };
  return embedder;
}

export function memory(options: Partial<LocalMemoryOptions> = {}): LocalMemory {
  const db = createLocalMemory({ path: ':memory:', workspaceId: 'project', agentId: 'alice', embedder: syntheticEmbedder(), rerank: false, ...options });
  opened.push(db); return db;
}
const fact = (text: string, more: Partial<StoreMemoryInput> = {}): StoreMemoryInput => ({ text, source, trust: 'observed', ...more });

const CORPUS = [
  'Melanie restored the antique automobile in her garage last spring.',
  'vintage car repair manual, page twelve, carburettor diagrams.',
  'The quarterly revenue report was filed on the fourteenth.',
  'Dmitri prefers oat milk in his coffee, never soy.',
  'The staging cluster runs on four nodes in Frankfurt.',
  'Aurora bought a second-hand bicycle for the commute.',
  'Payroll runs on the last working day of each month.',
  'The archive keeps seven years of signed audit records.',
];

function seed(db: LocalMemory): string[] { return CORPUS.map(text => db.store(fact(text)).id); }

describe('sqlite-vec dense index', () => {
  it('loads the extension in-process through node:sqlite and reports itself', () => {
    const db = memory();
    seed(db);
    db.recall({ query: 'vintage car repair' });
    expect(db.retrieval.index).toMatchObject({ requested: 'auto', mode: 'sqlite-vec' });
    expect(db.retrieval.index!.size).toBe(CORPUS.length);
  });

  it('returns exactly what the exact scan returns, for every corpus query', () => {
    // ONE database, opened twice. Comparing two separately seeded stores would
    // compare two sets of random identifiers, and identifiers are what breaks a
    // score tie — the difference would be the fixture, not the index.
    const path = location();
    const writer = memory({ path, indexMode: 'exact' });
    seed(writer);
    writer.close(); opened.splice(opened.indexOf(writer), 1);

    const indexed = memory({ path }), exact = memory({ path, indexMode: 'exact' });
    for (const query of [...CORPUS, 'bicycle', 'coffee preferences', 'audit retention', 'nothing at all like these']) {
      const viaIndex = indexed.recall({ query, limit: 8 });
      const viaScan = exact.recall({ query, limit: 8 });
      expect(viaIndex.map(hit => hit.memory.id)).toEqual(viaScan.map(hit => hit.memory.id));
      expect(viaIndex.map(hit => hit.score)).toEqual(viaScan.map(hit => hit.score));
    }
    expect(indexed.retrieval.index).toMatchObject({ requested: 'auto', mode: 'sqlite-vec' });
    expect(exact.retrieval.index).toMatchObject({ requested: 'exact', mode: 'exact' });
  });

  it('writes the vectors into a vec0 table inside the same database file', () => {
    const path = location();
    const db = memory({ path });
    seed(db);
    db.recall({ query: 'coffee' });
    db.close(); opened.splice(opened.indexOf(db), 1);
    const raw = new DatabaseSync(path, { allowExtension: true });
    try {
      const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'local_vec%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
      expect(tables).toContain('local_vec_labels');
      expect(tables).toContain('local_vec_index');
      expect((raw.prepare('SELECT count(*) AS count FROM local_vec_labels').get() as { count: number }).count).toBe(CORPUS.length);
    } finally { raw.close(); }
  });

  it('builds the index lazily for a database written before one existed', () => {
    const path = location();
    const before = memory({ path, indexMode: 'exact' });
    const ids = seed(before);
    expect(before.recall({ query: 'bicycle commute' }).length).toBeGreaterThan(0);
    before.close(); opened.splice(opened.indexOf(before), 1);

    // No migration step, no rebuild command: opening it is enough.
    const after = memory({ path });
    const hits = after.recall({ query: 'bicycle commute', limit: 8 });
    expect(after.retrieval.index).toMatchObject({ mode: 'sqlite-vec', size: CORPUS.length });
    expect(hits.length).toBeGreaterThan(0);
    expect(ids).toEqual(expect.arrayContaining(hits.map(hit => hit.memory.id)));
  });

  it('keeps working, and keeps erasing, when the extension cannot be loaded', () => {
    const path = location();
    const indexed = memory({ path });
    const ids = seed(indexed);
    indexed.recall({ query: 'payroll' });
    indexed.close(); opened.splice(opened.indexOf(indexed), 1);

    // The same database, on a machine with no sqlite-vec. A trigger naming a
    // table this process cannot see would make forget() throw; it must not.
    const plain = memory({ path, indexMode: 'exact' });
    expect(() => plain.forget(ids[0])).not.toThrow();
    expect(plain.recall({ query: CORPUS[0], limit: 8 }).map(hit => hit.memory.id)).not.toContain(ids[0]);
  });

  it('never loads a model or an index on the zero-model deterministic path', () => {
    const db = memory({ retrieval: 'lexical', embedder: undefined });
    seed(db);
    expect(db.recall({ query: 'vintage car repair' }).length).toBeGreaterThan(0);
    expect(db.retrieval).toEqual({ requested: 'lexical', mode: 'lexical' });
    expect(db.retrieval.index).toBeUndefined();
  });

  it('refuses an index mode it does not implement', () => {
    expect(() => memory({ indexMode: 'faiss' as never })).toThrow(/indexMode must be one of/);
  });

  it('reads no network at query time', () => {
    const db = memory();
    seed(db);
    const fetchRef = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => { calls++; throw new Error('network at query time'); }) as typeof fetch;
    try { expect(db.recall({ query: 'staging cluster Frankfurt' }).length).toBeGreaterThan(0); }
    finally { globalThis.fetch = fetchRef; }
    expect(calls).toBe(0);
  });
});

describe('hnsw dense index', () => {
  const withHnsw = hnswAvailable() ? it : it.skip;

  withHnsw('is never selected on your behalf', () => {
    const db = memory();
    seed(db); db.recall({ query: 'coffee' });
    expect(db.retrieval.index!.mode).toBe('sqlite-vec');
  });

  withHnsw('rebuilds deterministically after its index file is lost', () => {
    const path = location();
    const build = (): { digest: string; hits: string[][] } => {
      const db = memory({ path, indexMode: 'hnsw' });
      const queries = ['coffee', 'vintage car repair', 'payroll last working day', 'signed audit records', 'Frankfurt nodes'];
      const hits = queries.map(query => db.recall({ query, limit: 5 }).map(hit => hit.memory.id));
      db.close(); opened.splice(opened.indexOf(db), 1);
      return { digest: createHash('sha256').update(readFileSync(`${path}-hnsw`)).digest('hex'), hits };
    };
    const seeder = memory({ path, indexMode: 'exact' });
    seed(seeder);
    seeder.close(); opened.splice(opened.indexOf(seeder), 1);

    const incremental = build();
    // Lose the index the way a crash or a partial copy would, leaving the
    // database untouched, and rebuild from `local_embeddings` twice.
    const rebuild = (): { digest: string; hits: string[][] } => {
      rmSync(`${path}-hnsw`); rmSync(`${path}-hnsw.meta.json`);
      return build();
    };
    const first = rebuild(), second = rebuild();

    // A rebuild is reproducible to the byte: same labels, same insertion order
    // (`ORDER BY memory_id`), same seed and construction parameters.
    expect(second.digest).toBe(first.digest);
    expect(second.hits).toEqual(first.hits);
    // It still answers what the incremental index answered. The two graphs are
    // NOT required to be the same object — the index is built incrementally in
    // creation order and rebuilt in identifier order, so their topologies can
    // differ — and they do not have to be, because correctness comes from the
    // authorization gate and the exact rescore below the index, never from which
    // graph proposed a candidate.
    expect(first.hits).toEqual(incremental.hits);
  });

  withHnsw('persists its index beside the database and reloads it', () => {
    const path = location();
    const db = memory({ path, indexMode: 'hnsw' });
    seed(db);
    db.recall({ query: 'coffee' });
    expect(db.retrieval.index).toMatchObject({ requested: 'hnsw', mode: 'hnsw' });
    db.close(); opened.splice(opened.indexOf(db), 1);
    expect(existsSync(`${path}-hnsw`)).toBe(true);

    const reopened = memory({ path, indexMode: 'hnsw' });
    expect(reopened.recall({ query: 'oat milk coffee', limit: 8 }).length).toBeGreaterThan(0);
    expect(reopened.retrieval.index).toMatchObject({ mode: 'hnsw', size: CORPUS.length });
  });
});
