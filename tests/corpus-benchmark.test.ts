import { describe, expect, it, vi } from 'vitest';
import { LocalMemory } from '../src/local/index.js';
import { adaptBeamCorpus, adaptLoCoMoCorpus, adaptLongMemEvalCorpus, runCorpusBenchmark, splitEvaluationText, type CorpusDataset } from '../src/evaluation/corpus-benchmark.js';

const provenance = { dataset: 'synthetic-test', revision: 'fixture-v1', license: 'MIT; synthetic fixtures only' };
const lme = (overrides: Record<string, unknown> = {}) => ({ question_id: 'q1', question_type: 'single-session-user', question: 'orchid water', question_date: '2023/05/20 (Sat) 12:00',
  haystack_session_ids: ['answer_GOLD_SESSION', 'other'], haystack_dates: ['2023/05/18 (Thu) 09:00', '2023/05/19 (Fri) 09:00'],
  haystack_sessions: [[{ role: 'user', content: 'The orchid needs water every Tuesday.', has_answer: 'GOLD_TURN_LABEL' }], [{ role: 'assistant', content: 'Other topics: mountain weather.' }]], answer_session_ids: ['answer_GOLD_SESSION'], answer: 'GOLD_ANSWER_SENTINEL', ...overrides });
const dataset = () => adaptLongMemEvalCorpus([lme()], provenance);
const beamChat = [{ batch_number: 1, turns: [[{ id: 0, role: 'user', content: 'Initial region Oslo.', time_anchor: 'January-01-2024' }, { id: 1, role: 'assistant', content: 'Current region Bern.' }]] }];

