// Environment gates, tagged so a skipped test is a *countable* skipped test.
//
// A handful of suites can only run when something outside the repository is
// present: the optional `hnswlib-node` native addon, or a model downloaded by
// `npm run setup:embedder` / `setup:reranker`. Historically each site wrote its
// own `const withX = available ? it : it.skip`, which is correct but silent —
// on a bare host those tests report as skipped among all the other skips and
// nobody notices that a double-digit slice of the suite stopped running.
//
// These wrappers do the same gating and additionally prefix the test name with
// `[env:<gate>]`. That prefix is the whole mechanism: it survives into vitest's
// JSON report, so `scripts/check-env-gated-tests.mjs` can count, per gate, how
// many gated tests actually ran and fail the check when a gate contributed
// nothing. Tag a new gated test and it is counted automatically — there is no
// manifest to keep in sync.
import { describe, it } from 'vitest';

/** Prefix marker. Shared with scripts/check-env-gated-tests.mjs — keep in step. */
export const ENV_GATE_PREFIX = 'env:';

type TestBody = Parameters<typeof it>[1];
type TestOptions = Parameters<typeof it>[2];
type SuiteBody = Parameters<typeof describe>[1];

function tag(gate: string, name: string): string {
  return `[${ENV_GATE_PREFIX}${gate}] ${name}`;
}

/** `it`, gated on `available`, tagged with `gate`. */
export function gatedIt(gate: string, available: boolean) {
  const run = available ? it : it.skip;
  return (name: string, body: TestBody, options?: TestOptions): void => {
    run(tag(gate, name), body, options);
  };
}

/** `describe`, gated on `available`, tagged with `gate`. Every test inside inherits the tag through its full name. */
export function gatedDescribe(gate: string, available: boolean) {
  const run = available ? describe : describe.skip;
  return (name: string, body: SuiteBody): void => {
    run(tag(gate, name), body);
  };
}
