# AGENTS.md

Instructions for coding agents (Claude Code, Cursor, Codex, Copilot and others) that work inside this repository or want to use it as memory. A shorter, link-only summary for retrieval is in [llms.txt](llms.txt).

## What this repository is

`mnemosy-ai` is local-first, long-term memory for AI agents: a SQLite store that keeps memories with their evidence, retires dependent guidance when a source is corrected, and serves recall and context over TypeScript, MCP, CLI and HTTP. The [README](README.md) states the measured results and the two release targets that are not met; keep both halves when you touch any claim.

It is a separate project from [mnemosyne-oss/mnemosyne](https://github.com/mnemosyne-oss/mnemosyne), the Python `mnemosyne-memory` package; the two share a name, not code or maintainers. Do not mix their APIs, install commands or issue trackers.

## Use it as memory for your own agent

- Install: `npm install mnemosy-ai` (`latest` is the stable 2.0.0; pin `mnemosy-ai@2.0.0` for a reproducible install; the older 1.x engine stays installable as `mnemosy-ai@1`). The newest pre-release is 3.0.0-rc.3 on the `next` channel: `npm install mnemosy-ai@next` (or pin `mnemosy-ai@3.0.0-rc.3`); it is a breaking release, see [docs/MIGRATION-v3.md](docs/MIGRATION-v3.md).
- MCP: see the server entry in the [README](README.md#install-and-connect-an-agent). Tools are named `memory_*`; `--read-only` removes mutation tools; `--allow-destructive` is required for forgetting.
- SDK: `createLocalMemory` from `mnemosy-ai/local`; contracts in [docs/api.md](docs/api.md) and [docs/CONTEXT.md](docs/CONTEXT.md).
- Trust and scope are controller assertions. A model talking to the MCP server cannot change its workspace, raise its own trust or record its own skill trials.

## Work on the code

- Node.js 22.16 or newer (24 recommended). `npm ci --ignore-scripts`, then `npm run build`, then `npm rebuild hnswlib-node && npm run setup:embedder && npm run setup:reranker` (the optional native dense index and the pinned local models; `npm test` fails its env-gate check if tests that need them were skipped, as in CI). See [CONTRIBUTING.md](CONTRIBUTING.md#set-up-the-source-candidate).
- Full gate before any pull request: `npm run check` (typecheck, tests, example typecheck), `npm run check:docs` (local Markdown links and anchors), `npm run check:public` (package identity and public surfaces). CI runs the same three plus `npm audit` and an isolated install of the packed tarball.
- Tests live in `tests/` (Vitest). Add a failing test before a fix; the repository history records tests red before green.
- Source is `src/`; published code is `dist/` (built, not committed). Public entry points are listed under `exports` in [package.json](package.json).
- Documentation is part of the contract. If behaviour changes, update the matching guide in `docs/` and the [CHANGELOG](CHANGELOG.md) entry under `[Unreleased]` with the commit that made the change.

## Claims, numbers and benchmarks

- Every number in the README, CHANGELOG, [COMPARISON.md](COMPARISON.md) and `docs/evaluation/` traces to a report under `docs/evaluation/reports/` or `reports/`. Do not round, restate or extrapolate a measurement without the command that produced it.
- Unmet gates stay disclosed where the feature is described. Removing a disclosure is a regression.
- Use the wording in [docs/BENCHMARKS-TRUST.md](docs/BENCHMARKS-TRUST.md):
  - State a poisoning result as "zero escapes on suite vN (M cases, reproducible)". Never present it as resistance to every attack.
  - Describe consolidation as outcome-gated and reversible. Never call it safe without qualification.
  - Label synthetic corpora and ledgers synthetic.
  - Do not describe recorded experience as weight-level learning or as general intelligence.
- From 3.0.0-rc.2, `mnemosy demo` is the five-moment demo ([docs/DEMO.md](docs/DEMO.md)), and its PROOF lines are measured live. `scripts/verify-package.mjs` runs `demo --classic`, because it parses the 2.0.0 JSON report.
- Benchmark corpora (`benchmarks/data/`) are downloaded by `npm run benchmark:fetch` and are not committed.

## Do not

- Do not commit secrets, `.env` files, API keys, database files, model weights or personal data. `package.json` `files` and `.npmignore` exclude them from the package; keep both lists in sync.
- Do not run paid model calls from tests or examples. Every test and example runs offline with fixtures.
- Do not change `scripts/public-identity.json` or the contact address without a maintainer decision.
- Do not publish. Releases go through `.github/workflows/publish.yml` from a tagged commit with trusted publishing.

## Contact

Issues and feature proposals: [GitHub issues](https://github.com/28naem-del/mnemosyne/issues). Vulnerabilities: [SECURITY.md](SECURITY.md).