describe('public corpus adapters', () => {
  it('separates reference labels and source groups from original LongMemEval history', () => {
    const result = dataset();
    expect(result.corpora[0].turns[0].text).toBe('The orchid needs water every Tuesday.');
    expect(JSON.stringify(result.corpora)).not.toContain('GOLD_ANSWER_SENTINEL');
    expect(JSON.stringify(result.corpora)).not.toContain('GOLD_TURN_LABEL');
    expect(result.labels[0].reference).toBe('GOLD_ANSWER_SENTINEL');
    expect(result.labels[0].evidenceGroups).toEqual(['session:answer_GOLD_SESSION']);
  });
  it('preserves oversized and multilingual turns using complete original byte spans', async () => {
    const original = 'orchid café 😀 '.repeat(6000);
    const pieces = splitEvaluationText(original, 1024);
    expect(pieces.map(piece => piece.text).join('')).toBe(original);
    expect(pieces.every(piece => Buffer.byteLength(piece.text) <= 1024 && piece.endByte - piece.startByte === Buffer.byteLength(piece.text))).toBe(true);
    expect(pieces.slice(1).every((piece, index) => piece.startByte === pieces[index].endByte)).toBe(true);
    const data = adaptLongMemEvalCorpus([lme({ haystack_sessions: [[{ role: 'user', content: original }], []] })], provenance);
    const result = await runCorpusBenchmark(data, { chunkBytes: 1024, maxContextUnits: 262144 });
    expect(result.ingestion[0].bytes).toBe(Buffer.byteLength(original));
    expect(result.summaries.lexical?.anyHitRate).toBe(1);
    expect(result.summaries['full-context']?.packedMeanRecall).toBe(1);
  });
  it('rejects future LongMemEval sessions unless explicit same-day compatibility is selected', () => {
    const input = [lme({ haystack_dates: ['2023/05/20 (Sat) 23:00', '2023/05/19 (Fri) 09:00'] })];
    expect(() => adaptLongMemEvalCorpus(input, provenance)).toThrow('cutoff');
    expect(adaptLongMemEvalCorpus(input, provenance, { timestampPolicy: 'question-day' }).notices[0]).toContain('1 history sessions');
    expect(() => adaptLongMemEvalCorpus([lme({ question_date: '2023/02/31 (Fri) 00:00' })], provenance)).toThrow('calendar');
    expect(() => adaptLongMemEvalCorpus([lme({ question_date: '2023-02-31T00:00:00Z' })], provenance)).toThrow('calendar');
    expect(() => adaptLongMemEvalCorpus([lme({ question_date: '2023-05-20T24:00:00Z' })], provenance)).toThrow('date');
  });
  it('preserves repeated session occurrences while rejecting absent evidence and misaligned inputs', () => {
    expect(adaptLongMemEvalCorpus([lme({ haystack_session_ids: ['answer_GOLD_SESSION', 'answer_GOLD_SESSION'] })], provenance).corpora[0].turns).toHaveLength(2);
    expect(() => adaptLongMemEvalCorpus([lme({ answer_session_ids: ['missing'] })], provenance)).toThrow('Unknown');
    expect(() => adaptLongMemEvalCorpus([lme({ haystack_dates: [] })], provenance)).toThrow('align');
  });
  it('ingests only original LoCoMo dialogue and retains adversarial questions without treating decoys as answers', async () => {
    const input = [{ sample_id: 'conv', observation: 'GOLD_OBSERVATION', session_summary: 'GOLD_SUMMARY', conversation: {
      speaker_a: 'A', speaker_b: 'B', session_1_date_time: '1:56 pm on 8 May, 2023', session_1: [{ speaker: 'Caroline', dia_id: 'D1:1', text: 'I enjoy orchids.' }],
    }, qa: [{ question: 'Caroline hobby?', answer: 'GOLD_ANSWER', category: 4, evidence: ['D1:1'] }, { question: 'Her unknown city?', adversarial_answer: 'GOLD_DECOY', category: 5, evidence: ['D1:1'] }] }];
    const data = adaptLoCoMoCorpus(input, provenance);
    expect(JSON.stringify(data.corpora)).not.toMatch(/GOLD_/);
    expect(data.corpora[0].turns[0].date).toBe('1:56 pm on 8 May, 2023');
    expect(data.labels[1]).toMatchObject({ answerability: 'unanswerable', answerSchema: 'missing' });
    expect(data.labels[1].reference).toBeUndefined();
    const report = await runCorpusBenchmark(data);
    expect(report.summaries.lexical?.questions).toBe(2); expect(report.summaries.lexical?.annotatedQuestions).toBe(1);
    expect(report.attempts.filter(row => row.questionId.endsWith(':1')).every(row => row.retrieval.recall === null)).toBe(true);
  });
  it('keeps BEAM chat ID zero and recursively resolves nested source ID objects', () => {
    const data = adaptBeamCorpus(beamChat, { knowledge_update: [{ question: 'Current region?', source_chat_ids: { original_info: [0], updated_info: { final: [1, 1] } }, ideal_answer: 'Bern', rubric: ['Do not say Oslo.'] }] }, provenance);
    expect(data.corpora[0].turns[0].id).toBe('0');
    expect(data.labels[0].evidenceGroups).toEqual(['turn:0', 'turn:1']);
    expect(data.labels[0].reference).toEqual({ ideal_answer: 'Bern', rubric: ['Do not say Oslo.'] });
    expect(() => adaptBeamCorpus(beamChat, { category: [{ question: 'x', source_chat_ids: [9] }] }, provenance)).toThrow('Unknown');
  });
  it('retains unsupported BEAM expected_compliance schemas and rubric-only questions in the denominator', async () => {
    const data = adaptBeamCorpus(beamChat, { instruction_following: [{ question: 'Region?', source_chat_ids: [0], expected_compliance: { unknown_new_schema: true } }], summarization: [{ question: 'Region?', rubric: ['Only say region.'] }] }, provenance);
    expect(data.labels.map(label => label.answerSchema)).toEqual(['unsupported', 'rubric-only']);
    expect(data.notices.some(notice => notice.includes('Unsupported'))).toBe(true);
    const report = await runCorpusBenchmark(data);
    expect(report.summaries.lexical?.questions).toBe(2);
    expect(report.answerQuality).toBe('not-evaluated');
    expect(report.attempts.some(row => row.answerSchema === 'unsupported')).toBe(true);
  });
  it('refuses Python literal question strings, duplicate chat IDs and unknown LoCoMo evidence', () => {
    expect(() => adaptBeamCorpus(beamChat, "{'question': 'x'}", provenance)).toThrow('object');
    expect(() => adaptBeamCorpus([...beamChat, ...beamChat], {}, provenance)).toThrow('Duplicate');
    expect(() => adaptLoCoMoCorpus([{ conversation: { session_1: [{ dia_id: 'D1', speaker: 'A', text: 'Text.' }] }, qa: [{ question: 'q', category: 1, evidence: ['absent'] }] }], provenance)).toThrow('Unknown');
  });
});

