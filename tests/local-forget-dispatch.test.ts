import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory, type LocalMemory, type MemoryEmbedder } from '../src/local/index.js';
import { reflect } from '../src/reflection/index.js';

// A provider call is dispatched from a queued microtask, so a caller that starts
// the work and then forgets a record synchronously has already erased it by the
// time the call is made. What the provider receives must be read at dispatch.

const opened: LocalMemory[] = [];
const SECRET = 'Marigold vault combination is 4471';
afterEach(() => { for (const memory of opened.splice(0)) memory.close(); });

function memory(): LocalMemory {
  const db = createLocalMemory({ path: ':memory:', workspaceId: 'project', agentId: 'agent', retrieval: 'lexical' });
  opened.push(db);
  return db;
}

function recordingEmbedder(seen: string[]): MemoryEmbedder {
  return {
    model: 'test-recording-embedder@v1', dimensions: 4,
    embed: async (texts) => { seen.push(...texts); return texts.map(() => [1, 0, 0, 0]); },
  };
}

describe('forget before a provider call is dispatched', () => {
  it('reflect does not send the text of a record forgotten after it started', async () => {
    const db = memory();
    const secret = db.store({ text: `${SECRET}; rotate it every quarter.`, trust: 'observed', source: { uri: 'test://secret' } });
    db.store({ text: 'The vault rotation schedule is reviewed every quarter.', trust: 'observed', source: { uri: 'test://schedule' } });
    const sent: string[] = [];
    const proposer = async (request: { context: string }) => { sent.push(request.context); return { proposals: [] }; };
    const running = reflect(db, { query: 'vault quarter', proposer });
    db.forget(secret.id);
    await running.catch(() => undefined);
    expect(db.get(secret.id)).toBeNull();
    expect(sent.join('\n').toLowerCase()).not.toContain('marigold');
  });

  it('reflect still dispatches when nothing changed', async () => {
    const db = memory();
    db.store({ text: `${SECRET}; rotate it every quarter.`, trust: 'observed', source: { uri: 'test://secret' } });
    const sent: string[] = [];
    const report = await reflect(db, { query: 'vault quarter', proposer: async (request) => { sent.push(request.context); return { proposals: [] }; } });
    expect(report.modelCalls).toBe(1);
    expect(sent.join('\n')).toContain('Marigold');
  });

  it('indexGranularity does not embed a derived document whose member was forgotten after it started', async () => {
    const db = memory();
    const secret = db.store({ text: `${SECRET}.`, trust: 'observed', source: { uri: 'test://turn' }, metadata: { sessionId: 's1' } });
    db.store({ text: 'The vault is opened by two people together.', trust: 'observed', source: { uri: 'test://turn' }, metadata: { sessionId: 's1' } });
    db.store({ text: 'Nobody writes the combination down.', trust: 'observed', source: { uri: 'test://turn' }, metadata: { sessionId: 's1' } });
    const seen: string[] = [];
    const running = db.indexGranularity({ embedder: recordingEmbedder(seen) });
    db.forget(secret.id);
    const result = await running;
    expect(seen.join('\n').toLowerCase()).not.toContain('marigold');
    expect(result.embedded).toBe(0);
  });

  it('indexGranularity skips a later batch whose member was forgotten during an earlier call', async () => {
    const db = memory();
    // Two sessions, so two derived documents per level; batchSize 1 puts them in separate calls.
    const first = ['The vault is opened by two people together.', 'Nobody writes the combination down.'];
    for (const text of first) db.store({ text, trust: 'observed', source: { uri: 'test://turn' }, metadata: { sessionId: 'a-session' } });
    const secret = db.store({ text: `${SECRET}.`, trust: 'observed', source: { uri: 'test://turn' }, metadata: { sessionId: 'b-session' } });
    db.store({ text: 'The second vault holds the archive.', trust: 'observed', source: { uri: 'test://turn' }, metadata: { sessionId: 'b-session' } });
    const seen: string[] = [];
    let calls = 0;
    const embedder: MemoryEmbedder = {
      model: 'test-recording-embedder@v1', dimensions: 4,
      embed: async (texts) => {
        calls++;
        seen.push(...texts);
        // Erase during the first provider call, while later batches are queued.
        if (calls === 1) db.forget(secret.id);
        return texts.map(() => [1, 0, 0, 0]);
      },
    };
    await db.indexGranularity({ embedder, batchSize: 1 });
    expect(db.get(secret.id)).toBeNull();
    expect(seen.slice(1).join('\n').toLowerCase()).not.toContain('marigold');
  });
});
