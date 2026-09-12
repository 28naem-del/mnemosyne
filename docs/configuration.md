# Configuration

## Local mode

`createLocalMemory({ path, workspaceId, agentId, now?, tokenCounter? })` takes explicit options. CLI commands use `--db`, `--workspace`, and `--agent`. The local engine has no network service, environment-variable configuration loader, embedding provider, or background model. MCP authority is set at launch with `--read-only` and `--allow-destructive`.

The database directory must already exist. File permissions reduce accidental access but do not implement encryption or hostile local-user isolation. Select identities in trusted controller code.

## Qdrant mode

Pass configuration to `createMnemosyne` as JavaScript options. Environment variables in your deployment must be read and passed explicitly by your application.

```ts
const memory = await createMnemosyne({
  vectorDbUrl: process.env.QDRANT_URL!,
  qdrantApiKey: process.env.QDRANT_API_KEY,
  embeddingUrl: process.env.EMBEDDING_URL!,
  embeddingApiKey: process.env.EMBEDDING_API_KEY,
  embeddingModel: 'your-model-id',
  embeddingDimensions: 768,
  agentId: 'catalogue-agent',
  requestTimeoutMs: 15000,
  bm25MaxDocs: 50000,
  bm25BatchSize: 100,
  collections: {
    shared: 'project_shared', private: 'project_private',
    profiles: 'project_profiles', skills: 'project_skills',
  },
});
```

Replace model/dimensions with your provider's actual values, or omit dimensions to detect them from startup output. A mismatched existing collection rejects startup; it is not recreated or erased. Authentication uses Qdrant's API-key header and the embedding provider's bearer token. Timeouts and response validation surface errors.

Default embedding model is `nomic-text-v1.5`; the endpoint remains required. Optional graph integration requires `graphUrl` and `enableGraph`; optional broadcast requires `redisUrl` and `enableBroadcast`. Install/configure compatible services separately. Redis is an optional peer dependency.

The factory awaits paginated keyword bootstrap, scanning at most `bm25MaxDocs` per collection. Inspect `memory.bm25Status.collections` for truncated coverage. Increasing the cap consumes startup time and memory. Background progressive indexing is not implemented.

[The configuration type](../src/config.ts) lists all compatibility flags. Some describe historical optional helpers; a true flag alone does not prove an autonomous feature is scheduled. Version 2 maintenance is scoped and nondestructive; legacy URL-only destructive helpers reject. See [migration](MIGRATION-v2.md).
