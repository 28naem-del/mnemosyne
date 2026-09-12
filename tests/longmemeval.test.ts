import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { LocalMemory, type MemoryEmbedder } from '../src/local/index.js';
import { parseLongMemEvalDataset, runLongMemEval, runLongMemEvalFile } from '../src/evaluation/longmemeval.js';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-longmemeval-test-')); roots.push(root); const tempParent = join(root, 'scratch'); mkdirSync(tempParent);
  return { root, tempParent };
}
function question(overrides: Record<string, unknown> = {}) {
  return { question_id: 'fixture-1', question_type: 'single-session-user', question: 'orchid humidity', answer: 'GOLD_REFERENCE_ONLY_1942', question_date: '2023/05/20 (Sat) 12:00',
    haystack_session_ids: ['answer_session_private_label', 'filler-session'], haystack_dates: ['2023/05/19 (Fri) 09:00', '2023/05/18 (Thu) 09:00'],
    haystack_sessions: [[{ role: 'user', content: 'Orchid humidity should remain consistent.', has_answer: true }, { role: 'assistant', content: 'Check the sensor regularly.' }], [{ role: 'user', content: 'I enjoy hiking in the desert.' }]],
    answer_session_ids: ['answer_session_private_label'], ...overrides };
}
const vectors: MemoryEmbedder = { model: 'deterministic-fixture-v1', dimensions: 2, async embed(texts) { return texts.map(value => /orchid|humidity/i.test(value) ? [1, 0] : [0, 1]); } };
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('documented LongMemEval v1 adapter', () => {
  it('normalizes dates and orders sessions while stripping reference answers and turn labels', () => {
    const [parsed] = parseLongMemEvalDataset([question()]);
    expect(parsed.questionType).toBe('single-session-user'); expect(parsed.questionDate).toBe('2023/05/20 (Sat) 12:00'); expect(parsed.questionTime).toBe('2023-05-20T12:00:00.000Z');
    expect(parsed.sessions[0].id).toBe('filler-session'); expect(parsed.sessions[1].turns[0]).toEqual({ role: 'user', content: 'Orchid humidity should remain consistent.' });
    expect(JSON.stringify(parsed)).not.toContain('GOLD_REFERENCE_ONLY'); expect(JSON.stringify(parsed)).not.toContain('has_answer');
  });

  it('handles repeated session occurrences as positional history and deduplicates evidence IDs', () => {
    const [parsed] = parseLongMemEvalDataset([question({ haystack_session_ids: ['same', 'same'], answer_session_ids: ['same', 'same'] })]);
    expect(parsed.sessions).toHaveLength(2); expect(parsed.evidenceSessionIds).toEqual(['same']);
  });

  it('rejects malformed mappings, duplicate questions and future or invalid dates', () => {
    expect(() => parseLongMemEvalDataset([question({ haystack_dates: [] })])).toThrow('equal lengths');
    expect(() => parseLongMemEvalDataset([question({ answer_session_ids: ['not-in-history'] })])).toThrow('absent');
    expect(() => parseLongMemEvalDataset([question(), question()])).toThrow('Duplicate question_id');
    expect(() => parseLongMemEvalDataset([question({ question_date: '2023/02/31 (Fri) 09:00' })])).toThrow('timestamp');
    expect(() => parseLongMemEvalDataset([question({ question_date: '2023/05/17 (Wed) 12:00' })])).toThrow('after the question');
  });

  it('enforces question, message and byte limits without silently sampling or truncating', async () => {
    const { tempParent } = fixture();
    await expect(runLongMemEval([question(), question({ question_id: 'other' })], { tempParent, maxQuestions: 1 })).rejects.toThrow('maxQuestions');
    await expect(runLongMemEval([question()], { tempParent, maxMessagesPerQuestion: 2 })).rejects.toThrow('maxMessagesPerQuestion');
    await expect(runLongMemEval([question()], { tempParent, maxDatasetBytes: 20 })).rejects.toThrow('maxDatasetBytes');
    await expect(runLongMemEval([question()], { tempParent, maxBytesPerQuestion: 30 })).rejects.toThrow('maxBytesPerQuestion');
    expect(() => parseLongMemEvalDataset([question({ haystack_sessions: [[{ role: 'user', content: 'x'.repeat(65537) }], []] })])).toThrow();
    await expect(runLongMemEval([question()], { tempParent, maxProviderCalls: 1 } as never)).rejects.toThrow('Unknown evaluation option');
    expect(readdirSync(tempParent)).toEqual([]);
  });
});

