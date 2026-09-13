# API reference

The generated TypeScript declarations are the exact contract. The local kernel is synchronous and file-backed. Hybrid retrieval, provider calls, extraction and server startup are asynchronous. [Runtime API and examples](RUNTIME.md) cover experience processing, HTTP/Python, connectors, branches and relations.

## Local engine

```ts
import { createLocalMemory, CheckpointConflictError } from 'mnemosy-ai/local';
const memory = createLocalMemory({ path: './memory.sqlite', workspaceId: 'project', agentId: 'agent' });
```

`path` may be `:memory:` for isolated tests. The parent directory must exist. `workspaceId` and `agentId` are fixed for the instance. Optional `now` provides a clock and `tokenCounter(text)` provides a model-specific budget counter.

- `store({ text, source, kind?, trust?, visibility?, evidence?, key?, dependencies?, metadata?, idempotencyKey? })` returns a record. Default kind is observation, trust untrusted, visibility private. `source.uri` is required; source revision/author/observation time are optional. Verified trust requires evidence and remains a controller assertion. Retry keys require an identical normalized payload.
- `get(id)` returns a visible record, including inactive history, or null. `inspect({ limit?, includeInactive? })` lists scoped records; the maximum limit is 100.
- `recall({ query, limit?, kinds?, includeUntrusted?, lexicalScoring? })` searches active records lexically with scope-aware BM25 by default. Use `lexicalScoring: 'overlap'` to select the earlier scorer explicitly. Default limit is 10, maximum 100. Untrusted records are excluded by default. Results include scores and outcome counts; raw recall is for inspection, while `compile` adds provenance eligibility checks. BM25 scores are ranking values, not probabilities.
- `compile({ query, maxTokens, taskId? })` returns `text`, `tokens`, `tokenBudget`, records, citations, conflicts, exclusions, uncertainty, and `abstained`. Only `text` is within the budget. Default counting uses UTF-8 bytes. With no eligible content the packet abstains; a tiny budget can produce empty text.
- `correct(id, { text, source, reason })` creates a replacement, supersedes the old record, and invalidates its descendants. Only the owner can correct. An untrusted source cannot acquire higher trust through correction.
- `forget(id)` purges owned live content, versions, dependent content, outcomes, search entries, and relevant retry payloads; returns deleted IDs. It does not wipe external snapshots, backups, prompts, or physical disk remnants.
- `checkpoint({ taskId, goal, completed, pending, decisions, constraints, artifacts, rejectedApproaches?, nextAction, visibility?, dependencies? })` stores typed task state. Declare source/procedure dependencies so correction invalidates obsolete handoffs; failed or conflicted evidence is excluded from resume. `resume(taskId)` returns active visible state or null, and throws `CheckpointConflictError` for differing shared states.
- `recordOutcome({ memoryId, success, evidence, verifier, taskId })` records a controller-supplied result for an owned record. `getOutcomeSummary(id)` returns scoped success/failure counts; hidden or missing IDs return a generic error.
- `export()` produces a versioned owner snapshot with an optional `omitted` count for cross-agent provenance. `import(snapshot)` validates and restores same-scope records atomically, preserving idempotency. Limits: 32 MiB serialized JSON and 100,000 entries per collection, available as `LOCAL_SNAPSHOT_LIMITS`.
- `close()` releases the connection. Always close in a `finally` block in reusable applications.

Text and identifiers are byte-bounded and NUL-free. Invalid unknown input fields are rejected. Source references are recorded; the engine does not fetch or authenticate them.

## Advanced local retrieval

