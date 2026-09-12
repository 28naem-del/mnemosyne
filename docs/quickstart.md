# Quickstart

Requires Node >=22.16; Node 24 is recommended. Build this release candidate from source as shown in [README](../README.md). The default published npm version may differ.

## Run the real demonstration

```sh
npm ci
npm run check
npm run demo
node dist/cli/index.js demo --record demo-evidence.json
```

Recording creates a new file and refuses to overwrite an existing one. The demo uses temporary synthetic records, cleans its database, and makes no model calls.

## Use a local database

```sh
mkdir -p data
node dist/cli/index.js store --db ./data/memory.sqlite --workspace demo --agent alice --text 'The catalogue requires owner approval.' --source 'brief://catalogue' --share
node dist/cli/index.js context --db ./data/memory.sqlite --workspace demo --agent bob --query 'catalogue approval' --tokens 2048
node dist/cli/index.js inspect --db ./data/memory.sqlite --workspace demo --agent alice --history
```

Omit `--share` to keep a record private. Each command requires an explicit database, workspace, and agent. SDK writes default to `untrusted`; CLI and MCP writes default to `observed`. Neither label proves the content is true.

Use the returned memory ID with `correct --id ID --text TEXT --source URI --reason TEXT`. Use `forget --id ID --confirm` for deliberate live-content erasure. Neither operation asks a model to guess which memory to change.

## MCP stdio

```sh
node dist/cli/index.js mcp --db ./data/memory.sqlite --workspace demo --agent alice
```

This waits for an MCP client on standard input; it does not launch a web server. Put the command and arguments in the server configuration format your client supports. Use absolute file paths when the client's working directory differs. Server diagnostics go to stderr; stdout is reserved for protocol messages.

Tools include recall, context, inspection, task resume, store, checkpoint, and correction. Read-only mode removes writes; explicit `--allow-destructive` enables forgetting. Validation/outcome recording and reflection commitment remain controller SDK operations.

## Export and restore

```sh
node dist/cli/index.js export --db ./data/memory.sqlite --workspace demo --agent alice --out alice-snapshot.json
node dist/cli/index.js import --db ./data/restored.sqlite --workspace demo --agent alice --file alice-snapshot.json
```

Snapshots preserve owner scope and retry identity. Export omits owned records whose dependencies include another agent; inspect the snapshot's `omitted` count. Import does not remap scope and rejects conflicting IDs or inconsistent content atomically. Files must be at most 32 MiB; each collection of memories, outcomes, or idempotency entries has a 100,000-entry cap.

Keep snapshots private. A snapshot is an additional copy; forgetting from the live database does not edit old exports.
