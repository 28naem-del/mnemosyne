import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalMemory, type DenseIndexMode, type LocalMemory, type StoredEmbedding } from '../src/local/index.js';
import { hnswAvailable } from '../src/local/vector/index.js';
import { gatedIt } from './env-gates.js';

// A deterministic four-dimensional embedder: no model, no network.
const vector = (text: string) => [1, text.length % 7, text.includes('Atlas') ? 3 : 0, 1];
const embedder = Object.freeze({
  model: 'test-import-embedder@1', dimensions: 4,
  embedSync: (texts: readonly string[]) => texts.map(vector),
  embed: async (texts: readonly string[]) => texts.map(vector),
  forQueries: () => ({ model: 'test-import-embedder@1', dimensions: 4, embed: async (texts: readonly string[]) => texts.map(vector) }),
  forPassages: () => ({ model: 'test-import-embedder@1', dimensions: 4, embed: async (texts: readonly string[]) => texts.map(vector) }),
  close: () => {},
});
const packed = (values: number[]) => new Uint8Array(Float32Array.from(values).buffer);
const opened: LocalMemory[] = [], roots: string[] = [];
function memory(path = ':memory:', indexMode: DenseIndexMode = 'exact') { const db = createLocalMemory({ path, agentId: 'alice', workspaceId: 'test', retrieval: 'hybrid', embedder, indexMode }); opened.push(db); return db; }
function file() { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-import-embeddings-')); roots.push(root); return join(root, 'memory.sqlite'); }
afterEach(() => { opened.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('imported embeddings', () => {
  it('rejects packed vectors with non-finite values or a zero norm, and writes nothing', () => {
    const source = memory(); source.store({ text: 'Atlas deployment needs two reviewers.', source: { uri: 'test:source' }, trust: 'observed' });
    expect(source.recall({ query: 'Atlas deployment' })).toHaveLength(1);
    const [row] = source.exportEmbeddings(); expect(row.data).toBeInstanceOf(Uint8Array);
    const target = memory(); target.import(source.export());
    for (const values of [[Number.NaN, 1, 0, 0], [1, Number.POSITIVE_INFINITY, 0, 0], [0, 0, Number.NEGATIVE_INFINITY, 1], [0, 0, 0, 0]]) {
      const bad: StoredEmbedding = { ...row, data: packed(values) };
      expect(() => target.importEmbeddings([row, bad])).toThrow('finite float32 values with a nonzero norm');
    }
    expect(() => target.importEmbeddings([{ ...row, data: JSON.stringify([Number.MAX_VALUE, Number.MAX_VALUE, 0, 0]) }])).toThrow('finite');
    expect(target.exportEmbeddings()).toEqual([]);
    expect(target.importEmbeddings([row])).toEqual({ imported: 1, skipped: 0 });
    expect(target.recall({ query: 'Atlas deployment' }).map(result => result.memory.text)).toEqual(['Atlas deployment needs two reviewers.']);
  });

  const corrupt = (indexMode: DenseIndexMode) => () => {
    const path = file(), db = memory(path, indexMode);
    const record = db.store({ text: 'Atlas deployment needs two reviewers.', source: { uri: 'test:source' }, trust: 'observed' });
    db.store({ text: 'The garden fence was painted blue.', source: { uri: 'test:other' }, trust: 'observed' });
    db.recall({ query: 'Atlas deployment' });
    const [good] = db.exportEmbeddings().filter(row => row.memoryId === record.id);
    // A row written before import validation, or damaged on disk.
    const raw = new DatabaseSync(path); raw.prepare('UPDATE local_embeddings SET data=? WHERE memory_id=?').run(packed([Number.NaN, 1, 0, 0]), record.id); raw.close();
    expect(db.recall({ query: 'Atlas deployment' }).map(result => result.memory.id)).toContain(record.id);
    expect(db.recall({ query: 'Atlas deployment' }).map(result => result.memory.id)).toContain(record.id);
    const [repaired] = db.exportEmbeddings().filter(row => row.memoryId === record.id);
    expect(repaired.sourceHash).toBe(good.sourceHash); expect(repaired.data).toEqual(good.data);
    // Reopened, the dense index is caught up from the repaired table.
    db.close(); expect(memory(path, indexMode).recall({ query: 'Atlas deployment' }).map(result => result.memory.id)).toContain(record.id);
  };
  it.each(['exact', 'sqlite-vec'] as const)('skips a corrupt stored vector in %s search and re-embeds it on the next recall', mode => corrupt(mode)());
  gatedIt('hnsw', hnswAvailable())('skips a corrupt stored vector in hnsw search and re-embeds it on the next recall', corrupt('hnsw'));
});
