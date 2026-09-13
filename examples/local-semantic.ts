/** Real optional CPU integration. Run only with an explicitly chosen model cache. */
import { parseArgs } from 'node:util';
import { createLocalMemory } from '../dist/local/index.js';
import { createLocalEmbedder, createLocalReranker, type LocalEmbedder, type LocalReranker } from '../dist/providers/local.js';

const { values } = parseArgs({ options: { cache: { type: 'string' }, download: { type: 'boolean', default: false } }, strict: true });
if (!values.cache) throw new Error('Supply --cache /absolute/model-cache; add --download only when provisioning pinned public models.');
const models = { cacheDir: values.cache, allowDownload: values.download, timeoutMs: 60000 };
const memory = createLocalMemory({ path: ':memory:', workspaceId: 'local-model-demo', agentId: 'demo' });
let reranker: LocalReranker | undefined;
let embedder: LocalEmbedder | undefined;
try {
  embedder = await createLocalEmbedder(models);
  reranker = await createLocalReranker(models);
  for (const [index, text] of ['A mechanic fixes broken bicycles.', 'A chef prepares dinner.', 'An accountant audits financial statements.'].entries()) {
    memory.store({ text, trust: 'observed', source: { uri: `demo:source-${index}` } });
  }
  const index = await memory.indexEmbeddings({ embedder, batchSize: 3, timeoutMs: 60000 });
  const packet = await memory.compileHybrid({ query: 'Who repairs a bike?', maxTokens: 8192 }, { embedder, reranker, timeoutMs: 60000 });
  if (!packet.items[0]?.text.includes('mechanic')) throw new Error('Semantic integration did not rank the expected example first.');
  console.log(JSON.stringify({ example: 'synthetic local CPU integration, not benchmark accuracy', embeddingModel: embedder.model, rerankerModel: reranker.model, index, context: JSON.parse(packet.text) }, null, 2));
} finally {
  try { await Promise.all([embedder?.dispose(), reranker?.dispose()]); }
  finally { memory.close(); }
}
