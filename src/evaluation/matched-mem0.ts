import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryEmbedder } from '../local/index.js';
import { assertMatchedSystemId, type MatchedResolution, type MatchedSession, type MatchedSystem, type MatchedSystemFactory } from './matched-types.js';

/**
 * Mem0 OSS as a matched-run system.
 *
 * This adapts the open-source `mem0ai/oss` client — the self-hosted `Memory`
 * class — and never the paid Mem0 Platform client. The two are different
 * products with different retrieval stacks, so a Platform number would not
 * belong in the same table.
 *
 * Three deliberate choices, all of which are stated in the printed mode label
 * because each one changes what the number means:
 *
 * 1. **The embedder is injected, not Mem0's default.** Mem0 defaults to OpenAI
 *    `text-embedding-3-small`. Running it that way against our bundled
 *    `bge-small-en-v1.5` would measure two embedding models, not two memory
 *    systems. Mem0's `langchain` embedder provider accepts any object exposing
 *    `embedQuery`/`embedDocuments`, so the matched run hands Mem0 the *same*
 *    embedder object it hands its own hybrid condition: identical vectors for
 *    identical text, leaving the memory architecture as the only difference.
 *    `--mem0-embedder openai` opts back into Mem0's own default and relabels.
 * 2. **`extraction: 'off'` is the default** (`infer: false`), which stores each
 *    chunk verbatim and calls no LLM at all. That makes the default matched run
 *    free, offline and deterministic. It is *not* Mem0's headline configuration,
 *    and the label says so; `extraction: 'llm'` runs Mem0's real
 *    ADD/UPDATE/DELETE fact-extraction path and costs money.
 * 3. **The LLM is wired fail-closed.** Mem0 constructs an LLM eagerly even when
 *    nothing will call it. Rather than leave a live OpenAI client in the object
 *    graph of a run advertised as offline, the default adapter installs a stub
 *    whose `invoke` throws. If any code path ever reaches an LLM during an
 *    `extraction: 'off'` run, the run fails loudly instead of quietly billing a
 *    key and reporting a number from a different configuration.
 *
 * Mem0's `memory` vector store is SQLite-backed and defaults to a shared file in
 * the user's home directory, so two corpora scored in one process would see each
 * other's passages. Every session gets its own temporary directory, removed on
 * close. `tests/matched-mem0.test.ts` pins that isolation.
 */

/** Minimal structural view of the parts of `mem0ai/oss` this adapter drives. */
interface Mem0MemoryItem { id?: string; memory?: string; score?: number; metadata?: Record<string, unknown> | null }
interface Mem0SearchResult { results?: Mem0MemoryItem[] }
interface Mem0Memory {
  add(messages: string, config: Record<string, unknown>): Promise<Mem0SearchResult>;
  search(query: string, config: Record<string, unknown>): Promise<Mem0SearchResult>;
  delete(memoryId: string): Promise<unknown>;
}
interface Mem0Module { Memory: new (config: Record<string, unknown>) => Mem0Memory }

export interface Mem0AdapterOptions {
  /** The document-side embedder the matched run gives every system. */
  embedder?: MemoryEmbedder;
  /** The query-side embedder, for asymmetric models. Defaults to `embedder`. */
  queryEmbedder?: MemoryEmbedder;
  /**
   * `off` stores each chunk verbatim with no model in the write path.
   * `llm` runs Mem0's real fact-extraction and ADD/UPDATE/DELETE reconciliation,
   * which calls the configured LLM once or twice per chunk and costs money.
   */
  extraction?: 'off' | 'llm';
  /** Passed through to Mem0's LLM factory when `extraction` is `llm`. */
  llm?: { provider: string; config: Record<string, unknown>; label: string };
  /** Passed through to Mem0's embedder factory instead of injecting ours. */
  embedderProvider?: { provider: string; config: Record<string, unknown>; label: string; dimension: number };
  /** Overridden only by tests, which substitute a fake module. */
  moduleSpecifier?: string;
  /** Where to read the adapted package's version from. Tests override it. */
  versionSpecifier?: string;
  /** Parent directory for the per-session SQLite files. Defaults to the OS temp dir. */
  dataDir?: string;
  /**
   * Ranked hits requested from Mem0 per query, as a multiple of the scored limit.
   * Extraction can map several memories onto one source chunk; without the
   * overfetch, de-duplicating those would hand Mem0 fewer distinct passages than
   * every other system is allowed. Disclosed in the mode label.
   */
  overfetch?: number;
}

