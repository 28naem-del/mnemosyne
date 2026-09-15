import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions, type StoreMemoryInput, type SyncMemoryEmbedder } from '../src/local/index.js';

/**
 * Fusing the coarser indexes back into turn-level retrieval.
 *
 * The contract under test is narrow and it is the whole point of the feature:
 * a session or summary hit may CARRY its member turns into the candidate pool,
 * it may never BE a result, and it may never cost a turn-level candidate its
 * place. And none of it happens unless the caller asks for it.
 */

const opened: LocalMemory[] = [];
const roots: string[] = [];
const source = { uri: 'test://granularity/fusion' };
function location(): string { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-fusion-')); roots.push(root); return join(root, 'memory.sqlite'); }
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

function memory(options: Partial<LocalMemoryOptions> = {}): LocalMemory {
  const db = createLocalMemory({ path: ':memory:', workspaceId: 'project', agentId: 'alice', embedder: stubEmbedder(), reranker: null, ...options });
  opened.push(db); return db;
}

const QUERY = 'catalogue export approval owner';

/** One session the query reaches, whose last three turns answer only in context,
 * and two sessions of plausible neighbours that share no term with the query — so
 * a turn that rises must have risen because of its session, not its own text. */
const CONVERSATION: Record<string, string[]> = {
  'session-approval': [
    'Catalogue exports need approval from the owner before release.',
    'The owner signs the catalogue export approval each quarter.',
    'Approval is recorded against the catalogue export in the release log.',
    'Yeah, I did that too, back in the spring.',
    'She was travelling at the time, so it slipped by a week.',
    'Everything went out on the Friday in the end.',
  ],
  'session-canvas': [
    'The drawing surface is 1200 by 900 pixels.',
    'Presets are stored beside the rendering profiles.',
    'A wider surface needs a different rendering profile.',
    'Nobody has changed the presets since March.',
    'The renderer was rewritten last year.',
    'Rendering time is dominated by the blur pass.',
  ],
  'session-coffee': [
    'The office coffee machine was replaced in June.',
    'The old machine went to the second floor kitchen.',
    'Beans are ordered monthly from the same supplier.',
    'Someone keeps leaving the grinder unlocked.',
    'The service contract runs until next October.',
    'A second machine is being considered for the annexe.',
  ],
};

function populate(db: LocalMemory): Record<string, string[]> {
  const ids: Record<string, string[]> = {};
  for (const [sessionId, texts] of Object.entries(CONVERSATION)) {
    ids[sessionId] = texts.map(text => db.store({ text, source, trust: 'observed', metadata: { sessionId } } satisfies StoreMemoryInput).id);
  }
  return ids;
}

const fused = (db: LocalMemory): { memoryId: string; granularity?: string }[] =>
  db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!.candidates.filter(candidate => candidate.stage === 'fused');

describe('the default path does not know the derived index exists', () => {
  it('returns byte-identical results whether or not the derived index was ever built', async () => {
    const db = memory();
    populate(db);
    const shape = (input: Parameters<LocalMemory['recall']>[0]): string => JSON.stringify(db.recall(input));
    // The same database before and after the index exists, so the comparison is
    // over the same record identities and any difference at all would be real.
    const bare = shape({ query: QUERY, limit: 8 });
    await db.indexGranularity({ embedder: stubEmbedder() });
    expect(shape({ query: QUERY, limit: 8 })).toEqual(bare);
    expect(shape({ query: QUERY, limit: 8, granularity: 'turn' })).toEqual(bare);
    expect(shape({ query: QUERY, limit: 8, granularity: 'multi' })).not.toEqual(bare);
  });

  it('labels every candidate as coming from the turn index and records no derived channels', async () => {
    const db = memory();
    populate(db);
    await db.indexGranularity();
    db.recall({ query: QUERY, limit: 5 });
    const entry = db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
    expect(entry.granularity).toBeUndefined();
    expect(new Set(entry.candidates.map(candidate => candidate.granularity))).toEqual(new Set(['turn']));
  });

  it('reads a candidate recorded before the column existed as what it was: turn-level', async () => {
    const path = location();
    const db = memory({ path });
    populate(db);
    db.recall({ query: QUERY, limit: 3 });
    db.close(); opened.splice(opened.indexOf(db), 1);
    const raw = new DatabaseSync(path);
    try { raw.exec('UPDATE local_ledger_candidates SET granularity=NULL'); } finally { raw.close(); }
    const reopened = memory({ path });
    expect(new Set(fused(reopened).map(candidate => candidate.granularity))).toEqual(new Set(['turn']));
  });

  it('says so instead of going quiet when the zero-model path is asked for multi', () => {
    const db = memory({ retrieval: 'lexical', embedder: undefined });
    populate(db);
    expect(db.recall({ query: QUERY, limit: 3, granularity: 'multi' }).length).toBeGreaterThan(0);
    expect(db.retrieval.granularityDegraded).toMatch(/hybrid/);
  });

  it('rejects a granularity it does not implement rather than falling back to one it does', () => {
    const db = memory();
    populate(db);
    expect(() => db.recall({ query: QUERY, granularity: 'session' as never })).toThrow('granularity');
  });
});

describe('a session hit carries its member turns, and nothing else', () => {
  it('surfaces the turns that answer only in context, which turn-level retrieval ranks out of reach', async () => {
    const db = memory();
    const ids = populate(db);
    await db.indexGranularity();
    const session = new Set(ids['session-approval']);
    const before = db.recall({ query: QUERY, limit: 6 }).map(hit => hit.memory.id);
    const after = db.recall({ query: QUERY, limit: 6, granularity: 'multi' }).map(hit => hit.memory.id);
    // "Everything went out on the Friday in the end" shares no term with the
    // query and is evidence only because of the turns above it. Turn-level
    // retrieval puts it last of eighteen; its session puts it sixth.
    expect(before.filter(id => session.has(id)).length).toBeLessThan(6);
    expect(before).not.toContain(ids['session-approval'][5]);
    expect(after.filter(id => session.has(id))).toHaveLength(6);
  });

  it('returns turn-level records only: a derived document is never a result', async () => {
    const db = memory();
    const ids = populate(db);
    await db.indexGranularity();
    const known = new Set(Object.values(ids).flat());
    const results = db.recall({ query: QUERY, limit: 8, granularity: 'multi' });
    expect(results.length).toBeGreaterThan(0);
    for (const hit of results) {
      expect(known.has(hit.memory.id)).toBe(true);
      expect(hit.memory.text).toBe(db.get(hit.memory.id)!.text);
    }
  });

  it('never costs a turn-level candidate its place: the multi pool is a superset of the turn pool', async () => {
    const db = memory();
    populate(db);
    await db.indexGranularity();
    db.recall({ query: QUERY, limit: 4 });
    const turnOnly = fused(db).map(candidate => candidate.memoryId);
    db.recall({ query: QUERY, limit: 4, granularity: 'multi' });
    const multi = fused(db).map(candidate => candidate.memoryId);
    for (const id of turnOnly) expect(multi).toContain(id);
    expect(multi.length).toBeGreaterThanOrEqual(turnOnly.length);
  });

  it('records which index nominated each candidate, and what the derived channels did', async () => {
    const db = memory();
    populate(db);
    // With the derived documents embedded, all four channels are live.
    await db.indexGranularity({ embedder: stubEmbedder() });
    db.recall({ query: QUERY, limit: 4, granularity: 'multi' });
    const entry = db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!;
    const summary = entry.granularity!;
    expect(summary.mode).toBe('multi');
    // Four channels: each level scored by each of the two retrievers.
    expect(summary.channels.map(channel => `${channel.level}:${channel.channel}`))
      .toEqual(['session:lexical', 'summary:lexical', 'session:dense', 'summary:dense']);
    for (const channel of summary.channels) expect(channel.expandedDocs).toBeGreaterThan(0);
    for (const channel of summary.channels) expect(channel.expandedTurns).toBeLessThanOrEqual(24);
    expect(summary.reserved).toBeLessThanOrEqual(16);
    const origins = new Set(fused(db).map(candidate => candidate.granularity));
    expect([...origins].some(origin => origin!.includes('session') || origin!.includes('summary'))).toBe(true);
    // A record the turn indexes nominated directly still says so, even when a
    // window nominated it as well.
    expect([...origins].some(origin => origin!.startsWith('turn'))).toBe(true);
  });

  it('expands nothing once its members are erased, on the same call that would have used them', async () => {
    const db = memory();
    const ids = populate(db);
    await db.indexGranularity();
    expect(db.recall({ query: QUERY, limit: 6, granularity: 'multi' }).map(hit => hit.memory.id)).toContain(ids['session-approval'][5]);
    db.forget(ids['session-approval'][0]);
    const after = db.recall({ query: QUERY, limit: 6, granularity: 'multi' });
    expect(after.map(hit => hit.memory.id)).not.toContain(ids['session-approval'][5]);
    expect(db.ledger({ events: ['recall'] }).entries.at(-1)!.retrieval!.granularity!.channels.every(channel => channel.expandedDocs === 0)).toBe(true);
  });
});

describe('the asynchronous and packing paths carry the flag too', () => {
  it('fuses the derived indexes on recallHybrid and still returns turn-level records', async () => {
    const db = memory();
    const ids = populate(db);
    await db.indexGranularity();
    const embedder = stubEmbedder();
    await db.indexEmbeddings({ embedder });
    const known = new Set(Object.values(ids).flat());
    const results = await db.recallHybrid({ query: QUERY, limit: 6, granularity: 'multi' }, { embedder });
    expect(results.length).toBeGreaterThan(0);
    for (const hit of results) expect(known.has(hit.memory.id)).toBe(true);
    expect(results.map(hit => hit.memory.id)).toContain(ids['session-approval'][5]);
  });

  it('packs a context window from the multi-granularity ranking', async () => {
    const db = memory();
    populate(db);
    await db.indexGranularity();
    const packet = db.compile({ query: QUERY, maxTokens: 4000, granularity: 'multi' });
    expect(packet.citations.length).toBeGreaterThan(0);
    const embedder = stubEmbedder();
    await db.indexEmbeddings({ embedder });
    const hybrid = await db.compileHybrid({ query: QUERY, maxTokens: 4000, granularity: 'multi' }, { embedder });
    expect(hybrid.citations.length).toBeGreaterThan(0);
  });
});
