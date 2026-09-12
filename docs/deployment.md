# Deploying Mnemosyne 2

Mnemosyne 2 has two storage paths. The local engine and its MCP server use a SQLite file and lexical retrieval. The existing `createMnemosyne()` API uses Qdrant and an embedding endpoint. The local MCP server does not connect to Qdrant, Redis, FalkorDB, MongoDB, or a model provider.

This guide describes the source build in this repository. A release candidate in source does not imply that its version is available on npm.

## Build and run locally

Use Node.js **22.16.0 or newer**; CI checks the minimum version and Node 24. Node's built-in SQLite may emit an experimental warning on stderr on some versions.

```bash
npm ci --ignore-scripts
npm run check
node dist/cli/index.js demo
```

The demo uses an isolated temporary database and checks handoffs, privacy, correction propagation, evidence, and forgetting. It does not call an LLM or measure agent intelligence.

Start an MCP server with an explicit persistent path and identity:

```bash
node dist/cli/index.js mcp \
  --db /absolute/path/to/memory.sqlite \
  --workspace my-project \
  --agent coding-agent
```

An MCP client launches this command and communicates over stdin/stdout. There is no HTTP port, health endpoint, or background service to install. Use an absolute path to a supported Node executable if the client has a different `PATH` from your terminal.

Example client configuration; replace both absolute paths:

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/mnemosyne/dist/cli/index.js",
        "mcp",
        "--db", "/absolute/path/to/memory.sqlite",
        "--workspace", "my-project",
        "--agent", "coding-agent"
      ]
    }
  }
}
```

Add `--read-only` to expose retrieval and inspection tools without write tools. Forgetting is not exposed unless the controller adds `--allow-destructive`. These flags control tool availability, not filesystem permissions; the SQLite directory must still be writable.

## Scope and persistence

Use the same database path and workspace ID for agents that should share explicitly shared memories. Give each agent its own stable agent ID. Memories default to private; sharing is an explicit choice. The launching application chooses these identities, and should not take them from untrusted model arguments.

Workspace and agent IDs are selectors enforced by the memory API, **not authentication or encryption**. Anyone able to open the underlying file directly has access to its contents. Use separate operating-system accounts or files for mutually untrusted applications, and host-managed encrypted storage when required.

Keep the SQLite file on a local persistent filesystem. Its containing directory must also permit the process to create SQLite `-wal` and `-shm` files. The engine uses transactions, WAL, and a bounded busy timeout; concurrent writes can still require application-level handling of an exhausted timeout. Network filesystems and multi-host SQLite access are not a supported deployment model.

## Container

Build a local image first:

```bash
docker build --target production -t mnemosyne:local .
```

The image runs Node 24 as the unprivileged `node` user. `/data` is the writable memory directory. The application code and dependencies remain owned by root. No port is exposed.

```bash
docker run --rm -i --network none \
  --mount type=volume,src=mnemosyne-local,dst=/data \
  mnemosyne:local mcp \
  --db /data/memory.sqlite \
  --workspace my-project \
  --agent coding-agent
```

Use `-i` without `-t`: a terminal must not alter the MCP protocol stream. A named volume survives removal of the container. A host bind mount must be writable by the container's `node` user (UID 1000); do not make private memory directories world-writable to solve a permission error.

The image entrypoint is the CLI. Arguments after the image name replace its default `mcp` arguments, so include the command and all scope flags when overriding defaults.

The included Compose file offers the same local MCP service:

```bash
docker compose build mnemosyne
MNEMOSYNE_WORKSPACE=my-project MNEMOSYNE_AGENT=coding-agent \
  docker compose run --rm -T --no-deps mnemosyne
