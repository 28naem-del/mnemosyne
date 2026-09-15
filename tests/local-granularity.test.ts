import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions, type StoreMemoryInput } from '../src/local/index.js';
import { lexicalDerived, type DerivedScan } from '../src/local/granularity.js';

const opened: LocalMemory[] = [];
const roots: string[] = [];
const source = { uri: 'test://granularity' };
const NOW = '2026-02-01T00:00:00.000Z';

function location(): string { const root = mkdtempSync(join(tmpdir(), 'mnemosyne-granularity-')); roots.push(root); return join(root, 'memory.sqlite'); }
function memory(options: Partial<LocalMemoryOptions> = {}): LocalMemory {
  const db = createLocalMemory({ path: ':memory:', workspaceId: 'project', agentId: 'alice', retrieval: 'lexical', now: () => new Date(NOW), ...options });
  opened.push(db); return db;
}
const turn = (text: string, sessionId: string, more: Partial<StoreMemoryInput> = {}): StoreMemoryInput =>
  ({ text, source, trust: 'observed', metadata: { sessionId }, ...more });
afterEach(() => { opened.splice(0).forEach(db => db.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

/** Two sessions, eight turns each, so the default six-turn window with a stride of
 * three produces overlapping windows rather than one window per session. */
const SESSIONS: Record<string, string[]> = {
  'session-a': [
    'Melanie restored the antique automobile she inherited from her grandfather.',
    'The gearbox needed a rebuild before anything else could be tested.',
    'She sourced a replacement carburettor from a specialist in Leeds.',
    'Yeah, I did that too, back when I had the workshop on Carlisle Road.',
    'The paintwork took three weekends and two full days of sanding.',
    'It passed its inspection in March with no advisories at all.',
    'Her brother borrowed it for a wedding in the Cotswolds.',
    'The insurance quote came back lower than the estimate she budgeted.',
  ],
  'session-b': [
    'Priya submitted the quarterly compliance filing on the Tuesday deadline.',
    'The auditors flagged two reconciliations that needed supporting documents.',
    'She pulled the bank statements and matched them line by line.',
    'Nothing was actually wrong; the timestamps were recorded in the wrong timezone.',
    'The finance team agreed to move the ledger export to UTC.',
    'Priya wrote the migration note and circulated it for review.',
    'The second filing went through without any auditor comments.',
    'She took the following Friday off, which she had earned several times over.',
  ],
};

function populate(db: LocalMemory): Record<string, string[]> {
  const ids: Record<string, string[]> = {};
  for (const [sessionId, texts] of Object.entries(SESSIONS)) ids[sessionId] = texts.map(text => db.store(turn(text, sessionId)).id);
  return ids;
}

function documents(path: string): { id: string; granularity: string; session_key: string; ordinal: number; text: string; source_hash: string; members: number }[] {
  const raw = new DatabaseSync(path);
  try { return raw.prepare('SELECT id,granularity,session_key,ordinal,text,source_hash,members FROM local_granularity_docs ORDER BY granularity,session_key,ordinal').all() as never; }
  finally { raw.close(); }
}

describe('the derived index is a deterministic, additive function of the records', () => {
  it('derives overlapping session windows and one summary per session, each pointing back at its members', async () => {
    const path = location();
    const db = memory({ path });
    const ids = populate(db);
    const result = await db.indexGranularity();
    expect(result).toMatchObject({ sessions: 2, unsessioned: 0, removed: 0, unchanged: 0, embedded: 0 });
    expect(result.inserted).toBe(result.documents);
    db.close(); opened.splice(opened.indexOf(db), 1);

    const rows = documents(path);
    expect(rows.filter(row => row.granularity === 'summary').map(row => row.session_key)).toEqual(['session-a', 'session-b']);
    // Eight members, six per window, stride three: windows at 0 and 3, the second
    // reaching the end. Overlap is the point — evidence split across a boundary is
    // still covered whole by a neighbour.
    expect(rows.filter(row => row.granularity === 'session' && row.session_key === 'session-a').map(row => row.ordinal)).toEqual([0, 1]);

    const raw = new DatabaseSync(path);
    try {
      const members = raw.prepare(`SELECT m.memory_id AS id FROM local_granularity_members m JOIN local_granularity_docs d ON d.id=m.doc_id
        WHERE d.granularity='session' AND d.session_key='session-a' AND d.ordinal=0 ORDER BY m.position`).all() as { id: string }[];
      expect(members.map(row => row.id)).toEqual(ids['session-a'].slice(0, 6));
      const summary = raw.prepare("SELECT memory_id AS id FROM local_granularity_members m JOIN local_granularity_docs d ON d.id=m.doc_id WHERE d.granularity='summary' AND d.session_key='session-a' ORDER BY m.position").all() as { id: string }[];
      expect(summary.map(row => row.id)).toEqual(ids['session-a']);
      // Every posting the derived lexical channel scores is a posting of a document
      // that exists; nothing is indexed for a document that was never written.
      const orphans = raw.prepare('SELECT count(*) AS count FROM local_granularity_terms WHERE doc_id NOT IN (SELECT id FROM local_granularity_docs)').get() as { count: number };
      expect(orphans.count).toBe(0);
    } finally { raw.close(); }
  });

  it('is idempotent: a second build inserts nothing and keeps what the first one wrote', async () => {
    const path = location();
    const db = memory({ path });
    populate(db);
    const first = await db.indexGranularity();
    const before = documents(path);
    const second = await db.indexGranularity();
    expect(second).toEqual({ ...first, inserted: 0, removed: 0, unchanged: first.documents });
    expect(documents(path)).toEqual(before);
  });

  it('produces the same documents from the same records in two independent databases', async () => {
    const left = location(), right = location();
    const one = memory({ path: left }), two = memory({ path: right });
    populate(one); populate(two);
    await one.indexGranularity(); await two.indexGranularity();
    // Member identities are random UUIDs and deliberately excluded here: what must
    // match is the derived identity, the derived text and the content hash.
    const shape = (path: string): unknown => documents(path).map(({ id, granularity, session_key, ordinal, text, members }) => ({ id, granularity, session_key, ordinal, text, members }));
    expect(shape(left)).toEqual(shape(right));
  });

  it('leaves records that declare no session turn-only, and says how many', async () => {
    const db = memory();
    populate(db);
    db.store({ text: 'A standalone note with no conversation around it.', source, trust: 'observed' });
    db.store({ text: 'Another one, filed under nothing in particular.', source, trust: 'observed', metadata: { topic: 'misc' } });
    expect(await db.indexGranularity()).toMatchObject({ sessions: 2, unsessioned: 2 });
  });

  it('reads whichever session key a record actually carries, in the configured order', async () => {
    const db = memory({ granularity: { sessionKeys: ['conversationId', 'sessionId'] } });
    db.store({ text: 'First turn of the thread.', source, trust: 'observed', metadata: { conversationId: 'c1', sessionId: 'ignored' } });
    db.store({ text: 'Second turn of the thread.', source, trust: 'observed', metadata: { sessionId: 'c1' } });
    const result = await db.indexGranularity();
    expect(result).toMatchObject({ sessions: 1, unsessioned: 0 });
    expect(result.documents).toBeGreaterThan(0);
  });

  it('rejects settings it cannot honour instead of silently clamping them', () => {
    expect(() => memory({ granularity: { windowStride: 9 } })).toThrow('windowStride');
    expect(() => memory({ granularity: { windowTurns: 0 } })).toThrow('windowTurns');
    expect(() => memory({ granularity: { weight: 9 } })).toThrow('weight');
    expect(() => memory({ granularity: { sessionKeys: [] } })).toThrow('sessionKeys');
    expect(() => memory({ granularity: { nope: 1 } as never })).toThrow('granularity');
  });
});

describe('a derived document can never outlive, out-scope or outrank its members', () => {
  it('is destroyed the moment any member is erased', async () => {
    const path = location();
    const db = memory({ path });
    const ids = populate(db);
    await db.indexGranularity();
    const before = documents(path);
    const target = ids['session-a'][4];
    db.forget(target);
    const after = documents(path);
    // Window 0 (members 0-5) and window 1 (members 3-7) both held it, as did the
    // summary. Session B is untouched, so erasure is complete without being broad.
    expect(after.filter(row => row.session_key === 'session-a')).toEqual([]);
    expect(after.filter(row => row.session_key === 'session-b')).toEqual(before.filter(row => row.session_key === 'session-b'));
    const raw = new DatabaseSync(path);
    try {
      const survivors = raw.prepare('SELECT count(*) AS count FROM local_granularity_members WHERE memory_id=?').get(target) as { count: number };
      expect(survivors.count).toBe(0);
      const text = raw.prepare("SELECT count(*) AS count FROM local_granularity_docs WHERE text LIKE '%three weekends%'").get() as { count: number };
      expect(text.count).toBe(0);
    } finally { raw.close(); }
  });

  it('is destroyed when any member is corrected, so no derived copy quotes superseded text', async () => {
    const path = location();
    const db = memory({ path });
    const ids = populate(db);
    await db.indexGranularity();
    // Member four sits in both windows, so nothing derived from this session
    // survives; a document holding a stale copy of corrected text would be worse
    // than no document at all.
    db.correct(ids['session-b'][4], { text: 'The finance team kept the ledger export local.', source, reason: 'wrong decision recorded' });
    expect(documents(path).filter(row => row.session_key === 'session-b')).toEqual([]);
    expect(documents(path).filter(row => row.session_key === 'session-a').length).toBeGreaterThan(0);
  });

  it('is invisible from a workspace that did not derive it', async () => {
    const path = location();
    const mine = memory({ path });
    populate(mine);
    await mine.indexGranularity();
    mine.close(); opened.splice(opened.indexOf(mine), 1);
    const raw = new DatabaseSync(path);
    try {
      const terms = ['antique', 'automobile', 'gearbox'];
      const scan = (workspaceId: string, agentId: string): DerivedScan => ({ workspaceId, agentId, asOf: NOW, knownAt: NOW });
      expect(lexicalDerived(raw, terms, scan('project', 'alice'), 20).length).toBeGreaterThan(0);
      expect(lexicalDerived(raw, terms, scan('other-project', 'alice'), 20)).toEqual([]);
      // Same workspace, different agent: private records make private documents,
      // so a peer agent sees nothing it could not already have recalled directly.
      expect(lexicalDerived(raw, terms, scan('project', 'bob'), 20)).toEqual([]);
    } finally { raw.close(); }
  });

  it('never surfaces before its last member exists or after its first member stops being valid', async () => {
    const path = location();
    const db = memory({ path });
    db.store(turn('The kiln reached temperature just after midnight.', 'session-c', { validUntil: '2026-03-01T00:00:00.000Z' }));
    db.store(turn('The glaze test tiles came out of the kiln unevenly fired.', 'session-c'));
    await db.indexGranularity();
    db.close(); opened.splice(opened.indexOf(db), 1);
    const raw = new DatabaseSync(path);
    try {
      const terms = ['kiln', 'glaze'];
      const at = (asOf: string, knownAt: string): DerivedScan => ({ workspaceId: 'project', agentId: 'alice', asOf, knownAt });
      expect(lexicalDerived(raw, terms, at(NOW, NOW), 20).length).toBeGreaterThan(0);
      expect(lexicalDerived(raw, terms, at(NOW, '2026-01-31T23:59:59.999Z'), 20)).toEqual([]);
      expect(lexicalDerived(raw, terms, at('2026-03-01T00:00:00.001Z', '2026-03-02T00:00:00.000Z'), 20)).toEqual([]);
    } finally { raw.close(); }
  });

  it('never derives from a record retrieval itself would refuse to return', async () => {
    const db = memory();
    db.store(turn('Untrusted turn about the antique automobile.', 'session-d', { trust: 'untrusted' }));
    db.store(turn('Advisory turn about the same automobile.', 'session-d', { metadata: { sessionId: 'session-d', advisory: 0 } }));
    expect(await db.indexGranularity()).toMatchObject({ sessions: 0, documents: 0 });
  });
});
