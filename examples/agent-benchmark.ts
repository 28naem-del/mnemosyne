import { strict as assert } from 'node:assert';
import { runAgentBenchmark, noMemoryCondition, recentHistoryCondition, lexicalMemoryCondition, adaptiveMemoryCondition, type AgentBenchmarkDataset, type BenchmarkReader } from '../dist/evaluation/index.js';

// A deterministic integration demonstration. It does not measure an AI model's intelligence.
const dataset: AgentBenchmarkDataset = {
  protocol: 'mnemosyne-agent-benchmark-v1', name: 'Synthetic update and erasure demonstration', revision: '1', split: 'development',
  episodes: [{ id: 'deployment', category: 'updates-and-erasure', events: [
    { operation: 'remember', key: 'region', text: 'Deployment region: Oslo.' },
    { operation: 'task', id: 'initial', query: 'Deployment region?', answers: ['Oslo'], action: 'act', evidenceKeys: ['region'] },
    { operation: 'correct', key: 'region', text: 'Deployment region: Bern.' },
    { operation: 'task', id: 'changed', query: 'Deployment region?', answers: ['Bern'], staleAnswers: ['Oslo'], action: 'act', evidenceKeys: ['region'] },
    { operation: 'forget', key: 'region' },
    { operation: 'task', id: 'forgotten', query: 'Deployment region?', answers: ['unknown'], staleAnswers: ['Bern'], action: 'abstain', evidenceKeys: [] },
  ] }],
};
const reader: BenchmarkReader = { id: 'scripted-example', revision: '1', mode: 'scripted', async run({ context }) {
  const match = /Deployment region: (Oslo|Bern)/.exec(context);
  return match ? { answer: match[1], action: 'act', citations: ['region'] } : { answer: 'unknown', action: 'abstain', citations: [] };
} };
const report = await runAgentBenchmark(dataset, {
  reader, conditions: [noMemoryCondition(), recentHistoryCondition(), lexicalMemoryCondition(), adaptiveMemoryCondition()],
  trials: 3, maxContextUnits: 8192, maxOutputTokens: 128, maxReaderCalls: 36,
});
assert.equal(report.complete, true);
assert.equal(report.readerCalls, 36);
assert.equal(report.summaries['mnemosyne-adaptive'].successRate, 1);
console.log(JSON.stringify({ description: 'Synthetic harness verification; no model or competitor performance claim', externalModelCalls: 0, report }, null, 2));
