import { afterEach, describe, expect } from 'vitest';
import { gatedIt } from './env-gates.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions } from '../src/local/index.js';
import type { SyncMemoryEmbedder } from '../src/local/types.js';
import { hnswAvailable } from '../src/local/vector/index.js';

/**
 * An HNSW graph lives in the process that opened it. Two connections on one
 * database file each keep their own; what one indexes must still reach the
 * other's dense channel.
 */

const opened: LocalMemory[] = [];
const roots: string[] = [];
function location(): string { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-hnsw-conn-')); roots.push(root); return join(root, 'memory.sqlite'); }
afterEach(() => { opened.splice(0).forEach(db => { try { db.close(); } catch { /* already closed */ } }); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

/** Vectors by topic word, so a query can reach a record densely while sharing
 * no token with it (and so cannot be found by the lexical channel). */
const TOPICS: [RegExp, number][] = [[/sunrise|dawn/, 0], [/invoice|billing/, 1], [/garden|soil/, 2], [/engine|gearbox/, 3]];
function topicEmbedder(): SyncMemoryEmbedder {
  const encode = (text: string): number[] => {
    const vector = [0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
    for (const [pattern, axis] of TOPICS) if (pattern.test(text.toLowerCase())) vector[axis] += 1;
    const norm = Math.hypot(...vector);
    return vector.map(value => value / norm);
  };
  const self: SyncMemoryEmbedder = { model: 'topic-embedder@v1', dimensions: 6, embedSync: (texts) => texts.map(encode), embed: async (texts) => texts.map(encode), forQueries: () => self, forPassages: () => self, close: () => {} };
  return self;
}
function open(path: string, options: Partial<LocalMemoryOptions> = {}): LocalMemory {
  const db = createLocalMemory({ path, workspaceId: 'project', agentId: 'alice', embedder: topicEmbedder(), rerank: false, indexMode: 'hnsw', ...options });
  opened.push(db); return db;
}
const source = { uri: 'test://hnsw-connections' };

describe('hnsw across connections', () => {
  const withHnsw = gatedIt('hnsw', hnswAvailable());

  withHnsw('a reader finds records another connection indexed after the reader opened its graph', () => {
    const path = location();
    const reader = open(path), writer = open(path);
    reader.store({ text: 'The invoice run closes on Fridays.', source, trust: 'observed' });
    reader.store({ text: 'Compost the garden beds in autumn.', source, trust: 'observed' });
    // The reader resolves its graph now, before the writer adds anything.
    expect(reader.recall({ query: 'billing', limit: 5 }).map(hit => hit.memory.text)).toContain('The invoice run closes on Fridays.');

    const added = writer.store({ text: 'Rangers patrol the ridge before sunrise.', source, trust: 'observed' });
    // The writer's recall embeds the new record and labels it in its own graph.
    expect(writer.recall({ query: 'dawn', limit: 1 }).map(hit => hit.memory.id)).toEqual([added.id]);

    // 'dawn' shares no token with the record, so only the dense channel can find it.
    expect(reader.recall({ query: 'dawn', limit: 1 }).map(hit => hit.memory.id)).toEqual([added.id]);
    expect(reader.retrieval.index).toMatchObject({ mode: 'hnsw', size: 3 });
  });

  withHnsw('an erasure made by another connection is withheld from the reader at once', () => {
    const path = location();
    const reader = open(path), writer = open(path);
    const record = writer.store({ text: 'The gearbox needs new bearings.', source, trust: 'observed' });
    expect(writer.recall({ query: 'engine', limit: 1 }).map(hit => hit.memory.id)).toEqual([record.id]);
    expect(reader.recall({ query: 'engine', limit: 1 }).map(hit => hit.memory.id)).toEqual([record.id]);
    writer.forget(record.id);
    expect(reader.recall({ query: 'engine', limit: 1 })).toEqual([]);
  });

  withHnsw('the reader agrees with the exact scan after interleaved writes from two connections', () => {
    const path = location();
    const first = open(path), second = open(path);
    const texts = ['Sunrise over the bay.', 'Billing disputes go to finance.', 'Soil tests in spring.', 'Engine oil every 10k.', 'Dawn chorus recordings.', 'Invoice numbering rules.'];
    texts.forEach((text, index) => {
      const db = index % 2 ? second : first;
      db.store({ text, source, trust: 'observed' });
      db.recall({ query: text, limit: 1 });
    });
    const exact = open(path, { indexMode: 'exact' });
    for (const query of ['dawn', 'billing', 'soil', 'gearbox']) {
      const expected = exact.recall({ query, limit: 3 }).map(hit => hit.memory.id);
      expect(first.recall({ query, limit: 3 }).map(hit => hit.memory.id), query).toEqual(expected);
      expect(second.recall({ query, limit: 3 }).map(hit => hit.memory.id), query).toEqual(expected);
    }
  });
});
