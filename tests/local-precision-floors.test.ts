import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions, type StoreMemoryInput, type SyncMemoryEmbedder, type SyncMemoryReranker } from '../src/local/index.js';
import { retrievalConfigSha256 } from '../src/local/ledger.js';

/**
 * P4: per-stage score floors and native abstention. A floor only excludes; when
 * nothing clears it the recall is empty and the ledger says why, with the floors
 * and the best score seen. A recall that sets no precision control keeps exactly
 * the configuration (and so the hash) it had before the controls existed.
 */

const opened: LocalMemory[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); });
const source = { uri: 'test://precision/floors' };
const fact = (text: string, more: Partial<StoreMemoryInput> = {}): StoreMemoryInput => ({ text, source, trust: 'observed', ...more });
function memory(options: Partial<LocalMemoryOptions> = {}): LocalMemory {
  const db = createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', ...options });
  opened.push(db); return db;
}
const lastRetrieval = (db: LocalMemory) => db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;

// Synthetic test doubles. The embedder places each text on one axis per topic
// word it contains; the reranker gives +5 to a passage that says "approved"
// and -5 to any other.
const AXES = ['canvas', 'export', 'billing', 'invoice'];
function vector(text: string): number[] {
  const lower = text.toLowerCase();
  const raw = AXES.map(word => (lower.includes(word) ? 1 : 0));
  const norm = Math.hypot(...raw) || 1;
  return raw.every(x => x === 0) ? [0.01, 0.01, 0.01, 0.01] : raw.map(x => x / norm);
}
const embedder: SyncMemoryEmbedder = Object.freeze({
  model: 'test-precision-embedder@1', dimensions: 4,
  embedSync: (texts: readonly string[]) => texts.map(vector), embed: async (texts: readonly string[]) => texts.map(vector),
  forQueries: () => ({ model: 'test-precision-embedder@1', dimensions: 4, embed: async (texts: readonly string[]) => texts.map(vector) }),
  forPassages: () => ({ model: 'test-precision-embedder@1', dimensions: 4, embed: async (texts: readonly string[]) => texts.map(vector) }),
  close: () => {},
});
const reranker: SyncMemoryReranker = Object.freeze({
  model: 'test-precision-reranker@1',
  rerankSync: (_query: string, passages: readonly string[]) => passages.map(passage => (/approved/i.test(passage) ? 5 : -5)),
  close: () => {},
});

