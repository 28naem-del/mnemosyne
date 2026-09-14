#!/usr/bin/env node
// One-time setup download of the pinned local embedding model. Retrieval never
// reaches the network; this script exists so the cache can be populated once.
import { parseArgs } from 'node:util';
import { BUNDLED_EMBEDDING_MODEL, fetchBundledModel } from '../dist/local/embedding/index.js';

const { values } = parseArgs({ options: { 'cache-dir': { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('node scripts/fetch-local-model.mjs [--cache-dir ABSOLUTE_DIR]\n'
    + `Downloads ${BUNDLED_EMBEDDING_MODEL.repository}@${BUNDLED_EMBEDDING_MODEL.revision} (int8 ONNX, ${BUNDLED_EMBEDDING_MODEL.dimensions}d).\n`
    + 'Defaults to $MNEMOSYNE_MODEL_CACHE, then the user cache directory. Every artifact is SHA-256 verified against a pinned digest.');
  process.exit(0);
}
const status = await fetchBundledModel({ ...(values['cache-dir'] ? { cacheDir: values['cache-dir'] } : {}), onProgress: message => console.log(`[setup:embedder] ${message}`) });
console.log(JSON.stringify({ directory: status.directory, present: status.present, files: status.files.map(({ file, bytes }) => ({ file, bytes })) }, null, 2));
if (!status.present) { console.error('[setup:embedder] cache is incomplete'); process.exitCode = 1; }
