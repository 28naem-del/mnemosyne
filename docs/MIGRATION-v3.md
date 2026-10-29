# Migration to Mnemosyne 3.0

The first 3.0 release on npm is the pre-release **3.0.0-rc.2** on the `next` channel (`npm install mnemosy-ai@next`, or pin `mnemosy-ai@3.0.0-rc.2`); rc.1 was not published. The `latest` channel stays on 2.0.0, so an unpinned `npm install mnemosy-ai` and an existing `^2` range are not affected until 3.0.0 is promoted.

Version 3.0.0 makes `mnemosy-ai` the local kernel only. The 1.x/2.x Qdrant engine — `createMnemosyne`, its vector, graph, broadcast, cache, pipeline and cognitive layers, and the framework-agnostic `tools` built on them — moved out of the public package into a separate package, `mnemosy-ai-legacy`, kept in this repository under [`packages/legacy`](../packages/legacy/README.md). Applications that use only `createLocalMemory`, the runtime, MCP, HTTP, CLI or other kernel subpaths need no code changes.

`mnemosy-ai-legacy` is **not published to npm yet** (`"private": true`). Until it is, install it from a checkout of this repository (see [keep using the legacy engine](#keep-using-the-legacy-engine)). Upgrading from 1.x? Read [the 2.0 migration notes](MIGRATION-v2.md) first; they still describe the legacy engine's behavior.

## What moved

| Before (`mnemosy-ai` 2.x) | After (3.0) |
|---|---|
| `import { createMnemosyne } from 'mnemosy-ai'` (also the default export) | `import { createMnemosyne } from 'mnemosy-ai-legacy'` |
| Root re-exports `QdrantDB`, `EmbeddingsClient`, `classifyMemory`, `BM25Index`, `reciprocalRankFusion`, `hybridSearch` | `mnemosy-ai-legacy` (root) or `mnemosy-ai-legacy/core` |
| Root re-exports `computeActivation`, `getDecayStatus`, `computeMultiSignalScore`, `applyDiversityReranking`, `detectQueryIntent`, `routeQuery`, `classifyExtendedIntent`, `computeConfidence`, `confidenceLabel`, `runConsolidation`, `maintainMemory`, `runDreamConsolidation`, `runPatternMining`, `memoryFeedback`, `detectFeedbackSignal` | `mnemosy-ai-legacy` (root) or `mnemosy-ai-legacy/cognitive` |
| Root re-exports `FalkorDBClient`, `activationSearch`, `findAutoLinks`, `createBidirectionalLinks` | `mnemosy-ai-legacy` (root) or `mnemosy-ai-legacy/graph` |
| Root re-exports `MemoryPublisher`, `MemorySubscriber`, `SharedBlockManager` | `mnemosy-ai-legacy` (root) or `mnemosy-ai-legacy/broadcast` |
| Root re-exports `looksLikePromptInjection`, `escapeMemoryForPrompt` | `mnemosy-ai-legacy` |
| Root types `MemCell`, `MemCellSearchResult`, `MemoryType`, `UrgencyLevel`, `Domain`, `ConfidenceTag`, `Classification`, `BroadcastMessage`, `Procedure`, `Mnemosyne`, `MnemosyneConfigInput`, `StoreOptions`, `RecallOptions`, `ForgetOptions` | `mnemosy-ai-legacy` |
| Root constants `MEMORY_TYPES`, `URGENCY_LEVELS`, `DOMAINS`, `CONFIDENCE_TAGS`, `CLASSIFICATIONS`, `DECAY_RATES`, `SOURCE_TRUST`, `DEFAULT_COLLECTIONS` | `mnemosy-ai-legacy` (root) or `mnemosy-ai-legacy/core` |
| `mnemosy-ai/core` | `mnemosy-ai-legacy/core` |
| `mnemosy-ai/cognitive` | `mnemosy-ai-legacy/cognitive` |
| `mnemosy-ai/graph` | `mnemosy-ai-legacy/graph` |
| `mnemosy-ai/broadcast` | `mnemosy-ai-legacy/broadcast` |
| `mnemosy-ai/pipeline` | `mnemosy-ai-legacy/pipeline` |
| `mnemosy-ai/cache` | `mnemosy-ai-legacy/cache` |
| `mnemosy-ai/tools` (`store`, `recall`, `forget`, `feedback`, `consolidate`, `dream`, `patterns`, `lessons`, `preferences`) | `mnemosy-ai-legacy/tools` |
| `examples/basic-usage.ts`, `examples/with-redis.ts`, `examples/with-falkordb.ts` | `packages/legacy/examples/` |

The legacy code is unchanged apart from these import paths; behavior documented in the [2.0 migration notes](MIGRATION-v2.md) still applies.

## What stays in `mnemosy-ai`

The package root now exports the local kernel only: `createLocalMemory`, `LocalMemory`, the `MemoryRecord`, `ContextPacket` and `MemorySnapshot` types, `reflect`, `commitVerifiedLesson`, and the `resolveConfig` helper with its `MnemosyneConfig`/`MemoryCategory` types (kept for configuration compatibility; it no longer drives an engine in this package). Every other kernel subpath is unchanged: `/local`, `/runtime`, `/agent`, `/context`, `/mcp`, `/http`, `/adapters`, `/providers`, `/providers/local`, `/local/embedding`, `/local/reranking`, `/reflection`, `/maintenance`, `/profiles`, `/relations`, `/branches`, `/bridge`, `/migration`, `/connectors` (local file source sync), `/operations` and `/evaluation`. The CLI, MCP server and HTTP service never used the legacy engine and are unaffected.

Importing data *from* a legacy Qdrant export still works without the legacy package: the [export migration](MIGRATION.md) planner recognizes legacy Mnemosyne payloads on its own, and the [bridge](BRIDGE.md) wraps any legacy search adapter you supply.

## Removed outright: blind `dream()` / `consolidate()` consolidation

`mnemosy-ai` 3.0 has no drop-in counterpart to the legacy `memory.dream()`, `memory.consolidate()`, `runDreamConsolidation`, `runConsolidation`, `maintainMemory` or the `consolidate`/`dream`/`patterns` tools. Those rewrite stored memories on a schedule from similarity and heuristics alone: they merge, demote or strengthen records without any observed task outcome showing the change was right, and without a record-level way to undo it. That is incompatible with the kernel's guarantee that advice only changes on evidence.

The kernel replaces it with an outcome-gated, reversible path:

- **Proposals, not rewrites.** [`reflect`](api.md#reflection) asks your model adapter for candidate lessons over cited memories; nothing is stored until a controller validates a proposal with an actual test and calls `commitVerifiedLesson`.
- **Outcome-gated promotion.** Procedures start as non-advisory candidates and are promoted only after successful [skill trials](RUNTIME.md#project-models-skill-trials-and-traces) across distinct tasks and verifiers; `recordOutcome` and traces record what actually worked, and failed outcomes or changed evidence retire advice.
- **Corrections instead of merges.** `correct` supersedes a stale source and invalidates everything that depended on it, keeping history; [maintenance checks](MAINTENANCE.md) detect stale evidence before it is used.
- **Gated consolidation instead of blind dreaming (3.0.0-rc.2).** [`mnemosy-ai/consolidation`](CONSOLIDATION.md) proposes merges as a signed diff and replays it against the agent's own recorded outcomes. The diff is kept only when nothing regresses and no invariant breaks, and one call undoes it, back to the identical state hash. Its `consolidate()` shares the legacy name but not the signature or the semantics: it takes a `LocalMemory` and a signer, and it never applies a pass that the gate did not keep.
- **Reversible by construction.** Staged [branches](RUNTIME.md#time-entities-and-branches) preview and merge with receipts, imports have a guarded undo ([migration](MIGRATION.md)), and backups/restore are covered in [operations](OPERATIONS.md).

If you relied on `dream()` to keep a Qdrant store small, keep using it through `mnemosy-ai-legacy`; its 2.x safeguards (scoped `QdrantDB`, `dryRun` previews, URL-only destructive helpers rejected) are unchanged.

## Keep using the legacy engine

1. Clone this repository at the release you depend on and build the legacy package:

   ```sh
   npm ci --ignore-scripts
   npm --prefix packages/legacy run build
   ```

2. Install it into your application from that folder (or `npm pack` it there and install the tarball):

   ```sh
   npm install /path/to/mnemosyne/packages/legacy
   ```

3. Replace imports as in the table above, for example `import { createMnemosyne } from 'mnemosy-ai-legacy'`. Install `ioredis` yourself if you use the graph, broadcast or Redis cache features (it is an optional peer dependency, as before; 5.x and 6.x are both supported).

The legacy package has no dependency on `mnemosy-ai`; you can install both side by side and migrate incrementally with the [bridge](BRIDGE.md). Staying on `mnemosy-ai@2` also keeps both engines in one package.
