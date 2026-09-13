# Build with Mnemosyne

Start with the [keyless local quickstart](quickstart.md), then choose the integration that fits your application. The [15 examples](../examples/README.md) distinguish offline fixtures, optional local models and external services. The current source release is **2.0.0-rc.8**; the [GitHub prerelease](https://github.com/28naem-del/mnemosyne/releases/tag/v2.0.0-rc.8) includes checksummed JavaScript and Python assets. Package registry versions are a separate publication channel.

## Choose a task

| I want to… | Start here | What I will build |
|---|---|---|
| Give an existing agent persistent memory | [Agent lifecycle](AGENT.md) | Context before a turn, capture afterward and evidence checks before actions. |
| Connect an MCP client or inspect memory in a browser | [Deployment](deployment.md) · [HTTP and Python](RUNTIME.md#http-inspector-and-python) | A scoped local service with explicit capabilities. |
| Keep my old memory system while adopting Mnemosyne | [Gradual migration](BRIDGE.md) | A read-only legacy adapter with shadow, assist and prefer phases. |
| Move an exported memory collection | [Full migration](MIGRATION.md) · [Existing installations](MIGRATION-v2.md) | Preview, source inspection, atomic apply, replay protection and guarded undo. |
| Retrieve by meaning as well as words | [Local CPU models](LOCAL-MODELS.md) · [Hybrid retrieval](RUNTIME.md#hybrid-retrieval) | Explicit embeddings, independent lexical/dense candidates and optional reranking. |
| Fit evidence into a limited context | [Adaptive context](CONTEXT.md) | Source-backed summaries, budget accounting and expansion to original bytes. |
| Detect stale sources before using advice | [Maintenance](MAINTENANCE.md) | Source policies, confirmations, bounded checks and action read sets. |
| Reuse a procedure after controller trials | [Skill trials](RUNTIME.md#project-models-skill-trials-and-traces) | Persisted promotion requirements and retirement when evidence changes. |
| Build typed preference or project profiles | [Profiles](PROFILES.md) | Explicit known, unknown and conflicting fields with source attribution. |
| Use native memory tool envelopes | [Provider tools](PROVIDER-TOOLS.md) · [Virtual memory files](ANTHROPIC-MEMORY.md) | Local command handlers connected to a host-owned model loop. |
| Recover the whole database | [Backup and restore](OPERATIONS.md) | A consistent verified snapshot restored to a new path. |
| Assess the evidence behind a claim | [Evaluation](EVALUATION.md) · [Measurements](evaluation/BENCHMARKS.md) | Reproducible retrieval reports and separate lifecycle diagnostics. |

## Integration coverage

“Available” describes the implemented interface. The checks below do not certify every version of an external client or framework.

| Surface | Available contract | Verification and boundary |
|---|---|---|
| TypeScript and JavaScript | Embedded local store, runtime and agent lifecycle | Strict typechecks, synthetic SQLite integration tests, installed-package import checks and runnable offline examples. |
| MCP | Stdio tools with host-fixed scope and capability flags | Protocol integration and advertised-tool tests; each client still needs its own setup and acceptance test. |
| HTTP and Python | Bearer-authenticated local service and standard-library Python client | Service and client fixture tests; remote TLS, organizational identity and production hosting remain deployment work. |
| Provider memory tools | Native memory commands and explicit function-call envelopes | Synthetic request/result, replay, policy and error cases; no universal live-provider or framework certification. |
| Migration | Eleven export profiles plus a host-supplied legacy search adapter | Offline format, completeness, scope, replay, correction and erasure fixtures. Export support is not automatic account access. |
| Optional local models | Pinned CPU embedding and reranking integration | Separate cached CPU smoke checks; model artifacts are not installed or downloaded by the default quickstart or CI examples. |
| Existing service-backed API | `createMnemosyne` and optional graph/broadcast modules | Typed examples and mocked contracts; live backend conformance requires your own isolated services. |

## Understand the system

Read the [architecture](../ARCHITECTURE.md) for storage, ranking and trust boundaries; the [feature map](features.md) for supported behavior and limits; and the [capability comparison](comparison.md) to choose a deployment path. The [local API](api.md) and [configuration reference](configuration.md) provide lower-level details.

Memory scopes and evidence labels are host assertions, not proof of authenticity. Databases and backup bundles are plaintext. Automatic cloud synchronization, universal framework hooks and public generated-answer quality results are outside this release. For matched task experiments use the [agent evaluation guide](AGENT-EVALUATION.md); retrieval coverage alone cannot show how well an agent answers.

## Contribute or report a problem

See [contributing](../CONTRIBUTING.md) for checks and review expectations, [security](../SECURITY.md) for private vulnerability reporting, and the [code of conduct](../CODE_OF_CONDUCT.md) for participation. Report a reproducible problem through [GitHub issues](https://github.com/28naem-del/mnemosyne/issues). Keep private memories, credentials and production logs out of public reports.