const CHUNK_KEY = 'matched_chunk_id';

/** Mem0's `langchain` embedder provider duck-types on these two methods only. */
function langchainEmbedder(documents: MemoryEmbedder, queries: MemoryEmbedder, timeoutMs: number) {
  return {
    async embedQuery(text: string): Promise<number[]> {
      const [vector] = await queries.embed([text], { signal: AbortSignal.timeout(timeoutMs) });
      return [...vector];
    },
    async embedDocuments(texts: string[]): Promise<number[][]> {
      const vectors = await documents.embed([...texts], { signal: AbortSignal.timeout(timeoutMs) });
      return vectors.map(vector => [...vector]);
    },
  };
}

class FailClosedLlmError extends Error {}

/** Fails a nominally offline run loudly rather than letting it reach a model. */
function failClosedLlm(): { model: string; invoke(): never } {
  return { model: 'fail-closed', invoke(): never {
    throw new FailClosedLlmError('Mem0 reached an LLM during an extraction:off matched run. The run is void, not degraded.');
  } };
}

export function createMem0Factory(options: Mem0AdapterOptions = {}): MatchedSystemFactory {
  const specifier = options.moduleSpecifier ?? 'mem0ai/oss';
  const extraction = options.extraction ?? 'off';
  if (extraction !== 'off' && extraction !== 'llm') throw new Error('Invalid Mem0 extraction mode.');
  if (extraction === 'llm' && !options.llm) throw new Error('Mem0 extraction:llm requires an explicit llm configuration.');
  const overfetch = options.overfetch ?? (extraction === 'llm' ? 4 : 1);
  if (!Number.isSafeInteger(overfetch) || overfetch < 1 || overfetch > 20) throw new Error('Invalid Mem0 overfetch.');

  return {
    id: 'mem0-oss',
    describe: () => `Mem0 OSS (npm ${specifier}); self-hosted Memory class, not the paid Platform client. `
      + 'Install with `npm run benchmark:matched:install`. No account or key is needed in extraction:off mode.',
    async resolve(): Promise<MatchedResolution> {
      let module: Mem0Module, revision = 'unknown';
      try {
        module = await import(/* @vite-ignore */ specifier) as Mem0Module;
      } catch (error) {
        return { available: false, reason: `mem0ai is not installed (import "${specifier}" failed: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}). `
          + 'Run `npm run benchmark:matched:install` to install the pinned competitor SDKs.' };
      }
      if (typeof module?.Memory !== 'function') return { available: false, reason: `"${specifier}" does not export a Memory class; the installed mem0ai is not the OSS client.` };
      // Resolved through a non-literal specifier: the competitor SDK is deliberately
      // not a dependency of this package, so its manifest must not become a
      // compile-time import the type checker has to resolve.
      const manifest: string = options.versionSpecifier ?? `${specifier.split('/')[0]}/package.json`;
      try {
        const meta = await import(manifest, { with: { type: 'json' } }) as { default?: { version?: string } };
        if (typeof meta?.default?.version === 'string') revision = meta.default.version;
      } catch { /* version is a label, not a gate */ }

      const injected = options.embedderProvider;
      if (!injected && !options.embedder) return { available: false, reason: 'Mem0 needs either an injected embedder or an explicit embedderProvider.' };
      const documents = options.embedder, queries = options.queryEmbedder ?? options.embedder;
      const dimension = injected ? injected.dimension : documents!.dimensions;
      const embedderLabel = injected ? injected.label : `injected:${documents!.model}`;
      const llmLabel = extraction === 'llm' ? options.llm!.label : 'none(fail-closed)';
      const dataRoot = options.dataDir ?? tmpdir();

      const system: MatchedSystem = {
        id: assertMatchedSystemId('mem0-oss'),
        revision,
        mode: `mem0-oss@${revision}, extraction=${extraction === 'off' ? 'off(infer:false)' : `llm(${llmLabel})`}, `
          + `retrieval=vector-cosine(exact), vectorStore=memory(sqlite,isolated), embedder=${embedderLabel}, `
          + `history=disabled, telemetry=disabled, overfetch=${overfetch}x`,
        async create(request): Promise<MatchedSession> {
          // Mem0 OSS ships PostHog telemetry on by default. A benchmark must not
          // emit events about a corpus run to a third party, and an "offline"
          // claim has to be true, so this is set before the client is built.
          process.env.MEM0_TELEMETRY = 'false';
          const directory = mkdtempSync(join(dataRoot, 'mnemosyne-matched-mem0-'));
          const client = new module.Memory({
            version: 'v1.1',
            embedder: injected ? { provider: injected.provider, config: injected.config }
              : { provider: 'langchain', config: { model: langchainEmbedder(documents!, queries!, 120_000) } },
            vectorStore: { provider: 'memory', config: { collectionName: `matched_${request.seed}`, dimension, dbPath: join(directory, 'vector_store.db') } },
            llm: extraction === 'llm' ? { provider: options.llm!.provider, config: options.llm!.config }
              : { provider: 'langchain', config: { model: failClosedLlm() } },
            // Mem0's history store is a second SQLite file recording every
            // ADD/UPDATE/DELETE. Nothing here reads it, and writing it would
            // charge Mem0 ingestion time for an audit trail the matched run
            // never scores.
            disableHistory: true,
          });
          const user = `matched-${request.corpusId}`;
          let closed = false;
          // chunk identity -> the Mem0 memory ids derived from it. Extraction can
          // turn one chunk into several memories or none, so this is a set per
          // chunk rather than a single id.
          const byChunk = new Map<string, Set<string>>();

          return {
            async ingest(chunks, operation): Promise<void> {
              for (const chunk of chunks) {
                operation.signal.throwIfAborted();
                // One add() per chunk: the metadata that carries the chunk
                // identity is per-call, so batching would make every memory in a
                // batch indistinguishable and unscoreable.
                const written = await client.add(chunk.speaker ? `${chunk.speaker}: ${chunk.text}` : chunk.text, {
                  userId: user, metadata: { [CHUNK_KEY]: chunk.id }, infer: extraction === 'llm',
                });
                const ids = new Set((written.results ?? []).flatMap(item => typeof item.id === 'string' ? [item.id] : []));
                byChunk.set(chunk.id, ids);
              }
            },
            async forget(ids, operation): Promise<void> {
              for (const id of ids) {
                operation.signal.throwIfAborted();
                for (const memoryId of byChunk.get(id) ?? []) await client.delete(memoryId);
                byChunk.delete(id);
              }
            },
            async retrieve({ query, limit, signal }): Promise<string[]> {
              signal.throwIfAborted();
              const found = await client.search(query, { filters: { user_id: user }, topK: limit * overfetch });
              const ranked: string[] = [];
              for (const hit of found.results ?? []) {
                const id = hit.metadata?.[CHUNK_KEY];
                // A memory with no chunk identity is one Mem0 created without
                // provenance back to a source passage. It cannot be scored, so it
                // is skipped rather than guessed at.
                if (typeof id !== 'string' || !byChunk.has(id) || ranked.includes(id)) continue;
                ranked.push(id);
                if (ranked.length >= limit) break;
              }
              return ranked;
            },
            async close(): Promise<void> {
              if (closed) return;
              closed = true;
              rmSync(directory, { recursive: true, force: true });
            },
          };
        },
      };
      return { available: true, system };
    },
  };
}
