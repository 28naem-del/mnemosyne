# Contributing to Mnemosyne

Use Node >=22.16; Node 24 is recommended. Local development and the default test suite need no external services or model API keys.

```sh
npm ci
npm run check
npm run demo
npm run benchmark -- --count 10000 --queries 100
```

`npm test` builds the CLI before running Vitest. `npm run test:watch` starts the watcher after an initial build; rebuild when changing subprocess CLI code. `npm run test:coverage` collects coverage. No lint or formatter command is currently configured.

## Where to work

- `src/local`: SQLite lifecycle, scope, provenance, retrieval, snapshots.
- `src/reflection`: bounded proposer and controller commitment.
- `src/mcp` and `src/cli`: actual protocol and command interfaces.
- `src/evaluation`: isolated executable demonstrations and synthetic scale probes.
- `src/core`, `cognitive`, `graph`, `cache`, `broadcast`, `pipeline`, `tools`, and root factory: Qdrant compatibility path and existing helpers.
- `site`: static public-site candidate; `docs`: maintained contracts and research evidence.

Read [architecture](ARCHITECTURE.md), [security boundaries](SECURITY.md), and [migration](docs/MIGRATION-v2.md) before modifying lifecycle or public behavior.

## Changes and review

Use strict TypeScript, bounded input, parameterized database queries, explicit network timeouts, and meaningful errors. Add regression tests for real bugs and tests for meaningful new behavior. Do not write a test that merely repeats an implementation detail. Validate the actual built CLI/MCP when changing a transport or package entry point.

Keep independent sources and conflicting facts intact. Do not merge facts solely because their embeddings are similar. Preserve explicit identity and source authority. Changes that alter erasure, scopes, trust, or provenance need independent review.

Run `npm run check`, inspect `npm pack --dry-run`, and explain the problem, resulting behavior, validation, and remaining limits in your pull request. Conventional Commits are welcome. Document breaking API/schema changes. Never use production databases for tests or publish private memory fixtures.

Performance claims need a reproducible workload and environment. Agent-improvement claims need held-out tasks, matched compute, and a meaningful baseline. Label demonstrations, mock-based integration tests, synthetic benchmarks, and real model evaluations separately. Cite primary sources when a mechanism draws on research.

Contributions are MIT licensed. Report reproducible non-sensitive bugs through [GitHub issues](https://github.com/28naem-del/mnemosyne/issues); use the private contact in [SECURITY.md](SECURITY.md) for vulnerabilities.
