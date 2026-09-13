import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';

const connections: (LocalMemory | DatabaseSync)[] = [];
const directories: string[] = [];
function location() { const directory = mkdtempSync(join(tmpdir(), 'mnemosyne-posting-layout-')); directories.push(directory); return join(directory, 'memory.sqlite'); }
function memory(path: string) { const db = createLocalMemory({ path, workspaceId: 'fixture', agentId: 'owner' }); connections.push(db); return db; }
function sqlite(path: string) { const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys=ON;'); connections.push(db); return db; }
const source = { uri: 'test:posting-layout' };
afterEach(() => { connections.splice(0).reverse().forEach(db => db.close()); directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });

describe('compact posting storage without changing memory semantics', () => {
  it('retains both lookup orders, duplicate/FK constraints and source-deletion cascades', () => {
    const path = location(); const db = memory(path);
    const original = db.store({ text: 'Café release café', source, trust: 'observed' });
    const derived = db.store({ text: 'Release procedure', source, trust: 'observed', dependencies: [original.id] });
    const raw = sqlite(path);
    const layout = raw.prepare("SELECT wr FROM pragma_table_list WHERE name='local_terms'").get() as { wr: number };
    expect(layout.wr).toBe(1);
    const indexes = raw.prepare('PRAGMA index_list(local_terms)').all() as { name: string; origin: string }[];
    expect(indexes.some(index => index.origin === 'pk')).toBe(true);
    expect(indexes.some(index => index.name === 'local_terms_term')).toBe(true);
    expect(raw.prepare('SELECT term FROM local_terms WHERE memory_id=? ORDER BY term').all(original.id)).toEqual([{ term: 'cafe' }, { term: 'release' }]);
    expect(() => raw.prepare('INSERT INTO local_terms(memory_id,term) VALUES(?,?)').run(original.id, 'cafe')).toThrow(/UNIQUE/);
    expect(() => raw.prepare('INSERT INTO local_terms(memory_id,term) VALUES(?,?)').run('missing-memory', 'orphan')).toThrow(/FOREIGN KEY/);
    expect(db.recall({ query: 'cafe' }).map(hit => hit.memory.id)).toEqual([original.id]);
    expect(db.forget(original.id).deletedIds.sort()).toEqual([original.id, derived.id].sort());
    expect(raw.prepare('SELECT count(*) AS count FROM local_terms').get()).toEqual({ count: 0 });
    expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('opens existing rowid posting tables without rebuilding or losing records', () => {
    const path = location(); const db = memory(path); const original = db.store({ text: 'Legacy orchid evidence', source, trust: 'observed' });
    db.close(); connections.splice(connections.indexOf(db), 1);
    const raw = sqlite(path);
    // Reproduce the previous derived-table layout in this isolated fixture.
    raw.exec(`BEGIN IMMEDIATE;
      ALTER TABLE local_terms RENAME TO previous_postings;
      CREATE TABLE local_terms(memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE, term TEXT NOT NULL, PRIMARY KEY(memory_id,term));
      INSERT INTO local_terms(memory_id,term) SELECT memory_id,term FROM previous_postings;
      DROP TABLE previous_postings;
      CREATE INDEX local_terms_term ON local_terms(term,memory_id);
      COMMIT;`);
    raw.close(); connections.splice(connections.indexOf(raw), 1);
    const reopened = memory(path); const check = sqlite(path);
    expect(check.prepare("SELECT wr FROM pragma_table_list WHERE name='local_terms'").get()).toEqual({ wr: 0 });
    expect(reopened.get(original.id)).toEqual(original);
    expect(reopened.recall({ query: 'orchid' }).map(hit => hit.memory.id)).toEqual([original.id]);
    const additional = reopened.store({ text: 'Additional orchid evidence', source, trust: 'observed' });
    expect(reopened.recall({ query: 'orchid' }).map(hit => hit.memory.id).sort()).toEqual([original.id, additional.id].sort());
    reopened.forget(original.id);
    expect(reopened.recall({ query: 'orchid' }).map(hit => hit.memory.id)).toEqual([additional.id]);
    expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
