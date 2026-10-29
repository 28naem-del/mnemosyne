import { realClient } from './lib.mjs';
const c = realClient();
const r = await c.user.listOrdered({ pageNumber: 1, pageSize: 100 });
console.log('users', r.totalCount ?? r.users?.length, (r.users ?? []).map(u => u.userId).slice(0, 30).join(' '));
