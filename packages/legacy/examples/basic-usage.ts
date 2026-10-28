/** Qdrant example. Use explicitly configured isolated services; this writes sample data. */
import { createMnemosyne } from '../dist/index.js';
const vectorDbUrl = process.env.QDRANT_URL;
const embeddingUrl = process.env.EMBEDDING_URL;
if (!vectorDbUrl || !embeddingUrl) throw new Error('Set QDRANT_URL and EMBEDDING_URL to isolated example services.');
const memory = await createMnemosyne({
  vectorDbUrl, embeddingUrl,
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
  embeddingApiKey: process.env.EMBEDDING_API_KEY,
  qdrantApiKey: process.env.QDRANT_API_KEY,
  agentId: 'example-agent',
  collections: { shared: 'example_shared', private: 'example_private', profiles: 'example_profiles', skills: 'example_skills' },
});
const id = await memory.store({ text: 'The catalogue needs owner approval before publishing.', category: 'fact', importance: 0.8 });
try {
  const results = await memory.recall({ query: 'catalogue approval', limit: 5 });
  console.log(results.map(result => ({ id: result.entry.id, text: result.entry.text, score: result.score })));
  console.log('Keyword startup coverage:', memory.bm25Status);
} finally {
  if (id) await memory.forget({ id });
}
