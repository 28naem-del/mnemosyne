// Replaces the operator's absolute checkout path inside a raw report with `<repo>`, the same
// placeholder the 14 September raw reports carry. The path only appears in the free-text
// `matched.outcomes[].describes` field; no scored value contains it. The script refuses to
// write unless every occurrence is inside a `describes` string and the parsed report is
// otherwise deep-equal to the original.
// Usage: node redact-local-paths.mjs <absolute-checkout-path> <in.json.gz> <out.json.gz>
import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';

const [prefix, input, output] = process.argv.slice(2);
if (!prefix || !input || !output || !prefix.startsWith('/')) throw new Error('usage: redact-local-paths.mjs <absolute-checkout-path> <in.json.gz> <out.json.gz>');
const text = gunzipSync(readFileSync(input)).toString('utf8');
const occurrences = text.split(prefix).length - 1;
const redacted = text.split(prefix).join('<repo>');
const before = JSON.parse(text), after = JSON.parse(redacted);
const describes = report => (report.matched?.outcomes ?? []).map(outcome => outcome.describes);
const strip = report => ({ ...report, matched: { ...report.matched, outcomes: (report.matched?.outcomes ?? []).map(({ describes: _, ...rest }) => rest) } });
if (!isDeepStrictEqual(strip(before), strip(after))) throw new Error(`${input}: the path occurs outside matched.outcomes[].describes; refusing`);
const changed = describes(before).filter((value, index) => value !== describes(after)[index]).length;
if (redacted.includes('/Users/') || redacted.includes('/home/')) throw new Error(`${input}: another absolute home path remains; refusing`);
writeFileSync(output, gzipSync(Buffer.from(redacted, 'utf8'), { level: 9 }));
console.log(`${input}: replaced ${occurrences} occurrence(s) in ${changed} describes field(s)`);