- `list({ limit?, cursor?, kinds?, includeInactive?, includeUntrusted?, metadata? })` returns `{ items, nextCursor? }`. Pages contain at most 1,000 records, filtered within the fixed scope. Metadata filters are exact string matches.
- `getAt(id, { asOf?, knownAt? })` projects a visible record at the requested valid time and knowledge time. `isEligible(id, time?)` additionally checks provenance, trust, conflicts and recorded failures.
- `recall({ query, asOf?, knownAt?, maxCandidates?, ... })` and `compile` support explicit temporal queries. Records may declare `validFrom`/`validUntil`; corrections retain the earlier text version. This is a versioned evidence view, not an arbitrary replay of every mutable field.
- `await indexEmbeddings({ embedder, ... })` persists vectors identified by endpoint/model/revision/dimensions and source text hash. `await recallHybrid(input, { embedder, reranker?, ... })` fuses scoped lexical and vector candidates, then rechecks current evidence after asynchronous calls. `compileHybrid` packs those results with the same citation and context budget rules.
- `atomic(() => result)` groups synchronous SDK operations under a transaction or nested savepoint. Async callbacks are rejected; keep network work outside the transaction and revalidate inputs before committing.

See [local types](../src/local/types.ts) for exact limits and adapter contracts. Runtime control records marked `advisory: false` remain inspectable but are excluded from ordinary recall and context.

## Reflection

```ts
import { reflect, commitVerifiedLesson } from 'mnemosy-ai/reflection';
const report = await reflect(memory, {
  query: 'catalogue export procedure',
  proposer: yourExistingModelAdapter,
  maxProposals: 3,
  maxInputBytes: 16384,
  maxOutputBytes: 16384,
  timeoutMs: 30000,
});
```

The adapter receives `{ instructions, query, context, maxProposals, maxOutputBytes, signal }`. It must return JSON text or an object of the form `{ proposals: [{ text, rationale, kind: 'procedure' | 'observation', dependencies: ['provided-memory-id'] }] }`. The adapter chooses and pays for any model calls; Mnemosyne selects no provider or fallback. Honor `signal` to cancel external computation.

Reports include proposals, rejections, source IDs, call count, elapsed time, and status. Validate a proposal with an external test or trusted review before calling:

```ts
const lesson = commitVerifiedLesson(memory, {
  proposal: report.proposals[0],
  validation: { passed: true, evidence: 'Your actual test result', verifier: 'Your test runner', taskId: 'actual-task-id' },
  visibility: 'private',
});
```

This illustrates the contract, not a substitute for running the validator. Guard against an empty proposal list. Commitment stores validation metadata and retains observed trust. It does not automatically append an outcome; use `recordOutcome` for subsequent measured uses. Repeated identical commits return the same memory; source/outcome changes invalidate outstanding proposals.

## MCP

`createMemoryServer(memory, { readOnly?, allowDestructive?, runtime?, hybrid? })` creates an SDK server. `serveMemoryStdio(memory, options)` connects it. Import these from `mnemosy-ai/mcp`. Caller code owns closing the server and memory. The CLI handles its own lifecycle. Escaped tool results are capped at 1 MiB; oversized reads return a small error and keep the connection alive. Retry with a smaller limit or one ID. If a write completed but its result exceeded the cap, the error explicitly says so; do not repeat the write just to obtain a response.

Model tools have narrower authority than the controller SDK. They cannot choose another identity, promote trust to verified, report outcomes, import snapshots, or commit reflection. Correction of controller-verified records is refused. Forgetting is opt-in at server launch.

## Qdrant compatibility API

```ts
import { createMnemosyne } from 'mnemosy-ai';
const vectorMemory = await createMnemosyne({
  vectorDbUrl: 'http://127.0.0.1:6333',
  embeddingUrl: 'http://127.0.0.1:11434/v1/embeddings',
  agentId: 'agent',
});
```

The factory probes embedding dimensions, checks collection compatibility, and awaits bounded keyword indexing. `bm25Status` reports readiness and per-collection coverage/truncation. `store`, `recall`, `search`, `stats`, `update`, `feedback`, `consolidate`, and `dream` retain their typed interfaces. Erasure requires `forget({ id, collection? })`; query erasure is disabled. Low-level backend classes assume a trusted controller and are not a public authentication layer. [Configuration](configuration.md) and [migration](MIGRATION-v2.md) describe boundaries.
