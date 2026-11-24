// Diagnostic only: does graph.search(scope=episodes) return episodes in score order?
import { realClient } from './lib.mjs';
const c = realClient();
const u = 'mnemo-zeprun-20261029-matched-conversation_1-0';
for (const q of ['When did Joanna start writing her screenplay?', 'What pets does Nate have?']) for (const limit of [5, 20]) {
  const r = await c.graph.search({ userId: u, query: q, limit, scope: 'episodes' });
  const e = r.episodes ?? [];
  console.log(JSON.stringify({ q: q.slice(0, 30), limit, n: e.length, scores: e.map(x => x.score === undefined ? null : Number(x.score.toFixed(3))), created: e.map(x => (x.createdAt ?? '').slice(11, 19)), keys: Object.keys(e[0] ?? {}).join(',') }));
}
