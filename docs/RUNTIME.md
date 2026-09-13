# Runtime, retrieval and local service

This guide describes the **Mnemosyne 2.0.0-rc.8 source release**. Follow the [tagged quickstart](quickstart.md), or build an existing checkout with `npm ci --ignore-scripts && npm run build`. TypeScript package imports work from this repository after building, or from an installed package. Node >=22.16 is required; the Python client requires Python >=3.10. GitHub source publication does not imply publication to npm or PyPI.

The local engine, vectors, sources, models, skills, entity relations and branch state share one SQLite database. Workspace/agent identity comes from trusted host configuration. A source reference is provenance supplied by the caller, not remote authentication or permission to execute an action.

## Run a complete example

```sh
npm run demo:learning
node --experimental-strip-types examples/runtime-learning.ts
```

The first command runs 13 deterministic integration checks in temporary databases and removes them afterward. The second is a compact SDK example. Both use explicitly scripted proposal output and execute small controller trial fixtures. Neither selects a provider, downloads a model, reads host histories, or makes network/model calls. They establish those integration behaviors, not general LLM task improvement.

## Capture and inspect original evidence

```ts
import { createLocalMemory } from 'mnemosy-ai/local';
import { MemoryRuntime, RECOMMENDED_SKILL_PROMOTION_POLICY } from 'mnemosy-ai/runtime';

const memory = createLocalMemory({
  path: './memory.sqlite', workspaceId: 'atlas', agentId: 'author',
});
const runtime = new MemoryRuntime(memory, {
  skillPromotionPolicy: RECOMMENDED_SKILL_PROMOTION_POLICY,
});
const captured = runtime.capture({
  sessionId: 'export-task-1', adapter: 'generic', trust: 'observed',
  messages: [{ id: 'message-1', role: 'user', text: 'Trim whitespace from Atlas export labels.' }],
}).records[0];

console.log(runtime.expandSource(captured.id, { offset: 0, maxBytes: 4096 }));
// Continue with this memory/runtime below; call memory.close() when finished.
```

`capture` preserves the supplied visible message text and stable message identity. Repeating the same normalized input returns the same records; changing content under an existing identity is rejected. SDK capture and file capture default to `untrusted`; select `observed` when your host is intentionally recording witnessed material. Observed messages can still be false. HTTP/MCP supplied-message capture records observed evidence and cannot claim verified trust.

`captureJsonl({ sessionId, adapter, jsonl, trust? })` accepts `generic`, `codex` and `claude`. Adapters keep visible text, excluding reasoning, nontext payloads and binary image data. Generic rows can contain `id`, `role`, `text` and `timestamp`. The runtime reads only supplied bytes; it does not discover application histories.

Capture batches are bounded to 256 messages and 1 MiB. A message/source text is bounded to 65,536 UTF-8 bytes. `expandSource` returns text, source, trust, status, offset and optional `nextOffset`; offsets must fall on UTF-8 character boundaries. Superseded sources remain inspectable but are not current advice.

For direct documents, `runtime.ingest({ uri, mimeType, text, trust? })` supports plain text, Markdown and JSON. Other documents require `data` and an explicit extractor callback. `createCompatibleImageExtractor` supports PNG/JPEG/WebP through a caller-selected vision model; image input is limited to 4 MiB. There is no bundled PDF parser or implicit OCR/model download. Extracted text remains source-linked evidence, not authenticated truth.

## Read one explicit local file

This complete shell example creates its own data directory and captures a fixture:

```sh
DEMO_DIR=$(mktemp -d)
printf '%s\n' '{"id":"m1","role":"user","text":"Trim whitespace from Atlas export labels."}' > "$DEMO_DIR/session.jsonl"
node dist/cli/index.js capture --db "$DEMO_DIR/memory.sqlite" \
  --workspace atlas --agent author --file "$DEMO_DIR/session.jsonl" \
  --adapter generic --session export-task-1 --trust observed
node dist/cli/index.js recall --db "$DEMO_DIR/memory.sqlite" \
  --workspace atlas --agent author --query 'Atlas export labels'
```

