# mnemosy-ai-legacy

The Mnemosyne 1.x/2.x Qdrant engine — `createMnemosyne`, the vector `core`, `cognitive` (decay, retrieval scoring, consolidation, dream), `graph` (FalkorDB), `broadcast` (Redis pub/sub), `cache`, `pipeline` and the framework-agnostic `tools` — split out of `mnemosy-ai` for 3.0.0. `mnemosy-ai` itself is now the local SQLite kernel. See [the 3.0 migration notes](../../docs/MIGRATION-v3.md) for the import table and what replaced blind `dream()`/`consolidate()` consolidation.

This package is `"private": true` and not published to npm yet. Version 2.0.0 marks the code as it shipped inside `mnemosy-ai@2.0.0`; only import paths changed.

## Layout

```text
packages/legacy/
  package.json        name mnemosy-ai-legacy, private, exports ".", ./core, ./cognitive, ./graph,
                      ./broadcast, ./pipeline, ./cache, ./tools (built files in dist/)
  tsconfig.json       extends ../../tsconfig.json; rootDir src, outDir dist
  vitest.config.ts    runs tests/**/*.test.ts with this folder as root
  src/index.ts        createMnemosyne factory and the former mnemosy-ai root re-exports
  src/config.ts       copy of the 2.x resolveConfig used by the factory
  src/{core,cognitive,graph,broadcast,cache,pipeline,tools}/   moved from ../../src with git mv
  tests/              legacy-backend, legacy-maintenance, legacy-redirects, legacy-review-regressions,
                      broadcast-privacy, bm25, recall, store (moved from ../../tests)
  examples/           basic-usage, with-redis, with-falkordb (moved from ../../examples)
```

## Decisions

- **No npm workspaces.** Adding a workspace would rewrite `package-lock.json`. The folder has its own `package.json` but no `node_modules`; Node and TypeScript resolve `vitest`, `typescript`, `@types/node` and the optional `ioredis` from the repository root's `node_modules`, and npm scripts find the root `node_modules/.bin`.
- **Self-contained source.** Nothing under `src/` imports the kernel in `../../src`. The only kernel code the engine used was `resolveConfig` (`src/config.ts`), so the package carries its own copy, together with the mutable `DEFAULT_COLLECTIONS` it reads (`core/types.ts`, unchanged, including the deprecated `configureCollections`). The kernel keeps its own `resolveConfig` and an inline copy of the default collection names; the migration planner keeps an inline copy of `MEMORY_TYPES` to recognize legacy payloads. These copies describe a frozen 2.x format and are not expected to change.
- **Old subpaths preserved.** Each former `mnemosy-ai/<subpath>` for the engine is `mnemosy-ai-legacy/<subpath>` with the same exports, and the package root carries what the old `mnemosy-ai` root exported for the engine (including the default export). Kernel names (`createLocalMemory`, `reflect`, ...) are not re-exported; import them from `mnemosy-ai`.
- **`connectors` stayed in the kernel.** `mnemosy-ai/connectors` (`LocalSourceConnector`, `readLocalText`) syncs local files into the kernel's `MemoryRuntime` and backs the CLI; it never used the Qdrant engine.

## Build, test and use

From the repository root, after `npm ci`:

```sh
npm run test:legacy                          # build + typecheck examples + tests
npx vitest run --config packages/legacy/vitest.config.ts   # tests only
npm --prefix packages/legacy run build       # emit packages/legacy/dist
```

The tests use mocked HTTP/Redis transports and need no running services. The examples need live services; see the comments at the top of each file and run them after building, for example `node --experimental-strip-types packages/legacy/examples/basic-usage.ts`.

To use the engine from an application, build it and install the folder (or a tarball from `npm pack` inside it): `npm install /path/to/mnemosyne/packages/legacy`, then `import { createMnemosyne } from 'mnemosy-ai-legacy'`.
