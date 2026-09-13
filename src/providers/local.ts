import { isAbsolute } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { MemoryEmbedder, MemoryReranker } from '../local/index.js';
import { LOCAL_EMBEDDING_ID, LOCAL_EMBEDDING_SPEC, LOCAL_RERANKER_ID } from './local-model-spec.js';
export { LOCAL_EMBEDDING_SPEC, LOCAL_RERANKER_SPEC, LOCAL_MODEL_RUNTIME } from './local-model-spec.js';

export interface LocalModelOptions {
  /** Explicit model cache location. Existing cached models work without network access. */
  cacheDir: string;
  /** Downloads only the pinned public model artifacts; source text stays in the CPU worker. Default false. */
  allowDownload?: boolean;
  startupTimeoutMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface LocalEmbedder extends MemoryEmbedder { dispose(): Promise<void> }
export interface LocalReranker extends MemoryReranker { readonly model: string; dispose(): Promise<void> }
const optionsSchema = z.object({
  cacheDir: z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes('\0'), 'cacheDir must be an absolute path'),
  allowDownload: z.boolean().default(false), startupTimeoutMs: z.number().int().min(1).max(600000).default(120000),
  timeoutMs: z.number().int().min(1).max(600000).default(30000), signal: z.instanceof(AbortSignal).optional(),
}).strict();
const textSchema = z.string().refine(text => !!text.trim() && !text.includes('\0') && Buffer.byteLength(text) <= 65536, 'Model text is empty, invalid or exceeds 65536 bytes');

class LocalInference {
  readonly worker: ChildProcess;
  #closed = false;
  #busy = false;
  #sequence = 0;
  #stop?: (error: Error) => void;
  readonly timeoutMs: number;
  constructor(kind: 'embed' | 'rerank', options: z.output<typeof optionsSchema>) {
    this.timeoutMs = options.timeoutMs;
    this.worker = fork(new URL('./local-model-worker.js', import.meta.url), [JSON.stringify({ kind, cacheDir: options.cacheDir, allowDownload: options.allowDownload })], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced', execArgv: ['--max-old-space-size=512'],
    });
    this.worker.stderr?.on('data', () => {}); // Drain native diagnostics without forwarding model/source text.
    this.worker.on('error', cause => { this.#closed = true; this.#stop?.(cause instanceof Error ? cause : new Error('Local model worker failed')); });
    this.worker.on('exit', (code, signal) => { this.#closed = true; this.#stop?.(new Error(`Local model process exited (${signal ?? code})`)); });
  }
  async wait(startupMs: number, signal?: AbortSignal): Promise<void> { await this.#exchange(undefined, startupMs, signal); }
  async request(texts: string[], query?: string, signal?: AbortSignal): Promise<unknown> {
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > 100) throw new Error('Local inference requires 1 to 100 texts');
    texts.forEach(text => textSchema.parse(text));
    if (texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0) > 1_048_576) throw new Error('Local inference batch exceeds 1 MiB');
    if (query !== undefined) textSchema.parse(query);
    return this.#exchange({ id: ++this.#sequence, texts: [...texts], ...(query !== undefined ? { query } : {}) }, this.timeoutMs, signal);
  }
  async #exchange(request: { id: number; texts: string[]; query?: string } | undefined, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
    if (this.#closed) throw new Error('Local model is disposed; create a new provider');
    if (this.#busy) throw new Error('Local model is busy; await the previous operation');
    if (signal?.aborted) { await this.dispose(); throw new Error('Local model cancelled'); }
    this.#busy = true;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, values?: unknown) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); this.worker.off('message', message);
        this.#stop = undefined; this.#busy = false;
        if (error) { void this.dispose(); reject(error); } else resolve(values);
      };
      const abort = () => finish(new Error('Local model cancelled'));
      const timer = setTimeout(() => finish(new Error('Local model deadline exceeded; worker terminated')), timeoutMs);
      const message = (value: unknown) => {
        if (!value || typeof value !== 'object') { finish(new Error('Invalid local model response')); return; }
        const data = value as { id?: number; ready?: boolean; error?: string; values?: unknown };
        if (typeof data.error === 'string') { finish(new Error(data.error)); return; }
        if (request ? data.id !== request.id : data.ready !== true) { finish(new Error('Unexpected local model response')); return; }
        finish(undefined, data.values);
      };
      this.#stop = error => finish(error);
      this.worker.on('message', message); signal?.addEventListener('abort', abort, { once: true });
      if (request) {
        try { this.worker.send(request, error => { if (error) finish(new Error('Local model IPC failed')); }); }
        catch { finish(new Error('Local model IPC failed')); }
      }
    });
  }
  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true; this.#stop?.(new Error('Local model disposed'));
    await new Promise<void>(resolve => {
      this.worker.once('exit', () => resolve());
      if (!this.worker.kill('SIGKILL')) resolve();
    });
  }
}
async function start(kind: 'embed' | 'rerank', input: LocalModelOptions): Promise<LocalInference> {
  const options = optionsSchema.parse(input);
  if (options.signal?.aborted) throw new Error('Local model cancelled');
  const inference = new LocalInference(kind, options);
  await inference.wait(options.startupTimeoutMs, options.signal);
  return inference;
}
/** Explicit optional CPU inference; constructing LocalMemory never loads or downloads a model. */
export async function createLocalEmbedder(options: LocalModelOptions): Promise<LocalEmbedder> {
  const inference = await start('embed', options);
  return Object.freeze({ model: LOCAL_EMBEDDING_ID, dimensions: LOCAL_EMBEDDING_SPEC.dimensions,
    async embed(texts: string[], call?: { signal?: AbortSignal }) {
      const values = await inference.request(texts, undefined, call?.signal);
      return z.array(z.array(z.number().finite()).length(LOCAL_EMBEDDING_SPEC.dimensions)).length(texts.length).parse(values);
    }, dispose: () => inference.dispose() });
}
/** Reranks every supplied candidate; long documents use the maximum score across complete model windows. */
export async function createLocalReranker(options: LocalModelOptions): Promise<LocalReranker> {
  const inference = await start('rerank', options);
  return Object.freeze({ model: LOCAL_RERANKER_ID,
    async rerank(query: string, candidates: Parameters<MemoryReranker['rerank']>[1], call?: { signal?: AbortSignal }) {
      if (!candidates.length) return [];
      const scores = z.array(z.number().finite()).length(candidates.length).parse(await inference.request(candidates.map(item => item.text), query, call?.signal));
      return candidates.map((item, index) => {
        const logit = scores[index], exp = Math.exp(logit < 0 ? logit : -logit);
        // The kernel accepts [0,1]; this monotonic transform is not a calibrated probability.
        return { id: item.id, score: logit < 0 ? exp / (1 + exp) : 1 / (1 + exp) };
      });
    }, dispose: () => inference.dispose() });
}
