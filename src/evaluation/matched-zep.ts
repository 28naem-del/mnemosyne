import { assertMatchedSystemId, type MatchedResolution, type MatchedSession, type MatchedSystem, type MatchedSystemFactory } from './matched-types.js';
import { resolveCompetitorModule } from './matched-resolve.js';

/**
 * Zep as a matched-run system.
 *
 * Zep is the one competitor in this table that cannot be made to run for free.
 * Zep Community Edition — the self-hostable server the older `@getzep/zep-js`
 * client spoke to — was discontinued, and the current `@getzep/zep-cloud` client
 * talks only to Zep's hosted API, which requires an account and an API key.
 * Graphiti, the open-source engine underneath it, additionally requires a graph
 * database and an LLM for ingestion.
 *
 * So this adapter exists in full, is exercised by `tests/matched-zep.test.ts`
 * against a stub client that implements the same surface, and **fails closed**
 * in the absence of a key: it produces a reason string, which the published
 * table prints in the cell where a score would otherwise be. It never falls back
 * to a different retrieval path, never degrades quietly, and above all never
 * reprints a number Zep published about itself.
 *
 * The blocking requirement, so an operator can unblock it in one step, is
 * recorded in `describe()` and reproduced verbatim in the report.
 */

/** The part of the Zep client surface a retrieval benchmark needs. */
export interface ZepLikeClient {
  graph: {
    add(request: { userId: string; type: 'text'; data: string; sourceDescription?: string }): Promise<unknown>;
    search(request: { userId: string; query: string; limit: number; scope?: 'edges' | 'nodes' | 'episodes' }): Promise<ZepSearchResponse>;
  };
  user: {
    add(request: { userId: string }): Promise<unknown>;
    delete(userId: string): Promise<unknown>;
  };
}
export interface ZepSearchResponse {
  episodes?: { uuid?: string; content?: string; sourceDescription?: string }[];
  edges?: { uuid?: string; fact?: string; sourceDescription?: string }[];
  nodes?: { uuid?: string; name?: string; summary?: string }[];
}

export interface ZepAdapterOptions {
  /** Where `@getzep/zep-cloud` is installed. */
  baseDir: string;
  /** Injected by tests. When present, no SDK or key is required. */
  client?: ZepLikeClient;
  /** Name of the environment variable holding the key. The value is never logged. */
  apiKeyEnv?: string;
  /** Self-hosted base URL, for a Zep server that is not the hosted cloud. */
  baseUrl?: string;
}

const KEY_ENV = 'ZEP_API_KEY';
const REQUIREMENT = 'a Zep Cloud account and a ZEP_API_KEY (Zep Community Edition, the self-hostable server, was discontinued; '
  + 'the current @getzep/zep-cloud client speaks only to the hosted API). Graphiti, the engine underneath, additionally needs a graph database '
  + '(Neo4j/FalkorDB) and an LLM provider for episode ingestion.';

/**
 * Marks every chunk we push so retrieval can map a Zep result back to a source
 * passage. Zep returns facts and episodes, not our identities, so the identity
 * is carried in the one free-text field that survives ingestion unmodified.
 */
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
  return {
    id: 'zep',
    describe: () => `Zep (npm @getzep/zep-cloud). BLOCKED without ${REQUIREMENT} Set ${keyEnv} and re-run to score it.`,
    async resolve(): Promise<MatchedResolution> {
      let client = options.client, revision = 'stub';
      if (!client) {
        const module = resolveCompetitorModule(options.baseDir, '@getzep/zep-cloud', '.');
        if (!module.resolved) return { available: false, reason: `${module.reason} Even once installed, Zep needs ${REQUIREMENT}` };
        revision = module.version;
        // The key is read by name and never printed, logged or included in a report.
        const key = process.env[keyEnv];
        if (typeof key !== 'string' || !key.trim()) {
          return { available: false, reason: `${keyEnv} is not set. Zep needs ${REQUIREMENT}` };
        }
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
        mode: `zep-cloud@${revision}, extraction=graphiti(hosted, vendor-side LLM), retrieval=graph-search(episodes), endpoint=${options.baseUrl ?? 'hosted'}`,
        async create(request): Promise<MatchedSession> {
          const user = `matched-${request.corpusId}-${request.seed}`;
          await bound.user.add({ userId: user });
          const known = new Set<string>();
          return {
            async ingest(chunks, operation): Promise<void> {
              for (const chunk of chunks) {
                operation.signal.throwIfAborted();
                await bound.graph.add({ userId: user, type: 'text',
                  data: chunk.speaker ? `${chunk.speaker}: ${chunk.text}` : chunk.text,
                  sourceDescription: marker(chunk.id) });
                known.add(chunk.id);
              }
            },
            async retrieve({ query, limit, signal }): Promise<string[]> {
              signal.throwIfAborted();
              const found = await bound.graph.search({ userId: user, query, limit, scope: 'episodes' });
              const ranked: string[] = [];
              for (const episode of found.episodes ?? []) {
                const id = unmark(episode.sourceDescription);
                if (!id || !known.has(id) || ranked.includes(id)) continue;
                ranked.push(id);
                if (ranked.length >= limit) break;
              }
              return ranked;
            },
            async close(): Promise<void> { await bound.user.delete(user); },
          };
        },
      };
      return { available: true, system };
    },
  };
}
