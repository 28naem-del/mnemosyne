# Migration to 2.0.0-rc.1

This release candidate adds local memory alongside the existing Qdrant engine and intentionally changes unsafe behavior. Test against isolated copies before production use. No automatic database migration runs.

## Runtime and package

Node >=22.16 is required because the local kernel uses built-in SQLite. The package is ESM. `mnemosy-ai/local`, `/mcp`, and `/reflection` are new subpaths. `createMnemosyne` remains the Qdrant factory; `createLocalMemory` creates the separate SQLite engine. Root reexports are available, but importing `/local` keeps the dependency surface small.

Local and Qdrant records have different schemas and lifecycle capabilities. They are not silently synchronized or interchangeable. Existing installed OpenClaw plugins and fleet databases are not changed by installing this source checkout.

## Deliberate Qdrant changes

- **Retrieval score correction (#21).** Reciprocal-rank fusion no longer overwrites cosine similarity. Keyword-only hits are hydrated and receive bounded lexical relevance so they can pass a meaningful `minScore`; weak matches are rejected.
- **Keyword startup coverage (#22).** Startup awaits paginated indexing. The default cap is 50,000 records per collection, with configurable batch size/cap and explicit readiness/truncation diagnostics. This fixes the old silent 500-record horizon. It does not implement background progressive startup.
- **Explicit erasure.** Query-based forgetting is disabled. First inspect recall results, then pass a specific ID. An explicit collection must belong to the instance configuration. IDs present in multiple collections require disambiguation. Private record ownership is checked. Authorized soft-deleted points can also be physically removed.
- **Scope-aware retrieval and caching.** Graph matches supply IDs that are hydrated through scoped live Qdrant reads. Cached records are revalidated; deletion by another instance cannot be returned from stale cache when revalidation succeeds. This does not erase every distributed cache copy.
- **Nondestructive maintenance.** `memory.consolidate({ dryRun: true })` previews scoped maintenance. Consolidation/dream helpers accept a scoped `QdrantDB` for the supported replacement. URL-only destructive consolidation, dream, pattern-mining and lower-level mutation helpers reject before network access. Existing callers must migrate; do not catch this error and continue assuming work ran.
- **No cosine-based fact overwrite.** Similarity does not establish that one fact can replace another. Related facts survive; metadata/classification fields are normalized consistently.
- **Backend configuration.** Collections are instance-local; authentication, request timeouts, and embedding-dimension validation are supported. Startup can now fail on invalid responses, dimensions, or unavailable services instead of silently assuming success.

## Local trust and lifecycle

SDK stores default to untrusted, private memory. Explicitly use observed trust for accepted source assertions. Verified trust requires controller evidence; this is not cryptographic verification. MCP cannot self-promote trust, report outcomes, or modify verified records. Memory remains reference data, never permission to execute instructions.

Use `correct` for a changed source so dependents are invalidated. Set checkpoint `dependencies` to the source or procedure that its next action relies on; those handoffs retire with the obsolete source. Use `recordOutcome` for actual observed success/failure. Use explicit fact keys to detect competing values. No universal semantic contradiction detector is claimed.

Snapshots preserve owner scope and retry identity. Cross-agent provenance can cause owned records to be omitted; check the count. Import is atomic, bounded, and rejects inconsistent IDs. Forgetting purges the live local content closure; older snapshots, backups, copied prompts, and physical storage remnants remain outside its reach.
