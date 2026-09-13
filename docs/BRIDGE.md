# Gradual migration beside an existing memory system

`MemoryBridge` lets an existing agent keep its old memory backend while Mnemosyne
learns the records the agent actually uses. The host supplies one read-only search
adapter. Each search result is staged as an exact, private Mnemosyne source before
it can appear in agent context. The old backend remains connected and unchanged.
The existing [full migration](MIGRATION.md) preview/apply/undo workflow remains
available for a deliberate bulk move.

```ts
import { createLocalMemory } from 'mnemosy-ai/local';
import { MemoryRuntime } from 'mnemosy-ai/runtime';
import { MemoryBridge } from 'mnemosy-ai/bridge';
import { MemoryAgent } from 'mnemosy-ai/agent';

const memory = createLocalMemory({
  path: './memory.db', workspaceId: 'my-project', agentId: 'assistant',
});
const runtime = new MemoryRuntime(memory);
const bridge = new MemoryBridge(runtime, {
  adapter: {
    id: 'my-existing-memory-adapter-v1',
    family: 'mem0',
    sourceStore: 'my-existing-store',
    sourceOwner: 'explicit-user-id',
    search: async ({ query, limit, maxBytes, signal }) => {
      // Call your existing SDK here. Scope it to the configured owner, honor
      // cancellation and limits, and map original text plus stable revisions.
      return existingMemorySearch({ query, limit, maxBytes, signal });
      // Array shape: [{ id: 'stable-id', revision: 'revision-token', text: '...' }]
    },
  },
  // Omit this to import as untrusted, outside advisory agent context.
  trust: 'observed',
});
const agent = new MemoryAgent(runtime, { contextProvider: bridge.contextProvider });
const before = await agent.beforeTurn({ query: 'Deployment rules', maxTokens: 8192 });
// Or use agent.runTurn(...) with your existing responder for final validation.
```

The adapter is a small SDK interface, not an automatic account connector. There
is no credential discovery, provider selection, background scan, timer, legacy
write, or model call. Its owner selection and `observed` trust are explicit host
assertions; they do not authenticate the backend or prove its claims. The bridge
copies exact original text, including whitespace and UTF-8, without summarizing
it during migration. The default `untrusted` copies remain inspectable/searchable
with `includeUntrusted: true`; they are excluded from agent advisory context and
do not earn adoption credit.

## How adoption works

1. **Shadow:** every query searches the old backend. Mnemosyne stores the returned
   sources and also runs its own local candidate retrieval before importing this
   query's results. Rendering uses the reconciled legacy order.
2. **Assist:** after three consecutive nonempty paired queries reach the configured
   coverage threshold, eligible local retrieval hits can supply up to half the
   returned memories. Missing matches still come from the legacy search and are
   staged locally before rendering.
3. **Prefer Mnemosyne:** after ten consecutive successful paired queries, all
   matching local hits can supply the context and are ordered first. Legacy search
   still runs on every query and supplies every missing match.

Only a source already returned by actual local retrieval, with the same current
legacy revision and text, is counted as a local match. Copying a new legacy search
result does not immediately turn it into a local retrieval success. Routing uses
the phase established before this query; a promotion applies to the next query.
Empty searches, incomplete coverage, failures and explicit rollback reset the
consecutive streak. The default threshold is 100% of eligible returned matches;
`promotion` can set `assistAfter`, `preferAfter` and `minCoverage` (0.5–1).

This is observed retrieval coverage, not a measurement of answer quality or the
percentage of all memories migrated. `status().totalLegacyCoverage` is always
`'unknown'`: a search interface cannot enumerate the complete old store. It never
automatically disconnects the old backend. Rarely used memories remain there and
can be migrated when first returned by the old search. An empty search never
deletes a remembered source. The provider also merges eligible private native
originals returned by Mnemosyne's own local retrieval, so newly captured host
memories remain useful during coexistence. Native originals do not count toward
legacy coverage. It excludes foreign/shared records, migration records and any
unconfirmed bridge copies from this native path. Generated representations and
dependent native advice are excluded from this conservative provider; their
eligible original records can still be retrieved through the native path.

## Corrections, concurrency and rollback

A new opaque revision updates the original source and invalidates dependent
advice. Revision equality with different bytes is rejected. Returning to an old
revision creates a fresh generation rather than reactivating old derived advice.
The SDK preserves durable source bindings and adoption counters across restarts.
Adapter configuration and trust must match the established bridge identity.

