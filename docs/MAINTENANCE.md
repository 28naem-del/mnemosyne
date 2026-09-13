# Detect stale evidence before using it

The rc5 `MemoryMaintenance` service adds explicit source freshness checks and short-lived action read sets to the existing provenance engine. A stored fact can age without receiving a contradictory message. This service makes that uncertainty visible and can withhold it from a freshness-aware retrieval path. Age alone never changes a fact's text, truth, trust or historical validity.

The service runs locally through `mnemosy-ai/maintenance` or the `health` CLI. It does not fetch URLs, read source files, choose a model, install a scheduler, or rewrite facts automatically. A controller chooses which facts need checking, provides check evidence and decides how to handle a changed source.

## A clock and a source policy

```js
import { createLocalMemory } from 'mnemosy-ai/local';
import { MemoryRuntime } from 'mnemosy-ai/runtime';
import { MemoryMaintenance } from 'mnemosy-ai/maintenance';

const memory = createLocalMemory({
  path: './agent-memory.sqlite', workspaceId: 'my-project', agentId: 'assistant',
});
const runtime = new MemoryRuntime(memory);
const health = new MemoryMaintenance(runtime);

const constraint = memory.store({
  text: 'The release window starts at 18:00 UTC.',
  source: { uri: 'project://release-calendar' },
  trust: 'observed', kind: 'fact',
});

const pending = health.watchMemory({
  memoryId: constraint.id, maxAgeMs: 60 * 60 * 1000, priority: 90,
});
// A new watch needs evidence. Merely storing or retrieving a fact does not confirm it.
const confirmed = health.recordCheck({
  memoryId: constraint.id, expectedStateHash: pending.stateHash,
  observation: {
    status: 'confirmed',
    evidence: 'Controller checked the current release-calendar entry.',
    verifier: 'release-calendar-controller', sourceRevision: 'calendar-r42',
  },
});
console.log(confirmed.status); // fresh
console.log(health.recall({ query: 'release window' }));
```

Use the executable [maintenance example](../examples/maintenance.ts) for a temporary database, injected clock, elapsed-time checks and reopening. The SDK accepts `now: () => Date` so tests can advance time without changing the system clock.

`lastConfirmedAt` records the latest accepted source check, distinct from when the fact was first stored or last retrieved. The policy's interval expires from that confirmation. Policies are explicit per memory revision; no guessed half-life or confidence score is used. Repeating the same watch is idempotent. Changing an existing watch policy currently requires a new target revision.

## What a check means

The controller returns one of three results, with evidence and a verifier:

- `confirmed`: evidence supports retaining the current assertion; it starts a new freshness interval.
- `changed`: the witnessed source changed; the assertion needs review or ordinary correction. This does not invent a replacement.
- `unavailable`: verification could not establish the current state; it remains unresolved.

Confirmation is a controller assertion, not authenticated truth. A matching document hash establishes only unchanged bytes, not that its claims are still true in the world. Define the meaning of `confirmed` in the host adapter. Watches never promote trust; untrusted imports are ineligible for confirmation until the host supplies eligible evidence through the ordinary lifecycle. Failed watch/check outcomes, missing evidence and changed revisions prevent those checks from authorizing freshness.

`expectedStateHash` binds a submitted check to the exact target and earlier check state. If another check or correction arrived while a probe was running, the stale result is rejected. Source corrections use the existing memory/runtime lifecycle; source forgetting removes dependent watch/check content with it.

## Run bounded checks

`health.scan()` lists watched records and their status without contacting any source. States distinguish fresh, needs-check, stale, source-changed, unavailable, ineligible, missing and clock-skew. `unwatched` means no freshness policy was supplied; it does not mean recently verified.

`health.probeDue({ probe, maxChecks, timeoutMs, signal })` calls your asynchronous probe for due records, ordered by explicit priority and due state. Defaults are ten checks and a single ten-second budget for the whole operation, including preflight. Maximums are 100 checks and 60 seconds. The report counts attempted, confirmed, changed, unavailable, failed and deferred work. Budget exhaustion never counts an unchecked fact as confirmed.

The probe receives an `AbortSignal`. Canceled work is not started, late results cannot commit, and the probe must honor cancellation to stop its own compute. Synchronous database scans cannot be interrupted mid-statement. Running another sweep later is the host's scheduling responsibility.

