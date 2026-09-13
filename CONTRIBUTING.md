# Contributing to Mnemosyne

Help make agent memory reliable, inspectable and easy to adopt. Useful contributions include reproducible bug reports, bounded integrations, improvements to evidence retention, clear examples and fair evaluation. Start with [release status](docs/UPGRADE-STATUS.md) and existing [issues](https://github.com/28naem-del/mnemosyne/issues) to avoid overlapping work.

## Set up the source candidate

Use Node.js ≥22.16; Node 24 is recommended. The default suite uses isolated local databases and needs no external services or model API keys.

```sh
npm ci --ignore-scripts
npm run check
npm run demo
npm run demo:learning
npm run test:python
```

The Python client tests require Python ≥3.10. `npm run check` typechecks, builds, tests and checks the examples. `npm test` builds before running Vitest. `npm run test:watch` performs an initial build; rebuild when changing code exercised through subprocesses. Use `npm run test:coverage` for coverage. No lint or formatter command is configured.

## Find the right module

| Area | Source | Contract |
|---|---|---|
| Memory, scope, corrections and retrieval | `src/local` | [Local API](docs/api.md) |
| Host lifecycle, context and typed profiles | `src/agent`, `src/context`, `src/profiles` | [Agent](docs/AGENT.md), [context](docs/CONTEXT.md), [profiles](docs/PROFILES.md) |
| Capture, jobs, models, skills and freshness | `src/runtime`, `src/maintenance` | [Runtime](docs/RUNTIME.md), [freshness](docs/MAINTENANCE.md) |
| Import, gradual adoption and recovery | `src/migration`, `src/bridge`, `src/operations` | [Migration](docs/MIGRATION.md), [bridge](docs/BRIDGE.md), [operations](docs/OPERATIONS.md) |
| Configured models and source/tool adapters | `src/providers`, `src/connectors`, `src/adapters` | [Local models](docs/LOCAL-MODELS.md), [provider tools](docs/PROVIDER-TOOLS.md) |
| Transports and client | `src/mcp`, `src/http`, `src/cli`, `python` | [Runtime interfaces](docs/RUNTIME.md) |
| Experiments and diagnostics | `src/evaluation` | [Corpus protocol](docs/evaluation/CORPUS_PROTOCOL.md), [evidence protocol](docs/evaluation/EVIDENCE-PROTOCOL.md) |

The root factory and `src/core`, `cognitive`, `graph`, `cache`, `broadcast`, `pipeline` and `tools` maintain the existing backend path. Read [architecture](ARCHITECTURE.md), [security](SECURITY.md) and [version migration](docs/MIGRATION-v2.md) before changing shared behavior.

## Submit a reviewable change

Describe the concrete problem and resulting behavior in your pull request. Keep the patch bounded, preserve unrelated edits, and document breaking API or schema changes. Use strict TypeScript, parameterized database queries, bounded inputs, network timeouts and actionable errors. Add meaningful behavior tests and regressions for actual failures; validate the built CLI or protocol when changing a transport.

Changes to scope, trust, erasure, provenance or promotion requirements need independent review. Keep conflicting sources distinguishable. Embedding similarity alone is not authority to merge facts. Use synthetic fixtures or properly licensed public data; never include credentials, private histories, production database copies or private operational paths.

Before submission, run the relevant checks and `npm run check`. For package changes, inspect `npm pack --dry-run --ignore-scripts` and exercise the built package entry points. State which checks ran and any limits. Optional local model changes must follow the pinned dependency and provisioning instructions in [LOCAL-MODELS.md](docs/LOCAL-MODELS.md); the default installation must remain usable without them.

## Make claims reproducible

Keep source data separate from private grading labels. Preserve failures, overflows and exclusions in reported denominators. Record dataset licenses, revisions, runtime fingerprints, context budgets and provider settings. Retrieval coverage, synthetic lifecycle checks, mocked protocol tests and live generated-answer evaluation measure different things; label them separately. Agent-improvement claims need held-out tasks, matched compute and meaningful baselines.

Source contributions are distributed under the project's [MIT license](LICENSE). Retain applicable third-party notices and authorship. Follow the [code of conduct](CODE_OF_CONDUCT.md). Use [GitHub issues](https://github.com/28naem-del/mnemosyne/issues) for non-sensitive discussion and [28naime@gmail.com](mailto:28naime@gmail.com) for private security reports, integration enquiries or maintainer contact.
