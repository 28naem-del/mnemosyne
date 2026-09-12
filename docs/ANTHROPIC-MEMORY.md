# Claude native memory commands

The `mnemosy-ai/adapters` entry point provides a client-side handler for Anthropic's native `memory_20250818` tool. Claude can view and edit virtual text files under `/memories`; Mnemosyne stores their contents, revisions and provenance in the caller's scoped SQLite database. The adapter makes no model calls and accesses no physical `/memories` directory.

The native tool definition, command fields and client-execution pattern follow [Anthropic's memory-tool documentation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool). The runnable integration was checked against the public [TypeScript SDK helper and runner contract](https://github.com/anthropics/anthropic-sdk-typescript/blob/135f71e9297683e14614d4307081c0273ed0a09c/src/helpers/beta/memory.ts), version 0.125.0. This package does not require that SDK as a dependency or configure a Claude application.

## Bind an authorized scope

```ts
import { createLocalMemory } from 'mnemosy-ai/local';
import { MemoryRuntime } from 'mnemosy-ai/runtime';
import { createAnthropicMemoryAdapter } from 'mnemosy-ai/adapters';

const memory = createLocalMemory({
  path: '/absolute/path/chosen-by-your-app/memory.sqlite',
  workspaceId: 'your-authorized-workspace',
  agentId: 'your-authorized-agent',
});
const runtime = new MemoryRuntime(memory);
const adapter = createAnthropicMemoryAdapter({
  memory,
  runtime,
  namespace: 'project-notes',
  policy: () => ({
    recallEnabled: true,
    captureEnabled: true,
    readOnly: false,
    allowDestructive: false,
  }),
});
```

The application chooses the database, owner, namespace, session ID and permissions. These values are not accepted from model command input. The runtime must wrap the same `LocalMemory` instance. Native files are private to that principal. A scope selector alone is not authentication; the host must authenticate its caller before constructing the adapter.

Default permissions enable viewing and ordinary writes, with deletion disabled. Runtime capture/recall controls also apply. A trusted host can grant deletion independently; privacy deletion remains available under the documented policy when capture or recall is disabled. Close the memory instance when the host is finished.

For a new namespace shared with OpenAI Responses or Gemini Generate Content, select the immutable `captureAdapter: "generic"` option and use the [provider wrappers](PROVIDER-TOOLS.md). Existing default Claude namespaces retain their original capture identities; an opposite-mode namespace fails rather than relabeling old records.

## Manual Messages loop

Supply `adapter.definition` in your application's native tools array. When the API returns a matching tool-use block, execute it locally:

```ts
const result = adapter.handleToolUse(
  {
    type: 'tool_use',
    id: 'actual-tool-use-id-from-the-api',
    name: 'memory',
    input: {
      command: 'create',
      path: '/memories/project.md',
      file_text: 'Atlas releases on Tuesday.',
    },
  },
  { sessionId: 'stable-session-id-chosen-by-the-host' },
);
// Return `result` in the next user-role tool_result message in your loop.
```

The handler returns a native `tool_result` with the original tool-use ID. Command failures set `is_error: true`. An invalid outer block or missing tool-use ID throws because there is no trustworthy ID for a result; the host should handle malformed API envelopes. An optional `AbortSignal` belongs in the second argument. The handler never sends an API request itself.

`adapter.asRunnable({ sessionId })` provides a structurally compatible native runnable tool for an Anthropic SDK runner. It validates input and consumes the runner's trusted tool-use ID and cancellation signal. It throws command failures so the runner can produce error results. Do not wrap it in a helper that drops the tool-use context: durable retry protection needs the actual ID.

Run the [executable example](../examples/anthropic-memory.ts) from a source checkout after building:

```sh
node --experimental-strip-types examples/anthropic-memory.ts
```

This example executes native command objects, correction, retry and deletion locally. It does not run Claude or establish model task performance.

## Text operations

- `view` lists a directory or displays numbered file lines. `view_range` is inclusive and 1-based; an end of `-1` reads through EOF within the result budget.
- `create` creates a new file and implicit parent directories. Existing destinations fail; a committed retry with the same trusted ID does not create twice.
- `str_replace` requires exactly one literal occurrence, including across multiple lines. Duplicate occurrences on one line are ambiguous. Omitted `new_str` deletes the match; replacement characters such as `$&` remain literal.
- `insert` inserts after a logical line. Zero prepends. Existing line bytes are preserved; necessary LF separators are added.
- `rename` moves a file or directory subtree atomically. A pure rename preserves content identity and does not retire advice derived from unchanged text.
- `delete` removes a file or subtree only when the host grants destructive permission. It forgets original revisions and their dependent content.

Before editing a file first encountered in a session, view it in that adapter session. A successful create or edit also establishes the current revision observation, so consecutive edits to that revision are allowed. If its revision changes elsewhere before an edit, the command fails with a conflict requiring a fresh view. Revision observations are held in memory; restarting the adapter requires another view. This makes stale line-number edits detectable, without adding unsupported fields to the native schema.

Line numbering splits on LF and retains CR characters. One terminal LF does not create a phantom final line. Empty files have zero lines. For example, inserting `x` after line 1 transforms `a\nb` into `a\nx\nb`, and transforms `a\n` into `a\nx\n`. This convention is explicit because the current official SDK helpers differ at newline boundaries.

## Evidence and replay

Nonblank text becomes a model-authored captured source with `untrusted` provenance by default. Explicit file viewing remains available, while ordinary advice retrieval excludes untrusted notes. The host can set `writeTrust: "observed"` when it intends these notes to participate in recall. “Observed” means the host witnessed the text; it does not certify that its assertions are true. Native commands cannot mark facts verified, promote skills, execute code, change provider configuration or choose another owner.

Content edits correct the source and suppress advice that depends on its old version. Original captured text remains inspectable until forgotten. Blank values retain their exact UTF-8 bytes through a validated base64 control representation and do not become fabricated semantic evidence. Edits return bounded acknowledgements; use view to inspect the resulting text. The protected `/memories/_sources` mount exposes bounded original-source inspection and accepts no writes. It follows the owner and workspace scope across virtual namespaces; namespace names alone are not separate privacy principals.

Mutation receipts use the trusted session and tool-use ID plus normalized command hash. Replaying a committed operation cannot duplicate an insertion or resurrect a deleted file. Reusing an ID with different input fails. Receipts retain no original text or result snippets. A new authorized create after deletion gets a new file identity.

Deletion covers this live store and its dependent records. It cannot erase earlier API messages, exported copies or backups. An explicitly shared derived record can be invalidated or removed when its underlying private evidence is corrected or forgotten; that is the same dependency behavior as the local kernel.

## Deliberate boundaries

Paths are case-sensitive virtual keys. Traversal components, backslashes, control characters, percent escapes and paths outside `/memories` are rejected. Repeated and trailing slashes are normalized; canonical root aliases can be viewed but remain protected against writes. The source mount is also protected. The adapter never resolves symlinks or interprets paths as host files.

This delivery supports text only, create-exclusive behavior and implicit directories. Empty directories disappear when their last file leaves; there is no `mkdir`. Hidden names and `node_modules` are omitted from listings but remain addressable by explicit valid paths and included in deletion. Default bounds are 512 files, 32,000 UTF-8 bytes per file, 8 MiB live content, 10,000 control records, 128 listing entries, 16,000 rendered view characters and 65,536 result bytes. Views retain up to 4,096 revision observations. Receipt capacity is finite and requires controller maintenance when exhausted; no automatic pruning weakens replay protection. Results and inventory scans have explicit bounds; exceeding a complete-scan budget fails before mutation.

Native protocol integration does not install hooks, discover chat histories, provide a background scheduler or evaluate Claude's use of the tool. Use the [runtime guide](RUNTIME.md) for explicit capture and job processing, and [provider research](PROVIDER-MEMORY-RESEARCH.md) for the distinction between provider products and this client-owned tool.
