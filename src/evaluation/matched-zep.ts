import { assertMatchedSystemId, type MatchedResolution, type MatchedSession, type MatchedSystem, type MatchedSystemFactory } from './matched-types.js';
import { resolveCompetitorModule } from './matched-resolve.js';

/**
 * Zep as a matched-run system.
 *
 * Zep is the one competitor in this table that cannot be made to run for free,
 * and the reason is worth stating precisely because "we didn't benchmark Zep" is
 * otherwise indistinguishable from "we didn't try".
 *
 * - `@getzep/zep-cloud` speaks only to Zep's hosted API. Calls without a key, and
 *   with a bogus key, both return HTTP 401. An account and a `ZEP_API_KEY` are
 *   required, and no key is provisioned here.
 * - Zep Community Edition — the self-hostable server the older `@getzep/zep-js`
 *   client targeted — is deprecated and moved to `legacy/` upstream, and its own
 *   compose file references `zepai/zep:latest`, which no longer exists on Docker
 *   Hub. There is no free self-hosted path to fall back to.
 *
 * So the adapter is written in full against the SDK's actual surface, exercised
 * by `tests/matched-systems.test.ts` against a client implementing that same
 * surface, and **fails closed**: with no key it returns a reason string, which
 * the published table prints in the cell where a score would otherwise be. It
 * never falls back to a different retrieval path, never degrades quietly, and
 * above all never reprints a number Zep published about itself.
 *
 * **Why the graph API and not the thread API.** Zep exposes two ingestion
 * surfaces. `thread.addMessages` + `thread.getUserContext` returns a synthesized
 * context *block* — prose Zep assembled — which cannot be mapped back to the
 * source passages the evidence labels identify, so it cannot be scored on the
 * same footing as every other row. `graph.add` + `graph.search({ scope:
 * 'episodes' })` returns *ranked episodes* carrying the `sourceDescription` and
 * `metadata` supplied at ingestion, which is exactly the ranked list of source
 * identities this harness scores. Scoring the context block instead would be a
 * different measurement wearing the same column heading.
 */

/** The part of `@getzep/zep-cloud`'s surface this adapter drives, as declared by its typings. */
export interface ZepLikeClient {
  user: {
    add(request: { userId: string }): Promise<unknown>;
    delete(userId: string): Promise<unknown>;
  };
  graph: {
    add(request: { userId: string; type: 'text'; data: string; sourceDescription?: string; metadata?: Record<string, unknown> }): Promise<ZepEpisode>;
    search(request: { userId: string; query: string; limit: number; scope: 'episodes' }): Promise<ZepSearchResponse>;
    episode: {
      getByUserId(userId: string, request: { lastn: number }): Promise<{ episodes?: ZepEpisode[] }>;
      delete(uuid: string): Promise<unknown>;
    };
  };
}
export interface ZepEpisode { uuid?: string; content?: string; processed?: boolean; score?: number; sourceDescription?: string; metadata?: Record<string, unknown> | null }
export interface ZepSearchResponse { episodes?: ZepEpisode[]; context?: string }

export interface ZepAdapterOptions {
  /** Where `@getzep/zep-cloud` is installed. */
  baseDir: string;
  /** Injected by tests. When present, no SDK or key is required. */
  client?: ZepLikeClient;
  /** Name of the environment variable holding the key. The value is never logged. */
  apiKeyEnv?: string;
  /** Self-hosted base URL, for a Zep server that is not the hosted cloud. */
  baseUrl?: string;
  /** Bounded wait for Zep's asynchronous episode processing, in milliseconds. */
  ingestSettleMs?: number;
  /** Injected by tests so the settle loop does not actually sleep. */
  sleep?(ms: number): Promise<void>;
}

const KEY_ENV = 'ZEP_API_KEY';
const CHUNK_KEY = 'matched_chunk_id';
const REQUIREMENT = 'a Zep Cloud account and a ZEP_API_KEY. Zep Community Edition, the self-hostable server, is deprecated upstream '
  + 'and its own compose file points at zepai/zep:latest, which no longer exists on Docker Hub, so there is no free self-hosted path. '
  + 'Graphiti, the engine underneath Zep, additionally needs a graph store and a generative LLM for episode ingestion.';

/** Ingestion-time identity, carried in the one field that survives extraction unmodified. */
const MARK = 'matched-chunk';
const marker = (id: string): string => `${MARK}[${id}]`;
const unmark = (value: string | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const open = value.indexOf(`${MARK}[`);
  if (open < 0) return undefined;
  const close = value.indexOf(']', open + MARK.length + 1);
  return close < 0 ? undefined : value.slice(open + MARK.length + 1, close) || undefined;
};

