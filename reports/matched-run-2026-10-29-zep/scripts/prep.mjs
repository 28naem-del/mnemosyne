// Phase 1: load each LoCoMo conversation into Zep once, through the repository's Zep adapter
// (session.ingest = sequential graph.add + wait-for-processed), recording episode uuids.
// Usage: node prep.mjs <kind> <concurrency> <index...>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPETITORS, DIST, STATE, KEY_ENV, ZEP_VERSION, harnessChunks, loadCorpus, realClient, recordingClient } from './lib.mjs';

const [kind, conc, ...idx] = process.argv.slice(2);
mkdirSync(STATE, { recursive: true, mode: 0o700 });
const { createZepFactory } = await import(join(DIST, 'evaluation', 'matched-zep.js'));
const { dataset } = await loadCorpus(kind, undefined, kind === 'longmemeval' ? Number(process.env.STRIDE || 10) : 1);
const stats = { added: 0, replayed: 0, credits: 0, calls: {} };
const client = recordingClient(realClient(), 'ingest', stats);
const factory = createZepFactory({ baseDir: COMPETITORS, client, ingestSettleMs: 6 * 3600_000 });
const resolution = await factory.resolve({ seed: 0, signal: new AbortController().signal });
if (!resolution.available) throw new Error(resolution.reason);
console.log(`prep ${kind} key=${KEY_ENV} sdk=${ZEP_VERSION} conversations=${idx.join(',')}`);
const timer = setInterval(() => console.log(new Date().toISOString(), JSON.stringify(stats)), 60_000);
const results = {};
const queue = idx.map(Number);
async function worker() {
  for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
    const corpus = dataset.corpora[i];
    const chunks = await harnessChunks(corpus, i);
    const t0 = Date.now();
    try {
      const session = await resolution.system.create({ corpusId: corpus.id, seed: 0, signal: new AbortController().signal });
      await session.ingest(chunks, { signal: new AbortController().signal });
      results[i] = { corpus: corpus.id, chunks: chunks.length, seconds: (Date.now() - t0) / 1000, status: 'processed' };
    } catch (e) {
      results[i] = { corpus: corpus.id, chunks: chunks.length, seconds: (Date.now() - t0) / 1000, status: 'failed', error: String(e?.message ?? e).split('\n')[0].slice(0, 400), statusCode: e?.statusCode };
    }
    console.log(new Date().toISOString(), 'done', i, JSON.stringify(results[i]));
    writeFileSync(join(STATE, `prep-${kind}-${i}.json`), JSON.stringify(results[i], null, 2));
  }
}
await Promise.all(Array.from({ length: Number(conc) }, worker));
clearInterval(timer);
console.log('FINAL', JSON.stringify({ results, stats }));