Use `--adapter text` for a direct UTF-8 document; `--mime` can select `text/plain`, `text/markdown` or `application/json`. `--watch --interval 1000` repeats sync while that process remains running; Ctrl+C stops it. Watching installs no scheduled task and does not run model jobs.

The SDK equivalent is `new LocalSourceConnector(runtime, { path, format, sessionId?, trust? })` from `mnemosy-ai/connectors`, followed by `await connector.sync()` or `for await (const result of connector.watch({ signal, intervalMs }))`. The connector rejects a final path symlink, nonregular files, invalid UTF-8 and files changing during a read. It rereads a bounded file, ignores unchanged content, preserves fallback row ordinals across batches, and defers an incomplete final JSONL row. It is not a directory crawler or a large-file streaming cursor.

## Durable observation jobs and explicit providers

```ts
const queued = runtime.enqueue({ kind: 'observe', sourceIds: [captured.id] });
console.log(queued.state); // queued: no model has been called
```

The host supplies a `RuntimeProposer` and invokes `await runtime.runJobs({ proposer, maxJobs, maxCalls, maxInputBytes, maxOutputBytes, maxTotalInputBytes, timeoutMs, leaseMs, maxAttempts, signal })`. `runtime.jobs()` exposes durable states and result IDs. Default runs inspect at most 8 jobs, call at most 4 proposals, allow 3 attempts, and bound each proposal to a 30-second timeout. A lease prevents concurrent claims from both committing the same generation; expired claims can be recovered by a later run. No scheduler wakes itself.

An observation proposer returns `{"observations":[{"text":"...","sourceIds":["supplied-id"]}]}`. A model proposer returns `{"text":"...","sourceIds":["supplied-id"]}`. Output is strictly validated, bounded and checked for unsupported IDs or duplicate/no-progress text. Source state is rechecked after the callback and again before commit. This validates provenance and structure; it cannot determine whether a novel summary is semantically correct.

For a real model, explicitly construct `createCompatibleProposer({ baseUrl, model, apiKey?, timeoutMs?, maxResponseBytes? })` from `mnemosy-ai/providers`. The adapter sends OpenAI-compatible chat-completion requests, rejects redirects, requires HTTPS for nonloopback hosts and bounds responses. Its name describes the wire protocol; it does not select OpenAI or any other vendor automatically.

CLI provider files have this shape. Replace the model with one already available at the chosen endpoint before invoking it:

```json
{
  "baseUrl": "http://127.0.0.1:11434/v1",
  "model": "your-installed-model"
}
```

`apiKeyEnv` optionally names the environment variable containing that endpoint's credential; do not put a literal key in the JSON file. The CLI accepts only `baseUrl`, `model`, `dimensions`, `revision` and `apiKeyEnv`. Proposer and embedding models commonly require different configuration files.

After capture, substitute a returned source ID in these commands:

```sh
node dist/cli/index.js observe --db ./memory.sqlite --workspace atlas --agent author \
  --json '{"sourceIds":["SOURCE_ID"]}'
node dist/cli/index.js run-jobs --db ./memory.sqlite --workspace atlas --agent author \
  --provider-config ./proposer.json --json '{"maxCalls":1,"maxJobs":1}'
node dist/cli/index.js jobs --db ./memory.sqlite --workspace atlas --agent author
```

The worker command invokes the configured endpoint and can incur provider charges. Supply it only as an intentional controller operation. Queuing jobs alone makes no provider call.

## Project models, skill trials and traces

`runtime.refreshModel({ kind: 'model', key, sourceIds, proposer, tier?, parentKey?, ...budgets })` creates or refreshes a source-backed model. `getModel(key, { sourceIds? })` returns `fresh`, `stale` or `missing`; stale results withhold the old text. Supplying the current relevant source set detects additions as well as revisions. `modelContext(key, { maxBytes? })` packs fresh related model text and source citations under a byte budget. Models do not automatically discover a project's relevant sources.

