import { afterEach, describe, expect, it } from 'vitest';
import { gatedDescribe } from './env-gates.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions, type StoreMemoryInput } from '../src/local/index.js';
import { BUNDLED_EMBEDDING_ID, bundledModelStatus } from '../src/local/embedding/index.js';

const opened: LocalMemory[] = [];
const roots: string[] = [];
const source = { uri: 'test://hybrid' };
function location(): string { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-hybrid-')); roots.push(root); return join(root, 'memory.sqlite'); }
function memory(options: Partial<LocalMemoryOptions> = {}): LocalMemory {
  const db = createLocalMemory({ path: ':memory:', workspaceId: 'project', agentId: 'alice', ...options });
  opened.push(db); return db;
}
const fact = (text: string, more: Partial<StoreMemoryInput> = {}): StoreMemoryInput => ({ text, source, trust: 'observed', ...more });
afterEach(() => { opened.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

/** A record a lexical query cannot reach, and one it can. */
const DENSE_ONLY = 'Melanie finished restoring the antique automobile in her garage.';
const LEXICAL_ONLY = 'vintage car repair manual, page 12.';
const QUERY = 'vintage car repair';

const cached = bundledModelStatus().present;
const withModel = gatedDescribe('model', cached);

describe('zero-model deterministic retrieval stays first class', () => {
  it('is selectable explicitly and reports that no model participates', () => {
    const db = memory({ retrieval: 'lexical' });
    expect(db.retrieval).toEqual({ requested: 'lexical', mode: 'lexical' });
    expect(db.retrieval.embeddingModel).toBeUndefined();
  });

  it('retrieves only lexical matches and writes no vectors at all', () => {
    const path = location();
    const db = memory({ path, retrieval: 'lexical' });
    db.store(fact(DENSE_ONLY));
    const wanted = db.store(fact(LEXICAL_ONLY));
    expect(db.recall({ query: QUERY }).map(hit => hit.memory.id)).toEqual([wanted.id]);
    db.close(); opened.splice(opened.indexOf(db), 1);
    const raw = new DatabaseSync(path);
    try { expect((raw.prepare('SELECT count(*) AS count FROM local_embeddings').get() as { count: number }).count).toBe(0); }
    finally { raw.close(); }
  });

  it('is byte-for-byte repeatable, which is what makes it the audit baseline', () => {
    const db = memory({ retrieval: 'lexical' });
    db.store(fact(LEXICAL_ONLY)); db.store(fact(DENSE_ONLY));
    expect(JSON.stringify(db.recall({ query: QUERY }))).toEqual(JSON.stringify(db.recall({ query: QUERY })));
  });
});

describe('a hybrid request without a usable model degrades loudly, never silently', () => {
  it('reports the degradation and the reason through retrieval', () => {
    const db = memory({ modelCacheDir: join(tmpdir(), 'mnemosyne-no-such-model-cache-t11') });
    expect(db.retrieval.requested).toBe('hybrid');
    expect(db.retrieval.mode).toBe('lexical');
    expect(db.retrieval.degraded).toMatch(/setup:embedder/);
  });

  it('throws instead of degrading when the caller requires an embedder', () => {
    expect(() => memory({ modelCacheDir: join(tmpdir(), 'mnemosyne-no-such-model-cache-t11'), requireEmbedder: true }).recall({ query: QUERY }))
      .toThrow(/embedding model is not in the cache/);
  });
});

withModel('hybrid RRF retrieval is the default', () => {
  it('needs no option to be selected, and names the pinned model it loaded', () => {
    const db = memory();
    expect(db.retrieval.requested).toBe('hybrid');
    expect(db.retrieval.mode).toBe('hybrid');
    expect(db.retrieval.embeddingModel).toBe(BUNDLED_EMBEDDING_ID);
    expect(db.retrieval.dimensions).toBe(384);
  });

  it('finds a record by meaning that the zero-model path cannot reach', () => {
    const dense = memory(); const lexical = memory({ retrieval: 'lexical' });
    for (const db of [dense, lexical]) db.store(fact(DENSE_ONLY));
    expect(lexical.recall({ query: QUERY })).toEqual([]);
    expect(dense.recall({ query: QUERY }).map(hit => hit.memory.text)).toEqual([DENSE_ONLY]);
  });

  it('fuses both channels, keeping the lexical hit the zero-model path already found', () => {
    // Pinned to rerank: false so this case keeps measuring exactly what it names.
    // The default path now rescores the fused head with the cross-encoder, which
    // replaces these scores; that contract is pinned in local-reranker.test.ts.
    const db = memory({ rerank: false });
    const lexicalHit = db.store(fact(LEXICAL_ONLY));
    const denseHit = db.store(fact(DENSE_ONLY));
    const ids = db.recall({ query: QUERY }).map(hit => hit.memory.id);
    expect(ids).toContain(lexicalHit.id);
    expect(ids).toContain(denseHit.id);
    // Reciprocal rank fusion, so scores are rank sums rather than BM25 scores.
    expect(db.recall({ query: QUERY })[0].score).toBeLessThanOrEqual(2 / 11);
  });

  it('fuses both channels with the reranker on, which is the default', () => {
    const db = memory();
    const lexicalHit = db.store(fact(LEXICAL_ONLY));
    const denseHit = db.store(fact(DENSE_ONLY));
    const results = db.recall({ query: QUERY });
    expect(results.map(hit => hit.memory.id)).toContain(lexicalHit.id);
    expect(results.map(hit => hit.memory.id)).toContain(denseHit.id);
    // Rescored candidates carry a logistic of the cross-encoder score, so they sit
    // above every unrescored one and the list stays ordered by score.
    expect(results[0].score).toBeGreaterThan(0.5);
    expect(results.map(hit => hit.score)).toEqual([...results.map(hit => hit.score)].sort((a, b) => b - a));
  });

  it('keeps the model off the write path: storing indexes no vectors, recall does', () => {
    const path = location();
    const db = memory({ path });
    db.store(fact(DENSE_ONLY));
    const count = (): number => {
      const raw = new DatabaseSync(path);
      try { return (raw.prepare('SELECT count(*) AS count FROM local_embeddings').get() as { count: number }).count; }
      finally { raw.close(); }
    };
    expect(count()).toBe(0);
    db.recall({ query: QUERY });
    expect(count()).toBe(1);
  });

  it('enforces scope, visibility, trust and advisory gates on the dense channel too', () => {
    const path = location();
    const alice = memory({ path });
    const bobPrivate = memory({ path, agentId: 'bob' }).store(fact('automobile kept private by bob'));
    const otherWorkspace = memory({ path, agentId: 'alice', workspaceId: 'other' }).store(fact('automobile in another workspace', { visibility: 'workspace' }));
    const advisoryOff = alice.store(fact('automobile withdrawn from advice', { metadata: { advisory: false } }));
    const untrusted = alice.store(fact('automobile from an untrusted source', { trust: 'untrusted' }));
    const shared = memory({ path, agentId: 'bob' }).store(fact('automobile shared across the workspace', { visibility: 'workspace' }));
    const ids = alice.recall({ query: 'vehicle', limit: 50 }).map(hit => hit.memory.id);
    expect(ids).toContain(shared.id);
    for (const hidden of [bobPrivate.id, otherWorkspace.id, advisoryOff.id, untrusted.id]) expect(ids).not.toContain(hidden);
  });

  it('honours an explicitly supplied embedder over the bundled default', () => {
    const constant = Object.freeze({
      model: 'test-constant-embedder@1', dimensions: 4,
      embedSync: () => [[1, 0, 0, 0]],
      embed: async () => [[1, 0, 0, 0]],
      forQueries: () => ({ model: 'test-constant-embedder@1', dimensions: 4, embed: async () => [[1, 0, 0, 0]] }),
      forPassages: () => ({ model: 'test-constant-embedder@1', dimensions: 4, embed: async () => [[1, 0, 0, 0]] }),
      close: () => {},
    });
    const db = memory({ embedder: constant });
    expect(db.retrieval.embeddingModel).toBe('test-constant-embedder@1');
    db.store(fact(DENSE_ONLY));
    expect(db.recall({ query: QUERY }).map(hit => hit.memory.text)).toEqual([DENSE_ONLY]);
  });

  it('applies a similarity floor so an unrelated query can return nothing', () => {
    const db = memory();
    db.store(fact(DENSE_ONLY));
    expect(db.recall({ query: 'quarterly payroll tax filing deadline' }).length).toBe(1);
    expect(db.recall({ query: 'quarterly payroll tax filing deadline', minSimilarity: 0.9 })).toEqual([]);
    expect(() => db.recall({ query: QUERY, minSimilarity: 1.5 })).toThrow(/minSimilarity/);
  });

  it('shares one model across memories in a process instead of reloading it', () => {
    const first = memory(), second = memory();
    expect(first.retrieval.embeddingModel).toBe(second.retrieval.embeddingModel);
    const started = performance.now();
    memory().recall({ query: QUERY });
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
