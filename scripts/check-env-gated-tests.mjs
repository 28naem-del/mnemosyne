#!/usr/bin/env node
// F8 guard — environment-gated tests must not vanish silently.
//
// Some suites only run when something outside the repository is present: the
// optional `hnswlib-node` native addon, or a model fetched by
// `npm run setup:embedder` / `setup:reranker`. On a bare host those tests are
// skipped, the suite still reports green, and a double-digit slice of the
// coverage is simply gone with nothing in the output saying so.
//
// `tests/env-gates.ts` prefixes every gated test name with `[env:<gate>]`. This
// script reads the JSON report `npm test` writes, prints how many gated tests
// actually RAN per gate, and exits non-zero when any gated test in it was
// skipped: a gate that contributed nothing, and equally a gate where one test ran
// and the rest quietly did not. It parses a report vitest already produced — no
// second suite run, no dependency.
//
// Escape hatch for a CI that is legitimately bare (no addon, no model):
//   MNEMOSYNE_ALLOW_BARE_TEST_ENV=1 npm test
// which downgrades the failure to a loud warning. Setting it is a statement
// that the missing coverage is known and accepted, not that it does not exist.
// A filtered run (`npm test -- -t <name>`) skips the gated tests it filters out,
// so it needs the same statement.
import { readFileSync, statSync } from 'node:fs';

const REPORT = process.argv[2] ?? process.env.VITEST_ENV_GATE_REPORT ?? '.vitest-report.json';
const TAG = /\[env:([^\]]+)\]/;
const STALE_MS = 2 * 60 * 60 * 1000;
const allowBare = process.env.MNEMOSYNE_ALLOW_BARE_TEST_ENV === '1';

function die(message) {
  console.error(`env-gated tests: ${message}`);
  process.exit(1);
}

let report, mtimeMs;
try {
  mtimeMs = statSync(REPORT).mtimeMs;
  report = JSON.parse(readFileSync(REPORT, 'utf8'));
} catch (error) {
  die(`cannot read the vitest JSON report at ${REPORT} (${error.code ?? error.message}).\n` +
      `  The "test" script writes it via --reporter=json. Run \`npm test\`, or point this\n` +
      `  script at a report: node scripts/check-env-gated-tests.mjs <path>`);
}
if (Date.now() - mtimeMs > STALE_MS) {
  die(`the report at ${REPORT} was written ${Math.round((Date.now() - mtimeMs) / 3600000)}h ago.\n` +
      `  Refusing to certify env-gate coverage from a stale run; re-run \`npm test\`.`);
}

// gate -> { ran, skipped }
const gates = new Map();
for (const file of report.testResults ?? []) {
  for (const assertion of file.assertionResults ?? []) {
    const name = assertion.fullName ?? [...(assertion.ancestorTitles ?? []), assertion.title].join(' ');
    const match = TAG.exec(name);
    if (!match) continue;
    const gate = gates.get(match[1]) ?? { ran: 0, skipped: 0 };
    if (assertion.status === 'passed' || assertion.status === 'failed') gate.ran++;
    else gate.skipped++;
    gates.set(match[1], gate);
  }
}

if (gates.size === 0) {
  // No gated file was part of this run (e.g. `npm test -- tests/local-store.test.ts`).
  // Nothing was hidden, so there is nothing to certify.
  console.log('env-gated tests: none in this run — no gate to check.');
  process.exit(0);
}

const names = [...gates.keys()].sort();
const ranTotal = names.reduce((sum, gate) => sum + gates.get(gate).ran, 0);
const total = names.reduce((sum, gate) => sum + gates.get(gate).ran + gates.get(gate).skipped, 0);
console.log(`env-gated tests: ${ranTotal}/${total} ran across ${names.length} gate(s)`);
for (const gate of names) {
  const { ran, skipped } = gates.get(gate);
  console.log(`  ${ran === 0 ? 'x' : skipped > 0 ? '!' : '✓'} env:${gate}  ran ${ran}, skipped ${skipped}`);
}

// One test running does not certify a gate: every gated test has to run.
const short = names.filter(gate => gates.get(gate).skipped > 0);
if (short.length === 0) process.exit(0);

const dark = short.filter(gate => gates.get(gate).ran === 0);
const partial = short.filter(gate => gates.get(gate).ran > 0);
const detail = [
  ...(dark.length ? [`every test behind ${dark.map(gate => `env:${gate} (${gates.get(gate).skipped} tests)`).join(', ')} was skipped`] : []),
  ...(partial.length ? [`${partial.map(gate => `env:${gate} skipped ${gates.get(gate).skipped} of ${gates.get(gate).ran + gates.get(gate).skipped} tests`).join(', ')}`] : []),
].join('; ');
const how = {
  hnsw: 'npm rebuild hnswlib-node  (builds the native addon that npm ci --ignore-scripts skips)',
  model: 'npm run setup:embedder',
  reranker: 'npm run setup:reranker',
};
const hints = short.map(gate => `  ${gate}: ${how[gate] ?? 'provide whatever this gate requires'}`).join('\n');
if (allowBare) {
  console.warn(`\n!! WARNING: ${detail}.`);
  console.warn(`!! This run did NOT cover that code. MNEMOSYNE_ALLOW_BARE_TEST_ENV=1 is set, so this is not a failure.`);
  console.warn(`!! To cover it:\n${hints}`);
  process.exit(0);
}
die(`${detail}, so this run did not cover that code.\n` +
    `  Green here does not mean those paths work. To cover them:\n${hints}\n` +
    `  If this host is meant to be bare, say so explicitly: MNEMOSYNE_ALLOW_BARE_TEST_ENV=1 npm test`);