Each request reserves a durable sequence before calling the old backend. A newer
request, privacy erasure or rollback prevents an older in-flight callback from
committing stale results, including across instances sharing one database. Local
edits, outcomes and source-watch changes are checked again before committing or
returning context. These checks observe the backend response at query time; they
cannot lock an external service against a subsequent change.

```ts
bridge.setMode('legacy'); // Immediate routing rollback, preserves all copies.
bridge.setMode('auto');   // Starts gradual promotion again from shadow.
const progress = bridge.status();
const result = await bridge.recall({ query: 'Deployment rules', maxTokens: 8192 });
bridge.validate(result.context); // Synchronous, instance-bound final check.
```

`setMode('legacy')` invalidates outstanding contexts and in-flight searches. It
keeps using the old search while retaining source tracking in Mnemosyne. It does
not bypass a failed staging operation: the existing host can handle the explicit
fallback error described below. It is never a destructive reverse migration.

## Privacy across gradual and full migration

```ts
bridge.forget('external-stable-id');
```

Forgetting erases local source generations and dependent content and records a
shared hashed origin tombstone. It prevents reappearance through both gradual and
full migration, including a result already in flight. The old backend is never
modified: delete there separately through your existing trusted control if desired.
Direct `runtime.forgetSource()` for a bridge source also blocks reimport. Privacy
erasure remains available when recall/capture are disabled; read-only policy
denies mutation.

Use the same family, source store, collection where applicable, source owner and
external ID in both migration paths. Legacy Mnemosyne requires `collection`.
LangGraph's external ID is `JSON.stringify([namespace, key])`; Graphiti's is
`JSON.stringify([group_id, uuid])`. Namespaces, groups and tags alone do not prove
ownership. Keep the configured owner selection explicit in the existing SDK.

## Bounds and explicit failures

`budgets` bounds returned matches (default 32, maximum 64), serialized legacy
response bytes (256 KiB), original source bytes (64 KiB each), complete context
bytes (256 KiB), candidate and control scans, one callback deadline (10 seconds)
and context lifetime (30 seconds). The bridge validates the returned response
even if the adapter ignored the supplied bounds. It does not silently truncate
the match set or source text to fit a prompt. A caller-provided callback can ignore
cancellation, but its late result never writes to Mnemosyne. Context lifetime
uses a monotonic clock, so a backward wall-clock adjustment cannot extend it.
The combined prompt has at most 64 source IDs. Native candidates beyond the
remaining slots are not selected; every eligible legacy match is retained.

The default token counter measures **UTF-8 bytes of the entire serialized context**,
including instructions, IDs, source metadata, escaping and texts. A custom
`tokenCounter` requires a stable `tokenizerId`; the complete prompt must satisfy
both its token budget and the independent byte budget. Tokenizer callbacks run
outside write transactions, and source changes during them invalidate the result.
Copied-revision counters commit with the source copies even if a later context
budget check fails; such failures do not count as successful paired usage.
Every rendered memory ID is an actual current local source. The `MemoryAgent`
provider validates the packet after build and immediately before responder
dispatch. Source watches, outcome evidence, erasure, packet tampering, later
requests and expiry invalidate previously issued packets.

`MemoryBridgeError` exposes a sanitized `code`. A bounded `legacyFallback` may be
available after a staging or envelope-budget failure. That array is transient
host-only data, not a valid Mnemosyne context: the existing host must explicitly
choose its own previous memory path. The bridge and `MemoryAgent` never silently
render untracked fallback claims. Cancellation, stale callbacks, policy failures,
revision conflicts and an unavailable old backend provide no fallback claims.
Copies survive outages, but are not presented as confirmed current without legacy
reconciliation. Adoption demotes on failure instead of hiding it.

Control rows contain hashed identity/revision bindings and counters, with no
source texts, queries or provider error details. Original sources are deliberately
retained in the scoped local database. Local owner selectors are not enterprise
authentication, and erasure cannot guarantee removal from external backups.

Run the assertions in [the offline example](../examples/gradual-migration.ts):

```sh
npm run build
node --experimental-strip-types examples/gradual-migration.ts
```

It demonstrates gradual promotion, actual local retrieval, a source correction,
dependent invalidation, a missing legacy match, immediate rollback, the host agent
provider and forgotten-source replay protection with zero external model calls.
