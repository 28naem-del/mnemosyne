import { describe, expect, it } from 'vitest';
import { parseAgentBenchmark, runAgentBenchmark, type AgentBenchmarkDataset, type BenchmarkCondition, type BenchmarkReader } from '../src/evaluation/agent-benchmark.js';
import { adaptiveMemoryCondition, lexicalMemoryCondition, noMemoryCondition, recentHistoryCondition } from '../src/evaluation/benchmark-memory.js';

const dataset: AgentBenchmarkDataset = { protocol: 'mnemosyne-agent-benchmark-v1', name: 'synthetic controller facts', revision: '1', split: 'development', episodes: [
  { id: 'project', category: 'updates-and-erasure', events: [
    { operation: 'remember', key: 'deployment', text: 'deployment region: oslo' },
    { operation: 'task', id: 'initial', query: 'deployment region', answers: ['oslo'], action: 'act', evidenceKeys: ['deployment'] },
    { operation: 'correct', key: 'deployment', text: 'deployment region: bern' },
    { operation: 'task', id: 'updated', query: 'deployment region', answers: ['bern'], staleAnswers: ['oslo'], action: 'act', evidenceKeys: ['deployment'] },
    { operation: 'correct', key: 'deployment', text: 'deployment region: rome' },
    { operation: 'task', id: 'updated-twice', query: 'deployment region', answers: ['rome'], staleAnswers: ['bern', 'oslo'], action: 'act', evidenceKeys: ['deployment'] },
    { operation: 'forget', key: 'deployment' },
    { operation: 'task', id: 'forgotten', query: 'deployment region', answers: ['unknown'], staleAnswers: ['rome'], action: 'abstain', evidenceKeys: [] },
  ] },
] };
const scripted: BenchmarkReader = { id: 'fixture-reader', revision: '1', mode: 'scripted', async run(request) {
  const match = /deployment region: (oslo|bern|rome)/.exec(request.context);
  return match ? { answer: match[1], action: 'act', citations: ['deployment'] } : { answer: 'unknown', action: 'abstain', citations: [] };
} };
const run = (overrides: Partial<Parameters<typeof runAgentBenchmark>[1]> = {}, data: unknown = dataset) => runAgentBenchmark(data, {
  reader: scripted, conditions: [noMemoryCondition(), lexicalMemoryCondition(), recentHistoryCondition()], trials: 2, ...overrides,
});

