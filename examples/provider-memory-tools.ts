/** Synthetic provider envelopes over real SQLite. No SDK, network or model calls. */
import { createLocalMemory } from '../dist/local/index.js';
import { MemoryRuntime } from '../dist/runtime/index.js';
import { createAnthropicMemoryAdapter, createProviderMemoryTools } from '../dist/adapters/index.js';

const memory = createLocalMemory({ path: ':memory:', workspaceId: 'provider-example', agentId: 'assistant' });
const engine = createAnthropicMemoryAdapter({ memory, runtime: new MemoryRuntime(memory),
  namespace: 'fresh-shared-provider-notes', captureAdapter: 'generic',
});
const tools = createProviderMemoryTools({ engine });
const context = { sessionId: 'stable-example-session' };
const maximumCallsPerStep = 32;

function assertSuccess(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== true) {
    throw new Error('A fixture memory command failed.');
  }
}
function assertFailure(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== false) {
    throw new Error('The expected fixture error was lost.');
  }
}

try {
  // These distinct IDs demonstrate which identity a Responses tool result echoes.
  const response = { id: 'resp_fixture', status: 'completed', output: [
    { type: 'reasoning', id: 'rs_fixture', summary: [] },
    { type: 'function_call', id: 'fc_fixture', call_id: 'call_create', status: 'completed',
      name: 'memory_create', arguments: JSON.stringify({ path: '/memories/project.md', file_text: 'Atlas releases on Tuesday.' }) },
    { type: 'function_call', id: 'fc_missing', call_id: 'call_missing', status: 'completed',
      name: 'memory_view', arguments: JSON.stringify({ path: '/memories/missing.md', view_range: null }) },
  ] };
  if (response.status !== 'completed') throw new Error('Wait for the complete response before dispatch.');
  const openAIHistory: unknown[] = [...response.output]; // Preserve reasoning and every original output item.
  const calls = response.output.filter(item => item.type === 'function_call');
  if (calls.length > maximumCallsPerStep) throw new Error('Too many calls in one step.');
  const openAIOutputs = [];
  for (const call of calls) {
    const output = tools.handleOpenAIResponsesCall(call, context);
    if (!output) throw new Error('Route non-memory calls to the host tool dispatcher.');
    if (output.call_id !== call.call_id) throw new Error('The item ID replaced the call ID.');
    openAIOutputs.push(output);
    openAIHistory.push(output);
  }
  // Check this fixture only after every result, including errors, is retained.
  assertSuccess(JSON.parse(openAIOutputs[0].output));
  assertFailure(JSON.parse(openAIOutputs[1].output));

  type FixturePart = { text?: string; thoughtSignature?: string;
    functionCall?: { id?: string; name: string; args: Record<string, unknown> } };
  type FixtureContent = { role: 'model'; parts: FixturePart[]; fixtureMetadata?: string };
  const geminiHistory: unknown[] = [];
  function handleSelectedGeminiContent(content: FixtureContent, recordedTurnKey: string) {
    // The host selected this one complete candidate. Alternative candidates are not dispatched.
    const selected = content.parts.map((part, index) => ({ part, index })).filter(entry => entry.part.functionCall);
    if (selected.length > maximumCallsPerStep) throw new Error('Too many calls in one step.');
    geminiHistory.push(content); // Keep ALL parts, opaque metadata and thought signatures unchanged.
    if (!selected.length) return []; // A final text response needs no empty tool-result turn.
    const parts = selected.map(({ part, index }) => {
      // A persisted turn/candidate/part identity protects retries when Gemini omits a call ID.
      const output = tools.handleGeminiFunctionCall(part.functionCall, { ...context,
        operationId: `${recordedTurnKey}:candidate-0:part-${index}` });
      if (!output) throw new Error('Route non-memory calls to the host tool dispatcher.');
      return output;
    });
    geminiHistory.push({ role: 'user', parts });
    return parts;
  }

  const viewed: FixtureContent = { role: 'model', fixtureMetadata: 'preserve-me', parts: [
    { text: 'Inspect the project note.', thoughtSignature: 'Zml4dHVyZQ==' },
    { functionCall: { id: 'gem_view', name: 'memory_view', args: { path: '/memories/project.md' } } },
    { functionCall: { id: 'gem_missing', name: 'memory_view', args: { path: '/memories/missing.md' } } },
  ] };
  const viewedResults = handleSelectedGeminiContent(viewed, 'generation-view');
  assertSuccess(viewedResults[0].functionResponse.response);
  assertFailure(viewedResults[1].functionResponse.response);
  const edited: FixtureContent = { role: 'model', parts: [
    { functionCall: { name: 'memory_str_replace', args: { path: '/memories/project.md', old_str: 'Tuesday', new_str: 'Thursday' } },
      thoughtSignature: 'c2Vjb25kLWZpeHR1cmU=' },
  ] };
  const editedResults = handleSelectedGeminiContent(edited, 'generation-edit');
  assertSuccess(editedResults[0].functionResponse.response);
  const finalContent: FixtureContent = { role: 'model', parts: [{ text: 'The project note is updated.' }] };
  if (handleSelectedGeminiContent(finalContent, 'generation-final').length || geminiHistory.length !== 5 || geminiHistory[4] !== finalContent) {
    throw new Error('A final text response generated an empty tool-result turn.');
  }
  if (geminiHistory[0] !== viewed || geminiHistory[2] !== edited || openAIHistory[0] !== response.output[0]) {
    throw new Error('Original provider history was rebuilt or dropped.');
  }

  const native = engine.handleToolUse({ type: 'tool_use', id: 'claude_view', name: 'memory',
    input: { command: 'view', path: '/memories/project.md' } }, context);
  if (native.is_error || !native.content.includes('Thursday')) throw new Error('The shared native view missed the edit.');
  const sources = memory.list({ includeInactive: true, includeUntrusted: true, metadata: { runtimeType: 'source' } }).items;
  if (!sources.length || sources.some(source => source.metadata.adapter !== 'generic' || source.trust !== 'untrusted')) {
    throw new Error('Provider-neutral writes acquired incorrect provenance.');
  }
  console.log(JSON.stringify({ kind: 'synthetic provider protocol integration', externalModelCalls: 0,
    responsesTools: tools.openAIResponsesTools.length, geminiToolGroups: tools.geminiGenerateContentTools.length,
    preservedOpenAIItems: openAIHistory.length, preservedGeminiContents: geminiHistory.length,
    sharedRevisionVisible: true, captureAdapter: engine.captureAdapter }, null, 2));
} finally { memory.close(); }
