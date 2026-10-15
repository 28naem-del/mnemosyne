// $0 proof that a variant edit reaches the model. Imports the BUILT adapter from dist/ -- the same
// module the driver imports -- stubs fetch to capture the outbound body and return a canned valid
// reply, and prints the system message and payload keys that were actually sent. No network, no key.
// If `npm run build` was skipped, this prints the OLD prompt, which is exactly the failure it exists
// to catch.
import { createHash } from 'node:crypto';
import { createCompatibleBenchmarkReader } from '../../../dist/providers/index.js';

let sent = null;
globalThis.fetch = async (_url, init) => { sent = JSON.parse(init.body);
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"x","action":"act","citations":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }); };

// T1-targets (lane t17): `--prompt-version <name>` probes any named prompt shipped in
// `src/providers/index.ts` (BENCHMARK_READER_PROMPTS) at $0, no network, no rebuild beyond the
// normal `npm run build` -- superseding the old `apply-variant.mjs` (which edited the source
// literal in place and is no longer needed since prompts are now selected, not hand-edited).
const promptIndex = process.argv.indexOf('--prompt-version');
const promptVersion = promptIndex < 0 ? undefined : process.argv[promptIndex + 1];
const reader = createCompatibleBenchmarkReader({ baseUrl: 'https://example.invalid/api/v1', model: 'probe', apiKey: 'not-a-key', revision: 'probe', ...(promptVersion ? { promptVersion } : {}) });
await reader.run({ query: 'q', context: 'ctx', sourceKeys: ['k'], seed: 1, maxOutputTokens: 64,
  ...(process.argv.includes('--with-as-of') ? { asOf: '2023-05-20 (Sat) 02:36' } : {}), signal: AbortSignal.timeout(5000) });

const system = sent.messages.find(m => m.role === 'system').content;
const user = JSON.parse(sent.messages.find(m => m.role === 'user').content);
console.log(`system sha256   ${createHash('sha256').update(system).digest('hex')}`);
console.log(`system bytes    ${Buffer.byteLength(system)}`);
console.log(`user keys       ${JSON.stringify(Object.keys(user))}`);
console.log(`asOf on wire    ${user.asOf ?? '(absent)'}`);
console.log(`system verbatim ${system}`);
