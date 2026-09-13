import { z } from 'zod';
import type { CapturedMessage } from '../runtime/index.js';
import type { AgentEventInput } from './types.js';

const id = z.string().min(1).max(160).refine(value => !!value.trim() && !value.includes('\0'));
const visible = z.string().min(1).refine(value => !!value.trim() && !value.includes('\0') && Buffer.byteLength(value) <= 65_536);
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Converts only supplied completed SDK messages. No hook installation or history discovery. */
export function messagesFromAgentEvents(input: AgentEventInput): CapturedMessage[] {
  try {
    id.parse(input.sessionId);
    if (!['codex', 'claude'].includes(input.adapter) || !Array.isArray(input.events) || input.events.length > 256) throw new Error();
    const messages: CapturedMessage[] = [];
    let bytes = 0;
    for (const event of input.events) {
      const row = object(event); if (!row) throw new Error();
      if (input.adapter === 'codex') {
        if (row.type === 'thread.started' && row.thread_id !== input.sessionId) throw new Error();
        if (row.type !== 'item.completed') continue;
        const item = object(row.item); if (!item) throw new Error();
        if (item.type !== 'agent_message') continue;
        messages.push({ id: id.parse(item.id), role: 'assistant', text: visible.parse(item.text) });
      } else {
        if (!['user', 'assistant'].includes(String(row.type))) continue;
        // Stream deltas, tool results, synthetic prompts and subagent messages are not visible user turns.
        if (row.isSynthetic === true || row.error != null || row.tool_use_result != null || row.parent_tool_use_id != null) continue;
        if (row.session_id !== input.sessionId) throw new Error();
        const message = object(row.message); if (!message) throw new Error();
        const role = row.type as 'user' | 'assistant';
        if (message.role != null && message.role !== role) throw new Error();
        let text: string;
        if (typeof message.content === 'string') text = message.content;
        else if (Array.isArray(message.content)) {
          if (message.content.length > 256) throw new Error();
          // Concatenate text blocks verbatim; never include thinking, tool or image data.
          text = message.content.flatMap(block => { const value = object(block); return value?.type === 'text' ? [visible.parse(value.text)] : []; }).join('');
        } else throw new Error();
        if (!text.trim()) continue;
        messages.push({ id: id.parse(row.uuid), role, text: visible.parse(text) });
      }
      if (messages.length) bytes = messages.reduce((size, message) => size + Buffer.byteLength(message.text), 0);
      if (bytes > 1_048_576) throw new Error();
    }
    return messages;
  } catch { throw new Error('Invalid or oversized agent event envelope; visible messages require stable IDs and matching session scope.'); }
}
