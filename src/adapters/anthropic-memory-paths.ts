/** Pure virtual text/path rules. Never resolve these keys against a host filesystem. */
export class AnthropicMemoryError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'AnthropicMemoryError'; }
}
export function fail(code: string, message: string): never { throw new AnthropicMemoryError(code, message); }
export function scalarText(value: unknown, maximum: number, empty = true): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0') || Buffer.byteLength(value) > maximum || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail('E_INPUT', 'Expected bounded Unicode text.');
  return value;
}
export function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('E_INPUT', 'Expected a plain command object.');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (!('value' in descriptor)) fail('E_INPUT', 'Accessor properties are not allowed.');
  if (Object.getOwnPropertySymbols(value).length) fail('E_INPUT', 'Symbol properties are not allowed.');
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.getOwnPropertyNames(value).some(key => !allowed.includes(key))) fail('E_INPUT', 'Unknown command field.');
}
export function virtualPath(value: unknown, maximum = 1024, depth = 16): string {
  const raw = scalarText(value, maximum, false);
  if (/[\\\x00-\x1f\x7f-\x9f:%]/u.test(raw) || !raw.startsWith('/')) fail('E_PATH', 'Use an absolute virtual /memories path.');
  const parts = raw.split('/').filter(Boolean);
  if (parts[0] !== 'memories' || parts.some(part => part === '.' || part === '..') || parts.length - 1 > depth) fail('E_PATH', 'Path is outside the virtual memory namespace or exceeds its depth limit.');
  return `/${parts.join('/')}`;
}
export const contains = (parent: string, path: string) => path === parent || path.startsWith(`${parent}/`);
export const protectedPath = (path: string) => path === '/memories' || contains('/memories/_sources', path);
export function logicalLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n'); if (text.endsWith('\n')) lines.pop(); return lines;
}
export function insertText(text: string, line: number, insertion: string): string {
  const lines = logicalLines(text);
  if (!Number.isSafeInteger(line) || line < 0 || line > lines.length) fail('E_RANGE', `insert_line must be from 0 to ${lines.length}.`);
  if (!insertion) return text;
  let position = 0;
  for (let index = 0; index < line; index++) { const newline = text.indexOf('\n', position); position = newline < 0 ? text.length : newline + 1; }
  const before = text.slice(0, position), after = text.slice(position);
  return before + (before && !before.endsWith('\n') ? '\n' : '') + insertion + (!insertion.endsWith('\n') && (after || (line === lines.length && text.endsWith('\n'))) ? '\n' : '') + after;
}
export function replaceText(text: string, oldText: string, replacement: string): string {
  if (!oldText) fail('E_MATCH', 'old_str must not be empty.');
  const first = text.indexOf(oldText);
  if (first < 0) fail('E_MATCH', 'old_str was not found.');
  if (text.indexOf(oldText, first + 1) >= 0) fail('E_AMBIGUOUS', 'old_str occurs more than once; view and choose a unique literal.');
  return text.slice(0, first) + replacement + text.slice(first + oldText.length);
}
export function renderText(path: string, text: string, header: string, maximum: number, range?: [number, number]): string {
  const lines = logicalLines(text), start = range?.[0] ?? 1, end = range?.[1] ?? -1;
  if (range && start > lines.length) fail('E_RANGE', `The file has ${lines.length} logical lines.`);
  const limit = end === -1 ? lines.length : Math.min(end, lines.length);
  let result = `${path}\n${header}\n`;
  const reserve = 110;
  for (let index = start - 1; index < limit; index++) {
    const line = `${String(index + 1).padStart(6)}\t${lines[index]}\n`;
    if (result.length + line.length + reserve > maximum) {
      if (index === start - 1) fail('E_LIMIT', 'A single rendered line exceeds the view budget; use a larger controller budget or shorter text.');
      return `${result}[Truncated; next unread line: ${index + 1}. Use view_range [${index + 1}, -1].]`;
    }
    result += line;
  }
  if (result.length > maximum) fail('E_LIMIT', 'The view header exceeds the result budget.');
  return result;
}
