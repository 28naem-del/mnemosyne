import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContextPassage, contextBudget, type ContextNeighbour } from '../src/local/reranking/context.js';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions, type StoreMemoryInput, type SyncMemoryEmbedder, type SyncMemoryReranker } from '../src/local/index.js';

/**
 * Reranking a turn together with its in-session neighbours.
 *
 * The contract has three halves and each is tested where it lives: the passage is
 * assembled deterministically and the candidate always survives it; the
 * neighbourhood comes from the derived index and stops at the session's edges;
 * and with the feature off the reranker sees byte-identical input to today's.
 */

const opened: LocalMemory[] = [];
const roots: string[] = [];
const source = { uri: 'test://rerank/context' };
function location(): string { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-rerank-context-')); roots.push(root); return join(root, 'memory.sqlite'); }
afterEach(() => { opened.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

/** One piece per whitespace-delimited word: enough to make a budget bite. */
const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

describe('the passage a context-aware rerank scores', () => {
  const neighbours = (...entries: [number, string][]): ContextNeighbour[] =>
    entries.map(([offset, text]) => ({ id: `n${offset}`, offset, text }));

  it('leads with the candidate, which is what makes truncation safe', () => {
    const passage = buildContextPassage('the candidate turn', neighbours([-1, 'before it'], [1, 'after it']), { maxTokens: 64, count: words });
    expect(passage.startsWith('the candidate turn')).toBe(true);
    expect(passage).toContain('before it');
    expect(passage).toContain('after it');
  });

  it('lays the block out in session order even though it admits nearest-first', () => {
    const passage = buildContextPassage('C', neighbours([2, 'plus two'], [-2, 'minus two'], [1, 'plus one'], [-1, 'minus one']), { maxTokens: 64, count: words });
    expect(passage).toBe('C\nminus two\nminus one\nplus one\nplus two');
  });

  it('skips a neighbour that does not fit instead of truncating it or stopping', () => {
    // -1 is offered first and is too long; -2 is offered last and fits. A rule
    // that stopped at the first miss would lose it, and one that truncated would
    // put half a sentence in front of the model.
    const passage = buildContextPassage('C', neighbours([-1, 'one two three four five six'], [-2, 'short']), { maxTokens: 3, count: words });
    expect(passage).toBe('C\nshort');
    expect(passage).not.toContain('one two three');
  });

  it('returns the candidate unchanged when nothing fits, byte for byte', () => {
    expect(buildContextPassage('C', neighbours([-1, 'too long by far']), { maxTokens: 1, count: words })).toBe('C');
    expect(buildContextPassage('C', neighbours([-1, 'anything']), { maxTokens: 0, count: words })).toBe('C');
    expect(buildContextPassage('C', [], { maxTokens: 64, count: words })).toBe('C');
  });

  it('is deterministic: the input order of the neighbours cannot change the result', () => {
    const forward = neighbours([-2, 'a'], [-1, 'b'], [1, 'c'], [2, 'd']);
    const shuffled = [forward[2], forward[0], forward[3], forward[1]];
    const budget = { maxTokens: 3, count: words };
    expect(buildContextPassage('C', shuffled, budget)).toBe(buildContextPassage('C', forward, budget));
    // Three of four fit, and which three is decided by distance and then by
    // preferring the earlier turn, never by input order: -1, +1, -2 are admitted
    // and +2 is the one left out.
    expect(buildContextPassage('C', shuffled, budget)).toBe('C\na\nb\nc');
  });

  it('spends nothing on a candidate that already fills the pair', () => {
    expect(contextBudget(10, 400, 192)).toBe(99);
    expect(contextBudget(10, 500, 192)).toBe(0);
    expect(contextBudget(10, 40, 192)).toBe(192);
  });
});

/* ------------------------------------------------------------------------- */

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

/** Records every array it is handed, so a test can assert on what the model saw. */
function recordingReranker(score: (passage: string) => number, counts = true): SyncMemoryReranker & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model: 'test-stub-reranker@v1', calls,
    rerankSync: (_query, passages) => { calls.push([...passages]); return passages.map(score); },
    ...(counts ? { countTokens: words } : {}),
    close: () => {},
  } as SyncMemoryReranker & { calls: string[][] };
}

const QUERY = 'catalogue export approval owner';

/** The same shape the fusion suite uses: one session the query reaches whose later
 * turns answer only in context, and two sessions of plausible strangers. */
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
};

