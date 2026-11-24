import type { CorpusEngineOptions } from './corpus-types.js';

/**
 * `--engine-opts '<json>'` for the matched run: one generic passthrough, so a
 * tuning experiment changes a JSON value rather than adding a flag per knob.
 *
 * The JSON is merged over the engine configuration this harness has always used
 * (`MATCHED_ENGINE_DEFAULTS`), section by section, and applies to every Mnemosyne
 * condition in the run:
 *
 * - `memory`   -> `createLocalMemory` options (e.g. `rrfK`, `minSimilarity`, `granularity`)
 * - `hybrid`   -> every `recallHybrid` call: `rrfK`, `fusionWeights` {lexical, dense},
 *                 `rerankTopN` (cross-encoder candidates), `maxCandidates` (dense pool)
 * - `embedder` -> the bundled ONNX embedder: `batchSize`, `threads` (ORT intra-op)
 * - `reranker` -> the bundled ONNX cross-encoder: `batchSize`, `threads` (ORT intra-op)
 *
 * `{}` (the default) reproduces the harness exactly as it was before this flag.
 * The requested JSON and the merged result are both written to the raw report.
 */
export interface MatchedEngineOpts {
  memory?: NonNullable<CorpusEngineOptions['memory']>;
  hybrid?: NonNullable<CorpusEngineOptions['hybrid']> & { rerankTopN?: number };
  embedder?: { batchSize?: number; threads?: number };
  reranker?: { batchSize?: number; threads?: number };
}

/** What the harness ran with before engine options existed; `{}` merges to exactly this. */
export const MATCHED_ENGINE_DEFAULTS = Object.freeze({
  memory: Object.freeze({}),
  hybrid: Object.freeze({ rerankTopN: 50 }),
  embedder: Object.freeze({ batchSize: 32 }),
  reranker: Object.freeze({ batchSize: 32 }),
});

export interface MatchedEngineConfig {
  memory: NonNullable<MatchedEngineOpts['memory']>;
  hybrid: NonNullable<MatchedEngineOpts['hybrid']> & { rerankTopN: number };
  embedder: { batchSize: number; threads?: number };
  reranker: { batchSize: number; threads?: number };
}

const SECTIONS = ['memory', 'hybrid', 'embedder', 'reranker'] as const;
const MODEL_KEYS = ['batchSize', 'threads'];

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function integer(value: unknown, label: string, min: number, max: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)) throw new Error(`--engine-opts ${label} must be an integer ${min}-${max}.`);
}

/**
 * Parses and checks the flag's JSON. Shape and model/rerank bounds are checked
 * here; `memory` and the rest of `hybrid` are checked again by the corpus runner
 * against the engine itself before any corpus loads.
 */
export function parseEngineOpts(text: string | undefined): MatchedEngineOpts {
  if (text === undefined || !text.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('--engine-opts must be a JSON object.'); }
  if (!plain(parsed)) throw new Error('--engine-opts must be a JSON object.');
  for (const key of Object.keys(parsed)) {
    if (!(SECTIONS as readonly string[]).includes(key)) throw new Error(`--engine-opts has an unknown section "${key}"; use ${SECTIONS.join(', ')}.`);
    if (!plain(parsed[key])) throw new Error(`--engine-opts ${key} must be an object.`);
  }
  for (const section of ['embedder', 'reranker'] as const) {
    const entry = parsed[section] as Record<string, unknown> | undefined;
    if (!entry) continue;
    for (const key of Object.keys(entry)) if (!MODEL_KEYS.includes(key)) throw new Error(`--engine-opts ${section} takes only ${MODEL_KEYS.join(', ')}; got "${key}".`);
    integer(entry.batchSize, `${section}.batchSize`, 1, 64);
    integer(entry.threads, `${section}.threads`, 1, 64);
  }
  integer((parsed.hybrid as Record<string, unknown> | undefined)?.rerankTopN, 'hybrid.rerankTopN', 1, 1000);
  return parsed as MatchedEngineOpts;
}

/** Merges the requested options over the harness defaults, one section at a time. */
export function resolveEngineConfig(opts: MatchedEngineOpts): MatchedEngineConfig {
  return {
    memory: { ...MATCHED_ENGINE_DEFAULTS.memory, ...opts.memory },
    hybrid: { ...MATCHED_ENGINE_DEFAULTS.hybrid, ...opts.hybrid },
    embedder: { ...MATCHED_ENGINE_DEFAULTS.embedder, ...opts.embedder },
    reranker: { ...MATCHED_ENGINE_DEFAULTS.reranker, ...opts.reranker },
  };
}

/**
 * The corpus runner's `engine` option for a resolved configuration, or undefined
 * when nothing beyond the defaults reaches the engine — so a default run passes
 * the runner exactly what it always did. `rerankTopN` is not in here: it goes to
 * the runner's own `rerankTopN`, which the settings block already records.
 */
export function corpusEngineOptions(config: MatchedEngineConfig): CorpusEngineOptions | undefined {
  const { rerankTopN: _rerankTopN, ...hybrid } = config.hybrid;
  const memory = config.memory;
  const engine: CorpusEngineOptions = { ...(Object.keys(memory).length ? { memory } : {}), ...(Object.keys(hybrid).length ? { hybrid } : {}) };
  return Object.keys(engine).length ? engine : undefined;
}