describe('matched corpus retrieval and context budgets', () => {
  it('runs no-memory, full-context and lexical conditions without network or model calls', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const report = await runCorpusBenchmark(dataset());
      expect(report.complete).toBe(true); expect(report.attempts).toHaveLength(3);
      expect(report.summaries.lexical?.anyHitRate).toBe(1);
      expect(report.summaries['no-memory']?.anyHitRate).toBe(0);
      expect(report.summaries['full-context']?.allHitRate).toBe(1);
      expect(report.calls).toEqual({ embedding: 0, embeddingInputBytes: 0, generation: 0, judge: 0 });
      expect(fetch).not.toHaveBeenCalled(); expect(JSON.stringify(report)).not.toContain('GOLD_ANSWER_SENTINEL');
      expect(report.runtime.implementationSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally { fetch.mockRestore(); }
  });
  it('never sends gold answers, evidence groups, question IDs or grading categories to the embedder', async () => {
    const captured: string[] = [];
    const report = await runCorpusBenchmark(dataset(), { embedder: { model: 'synthetic-v1', dimensions: 2, async embed(texts) { captured.push(...texts); return texts.map(value => value.includes('orchid') ? [1, 0] : [0, 1]); } } });
    expect(report.complete).toBe(true); expect(report.attempts).toHaveLength(4); expect(report.calls.embedding).toBeGreaterThan(0);
    expect(captured.join('\n')).not.toMatch(/GOLD_|single-session-user|q1/);
    expect(report.summaries.hybrid?.anyHitRate).toBe(1);
  });
  it('adds BM25 as a separately named paired condition without changing the overlap baseline', async () => {
    const baseline = await runCorpusBenchmark(dataset());
    const paired = await runCorpusBenchmark(dataset(), { includeBm25: true });
    expect(paired.attempts).toHaveLength(4);
    expect(paired.summaries.bm25?.allHitRate).toBe(1);
    expect(paired.attempts.find(row => row.condition === 'lexical')?.selected).toEqual(baseline.attempts.find(row => row.condition === 'lexical')?.selected);
    expect(paired.calls.embedding).toBe(0);
    expect(paired.settings.bm25Condition).toBe('enabled');
    const hybrid = await runCorpusBenchmark(dataset(), { includeBm25: true, hybridLexicalScoring: 'bm25', embedder: { model: 'synthetic-v1', dimensions: 2, async embed(texts) { return texts.map(() => [1, 0]); } } });
    expect(hybrid.attempts).toHaveLength(5);
    expect(hybrid.settings.hybridLexicalScoring).toBe('bm25');
    expect(hybrid.complete).toBe(true);
  });
  it('keeps full-context overflow in packed coverage denominator without truncation', async () => {
    const data = dataset(); data.corpora[0].turns[1].text = 'Large unrelated history. '.repeat(200);
    const report = await runCorpusBenchmark(data, { maxContextUnits: 512, chunkBytes: 512 });
    const full = report.attempts.find(row => row.condition === 'full-context')!;
    expect(full.status).toBe('context-overflow'); expect(full.packedChunks).toBe(0); expect(full.selected).toEqual([]);
    expect(full.retrieval.recall).toBe(1); expect(full.packed.recall).toBe(0);
    expect(report.summaries['full-context']).toMatchObject({ questions: 1, overflows: 1, annotatedQuestions: 1, packedMeanRecall: 0 });
    expect(report.summaries.lexical?.packedMeanRecall).toBe(1);
  });
  it('uses the same named counter for every complete envelope', async () => {
    await expect(runCorpusBenchmark(dataset(), { countContext: value => value.length })).rejects.toThrow('identity');
    const seen: string[] = [];
    const report = await runCorpusBenchmark(dataset(), { maxContextUnits: 200, accountingId: 'synthetic-js-codeunits-v1', countContext(value) { seen.push(value); return value.length; } });
    expect(seen.every(value => JSON.parse(value).instruction && Array.isArray(JSON.parse(value).evidence))).toBe(true);
    expect(report.attempts.every(row => row.contextUnits <= 200)).toBe(true);
  });
  it('retains embedding failures and cancellations rather than shrinking the denominator', async () => {
    const report = await runCorpusBenchmark(dataset(), { embedder: { model: 'broken', dimensions: 2, async embed() { throw new Error('PRIVATE_ERROR'); } } });
    expect(report.complete).toBe(false); expect(report.summaries.hybrid).toMatchObject({ questions: 1, errors: 1, meanRecall: 0 });
    expect(report.summaries.lexical?.anyHitRate).toBe(1); expect(JSON.stringify(report)).not.toContain('PRIVATE_ERROR');
    const signal = AbortSignal.abort();
    const cancelled = await runCorpusBenchmark(dataset(), { signal });
    expect(cancelled.attempts).toHaveLength(3); expect(cancelled.attempts.every(row => row.status === 'cancelled')).toBe(true);
  });
  it('does not fail no-memory and full-context controls when the search index fails to import', async () => {
    const failingImport = vi.spyOn(LocalMemory.prototype, 'import').mockImplementation(() => { throw new Error('PRIVATE_INDEX_FAILURE'); });
    try {
      const report = await runCorpusBenchmark(dataset(), { includeBm25: true });
      expect(report.complete).toBe(false);
      expect(report.summaries['no-memory']?.completed).toBe(1);
      expect(report.summaries['full-context']?.packedAllHitRate).toBe(1);
      expect(report.summaries.lexical).toMatchObject({ questions: 1, errors: 1, meanRecall: 0 });
      expect(report.summaries.bm25).toMatchObject({ questions: 1, errors: 1, meanRecall: 0 });
      expect(JSON.stringify(report)).not.toContain('PRIVATE_INDEX_FAILURE');
    } finally { failingImport.mockRestore(); }
  });
  it('refuses fabricated references, duplicate question identities and oversized corpora', async () => {
    const bad = dataset(); bad.labels[0].evidenceGroups.push('missing');
    await expect(runCorpusBenchmark(bad)).rejects.toThrow('unknown');
    const duplicate = dataset(); duplicate.questions.push(duplicate.questions[0]); duplicate.labels.push(duplicate.labels[0]);
    await expect(runCorpusBenchmark(duplicate)).rejects.toThrow('Duplicate');
    await expect(runCorpusBenchmark(dataset(), { maxCorpusBytes: 20 })).rejects.toThrow();
    await expect(runCorpusBenchmark(dataset(), { includeBm25: 'yes' } as never)).rejects.toThrow('boolean');
    await expect(runCorpusBenchmark(dataset(), { maxTokens: 20 } as never)).rejects.toThrow('Unknown');
  });
  it('never forwards label mutation through an asynchronous callback', async () => {
    const data: CorpusDataset = dataset();
    const report = await runCorpusBenchmark(data, { embedder: { model: 'mutation-fixture', dimensions: 2, async embed(texts) { data.labels[0].evidenceGroups = []; data.corpora[0].turns[0].text = 'Changed while embedding.'; return texts.map(() => [1, 0]); } } });
    expect(report.summaries.hybrid?.annotatedQuestions).toBe(1);
    expect(report.summaries.lexical?.anyHitRate).toBe(1);
  });
});
