/**
 * FalkorDB Knowledge Graph Example
 *
 * Demonstrates how Mnemosyne integrates with FalkorDB to build a property
 * graph of entities and relationships extracted from stored memories.
 * This enables multi-hop reasoning: "what else is related to Paris?"
 *
 * Prerequisites:
 *   - Qdrant running at http://localhost:6333
 *   - Ollama running at http://localhost:11434 with nomic-embed-text pulled
 *   - FalkorDB running at localhost:6380
 *
 * Run:
 *   npx ts-node examples/with-falkordb.ts
 */

import createMnemosyne from '../src/index';

async function main() {
  const memory = createMnemosyne({
    qdrantUrl: process.env.QDRANT_URL ?? 'http://localhost:6333',
    embeddingUrl: process.env.EMBEDDING_URL ?? 'http://localhost:11434',
    embeddingModel: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
    agentId: process.env.AGENT_ID ?? 'graph-demo',
    collectionName: 'graph-memories',
    falkordb: {
      host: process.env.FALKORDB_HOST ?? 'localhost',
      port: Number(process.env.FALKORDB_PORT ?? 6380),
      graphName: 'mnemosyne_kg',
    },
  });

  console.log('✅ Mnemosyne initialized with FalkorDB knowledge graph\n');

  // Store several related memories — each creates nodes and edges in the graph
  await memory.store({
    text: 'Marie Curie was a physicist and chemist who conducted pioneering research on radioactivity.',
    category: 'fact',
    importance: 0.9,
    metadata: { domain: 'science' },
  });

  await memory.store({
    text: 'Marie Curie won the Nobel Prize in Physics in 1903 and the Nobel Prize in Chemistry in 1911.',
    category: 'fact',
    importance: 0.95,
    metadata: { domain: 'science' },
  });

  await memory.store({
    text: 'The Nobel Prize in Chemistry was first awarded in 1901 to Jacobus Henricus van\'t Hoff.',
    category: 'fact',
    importance: 0.7,
    metadata: { domain: 'science' },
  });

  console.log('📝 Stored 3 memories about Marie Curie and the Nobel Prize');

  // Standard semantic recall
  const semanticResults = await memory.recall({
    query: 'Marie Curie Nobel Prize',
    limit: 5,
  });

  console.log(`\n🔍 Semantic recall (${semanticResults.length} results):`);
  for (const r of semanticResults) {
    console.log(`  [${(r.score * 100).toFixed(1)}%] ${r.text.slice(0, 80)}…`);
  }

  // Graph traversal: find all memories connected to "Marie Curie" via knowledge graph
  if (memory.graph) {
    const graphResults = await memory.graph.traverse({
      startEntity: 'Marie Curie',
      relationTypes: ['WON', 'RESEARCHED', 'AWARDED'],
      maxHops: 2,
    });

    console.log(`\n🕸️  Graph traversal from "Marie Curie" (${graphResults.length} nodes):`);
    for (const node of graphResults) {
      console.log(`  → [${node.type}] ${node.label}`);
    }
  }

  // Spreading activation: surface loosely related memories
  const activated = await memory.spreadingActivation({
    seedText: 'radioactivity research',
    depth: 2,
    decay: 0.7,
    limit: 5,
  });

  console.log(`\n⚡ Spreading activation (${activated.length} results):`);
  for (const r of activated) {
    console.log(`  [activation: ${r.activation.toFixed(3)}] ${r.text.slice(0, 80)}…`);
  }

  console.log('\n✅ Done');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
