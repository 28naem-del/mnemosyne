# Mnemosyne

**The next agent starts wiser.**

Portable memory for agents that need to carry work forward, explain what they remember, and stop relying on something after it changes.

Mnemosyne 2 adds a local SQLite engine, MCP server, CLI, correction-aware provenance, task handoffs, and a bounded reflection API. The existing Qdrant integration remains available with retrieval, isolation, and deletion fixes.

**Status: 2.0.0-rc.1, source release candidate.** The commands below build this checkout. They do not assume the release candidate has been published to npm.

[Quickstart](docs/quickstart.md) · [API](docs/api.md) · [Migration](docs/MIGRATION-v2.md) · [Research](docs/RESEARCH-2026-09-12.md) · [Security boundaries](SECURITY.md)

## See it work

Node.js **22.16 or newer** is required. Node 24 is recommended. SQLite is built into Node; the local engine needs no API key, database service, or Docker.

```sh
git clone --branch codex/mnemosyne-2-local-learning https://github.com/28naem-del/mnemosyne.git
cd mnemosyne
npm ci
npm run check
npm run demo
```

The demo runs actual code against an isolated temporary database. One agent records a brief, procedure, and checkpoint. A second agent resumes the work. A correction invalidates the earlier procedure. Private memory remains private, and deletion removes its live content. Every step includes inspectable records and assertions. It is a memory-engine demonstration, without LLM inference.

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

console.log(memory.get(procedure.id).status); // invalidated
const context = memory.compile({ query: 'catalogue product images', maxTokens: 2048 });
// Pass context.text to the model. Inspect context.citations / uncertainty separately.
console.log(context.text);
memory.close();
```

These package imports work from an installed build or this repository's package scope after building. [Quickstart](docs/quickstart.md) includes direct CLI commands and MCP configuration.

## What this release builds

- **Memory with a history.** Source references, trust labels, explicit fact keys, corrections, and dependency chains. Correct a source and dependent lessons become ineligible.
- **A handoff that preserves the work.** Structured goals, decisions, rejected approaches, artifacts, and next actions survive process restarts. Link their dependencies so obsolete handoffs retire with corrected sources. Conflicting shared checkpoints cause abstention.
- **Context with a budget and receipts.** Lexical retrieval compiles cited context inside a specified budget. Conflicting keyed facts stay together; recommendations with conflicted or failed evidence are withheld.
- **Explicit sharing.** Memories are private by default. Controllers can share selected records within a workspace. Dependencies cannot expose another agent's private source.
- **Experience tied to outcomes.** A controller records success or failure with evidence. Failed evidence prevents its recommendations from entering compiled context.
- **Bounded reflection.** A caller-selected model can propose lessons in one budgeted pass. Proposals do not write memory. A controller must validate a proposal before committing it; changed or failed evidence rejects stale proposals.
- **A usable lifecycle.** Inspect, correct, export, restore, and forget through an SDK and CLI. An actual MCP stdio server exposes a narrower set of agent tools.

The local path uses SQLite FTS and lexical scoring. It does not provide semantic embeddings, cloud synchronization, model training, or a hosted service. The Qdrant path supports vector/hybrid retrieval separately. These engines do not automatically synchronize.

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

## Keep the promise measurable

Research motivates the design; it does not establish superiority. [The research review](docs/RESEARCH-2026-09-12.md) covers primary papers, competing implementations, GitHub reports, Hacker News, Reddit, and accessible X posts. [Evaluation](docs/EVALUATION.md) separates deterministic lifecycle checks, synthetic scale measurements, and still-needed agent experiments.

A memory system can improve continuity and make previous experience available to an agent. This release does not establish AGI, universal reasoning improvement, or a public-benchmark lead.

## Existing Qdrant users

`createMnemosyne` and the existing subpath exports remain. Version 2 introduces deliberate safety changes: explicit-ID erasure, awaited keyword-index startup with coverage diagnostics, scoped maintenance, and disabled unsafe legacy mutation helpers. Read [migration notes](docs/MIGRATION-v2.md) before upgrading. No existing database is migrated or deleted automatically.

## Develop and contribute

```sh
npm run check          # typecheck, build, and all tests
npm run benchmark -- --count 10000 --queries 100
npm pack --dry-run
```

Use an isolated database for experiments. See [contribution guidance](CONTRIBUTING.md), [architecture](ARCHITECTURE.md), and [deployment](docs/deployment.md). MIT licensed. [NOTICE](NOTICE.md) identifies research lineage and dependencies.
