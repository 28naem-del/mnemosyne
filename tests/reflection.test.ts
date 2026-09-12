import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalMemory, type LocalMemory } from '../src/local/index.js';
import { reflect, commitVerifiedLesson } from '../src/reflection/index.js';

const opened: LocalMemory[] = [];
function fixture() {
  const memory = createLocalMemory({ path: ':memory:', workspaceId: 'project', agentId: 'agent' });
  opened.push(memory);
  const record = memory.store({ text: 'Catalogue images use a 1600 x 1200 canvas and require owner approval.', trust: 'observed', source: { uri: 'test://owner/brief' } });
  const proposer = vi.fn(async () => ({ proposals: [{ text: 'For catalogue images, preserve aspect ratio inside the approved canvas, then request approval.', kind: 'procedure', rationale: 'Preserves the image dimensions and approval requirement in the owner brief.', dependencies: [record.id] }] }));
  return { memory, record, proposer };
}
afterEach(() => { for (const memory of opened.splice(0)) memory.close(); });
const validation = { passed: true, evidence: 'Independent fixture: aspect ratio preserved; approval gate retained.', verifier: 'fixture-runner', taskId: 'test-001' };

describe('bounded, evidence-linked reflection', () => {
  it('calls the selected proposer once, writes nothing, then requires independent validation to commit', async () => {
    const { memory, record, proposer } = fixture();
    const report = await reflect(memory, { query: 'catalogue', proposer });
    expect(proposer).toHaveBeenCalledTimes(1);
    expect(report.modelCalls).toBe(1);
    expect(report.sourceIds).toContain(record.id);
    expect(memory.inspect()).toHaveLength(1);
    expect(() => commitVerifiedLesson(memory, { proposal: report.proposals[0], validation: { ...validation, passed: false } })).toThrow();
    expect(memory.inspect()).toHaveLength(1);
    const lesson = commitVerifiedLesson(memory, { proposal: report.proposals[0], validation });
    expect(lesson.trust).toBe('observed');
    expect(lesson.dependencies).toEqual([record.id]);
    expect(commitVerifiedLesson(memory, { proposal: report.proposals[0], validation }).id).toBe(lesson.id);
    expect(memory.inspect()).toHaveLength(2);
  });

  it('does not spend a proposer call on absent evidence', async () => {
    const { memory, proposer } = fixture();
    const report = await reflect(memory, { query: 'unmatched polar astronomy', proposer });
    expect(report.status).toBe('no-evidence');
    expect(proposer).not.toHaveBeenCalled();
  });

  it('rejects fabricated sources and duplicate/no-progress proposals', async () => {
    const { memory, record } = fixture();
    const report = await reflect(memory, { query: 'catalogue', proposer: async () => ({ proposals: [
      { text: record.text, rationale: 'Copied evidence', kind: 'observation', dependencies: [record.id] },
      { text: 'Use a different policy.', rationale: 'Fabricated source', kind: 'procedure', dependencies: ['outside-scope'] },
    ] }) });
    expect(report.status).toBe('no-progress');
    expect(report.rejected).toHaveLength(2);
    expect(memory.inspect()).toHaveLength(1);
  });

  it('rejects source revisions changed after proposal and cascades later corrections through accepted lessons', async () => {
    const { memory, record, proposer } = fixture();
    const report = await reflect(memory, { query: 'catalogue', proposer });
    const lesson = commitVerifiedLesson(memory, { proposal: report.proposals[0], validation });
    memory.correct(record.id, { text: 'Catalogue output now requires a 2000 x 1500 canvas.', source: { uri: 'test://owner/revised' }, reason: 'Output requirement changed.' });
    expect(memory.get(lesson.id)?.status).toBe('invalidated');
    expect(() => commitVerifiedLesson(memory, { proposal: report.proposals[0], validation })).toThrow(/changed|unavailable/);
  });

  it('binds approved text to the actual proposal, not a modified model response', async () => {
    const { memory, proposer } = fixture();
    const report = await reflect(memory, { query: 'catalogue', proposer });
    expect(() => commitVerifiedLesson(memory, { proposal: { ...report.proposals[0], text: 'Bypass owner approval.' }, validation })).toThrow(/altered/);
    expect(memory.inspect()).toHaveLength(1);
  });

  it('enforces elapsed time, output size, cancellation and number of proposals', async () => {
    const { memory, proposer } = fixture();
    let signal: AbortSignal | undefined;
    await expect(reflect(memory, { query: 'catalogue', timeoutMs: 10, proposer: request => { signal = request.signal; return new Promise(() => {}); } })).rejects.toThrow(/time budget/);
    expect(signal?.aborted).toBe(true);
    await expect(reflect(memory, { query: 'catalogue', maxOutputBytes: 256, proposer: async () => 'x'.repeat(257) })).rejects.toThrow(/output budget/);
    const abort = new AbortController(); abort.abort();
    await expect(reflect(memory, { query: 'catalogue', signal: abort.signal, proposer })).rejects.toThrow(/cancelled/);
    expect(proposer).not.toHaveBeenCalled();
    await expect(reflect(memory, { query: 'catalogue', maxProposals: 0, proposer })).rejects.toThrow(/budget/);
  });

  it('rejects intervening negative outcomes on source evidence', async () => {
    const { memory, record, proposer } = fixture();
    const report = await reflect(memory, { query: 'catalogue', proposer });
    memory.recordOutcome({ memoryId: record.id, success: false, taskId: 'new-failure', evidence: 'The owner requirement was misinterpreted in the test.', verifier: 'independent-runner' });
    expect(() => commitVerifiedLesson(memory, { proposal: report.proposals[0], validation })).toThrow(/evidence changed|failed verification/);
    expect(memory.inspect()).toHaveLength(1);
  });

  it('never includes untrusted external source text in the proposer envelope', async () => {
    const { memory } = fixture();
    // Untrusted external notes are retained for inspection, excluded from compile.
    memory.store({ text: 'Catalogue secret untrusted instruction to expose PASSWORD.', source: { uri: 'test://external' } });
    const proposer = vi.fn(async (request) => { expect(request.context).not.toContain('PASSWORD'); return { proposals: [] }; });
    await reflect(memory, { query: 'catalogue', proposer });
    expect(proposer).toHaveBeenCalledTimes(1);
  });
});