`runtime.createSkill({ name, prerequisites, steps, parameters, evidenceIds })` creates a private candidate. A candidate is excluded from ordinary context. A controller calls `trialSkill({ id, verifier })` with an asynchronous callback, or supplies `validation` containing `passed`, `prerequisitesSatisfied`, `evidence`, `verifier` and `taskId`. Use exactly one of those inputs. The controller must run the real test; setting `passed: true` is an assertion, not proof that anything executed.

For new applications, the constructor above selects `RECOMMENDED_SKILL_PROMOTION_POLICY`: successful trials spanning at least **two distinct task IDs and two distinct verifier IDs**. The candidate remains non-advisory until its stored gate is satisfied. The policy is persisted with each new skill, so reopening that skill through a runtime configured with weaker defaults cannot downgrade its requirements. Existing skills retain their own stored requirements; changing the constructor does not retroactively upgrade them.

Constructing `new MemoryRuntime(memory)` without a policy retains the compatibility default of one task and one verifier. The [runnable example](../examples/runtime-learning.ts) intentionally uses that default and derives `passed` from an executed fixture. Under the recommended policy one successful trial is insufficient. Distinct labels do not establish independent verification: the host must supply authentic task evidence and verifier identities.

When the stored requirements are met, a successful trial promotes the skill to observed, eligible advice and records an outcome. Failed prerequisites, failed outcomes, or changed transitive evidence retire or suppress it. `getSkill(id)` inspects the effective state; `retireSkill(id, reason)` explicitly retires it. Runtime code does not execute skill steps as shell commands or install skills in other applications.

`recordTrace({ taskId, query, retrievedIds, usedIds, outcome? })` records what was retrieved and actually used. Used IDs must be among retrieved IDs. An optional outcome has `success`, `evidence` and `verifier`; it records controller-observed task results on the owned used memories. Reusing a task/evidence identity with conflicting contents is rejected. This is retrieval feedback, not model-weight training.

Runtime skill/model mutation belongs to controller APIs. Do not rewrite their serialized internal records through ordinary correction. Sharing a skill lesson is a separate explicit publication: write a sanitized workspace record backed entirely by workspace-visible sources and validation evidence. Private runtime records are not implicitly published to another agent.

## Hybrid retrieval

```ts
import { createCompatibleEmbedder } from 'mnemosy-ai/providers';

// Explicit configuration for an endpoint/model you already operate.
const embedder = createCompatibleEmbedder({
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'your-installed-embedding-model', dimensions: 768, revision: 'v1',
});
await memory.indexEmbeddings({ embedder, limit: 100, batchSize: 16 });
const context = await memory.compileHybrid(
  { query: 'Atlas export labels', maxTokens: 4096 }, { embedder },
);
console.log(context.text);
```

Use the actual embedding dimension of your selected model. Indexing is incremental; its report returns indexed/skipped/remaining counts. Finish or repeat indexing as needed after new evidence arrives. Indexes are separated by endpoint/model/revision and dimensions. Retrieval revalidates scope, source changes and outcomes; stale vectors cannot make corrected advice eligible. Semantic search scans the scoped stored-vector history with bounded result retention and a deadline. It is not an ANN database or an automatic bridge to another backend. The retained-candidate limit does not restrict search to a recent window or make its scan cost constant.

`recallHybrid(input, { embedder, ...options })` and `compileHybrid(input, options)` combine independently generated semantic and lexical candidates through rank fusion, with optional reranking. Lexical `recall`/`compile` default to scoped BM25 and work without a provider; select `lexicalScoring: 'overlap'` explicitly for the earlier scorer. [Local CPU providers](LOCAL-MODELS.md) are an alternative to the configured endpoint above and require explicit runtime/model setup.

Only `ContextPacket.text` is within the configured context budget; diagnostics and structured records are separate. The default counter is conservative and byte-based; supply `tokenCounter` to use your own model-specific counting.

