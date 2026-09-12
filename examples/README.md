# Runnable examples

Start with `npm run check` and `npm run demo` in the repository root. The demo runs the complete local handoff/correction workflow with synthetic data, without external services.

The three TypeScript examples here demonstrate the separate backend APIs. Build first, use Node >=22.16, and run with `node --experimental-strip-types examples/basic-usage.ts` (substitute the other filename as needed). Environment variables must be passed by your shell; if you use an `.env` file, add Node's `--env-file=.env` option explicitly. These examples do not load environment files automatically.

- `basic-usage.ts`: requires explicit `QDRANT_URL` and full `EMBEDDING_URL`; supports optional provider keys/model. Writes to isolated `example_*` collections, recalls, and forgets the sample ID. It does not delete the collections.
- `with-redis.ts`: requires explicit `REDIS_URL`; demonstrates the actual publisher/subscriber classes, bounded delivery wait, and disconnect. No nonexistent factory subscription API is used.
- `with-falkordb.ts`: requires explicit `GRAPH_URL`; demonstrates direct entity/relationship storage and lookup in `mnemosyne_example_graph`. Sample nodes remain in that example graph. An empty lookup is not proof of a successful live write; inspect your backend if needed.

Never point example writes at production services. These examples were checked against generated API declarations; live Redis/Qdrant/FalkorDB conformance is not part of the default local test suite. See [deployment](../docs/deployment.md) for optional infrastructure.
