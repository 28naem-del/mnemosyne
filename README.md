# Mnemosyne

**The next agent starts wiser.**

Portable memory for agents that need to carry work forward, explain what they remember, and stop relying on something after it changes.

Mnemosyne 2 combines a local SQLite memory engine with a host-controlled agent lifecycle, adaptive context, source capture, bounded observation jobs, source-backed project models, trial-gated skills, hybrid retrieval, and correction-aware provenance. Use it through TypeScript, MCP, the CLI, or an authenticated local HTTP service with a live inspector and Python client. The existing Qdrant integration remains available separately.

**Status: 2.0.0-rc.8, source release candidate.** The commands below build this checkout. They do not assume publication to npm, PyPI, or a production website.

[Quickstart](docs/quickstart.md) · [Agent lifecycle](docs/AGENT.md) · [Adaptive context](docs/CONTEXT.md) · [Typed profiles](docs/PROFILES.md) · [Runtime](docs/RUNTIME.md) · [Gradual migration](docs/BRIDGE.md) · [Full migration](docs/MIGRATION.md) · [Backup and restore](docs/OPERATIONS.md) · [Agent evaluation](docs/AGENT-EVALUATION.md) · [Security boundaries](SECURITY.md)

## See it work

Node.js **22.16 or newer** is required. Node 24 is recommended. SQLite is built into Node; the local engine needs no API key, database service, or Docker.

```sh
git clone --branch codex/mnemosyne-2-local-learning https://github.com/28naem-del/mnemosyne.git
cd mnemosyne
npm ci
npm run check
npm run demo
npm run demo:learning
```

The demo runs actual code against an isolated temporary database. One agent records a brief, procedure, and checkpoint. A second agent resumes the work. A correction invalidates the earlier procedure. Private memory remains private, and deletion removes its live content. Every step includes inspectable records and assertions. It is a memory-engine demonstration, without LLM inference.

The learning demo exercises 13 checks: source capture, one scripted observation job, candidate suppression, two executed controller trial cases, skill promotion, explicit workspace sharing, a second agent's recall, correction-driven retirement, original-source inspection, and forgetting with replay protection after restart. Its proposer and tasks are hand-authored fixtures. It makes no external model calls and does not measure LLM task improvement. [Runnable runtime example](examples/runtime-learning.ts).

## Give an agent persistent memory

```js
import { createLocalMemory } from 'mnemosy-ai/local';

const memory = createLocalMemory({
  path: './agent-memory.sqlite',
  workspaceId: 'catalogue',
  agentId: 'designer',
});

const brief = memory.store({
  text: 'Product images must be 1200 by 900 pixels.',
  kind: 'fact',
  key: 'catalogue.image-size',
  source: { uri: 'brief://catalogue/v1' },
  trust: 'observed',
  visibility: 'workspace',
});

const procedure = memory.store({
  text: 'Export catalogue product images at 1200 by 900 pixels.',
  kind: 'procedure',
  source: { uri: 'run://designer/export' },
  trust: 'observed',
  dependencies: [brief.id],
  visibility: 'workspace',
});

memory.correct(brief.id, {
  text: 'Product images must be 1600 by 1200 pixels.',
  source: { uri: 'brief://catalogue/v2' },
  reason: 'The owner updated the delivery specification.',
});

console.log(memory.get(procedure.id)?.status); // invalidated
const context = memory.compile({ query: 'catalogue product images', maxTokens: 2048 });
// Pass context.text to the model. Inspect context.citations / uncertainty separately.
console.log(context.text);
memory.close();
```

These package imports work from an installed build or this repository's package scope after building. [Quickstart](docs/quickstart.md) includes direct CLI commands and MCP configuration.

## What this release builds

