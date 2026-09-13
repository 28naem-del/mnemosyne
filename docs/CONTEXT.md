# Adaptive context and exact evidence

`AdaptiveContext` turns scoped memory into a bounded prompt. It can use an overview, a detailed projection, a runtime observation, or an exact original excerpt. Generated projections preserve dependency links to their evidence. If their recorded evidence state changes, the builder withholds them and tries current originals instead.

```ts
import { createLocalMemory } from 'mnemosy-ai/local';
import { MemoryRuntime } from 'mnemosy-ai/runtime';
import { AdaptiveContext } from 'mnemosy-ai/context';

const memory = createLocalMemory({
  path: './memory.sqlite', workspaceId: 'atlas', agentId: 'assistant',
});
const runtime = new MemoryRuntime(memory);
const context = new AdaptiveContext(runtime);
const packet = await context.build({
  query: 'How should I publish the Atlas release?', maxTokens: 2048,
  taskId: 'release-preview', modelId: 'your-host-model-and-revision',
});
// Pass only packet.text to the model, in a reference-data channel.
// Revalidate at dispatch if any asynchronous work occurred after construction.
if (!context.validate(packet).valid) throw new Error('Rebuild current context');
console.log(packet.text);
memory.close();
```

Construction and `build` start no scheduler, network call or model. Build is read-only, including when it creates an excerpt. The existing `MemoryRuntime` capture and recall switches apply. A disabled capture switch still allows building context; it prevents new projections. Disabled recall blocks building, expansion and projection work.

## Budget and selection contract

`maxTokens` applies to the complete JSON text envelope, including instructions, IDs, source references and range metadata. Structured `items`, `handles`, `citations` and diagnostics are outside this budget: do not append them to a prompt and assume it still fits. If the envelope cannot fit, the text is empty and `abstained` is true.

The default counter charges one token per UTF-8 byte and is labeled `utf8-byte-estimate`. It is a conservative estimate, not a provider tokenizer. Supply both `tokenCounter(text)` and `tokenizerId` to count with an actual model tokenizer. The returned count must be a positive safe integer for nonempty text. The builder checks the final rendered result; this module cannot verify a host tokenizer's accuracy. Change `tokenizerId` when its semantics change.

Selection uses bounded lexical candidates and related projections. In adaptive mode it tries overviews, details and observations before original sources, avoids covering the same source repeatedly, and chooses an exact query-focused source range if a full original does not fit. Generated claims are never silently cut in half. This is a deterministic packing heuristic; it is not a semantic completeness guarantee. `level: 'detail'` prioritizes details, `level: 'overview'` skips detailed projections, and `level: 'source'` bypasses generated representations.

Limits are explicit: query 4096 bytes; candidate count 1–100 (default 64); at most 64 selected roots; context text at most 1 MiB; complete dependency closure at most 2048 records; projection inventory default 1000, configurable up to 10000. An incomplete inventory or excessive dependency closure fails closed. Cancellation uses a caller-supplied `AbortSignal`; synchronous local work checks it between bounded steps.

## Durable incremental compaction

Compaction is optional work with an explicit callback. This module does not choose a provider or spend on a model by itself.

```ts
const result = await context.compact({
  key: 'atlas-history', sourceIds: capturedRecords.map(record => record.id),
  proposerId: 'my-summarizer-model-and-prompt-v1',
  proposer: async request => {
    // Your existing provider implementation; obey request.signal and output limit.
    return myConfiguredSummarizer(request);
  },
  batchSize: 8, maxCalls: 5, maxInputBytes: 65536,
  maxTotalInputBytes: 262144, maxOutputBytes: 4096, timeoutMs: 10000,
});
```

The ordered input can contain up to 512 distinct IDs. Stable batches of 8–64 sources produce L1 details; one L0 overview depends on those details. Appending history keeps earlier batch identities reusable. A partial final batch changes identity when it grows. The same evidence and proposer policy reuse the same durable records without a callback. Exhausting the call limit returns completed details plus `deferredBatches`; another invocation can resume through those existing records. Byte-budget violations and provider failures reject the invocation; any previously completed, valid batches remain reusable. There is no implicit retry or installed background loop.

`refresh` is the lower-level single-projection operation. It accepts `key`, up to 64 `sourceIds`, `tier: 'overview' | 'detail'`, `proposerId`, `proposer`, and the same per-call limits. The callback receives exact supplied records, a source-as-data instruction, an abort signal and an output bound. It must return `{ text, sourceIds }`, or a JSON string containing that object. Every supplied ID must be cited exactly once, and the projection must be shorter than its source text. Citation validation proves attribution structure, not the factual correctness or completeness of generated prose.

Every new projection is a private, observed memory record with ordinary dependency lineage in the existing SQLite store. It never upgrades trust to verified and does not publish to another agent automatically. Replacing a projection key retires its prior representation and dependent overview. Source forgetting therefore removes dependent projections through the same local erasure path; there is no second text cache to clean.

Run the [synthetic example](../examples/adaptive-context.ts) after building. It asserts two detail batches and one overview, zero calls on replay, exact original expansion, and deletion invalidation. Its scripted callbacks demonstrate mechanics and byte reduction; they are not a model-quality benchmark.

