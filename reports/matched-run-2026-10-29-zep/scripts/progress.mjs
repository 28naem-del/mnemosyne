import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { realClient, STATE } from './lib.mjs';
const c = realClient();
const users = [...new Set(readFileSync(join(STATE, 'users.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).user))];
const added = {}; for (const l of readFileSync(join(STATE, 'episodes.jsonl'), 'utf8').split('\n').filter(Boolean)) { const e = JSON.parse(l); added[e.user] = (added[e.user] ?? 0) + 1; }
let tot = 0;
for (const u of users) { const r = await c.graph.episode.getByUserId(u, { lastn: 1000 }); const e = r.episodes ?? []; const done = e.filter(x => x.processed !== false).length; tot += done;
  console.log(new Date().toISOString(), u.replace('mnemo-zeprun-20261029-matched-', ''), 'added', added[u] ?? 0, 'visible', e.length, 'processed', done); }
console.log('TOTAL processed', tot);