function seeded(options: Partial<LocalMemoryOptions> = {}): { db: LocalMemory; ids: Record<string, string[]> } {
  const db = createLocalMemory({ path: ':memory:', workspaceId: 'project', agentId: 'alice', embedder: stubEmbedder(), ...options });
  opened.push(db);
  const ids: Record<string, string[]> = {};
  for (const [sessionId, texts] of Object.entries(CONVERSATION)) {
    ids[sessionId] = texts.map(text => db.store({ text, source, trust: 'observed', metadata: { sessionId } } satisfies StoreMemoryInput).id);
  }
  return { db, ids };
}

describe('with the feature off, the reranker sees exactly what it sees today', () => {
  it('makes one call with bare record text when rerankContext is left at its default', async () => {
    const reranker = recordingReranker(() => 0);
    const { db } = seeded({ reranker });
    await db.indexGranularity({ embedder: stubEmbedder() });
    db.recall({ query: QUERY, limit: 6, granularity: 'multi' });
    expect(reranker.calls).toHaveLength(1);
    const known = new Set(Object.values(CONVERSATION).flat());
    for (const passage of reranker.calls[0]) expect(known.has(passage)).toBe(true);
  });

  it('stays off on the turn path even when the radius is set', async () => {
    const reranker = recordingReranker(() => 0);
    const { db } = seeded({ reranker, granularity: { rerankContext: 2 } });
    await db.indexGranularity({ embedder: stubEmbedder() });
    db.recall({ query: QUERY, limit: 6 });
    db.recall({ query: QUERY, limit: 6, granularity: 'turn' });
    expect(reranker.calls).toHaveLength(2);
    const known = new Set(Object.values(CONVERSATION).flat());
    for (const call of reranker.calls) for (const passage of call) expect(known.has(passage)).toBe(true);
  });

  it('stands down rather than guessing when the reranker cannot count its own tokens', async () => {
    const reranker = recordingReranker(() => 0, false);
    const { db } = seeded({ reranker, granularity: { rerankContext: 2 } });
    await db.indexGranularity({ embedder: stubEmbedder() });
    db.recall({ query: QUERY, limit: 6, granularity: 'multi' });
    expect(reranker.calls).toHaveLength(1);
  });

  it('refuses a radius it does not implement rather than silently clamping it', () => {
    expect(() => createLocalMemory({ path: ':memory:', workspaceId: 'project', agentId: 'alice', granularity: { rerankContext: 9 } })).toThrow('rerankContext');
    expect(() => createLocalMemory({ path: ':memory:', workspaceId: 'project', agentId: 'alice', granularity: { rerankContextTokens: 9999 } })).toThrow('rerankContextTokens');
  });
});

