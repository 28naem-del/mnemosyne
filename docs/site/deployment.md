# Deploy Mnemosyne

Mnemosyne runs as a scoped local library, an MCP service or a local HTTP service. Use a reviewed source checkout or an explicitly selected package release; website updates do not publish a new package version. The local runtime requires Node 22.16 or later. Keep persistent memory outside the checkout and use an explicit workspace and agent identity for each caller.

## Build and run locally

From a source checkout, build the CLI and point it at your chosen database. This example starts an MCP process over its standard streams; the client owns that connection. It does not expose a network port.

```sh
npm ci --ignore-scripts
npm run build
node dist/cli/index.js mcp --db ./memory.sqlite \
  --workspace my-project --agent assistant
```

## Scope and persistence

Workspace and agent selectors come from trusted host configuration. They do not authenticate an end user. The HTTP service defaults to loopback with bearer authentication; remote authentication and protected transport remain deployment responsibilities. Container deployments must retain their data volume and keep the memory directory writable only by the intended operator.

<a id="existing-qdrant-applications"></a>
## Existing installations

The local engine does not automatically import, rename or delete an existing backend. Keep existing collection identities and storage volumes intact while evaluating a separate local database. Use [gradual migration](/docs/reference/BRIDGE.html) for coexistence or [full migration](/docs/reference/MIGRATION.html) for a reviewed bulk move. Existing backend integrations retain their actual runtime identifiers and configuration contracts.

## Export, recovery, and forgetting

A scoped export is different from a whole-database backup. Inspect omitted-record counts when exporting, and use [recovery operations](/docs/reference/OPERATIONS.html) for a consistent complete snapshot. Backups contain plaintext memory content and require protected storage. Forgetting affects the live store; prior exports, backups and context already delivered elsewhere remain separate copies.