```

`MNEMOSYNE_WORKSPACE` and `MNEMOSYNE_AGENT` are **Compose interpolation variables** for command-line flags. They are not automatically read by the library or CLI. Run the Compose command from an MCP client that owns its standard streams; `docker compose up -d` does not establish an MCP client connection. The service has no network access and no automatic restart loop when stdin closes.

## Existing Qdrant applications

Existing Qdrant collections are not imported, renamed, or deleted by the local engine. Keep using `createMnemosyne()` for the vector-backed API and select collection names explicitly when needed. Do not repoint a production application to a new database merely to try the local demo.

The Compose services `qdrant`, `redis`, `falkordb`, and `mongo` are under the optional `legacy` profile. Their existing named-volume keys remain `qdrant-data`, `redis-data`, `falkordb-data`, and `mongo-data`. Docker Compose prefixes volume names with its project name, so retain your existing project name and volume mapping when maintaining an existing installation. Never use `docker compose down --volumes` on memory data you intend to keep.

For a new isolated development deployment, starting only Qdrant is enough for the database side of the vector API:

```bash
docker compose --profile legacy up -d qdrant
```

An embedding endpoint is also required. Optional Redis and FalkorDB services must be configured by the application; starting their containers does not activate library features. The MongoDB service is retained for existing companion applications and is not used by the local MCP server or automatically connected by `createMnemosyne()`.

Example application configuration:

```typescript
import { createMnemosyne } from 'mnemosy-ai';

const memory = await createMnemosyne({
  vectorDbUrl: 'http://127.0.0.1:6333',
  embeddingUrl: 'http://127.0.0.1:11434/v1/embeddings',
  embeddingModel: 'nomic-embed-text',
  agentId: 'coding-agent',
  requestTimeoutMs: 15_000,
  enableGraph: false,
  enableBroadcast: false,
});
```

The embedding model must actually be available from that endpoint. `embeddingDimensions` can assert the expected output dimension; an existing Qdrant collection must match it. For authenticated services, the application passes `qdrantApiKey` and `embeddingApiKey`. Optional feature fields are `redisUrl` and `graphUrl`; the old `cacheUrl` and `graphDbUrl` examples were incorrect. There is no automatic environment-to-configuration mapping.

The provided optional service images and settings are development defaults. Pin tested image versions and configure service authentication, backups, and resource limits for your own deployment. The Compose ports bind to loopback; the memory package does not manage service credentials or fleet operations.

## Export, recovery, and forgetting

A CLI snapshot is an owner-scoped portable export, not a whole-database backup:

```bash
node dist/cli/index.js export \
  --db /absolute/path/to/memory.sqlite \
  --workspace my-project --agent coding-agent \
  --out /absolute/path/to/new-snapshot.json

node dist/cli/index.js import \
  --db /absolute/path/to/restored.sqlite \
  --workspace my-project --agent coding-agent \
  --file /absolute/path/to/new-snapshot.json
```

Exports refuse to overwrite existing files. Imports validate the complete snapshot before committing and require the same workspace and agent IDs. Snapshots preserve owner records, outcomes, and idempotency mappings; records whose provenance depends on another owner are omitted to keep the snapshot self-contained. Check the snapshot's `omitted` count before relying on it for recovery. Export and import are bounded to 32 MiB and 100,000 records per snapshot collection.

For a complete database backup, stop every process using that database cleanly and back up its containing directory, or use a SQLite-aware backup mechanism. Do not copy only the main database file from a live WAL database. Keep snapshots and backups outside Git and apply the same access restrictions as the original memory file.

Forgetting purges content from the live local memory store and its searchable/derived state. It cannot erase prior exports, filesystem snapshots, external logs, or underlying storage-controller copies. Manage those copies separately. The legacy vector API has different storage semantics; consult its API documentation before operating on existing data.

## Release checks

CI runs typechecking, a build, tests, a production dependency audit, and an installation smoke test of the packed artifact on Node 22.16.0 and Node 24. The smoke test runs the installed CLI demo and loads the root, local, MCP, and reflection package exports.

The publication workflow runs only on a published GitHub release and uses the existing `npm-publish` environment. It rejects package-name or release-tag mismatches and requires GitHub's prerelease status to agree with the package version. Prereleases go to the npm `next` tag; stable versions go to `latest`. It checks and installs the tarball before publishing that exact artifact with provenance. Repository changes alone do not publish a package.
