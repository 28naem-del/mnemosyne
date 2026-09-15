#!/usr/bin/env node
// Fetches a public evaluation corpus into benchmarks/data/. The corpora are NOT
// redistributed by this package and keep their own licenses; LoCoMo is CC BY-NC 4.0,
// which is why `npm run benchmark` needs this explicit, separate step.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const CORPORA = {
  locomo: { url: 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json', file: 'locomo10.json',
    sha256: '79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4', license: 'CC BY-NC 4.0', source: 'snap-research/locomo' },
};
const { values } = parseArgs({ options: { corpus: { type: 'string', default: 'locomo' }, out: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) { console.log(`node scripts/fetch-benchmark-corpus.mjs [--corpus ${Object.keys(CORPORA).join('|')}] [--out DIR]`); process.exit(0); }
const spec = CORPORA[values.corpus];
if (!spec) throw new Error(`Unknown corpus ${values.corpus}`);
const directory = resolve(values.out ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'benchmarks', 'data'));
mkdirSync(directory, { recursive: true, mode: 0o700 });
console.log(`[benchmark:fetch] ${spec.source} (${spec.license}) -> ${directory}`);
const response = await fetch(spec.url, { redirect: 'follow' });
if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== spec.sha256) throw new Error(`Digest ${digest} does not match the recorded ${spec.sha256}; the upstream corpus changed. Verify before using it.`);
const target = join(directory, spec.file);
writeFileSync(target, bytes, { mode: 0o600 });
console.log(JSON.stringify({ file: target, bytes: bytes.byteLength, sha256: digest, license: spec.license }, null, 2));
