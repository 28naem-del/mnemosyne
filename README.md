# Mnemosyne

**The next agent starts wiser.**

Portable memory for agents that need to carry work forward, explain what they remember, and stop relying on something after it changes.

Mnemosyne 2 combines a local SQLite memory engine with source capture, bounded observation jobs, source-backed project models, trial-gated skills, hybrid retrieval, and correction-aware provenance. Use it through TypeScript, MCP, the CLI, or an authenticated local HTTP service with a live inspector and Python client. The existing Qdrant integration remains available separately.

**Status: 2.0.0-rc.4, source release candidate.** The commands below build this checkout. They do not assume publication to npm, PyPI, or a production website.

[Quickstart](docs/quickstart.md) · [Runtime and service guide](docs/RUNTIME.md) · [Native provider tools](docs/PROVIDER-TOOLS.md) · [API](docs/api.md) · [Migration](docs/MIGRATION-v2.md) · [Provider memory research](docs/PROVIDER-MEMORY-RESEARCH.md) · [Security boundaries](SECURITY.md)

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
- **Context with a budget and receipts.** Lexical retrieval works immediately. An explicitly configured embedder adds incremental local vectors and hybrid recall. Both paths apply scope, provenance, conflict, outcome and context-budget checks.
- **Explicit sharing.** Memories are private by default. Controllers can share selected records within a workspace. Dependencies cannot expose another agent's private source.
- **Experience tied to outcomes.** A controller records success or failure with evidence. Failed evidence prevents its recommendations from entering compiled context.
- **Captured evidence and bounded processing.** Preserve supplied transcript text and source pages. A local connector reads a named regular file, with optional foreground watching. Durable observation/model jobs use explicit call, byte, timeout, retry and lease budgets.
- **Models and reusable skills.** Project models track their relevant source set. Skill candidates become eligible only after a controller trial; source changes or failed outcomes withhold stale advice. Runtime skill execution and workspace publication remain explicit controller work.
- **Time, entities and proposals.** Query validity and knowledge time, resolve ambiguous entity aliases, traverse evidence-linked relationships, and stage isolated branch changes before an atomic merge.
- **Bounded reflection.** A caller-selected model can propose lessons in one budgeted pass. Proposals do not write memory. A controller must validate a proposal before committing it; changed or failed evidence rejects stale proposals.
- **A usable lifecycle.** Inspect, correct, export, restore, and forget through an SDK and CLI. MCP tools and bearer-token HTTP expose narrower authority. A live browser inspector and dependency-free Python client use the HTTP service.

The local path needs no external service for lexical memory. Semantic indexing and generated observations require a caller-selected provider or callback; no model is chosen or downloaded automatically. Local vectors, entities, runtime artifacts and ordinary memories use the same SQLite store. Cloud synchronization, model training, unattended host-history discovery and a managed hosted service are not included. The Qdrant and local engines do not automatically synchronize.

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

Research motivates the design; it does not establish superiority. [The research review](docs/RESEARCH-2026-09-12.md) covers primary papers, competing implementations, GitHub reports, Hacker News, Reddit, and accessible X posts. [Evaluation](docs/EVALUATION.md) separates deterministic lifecycle checks, synthetic scale measurements, and still-needed agent experiments.

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
