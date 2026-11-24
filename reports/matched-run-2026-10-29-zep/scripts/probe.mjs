import { realClient } from './lib.mjs';
const c = realClient();
const u = process.argv[2];
for (const n of [10, 50, 100, 369, 1000]) {
  const r = await c.graph.episode.getByUserId(u, { lastn: n });
  const e = r.episodes ?? [];
  console.log('lastn', n, 'returned', e.length, 'unprocessed', e.filter(x => x.processed === false).length, 'processed-undefined', e.filter(x => x.processed === undefined).length);
}
