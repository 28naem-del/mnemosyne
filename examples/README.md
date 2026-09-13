# Runnable examples

Pick a task, build once, and run its example from the repository root. Node **22.16.0 or newer** is required; Node 24 is recommended. If you have not cloned the project yet, follow the [tagged source quickstart](../docs/quickstart.md).

```sh
npm ci --ignore-scripts
npm run build
node --experimental-strip-types examples/agent-loop.ts
```

Substitute any filename below. `npm run demo` and `npm run demo:learning` are additional CLI walkthroughs. Run `npm run check` for the full contributor checks rather than as a prerequisite for every demonstration.

## Offline examples

These **11 examples run in CI**. They use in-memory or isolated temporary SQLite databases, synthetic sources and explicit scripted callbacks. They require no API keys, model downloads or external service. A scripted proposal/reader call is not an external model call or a measurement of AI task quality.

| Example | Demonstrates | Guide |
|---|---|---|
| [agent-loop.ts](agent-loop.ts) | Capture a turn, process bounded observations, recall context and reject an action after its source changes. | [Agent lifecycle](../docs/AGENT.md) |
| [runtime-learning.ts](runtime-learning.ts) | Capture original evidence, run a scripted job, trial a skill, then retire and erase its dependency chain. Uses the compatibility 1-task/1-verifier policy; select the recommended 2/2 policy for new applications. | [Runtime](../docs/RUNTIME.md) |
| [adaptive-context.ts](adaptive-context.ts) | Compact source-backed summaries, reuse a selection plan, expand original bytes and invalidate after forgetting. | [Context](../docs/CONTEXT.md) |
| [maintenance.ts](maintenance.ts) | Confirm source freshness, advance a test clock, persist checks and reject stale action read sets. | [Maintenance](../docs/MAINTENANCE.md) |
| [gradual-migration.ts](gradual-migration.ts) | Adopt beside a simulated old store, reconcile a changed revision, retain fallback and return to legacy mode. The old store is read-only. | [Bridge](../docs/BRIDGE.md) |
| [migration.ts](migration.ts) | Preview and apply synthetic export records, inspect source bytes and exercise migration consistency checks. | [Full migration](../docs/MIGRATION.md) |
| [backup-restore.ts](backup-restore.ts) | Back up and verify a full database, then restore its state and forgetting protections into a new path. | [Recovery](../docs/OPERATIONS.md) |
| [profiles.ts](profiles.ts) | Keep typed known, unknown and conflicting fields; refresh after correction and suppress erased evidence. | [Profiles](../docs/PROFILES.md) |
| [anthropic-memory.ts](anthropic-memory.ts) | Handle native virtual-file memory commands, edit with stable replay IDs, and verify deletion. No provider SDK or live model is invoked. | [Memory tools](../docs/ANTHROPIC-MEMORY.md) |
| [provider-memory-tools.ts](provider-memory-tools.ts) | Route explicit provider function-call envelopes, preserve call identities and return errors to the host loop. | [Provider tools](../docs/PROVIDER-TOOLS.md) |
| [agent-benchmark.ts](agent-benchmark.ts) | Exercise four memory conditions with a scripted reader and synthetic update/erasure tasks. This checks the harness, not model accuracy. | [Agent evaluation](../docs/AGENT-EVALUATION.md) |

## Optional CPU model example

[local-semantic.ts](local-semantic.ts) uses real local embedding and reranking inference over synthetic memories. First follow [local model setup](../docs/LOCAL-MODELS.md), including the pinned optional runtime, application dependency override and explicit model provisioning. With that runtime installed and the model cache already populated:

```sh
node --experimental-strip-types examples/local-semantic.ts --cache /absolute/path/to/model-cache
```

The example fails clearly when its cache is missing. Add `--download` only when deliberately provisioning the documented public model artifacts. This example is excluded from the default offline CI run and is not a public answer-quality benchmark.

## External service examples

These three examples use the separate compatibility APIs. Provide isolated development endpoints; their configuration names below are actual runtime identifiers.

| Example | Required configuration | Side effects and coverage |
|---|---|---|
| [basic-usage.ts](basic-usage.ts) | `QDRANT_URL` and full `EMBEDDING_URL`; optional provider credentials and model settings are listed in the file. | Writes to isolated `example_*` collections, recalls and forgets sample records. It leaves the collections in place and calls the selected embedding service. |
| [with-redis.ts](with-redis.ts) | `REDIS_URL` | Publishes/subscribes to one synthetic broadcast with a bounded delivery wait and disconnect. |
| [with-falkordb.ts](with-falkordb.ts) | `GRAPH_URL` | Writes sample nodes and a relation in `mnemosyne_example_graph`; these sample nodes remain. |

All 15 examples are included in strict example typechecking. Live backend conformance is not part of the default local test suite; an empty graph lookup is not proof that a live write succeeded. Use [deployment](../docs/deployment.md) for the service configuration and keep example writes separate from production data.

Pass environment variables through your shell. If you choose an environment file, add Node's `--env-file=.env` option explicitly; these examples do not load one automatically. Do not commit credentials, memory databases or backups.
