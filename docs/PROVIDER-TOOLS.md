# Share virtual memory across native tool loops

The provider adapters expose Mnemosyne's six virtual memory operations as OpenAI Responses functions and Gemini Generate Content function declarations. A fresh, explicitly generic memory namespace can also serve Claude's native memory tool. These handlers execute local commands; the host owns its model requests, conversation history and authorization.

This is separate from ChatGPT or Gemini consumer memory, Vertex AI Memory Bank, OpenAI Chat Completions, and Gemini Interactions. It neither configures those products nor transfers their saved memories automatically.

## Create one shared engine

```ts
import { createLocalMemory } from 'mnemosy-ai/local';
import { MemoryRuntime } from 'mnemosy-ai/runtime';
import { createAnthropicMemoryAdapter, createProviderMemoryTools } from 'mnemosy-ai/adapters';

const memory = createLocalMemory({
  path: ':memory:', // Or an explicit persistent SQLite path chosen by the host.
  workspaceId: 'authorized-workspace',
  agentId: 'authorized-agent',
});
const engine = createAnthropicMemoryAdapter({
  memory,
  runtime: new MemoryRuntime(memory),
  namespace: 'fresh-shared-provider-notes',
  captureAdapter: 'generic',
});
const tools = createProviderMemoryTools({ engine });
```

The existing engine retains its Anthropic class/factory names and native methods. `captureAdapter: 'generic'` is an immutable host choice that prevents OpenAI or Gemini writes from being mislabeled as Claude transcript records. All providers using this generic engine share its private notes. Namespaces isolate virtual file bindings, not privacy principals: the protected `_sources` mount can inspect owned captured sources across namespaces in the same workspace and agent scope. Use distinct authorized scopes when source privacy must be separate. Existing default Claude namespaces retain their original provenance; selecting the opposite mode for an existing namespace fails. Use a fresh generic namespace until an explicit migration is available.

Write trust defaults to `untrusted`; explicit file views remain available. The host may select `writeTrust: 'observed'` for application-witnessed text, which does not certify the truth of that text. Policy, source corrections, stale-view guards, deletion and replay protection are the [same engine contracts](ANTHROPIC-MEMORY.md). No transport parameter can select another owner, change trust or promote a skill.

## OpenAI Responses

Supply `[...tools.openAIResponsesTools]` as the request's `tools`. Definitions are flat Responses function objects with explicit `strict: true`, closed argument objects and every property required. Nullable values represent the two optional meanings: send `view_range: null` for a normal view and `new_str: null` to delete the matched text. Omitting these fields is rejected on this transport. [Official function-calling guide](https://developers.openai.com/api/docs/guides/function-calling).

After assembling a completed response, dispatch each selected memory function-call item:

```ts
const output = tools.handleOpenAIResponsesCall(callItem, {
  sessionId: 'stable-session-chosen-by-the-host',
  signal: abortController.signal,
});
// null means an unrelated tool name: route it through your other tool handlers.
// Otherwise append `output` as a function_call_output in your next request.
```

