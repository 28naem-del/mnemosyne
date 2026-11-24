import { realClient } from './lib.mjs';
const c = realClient();
try { const { rawResponse: r } = await c.project.get().withRawResponse();
  console.log('status', r.status, 'limit', r.headers.get('x-ratelimit-limit'), 'remaining', r.headers.get('x-ratelimit-remaining'), 'reset', r.headers.get('x-ratelimit-reset'));
} catch (e) { console.log('error', e?.statusCode, JSON.stringify(e?.body ?? '').slice(0, 300), e?.rawResponse?.headers?.get?.('retry-after')); }
