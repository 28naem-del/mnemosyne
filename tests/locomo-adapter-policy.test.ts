import { describe, expect, it } from 'vitest';
import { adaptLoCoMoCorpus, runCorpusBenchmark } from '../src/evaluation/corpus-benchmark.js';

const provenance = { dataset: 'locomo-fixture', revision: 'fixture-1', license: 'CC BY-NC 4.0' };
const sample = (evidence: unknown[]) => [{
  sample_id: 'fixture',
  conversation: {
    session_1_date_time: '2023/05/07 (Sun) 14:30',
    session_1: [
      { dia_id: 'D1:1', speaker: 'Caroline', text: 'I went to the support group on Sunday.' },
      { dia_id: 'D1:2', speaker: 'Melanie', text: 'How did it go?' },
    ],
  },
  qa: [
    { question: 'When did Caroline go to the support group?', answer: '7 May 2023', evidence, category: 2 },
    { question: 'Who asked how it went?', answer: 'Melanie', evidence: ['D1:2'], category: 1 },
  ],
}];

describe('LoCoMo malformed evidence policy', () => {
  it('rejects the whole corpus by default, so a silent label drop is impossible', () => {
    expect(() => adaptLoCoMoCorpus(sample(['D1:1 D1:2']), provenance)).toThrow(/Unknown LoCoMo evidence dialogue/);
    expect(() => adaptLoCoMoCorpus(sample(['D1:1']), provenance)).not.toThrow();
  });

  it('rejects an unknown policy rather than falling back to a lenient one', () => {
    expect(() => adaptLoCoMoCorpus(sample(['D1:1']), provenance, { onMalformedEvidence: 'repair' as never })).toThrow(/Invalid LoCoMo evidence policy/);
  });

  it('drops only the unresolvable identifiers and reports how many, repairing none', () => {
    // 'D1:1 D1:2' is a single space-joined identifier in the published corpus.
    // Splitting it would be inventing a label, so it is dropped and counted.
    const dataset = adaptLoCoMoCorpus(sample(['D1:1 D1:2', 'D1:1']), provenance, { onMalformedEvidence: 'skip' });
    const label = dataset.labels.find(entry => entry.questionId === 'fixture:0')!;
    expect(label.evidenceGroups).toEqual(['turn:D1:1']);
    expect(dataset.notices.some(notice => /Malformed-evidence policy: skip\. 1 unresolvable evidence identifiers were dropped across 1 questions; 0 questions lost all evidence/.test(notice))).toBe(true);
    expect(dataset.notices.some(notice => notice.includes('No identifier was repaired or inferred'))).toBe(true);
  });

  it('leaves a question with no resolvable evidence out of the positive denominator, not scored as a miss', async () => {
    const dataset = adaptLoCoMoCorpus(sample(['D9:9 D9:8']), provenance, { onMalformedEvidence: 'skip' });
    expect(dataset.labels.find(entry => entry.questionId === 'fixture:0')!.evidenceGroups).toEqual([]);
    expect(dataset.notices.some(notice => notice.includes('1 questions lost all evidence'))).toBe(true);
    const report = await runCorpusBenchmark(dataset, { topK: 10, includeBm25: true });
    expect(report.summaries.bm25!.questions).toBe(2);
    expect(report.summaries.bm25!.annotatedQuestions).toBe(1);
  });

  it('states the policy in the report notices even when nothing was dropped', () => {
    expect(adaptLoCoMoCorpus(sample(['D1:1']), provenance).notices.some(notice => /Malformed-evidence policy: reject\./.test(notice))).toBe(true);
  });
});

describe('asymmetric query embedder', () => {
  const embedder = (model: string, dimensions = 4) => ({ model, dimensions, embed: async (texts: readonly string[]) => texts.map(() => [1, 0, 0, 0]) });

  it('refuses a query embedder that does not share the document vector space', async () => {
    const dataset = adaptLoCoMoCorpus(sample(['D1:1']), provenance);
    await expect(runCorpusBenchmark(dataset, { embedder: embedder('a@1'), queryEmbedder: embedder('b@1') })).rejects.toThrow(/same model identity and width/);
    await expect(runCorpusBenchmark(dataset, { embedder: embedder('a@1'), queryEmbedder: embedder('a@1', 8) })).rejects.toThrow(/same model identity and width/);
  });

  it('refuses a query embedder supplied without a document embedder', async () => {
    const dataset = adaptLoCoMoCorpus(sample(['D1:1']), provenance);
    await expect(runCorpusBenchmark(dataset, { queryEmbedder: embedder('a@1') })).rejects.toThrow(/requires a document embedder/);
  });

  it('records whether the run used an asymmetric convention', async () => {
    const dataset = adaptLoCoMoCorpus(sample(['D1:1']), provenance);
    const symmetric = await runCorpusBenchmark(dataset, { embedder: embedder('a@1') });
    expect(symmetric.embedding).toEqual({ model: 'a@1', dimensions: 4, asymmetric: false });
    const asymmetric = await runCorpusBenchmark(dataset, { embedder: embedder('a@1'), queryEmbedder: embedder('a@1') });
    expect(asymmetric.embedding!.asymmetric).toBe(true);
  });
});
