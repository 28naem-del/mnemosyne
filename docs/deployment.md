# Deploying Mnemosyne 2

Mnemosyne 2 has two storage paths. The local engine, MCP server and authenticated HTTP service use SQLite and BM25 retrieval by default. The existing `createMnemosyne()` API uses a separately configured vector service and embedding endpoint. Starting a local service does not connect optional legacy databases. It makes no model-provider calls by default; an explicit `--provider-config` enables hybrid queries that send query text to the configured embedding endpoint. See [semantic indexing and hybrid recall](RUNTIME.md#hybrid-retrieval) for provider setup and data flow.

This guide describes **2.0.0-rc.9**. Use the [quickstart](quickstart.md) for an exact-version npm installation or a fresh clone of the matching tag. With the npm package installed, replace `node dist/cli/index.js` below with `npx --no-install mnemosy`; the remaining flags are identical. Python registry publication remains separate.

## Build and run locally

Use Node.js **22.16.0 or newer**; CI checks the minimum version and Node 24. Node's built-in SQLite may emit an experimental warning on stderr on some versions.

```bash
npm ci --ignore-scripts
npm run build
npm run demo
npm run demo:learning
```

The demos use isolated temporary databases and check handoffs, privacy, correction propagation, evidence, runtime learning fixtures and forgetting. They do not call an LLM or measure agent intelligence. Run `npm run check` separately for the full contributor checks.

Start an MCP server with an explicit persistent path and identity:

```bash
node dist/cli/index.js mcp \
  --db /absolute/path/to/memory.sqlite \
  --workspace my-project \
  --agent coding-agent
```

An MCP client launches this command and communicates over stdin/stdout. This MCP command opens no HTTP port and installs no background service. Use an absolute path to a supported Node executable if the client has a different `PATH` from your terminal.

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

## Authenticated HTTP and browser inspector

Use the separate `serve` command for a local browser or a Python/HTTP integration. The [runtime service example](RUNTIME.md#http-inspector-and-python) generates a private token file, starts the service and demonstrates the Python client. It binds to loopback by default and requires bearer authentication for data routes. Tokens select configured identities and capabilities; request bodies cannot choose another scope. Read-only mode and destructive access remain explicit host choices.

The SDK supports multiple principals and explicit remote binding. It does not terminate TLS, supply organizational single sign-on or provision a managed public service. Configure those deployment boundaries in your application before exposing the service remotely. The static inspector shell is public, while memory data requires a valid token.

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

For complete recovery, use the built-in `mnemosy-ai/operations` helpers: `backupLocalDatabase`, `verifyLocalBackup` and `restoreLocalBackup`. They use a consistent SQLite snapshot, including committed WAL state, verify the bundle and restore to a **new** database path. The CLI exposes the same operations:

```sh
mkdir -m 700 ./backups ./recovery
node dist/cli/index.js operations --action backup --db ./memory.sqlite --out ./backups/snapshot.mnemo-backup
node dist/cli/index.js operations --action verify --file ./backups/snapshot.mnemo-backup
node dist/cli/index.js operations --action restore --file ./backups/snapshot.mnemo-backup --out ./recovery/memory.sqlite
```

Use new operator-owned private directories and substitute your actual database path. Existing outputs are refused; restore does not replace a running database or switch your application to it. A whole-database backup contains every workspace and agent, so this operator capability has no owner filter. See [whole-database recovery](OPERATIONS.md) for POSIX filesystem requirements, bounds, cancellation and an operator rehearsal.

Do not copy only the main file from a live WAL database. Bundles and exports contain plaintext data, and a SHA-256 digest is not an authenticity signature. Keep them outside Git in protected storage. A backup predating an erasure cannot contain the later tombstone; reconcile your retained deletion policy before making a restored database available.

Forgetting purges content from the live local memory store and its searchable/derived state. It cannot erase prior exports, filesystem snapshots, external logs, or underlying storage-controller copies. Manage those copies separately. The legacy vector API has different storage semantics; consult its API documentation before operating on existing data.

## Release checks

CI runs typechecking, a build, tests, a production dependency audit, and an installation smoke test of the packed artifact on Node 22.16.0 and Node 24. CI and publishing use the same artifact verifier. It imports every declared package export, checks all declared JavaScript and type files, executes both installed CLI demonstrations, checks package/CLI/MCP version agreement, and verifies the tarball integrity and installation receipt.

The [npm publication workflow](../.github/workflows/publish.yml) runs only through manual `workflow_dispatch`, with an explicit `release_tag` input and the `npm-publish` environment. It checks out `refs/tags/<release_tag>` and requires the package name to be `mnemosy-ai` and the tag to equal exactly `v` plus `package.json`'s version. A version containing a prerelease suffix goes to npm `next`; a stable version goes to `latest`.

The workflow reruns checks and the dependency audit, then installs and verifies the packed tarball before publishing that exact file with provenance. Creating a GitHub prerelease, pushing source changes or updating the website does not trigger npm publication. The existence of this workflow is not evidence that a particular package version has been published to a registry.
