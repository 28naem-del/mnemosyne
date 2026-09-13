# Connect an existing agent

`mnemosy-ai/agent` joins the local memory lifecycle to a host-owned agent loop. It recalls current context, captures supplied visible messages exactly, schedules durable observation jobs, and checks memory dependencies immediately before a host action. Construction starts no timers, reads no host history, installs no hooks, and calls no provider.

## One host turn

```ts
import { createLocalMemory } from 'mnemosy-ai/local';
import { MemoryRuntime } from 'mnemosy-ai/runtime';
import { MemoryAgent } from 'mnemosy-ai/agent';

const memory = createLocalMemory({
  path: './memory.sqlite', workspaceId: 'atlas', agentId: 'assistant',
});
const agent = new MemoryAgent(new MemoryRuntime(memory), {
  captureTrust: 'observed',
});

try {
  const result = await agent.runTurn({
    sessionId: 'conversation-123', turnId: 'turn-456',
    input: 'What does our Atlas release require?',
    query: 'Atlas release requirements', maxTokens: 4096,
  }, async ({ input, context, signal }) => {
    // Call your existing, explicitly authorized model here.
    // Supply context.text as reference data, not system instructions.
    return yourHost.respond({ input, memory: context.text, signal });
  });
  console.log(result.response);
} finally {
  await agent.close();
  memory.close();
}
```

`runTurn` invokes the supplied responder at most once for a retained `(workspace, agent, sessionId, turnId)` identity. It never retries the responder. Use a new turn ID for genuinely new user input. A durable reservation is written immediately before dispatch. It contains identity/input hashes and a nonce, not raw conversation text. A replay, ambiguous crash, or previously failed attempt rejects with `AgentOperationError.code === 'already-attempted'`. A crash between reservation and dispatch can therefore require host reconciliation. This is not an external exactly-once guarantee.

Successful visible input and response are captured together, preserving whitespace and UTF-8 text. Each eligible message receives its own durable observation job in the same transaction, so appending a replayed transcript does not schedule duplicate work. Source identity tombstones block forgotten message replay. The turn reservation remains after source forgetting to prevent the host callback running again; it contains no raw source bytes.

If the host returned a response but capture failed, `AgentOperationError.code` is `capture-failed` and its in-memory `response` property lets the host reconcile the visible result. The result and raw exception are not persisted. Do not blindly retry external work. Timeouts and cancellation signal the host and ignore late results; the library cannot undo an action a callback already performed.

The default capture trust is `untrusted`, which stays out of advisory recall and observation jobs. Set `captureTrust: 'observed'` only when your host witnessed the supplied messages. Observed content remains a source assertion, not independently verified truth. Sharing defaults to private; an explicit `visibility: 'workspace'` exposes the source to other agents in the same workspace. Generated observations remain private unless deliberately shared by another controller operation.

## Gradual migration beside an existing memory system

Pass `contextProvider: bridge.contextProvider` to use the [MemoryBridge](BRIDGE.md) inside the existing agent loop. Full export migration remains a separate option. The bridge reads the explicitly supplied legacy adapter and stages source records, so its provider declares `requiresCapture: true`; read-only or capture-disabled agents reject it before calling the adapter. Recall-disabled agents return disabled context without invoking it.

A custom `AgentContextProvider` has an asynchronous `build` and a **synchronous** `validate(context)` that throws when its packet or supporting source state is no longer valid. The agent invokes validation after construction and again immediately before responder dispatch. The rendered context fields are bound against mutation. Asynchronous validation is rejected; it cannot authorize dispatch while still pending. Provider methods are bound at construction, and `contextBuilder` and `contextProvider` are mutually exclusive.

The provider remains trusted host code and must bind all claims to complete source evidence. Use the supplied bridge provider to retain its additional origin, lease and freshness checks. A final validation checks locally recorded evidence; it does not make an external legacy database and host action one distributed transaction.

## Existing lifecycle and event streams

For hosts that already control turn boundaries, call `beforeTurn({query,maxTokens})`, then `afterTurn({sessionId,messages})`. A message contains a stable `id`, visible `role` and exact `text`. These methods allow you to keep the host's own retry, streaming, approval and error semantics.

`beforeTurn` uses [adaptive context](CONTEXT.md): source-backed representations, budget accounting, current provenance, and freshness throughout the dependency chain. Context construction makes no provider call. It checks the result again after asynchronous construction. The optional `contextBuilder` is trusted host code: it must report every rendered claim's supporting `memoryIds` and honest token accounting. Pass a custom adaptive-context builder when you need your model's actual tokenizer; the default uses a conservative UTF-8 byte estimate, not a provider tokenizer. `runTurn` revalidates its default context again immediately before responder dispatch.

`afterTranscript({adapter,sessionId,jsonl})` accepts the existing generic/Claude/Codex supplied transcript formats. `afterEvents({adapter,sessionId,events})` additionally accepts these SDK event envelopes:

- **Codex:** completed `agent_message` items from `item.completed`. Partial updates, reasoning, tools, and command output are ignored. An included `thread.started` must match the explicitly selected session. The SDK item event itself carries no thread identity: the host must route a stream to the correct instance/session. User input is captured separately through `afterTurn` or `runTurn`.
- **Claude:** visible user/assistant SDK messages with stable `uuid` and a matching `session_id`. Text content blocks concatenate verbatim. Thinking/tool/image blocks, synthetic messages, tool-result envelopes, errors, subagent messages, partial events and duplicate result summaries are excluded. Supply stable IDs for user messages that lack an SDK UUID; no random identity is invented.