describe('with the feature on, a second pass scores each candidate in its neighbourhood', () => {
  it('makes a second call whose passages lead with the candidate and carry its neighbours', async () => {
    const reranker = recordingReranker(() => 0);
    const { db } = seeded({ reranker, granularity: { rerankContext: 2 } });
    await db.indexGranularity({ embedder: stubEmbedder() });
    db.recall({ query: QUERY, limit: 6, granularity: 'multi' });
    expect(reranker.calls).toHaveLength(2);
    const [isolated, windowed] = reranker.calls;
    expect(windowed).toHaveLength(isolated.length);
    // Every windowed passage is its own isolated passage plus more, in that order.
    windowed.forEach((passage, index) => expect(passage.startsWith(isolated[index])).toBe(true));
    expect(windowed.some((passage, index) => passage.length > isolated[index].length)).toBe(true);
    // A turn that is evidence only in context now arrives with the turns above it.
    const orphan = windowed.find(passage => passage.startsWith('Everything went out on the Friday in the end.'));
    expect(orphan).toBeDefined();
    expect(orphan).toContain('She was travelling at the time');
    expect(orphan).toContain('Yeah, I did that too');
  });

  it('stops at the session edges and never crosses into another conversation', async () => {
    const reranker = recordingReranker(() => 0);
    const { db } = seeded({ reranker, granularity: { rerankContext: 2 } });
    await db.indexGranularity({ embedder: stubEmbedder() });
    db.recall({ query: QUERY, limit: 6, granularity: 'multi' });
    const windowed = reranker.calls[1];
    const first = windowed.find(passage => passage.startsWith(CONVERSATION['session-approval'][0]))!;
    const last = windowed.find(passage => passage.startsWith(CONVERSATION['session-approval'][5]))!;
    expect(first).toBeDefined(); expect(last).toBeDefined();
    // The session's first turn has no turn before it and its last has none after.
    expect(first.split('\n')).toEqual([CONVERSATION['session-approval'][0], CONVERSATION['session-approval'][1], CONVERSATION['session-approval'][2]]);
    expect(last.split('\n')).toEqual([CONVERSATION['session-approval'][5], CONVERSATION['session-approval'][3], CONVERSATION['session-approval'][4]]);
    for (const passage of windowed) {
      const lines = new Set(passage.split('\n'));
      for (const [sessionId, texts] of Object.entries(CONVERSATION)) {
        if (texts.some(text => lines.has(text))) expect(Object.entries(CONVERSATION).filter(([other]) => other !== sessionId).every(([, strangers]) => strangers.every(text => !lines.has(text)))).toBe(true);
      }
    }
  });

  it('is deterministic across repeated identical recalls', async () => {
    const reranker = recordingReranker(passage => passage.length % 7);
    const { db } = seeded({ reranker, granularity: { rerankContext: 2 } });
    await db.indexGranularity({ embedder: stubEmbedder() });
    const once = db.recall({ query: QUERY, limit: 6, granularity: 'multi' }).map(hit => hit.memory.id);
    const twice = db.recall({ query: QUERY, limit: 6, granularity: 'multi' }).map(hit => hit.memory.id);
    expect(twice).toEqual(once);
    expect(reranker.calls[3]).toEqual(reranker.calls[1]);
  });

  it('composes as a third channel: the same database reranks differently with it and without it', async () => {
    // ONE database, opened twice. Record identities, fused scores and every
    // tiebreak are therefore identical between the two recalls, so any difference
    // in the ranking is the third channel and nothing else.
    //
    // "approval" appears in the first three turns and nowhere else, so this
    // reranker scores exactly those three in isolation. At radius 2 it also scores
    // turns 3 and 4, which borrow the word from the turns above them, and NOT turn
    // 5, whose window reaches back only as far as turn 3. That asymmetry is what
    // makes this a test of the neighbourhood rather than of the session.
    const path = location();
    const score = (passage: string): number => /approval/i.test(passage) ? 5 : 0;
    const first = seeded({ path, reranker: recordingReranker(score) });
    await first.db.indexGranularity({ embedder: stubEmbedder() });
    const borrowers = [3, 4].map(index => first.ids['session-approval'][index]);
    const owners = [0, 1, 2].map(index => first.ids['session-approval'][index]);
    const isolated = first.db.recall({ query: QUERY, limit: 12, granularity: 'multi' }).map(hit => hit.memory.id);
    first.db.close(); opened.splice(opened.indexOf(first.db), 1);

    const reopened = createLocalMemory({ path, workspaceId: 'project', agentId: 'alice', embedder: stubEmbedder(), reranker: recordingReranker(score), granularity: { rerankContext: 2 } });
    opened.push(reopened);
    const contextual = reopened.recall({ query: QUERY, limit: 12, granularity: 'multi' }).map(hit => hit.memory.id);

    const stranded = first.ids['session-approval'][5];
    const worst = (list: string[]): number => Math.max(...borrowers.map(id => list.indexOf(id)));
    // What is asserted here is the CONTRACT, not the size of the effect. On a
    // twelve-record corpus the fused ranking already holds every candidate, so a
    // third channel can leave the final order untouched; whether it moves real
    // numbers is a benchmark question and is answered by the LoCoMo gate, not by
    // a stub. What must hold on any corpus is the direction: a turn whose
    // neighbourhood explains it does not lose ground, and a turn whose
    // neighbourhood does not explain it gains none.
    //
    // The borrowers move up as a pair, or hold. Which of the two leads is decided
    // by a score tie and then by record id, so the pair is the honest unit here.
    expect(worst(contextual)).toBeLessThanOrEqual(worst(isolated));
    // THE CONTROL, and the reason this is a neighbourhood rather than the rejected
    // session endorsement: turn 5's window reaches back only as far as turn 3, so
    // it never sees the word, and it must not be carried along with its siblings.
    expect(contextual.indexOf(stranded)).toBeGreaterThanOrEqual(isolated.indexOf(stranded));
    // Composition, not replacement: the three turns the model could score on their
    // own stay at the top. A borrower may slot in among them — that is the point —
    // but the group is not displaced.
    for (const owner of owners) {
      expect(contextual.indexOf(owner)).toBeGreaterThanOrEqual(0);
      expect(contextual.indexOf(owner)).toBeLessThan(4);
    }
  });
});