describe('matched agent-memory experiment', () => {
  it('exercises adaptive selection, repeated correction, erasure and complete envelope accounting', async () => {
    const result = await run({ conditions: [noMemoryCondition(), adaptiveMemoryCondition()], trials: 1 });
    expect(result.complete).toBe(true);
    expect(result.summaries['mnemosyne-adaptive'].successRate).toBe(1);
    const bounded = await run({ conditions: [noMemoryCondition(), adaptiveMemoryCondition()], trials: 1, maxContextUnits: 128 });
    expect(bounded.complete).toBe(true);
    expect(bounded.attempts.every(a => a.contextBytes <= 128)).toBe(true);
  });
  it('runs real SQLite corrections and forgetting through independent conditions and trials', async () => {
    const result = await run();
    expect(result.complete).toBe(true);
    expect(result.readerCalls).toBe(24);
    expect(result.attempts).toHaveLength(24);
    expect(result.summaries['mnemosyne-lexical'].successRate).toBe(1);
    expect(result.summaries['recent-history'].successRate).toBe(1);
    expect(result.summaries['no-memory'].successRate).toBe(0.25);
    expect(result.summaries['mnemosyne-lexical'].positiveTransferRate).toBe(1);
    expect(result.reader.mode).toBe('scripted');
    expect(result.attempts.every(row => row.response === undefined)).toBe(true);
    expect(result.dataset.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('never passes answers, grading labels, category or task identities to callbacks', async () => {
    const data = structuredClone(dataset);
    data.episodes[0].id = 'EPISODE_LABEL'; data.episodes[0].category = 'CATEGORY_LABEL';
    const task = data.episodes[0].events.find(e => e.operation === 'task')!;
    if (task.operation !== 'task') throw new Error('fixture');
    task.id = 'TASK_LABEL'; task.answers = ['REFERENCE_LABEL']; task.staleAnswers = ['STALE_LABEL'];
    const requests: unknown[] = [];
    const condition: BenchmarkCondition = { id: 'spy', revision: '1', create(request) {
      requests.push(request);
      return { apply(event) { requests.push(structuredClone(event)); }, context(request) { requests.push(request); return { text: '', sourceKeys: [] }; }, close() {} };
    } };
    await run({ conditions: [noMemoryCondition(), condition], reader: { ...scripted, async run(request) { requests.push(request); return scripted.run(request); } } }, data);
    expect(JSON.stringify(requests)).not.toMatch(/REFERENCE_LABEL|STALE_LABEL|EPISODE_LABEL|CATEGORY_LABEL|TASK_LABEL|evidenceKeys/);
  });

  it('counterbalances order and sends the same trial seed and limits to each condition', async () => {
    const seen: string[] = [], seeds: number[] = [];
    const conditions = ['no-memory', 'a', 'b'].map(id => ({ id, revision: '1', create() { seen.push(id); return noMemoryCondition().create({ seed: 0, maxContextUnits: 1000, signal: new AbortController().signal }); } }));
    const result = await run({ conditions, trials: 3, seed: 0, maxOutputTokens: 123, reader: { ...scripted, async run(r) { seeds.push(r.seed); expect(r.maxOutputTokens).toBe(123); return scripted.run(r); } } });
    expect(seen).toEqual(['no-memory', 'a', 'b', 'a', 'b', 'no-memory', 'b', 'no-memory', 'a']);
    expect([...new Set(seeds)]).toEqual([0, 1, 2]);
    expect(result.attempts).toHaveLength(36);
  });

  it('counts failures in success denominators without retaining provider error text', async () => {
    const report = await run({ reader: { ...scripted, async run() { throw new Error('PRIVATE_SOURCE_AND_KEY'); } } });
    expect(report.complete).toBe(false); expect(report.readerCalls).toBe(24);
    expect(report.summaries['no-memory'].errors).toBe(8);
    expect(report.summaries['no-memory'].successRate).toBe(0);
    expect(report.summaries['no-memory'].staleActionRate).toBeNull();
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SOURCE_AND_KEY');
  });

  it('identifies stale actions, unsupported citations and answer accuracy separately', async () => {
    const report = await run({ trials: 1, reader: { ...scripted, async run() { return { answer: 'oslo', action: 'act', citations: ['fabricated'] }; } } });
    const old = report.attempts.find(a => a.condition === 'mnemosyne-lexical' && a.taskId === 'updated')!;
    expect(old.staleAction).toBe(true); expect(old.unsupportedAnswer).toBe(true); expect(old.citationsValid).toBe(false);
    expect(report.summaries['mnemosyne-lexical'].answerAccuracy).toBe(0.25);
    expect(report.summaries['mnemosyne-lexical'].successRate).toBe(0.25);
    expect(report.summaries['mnemosyne-lexical'].groundedSuccessRate).toBe(0);
  });

  it('includes the entire context envelope in accounting and blocks an oversized context before reader entry', async () => {
    const inflated: BenchmarkCondition = { id: 'inflated', revision: '1', create: () => ({ apply() {}, context: () => ({ text: '', sourceKeys: ['x'.repeat(200)] }), close() {} }) };
    const report = await run({ conditions: [noMemoryCondition(), inflated], trials: 1, maxContextUnits: 100 });
    expect(report.readerCalls).toBe(4);
    expect(report.attempts.filter(a => a.condition === 'inflated').every(a => a.status === 'memory-error')).toBe(true);
  });

  it('measures transfer from task correctness rather than citation availability', async () => {
    const taskOnly: AgentBenchmarkDataset = { ...dataset, episodes: [{ id: 'known-fact', category: 'reference', events: [
      { operation: 'remember', key: 'deployment', text: 'deployment region: oslo' },
      { operation: 'task', id: 'initial', query: 'deployment region', answers: ['oslo'], action: 'act', evidenceKeys: ['deployment'] },
    ] }] };
    const report = await run({ trials: 1, reader: { ...scripted, async run(r) { return { answer: 'oslo', action: 'act', citations: r.sourceKeys }; } } }, taskOnly);
    expect(report.summaries['no-memory'].successRate).toBe(1);
    expect(report.summaries['no-memory'].groundedSuccessRate).toBe(0);
    expect(report.summaries['mnemosyne-lexical'].negativeTransferRate).toBe(0);
    expect(report.summaries['mnemosyne-lexical'].positiveTransferRate).toBeNull();
  });

  it('caps reader calls and records all unattempted tasks instead of dropping failures', async () => {
    const report = await run({ maxReaderCalls: 2 });
    expect(report.readerCalls).toBe(2); expect(report.attempts).toHaveLength(24);
    expect(report.complete).toBe(false);
    expect(report.attempts.filter(a => a.status === 'budget-exhausted')).toHaveLength(22);
  });

  it('cancels queued work and bounds an uncooperative reader while closing sessions', async () => {
    let closed = 0;
    const condition: BenchmarkCondition = { id: 'closable', revision: '1', create: () => ({ apply() {}, context: () => ({ text: '', sourceKeys: [] }), close() { closed++; } }) };
    const report = await run({ conditions: [noMemoryCondition(), condition], trials: 1, operationTimeoutMs: 5, reader: { ...scripted, async run() { return await new Promise(() => {}); } } });
    expect(closed).toBe(1); expect(report.complete).toBe(false); expect(report.readerCalls).toBe(8);
    const aborted = new AbortController(); aborted.abort();
    const cancelled = await run({ signal: aborted.signal });
    expect(cancelled.readerCalls).toBe(0); expect(cancelled.attempts.every(a => a.status === 'cancelled')).toBe(true);
  });

  it('records cleanup failures without exposing error text', async () => {
    const bad: BenchmarkCondition = { id: 'bad-close', revision: '1', create: () => ({ apply() {}, context: () => ({ text: '', sourceKeys: [] }), close() { throw new Error('PRIVATE_CLOSE'); } }) };
    const report = await run({ conditions: [noMemoryCondition(), bad], trials: 1 });
    expect(report.complete).toBe(false); expect(report.cleanupErrors).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_CLOSE');
  });

  it('rejects invalid trial identities, references and forgotten source resurrection', () => {
    const data = structuredClone(dataset);
    data.episodes[0].events.push({ operation: 'remember', key: 'deployment', text: 'resurrect' });
    expect(() => parseAgentBenchmark(data)).toThrow('Repeated source');
    expect(() => parseAgentBenchmark({ ...dataset, extra: 'secret' })).toThrow();
    const duplicate = structuredClone(dataset); duplicate.episodes.push(duplicate.episodes[0]);
    expect(() => parseAgentBenchmark(duplicate)).toThrow('Duplicate episode');
  });

  it('requires an explicit reference and named custom tokenizer', async () => {
    await expect(run({ conditions: [lexicalMemoryCondition(), recentHistoryCondition()] })).rejects.toThrow('no-memory');
    await expect(run({ countContext: text => text.length })).rejects.toThrow('named counter');
    await expect(run({ conditions: [noMemoryCondition(), noMemoryCondition()] })).rejects.toThrow('unique identities');
  });

  it('retains responses only with explicit output opt-in and checks reported output budget', async () => {
    const report = await run({ includeResponses: true, trials: 1 });
    expect(report.attempts.every(a => a.response !== undefined)).toBe(true);
    const tooLarge = await run({ reader: { ...scripted, async run(r) { return { ...await scripted.run(r), usage: { inputTokens: 100, outputTokens: r.maxOutputTokens + 1 } }; } } });
    expect(tooLarge.complete).toBe(false);
    expect(tooLarge.attempts.every(a => a.status === 'reader-error')).toBe(true);
  });
});