- **Memory with a history.** Source references, trust labels, explicit fact keys, corrections, and dependency chains. Correct a source and dependent lessons become ineligible.
- **A handoff that preserves the work.** Structured goals, decisions, rejected approaches, artifacts, and next actions survive process restarts. Link their dependencies so obsolete handoffs retire with corrected sources. Conflicting shared checkpoints cause abstention.
- **Adaptive context with original evidence.** Select current observations, hierarchical summaries and original excerpts within a declared budget. Expand exact source bytes on demand. Reuse local selection plans only while complete source, check and outcome state matches; an injectable tokenizer replaces the labeled byte estimate. Building context makes no model call.
- **An agent lifecycle you control.** `MemoryAgent` prepares fresh context, captures supplied visible turns, queues durable work and checks action evidence before host dispatch. Use one bounded drain or an explicitly started finite worker. Supplied Codex/Claude event adapters do not install hooks or discover history.
- **Typed profiles with source evidence.** Define bounded fields as known, unknown or conflict. An explicit proposer supplies values and per-field citations; reads revalidate complete source state and withhold stale values. Schema validation and attribution do not certify truth. [Profile guide](docs/PROFILES.md).
- **Explicit sharing.** Memories are private by default. Controllers can share selected records within a workspace. Dependencies cannot expose another agent's private source.
- **Experience tied to outcomes.** A controller records success or failure with evidence. Failed evidence prevents its recommendations from entering compiled context.
- **Captured evidence and bounded processing.** Preserve supplied transcript text and source pages. A local connector reads a named regular file, with optional foreground watching. Durable observation/model jobs use explicit call, byte, timeout, retry and lease budgets.
- **Models and reusable skills.** Project models track their relevant source set. Skill candidates become eligible only after a controller trial; source changes or failed outcomes withhold stale advice. Runtime skill execution and workspace publication remain explicit controller work.
- **Time, entities and proposals.** Query validity and knowledge time, resolve ambiguous entity aliases, traverse evidence-linked relationships, and stage isolated branch changes before an atomic merge.
- **Bounded reflection.** A caller-selected model can propose lessons in one budgeted pass. Proposals do not write memory. A controller must validate a proposal before committing it; changed or failed evidence rejects stale proposals.
- **A usable lifecycle.** Inspect, correct, export, restore, and forget through an SDK and CLI. MCP tools and bearer-token HTTP expose narrower authority. A live browser inspector and dependency-free Python client use the HTTP service.
- **Bring existing memories.** Preview 11 explicit export profiles covering Mem0, Letta, LangGraph, Graphiti, Hindsight, Supermemory, legacy Mnemosyne/Qdrant and Markdown, then apply the reviewed source bytes atomically. Preserve original records, recognize retries and undo untouched imports. Forgetting also blocks replay of the same source identity.
- **Check silent staleness.** Explicit source policies track the last confirmation independently of creation or retrieval. Freshness-aware recall withholds stale dependencies, and short-lived action read sets detect changed evidence before the host acts. Controllers supply check evidence; age does not rewrite facts.

The local path needs no external service for lexical memory. Semantic indexing and generated observations require a caller-selected provider or callback; no model is chosen or downloaded automatically. Local vectors, entities, runtime artifacts and ordinary memories use the same SQLite store. Cloud synchronization, model training, unattended host-history discovery and a managed hosted service are not included. The Qdrant and local engines do not automatically synchronize.

## Connect the host loop

Use [`MemoryAgent`](docs/AGENT.md) around your existing responder. `runTurn` prepares context and records visible input/output; `beforeTurn` and `afterTurn` support separate host stages. Your controller explicitly selects the provider, trust assertions and any background work. Default capture is untrusted. Construction starts no model or worker.

The CLI also supports finite observation work against a chosen provider:

```sh
node dist/cli/index.js agent --action work --watch \
  --db ./agent-memory.sqlite --workspace my-project --agent assistant \
  --provider-config ./provider.json \
  --json '{"maxCycles":10,"maxDurationMs":60000,"maxCalls":4,"maxTotalInputBytes":262144}'
```

This process runs until a limit, cancellation or completion; it installs no daemon. Durable jobs and leases remain in SQLite for a later explicitly started worker. See the [agent guide](docs/AGENT.md) for provider configuration, event adapters, retry boundaries and controller action checks.

[`AdaptiveContext`](docs/CONTEXT.md) can incrementally compact selected history with your proposer, then build context locally and expand exact originals through scoped handles. New generated records track the complete source/check/outcome state used to create them. Changes invalidate their reuse; legacy summaries without that proof fall back to eligible original sources. Validate a retained packet immediately before dispatch. The default token count is a conservative UTF-8 byte estimate, not a model tokenizer.

## Bring your existing memories

```sh
node dist/cli/index.js migrate \
  --file ./mem0-export.json --profile mem0-array \
  --source-store personal-mem0 --source-owner alice \
  --workspace my-project --agent assistant \
  --acknowledge-partial --out ./reviewed-plan.json

node dist/cli/index.js migrate --action apply \
  --file ./reviewed-plan.json --db ./agent-memory.sqlite \
  --batch first-import --confirm
```

The preview opens no destination database. Imports are private and untrusted by default; accepted source assertions can be planned with explicit `--trust observed`. The [migration guide](docs/MIGRATION.md) lists all 11 supported export profiles, page/owner declarations, exact-byte accounting, limits, inspection, undo and forgetting. There is no account discovery. For an opt-in transition while the existing store stays active, use [gradual migration](docs/BRIDGE.md).

### Move gradually while your agent keeps working

`mnemosy-ai/bridge` wraps an explicitly supplied, read-only legacy search adapter. Used memories are copied with stable origins and revisions. Paired recall checks increase Mnemosyne preference from shadow to assist to preferred; missing legacy matches remain available. The bridge keeps querying the original store for reconciliation, never deletes it, and can return to legacy routing immediately. Progress describes observed workload coverage, not completion of the entire store. Full export migration remains available separately.

See the [bridge contract and host integration](docs/BRIDGE.md), then run `node --experimental-strip-types examples/gradual-migration.ts` after building.

Run the new synthetic examples after building to see migration and silent-staleness checks on temporary stores:

```sh
node --experimental-strip-types examples/migration.ts
node --experimental-strip-types examples/maintenance.ts
```

The [freshness guide](docs/MAINTENANCE.md) explains source checks, bounded probes and action read sets. Freshness filtering is an explicit SDK/CLI path; existing generic recall does not silently acquire a new policy. Neither example calls a model or accesses live sources.

