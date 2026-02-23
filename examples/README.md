# Mnemosyne Examples

This directory contains runnable TypeScript examples demonstrating Mnemosyne's core features.

## Prerequisites

All examples require:
- **Node.js 22+** and **TypeScript** (`npm install -g ts-node typescript`)
- The Mnemosyne package built locally (`npm run build` in the repo root)
- A copy of `.env.example` saved as `.env` (fill in your values)

```bash
cp .env.example .env
```

---

## Examples

### `basic-usage.ts`

**The essential CRUD loop.** Shows how to:

1. Create and configure a Mnemosyne instance
2. `store()` — persist a memory with text, category, importance, and metadata
3. `recall()` — semantic search over stored memories by query string
4. `forget()` — permanently delete a memory by id

**Requires:** Qdrant + Ollama (or any OpenAI-compatible embedding endpoint)

```bash
npx ts-node examples/basic-usage.ts
```

---

### `with-redis.ts`

**Fleet-wide memory broadcasting.** Demonstrates:

- Two agent instances sharing the same Qdrant collection
- One agent stores a memory → the other receives a real-time Redis pub/sub event
- `subscribe()` / `unsubscribe()` API for event-driven memory pipelines

**Requires:** Qdrant + Ollama + Redis

```bash
npx ts-node examples/with-redis.ts
```

---

### `with-falkordb.ts`

**Knowledge graph integration.** Demonstrates:

- Automatic entity/relationship extraction into a FalkorDB property graph
- `graph.traverse()` — multi-hop graph traversal from a named entity
- `spreadingActivation()` — loosely related memory retrieval via graph propagation

**Requires:** Qdrant + Ollama + FalkorDB

```bash
npx ts-node examples/with-falkordb.ts
```

---

## Running with Docker Compose

The quickest way to spin up all dependencies at once:

```bash
# Start Qdrant, Redis, and FalkorDB
docker compose up -d qdrant redis falkordb

# Run any example
npx ts-node examples/with-falkordb.ts
```

See [`docker-compose.yml`](../docker-compose.yml) at the repo root for service definitions.

---

## Environment Variables

| Variable          | Default                        | Description                             |
| ----------------- | ------------------------------ | --------------------------------------- |
| `QDRANT_URL`      | `http://localhost:6333`        | Qdrant vector store URL                 |
| `EMBEDDING_URL`   | `http://localhost:11434`       | Ollama (or OpenAI-compatible) base URL  |
| `EMBEDDING_MODEL` | `nomic-embed-text`             | Model name for generating embeddings    |
| `AGENT_ID`        | `my-agent`                     | Unique identifier for this agent        |
| `COLLECTION_NAME` | `memories`                     | Qdrant collection to use                |
| `REDIS_URL`       | `redis://localhost:6379`       | Redis connection URL (for broadcasting) |
| `FALKORDB_HOST`   | `localhost`                    | FalkorDB host                           |
| `FALKORDB_PORT`   | `6380`                         | FalkorDB port                           |
| `MONGODB_URL`     | `mongodb://localhost:27017`    | MongoDB URL (optional document store)   |