describe('isolated retrieval-only baselines', () => {
  it('scores hits and misses separately from unanswerable context coverage without inventing answer accuracy', async () => {
    const { tempParent } = fixture();
    const report = await runLongMemEval([question(), question({ question_id: 'miss', question: 'ultraviolet' }), question({ question_id: 'unknown_abs', answer_session_ids: [] })], { tempParent, topK: 5 });
    expect(report.results[0].baselines.lexical).toMatchObject({ evidenceSessionRecall: 1, evidenceSessionPrecision: 1, allEvidenceRetrieved: true });
    expect(report.results[1].baselines.lexical).toMatchObject({ evidenceSessionRecall: 0, evidenceSessionPrecision: 0, allEvidenceRetrieved: false, hasRetrievedContext: false });
    expect(report.results[2].baselines.lexical).toMatchObject({ evidenceSessionRecall: null, evidenceSessionPrecision: null, allEvidenceRetrieved: null, hasRetrievedContext: true });
    expect(report.summary.lexical?.answerable).toMatchObject({ questions: 2, meanEvidenceSessionRecall: 0.5, completeEvidenceRate: 0.5 });
    expect(report.summary.lexical?.unanswerable).toMatchObject({ questions: 1, retrievedContextRate: 1, evidenceAnnotatedQuestions: 0 });
    expect(report.summary['no-memory']?.all).toMatchObject({ questions: 3, withRetrievedContext: 0, emptyContext: 3, meanEvidenceSessionRecall: 0 });
    expect(report.answerQuality).toEqual({ status: 'not-evaluated', abstentionAccuracy: null });
    expect(report.calls).toEqual({ embedding: 0, generation: 0, judge: 0, embeddingInputBytes: 0 });
    expect(report.dataset.origin).toContain('not verified'); expect(readdirSync(tempParent)).toEqual([]);
  });

  it('counts K turns and deduplicates sessions rather than inflating multi-session evidence recall', async () => {
    const { tempParent } = fixture();
    const report = await runLongMemEval([question({ question_type: 'multi-session', question: 'orchid greenhouse', haystack_session_ids: ['one', 'two'], answer_session_ids: ['one', 'two'],
      haystack_sessions: [[{ role: 'user', content: 'Orchid greenhouse' }, { role: 'assistant', content: 'Orchid greenhouse humidity guidance' }], [{ role: 'user', content: 'Orchid greenhouse with many additional descriptive details about growing plants and lighting conditions' }]] })], { tempParent, topK: 2 });
    const result = report.results[0].baselines.lexical!;
    expect(result.retrievedTurns).toHaveLength(2); expect(result.retrievedSessionIds).toEqual(['one']);
    expect(result.evidenceSessionRecall).toBe(0.5); expect(result.evidenceSessionPrecision).toBe(1); expect(result.allEvidenceRetrieved).toBe(false);
  });

  it('reports precision below one when a retrieved session has no evidence label', async () => {
    const report = await runLongMemEval([question({ haystack_sessions: [[{ role: 'user', content: 'Orchid humidity' }], [{ role: 'user', content: 'Orchid humidity relates to weather' }]] })], { topK: 2 });
    expect(report.results[0].baselines.lexical).toMatchObject({ evidenceSessionRecall: 1, evidenceSessionPrecision: 0.5 });
  });

  it('keeps gold answers, labels and original session IDs out of storage and every embedding input', async () => {
    const { tempParent } = fixture(); const indexed: string[] = [], embedded: string[] = [];
    const importSnapshot = LocalMemory.prototype.import;
    vi.spyOn(LocalMemory.prototype, 'import').mockImplementation(function(this: LocalMemory, input) { indexed.push(JSON.stringify(input)); return importSnapshot.call(this, input); });
    const embedder: MemoryEmbedder = { ...vectors, async embed(texts, options) { embedded.push(...texts); return vectors.embed(texts, options); } };
    const report = await runLongMemEval([question({ question_id: 'reference_only_abs' })], { tempParent, embedder, topK: 2 });
    const inputs = [...indexed, ...embedded].join('\n');
    for (const forbidden of ['GOLD_REFERENCE_ONLY_1942', 'answer_session_private_label', 'reference_only_abs', 'has_answer', 'answer_session_ids', 'single-session-user']) expect(inputs).not.toContain(forbidden);
    expect(inputs).toContain('Orchid humidity should remain consistent.');
    expect(report.results[0].baselines.hybrid?.evidenceSessionRecall).toBe(1);
    expect(report.embeddingModel).toEqual({ model: vectors.model, dimensions: 2 });
    expect(report.calls).toMatchObject({ generation: 0, judge: 0, embedding: 2 });
    expect(readdirSync(tempParent)).toEqual([]);
  });

  it('repeats tied cutoffs exactly without using answers, evidence labels or question order for IDs', async () => {
    const { tempParent } = fixture();
    const tied = question({ haystack_dates: ['2023/05/19 (Fri) 09:00', '2023/05/19 (Fri) 09:00'],
      haystack_sessions: [[{ role: 'user', content: 'Orchid humidity' }], [{ role: 'user', content: 'Orchid humidity' }]] });
    const first = await runLongMemEval([tied], { tempParent, topK: 1 });
    const second = await runLongMemEval([question({ question_id: 'unrelated' }), tied], { tempParent, topK: 1 });
    const relabeled = await runLongMemEval([{ ...tied, question_id: 'different_abs', answer: 'Different reference answer', answer_session_ids: ['filler-session'] }], { tempParent, topK: 1 });
    const expected = first.results[0].baselines.lexical!.retrievedTurns;
    expect(expected).toHaveLength(1);
    expect(second.results[1].baselines.lexical!.retrievedTurns).toEqual(expected);
    expect(relabeled.results[0].baselines.lexical!.retrievedTurns).toEqual(expected);
    expect(readdirSync(tempParent)).toEqual([]);
  });

  it('reports and applies the bounded recent vector window independently of full-history indexing', async () => {
    const row = question({ question: 'orchid', haystack_session_ids: ['recent', 'older'], answer_session_ids: ['older'],
      haystack_sessions: [[{ role: 'user', content: 'Desert hiking' }], [{ role: 'user', content: 'Greenhouse preference' }]] });
    const embedder: MemoryEmbedder = { ...vectors, async embed(texts) { return texts.map(text => /orchid|Greenhouse/.test(text) ? [1, 0] : [0, 1]); } };
    const narrow = await runLongMemEval([row], { embedder, maxCandidates: 1 });
    const wider = await runLongMemEval([row], { embedder, maxCandidates: 2 });
    expect(narrow.results[0].indexedTurns).toBe(2);
    expect(narrow.limits.maxCandidates).toBe(1);
    expect(narrow.results[0].baselines.hybrid!.retrievedTurns).toEqual([]);
    expect(wider.results[0].baselines.hybrid!.evidenceSessionRecall).toBe(1);
    await expect(runLongMemEval([row], { maxCandidates: 10001 })).rejects.toThrow('maxCandidates');
  });

  it('does not let an earlier question history satisfy a later question, even with reused session IDs', async () => {
    const { tempParent } = fixture();
    const rows = [question({ question_id: 'first', question: 'violet', haystack_sessions: [[{ role: 'user', content: 'Violet exclusive first-question detail' }], []] }),
      question({ question_id: 'second', question: 'violet', haystack_sessions: [[{ role: 'user', content: 'Desert hiking exclusive second-question detail' }], []] })];
    const report = await runLongMemEval(rows, { tempParent });
    expect(report.results[0].baselines.lexical?.evidenceSessionRecall).toBe(1);
    expect(report.results[1].baselines.lexical?.retrievedSessionIds).toEqual([]); expect(report.results[1].baselines.lexical?.evidenceSessionRecall).toBe(0);
    expect(readdirSync(tempParent)).toEqual([]);
  });

  it('retains evidence coverage for labeled unanswerable questions without calling it successful abstention', async () => {
    const report = await runLongMemEval([question({ question_id: 'contradiction_abs' })]);
    expect(report.summary.lexical?.unanswerable).toMatchObject({ questions: 1, meanEvidenceSessionRecall: 1 });
    expect(report.answerQuality.abstentionAccuracy).toBeNull();
  });
});

