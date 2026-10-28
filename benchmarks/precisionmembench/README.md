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
| `run.mjs` | Starts the server, waits for `/health`, runs the pinned harness with `MEMORY_PROVIDER=mnemosyne RESEED=true`, copies the JSON reports to `reports/precisionmembench/<label>/`, stops the server. Fully synchronous. Exits 3 when an ava suite reported a failing case (which every run below has). |
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

# Configuration A (protocol-exact; the comparable number). No wrapper filter.
node benchmarks/precisionmembench/run.mjs --label final-lexical --retrieval lexical --metadata protocol --both
node benchmarks/precisionmembench/run.mjs --label final-hybrid  --retrieval hybrid  --metadata protocol --both
node benchmarks/precisionmembench/run.mjs --label final-hybrid-rerank --retrieval hybrid --metadata protocol --both --rerank

# Ablations (kernel options, still no wrapper filter)
node benchmarks/precisionmembench/run.mjs --label final-ablate-nonames-lexical --retrieval lexical --metadata protocol --both --named false
node benchmarks/precisionmembench/run.mjs --label final-ablate-nofuzzy-lexical --retrieval lexical --metadata protocol --both --no-fuzzy

# Configuration B (extended metadata; disclosed harness patch, not comparable)
node benchmarks/precisionmembench/run.mjs --label B-lexical --retrieval lexical --metadata extended --both --extended-harness
```

`--min-scores '<json>'` passes kernel score floors (`LocalMemory` `minScores`); the runs
above set none. The removed `--cutoff`, `--min-score` and `--min-sim` flags are rejected.

Each label directory holds `retrieval-report-mnemosyne.json` (per-case precision, recall,
pass flag and failure reasons), `session-retrieval-report-mnemosyne.json`, the full ava
output, the server log and `run-summary.json` (configuration, `wrapperFilter: "none"`,
`recallKinds: null`, the kernel options in force, benchmark commit, clone dirty-state, kernel commit, node version,
per-eval scores and server counters).

The hybrid runs need the bundled local models (`bge-small-en-v1.5`; the cross-encoder only
with `--rerank`) in `~/.cache/mnemosyne/models`. No network or API key is used at scoring time.

## Results (configuration A, protocol-exact, no wrapper filter)

Single-turn: 77 cases. Session: 2 cases, 12 scored turns. Mean precision / recall are the
harness's own aggregates.

| Label | Kernel | Single-turn | P / R | Session turns |
| --- | --- | --- | --- | --- |
| `A2-base-lexical` | 84cb6c3, before this work | 22/77 | 0.262 / 0.954 | 0/12 |
| `A2-base-hybrid` | 84cb6c3, before this work | 11/77 | 0.066 / 1.000 | 0/12 |
| `final-lexical` | 50a1eee, names gate (`auto`) + fuzzy, zero-model | **70/77** | 0.871 / 1.000 | 11/12 |
| `final-hybrid` | same + bge-small dense channel | **70/77** | 0.871 / 1.000 | 11/12 |
| `final-hybrid-rerank` | same + cross-encoder | 70/77 | 0.871 / 1.000 | 11/12 |
| `final-ablate-nonames-lexical` | `requireNamedMatch: false` | 20/77 | 0.249 / 1.000 | 0/12 |
| `final-ablate-nofuzzy-lexical` | `fuzzy: false` | 64/77 | 0.748 / 0.861 | 11/12 |

The `final-*` reports are canonical. The two `A2-base-*` runs used the earlier wrapper, which
passed `kinds: ['fact', 'preference', 'decision']` on every search; that predicate can only have
helped them. The same wrapper scored 12/12 session turns on the current kernel. That 12th turn
(session turn 5, `b-auth-open-q`) needs an open-question kind policy: the harness expects open
questions left out, but its `/search` never asks for it, so the kernel is not told about it and
the wrapper no longer supplies it. The reports of that wrapper (`merged-*`, `A2-lexical` and the
other non-base `A2-*` labels) were deleted; they remain in git history.

For comparison, the earlier wrapper-filtered runs (`A-lexical`, `A-hybrid`, kernel e0bbb47)
scored 44/77 and 48/77, with 5/12 and 6/12 session turns.

The fixture is public and small (35 beliefs). The kernel options were designed against
its failure classes (names in the query, typos, scope), so read these as "the kernel with
its name gate on this fixture", not as a held-out precision estimate.

## What the wrapper does and does not do

* `POST /add` stores one `observed` memory per belief with `metadata.beliefId`,
  `metadata.scope` and `metadata.names`: the harness's top-level `aliases` array plus the
  canonical name (the first word of the text). The session adapter's `/add` sends no
  aliases; the canonical name alone is declared then. Kind is mapped from the belief type
  when the protocol sends one, otherwise `fact`.
* `POST /search` calls `recall({ query, limit, metadata: { scope: [...] } })` and maps each
  result to its belief id. It passes no `kinds` predicate: the harness never asks to drop a
  kind, so a kind policy would be a wrapper-side filter. An open question still maps to the
  kernel kind `observation` when the protocol sends its type (the session adapter does;
  single-turn seeding does not), which is a translation only. `scope` becomes the
  kernel's metadata predicate, evaluated in the SQL of every channel before ranking.
  `providers.config.json` sets `supportsMultiScope: true`, so a multi-scope case is one
  `/search` with a scope array (protocol-exact either way).
* `PUT /update` (session eval) is a kernel `correct()` of the existing record with the new
  text; alias words inserted into the name prefix become extra names, one per word.
* No result is dropped, re-ranked, thresholded or deduplicated after `recall()` returns.
  Every exclusion is a kernel decision recorded in the ledger (`retrieval.config` carries
  `requireNamedMatch`, `fuzzy`, `metadataFilter`, and `minScores` when set;
  `retrieval.abstained` carries the reason for an empty answer).
* Configuration B maps `superseded_by` onto kernel supersession and resolved open questions
  onto validity windows; it needs the disclosed harness patch and is reported separately.
* The wrapper never reads the fixture or the case file.

## The kernel controls the run uses

* `requireNamedMatch: 'auto'`: a record that declares `metadata.names` is returned only
  when one of its names occurs in the query as a whole token phrase (underscores read as
  spaces); the names stage is also a candidate channel fused beside the text channel.
  This is what removes the long tail of beliefs that share a common word with the query.
* `fuzzy: true`: a query term with no exact posting in scope also matches stored terms one
  edit away (OSA distance 1, same first two letters, both at least four letters, no
  digits), at half weight, and name tokens match under the same guard.
* Native abstention: when nothing passes the gates the recall returns `[]` and records
  `no-candidates`, `no-named-match` or `below-floor`. 25 of the 77 cases expect an empty
  relevant set.

## The seven remaining failures, and why configuration A cannot pass them

Every remaining failure is one belief returned that the case expects excluded because of
lifecycle metadata the single-turn protocol does not send (`type`, `superseded_by`,
`resolved_at`). In each case the query contains one of that belief's own aliases, so a name
gate must admit it. The wire does carry lifecycle hints in natural language and identifiers
(text such as "Previously used ..." or "Was evaluating ...", names such as
`database_sqlalchemy_old`, belief ids such as `b-sqlalchemy-superseded`), but mining them would
be fixture-specific, so the kernel does not.

| Case | Belief returned | Query names it by | Excluded in the fixture because |
| --- | --- | --- | --- |
| `conflict-mongodb-supersedes-sqlalchemy` | `b-sqlalchemy-superseded` | `SQLAlchemy` | `superseded_by: b-db-decision` |
| `filter-resolved-at-excluded` | `b-hosting-resolved` | `Fly.io`, `self-host` | `type: open_question`, `resolved_at` set |
| `type-isolation-open-question-not-in-relevant` | `b-auth-open-q` | `JWT` | `type: open_question` |
| `multi-hop-supersession-chain-all-excluded` | `b-linting-v0`, `b-linting-v1` | `TSLint`, `ESLint` | `superseded_by` chain |
| `relation-type-expands-participants` | `b-auth-open-q` | `auth service` | `type: open_question` |
| `pinned-plus-resolved-excluded-from-questions` | `b-pinned-resolved-interaction` | `API versioning`, `v2 migration` | `type: open_question`, `resolved_at` set |
| `superseded-chain-query-terminal-only` | `b-linting-v0` | `TSLint` | `superseded_by: b-linting-v1` |

So 70/77 is the ceiling in configuration A for a provider that honours names and does not
mine lifecycle language from names, ids or text. The kernel
does exclude superseded and expired records natively (a non-historical recall never
surfaces them; `tests/local-precision-lifecycle.test.ts`), which configuration B exercises
once the harness sends the lifecycle fields.
