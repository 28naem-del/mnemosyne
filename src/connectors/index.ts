import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MemoryRuntime, parseTranscriptJsonl, type CaptureResult, type CapturedMessage } from '../runtime/index.js';

/** Reads only one explicitly supplied regular file; never discovers host histories. */
export function readLocalText(path: string, maxBytes = 1_048_576): string {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw new Error('Supply a local file path.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 33_554_432) throw new Error('Invalid local file byte limit.');
  const fd = openSync(resolve(path), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('Source must be a regular local file.');
    if (before.size > maxBytes) throw new Error('Local source exceeds its byte limit.');
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Source changed during reading; retry a stable file.');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
  } finally { closeSync(fd); }
}

export interface LocalSourceOptions {
  path: string;
  format: 'text' | 'generic' | 'codex' | 'claude';
  sessionId?: string;
  mimeType?: 'text/plain' | 'text/markdown' | 'application/json';
  trust?: 'untrusted' | 'observed';
  maxBytes?: number;
}
export interface SourceSyncResult extends CaptureResult { changed: boolean; path: string }

/** Manual sync or an explicitly running watch loop; no scheduler or host discovery. */
export class LocalSourceConnector {
  readonly #options: LocalSourceOptions;
  #lastHash?: string;
  constructor(readonly runtime: MemoryRuntime, options: LocalSourceOptions) {
    if (!['text', 'generic', 'codex', 'claude'].includes(options.format)) throw new Error('Use text, generic, codex or claude source format.');
    if (options.trust !== undefined && !['observed', 'untrusted'].includes(options.trust)) throw new Error('Invalid source trust.');
    this.#options = { ...options, path: resolve(options.path) };
  }
  async sync(): Promise<SourceSyncResult> {
    const { path, format, trust = 'untrusted', maxBytes = 1_048_576 } = this.#options;
    if (!this.runtime.captureEnabled) return { enabled: false, records: [], changed: false, path };
    const content = readLocalText(path, maxBytes);
    const fingerprint = createHash('sha256').update(content).digest('hex');
    if (fingerprint === this.#lastHash) return { enabled: true, records: [], changed: false, path };
    let result: CaptureResult;
    if (format === 'text') {
      result = await this.runtime.ingest({ uri: pathToFileURL(path).href, mimeType: this.#options.mimeType ?? 'text/plain', text: content, trust, maxInputBytes: maxBytes });
    } else {
      // Parsing each complete JSONL row preserves the absolute fallback ordinal,
      // including across 256-message batches and a new connector after restart.
      const rows = content.split('\n');
      const complete = [...rows];
      if (!content.endsWith('\n') && rows.at(-1)?.trim()) {
        try { JSON.parse(rows.at(-1)!); } catch { complete.pop(); }
      }
      const messages = complete.flatMap((line, index) => line.trim() ? parseTranscriptJsonl(format, line, { lineOffset: index }) : []);
      const sessionId = this.#options.sessionId ?? `file:${createHash('sha256').update(path).digest('hex')}`;
      result = this.runtime.memory.atomic(() => {
        const records: CaptureResult['records'] = []; let batch: CapturedMessage[] = []; let bytes = 0;
        const flush = () => {
          if (!batch.length) return;
          records.push(...this.runtime.capture({ sessionId, adapter: format, trust, messages: batch }).records);
          batch = []; bytes = 0;
        };
        for (const message of messages) {
          const size = Buffer.byteLength(JSON.stringify(message));
          if (batch.length >= 256 || bytes + size > 900_000) flush();
          batch.push(message); bytes += size;
        }
        flush();
        return { enabled: true, records, ...(messages.length ? { cursor: messages.at(-1)!.id } : {}) };
      });
    }
    this.#lastHash = fingerprint;
    return { ...result, changed: true, path };
  }
  async *watch(options: { intervalMs?: number; signal: AbortSignal }): AsyncGenerator<SourceSyncResult> {
    const intervalMs = options.intervalMs ?? 1000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 60_000) throw new Error('Watch interval must be from 100 to 60000 ms.');
    while (!options.signal.aborted) {
      yield await this.sync();
      if (options.signal.aborted) break;
      await new Promise<void>(done => {
        const finish = () => { clearTimeout(timer); options.signal.removeEventListener('abort', finish); done(); };
        const timer = setTimeout(finish, intervalMs);
        options.signal.addEventListener('abort', finish, { once: true });
        if (options.signal.aborted) finish();
      });
    }
  }
}