The wrapper echoes `call_id`, which differs from the output item's `id` and the response's `id`. It accepts complete direct calls with `status: 'completed'`; streaming, incomplete, asynchronous, programmatic and namespaced variants are outside this wrapper's contract. This status requirement is deliberately stricter than the SDK's optional input field. [Pinned official Responses types, SDK 7.13.0](https://github.com/openai/openai-node/blob/c037ba724235cd58943e95d5b3b98ff76235e83c/src/resources/responses/responses.ts).

For manually managed history, preserve every original response output item, including reasoning items, before appending tool outputs. Alternatively the host may use the actual response ID as `previous_response_id` with new outputs. The wrapper does not choose between those modes or configure storage/retention. `call_id` is not a conversation continuation ID. [Conversation-state guide](https://developers.openai.com/api/docs/guides/conversation-state).

Prefer `parallel_tool_calls: false` for mutable memory. If several calls arrive, dispatch them serially in order and supply a result for each before continuing the model. Separate operations are separate transactions; a later failure does not undo an earlier success.

## Gemini Generate Content

Supply `[...tools.geminiGenerateContentTools]` as `tools` for the Gemini Developer API Generate Content request. This module targets the `v1beta` Generate Content contract, which current Google navigation labels Legacy; it does not claim Interactions compatibility. The declarations use the documented OpenAPI-style `parameters` schema with uppercase types. They contain neither OpenAI's `strict` field nor JSON Schema union types. [Official Generate Content function calling](https://ai.google.dev/gemini-api/docs/generate-content/function-calling?hl=en).

Select one complete candidate, retain its complete model `content`, and dispatch its function-call parts:

```ts
const part = tools.handleGeminiFunctionCall(functionCall, {
  sessionId: 'stable-session-chosen-by-the-host',
  // Required only when the provider omitted functionCall.id:
  operationId: 'persisted-generation-key:candidate-0:part-2',
});
// null means an unrelated tool name.
// Append collected functionResponse parts in one new role:'user' Content,
// after the unchanged original model Content.
```

Arguments are objects. `view_range` and `new_str` may be omitted or null on this transport. A present `functionCall.id` is copied to `functionResponse.id`; a generation's `responseId` cannot replace it. When a call lacks an ID, the host must persist a stable operation identity for that exact generation, selected candidate and part. Do not generate a new identity for a retry or use one generation ID for multiple calls. [Gemini REST reference](https://ai.google.dev/api/generate-content).

Preserve all original model parts, their order and every opaque `thoughtSignature`. Do not rebuild history from the convenience function-call list or copy only the call parts. Retain earlier contents in the same multistep turn as well. The wrapper handles individual calls and cannot enforce candidate selection or history preservation for the host. [Thought-signature requirements](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures).

## Results, identities and limits

The six names are `memory_view`, `memory_create`, `memory_str_replace`, `memory_insert`, `memory_delete` and `memory_rename`. `tools.handlesName(name)` tests exact membership. Descriptions and local validation follow the virtual `/memories` engine; function arguments are closed and never treated as executable instructions.

Successful payloads are `{ ok: true, result: string }`; failed commands return `{ ok: false, error: { code, message } }`. Responses encodes that payload as JSON in `output`; Gemini places the object in `functionResponse.response`. Malformed envelopes without usable correlation throw `ProviderMemoryToolError`. Unknown names return null without dispatching memory operations. Unexpected failures are sanitized.

Provider IDs are namespaced before becoming engine receipt identities, so the same raw OpenAI and Gemini ID cannot collide. Mutation retries recheck live permissions and return a content-free acknowledgement without applying again. Read results are fresh; the wrapper never caches source text for replay. The neutral engine also exposes `execute(input, { sessionId, operationId, signal })` for trusted host integrations; input uses the native six-command shape and failures throw a bounded engine error.

The host must bound calls per step, total steps and time. It must finish assembling streaming output, select one candidate, dispatch every selected call and route unrelated tools. These are host responsibilities, not protections supplied by a single-call handler. The adapters do not create model clients, invoke an autonomous loop, perform network requests, configure applications or access host memory folders.

## Run the local protocol example

```sh
node --experimental-strip-types examples/provider-memory-tools.ts
```

The [example](../examples/provider-memory-tools.ts) uses synthetic complete provider envelopes with real isolated SQLite: OpenAI creates a note, Gemini views and edits it, and Claude's native interface reads the same revision. It preserves original Responses reasoning items and Gemini model contents/signature sentinels, with a 32-call per-step bound. It also preserves correlated failures alongside successful results and avoids generating an empty tool-result turn for a final text-only reply. Those sentinels are test data, not valid provider signatures. Passing this example proves local protocol handling; a live model/API session remains a separate evaluation.
