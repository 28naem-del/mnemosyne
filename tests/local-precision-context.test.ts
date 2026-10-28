import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory, type LocalMemory, type LocalMemoryOptions } from '../src/local/index.js';
import { MemoryRuntime } from '../src/runtime/index.js';
import { MemoryMaintenance } from '../src/maintenance/index.js';
import { AdaptiveContext } from '../src/context/index.js';

/**
 * The adaptive context packet carries the kernel's reason for an empty answer,
 * beside the `abstained` boolean it always had.
 */

const opened: LocalMemory[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); });
function fixture(options: Partial<LocalMemoryOptions> = {}) {
  const memory = createLocalMemory({ path: ':memory:', workspaceId: 'w', agentId: 'a', retrieval: 'lexical', ...options });
  opened.push(memory);
  const runtime = new MemoryRuntime(memory);
  return { memory, builder: new AdaptiveContext(runtime, { maintenance: new MemoryMaintenance(runtime) }) };
}
const store = (memory: LocalMemory, text: string) => memory.store({ text, source: { uri: 'fixture:source', revision: 'v1' }, trust: 'observed' });

describe('adaptive context abstention', () => {
  it('passes the recall abstention through when recall returned nothing', async () => {
    const f = fixture({ minScores: { keyword: 1000 } });
    store(f.memory, 'Atlas release uses dry-run checks.');
    const packet = await f.builder.build({ query: 'Atlas release', maxTokens: 1400, maxCandidates: 10 });
    expect(packet.abstained).toBe(true);
    expect(packet.abstention).toMatchObject({ reason: 'below-floor', floors: { keyword: 1000 } });
    const none = await f.builder.build({ query: 'zebra', maxTokens: 1400, maxCandidates: 10 });
    expect(none.abstention).toMatchObject({ reason: 'no-candidates', topScore: null });
  });

  it('omits the field when the packet has items', async () => {
    const f = fixture();
    store(f.memory, 'Atlas release uses dry-run checks.');
    const packet = await f.builder.build({ query: 'Atlas release', maxTokens: 1400, maxCandidates: 10 });
    expect(packet.abstained).toBe(false);
    expect(packet.abstention).toBeUndefined();
  });
});
