/**
 * Redis Broadcast Example
 *
 * Demonstrates fleet-wide memory broadcasting via Redis pub/sub.
 * When one agent stores a memory, all other agents subscribed to the
 * same Redis channel receive a real-time notification.
 *
 * Prerequisites:
 *   - Qdrant running at http://localhost:6333
 *   - Ollama running at http://localhost:11434 with nomic-embed-text pulled
 *   - Redis running at redis://localhost:6379
 *
 * Run:
 *   npx ts-node examples/with-redis.ts
 */

import createMnemosyne from '../src/index';

async function main() {
  // Agent A — the "writer" agent
  const agentA = createMnemosyne({
    qdrantUrl: process.env.QDRANT_URL ?? 'http://localhost:6333',
    embeddingUrl: process.env.EMBEDDING_URL ?? 'http://localhost:11434',
    embeddingModel: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
    agentId: 'agent-alpha',
    collectionName: 'fleet-memories',
    redis: {
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
      channel: 'mnemosyne:fleet',
    },
  });

  // Agent B — the "listener" agent (same fleet, different instance)
  const agentB = createMnemosyne({
    qdrantUrl: process.env.QDRANT_URL ?? 'http://localhost:6333',
    embeddingUrl: process.env.EMBEDDING_URL ?? 'http://localhost:11434',
    embeddingModel: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
    agentId: 'agent-beta',
    collectionName: 'fleet-memories',
    redis: {
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
      channel: 'mnemosyne:fleet',
    },
  });

  console.log('✅ Two agents initialized with Redis broadcast enabled');

  // Subscribe Agent B to fleet memory events
  await agentB.subscribe((event) => {
    console.log(`\n📡 Agent B received broadcast event:`);
    console.log(`   type   : ${event.type}`);
    console.log(`   agentId: ${event.agentId}`);
    console.log(`   text   : ${event.text ?? '(no text)'}`);
  });

  console.log('📻 Agent B is now subscribed to fleet broadcasts\n');

  // Agent A stores a memory — Agent B will be notified via Redis
  const id = await agentA.store({
    text: 'The production API key was rotated on 2026-02-23.',
    category: 'fact',
    importance: 0.9,
    metadata: { source: 'agent-alpha', critical: true },
  });

  console.log(`📝 Agent A stored memory: ${id}`);

  // Allow event loop to deliver the broadcast
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Agent B can independently recall from the shared collection
  const results = await agentB.recall({ query: 'API key rotation', limit: 3 });
  console.log(`\n🔍 Agent B recalled ${results.length} memory/memories about "API key rotation"`);

  await agentB.unsubscribe();
  console.log('\n✅ Done');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
