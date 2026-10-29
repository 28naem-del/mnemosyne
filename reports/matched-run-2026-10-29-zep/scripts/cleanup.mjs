// Phase 3: delete every Zep user this run created (user.delete removes the user's graph and episodes),
// then list users to confirm none with our prefix remain. Usage: node cleanup.mjs [--dry]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE, USER_PREFIX, KEY_ENV, realClient } from './lib.mjs';

const dry = process.argv.includes('--dry');
// --only=0,1,8 limits deletion to those LoCoMo conversation users (others stay for a still-running bench).
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',').map(i => `${USER_PREFIX}matched-conversation_${i}-0`);
const c = realClient();
const file = join(STATE, 'users.jsonl');
const recorded = existsSync(file) ? [...new Set(readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).user))] : [];
const listed = async () => { const r = await c.user.listOrdered({ pageNumber: 1, pageSize: 1000 }); return (r.users ?? []).map(u => u.userId); };
const before = await listed();
const targets = [...new Set([...recorded, ...before.filter(u => u.startsWith(USER_PREFIX))])].filter(u => !only || only.includes(u));
console.log(`key=${KEY_ENV} users before=${before.length} ours=${targets.length}`);
for (const u of targets) {
  if (dry) { console.log('would delete', u); continue; }
  try { await c.user.delete(u); console.log('deleted', u); }
  catch (e) { console.log('delete failed', u, e?.statusCode, JSON.stringify(e?.body ?? '').slice(0, 200)); }
  await new Promise(r => setTimeout(r, 400));
}
const after = await listed();
console.log(`users after=${after.length} ours remaining=${after.filter(u => u.startsWith(USER_PREFIX)).length}`);