## Verify a backup before recovery

Operator backups preserve the whole SQLite database, including every workspace, private record, durable job and replay guard. They are distinct from scoped logical exports. In a fresh working directory with an existing `agent-memory.sqlite`:

```sh
mkdir -m 700 backups recovery
node dist/cli/index.js operations --action backup \
  --db ./agent-memory.sqlite --out ./backups/snapshot.mnemo-backup
node dist/cli/index.js operations --action verify \
  --file ./backups/snapshot.mnemo-backup
node dist/cli/index.js operations --action restore \
  --file ./backups/snapshot.mnemo-backup --out ./recovery/memory.sqlite
```

Outputs must be new paths in existing private directories. Verification checks bundle hashes and SQLite integrity; it is not a signature or encryption. Restore leaves the original database in place and performs no service cutover. Protect backups separately: forgetting live data cannot erase an older backup. [Operator guide and tested limits](docs/OPERATIONS.md).

## Open the live inspector

From a built checkout, create an access token in a new private file and launch the loopback service:

```sh
node --input-type=module -e 'import { randomBytes } from "node:crypto"; import { writeFileSync } from "node:fs"; writeFileSync("./memory-token.txt", randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });'
node dist/cli/index.js serve --db ./agent-memory.sqlite \
  --workspace catalogue --agent designer --token-file ./memory-token.txt --port 8765
```

Open the printed URL and enter the token from that file. The inspector reads your live scoped database, pages through evidence, searches, and offers permitted corrections. Forget is available only with `--allow-destructive`; use `--read-only` for inspection without writes. The token stays in page memory and is cleared on disconnect. Keep the token file outside version control. See [HTTP and Python](docs/RUNTIME.md#http-inspector-and-python) for API calls and client setup.

## Connect through MCP

Build once, then use this as your MCP client's server entry, replacing the three absolute paths/identity values:

```json
{
  "command": "node",
  "args": [
    "/absolute/path/mnemosyne/dist/cli/index.js", "mcp",
    "--db", "/absolute/path/data/memory.sqlite",
    "--workspace", "my-project", "--agent", "my-agent"
  ]
}
```

The parent directory for the database must exist. Launch with `--read-only` to omit mutation tools. Forgetting is omitted unless the controller launches with `--allow-destructive`. Models cannot select workspace/agent identities, mark their own evidence verified, import snapshots, or report successful outcomes through MCP.

Runtime tools also expose supplied transcript capture, source expansion, observation-job enqueueing, model/skill inspection, entity resolution and branch previews. The host runs workers, selects providers and records skill trials. `--provider-config FILE` enables configured hybrid retrieval after indexing; separate `--no-capture` and `--no-recall` runtime policies are available. [Runtime guide](docs/RUNTIME.md).

## Keep the promise measurable

The [native provider tools](docs/PROVIDER-TOOLS.md) expose six virtual file commands to OpenAI Responses and Gemini Generate Content; [Claude native memory](docs/ANTHROPIC-MEMORY.md) uses the same engine. A fresh generic namespace shares notes across those interfaces with source revisions, correction and forgetting. No mandatory provider package or physical memory directory is required.

Research motivates the design; it does not establish superiority. [The research review](docs/RESEARCH-2026-09-12.md) covers primary papers, competing implementations, GitHub reports, Hacker News, Reddit, and accessible X posts. [Evaluation](docs/EVALUATION.md) separates deterministic lifecycle checks and synthetic scale measurements. The new [matched agent harness](docs/AGENT-EVALUATION.md) compares no memory, recent history, lexical memory and adaptive context using the same explicit reader/model revision and budgets. It reports answer/action correctness, provenance, stale actions and positive/negative transfer. Scripted fixtures verify the harness; no live-model or competitor-quality advantage has been established.

[The provider comparison](docs/PROVIDER-MEMORY-RESEARCH.md) distinguishes documented OpenAI, Anthropic and Google behavior from implementation details those providers have not published. Similar product features do not establish equivalent reliability.

A memory system can improve continuity and make previous experience available to an agent. This release does not establish AGI, universal reasoning improvement, or a public-benchmark lead.

## Existing Qdrant users

`createMnemosyne` and the existing subpath exports remain. Version 2 introduces deliberate safety changes: explicit-ID erasure, awaited keyword-index startup with coverage diagnostics, scoped maintenance, and disabled unsafe legacy mutation helpers. Read [migration notes](docs/MIGRATION-v2.md) before upgrading. No existing database is migrated or deleted automatically.

## Develop and contribute

```sh
npm run check          # typecheck, build, and all tests
PYTHONPATH=python python3 -m unittest discover -s python/tests -v
npm run demo:learning
npm run benchmark -- --count 10000 --queries 100
npm pack --dry-run
```

Use an isolated database for experiments. See [contribution guidance](CONTRIBUTING.md), [architecture](ARCHITECTURE.md), and [deployment](docs/deployment.md). MIT licensed. [NOTICE](NOTICE.md) identifies research lineage and dependencies.
