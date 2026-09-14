// Derives reports/matched-run-2026-09-14/summary.json from the merged raw reports.
// The published table is generated from this file, never typed by hand, so the
// prose and the measurement cannot drift apart.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'reports/matched-run-2026-09-14';
const load = f => JSON.parse(readFileSync(join(DIR, f), 'utf8'));

const ROWS = [
  ['lexical',         'Mnemosyne zero-model overlap'],
  ['bm25',            'Mnemosyne zero-model BM25'],
  ['hybrid-norerank', 'Mnemosyne hybrid (dense+BM25 RRF)'],
  ['hybrid',          'Mnemosyne hybrid + rerank'],
  ['system:mem0-oss', 'Mem0 OSS (extraction off)'],
];

const metrics = s => s === null || s === undefined ? null : ({
  recallAtK: s.meanRecall, anyHit: s.anyHitRate, allHit: s.allHitRate,
  mrr: s.mrr, p95RetrievalMs: s.p95RetrievalMs,
  questions: s.questions, completed: s.completed, errors: s.errors,
  annotatedQuestions: s.annotatedQuestions,
});

const runFor = (file, corpusLabel, k, note) => {
  const r = load(file);
  const notRun = (r.matched?.outcomes ?? []).filter(o => !o.available)
    .map(o => ({ id: o.id, status: 'not-run', reason: o.reason }));
  return {
    corpus: corpusLabel, topK: k, file,
    questions: r.dataset.questions, corpora: r.dataset.corpora,
    annotatedQuestions: r.summaries.bm25.annotatedQuestions,
    complete: r.complete,
    sourceSha256: r.dataset.sourceSha256, normalizedSha256: r.dataset.normalizedSha256,
    adapter: r.dataset.adapter,
    implementationSha256: r.runtime.implementationSha256,
    runtime: `${r.runtime.node} ${r.runtime.platform}`,
    durationSeconds: Number((r.durationMs / 1000).toFixed(1)),
    settings: r.settings,
    ...(note ? { note } : {}),
    rows: ROWS.map(([id, label]) => ({
      id, label,
      mode: id.startsWith('system:')
        ? (r.systems ?? []).find(s => s.condition === id)?.mode ?? null
        : null,
      ...( { metrics: metrics(r.summaries[id]) } ),
    })),
    notRun,
    ingest: (r.systems ?? []).map(s => ({ id: s.id, status: s.status, seconds: Number((s.ingestMilliseconds / 1000).toFixed(1)) })),
  };
};

const summary = {
  title: 'Mnemosyne matched run — 2026-09-14',
  generatedFrom: 'merged raw reports in reports/matched-run-2026-09-14/',
  spendUsd: 0,
  runs: [
    runFor('locomo-k5.json',  'LoCoMo (locomo10)', 5,  null),
    runFor('locomo-k10.json', 'LoCoMo (locomo10)', 10, 'headline K'),
    runFor('locomo-k20.json', 'LoCoMo (locomo10)', 20, null),
    runFor('longmemeval-stride10-k20.json', 'LongMemEval-S (cleaned)', 20,
      'every 10th question in source order (50 of 500); the release is grouped by category, so a prefix would be one category'),
  ],
};
writeFileSync(join(DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
console.log('wrote', join(DIR, 'summary.json'));
for (const run of summary.runs) {
  console.log(`\n${run.corpus} K=${run.topK}  q=${run.questions} annotated=${run.annotatedQuestions} complete=${run.complete}`);
  for (const row of run.rows) {
    const m = row.metrics;
    console.log('  ', row.label.padEnd(34), m ? `${(m.recallAtK*100).toFixed(2).padStart(6)}  ${(m.anyHit*100).toFixed(2).padStart(6)}  ${(m.allHit*100).toFixed(2).padStart(6)}  ${m.mrr.toFixed(4)}  ${m.p95RetrievalMs.toFixed(1).padStart(7)}ms` : 'NO METRICS');
  }
  for (const nr of run.notRun) console.log('   not run:', nr.id);
}
