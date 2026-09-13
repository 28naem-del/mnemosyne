import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createLocalMemory } from '../local/index.js';

const { values } = parseArgs({ options: { count: { type: 'string', default: '10000' }, queries: { type: 'string', default: '100' }, out: { type: 'string' } } });
const count = Number(values.count);
const queryCount = Number(values.queries);
if (!Number.isSafeInteger(count) || count < 100 || count > 100_000 || !Number.isSafeInteger(queryCount) || queryCount < 10 || queryCount > 1_000) throw new Error('count must be 100–100000; queries must be 10–1000.');
const directory = mkdtempSync(join(tmpdir(), 'mnemosyne-scale-'));
const memory = createLocalMemory({ path: join(directory, 'memory.sqlite'), workspaceId: 'benchmark', agentId: 'fixture-controller' });
const percentile = (samples: number[], fraction: number) => [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.floor(samples.length * fraction))];
try {
  const ids: string[] = [];
  const ingestStart = performance.now();
  for (let index = 0; index < count; index++) {
    ids.push(memory.store({ text: `Catalogue entry SKU${String(index).padStart(7, '0')} has export width ${1200 + index % 800} pixels. Department ${index % 32} requires owner approval before publishing.`, kind: 'fact', trust: 'observed', source: { uri: `fixture://catalogue/${index}` } }).id);
  }
  const ingestionMs = performance.now() - ingestStart;
  const exactMs: number[] = [];
  const broadMs: number[] = [];
  let exactHits = 0;
  for (let index = 0; index < queryCount; index++) {
    const expected = (index * 7919) % count;
    let started = performance.now();
    const results = memory.recall({ query: `SKU${String(expected).padStart(7, '0')}`, limit: 5 });
    exactMs.push(performance.now() - started);
    if (results.some(result => result.memory.id === ids[expected])) exactHits++;
    if (index < 20) {
      started = performance.now();
      memory.recall({ query: 'catalogue export approval', limit: 5 });
      broadMs.push(performance.now() - started);
    }
  }
  const report = {
    kind: 'synthetic local lexical retrieval smoke test; not an LLM or public memory benchmark',
    generatedAt: new Date().toISOString(), runtime: process.version, platform: `${process.platform}/${process.arch}`,
    records: count, queries: queryCount, backend: 'file-backed SQLite, per-record transactions, WAL',
    ingestionMs, exactIdentifier: { hitsAt5: exactHits, queries: queryCount, p50Ms: percentile(exactMs, 0.5), p95Ms: percentile(exactMs, 0.95) },
    broadQuery: { queries: broadMs.length, p50Ms: percentile(broadMs, 0.5), p95Ms: percentile(broadMs, 0.95) },
    limitations: ['Synthetic records and exact identifiers; this does not establish semantic recall or task improvement.', 'One local process; not a concurrent-agent load test.', 'Cold/warm cache states are not independently controlled.', 'No claims of AGI, competitor superiority or public-benchmark scores.'],
  };
  if (values.out) writeFileSync(resolve(values.out), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (exactHits !== queryCount) process.exitCode = 1;
} finally { memory.close(); rmSync(directory, { recursive: true, force: true }); }
