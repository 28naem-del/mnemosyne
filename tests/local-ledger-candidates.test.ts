import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions, type StoreMemoryInput, type SyncMemoryEmbedder, type SyncMemoryReranker } from '../src/local/index.js';

/**
 * The candidate-set schema (master plan 11.6).
 *
 * The ledger has to record what a retrieval CONSIDERED, not only what it
 * returned: without the rejected candidates, their per-stage ranks and the
 * configuration that produced them, an outcome cannot be attributed to a ranking
 * decision, and the data is unrecoverable after the fact. These cases pin that
 * contract, including the part that matters most — that widening what the ledger
 * remembers does not widen what survives erasure.
 */

const opened: LocalMemory[] = [];
const roots: string[] = [];
const source = { uri: 'test://ledger/candidates' };
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
function location(): string { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-candidates-')); roots.push(root); return join(root, 'memory.sqlite'); }
const fact = (text: string, more: Partial<StoreMemoryInput> = {}): StoreMemoryInput => ({ text, source, trust: 'observed', ...more });
afterEach(() => { opened.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

/** A deterministic stand-in for the bundled model: no weights, no cache, no network. */
function stubEmbedder(): SyncMemoryEmbedder {
  const vector = (text: string): number[] => {
    const out = new Array<number>(8).fill(0);
    for (const token of text.toLowerCase().split(/\W+/).filter(Boolean)) out[createHash('sha256').update(token).digest()[0] % 8] += 1;
    const norm = Math.hypot(...out) || 1;
    return out.map(value => value / norm);
  };
  const embedSync = (texts: readonly string[]): number[][] => texts.map(vector);
  const self: SyncMemoryEmbedder = {
    model: 'test-stub-embedder@v1', dimensions: 8, embedSync,
    embed: async (texts: readonly string[]) => embedSync(texts),
    forQueries: () => self, forPassages: () => self, close: () => {},
  };
  return self;
}

/** Reverses the fused order, so a reranked stage is unmistakably distinct from the fused one. */
function reversingReranker(): SyncMemoryReranker {
  return { model: 'test-stub-reranker@v1', rerankSync: (_query, passages) => passages.map((_passage, index) => index), close: () => {} };
}

function memory(options: Partial<LocalMemoryOptions> = {}): LocalMemory {
  const db = createLocalMemory({ path: ':memory:', workspaceId: 'project', agentId: 'alice', embedder: stubEmbedder(), reranker: null, ...options });
  opened.push(db); return db;
}

function seed(db: LocalMemory): string[] {
  return [
    'Catalogue exports need approval from the owner.',
    'Approval for the catalogue is granted by the owner each quarter.',
    'The export canvas is 1200 by 900 pixels.',
    'Owner approval is recorded in the release log.',
    'Unrelated: the office coffee machine was replaced.',
  ].map(text => db.store(fact(text)).id);
}

describe('ledger candidate set, configuration hash and verifier slot', () => {
  it('records every stage of a hybrid retrieval with per-candidate ranks and scores', () => {
    const db = memory();
    seed(db);
    const results = db.recall({ query: 'catalogue owner approval', limit: 2 });
    const entry = db.ledger({ events: ['recall'] }).entries.at(-1)!;
    const retrieval = entry.retrieval!;

    expect(retrieval.schema).toBe(2);
    expect(retrieval.candidateCounts.map(count => count.stage)).toEqual(['lexical', 'dense', 'fused']);
    for (const stage of ['lexical', 'dense', 'fused'] as const) {
      const candidates = retrieval.candidates.filter(candidate => candidate.stage === stage);
      expect(candidates.length).toBeGreaterThan(0);
      // The recorded set is strictly wider than the returned one: that is the point.
      expect(candidates.length).toBeGreaterThan(results.length);
      expect(candidates.map(candidate => candidate.rank)).toEqual(candidates.map((_, index) => index));
      for (const candidate of candidates) expect(typeof candidate.score).toBe('number');
      expect(retrieval.candidateCounts.find(count => count.stage === stage)).toEqual({ stage, total: candidates.length, recorded: candidates.length });
    }
    // The fused stage is ordered by its own score, descending.
    const fused = retrieval.candidates.filter(candidate => candidate.stage === 'fused');
    expect([...fused].sort((a, b) => b.score - a.score).map(candidate => candidate.memoryId)).toEqual(fused.map(candidate => candidate.memoryId));
    // and the returned results are its head.
    expect(fused.slice(0, results.length).map(candidate => candidate.memoryId)).toEqual(results.map(result => result.memory.id));
  });

  it('records a reranked stage that reorders the fused one without losing candidates', () => {
    const db = memory({ reranker: reversingReranker(), rerankTopN: 50 });
    seed(db);
    db.recall({ query: 'catalogue owner approval', limit: 3 });
    const retrieval = db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;

    expect(retrieval.candidateCounts.map(count => count.stage)).toEqual(['lexical', 'dense', 'fused', 'reranked']);
    const fused = retrieval.candidates.filter(candidate => candidate.stage === 'fused').map(candidate => candidate.memoryId);
    const reranked = retrieval.candidates.filter(candidate => candidate.stage === 'reranked').map(candidate => candidate.memoryId);
    // Reranking is a reordering, never a narrowing: same set, different order.
    expect([...reranked].sort()).toEqual([...fused].sort());
    expect(reranked).not.toEqual(fused);
    expect(retrieval.config?.rerankerModel).toBe('test-stub-reranker@v1');
    expect(retrieval.config?.rerankTopN).toBe(50);
  });

  it('hashes the retrieval configuration so runs are only comparable when it matches', () => {
    const first = memory();
    seed(first);
    first.recall({ query: 'catalogue owner approval', limit: 5 });
    const same = first.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
    first.recall({ query: 'a different question entirely', limit: 5 });
    const other = first.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
    // The hash covers the configuration, not the query.
    expect(other.configSha256).toBe(same.configSha256);

    const changed = memory({ rrfK: 60 });
    seed(changed);
    changed.recall({ query: 'catalogue owner approval', limit: 5 });
    const shifted = changed.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
    expect(shifted.configSha256).not.toBe(same.configSha256);
    expect(shifted.config).toMatchObject({ mode: 'hybrid', rrfK: 60, embeddingModel: 'test-stub-embedder@v1', rerankerModel: null, rerankTopN: null, limit: 5 });
  });

  it('leaves the verifier slot null until a verifier runs, then fills it exactly once', () => {
    const db = memory();
    seed(db);
    db.recall({ query: 'catalogue owner approval', limit: 3 });
    const retrievalId = db.lastRetrievalId!;
    expect(retrievalId).toBeTruthy();
    expect(db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!.verifier).toBeNull();

    const updated = db.recordRetrievalOutcome({ retrievalId, taskId: 'task-9', success: true, verifier: 'release-check', evidence: 'exit status 0' });
    expect(updated.retrieval!.verifier).toMatchObject({ taskId: 'task-9', success: true, verifier: 'release-check', evidenceSha256: sha('exit status 0') });
    expect(Date.parse(updated.retrieval!.verifier!.recordedAt)).toBeGreaterThan(0);
    // Read back through the normal ledger query, not only the returned value.
    expect(db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!.verifier).toMatchObject({ taskId: 'task-9', success: true });
    // A verdict is never quietly replaced.
    expect(() => db.recordRetrievalOutcome({ retrievalId, taskId: 'task-9', success: false, verifier: 'release-check', evidence: 'exit status 1' }))
      .toThrow(/already carries a verifier outcome/);
    // The evidence itself is hashed, never stored.
    expect(JSON.stringify(db.ledger({ events: ['recall'] }).entries)).not.toContain('exit status 0');
  });

  it('defaults the verifier slot to the most recent retrieval and refuses anything else', () => {
    const db = memory();
    seed(db);
    db.recall({ query: 'catalogue owner approval', limit: 3 });
    const first = db.lastRetrievalId!;
    db.recall({ query: 'export canvas size', limit: 3 });
    const second = db.lastRetrievalId!;
    expect(second).not.toBe(first);
    expect(db.recordRetrievalOutcome({ taskId: 't', success: false, verifier: 'v', evidence: 'e' }).id).toBe(second);
    expect(() => db.recordRetrievalOutcome({ retrievalId: randomUUID(), taskId: 't', success: true, verifier: 'v', evidence: 'e' }))
      .toThrow(/No retrieval is recorded under that identifier/);
    const storeEntry = db.ledger({ events: ['store'] }).entries[0];
    expect(() => db.recordRetrievalOutcome({ retrievalId: storeEntry.id, taskId: 't', success: true, verifier: 'v', evidence: 'e' }))
      .toThrow(/No retrieval is recorded under that identifier/);
  });

  it('bounds what one record stores and discloses what the bound dropped', () => {
    const db = memory({ ledger: { maxCandidates: 2 } });
    seed(db);
    db.recall({ query: 'catalogue owner approval', limit: 5 });
    const retrieval = db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
    for (const count of retrieval.candidateCounts) {
      expect(count.recorded).toBeLessThanOrEqual(2);
      // A truncated record never reads as a complete one.
      expect(count.total).toBeGreaterThanOrEqual(count.recorded);
    }
    expect(retrieval.candidates.filter(candidate => candidate.stage === 'fused')).toHaveLength(2);
    expect(retrieval.candidateCounts.find(count => count.stage === 'fused')!.total).toBeGreaterThan(2);
  });

  it('records no candidates when candidate recording is off, and still records the results', () => {
    const db = memory({ ledger: { candidates: 'off' } });
    seed(db);
    const results = db.recall({ query: 'catalogue owner approval', limit: 3 });
    const retrieval = db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
    expect(retrieval.candidates).toEqual([]);
    expect(retrieval.results).toHaveLength(results.length);
    // The stage depths are still disclosed, so "off" is visibly a choice, not an absence of stages.
    expect(retrieval.candidateCounts.map(count => count.stage)).toEqual(['lexical', 'dense', 'fused']);
    expect(retrieval.candidateCounts.every(count => count.recorded === 0 && count.total > 0)).toBe(true);
  });

  it('records the lexical ranking as the candidate set on the zero-model path', () => {
    const db = memory({ retrieval: 'lexical', embedder: undefined });
    seed(db);
    const results = db.recall({ query: 'catalogue owner approval', limit: 4 });
    const retrieval = db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
    expect(retrieval.candidateCounts.map(count => count.stage)).toEqual(['lexical']);
    expect(retrieval.config).toMatchObject({ mode: 'lexical', embeddingModel: null, rerankerModel: null, rerankTopN: null });
    expect(retrieval.candidates.map(candidate => candidate.memoryId)).toEqual(results.map(result => result.memory.id));
  });

  it('erases a record from the candidate set it was never returned in', () => {
    const db = memory({ path: location() });
    const ids = seed(db);
    db.recall({ query: 'catalogue owner approval', limit: 1 });
    const before = db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
    // The record to erase is one that was CONSIDERED and not returned — exactly the
    // identity the new table introduces and the old one never held.
    const considered = before.candidates.filter(candidate => candidate.stage === 'fused').map(candidate => candidate.memoryId);
    const erased = considered.find(id => id !== before.results[0].memoryId)!;
    expect(ids).toContain(erased);

    db.forget(erased);
    const after = db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
    expect(after.candidates.map(candidate => candidate.memoryId)).not.toContain(erased);
    // The fact that a retrieval happened, and how deep it went, survives.
    expect(after.candidateCounts.find(count => count.stage === 'fused')!.total).toBe(before.candidateCounts.find(count => count.stage === 'fused')!.total);
  });

  it('reads a ledger written before the candidate schema without inventing what it did not record', () => {
    const path = location();
    const first = createLocalMemory({ path, workspaceId: 'project', agentId: 'alice', retrieval: 'lexical' });
    first.store(fact('Catalogue exports need approval from the owner.'));
    first.recall({ query: 'catalogue approval', limit: 3 });
    const legacyId = first.lastRetrievalId!;
    first.close();

    // Rewrite that entry as a pre-T1.5 payload: no schema marker, no config, no candidates.
    const raw = new DatabaseSync(path);
    const row = raw.prepare('SELECT data FROM local_ledger WHERE id=?').get(legacyId) as { data: string };
    const payload = JSON.parse(row.data) as { retrieval: Record<string, unknown> };
    for (const key of ['schema', 'config', 'configSha256', 'candidateCounts', 'verifier']) delete payload.retrieval[key];
    raw.prepare('UPDATE local_ledger SET data=? WHERE id=?').run(JSON.stringify(payload), legacyId);
    raw.prepare('DELETE FROM local_ledger_candidates WHERE ledger_id=?').run(legacyId);
    raw.close();

    const reopened = createLocalMemory({ path, workspaceId: 'project', agentId: 'alice', retrieval: 'lexical' });
    opened.push(reopened);
    const retrieval = reopened.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
    expect(retrieval.schema).toBe(1);
    expect(retrieval.config).toBeUndefined();
    expect(retrieval.configSha256).toBeUndefined();
    expect(retrieval.candidates).toEqual([]);
    expect(retrieval.candidateCounts).toEqual([]);
    expect(retrieval.verifier).toBeNull();
    // The parts it DID record are still read back intact.
    expect(retrieval.results.length).toBeGreaterThan(0);
    expect(retrieval.querySha256).toBe(sha('catalogue approval'));
    // and a new retrieval on the same database records the full schema.
    reopened.recall({ query: 'catalogue approval', limit: 3 });
    expect(reopened.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!.schema).toBe(2);
  });
});