## Freshness and exact expansion

The builder uses `MemoryMaintenance`, supplied explicitly or created for the runtime. Watches and source checks are read from the same store. Every selected record and transitive dependency must be eligible and either fresh or unwatched. `requireWatched: true` requires fresh watches for original inputs and non-generated dependencies. Unwatched generated projections, observations and models are allowed only when their complete generation proof validates recursively against those inputs. An explicitly watched generated record must still be fresh; generation proof cannot override its stale or failed check. The host creates and confirms source policies. With an injected clock, pass a maintenance instance using that same clock.

Each new projection records a fingerprint covering complete source records, source revisions, dependencies, trust, successful and failed outcomes, and freshness state/check revisions. The builder revalidates it before reuse. Corrections, forgetting, conflicting facts, failed outcomes, changed checks and expired freshness suppress affected data. A new positive outcome or confirmation also changes the projection fingerprint; current raw evidence remains available when otherwise eligible. Source reads are not confirmations. Model-generated summaries cannot refresh their own evidence through repeated use.

New `MemoryRuntime` models and generated observations carry `generationStateVersion: 'v1'` and a full `generationFingerprint`; the builder can reuse them with the same checks. The runtime revalidates this generation state at actual proposer dispatch and before committing results. New observations depend on every input supplied to the proposer, even inputs omitted from its cited subset, so source forgetting covers all potentially influenced text.

Legacy runtime representations lack this complete generation-time fingerprint. Their existing runtime APIs remain available, but this builder conservatively falls back to current original leaves instead of certifying historical source-check state. To replace them here, run `refresh` or `compact` on those current originals. This fallback also applies when a new projection's proposed input depends on a legacy generated representation. Existing durable job IDs and the original runtime source fingerprint remain compatible; completed legacy jobs are not silently rerun.

`packet.handles` are tamper-evident, instance-bound pointers to exact leaf sources. `context.expand(handle, { offset, maxBytes, signal })` returns an original UTF-8 slice and `nextOffset` when more remains. It checks the selected root and complete lineage again, including freshness. Offsets must be UTF-8 boundaries. Another builder instance cannot redeem a handle; build a new packet after restart. Handles are references, not authorization to read another agent's private records.

`validate(packet)` checks the original packet object, its content and the full selected lineage. Cloning or altering the packet fails validation. A check is a point-in-time assertion; it cannot recall bytes that a host already sent to an external provider. For external actions, use the lifecycle coordinator or maintenance read sets with complete dependency roots and exact action arguments. Scope selectors and controller assertions are not authentication; use the authenticated transport boundary for remote clients.

## Cache semantics and limits

The bounded in-memory selection cache retains IDs, byte ranges and hashes only. It does not retain rendered prompts, source records or original text. Every build retrieves current candidates and reconstructs selected bytes. Its identity includes workspace, agent, query, task, model, tokenizer policy, budget, level, watched policy, current projection inventory, and complete candidate dependency state. A new relevant candidate or changed evidence produces a miss. `maxCacheEntries: 0` disables it; `clearCache()` clears local selection plans.

`cache.status` and `reusedItems` describe local selection reuse. They are not provider prompt-cache hit counts or billing savings. Stable identical requests produce identical prompt bytes, but this module does not promise provider-specific prefix activation, cache expiry management, automatic multimodal observation, or a persistent process between host invocations.

The design draws on established observation and progressive-context patterns documented by [Mastra](https://mastra.ai/docs/memory/observational-memory), [OpenViking](https://github.com/volcengine/OpenViking), and [Hindsight](https://hindsight.vectorize.io/developer/observations), checked September 13, 2026. Those systems already implement substantial memory processing. This module's tests establish bounded local behavior and evidence invalidation; they do not establish competitive answer-quality superiority.

## Structured projections

`refresh({ ..., representation: 'structured' })` explicitly permits a serialized payload whose schema overhead is larger than its source text. The default `summary` representation still requires shorter text. Both retain the same input/output byte limits, complete source attribution, private observed storage and full source-state checks at provider dispatch and commit. Representation participates in reuse and record identity. The caller owns validation of any structured schema; the generic context layer does not certify field values. Hierarchical `compact` remains summary-only.

`context.inspectProjection(recordId, { requireWatched: false })` performs a synchronous point-in-time read without retrieval ranking. It returns an owned context projection only after validating its full dependency closure, including source-check and outcome state. Missing, foreign, ineligible or stale projections return `undefined`; disabled recall, invalid options and exceeded dependency limits throw. Unwatched records remain allowed by default. With `requireWatched: true`, original inputs and non-generated dependencies must be watched and fresh; unwatched generated records require recursively valid generation proof, and explicit watches on generated records must remain fresh. Reinspect immediately before using retained structured data; the returned object is not a live view.

A policy or source-set change creates a new projection revision, including when a caller returns to an earlier policy. Retired results are not resurrected through idempotency. Identical concurrent refreshes can reuse a just-committed record after both proposers ran; inspect `modelCalls` rather than assuming every `status: 'reused'` result spent zero calls.
