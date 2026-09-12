/** Native command integration without an SDK install, network or model call. */
import { createLocalMemory } from '../dist/local/index.js';
import { MemoryRuntime } from '../dist/runtime/index.js';
import { createAnthropicMemoryAdapter } from '../dist/adapters/index.js';

const memory = createLocalMemory({ path: ':memory:', workspaceId: 'native-example', agentId: 'assistant' });
const runtime = new MemoryRuntime(memory);
const adapter = createAnthropicMemoryAdapter({ memory, runtime, namespace: 'example',
  // The host grants these permissions; model input cannot change them.
  policy: () => ({ recallEnabled: true, captureEnabled: true, readOnly: false, allowDestructive: true }),
});
const context = { sessionId: 'example-session' };
function execute(id: string, input: unknown) {
  const result = adapter.handleToolUse({ type: 'tool_use', id, name: 'memory', input }, context);
  if (result.is_error) throw new Error(result.content);
  return result;
}
try {
  execute('create-1', { command: 'create', path: '/memories/project.md', file_text: 'Atlas releases on Tuesday.' });
  execute('view-1', { command: 'view', path: '/memories/project.md' });
  execute('replace-1', { command: 'str_replace', path: '/memories/project.md', old_str: 'Tuesday', new_str: 'Thursday' });
  const revised = execute('view-2', { command: 'view', path: '/memories/project.md' });
  if (!revised.content.includes('Thursday')) throw new Error('The native edit was not visible.');
  // Identical trusted tool-use IDs replay the receipt without applying twice.
  const replay = execute('replace-1', { command: 'str_replace', path: '/memories/project.md', old_str: 'Tuesday', new_str: 'Thursday' });
  execute('delete-1', { command: 'delete', path: '/memories/project.md' });
  const absent = adapter.handleToolUse({ type: 'tool_use', id: 'view-3', name: 'memory', input: { command: 'view', path: '/memories/project.md' } }, context);
  if (!absent.is_error) throw new Error('The deleted file is still readable.');
  console.log(JSON.stringify({ kind: 'native memory command integration', tool: adapter.definition,
    externalModelCalls: 0, revised: revised.content, replay: replay.content, deletionVerified: absent.is_error }, null, 2));
} finally { memory.close(); }
