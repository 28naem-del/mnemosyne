// Auth smoke: project.get() per key (0 credits). Prints status codes and non-secret plan fields only.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../wt/benchmarks/competitors/package.json', import.meta.url));
const { ZepClient } = require('@getzep/zep-cloud');
for (const name of ['ZEP_API_KEY', 'ZEP_API_KEY_FREE']) {
  const key = process.env[name];
  if (!key) { console.log(name, 'unset'); continue; }
  const client = new ZepClient({ apiKey: key });
  try {
    const { data, rawResponse } = await client.project.get().withRawResponse();
    const p = data.project ?? data;
    const safe = Object.fromEntries(Object.entries(p).filter(([k]) => !/key|secret|token/i.test(k)));
    console.log(name, 'status', rawResponse.status, 'rpm-limit', rawResponse.headers.get('x-ratelimit-limit'), JSON.stringify(safe));
  } catch (e) {
    const body = typeof e?.body === 'object' ? JSON.stringify(e.body) : String(e?.body ?? '');
    console.log(name, 'error status', e?.statusCode ?? 'n/a', (e?.message ?? '').split('\n')[0].slice(0, 200), body.slice(0, 300));
  }
}
