# Mnemosyne Shared Memory Tools

Give different host tool loops a shared, scoped memory surface. Mnemosyne's virtual text engine preserves content, revisions and evidence while transport wrappers preserve each protocol's actual call identities and result format. The host chooses its model connection; the tools themselves make no model request and read no physical memory folder.

## Create one shared engine

The host binds database, workspace, agent, namespace and permissions before dispatching a command. Tool arguments cannot switch owners or promote trust. Virtual files are private to that principal, and a shared namespace must use the same established capture identity. An existing namespace is not silently relabeled for a different mode.

<a id="openai-responses"></a>
## Completed function calls

Dispatch only completed calls with their real correlation identifiers, preserve all original response items required by the host protocol, and return a result for each selected operation. Mutable memory calls should run serially in order. The wrapper does not reconstruct conversation history, choose a continuation mode or make a later failed command undo an earlier successful one.

<a id="gemini-generate-content"></a>
## Structured content calls

When a transport uses structured content parts, retain their original order and opaque protocol fields. The host supplies stable operation identities where the transport lacks them. Do not replace a call identity with a whole-response identity or generate a new identity for a retry. Exact wire schemas remain defined by the actual integration; presentation branding does not rename them.

## Results, identities and limits

The neutral function names are `memory_view`, `memory_create`, `memory_str_replace`, `memory_insert`, `memory_delete` and `memory_rename`. Durable mutation receipts prevent duplicate application; source reads are fresh rather than replayed from a text cache. The host bounds loop steps, calls and time, and routes unrelated tools. See [Mnemosyne Memory Tools](/docs/reference/ANTHROPIC-MEMORY.html) for the underlying text lifecycle.