The `health.recall` path filters ordinary lexical candidates by the freshness of their transitive dependencies. It returns excluded record IDs/statuses without the stale text. It checks at most 100 candidates and 2,048 distinct dependencies. Unwatched evidence is allowed by default; `requireWatched: true` requires fresh watches across the entire dependency closure. Plain `memory.recall`, `memory.compile`, hybrid retrieval and existing MCP/HTTP tools do not automatically gain this new policy. A host must use the maintenance path or enforce equivalent checks where it matters.

## Recheck the evidence behind an action

A source can change between planning and execution. Bind the memory evidence used by a plan to a particular action, then validate it immediately before the host considers that action:

```js
const actionKey = 'release:catalogue:r42:arguments-sha256';
const readSet = health.createReadSet({
  memoryIds: [constraint.id],
  actionKey,
  dependenciesComplete: true,
  lifetimeMs: 10_000,
  requireWatched: true,
});

const check = health.validateReadSet(readSet, actionKey);
if (!check.valid) {
  // Fetch/review current evidence and create a new plan before retrying.
  console.log(check.reason);
}
memory.close(); // Close after the host has finished using the store.
```

The host must supply all action-relevant memory roots and derive `actionKey` from the exact operation and arguments, for example a digest of a canonical action object. `dependenciesComplete: true` is that host declaration; the library cannot discover omitted external dependencies. A static label shared by different argument sets does not bind those arguments.

Read sets include exact local record fingerprints, source-check state, outcomes and transitive lineage. Corrections, failed outcomes, expired checks, new conflicts or missing dependencies invalidate them. Unrelated memory updates do not. Tampering with the ticket, changing its action key, or validating it under another service instance fails. Up to 64 roots and 2,048 records are supported; lifetime cannot exceed 60 seconds or the next required source check.

This is a **point-in-time check of local evidence**. It neither grants permission to act nor locks an external service between validation and execution. Use the external system's own version preconditions or transaction mechanism where available. Tickets use a private per-instance signing key and deliberately expire on process/service replacement; stored watch/check records survive reopening. Within a service instance, observed backward clock movement prevents expired tickets from reviving. Clock integrity across process restarts remains a host responsibility.

## CLI

```sh
node dist/cli/index.js health --action watch \
  --db ./agent-memory.sqlite --workspace my-project --agent assistant \
  --id MEMORY_ID --json '{"maxAgeMs":3600000,"priority":90}'

node dist/cli/index.js health --action scan \
  --db ./agent-memory.sqlite --workspace my-project --agent assistant

node dist/cli/index.js health --action check \
  --db ./agent-memory.sqlite --workspace my-project --agent assistant \
  --id MEMORY_ID --json '{"expectedStateHash":"STATE_HASH","observation":{"status":"confirmed","evidence":"Checked the current source.","verifier":"controller"}}'

node dist/cli/index.js health --action recall \
  --db ./agent-memory.sqlite --workspace my-project --agent assistant \
  --query 'release window' --json '{"requireWatched":true}'
```

Use IDs and the current state hash returned by watch or scan. Every health action requires an existing regular database with no linked database or sidecar file; invalid action arguments are rejected before opening it. The host-only read-set API remains in the SDK because its key belongs to the live service instance. Capture/recall policy switches remain enforced; read-only blocks watch/check mutations.

## Research and the supplied guide

The user-supplied Instagram guide by **@datasciencebrain**, *Build an Agent That Repairs Its Own Stale Memories*, usefully distinguishes new-message updates from silent aging, and separates valid time, recorded time and last verification. Its setup commands and model choices were not adopted. The existing local engine already supports validity/knowledge-time queries and source correction.

Primary research sharpened the additional design: [STALE/CUPMem](https://arxiv.org/abs/2605.06527) studies implicit conflicts; [PlanFence](https://arxiv.org/abs/2609.03340) binds plans to exact input lineage; [budgeted verification research](https://arxiv.org/abs/2608.25553) investigates which evidence gets checked under a limited budget. These implementations and controlled experiments have their own assumptions and limits. Mnemosyne's explicit freshness service is not a reproduction of those methods, a universal contradiction detector, or a measured agent-quality improvement. Its behavioral checks and remaining evaluation gaps are recorded in [evaluation evidence](EVALUATION.md).
