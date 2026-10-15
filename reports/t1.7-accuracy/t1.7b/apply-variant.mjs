// Swaps the reader system message in src/providers/index.ts for a named variant, in place, by exact
// string replacement of the single quoted literal. Refuses to run if it cannot find exactly one
// match, so it can never half-apply. `npm run build` afterwards or the driver tests the OLD prompt.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { VARIANTS } from './variants.mjs';

const name = process.argv[2];
if (!VARIANTS[name]) { console.error(`Unknown variant '${name}'. Known: ${Object.keys(VARIANTS).join(', ')}`); process.exit(2); }

const FILE = new URL('../../../src/providers/index.ts', import.meta.url);
const source = readFileSync(FILE, 'utf8');

// The literal currently in the file is whichever variant was applied last; find it by matching the
// shared tail, which every variant carries byte-identically.
const anchor = "Return only JSON: {\\\"answer\\\":\\\"concise answer\\\",\\\"action\\\":\\\"act\\\" or \\\"abstain\\\",\\\"citations\\\":[\\\"source key\\\"]}. Cite only supplied source keys that support the answer. Do not invent evidence.";
const pattern = /\{ role: 'system', content: '((?:[^'\\]|\\.)*)' \}/g;
const hits = [...source.matchAll(pattern)].filter(m => m[1].includes('Return only JSON'));
if (hits.length !== 1) { console.error(`Expected exactly one reader system literal, found ${hits.length}. Refusing to edit.`); process.exit(3); }

const wanted = VARIANTS[name].system;
// The file is TypeScript source in single quotes: escape backslashes and single quotes only.
const encoded = wanted.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const next = source.replace(hits[0][0], `{ role: 'system', content: '${encoded}' }`);
writeFileSync(FILE, next);

console.log(`variant        ${name}`);
console.log(`passAsOf       ${VARIANTS[name].passAsOf}`);
console.log(`system sha256  ${createHash('sha256').update(wanted).digest('hex')}`);
console.log(`system bytes   ${Buffer.byteLength(wanted)}`);
