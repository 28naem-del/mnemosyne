# Typed profiles with source evidence

`MemoryProfiles` keeps a caller-defined profile as a private, source-backed projection. Each field is explicitly `known`, `unknown`, or `conflict`. A known value carries supporting source IDs; conflicting candidates each carry their own supporting IDs. The library does not select a winner or infer missing fields automatically.

```ts
import { z } from 'zod';
import { createLocalMemory } from 'mnemosy-ai/local';
import { MemoryRuntime } from 'mnemosy-ai/runtime';
import { MemoryProfiles } from 'mnemosy-ai/profiles';

const memory = createLocalMemory({
  path: './memory.sqlite', workspaceId: 'my-workspace', agentId: 'my-agent',
});
const runtime = new MemoryRuntime(memory);
const profiles = new MemoryProfiles(runtime);
const preferences = profiles.define({
  key: 'user-preferences', version: '1',
  fields: {
    language: z.enum(['en', 'de', 'ar']),
    theme: z.enum(['light', 'dark']),
    city: z.string().max(120),
  },
});

// Reading never calls a proposer. Initially every field is unknown.
const current = profiles.get(preferences);
if (current.status === 'ready' && current.fields.language.status === 'known') {
  const language: 'en' | 'de' | 'ar' = current.fields.language.value;
}
memory.close();
```

## Explicit refresh

Call `profiles.refresh({ definition, sourceIds, proposerId, proposer, ...budgets })` with scoped source IDs and a host-owned callback. The callback receives original supplied source records, per-field JSON Schemas, instructions, byte limits, and an abort signal. It returns `{ fields: { ... } }`, either as an object or JSON text:

```ts
const result = await profiles.refresh({
  definition: preferences,
  sourceIds: [firstSource.id, secondSource.id],
  proposerId: 'my-model-and-profile-prompt-v1',
  proposer: async ({ sources, signal }) => {
    // Host-owned extraction/model call; no provider is chosen by Mnemosyne.
    return {
      fields: {
        language: { status: 'known', value: 'en', sourceIds: [sources[0].id] },
        theme: { status: 'unknown' },
        city: {
          status: 'conflict',
          candidates: [
            { value: 'Dubai', sourceIds: [sources[0].id] },
            { value: 'Berlin', sourceIds: [sources[1].id] },
          ],
        },
      },
    };
  },
});
```

Those example values illustrate the response format. A real proposer must derive its claims from the provided evidence. `known` describes a schema-valid claim with attribution, not factual certification. A citation alone does not prove that a source entails a value. Profiles remain advisory and `observed`, never automatically `verified`; source trust labels are controller assertions, not authentication.

Every defined field must appear exactly once. Unknown fields contain only `status`. Known fields need a schema-valid JSON value and at least one supplied source ID. Conflicts need two to eight distinct values, each with supporting supplied IDs. Duplicate citations, foreign IDs, extra properties, missing fields, invalid values, and silent Zod stripping/coercion are rejected before persistence. All supplied inputs become dependencies, including inputs that no individual field cites. Transitive dependencies retain their existing exact source lineage.

Refresh from original evidence or intermediates belonging to other profile definitions. A profile cannot depend directly or transitively on an earlier revision of the same definition. Such a refresh is rejected before the proposer runs, preserving the current profile and preventing an ambiguous pair of active revisions.

An unchanged refresh reuses its durable projection with `modelCalls: 0` when reuse is found before dispatch. A fresh generation invokes the callback once, with no automatic retry. `inputBytes` measures the complete serializable request delivered to that callback, including the field schemas and instructions. Identical concurrent generations can converge on a single committed record; a callback already dispatched still reports `modelCalls: 1` and its input bytes even if the returned status is `reused`. The host remains responsible for any additional calls or spending inside its callback.

## Freshness, correction and forgetting

Profiles use `AdaptiveContext.refresh({ representation: 'structured' })` and `inspectProjection`, sharing the existing full dependency, source-check, outcome and projection integrity checks. Structured storage allows schema overhead to exceed the length of a short original fact; all byte and dependency limits still apply. The profile adapter also validates a complete read set immediately before handing sources to the host callback.

`get(definition)` revalidates stored schema shape and the complete source state every time. It returns:

- `ready`: the unique active projection and its typed fields.
- `unknown`: no matching stored profile; all fields are unknown.
- `stale`: evidence, shape, or the active revision is unusable or ambiguous; all fields are unknown and no old values are returned.
- `disabled`: runtime recall is disabled; all fields are unknown and records are not read.

A correction, erasure, expiry, changed source check, or success/failure outcome anywhere in the supplied dependency closure invalidates the old profile. Reconfirming a source does not silently certify the old interpretation: call `refresh` explicitly. Forgotten source lineages remove dependent profiles, and captured transcript tombstones continue to block replay. No profile text is retained in an internal cache.

By default, unwatched sources may be used, and existing watches must be fresh. Set `requireWatched: true` on refresh/get to require fresh watched original evidence throughout the closure. Generated intermediates derive their validity from that evidence; if they also have an explicit watch, it must be fresh too. Nothing here fetches a source or schedules a check. Use [memory maintenance](MAINTENANCE.md) for host-supplied checks, and [host action guards](AGENT.md) immediately before consequential host actions. A returned profile is a point-in-time snapshot, not a lock on future source changes.

## Definitions, scope and limits

Recreate a definition after reopening using the same key, version and schemas. Its durable identity includes the JSON Schema fingerprint. Changing the schema shape or explicit version yields a separate profile. Increment `version` for changes to custom refinements or other validation semantics that JSON Schema cannot express. Every read still runs current validation. Definitions are instance-bound tokens; copies and tokens from another `MemoryProfiles` instance are rejected.

Use synchronous, pure Zod validators for JSON values. The accepted parsed value must equal the supplied JSON, so defaults, stripping and coercion cannot change claims silently. Types that cannot produce a JSON Schema, async validation, non-JSON values, cyclic values, accessors, sparse arrays and unsafe object keys are unsupported. Schema callbacks are host-owned code; the library cannot preempt blocking JavaScript inside a schema or proposer.

The fixed limits are 32 fields, 64 unique source IDs, eight candidates per conflict, 4,096 UTF-8 bytes per JSON value, six levels of nested value containers, 4,096 nodes per serialized JSON envelope, and 16 KiB of JSON Schema descriptors. Options permit `maxInputBytes` up to 1 MiB (default 64 KiB), `maxOutputBytes` up to 16 KiB (default 16 KiB), and `timeoutMs` up to 60 seconds (default 10 seconds). The output budget includes the persisted profile envelope and the context proposal wrapper, so leave space for attribution and JSON escaping. Timeouts abort the supplied signal and discard late results; stopping external work requires a cooperating host callback.

`MemoryProfiles(runtime, { maintenance?, maxScanRecords?, maxDependencyRecords? })` supports the existing context inventory and dependency bounds. Inventory exhaustion fails closed. Profile values remain private to the creating agent and workspace; explicit shared source records may contribute to independently generated private profiles. Both capture and recall must be enabled to refresh. With capture disabled, existing fresh profiles remain readable. There are no implicit model calls, account discovery, configuration changes, timers, network clients or managed synchronization.

The executable [synthetic example](../examples/profiles.ts) demonstrates typed conflict preservation, correction invalidation, and explicit refresh without a provider or network call.
