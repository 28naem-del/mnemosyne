import { LOCAL_EMBEDDING_SPEC, LOCAL_MODEL_RUNTIME, LOCAL_RERANKER_SPEC } from './local-model-spec.js';
import { assertLocalModelDependencies } from './local-model-dependencies.js';

type Tensor = { dims: number[]; data: ArrayLike<number | bigint> };
type Tokenizer = { (text: string, options: Record<string, unknown>): unknown; encode(text: string, options?: { text_pair?: string }): number[] };
type Model = (input: unknown) => Promise<{ logits: Tensor }>;
interface Transformers {
  env: { version: string; allowRemoteModels: boolean; allowLocalModels: boolean; localModelPath: string; useFSCache: boolean; cacheDir: string };
  AutoModel: { from_pretrained(model: string, options: Record<string, unknown>): Promise<(input: unknown) => Promise<{ last_hidden_state: Tensor }>> };
  AutoTokenizer: { from_pretrained(model: string, options: Record<string, unknown>): Promise<Tokenizer> };
  AutoModelForSequenceClassification: { from_pretrained(model: string, options: Record<string, unknown>): Promise<Model> };
}
if (!process.send || !process.argv[2]) throw new Error('Local model inference must run in its isolated subprocess');
const config = JSON.parse(process.argv[2]) as { kind: 'embed' | 'rerank'; cacheDir: string; allowDownload: boolean };
process.on('disconnect', () => process.exit(0));

/** Every character reaches a model window; budget failures are explicit, never silent truncation. */
function chunks(text: string, fits: (part: string) => boolean): string[] {
  const result: string[] = [], pending = [text];
  while (pending.length) {
    const part = pending.pop()!;
    if (fits(part)) result.push(part);
    else {
      const points = Array.from(part);
      if (points.length < 2) throw new Error('Text cannot fit the model token window');
      const middle = Math.ceil(points.length / 2);
      pending.push(points.slice(middle).join(''), points.slice(0, middle).join(''));
    }
    if (result.length + pending.length > 256) throw new Error('Text exceeds local model chunk budget; split the source into smaller records');
  }
  return result;
}
async function main() {
  const packageName: string = '@huggingface/transformers';
  let runtimeEntry: string;
  try { runtimeEntry = import.meta.resolve(packageName); }
  catch { throw new Error(`Install optional @huggingface/transformers@${LOCAL_MODEL_RUNTIME} to use local CPU models`); }
  assertLocalModelDependencies(runtimeEntry);
  let runtime: Transformers;
  try { runtime = await import(runtimeEntry) as Transformers; }
  catch { throw new Error(`Install optional @huggingface/transformers@${LOCAL_MODEL_RUNTIME} to use local CPU models`); }
  if (runtime.env.version !== LOCAL_MODEL_RUNTIME) throw new Error(`Local presets require @huggingface/transformers@${LOCAL_MODEL_RUNTIME}; found ${runtime.env.version}`);
  // Separate processes isolate native runtime globals as well as JavaScript settings.
  runtime.env.allowRemoteModels = config.allowDownload;
  runtime.env.allowLocalModels = true;
  // Avoid cwd-dependent model discovery; the runtime first checks its revision-keyed cache.
  runtime.env.localModelPath = `${config.cacheDir}/local-models/`;
  runtime.env.useFSCache = true;
  runtime.env.cacheDir = config.cacheDir;
  const spec = config.kind === 'embed' ? LOCAL_EMBEDDING_SPEC : LOCAL_RERANKER_SPEC;
  const load = { revision: spec.revision, dtype: spec.dtype, device: 'cpu', local_files_only: !config.allowDownload,
    cache_dir: config.cacheDir, session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 } };
  let embed: ((texts: string[]) => Promise<number[][]>) | undefined;
  let rerank: ((query: string, texts: string[]) => Promise<number[]>) | undefined;
  if (config.kind === 'embed') {
    // Explicit components use the pinned tokenizer and model, including cached offline loads.
    const tokenizer = await runtime.AutoTokenizer.from_pretrained(spec.id, load);
    const model = await runtime.AutoModel.from_pretrained(spec.id, load);
    embed = async texts => {
      const vectors: number[][] = [];
      for (const text of texts) {
        const parts = chunks(text, part => tokenizer.encode(part).length <= LOCAL_EMBEDDING_SPEC.maxTokens);
        const combined = Array<number>(LOCAL_EMBEDDING_SPEC.dimensions).fill(0);
        for (const part of parts) {
          const inputs = tokenizer(part, { padding: true, truncation: false }) as { attention_mask: Tensor };
          const hidden = (await model(inputs)).last_hidden_state;
          if (hidden?.dims.length !== 3 || hidden.dims[0] !== 1 || hidden.dims[2] !== combined.length || inputs.attention_mask.data.length !== hidden.dims[1]) throw new Error('Invalid local embedding output shape');
          const vector = Array<number>(combined.length).fill(0);
          for (let token = 0; token < hidden.dims[1]; token++) {
            if (Number(inputs.attention_mask.data[token]) === 0) continue;
            for (let index = 0; index < vector.length; index++) vector[index] += Number(hidden.data[token * vector.length + index]);
          }
          // Masked mean followed by L2 normalization is equivalent to normalized masked sum.
          const partNorm = Math.hypot(...vector);
          if (!Number.isFinite(partNorm) || partNorm === 0) throw new Error('Invalid local embedding output');
          for (let index = 0; index < vector.length; index++) vector[index] /= partNorm;
          const weight = Math.max(1, tokenizer.encode(part).length - 2);
          for (let index = 0; index < vector.length; index++) combined[index] += vector[index] * weight;
        }
        const norm = Math.hypot(...combined);
        if (!Number.isFinite(norm) || norm === 0) throw new Error('Invalid zero local embedding');
        vectors.push(combined.map(value => value / norm));
      }
      return vectors;
    };
  } else {
    const tokenizer = await runtime.AutoTokenizer.from_pretrained(spec.id, load);
    const model = await runtime.AutoModelForSequenceClassification.from_pretrained(spec.id, load);
    rerank = async (query, texts) => {
      if (tokenizer.encode(query).length > 128) throw new Error('Local reranking query exceeds 128 tokens; shorten the query explicitly');
      const scores: number[] = [];
      for (const text of texts) {
        const parts = chunks(text, part => tokenizer.encode(query, { text_pair: part }).length <= LOCAL_RERANKER_SPEC.maxTokens);
        let score = -Infinity;
        for (const part of parts) {
          const result = await model(tokenizer(query, { text_pair: part, padding: true, truncation: false }));
          if (result.logits.data.length !== 1 || !Number.isFinite(Number(result.logits.data[0]))) throw new Error('Invalid local reranker output');
          score = Math.max(score, Number(result.logits.data[0]));
        }
        scores.push(score);
      }
      return scores;
    };
  }
  process.on('message', (request: { id: number; texts: string[]; query?: string }) => {
    void (async () => {
      try {
        const values = embed ? await embed(request.texts) : await rerank!(request.query!, request.texts);
        process.send!({ id: request.id, values });
      } catch (cause) { process.send!({ id: request.id, error: cause instanceof Error ? cause.message : 'Local inference failed' }); }
    })();
  });
  process.send!({ ready: true });
}
void main().catch(cause => { process.send!({ error: cause instanceof Error ? cause.message : 'Local model initialization failed' }, () => process.disconnect?.()); });
