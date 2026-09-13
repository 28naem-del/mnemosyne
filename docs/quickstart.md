# Start with a working memory lifecycle

Run Mnemosyne locally, see a correction retire old advice, then connect your agent. The default local engine needs no model API key, database server or container. Use **Node 22.16.0 or newer**; Node 24 is recommended.

## Choose your engine

Version **2.0.0-rc.9 includes both engines**:

- **Vector Engine:** use `createMnemosyne` from `mnemosy-ai` with configured external services. Start with the [existing backend example](../examples/basic-usage.ts) and review the [version 2 migration notes](MIGRATION-v2.md).
- **Local Engine:** use `createLocalMemory` from `mnemosy-ai/local` for a SQLite store. The demonstrations below and the [local API](api.md) use this engine. The [MemoryAgent adapter](AGENT.md) runs on its local runtime.

They use separate schemas; installing version 2 does not migrate or synchronize an existing store. The optional [gradual migration bridge](BRIDGE.md) can read your previous system while keeping it unchanged. Release channels are a separate choice: `latest` stays on stable version 1.x; `next` provides the version 2 candidate with both engines.

## Install the release candidate

In your Node.js project:

```sh
npm install mnemosy-ai@2.0.0-rc.9
npx --no-install mnemosy demo
npx --no-install mnemosy learning-demo
```

Use the exact version above or `mnemosy-ai@next` for the prerelease channel. Unqualified installation follows `latest`, which remains on the stable 1.x line. The commands below use a source checkout; with an npm installation, replace `node dist/cli/index.js` with `npx --no-install mnemosy`. SDK imports such as `mnemosy-ai/local` work from the installed package.

## Build the tagged source release

```sh
git clone --branch v2.0.0-rc.9 --depth 1 https://github.com/28naem-del/mnemosyne.git
cd mnemosyne
npm ci --ignore-scripts
npm run build
npm run demo
npm run demo:learning
```

These commands build **2.0.0-rc.9**. It refreshes packaging and release guidance over the RC8 engine. The older [RC8 GitHub prerelease](https://github.com/28naem-del/mnemosyne/releases/tag/v2.0.0-rc.8) and its checksummed downloads remain unchanged. Python is a separate publication channel; install the bundled client with `python -m pip install ./python` from the checkout.

The first demo exercises handoff, scoped sharing, correction propagation and forgetting. The learning demo adds original evidence, a scripted observation job, a controller skill trial and retirement after correction. Both use synthetic temporary databases, clean up their own data, and make no external model calls. Passing these fixtures establishes the demonstrated behavior, not general agent intelligence.

To keep a receipt, choose a new output filename:

```sh
node dist/cli/index.js demo --record demo-evidence.json
```

Recording refuses to overwrite an existing file. Contributor validation is a separate step: run `npm run check` for typechecking, tests and example typechecking. See [contributing](../CONTRIBUTING.md) for the current documentation and release checks.

## Store and recall shared evidence

From the built repository:

```sh
mkdir -p data
node dist/cli/index.js store --db ./data/memory.sqlite --workspace demo --agent alice --text 'The catalogue requires owner approval.' --source 'brief://catalogue' --share
node dist/cli/index.js context --db ./data/memory.sqlite --workspace demo --agent bob --query 'catalogue approval' --tokens 2048
node dist/cli/index.js inspect --db ./data/memory.sqlite --workspace demo --agent alice --history
```

Alice explicitly shares this source with the workspace, so Bob can receive it. Omit `--share` to keep a record private. Every command fixes the database, workspace and agent; these selectors come from your host application. SDK writes default to `untrusted`; CLI and MCP writes default to `observed`. Neither label certifies that a claim is true.

Use the returned memory ID with `correct --id ID --text TEXT --source URI --reason TEXT`. Use `forget --id ID --confirm` for deliberate live-content erasure. Declare dependencies when storing derived advice so corrections can retire it. The [local API](api.md) explains those contracts.

## Connect through MCP or your agent loop

```sh
node dist/cli/index.js mcp --db ./data/memory.sqlite --workspace demo --agent alice
```

This process waits for an MCP client on standard input. Add the command and arguments to your client's server configuration; use absolute paths when its working directory differs. Diagnostics use stderr and stdout is reserved for protocol messages. `--read-only` removes write tools; forgetting requires `--allow-destructive`.

For an application you control, use the [agent lifecycle adapter](AGENT.md). It supplies context before a turn, captures visible results and rechecks declared evidence before an action. An existing memory backend can stay connected through the [gradual migration bridge](BRIDGE.md). Client configuration, model calls and action authorization belong to your host.

## Inspect and capture

The [runtime guide](RUNTIME.md#http-inspector-and-python) has a complete authenticated HTTP inspector setup and Python client example. The same service can expose selected read, capture and destructive capabilities to configured principals.

To ingest a local file, use `capture` with an explicit path and scope; the [file capture example](RUNTIME.md#read-one-explicit-local-file) includes all flags. An optional foreground watcher follows that file only. Source capture does not scan application histories or install a background service.

## Choose your next step

- [Examples](../examples/README.md): 15 runnable paths, with external dependencies clearly marked.
- [Full migration](MIGRATION.md): preview exported records before applying a plan.
- [Recovery](OPERATIONS.md): verify a complete database backup and restore to a new path.
- [Local semantic retrieval](LOCAL-MODELS.md): explicitly provision CPU embeddings and reranking.
- [Documentation index](README.md): choose a guide by the task you want to complete.

Keep memory databases, token files and backups outside Git. They contain plaintext data; forgetting from the live store cannot erase a prior backup or a prompt already sent to a model.