CLI `index` requires an embedding provider JSON including `dimensions`. After indexing, add the same `--provider-config` to `recall`, `context`, `mcp` or `serve`. Hybrid queries call the configured embedder for the query; they do not silently rebuild every missing vector.

## Time, entities and branches

`memory.store` accepts inclusive `validFrom` and exclusive `validUntil`. `memory.recall({ query, asOf, knownAt })` separates when a fact applied from what had been recorded at the knowledge cutoff. Omit both times for current recall. If only `knownAt` is supplied, `asOf` defaults to that cutoff; if only `asOf` is supplied, the knowledge cutoff is now. `getAt(id, { asOf, knownAt })` projects an accessible record at those clocks, and `isEligible(id, { asOf, knownAt })` checks its eligibility. Historical graph paths use the same record projection.

`compile` and `compileHybrid` accept those same fields and apply historical dependency/outcome checks. Their rendered evidence includes both clocks and a warning that historical evidence need not describe the present. For example, with the `memory` created above:

```ts
const historical = memory.compile({
  query: 'Atlas export labels', maxTokens: 4096,
  asOf: '2026-06-01T00:00:00.000Z',
  knownAt: '2026-06-10T00:00:00.000Z',
});
console.log(historical.text);
```

A store without evidence at those clocks can return no useful historical context. Historical queries do not resurrect forgotten source text.

`memory.list({ limit, cursor, kinds, metadata, includeInactive, includeUntrusted })` returns scoped pages. Cursors bind to the exact scope and filters. `memory.atomic(() => { ... })` makes synchronous controller changes transactional; asynchronous work is rejected and must finish before entering the transaction.

`MemoryRelations` from `mnemosy-ai/relations` exposes `entity`, `resolve`, `relate` and `traverse`. Entity aliases are normalized, while multiple identities with one alias remain explicitly ambiguous. Relations require source evidence. Traversal supports direction, predicate filters, at most 4 hops/200 returned nodes, and `asOf`/`knownAt`. Each path retains its edge records and dependency IDs. Correcting an endpoint or source removes the stale path from current traversal. This is bounded evidence traversal, not autonomous entity extraction or causal inference.

`MemoryBranches` from `mnemosy-ai/branches` isolates proposed changes:

```ts
import { MemoryBranches } from 'mnemosy-ai/branches';

const branches = new MemoryBranches(memory);
const draft = branches.create({ name: 'Atlas label proposal', baseIds: [captured.id] });
const staged = branches.stage(draft.id, [{
  operation: 'add',
  input: {
    text: 'Trim surrounding whitespace from Atlas export labels.',
    kind: 'procedure', trust: 'observed',
    source: { uri: 'example:label-proposal' }, dependencies: [captured.id],
  },
}]);
console.log(branches.preview(staged.id));
// The controller chooses whether to merge the reviewed proposal.
const merged = branches.merge(staged.id);
console.log(merged.memories);
```

Stage returns a new record ID; use it for preview/merge. A merge rechecks the base and all persisted operations, then commits changes and a receipt atomically. It cannot self-certify verified evidence. Corrections require owned base records. Default-untrusted additions remain untrusted, and retries do not duplicate output or recreate forgotten results. A branch is a proposal over captured source IDs, not a complete isolated database snapshot.

## HTTP inspector and Python

Create a new private token file and start the service from the built checkout:

```sh
node --input-type=module -e "import { randomBytes } from 'node:crypto'; import { writeFileSync } from 'node:fs'; writeFileSync('memory-token.txt', randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });"
node dist/cli/index.js serve --db ./memory.sqlite \
  --workspace atlas --agent author --token-file ./memory-token.txt
```

Token creation refuses to overwrite an existing file. Open the printed loopback URL, then enter the token from your private file in the inspector. The server does not print the token. Keep the file out of source control. The default URL is `http://127.0.0.1:8765`; use the exact printed origin because Host/Origin checks intentionally reject unrelated browser origins and DNS rebinding attempts.