export function createZepFactory(options: ZepAdapterOptions): MatchedSystemFactory {
  const keyEnv = options.apiKeyEnv ?? KEY_ENV;
  const settleMs = options.ingestSettleMs ?? 600_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(done => { setTimeout(done, ms); }));
  return {
    id: 'zep',
    describe: () => `Zep (npm @getzep/zep-cloud). BLOCKED without ${REQUIREMENT} Set ${keyEnv} and re-run to score it.`,
    async resolve(): Promise<MatchedResolution> {
      let client = options.client, revision = 'stub';
      if (!client) {
        const module = resolveCompetitorModule(options.baseDir, '@getzep/zep-cloud', '.');
        if (!module.resolved) return { available: false, reason: `${module.reason} Even once installed, Zep needs ${REQUIREMENT}` };
        revision = module.version;
        // Read by name. The value is never printed, logged, or put in a report.
        const key = process.env[keyEnv];
        if (typeof key !== 'string' || !key.trim()) return { available: false, reason: `${keyEnv} is not set. Zep needs ${REQUIREMENT}` };
        let loaded: { ZepClient?: new (config: Record<string, unknown>) => ZepLikeClient };
        try { loaded = await import(module.url) as typeof loaded; }
        catch (error) { return { available: false, reason: `@getzep/zep-cloud failed to load: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}` }; }
        if (typeof loaded.ZepClient !== 'function') return { available: false, reason: 'The installed @getzep/zep-cloud does not export ZepClient.' };
        client = new loaded.ZepClient({ apiKey: key, ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}) });
      }
      const bound = client;
      const system: MatchedSystem = {
        id: assertMatchedSystemId('zep'),
        revision,
        mode: `zep-cloud@${revision}, extraction=graphiti(vendor-side LLM, not ours), retrieval=graph-search(scope=episodes), `
          + `endpoint=${options.baseUrl ?? 'hosted'}, embedder=vendor-side(unknown)`,
        async create(request): Promise<MatchedSession> {
          const user = `matched-${request.corpusId}-${request.seed}`;
          await bound.user.add({ userId: user });
          // chunk identity -> the episode uuid Zep assigned, for deletion.
          const episodes = new Map<string, string>();
          return {
            async ingest(chunks, operation): Promise<void> {
              for (const chunk of chunks) {
                operation.signal.throwIfAborted();
                const episode = await bound.graph.add({ userId: user, type: 'text',
                  data: chunk.speaker ? `${chunk.speaker}: ${chunk.text}` : chunk.text,
                  sourceDescription: marker(chunk.id), metadata: { [CHUNK_KEY]: chunk.id } });
                episodes.set(chunk.id, typeof episode?.uuid === 'string' ? episode.uuid : '');
              }
              // Zep ingests asynchronously: `graph.add` returns before the episode
              // is extracted and searchable. Querying immediately would measure
              // Zep's queue depth rather than its retrieval, so the adapter waits
              // for every episode to report processed, and fails loudly — with a
              // reason that reaches the table — rather than scoring a half-loaded
              // graph as if it were a loaded one.
              const deadline = Date.now() + settleMs;
              for (let wait = 1000; ; wait = Math.min(wait * 2, 15_000)) {
                operation.signal.throwIfAborted();
                const seen = await bound.graph.episode.getByUserId(user, { lastn: chunks.length });
                const pending = (seen.episodes ?? []).filter(episode => episode.processed === false).length;
                const missing = chunks.length - (seen.episodes ?? []).length;
                if (!pending && missing <= 0) return;
                if (Date.now() >= deadline) throw new Error(`Zep did not finish processing ${pending + Math.max(0, missing)} of ${chunks.length} episodes within ${Math.round(settleMs / 1000)}s.`);
                await sleep(wait);
              }
            },
            async retrieve({ query, limit, signal }): Promise<string[]> {
              signal.throwIfAborted();
              // Zep caps a non-auto scope search at 50 results.
              const found = await bound.graph.search({ userId: user, query, limit: Math.min(limit, 50), scope: 'episodes' });
              const ranked: string[] = [];
              for (const episode of found.episodes ?? []) {
                const tagged = episode.metadata?.[CHUNK_KEY];
                const id = typeof tagged === 'string' ? tagged : unmark(episode.sourceDescription);
                // An episode with no ingestion-time identity is one Zep derived
                // without provenance back to a source passage. It cannot be scored
                // against evidence labels, so it is skipped rather than guessed at.
                if (!id || !episodes.has(id) || ranked.includes(id)) continue;
                ranked.push(id);
                if (ranked.length >= limit) break;
              }
              return ranked;
            },
            async forget(ids, operation): Promise<void> {
              for (const id of ids) {
                operation.signal.throwIfAborted();
                const uuid = episodes.get(id);
                if (uuid) await bound.graph.episode.delete(uuid);
                episodes.delete(id);
              }
            },
            async close(): Promise<void> { await bound.user.delete(user); },
          };
        },
      };
      return { available: true, system };
    },
  };
}
