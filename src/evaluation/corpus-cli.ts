import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createCompatibleEmbedder } from '../providers/index.js';
import { adaptBeamCorpus, adaptLoCoMoCorpus, adaptLongMemEvalCorpus, runCorpusBenchmark, type CorpusDataset, type CorpusProvenance } from './corpus-benchmark.js';

function readJson(path: string, maxBytes: number): { value: unknown; bytes: number; sha256: string } {
  const fd = openSync(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes || before.size < 1) throw new Error('Input must be a bounded regular JSON file.');
    const buffer = Buffer.alloc(before.size + 1); let used = 0;
    while (used < buffer.length) { const read = readSync(fd, buffer, used, buffer.length - used, null); if (!read) break; used += read; }
    const after = fstatSync(fd);
    if (used !== before.size || after.size !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Input changed while reading.');
    const bytes = buffer.subarray(0, used);
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown, bytes: used, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { closeSync(fd); }
}
const settingsSchema = z.object({ includeBm25: z.boolean().optional(), hybridLexicalScoring: z.enum(['overlap', 'bm25']).optional(), topK: z.number().int().min(1).max(100).optional(), maxContextUnits: z.number().int().min(1).max(16777216).optional(), chunkBytes: z.number().int().min(128).max(16000).optional(), maxQuestions: z.number().int().min(1).max(10000).optional(), maxTurnsPerCorpus: z.number().int().min(1).max(1000000).optional(), maxCorpusBytes: z.number().int().min(1).max(536870912).optional(), maxTotalBytes: z.number().int().min(1).max(2147483648).optional(), maxCandidates: z.number().int().min(1).max(10000).optional(), timeoutMs: z.number().int().min(1).max(3600000).optional(), maxEmbeddingCalls: z.number().int().min(1).max(1000000).optional(), maxEmbeddingInputBytes: z.number().int().min(1).max(2147483648).optional() }).strict();

/** Standalone public-data runner; no provider is selected or called implicitly. */
export async function corpusBenchmarkCli(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    format: { type: 'string' }, file: { type: 'string' }, questions: { type: 'string' }, out: { type: 'string' },
    'dataset-revision': { type: 'string' }, 'dataset-label': { type: 'string' }, 'source-url': { type: 'string' }, license: { type: 'string' },
    'timestamp-policy': { type: 'string' }, 'embedding-config': { type: 'string' }, json: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log('node dist/evaluation/corpus-cli.js --format longmemeval|locomo|beam|normalized --file DATA.json [--questions BEAM_QUESTIONS.json] --dataset-revision REV --license LICENSE --out NEW_REPORT.json [--timestamp-policy question-day] [--json SETTINGS_JSON] [--embedding-config EXPLICIT_CONFIG.json]'); return; }
  if (!values.file || !values.out || !values.format) throw new Error('Supply --format, --file and a new --out path.');
  if (!['longmemeval', 'locomo', 'beam', 'normalized'].includes(values.format)) throw new Error('Unknown dataset format.');
  if (values.format !== 'beam' && values.questions) throw new Error('--questions applies only to BEAM.');
  if (values.format !== 'longmemeval' && values['timestamp-policy']) throw new Error('--timestamp-policy applies only to LongMemEval.');
  const settings = settingsSchema.parse(values.json ? JSON.parse(values.json) : {});
  const source = readJson(values.file, 536_870_912);
  let dataset: CorpusDataset;
  if (values.format === 'normalized') {
    dataset = source.value as CorpusDataset;
    if (!Array.isArray(dataset?.notices)) throw new Error('Invalid normalized protocol notices.');
    dataset.notices.push(`Normalized protocol file SHA256 ${source.sha256}; bytes ${source.bytes}. Original dataset provenance remains caller supplied.`);
  }
  else {
    if (!values['dataset-revision'] || !values.license) throw new Error('Record --dataset-revision and --license for external data.');
    const provenance: CorpusProvenance = { dataset: values['dataset-label'] ?? values.format, revision: values['dataset-revision'], license: values.license, sourceSha256: source.sha256, sourceBytes: source.bytes, ...(values['source-url'] ? { sourceUrl: values['source-url'] } : {}) };
    if (values.format === 'longmemeval') dataset = adaptLongMemEvalCorpus(source.value, provenance, { timestampPolicy: z.enum(['strict-instant', 'question-day']).parse(values['timestamp-policy'] ?? 'strict-instant') });
    else if (values.format === 'locomo') dataset = adaptLoCoMoCorpus(source.value, provenance);
    else {
      if (!values.questions) throw new Error('BEAM requires normalized repository --questions JSON. Python literal strings are unsupported.');
      const questions = readJson(values.questions, 16_777_216);
      dataset = adaptBeamCorpus(source.value, questions.value, { ...provenance, sourceSha256: createHash('sha256').update(`${source.sha256}\n${questions.sha256}\n`).digest('hex'), sourceBytes: source.bytes + questions.bytes });
      dataset.notices.push(`BEAM chat SHA256 ${source.sha256}; questions SHA256 ${questions.sha256}. Combined digest hashes these two hex digests in that order, each followed by LF.`);
    }
  }
  const config = values['embedding-config'] ? z.object({ baseUrl: z.url(), model: z.string().min(1), revision: z.string().min(1), dimensions: z.number().int().min(1).max(4096), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional() }).strict().parse(readJson(values['embedding-config'], 16384).value) : undefined;
  const key = config?.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
  if (config?.apiKeyEnv && !key) throw new Error('Explicit embedding credential environment variable is missing.');
  const embedder = config ? createCompatibleEmbedder({ baseUrl: config.baseUrl, model: config.model, dimensions: config.dimensions, revision: config.revision, ...(key ? { apiKey: key } : {}) }) : undefined;
  const output = openSync(resolve(values.out), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const report = await runCorpusBenchmark(dataset, { ...settings, ...(embedder ? { embedder } : {}), signal: controller.signal });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ file: resolve(values.out), complete: report.complete, questions: report.dataset.questions, calls: report.calls, summaries: report.summaries }));
    if (!report.complete) process.exitCode = 1;
  } finally { closeSync(output); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void corpusBenchmarkCli().catch(() => { console.error('Corpus evaluation failed. Verify input format, bounds, source metadata and new output path; private error details omitted.'); process.exitCode = 1; });
}