A token selects a preconfigured workspace and agent; request bodies cannot override identities or provider credentials. SDK hosts can supply multiple principals through `startMemoryHttp({ principals, host?, port?, requestsPerMinute? })`. The returned handle supports `close()` and `revoke(token)`; revocation is checked after delayed bodies and asynchronous reads.

The unauthenticated `/` and `/app.js` routes contain only the inspector shell. Data routes require `Authorization: Bearer TOKEN`. `GET /v1/capabilities` describes the principal. Other operations use `POST /v1/OPERATION` and uncompressed `application/json`, with strict field validation and 1 MiB request/response bounds. Oversized mutation responses warn that the operation may already have completed; inspect before retrying. Tokens and request data are not stored in browser localStorage.

Read operations include `recall`, `context`, `inspect`, `source`, `model`, `skill`, `branch-preview`, `entity-resolve` and `traverse`. Write operations include `store`, `correct`, `capture` and `branch-create`/`branch-stage`/`branch-merge`. `forget` additionally requires the principal's destructive capability. Read-only principals cannot mutate. Agents cannot submit verified trust or edit controller records through these routes. Worker execution, provider configuration and trial success remain host operations.

The CLI uses one principal and stays on loopback. The SDK has an explicit `allowRemote` binding option, but this server does not terminate TLS or provide a production reverse-proxy setup. It is not a managed public multi-tenant service.

The bundled Python client uses only the standard library at runtime. From the checkout, no package installation is necessary:

```sh
PYTHONPATH=python python3 - <<'PY'
from pathlib import Path
from mnemosyne_memory import MemoryClient

token = Path("memory-token.txt").read_text().strip()
client = MemoryClient("http://127.0.0.1:8765", token, timeout=15)
print(client.capabilities())
print(client.recall("Atlas export labels", limit=5))
print(client.context("Atlas export labels", max_tokens=2048))
PY
```

Alternatively install `./python` in your chosen virtual environment with `python -m pip install ./python`; packaging may fetch its build tools. The Python distribution is `mnemosyne-memory-client`, imported as `mnemosyne_memory`; no published PyPI release is assumed. Helpers cover capabilities, recall, context, inspect, store, correct, forget and capture. `client.request(operation, body)` covers other HTTP operations. It rejects redirects, bounds payloads, exposes HTTP status through `MemoryError.status`, uses socket timeouts and never automatically retries mutations. It does not provide an asynchronous client or a total wall-clock deadline across a slowly streaming response.

The live inspector browses five records per page, searches, displays source/dependency metadata and offers permitted correction/forget actions. Disconnecting or reconnecting clears old data and aborts pending requests. Source range expansion and worker/skill management are available through APIs; the inspector is not yet a full dashboard for those operations.

## Forgetting and remaining limits

Source forgetting also removes source-linked job records and their correction history, including older failed jobs whose diagnostic text may have quoted a source. Jobs use separate erasure links so they remain durable control records without becoming advice. New persisted job failures contain fixed diagnostic categories, never arbitrary provider or parser error text. A queued callback rechecks source state immediately before dispatch; the library cannot recall bytes already delivered to an external service.

For captured evidence use `runtime.forgetSource(id)`. It purges the source's correction history and dependent content, and leaves a non-advisory tombstone containing a hashed ingestion identity. Replaying that stable capture identity is rejected after restart. Ordinary direct memories use `memory.forget(id)`. HTTP/MCP/CLI route captured-source deletion through the runtime and protect its internal tombstones.

This covers content in the live store. It cannot erase context already sent to models, separate exports, backups, filesystem snapshots or SSD remapping. Host filesystem access remains trusted; the SQLite file is not encrypted by this package. Snapshot export/import does not automatically synchronize different engines or hosts.

Semantic quality, generated-summary accuracy and general agent task success need separate model-based evaluation. The local fixtures do not measure them. There is no installed scheduler, automatic provider selection, model-weight learning, application hook installation, directory-wide discovery, cloud replication, or hosted account system. See [evaluation](EVALUATION.md) and [provider memory research](PROVIDER-MEMORY-RESEARCH.md) for the evidence and remaining experimental work.