describe('score floors', () => {
  it('a keyword floor empties the lexical answer and records why', () => {
    const db = memory();
    db.store(fact('Exports use a 1600 canvas.'));
    expect(db.recall({ query: 'canvas width' })).toHaveLength(1);
    expect(db.recall({ query: 'canvas width', minScores: { keyword: 1000 } })).toEqual([]);
    expect(db.lastAbstention).toMatchObject({ reason: 'below-floor', floors: { keyword: 1000 } });
    expect(db.lastAbstention!.topScore).toBeGreaterThan(0);
    const retrieval = lastRetrieval(db);
    expect(retrieval.config.minScores).toEqual({ keyword: 1000 });
    expect(retrieval.abstained).toEqual(db.lastAbstention);
  });

  it('keeps the old configuration keys and hash when no control is set', () => {
    const db = memory();
    db.store(fact('Exports use a 1600 canvas.'));
    db.recall({ query: 'canvas' });
    const retrieval = lastRetrieval(db);
    expect(Object.keys(retrieval.config).sort()).toEqual(['embeddingModel', 'lexicalScoring', 'limit', 'maxCandidates', 'minSimilarity', 'mode', 'rerankTopN', 'rerankerModel', 'rrfK']);
    expect(retrieval.configSha256).toBe(retrievalConfigSha256(retrieval.config));
    expect(retrieval.abstained).toBeUndefined();
    expect(db.lastAbstention).toBeUndefined();
  });

  it('applies final and finalRelative floors to the returned score', () => {
    const db = memory();
    db.store(fact('Canvas export canvas export canvas sizing notes.'));
    db.store(fact('Billing notes mention a canvas once.'));
    const all = db.recall({ query: 'canvas export sizing' });
    expect(all).toHaveLength(2);
    const relative = db.recall({ query: 'canvas export sizing', minScores: { finalRelative: 0.99 } });
    expect(relative.map(r => r.memory.id)).toEqual([all[0].memory.id]);
    expect(db.recall({ query: 'canvas export sizing', minScores: { final: all[0].score + 1 } })).toEqual([]);
    expect(db.lastAbstention).toMatchObject({ reason: 'below-floor', topScore: all[0].score });
  });

  it('instance defaults apply and a recall replaces them key by key', () => {
    const db = memory({ minScores: { keyword: 1000 } });
    db.store(fact('Exports use a 1600 canvas.'));
    expect(db.recall({ query: 'canvas' })).toEqual([]);
    expect(db.recall({ query: 'canvas', minScores: { keyword: 0 } })).toHaveLength(1);
    expect(lastRetrieval(db).config.minScores).toEqual({ keyword: 0 });
  });

  it('says no-candidates when nothing in scope matched at all', () => {
    const db = memory({ minScores: { keyword: 0.1 } });
    db.store(fact('Exports use a 1600 canvas.'));
    expect(db.recall({ query: 'zebra' })).toEqual([]);
    expect(db.lastAbstention).toEqual({ reason: 'no-candidates', floors: { keyword: 0.1 }, topScore: null });
  });

  it('a semantic floor removes dense-only candidates', () => {
    const db = memory({ retrieval: 'hybrid', embedder, rerank: false });
    db.store(fact('Exports use a 1600 canvas.'));
    // "prebilling" shares no token with the query, so only the dense channel
    // (cosine 1/sqrt(2) with "billing invoice") can find it.
    const dense = db.store(fact('Prebilling runs nightly.'));
    expect(db.recall({ query: 'billing invoice', minScores: { semantic: 0.5 } }).map(r => r.memory.id)).toEqual([dense.id]);
    expect(db.recall({ query: 'billing invoice', minScores: { semantic: 0.8 } })).toEqual([]);
    expect(lastRetrieval(db).config.minScores).toEqual({ semantic: 0.8 });
  });

  it('a reranker floor keeps only what the cross-encoder cleared', () => {
    const db = memory({ retrieval: 'hybrid', embedder, reranker });
    const approved = db.store(fact('The canvas export is approved.'));
    db.store(fact('The canvas export is pending review.'));
    expect(db.recall({ query: 'canvas export' })).toHaveLength(2);
    expect(db.recall({ query: 'canvas export', minScores: { reranker: 0.9 } }).map(r => r.memory.id)).toEqual([approved.id]);
    expect(db.recall({ query: 'canvas export pending', minScores: { reranker: 0.9999 } })).toEqual([]);
    expect(db.lastAbstention).toMatchObject({ reason: 'below-floor', floors: { reranker: 0.9999 } });
  });

  it('validates floors at construction and per recall', () => {
    expect(() => memory({ minScores: { semantic: 2 } })).toThrow(TypeError);
    expect(() => memory({ minScores: { keyword: -1 } })).toThrow(TypeError);
    expect(() => memory({ minScores: { lexical: 1 } as never })).toThrow(TypeError);
    expect(() => memory().recall({ query: 'x', minScores: { finalRelative: Number.NaN } })).toThrow(TypeError);
  });

  it('recallHybrid refuses the controls it does not apply', async () => {
    const db = memory();
    await expect(db.recallHybrid({ query: 'x', minScores: { final: 1 } }, { embedder })).rejects.toThrow(TypeError);
  });
});

describe('compile abstention', () => {
  it('reports the retrieval reason for an empty packet', () => {
    const db = memory({ minScores: { keyword: 1000 } });
    db.store(fact('Exports use a 1600 canvas.'));
    const packet = db.compile({ query: 'canvas', maxTokens: 500 });
    expect(packet.abstained).toBe(true);
    expect(packet.abstention).toMatchObject({ reason: 'below-floor', floors: { keyword: 1000 } });
    const none = db.compile({ query: 'zebra', maxTokens: 500 });
    expect(none.abstention).toMatchObject({ reason: 'no-candidates' });
  });

  it('reports budget when candidates existed but none fit', () => {
    const db = memory();
    db.store(fact(`Exports use a 1600 canvas. ${'Padding words for length. '.repeat(40)}`));
    const packet = db.compile({ query: 'canvas', maxTokens: 20 });
    expect(packet.abstained).toBe(true);
    expect(packet.abstention).toMatchObject({ reason: 'budget' });
  });

  it('omits the field when the packet has items', () => {
    const db = memory();
    db.store(fact('Exports use a 1600 canvas.'));
    const packet = db.compile({ query: 'canvas', maxTokens: 500 });
    expect(packet.abstained).toBe(false);
    expect(packet.abstention).toBeUndefined();
  });
});
