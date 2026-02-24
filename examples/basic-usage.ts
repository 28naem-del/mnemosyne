/**
 * Basic Usage Example
 *
 * Demonstrates the core Mnemosyne API: configure, store, recall, and forget.
 *
 * Prerequisites:
 *   - Qdrant running at http://localhost:6333
 *   - Ollama running at http://localhost:11434 with nomic-embed-text pulled
 *
 * Run:
 *   npx ts-node examples/basic-usage.ts
 */

import createMnemosyne from '../src/index';

async function main() {
  // 1. Create and configure a Mnemosyne instance
  //    qdrantUrl is an alias for vectorDbUrl, collectionName for collections.shared
  const memory = await createMnemosyne({
    qdrantUrl: process.env.QDRANT_URL ?? 'http://localhost:6333',
    embeddingUrl: process.env.EMBEDDING_URL ?? 'http://localhost:11434/v1/embeddings',
    embeddingModel: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
    agentId: process.env.AGENT_ID ?? 'demo-agent',
    collectionName: process.env.COLLECTION_NAME ?? 'memories',
  });

  console.log('✅ Mnemosyne initialized');

  // 2. Store a memory — returns the memory ID string
  const memoryId = await memory.store({
    text: 'The Eiffel Tower is located in Paris, France, and was completed in 1889.',
    category: 'fact',
    importance: 0.8,
    metadata: { source: 'basic-usage-example' },
  });

  console.log(`📝 Stored memory with id: ${memoryId}`);

  // 3. Store a second memory so recall has something to rank
  await memory.store({
    text: 'The Louvre Museum in Paris houses over 35,000 works of art.',
    category: 'fact',
    importance: 0.7,
    metadata: { source: 'basic-usage-example' },
  });

  // 4. Recall memories related to a query
  const results = await memory.recall({
    query: 'famous landmarks in Paris',
    limit: 5,
  });

  console.log(`\n🔍 Recalled ${results.length} memories:`);
  for (const result of results) {
    console.log(`  [${(result.score * 100).toFixed(1)}%] ${result.entry.text}`);
  }

  // 5. Forget the first memory by ID
  if (memoryId) {
    await memory.forget(memoryId);
    console.log(`\n🗑️  Forgot memory ${memoryId}`);
  }

  // 6. Confirm it's gone
  const afterForget = await memory.recall({ query: 'Eiffel Tower', limit: 3 });
  console.log(`\n🔍 After forget, recall for "Eiffel Tower": ${afterForget.length} result(s)`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
