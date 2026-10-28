import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMemory, type LedgerDependency, type LocalMemory } from '../src/local/index.js';
import { MemoryRuntime, type SkillValidation } from '../src/runtime/index.js';

const opened: LocalMemory[] = [];
afterEach(() => { opened.splice(0).forEach(db => db.close()); });

function setup() {
  let tick = Date.parse('2026-10-28T00:00:00.000Z');
  const now = () => new Date(tick += 1000);
  const db = createLocalMemory({ path: ':memory:', agentId: 'alice', workspaceId: 'project', now, retrieval: 'lexical' }); opened.push(db);
  const runtime = new MemoryRuntime(db, { now });
  const evidence = runtime.capture({ sessionId: 'session', trust: 'observed', messages: [{ id: 'm1', role: 'user', text: 'Deploy with the release checklist after tests pass.' }] }).records[0];
  const premise = db.store({ text: 'Releases ship from the main branch.', kind: 'fact', trust: 'observed', source: { uri: 'test:branch-policy' } });
  const skill = runtime.createSkill({ name: 'Safe release', prerequisites: ['Tests have passed'], steps: ['Read release checklist', 'Tag the main branch'], parameters: {}, evidenceIds: [evidence.id] });
  return { db, runtime, evidence, premise, skill };
}
const passed: SkillValidation = { passed: true, evidence: 'Synthetic release trial completed and artifacts verified.', verifier: 'test-harness', taskId: 'trial-1', prerequisitesSatisfied: true };
function receipt(db: LocalMemory, dependency: Record<string, string>) {
  return db.atomic(() => db.appendLedgerReceipt({ event: 'dependency', dependency: dependency as unknown as LedgerDependency }));
}

describe('premise-linked runtime skills (M6)', () => {
  it('links a premise only from an accepted dependency receipt for this skill and premise', async () => {
    const { db, runtime, premise, skill } = setup();
    const active = await runtime.trialSkill({ id: skill.id, validation: passed });
    expect(() => runtime.linkPremise(skill.id, premise.id, 'missing-receipt')).toThrow('receipt not found');
    const rejected = receipt(db, { decision: 'reject', to: premise.id, skillId: skill.id });
    expect(() => runtime.linkPremise(skill.id, premise.id, rejected)).toThrow('does not accept');
    const otherSkill = receipt(db, { decision: 'accept', to: premise.id, skillId: 'other-skill' });
    expect(() => runtime.linkPremise(skill.id, premise.id, otherSkill)).toThrow('does not accept');
    const other = db.store({ text: 'Unrelated observed fact.', kind: 'fact', trust: 'observed', source: { uri: 'test:other' } });
    const otherPremise = receipt(db, { decision: 'accept', to: other.id, skillId: skill.id });
    expect(() => runtime.linkPremise(skill.id, premise.id, otherPremise)).toThrow('does not accept');
    expect(runtime.getSkill(skill.id)).toEqual(active);

    const accepted = receipt(db, { decision: 'accept', to: premise.id, skillId: skill.id });
    const linked = runtime.linkPremise(skill.id, premise.id, accepted);
    expect(linked).toMatchObject({ id: skill.id, state: 'active', premises: [{ memoryId: premise.id, receiptId: accepted }] });
    expect(linked.recordId).not.toBe(active.recordId);
    expect(db.get(linked.recordId)!.dependencies).toEqual([...active.definition.evidenceIds, premise.id]);
    expect(db.isEligible(linked.recordId)).toBe(true);
    expect(runtime.getSkill(skill.id)).toEqual(linked);
    expect(new MemoryRuntime(db).getSkill(skill.id)).toEqual(linked);
    expect(runtime.linkPremise(skill.id, premise.id, accepted)).toEqual(linked);
  });

  it('retires the skill and refuses trials when a linked premise is corrected', async () => {
    const { db, runtime, premise, skill } = setup();
    await runtime.trialSkill({ id: skill.id, validation: passed });
    const linked = runtime.linkPremise(skill.id, premise.id, receipt(db, { decision: 'accept', to: premise.id, skillId: skill.id }));
    db.correct(premise.id, { text: 'Releases ship from the release branch.', source: { uri: 'test:branch-policy-v2' }, reason: 'Branch policy changed.' });
    expect(db.get(linked.recordId)!.status).toBe('invalidated');
    expect(runtime.getSkill(skill.id)).toMatchObject({ state: 'retired', reason: 'Linked premise was corrected or is no longer eligible.' });
    await expect(runtime.trialSkill({ id: skill.id, validation: { ...passed, taskId: 'trial-2', evidence: 'A later trial after the policy change.' } })).rejects.toThrow('retired or has stale evidence');
    expect(db.compile({ query: 'release main branch checklist', maxTokens: 2000 }).items.map(item => item.id)).not.toContain(linked.recordId);
  });

  it('retires when a linked premise fails an outcome even though nothing was corrected', async () => {
    const { db, runtime, premise, skill } = setup();
    await runtime.trialSkill({ id: skill.id, validation: passed });
    runtime.linkPremise(skill.id, premise.id, receipt(db, { decision: 'accept', to: premise.id, skillId: skill.id }));
    db.recordOutcome({ memoryId: premise.id, success: false, evidence: 'The main branch was frozen; the release failed.', verifier: 'ci', taskId: 'release-42' });
    expect(runtime.getSkill(skill.id)).toMatchObject({ state: 'retired', reason: 'Linked premise was corrected or is no longer eligible.' });
  });

  it('keeps premises across the candidate to active transition and checks them during trials', async () => {
    const { db, runtime, premise, skill } = setup();
    const linked = runtime.linkPremise(skill.id, premise.id, receipt(db, { decision: 'accept', to: premise.id, skillId: skill.id }));
    expect(linked.state).toBe('candidate');
    expect(db.isEligible(linked.recordId)).toBe(false);
    const active = await runtime.trialSkill({ id: skill.id, validation: passed });
    expect(active).toMatchObject({ state: 'active', premises: linked.premises, premiseFingerprint: linked.premiseFingerprint });
    expect(db.get(active.recordId)!.dependencies).toContain(premise.id);

    const { db: db2, runtime: runtime2, premise: premise2, skill: skill2 } = setup();
    runtime2.linkPremise(skill2.id, premise2.id, receipt(db2, { decision: 'accept', to: premise2.id, skillId: skill2.id }));
    await expect(runtime2.trialSkill({ id: skill2.id, verifier: async () => {
      db2.correct(premise2.id, { text: 'Releases ship from a tag.', source: { uri: 'test:branch-policy-v3' }, reason: 'Changed during trial.' });
      return passed;
    } })).rejects.toThrow('changed during trial');
  });

  it('refuses evidence premises, retired skills and disabled capture', async () => {
    const { db, runtime, evidence, premise, skill } = setup();
    expect(() => runtime.linkPremise(skill.id, evidence.id, receipt(db, { decision: 'accept', to: evidence.id, skillId: skill.id }))).toThrow('already declared skill evidence');
    const accepted = receipt(db, { decision: 'accept', to: premise.id, skillId: skill.id });
    expect(() => new MemoryRuntime(db, { captureEnabled: false }).linkPremise(skill.id, premise.id, accepted)).toThrow('must be enabled');
    runtime.retireSkill(skill.id, 'Controller retired the candidate.');
    expect(() => runtime.linkPremise(skill.id, premise.id, accepted)).toThrow('retired');
  });
});