SDK events use a distinct `sdk:` session namespace. Do not mix transcript and SDK ingestion for the same conversation and expect cross-format deduplication. Batch adapters handle at most 256 events/messages, 64 KiB per visible message and 1 MiB of captured text. A supplied turn can contain at most 64 KiB per input/response. Session/message identifiers follow the runtime's bounded identifier contract.

These adapters were checked against the [Codex TypeScript event definitions](https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts), [Codex item definitions](https://github.com/openai/codex/blob/main/sdk/typescript/src/items.ts), and [Claude Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript) on September 13, 2026. They consume caller-supplied events; they are not installed Codex/Claude hooks and have not been verified against a live authenticated model session.

## Bounded learning while the host runs

With no proposer, capture and recall work locally; `drain()` reports `no-proposer`, and observation jobs remain queued. To synthesize observations, pass a deliberately chosen `RuntimeProposer` in the constructor. Provider selection, credentials and any billing remain with the host.

```ts
const agent = new MemoryAgent(runtime, {
  captureTrust: 'observed',
  proposer: yourAuthorizedProposer,
  jobBudgets: { maxJobs: 4, maxCalls: 2, timeoutMs: 10000 },
});
const worker = agent.start({
  intervalMs: 1000, maxCycles: 60, maxDurationMs: 60000,
  maxCalls: 8, maxTotalInputBytes: 1024 * 1024,
  signal: shutdown.signal,
});
// Continue your host work, then await worker.done or stop it explicitly.
const report = await worker.stop();
```

A start has finite cycle, duration, total call and total input-byte limits. Default limits are 60 cycles, 60 seconds, 16 proposer calls and 1 MiB of input. Calls/bytes are shared across cycles, not reset each tick. Each runtime call also obeys its job, retry, input/output, timeout and lease limits. `jobBudgets.maxInputBytes` defaults to 256 KiB for a 64 KiB visible message plus its envelope. The runtime's default total batch input remains 128 KiB. Use `drain()` for one manual bounded batch.

Only one drain runs per `MemoryAgent`. Repeated concurrent `start()` calls return the first handle and preserve its limits; repeated manual drains join the first operation and use its cancellation signal. Manual drain and scheduled drain cannot begin together. `stop()` cancels both types of drain; `close()` cancels/waits for work and prevents further calls, but leaves the caller-owned database open. Await close before closing the database. Idle loops stop at their bounds. Process exit removes the in-process timer; queued jobs and lease state survive in SQLite. After reopening, a new explicitly started worker can recover expired leases. Two independent clients use the existing runtime compare-and-set leases to avoid committing the same job generation twice.

Raw provider or host error strings are never persisted by this layer. Cancellation depends on callback cooperation for stopping external work; late memory writes are rejected. Processing never automatically creates or trusts skills. Use the separate runtime skill trial and controller verification APIs for that decision.

## Check evidence immediately before an action

```ts
const planned = agent.prepareAction({
  name: 'release', args: { project: 'Atlas', reviewers: 2 },
  memoryIds: [policySourceId], dependenciesComplete: true,
  requireWatched: true, lifetimeMs: 10000,
});
// The host obtains approvals or performs other work here.
const result = await agent.executeAction(planned, async ({ args, signal }) => {
  return yourAuthorizedReleaseAction(args, signal);
});
```

The host asserts that `memoryIds` cover every memory dependency of the exact proposed action. The action name and bounded JSON arguments are copied, frozen and bound to a short-lived authenticated read set. `executeAction` rechecks it in the dispatch microtask and calls the host without another await in between. Correction, forgetting, failed outcomes, stale source checks, expired tickets, tampering and action replay reject before dispatch. Plans are instance-bound and single-use; creating a new agent requires preparing a new action.

Freshness policies and source checks come from `agent.maintenance`; no URL or document is fetched automatically. `requireWatched: true` requires every dependency to have a current confirmation. With the default false, unwatched eligible memories are allowed, while any watched stale dependency is still rejected. This is a point-in-time gate, not a transaction over an external service. The host still owns action authorization, complete dependency selection and any downstream idempotency key.

## Restrictive policies

`recallEnabled: false` prevents context construction and learning; direct capture remains possible and does not inspect source text for processing. `captureEnabled: false` prevents capture and learning. `readOnly: true` on `MemoryAgent` also denies erasure. These policies are checked before invoking builders/proposers. `runTurn` requires capture capability because its replay reservation and after-turn capture are part of its contract; recall-only hosts can call `beforeTurn` and their own responder directly.

Explicit `forgetSource` remains available when capture or recall is disabled, so restrictive collection settings do not prevent privacy erasure. It is denied in read-only mode. This wrapper controls operations performed through itself; callers that retain direct access to `runtime` or the database remain responsible for their own access policy.

The offline [agent-loop example](../examples/agent-loop.ts) exercises capture, synthesized observations, reuse, correction, stale action rejection and forgetting. Its responder/proposer are scripted fixtures, not claims of real model quality.