describe('bounded execution and file cleanup', () => {
  it('removes temporary databases after provider failure, timeout and cancellation', async () => {
    const { tempParent } = fixture();
    await expect(runLongMemEval([question()], { tempParent, embedder: { ...vectors, async embed() { throw new Error('Fixture provider failure'); } } })).rejects.toThrow('Fixture provider failure');
    expect(readdirSync(tempParent)).toEqual([]);
    let timedSignal: AbortSignal | undefined;
    await expect(runLongMemEval([question()], { tempParent, timeoutMs: 50, embedder: { ...vectors, async embed(_texts, { signal }) { timedSignal = signal; return new Promise<number[][]>(() => {}); } } })).rejects.toThrow(/tim|budget/);
    expect(timedSignal?.aborted).toBe(true); expect(readdirSync(tempParent)).toEqual([]);
    const control = new AbortController();
    await expect(runLongMemEval([question()], { tempParent, signal: control.signal, embedder: { ...vectors, async embed(texts) { control.abort(); return texts.map(() => [1, 0]); } } })).rejects.toThrow();
    expect(readdirSync(tempParent)).toEqual([]);
  });

  it('enforces embedding calls and total input bytes before invoking the adapter', async () => {
    const { tempParent } = fixture(); const embed = vi.fn(vectors.embed);
    await expect(runLongMemEval([question()], { tempParent, embedder: { ...vectors, embed }, maxEmbeddingCalls: 1 })).rejects.toThrow('Embedding call or input byte budget');
    expect(embed).toHaveBeenCalledTimes(1); expect(readdirSync(tempParent)).toEqual([]); embed.mockClear();
    await expect(runLongMemEval([question()], { tempParent, embedder: { ...vectors, embed }, maxEmbeddingInputBytes: 1 })).rejects.toThrow('Embedding call or input byte budget');
    expect(embed).not.toHaveBeenCalled(); expect(readdirSync(tempParent)).toEqual([]);
  });

  it('uses the remaining global deadline for every embedding batch and ignores late results', async () => {
    const { tempParent } = fixture(); let callCount = 0, resolveLate: ((value: number[][]) => void) | undefined, lateSignal: AbortSignal | undefined;
    const close = vi.spyOn(LocalMemory.prototype, 'close');
    const started = performance.now();
    await expect(runLongMemEval([question({ haystack_sessions: [Array.from({ length: 64 }, (_, index) => ({ role: 'user', content: `Orchid humidity sample ${index}` })), []] })], {
      tempParent, timeoutMs: 400, embedder: { ...vectors, async embed(texts, { signal }) {
        callCount++;
        if (callCount === 1) { await new Promise(resolve => setTimeout(resolve, 260)); return texts.map(() => [1, 0]); }
        lateSignal = signal; return new Promise<number[][]>(resolve => { resolveLate = resolve; });
      } },
    })).rejects.toThrow(/tim|budget/);
    expect(performance.now() - started).toBeLessThan(570);
    expect(callCount).toBe(2); expect(lateSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1); expect(readdirSync(tempParent)).toEqual([]);
    resolveLate?.(Array.from({ length: 32 }, () => [1, 0])); await setImmediate();
    expect(close).toHaveBeenCalledTimes(1); expect(readdirSync(tempParent)).toEqual([]);
  });

  it('reads only caller-supplied regular JSON files, fingerprints exact bytes and preserves the source file', async () => {
    const { root, tempParent } = fixture(); const path = join(root, 'fixture.json'); const input = `${JSON.stringify([question()])}\n`;
    writeFileSync(path, input);
    const report = await runLongMemEvalFile(path, { tempParent, datasetLabel: 'synthetic test only', datasetRevision: 'fixture-v1' });
    expect(report.dataset).toMatchObject({ sha256: createHash('sha256').update(input).digest('hex'), bytes: Buffer.byteLength(input), label: 'synthetic test only', revision: 'fixture-v1' });
    expect(readdirSync(root)).toContain('fixture.json'); expect(readdirSync(tempParent)).toEqual([]);
    await expect(runLongMemEvalFile(path, { maxDatasetBytes: 20 })).rejects.toThrow('regular JSON file');
    const link = join(root, 'linked.json'); symlinkSync(path, link); await expect(runLongMemEvalFile(link)).rejects.toThrow();
    await expect(runLongMemEvalFile(root)).rejects.toThrow('regular JSON file');
  });

  it('fingerprints raw UTF-8 file bytes including a BOM and retains the configured overall deadline', async () => {
    const { root, tempParent } = fixture(), path = join(root, 'bom.json');
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify([question()]))]);
    writeFileSync(path, raw);
    const report = await runLongMemEvalFile(path, { tempParent, timeoutMs: 12345 });
    expect(report.dataset).toMatchObject({ sha256: createHash('sha256').update(raw).digest('hex'), bytes: raw.length });
    expect(report.limits.timeoutMs).toBe(12345); expect(report.results).toHaveLength(1);
    expect(readdirSync(tempParent)).toEqual([]);
  });
});
