# Matched-run competitor SDKs

These packages are installed **here**, not in the root `package.json`, on purpose:

- `mnemosy-ai` must never make a competitor's SDK a dependency of itself. `npm i mnemosy-ai`
  would otherwise pull in Mem0 and its whole transitive tree.
- The root `package-lock.json` stays untouched, so a benchmark dependency can never drift
  into the published package.

Install them with the repository-root script:

```sh
npm run benchmark:matched:install   # npm ci --prefix benchmarks/competitors
npm run benchmark:matched
```

Without this step `npm run benchmark:matched` still runs. It reports every competitor row as
**not run**, with the reason, and never as a number.

Versions here are exact, not ranges, because the matched run's published numbers are attached to
a specific competitor build.

## Running the matched benchmark on GitHub Actions

The `benchmark-matched` workflow ([`.github/workflows/benchmark-matched.yml`](../../.github/workflows/benchmark-matched.yml))
runs the same `npm run benchmark:matched` on GitHub's `ubuntu-latest` runners, so anyone with
access to the repository's Actions can rerun the comparison and read every log:

```sh
gh workflow run benchmark-matched --ref main -f corpus=locomo -f modes=bm25,hybrid,hybrid+rerank \
  -f competitors=mem0 -f top_k=5,10,20 -f max_questions=20   # smoke; drop max_questions for a full run
```

It installs Node 24, the two pinned local models, these competitor SDKs (when `competitors=mem0`)
and the corpora, each verified against its pinned SHA-256. It runs one job per corpus and K, and
LongMemEval-S is split into `lme_shard_size` haystacks per job and recombined with the
harness's own `--merge`; at most `max_parallel` (default 12) slices run at once, so pull-request CI keeps runner slots. Every job logs and stores its runner's CPU model, core count and memory,
because latency numbers mean something only together with the machine that produced them. The
assembled artifact holds the raw JSON reports, the per-slice parts and logs, a `SUMMARY.md` table
and a `MANIFEST.sha256` of every file. Mem0 runs with `infer:false` only, because the workflow has no
API keys. The `split` input is passed to the harness's `--split` flag
([`benchmarks/PROTOCOL-2026-10.md`](../PROTOCOL-2026-10.md)); LongMemEval-S shards are cut over the
split's own question count, and on a ref without `--split` any value other than `all` fails the run
instead of mislabelling a full-set result.
