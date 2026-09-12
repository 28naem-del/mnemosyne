import { createHash } from 'node:crypto';
import type { CapturedMessage } from './types.js';

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap(block => {
    if (!block || typeof block !== 'object') return [];
    const value = block as Record<string, unknown>;
    // Deliberately exclude thinking/reasoning, tool payloads and image bytes.
    return ['text', 'input_text', 'output_text'].includes(String(value.type)) && typeof value.text === 'string' ? [value.text] : [];
  }).join('\n');
}

/** Parses only caller-supplied bytes. Never discovers histories or reads host files. */
export function parseTranscriptJsonl(adapter: 'generic' | 'codex' | 'claude', jsonl: string, options: { lineOffset?: number } = {}): CapturedMessage[] {
  const lineOffset = options.lineOffset ?? 0;
  if (!Number.isSafeInteger(lineOffset) || lineOffset < 0 || lineOffset > 1_000_000) throw new Error('Invalid transcript line offset.');
  if (!['generic', 'codex', 'claude'].includes(adapter)) throw new Error('Unsupported transcript adapter.');
  if (typeof jsonl !== 'string' || Buffer.byteLength(jsonl) > 1_048_576 || jsonl.includes('\0')) throw new Error('Transcript must be at most 1 MiB of JSONL.');
  const messages: CapturedMessage[] = [];
  for (const [index, line] of jsonl.split('\n').entries()) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      row = value as Record<string, unknown>;
    } catch { throw new Error(`Invalid transcript JSON at line ${index + 1}.`); }
    let role: unknown;
    let text = '';
    let id: unknown;
    if (adapter === 'generic') {
      role = row.role; text = contentText(row.text ?? row.content); id = row.id;
    } else if (adapter === 'claude') {
      if (!['user', 'assistant'].includes(String(row.type)) || !row.message || typeof row.message !== 'object') continue;
      const message = row.message as Record<string, unknown>;
      role = message.role ?? row.type; text = contentText(message.content); id = row.uuid ?? message.id;
    } else {
      // Codex response_item is the canonical visible-message stream. Ignore
      // event_msg duplicates, reasoning items, metadata and tool calls.
      if (row.type !== 'response_item' || !row.payload || typeof row.payload !== 'object') continue;
      const payload = row.payload as Record<string, unknown>;
      if (payload.type !== 'message') continue;
      if (payload.channel != null && !['final', 'commentary'].includes(String(payload.channel))) continue;
      if (payload.recipient != null && payload.recipient !== 'all') continue;
      if (!['user', 'assistant', 'system'].includes(String(payload.role))) continue;
      role = payload.role; text = contentText(payload.content); id = payload.id ?? row.id;
    }
    if (!['user', 'assistant', 'system', 'tool'].includes(String(role)) || !text.trim()) continue;
    if (messages.length >= 256) throw new Error('A transcript batch supports at most 256 visible messages.');
    // A supplied host ID is preferred. The stable line ordinal plus content
    // hash makes replay of an append-only JSONL source safe without guessing.
    const stableId = typeof id === 'string' && id.trim() ? id : `${lineOffset + index + 1}:${createHash('sha256').update(line).digest('hex')}`;
    messages.push({ id: stableId, role: role as CapturedMessage['role'], text, ...(typeof row.timestamp === 'string' ? { timestamp: row.timestamp } : {}) });
  }
  return messages;
}
