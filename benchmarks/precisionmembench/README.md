# PrecisionMemBench on the Mnemosyne kernel

[PrecisionMemBench](https://github.com/tenurehq/precisionMemBench) (MIT) scores a memory
provider's *retrieval precision* over a fixed belief fixture: 35 beliefs, 77 single-turn
cases and 2 multi-turn session cases, no LLM judge. The harness talks to the provider over
a small HTTP protocol (`DELETE /reset`, `POST /add`, `PUT /update`, `POST /search`).

This folder contains everything needed to reproduce the Mnemosyne numbers from a fresh
clone of this repository. Nothing here ships in the npm package (`benchmarks/` is not in
`package.json#files`), and the benchmark clone lives under the gitignored
`benchmarks/data/` directory.

## Files

| File | Purpose |
| --- | --- |
| `server.mjs` | PMB provider wrapper over the built kernel (`dist/local`). One `LocalMemory` per PMB `user_id`, all in one SQLite file, isolated only by the kernel's workspace scope. |
| `run.mjs` | Starts the server, waits for `/health`, runs the pinned harness with `MEMORY_PROVIDER=mnemosyne RESEED=true`, copies the JSON reports to `reports/precisionmembench/<label>/`, stops the server. Fully synchronous. |
| `sweep.mjs` | Runs several `run.mjs` configurations and prints one table row each. |
| `patches/pmb-register-provider.patch` | Adds the `mnemosyne` entry to the clone's `providers.config.json`. |
| `patches/pmb-extended-metadata.patch` | Configuration B only: makes the clone's `BaseAdapter.seedMetadata` forward `type`, `pinned`, `superseded_by`, `created_at`, `resolved_at` during single-turn seeding. Applied by `run.mjs --extended-harness` for one run and reverted afterwards. |

## Reproduce

```sh
npm ci && npm run build
git clone https://github.com/tenurehq/precisionMemBench benchmarks/data/precisionmembench
git -C benchmarks/data/precisionmembench checkout 61a712a1754e7d27b6dee42da32a2c214b003ece
git -C benchmarks/data/precisionmembench apply "$PWD/benchmarks/precisionmembench/patches/pmb-register-provider.patch"
npm --prefix benchmarks/data/precisionmembench install --ignore-scripts --no-audit --no-fund

# Configuration A (protocol-exact; the comparable number)
node benchmarks/precisionmembench/run.mjs --label A-lexical --retrieval lexical --metadata protocol --min-score 3 --cutoff 0.5 --both
node benchmarks/precisionmembench/run.mjs --label A-hybrid  --retrieval hybrid  --metadata protocol --min-sim 0.65 --cutoff 0.5 --both

# Configuration B (extended metadata; disclosed harness patch, not comparable)
node benchmarks/precisionmembench/run.mjs --label B-lexical --retrieval lexical --metadata extended --min-score 3 --cutoff 0.5 --both --extended-harness
node benchmarks/precisionmembench/run.mjs --label B-hybrid  --retrieval hybrid  --metadata extended --min-sim 0.65 --cutoff 0.5 --both --extended-harness

# Raw kernel output with no wrapper-side filtering (the honest floor)
node benchmarks/precisionmembench/run.mjs --label lexical-protocol-raw --retrieval lexical --metadata protocol
```

Each label directory holds `retrieval-report-mnemosyne.json` (per-case precision, recall,
pass flag and failure reasons), `session-retrieval-report-mnemosyne.json`, the full ava
output, the server log and `run-summary.json` (configuration, benchmark commit, clone
dirty-state, kernel commit, node version, per-eval scores and server counters).

The hybrid runs need the bundled local models (`bge-small-en-v1.5`; the cross-encoder only
with `--rerank`). They are fetched into `~/.cache/mnemosyne/models` by the kernel. No network
or API key is used at scoring time.

## What the wrapper does and does not do

* `POST /add` stores one `observed` memory per belief with `metadata.beliefId` and
  `metadata.scope`. Kind is mapped from the belief type when the protocol sends one
  (preference → preference, decision → decision, entity/relation → fact, open question →
  observation), otherwise `fact`.
* `POST /search` calls `recall({ query, limit: 100 })`, keeps results whose `metadata.scope`
  is in the requested scope(s), dedupes by belief id and returns `{ results: [{ id, memory, score }] }`.
* `PUT /update` (session eval) is a kernel `correct()` of the existing record with the new text.
* Configuration B maps `superseded_by` onto kernel supersession (`correct()` of the superseded
  record, so a chain `v0 → v1 → current` is a real kernel supersession chain), gives resolved
  open questions a validity window (`validFrom = created_at`, `validUntil = resolved_at`) and
  keeps open questions out of `/search` results (type routing). All of this needs information
  the single-turn protocol does not send, hence the harness patch and the separate label.
* The wrapper never reads the fixture or the case file.

## The two wrapper-side filters, and why they exist

The kernel's `recall()` returns every candidate with a positive score; it has no "nothing
relevant" abstention. PMB penalises every unexpected belief, so with no filter the kernel
returns almost all 34 beliefs for most queries (recall 0.95, precision 0.26, 22/77 passed).
`server.mjs` therefore applies, after scope filtering:

* `MNEMOSYNE_PMB_MIN_SCORE` — absolute floor (lexical BM25 only; `3` chosen).
* `MNEMOSYNE_PMB_CUTOFF` — relative floor: drop results scoring below `cutoff × top score`
  (`0.5` chosen).
* `MNEMOSYNE_PMB_MIN_SIMILARITY` — the kernel's own dense-similarity floor (`0.65` chosen for hybrid).

The values were chosen by a sweep on the public fixture (see
`reports/precisionmembench/sweep-*/sweep.json`). That is tuning on the only data the benchmark
has, so read the chosen-configuration numbers as "best wrapper configuration on this fixture",
and the raw run as the unfiltered kernel. The sweep is in the repository so the trade-off is
auditable. The product finding is that the kernel needs a native abstention threshold; the
wrapper's filters are the stand-in until it has one.
