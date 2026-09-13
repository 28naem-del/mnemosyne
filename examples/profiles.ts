/** Synthetic typed profiles; no provider, network or existing user database. */
import { z } from 'zod';
import { createLocalMemory } from '../dist/local/index.js';
import { MemoryRuntime } from '../dist/runtime/index.js';
import { MemoryProfiles } from '../dist/profiles/index.js';

const memory = createLocalMemory({ path: ':memory:', workspaceId: 'profile-example', agentId: 'client' });
try {
  const runtime = new MemoryRuntime(memory);
  const profiles = new MemoryProfiles(runtime);
  const definition = profiles.define({ key: 'preferences', version: '1', fields: { city: z.string(), language: z.enum(['en', 'de']), theme: z.enum(['dark', 'light']) } });
  const first = memory.store({ text: 'Synthetic client says city Dubai and language en.', trust: 'observed', source: { uri: 'example:first' } });
  const second = memory.store({ text: 'Another synthetic note says city Berlin.', trust: 'observed', source: { uri: 'example:second' } });
  let scriptedProposalCalls = 0;
  const initial = await profiles.refresh({ definition, sourceIds: [first.id, second.id], proposerId: 'scripted-example-v1', proposer: async () => {
    scriptedProposalCalls++;
    return { fields: { city: { status: 'conflict', candidates: [{ value: 'Dubai', sourceIds: [first.id] }, { value: 'Berlin', sourceIds: [second.id] }] }, language: { status: 'known', value: 'en', sourceIds: [first.id] }, theme: { status: 'unknown' } } };
  } });
  if (initial.profile.fields.city.status !== 'conflict' || initial.profile.fields.theme.status !== 'unknown') throw new Error('Profile field-state fixture failed.');
  if (initial.profile.fields.language.status === 'known') { const language: 'en' | 'de' = initial.profile.fields.language.value; if (language !== 'en') throw new Error('Profile type fixture failed.'); }
  const corrected = memory.correct(second.id, { text: 'The second synthetic note was outdated; city Dubai.', source: { uri: 'example:correction' }, reason: 'Fixture correction.' });
  if (profiles.get(definition).status !== 'stale') throw new Error('Profile invalidation fixture failed.');
  const refreshed = await profiles.refresh({ definition, sourceIds: [first.id, corrected.id], proposerId: 'scripted-example-v2', proposer: async ({ sources }) => {
    scriptedProposalCalls++;
    return { fields: { city: { status: 'known', value: 'Dubai', sourceIds: sources.map(source => source.id) }, language: { status: 'known', value: 'en', sourceIds: [first.id] }, theme: { status: 'unknown' } } };
  } });
  if (profiles.get(definition).recordId !== refreshed.profile.recordId) throw new Error('Profile refresh fixture failed.');
  memory.forget(first.id);
  if (profiles.get(definition).fields.city.status !== 'unknown') throw new Error('Profile erasure fixture failed.');
  console.log(JSON.stringify({ externalModelCalls: 0, scriptedProposalCalls, conflictPreserved: true, correctionInvalidated: true, erased: true }));
} finally { memory.close(); }
